// Tracers: thin HDR streaks travelling at ~9000 u/s, camera-facing ribbons, one draw call.
// Head/tail positions are computed on the GPU from (from, to, t0, speed).
import * as THREE from 'three';
import { shared } from './lighting.js';
import { queueRange } from './util.js';

const MAX = 96;
const STRIDE = 12;

const VERT = /* glsl */`
precision highp float;
attribute vec2 corner;      // x: -1..1 across, y: 0 tail .. 1 head
attribute vec4 t0;          // from.xyz, spawn time
attribute vec4 t1;          // to.xyz, speed
attribute vec4 t2;          // length, width, brightness, seed
uniform float uTime;
uniform vec2 uViewport;
varying float vAlong;
varying float vAcross;
varying float vBright;
#include <fog_pars_vertex>
void main() {
  float age = uTime - t0.w;
  vec3 A = t0.xyz, B = t1.xyz;
  vec3 D = B - A;
  float L = length(D);
  float speed = t1.w;
  float head = age * speed;
  float tail = head - t2.x;
  if (age < 0.0 || tail >= L || L < 1.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec3 dir = D / L;
  float h = min(head, L), tl = clamp(tail, 0.0, L);
  // skip the first few units so the muzzle end is not a fat blob
  vec3 P = A + dir * mix(tl, h, corner.y);
  vec4 mv = modelViewMatrix * vec4(P, 1.0);
  vec3 dv = normalize(mat3(modelViewMatrix) * dir);
  vec3 side = cross(dv, normalize(mv.xyz));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // width: world width, clamped to [1.1, 3.5] px
  float pxPerUnit = uViewport.y * projectionMatrix[1][1] * 0.5 / max(-mv.z, 1.0);
  float wpx = clamp(t2.y * pxPerUnit, 1.1, 3.5);
  float w = wpx / pxPerUnit;
  mv.xyz += side * corner.x * w * 0.5;
  gl_Position = projectionMatrix * mv;
  vAlong = corner.y;
  vAcross = corner.x;
  // thin lines lose energy as they are widened to the pixel minimum
  vBright = t2.z * clamp(t2.y * pxPerUnit / wpx, 0.25, 1.0) * smoothstep(0.0, 0.25, sl);
  // fade over the first 40u from the muzzle and when the tail reaches the target
  vBright *= smoothstep(8.0, 60.0, h) * (1.0 - smoothstep(L - t2.x * 0.2, L, tl + 1.0) * 0.6);
  vec4 mvPosition = mv;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
precision highp float;
varying float vAlong;
varying float vAcross;
varying float vBright;
#include <fog_pars_fragment>
void main() {
  float across = 1.0 - vAcross * vAcross;
  float along = pow(vAlong, 1.6);
  vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.85, 0.55), along) * vBright * along * across;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      col *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(col, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Tracers {
  constructor(scene) {
    this.data = new Float32Array(MAX * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1).setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, 1, 1, -1, 1], 2));
    g.setAttribute('t0', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    g.setAttribute('t1', new THREE.InterleavedBufferAttribute(this.buf, 4, 4));
    g.setAttribute('t2', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    g.instanceCount = 0;
    this.geo = g;
    this.uniforms = { uTime: shared.uTime, uViewport: { value: new THREE.Vector2(1920, 1080) }, ...THREE.UniformsLib.fog };
    this.material = new THREE.ShaderMaterial({
      name: 'fx-tracers', uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-tracers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.userData.fx = true;
    this.mesh.onBeforeRender = (renderer) => {
      const t = renderer.getRenderTarget();
      if (t) this.uniforms.uViewport.value.set(t.width, t.height);
      else renderer.getDrawingBufferSize(this.uniforms.uViewport.value);
    };
    scene?.add(this.mesh);
    this.head = 0; this.used = 0;
    this.dmin = Infinity; this.dmax = -1;
  }

  spawn(now, from, to, { speed = 9000, length = 260, width = 0.9, bright = 7, delay = 0 } = {}) {
    const i = this.head; this.head = (i + 1) % MAX;
    if (this.used < MAX) this.used++;
    const d = this.data, o = i * STRIDE;
    d[o] = from.x; d[o + 1] = from.y; d[o + 2] = from.z; d[o + 3] = now + delay;
    d[o + 4] = to.x; d[o + 5] = to.y; d[o + 6] = to.z; d[o + 7] = speed;
    d[o + 8] = length; d[o + 9] = width; d[o + 10] = bright; d[o + 11] = 0;
    if (i < this.dmin) this.dmin = i;
    if (i > this.dmax) this.dmax = i;
  }

  flush() {
    this.geo.instanceCount = this.used;
    if (this.dmax < 0) return;
    queueRange(this.buf, this.dmin * STRIDE, (this.dmax - this.dmin + 1) * STRIDE);
    this.dmin = Infinity; this.dmax = -1;
  }

  clear() { for (let i = 0; i < MAX; i++) this.data[i * STRIDE + 3] = -1e9; this.dmin = 0; this.dmax = MAX - 1; }
}
