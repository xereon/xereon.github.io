// GPU particle pool: one instanced quad per particle in a ring buffer, one draw call.
// The CPU writes a 32-float birth record per particle (position, velocity, life, size,
// colour curve, sprite, flags...) and never touches it again; the vertex shader evaluates
// drag, gravity, floor bounces, turbulence and the colour/size curves analytically.
import * as THREE from 'three';
import { shared, sunDirW } from './lighting.js';
import { PARTICLE_VERT, PARTICLE_FRAG, PF } from './shaders/particle.js';
import { queueRange } from './util.js';

export { PF };
const STRIDE = 32;

/** Reusable emission record. Fill fields, then pool.emit(spec). */
export class PSpec {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.c0 = new THREE.Vector4();
    this.c1 = new THREE.Vector4();
    this.reset();
  }
  reset() {
    this.pos.set(0, 0, 0); this.vel.set(0, 0, 0);
    this.delay = 0; this.life = 1;
    this.size0 = 1; this.size1 = 1; this.rot = 0; this.rotVel = 0;
    this.gravity = 0; this.drag = 0; this.floorY = -1e6; this.restitution = 0.3;
    this.c0.set(1, 1, 1, 1); this.c1.set(1, 1, 1, 0);
    this.sprite = 0; this.frames = 1; this.flags = 0; this.stretch = 0;
    this.fadeIn = 0.05; this.fadeOut = 0.6; this.sun = 1; this.seed = 0;
    return this;
  }
  color(r, g, b, a = 1) { this.c0.set(r, g, b, a); this.c1.set(r, g, b, 0); return this; }
}

const _m = new THREE.Matrix4();

export class ParticlePool {
  constructor(atlas, { capacity = 4096, renderOrder = 10, name = 'fx-particles', nearFade = [4, 40] } = {}) {
    this.cap = capacity;
    this.head = 0;
    this.data = new Float32Array(capacity * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.dmin = Infinity; this.dmax = -1;
    this.used = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    for (let i = 0; i < 8; i++) geo.setAttribute('a' + i, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    geo.instanceCount = 0;
    this.geo = geo;

    const size = atlas?.image?.width || atlas?.source?.data?.width || 2048;
    this.uniforms = {
      uTime: shared.uTime,
      uAtlas: { value: atlas },
      uAtlasTexel: { value: 1 / size },
      uViewport: { value: new THREE.Vector2(1920, 1080) },
      uCamWorld: { value: new THREE.Matrix4() },
      uSunDirV: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: shared.uSunCol, uSkyCol: shared.uSkyCol, uGroundCol: shared.uGroundCol,
      uEmissive: shared.uEmissive,
      uDepth: shared.uDepth, uHasDepth: shared.uHasDepth, uDepthRes: shared.uDepthRes, uNearFar: shared.uNearFar,
      uNearFade: { value: new THREE.Vector2(nearFade[0], nearFade[1]) },
      ...THREE.UniformsLib.fog,
    };
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.userData.fx = true;
    this.mesh.layers.enable(5);
    const U = this.uniforms;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      U.uSunDirV.value.copy(sunDirW).transformDirection(camera.matrixWorldInverse);
      U.uCamWorld.value.copy(camera.matrixWorld);
      const t = renderer.getRenderTarget();
      if (t) U.uViewport.value.set(t.width, t.height);
      else renderer.getDrawingBufferSize(U.uViewport.value);
    };
    this.spec = new PSpec();
  }

  /** Write one particle. `now` is the FX clock. Zero allocation. */
  emit(s, now) {
    const i = this.head;
    this.head = i + 1 >= this.cap ? 0 : i + 1;
    if (this.used < this.cap) this.used++;
    const d = this.data, o = i * STRIDE;
    d[o] = s.pos.x; d[o + 1] = s.pos.y; d[o + 2] = s.pos.z; d[o + 3] = now + s.delay;
    d[o + 4] = s.vel.x; d[o + 5] = s.vel.y; d[o + 6] = s.vel.z; d[o + 7] = s.life;
    d[o + 8] = s.size0; d[o + 9] = s.size1; d[o + 10] = s.rot; d[o + 11] = s.rotVel;
    d[o + 12] = s.gravity; d[o + 13] = s.drag; d[o + 14] = s.floorY; d[o + 15] = s.restitution;
    d[o + 16] = s.c0.x; d[o + 17] = s.c0.y; d[o + 18] = s.c0.z; d[o + 19] = s.c0.w;
    d[o + 20] = s.c1.x; d[o + 21] = s.c1.y; d[o + 22] = s.c1.z; d[o + 23] = s.c1.w;
    d[o + 24] = s.sprite; d[o + 25] = s.frames; d[o + 26] = s.flags; d[o + 27] = s.stretch;
    d[o + 28] = s.fadeIn; d[o + 29] = s.fadeOut; d[o + 30] = s.sun; d[o + 31] = s.seed;
    if (i < this.dmin) this.dmin = i;
    if (i > this.dmax) this.dmax = i;
    return i;
  }

  /** Kill every live particle (round reset). */
  clear() {
    for (let i = 0; i < this.cap; i++) this.data[i * STRIDE + 7] = 0;
    this.dmin = 0; this.dmax = this.cap - 1;
  }

  /** Upload dirty ranges; call once per frame before render. */
  flush() {
    this.geo.instanceCount = this.used;
    if (this.dmax < 0) return;
    queueRange(this.buf, this.dmin * STRIDE, (this.dmax - this.dmin + 1) * STRIDE);
    this.dmin = Infinity; this.dmax = -1;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}
