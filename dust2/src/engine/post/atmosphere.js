// Deferred world composite (before the viewmodel is drawn):
//   * GTAO applied to ambient light only (alpha = indirect fraction written by lit materials),
//     with a colour multi-bounce approximation so corners go warm-dark, not grey;
//   * exponential height fog with sky-matched inscatter + forward sun glow (aerial perspective).
import * as THREE from 'three';
import { fsMaterial } from './common.js';
import { DEPTH_GLSL } from './common.js';
import { SKY_GLSL, skyUniforms } from '../sky.js';

const FS = DEPTH_GLSL + SKY_GLSL + /* glsl */`
uniform sampler2D tColor, tDepth, tAO, tAOZ;
uniform vec2 uAOTexel;
uniform float uAOOn, uAOHalf;
uniform vec2 uTanHalf;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec4 uFog;       // x density, y height falloff (1/H), z base height, w max opacity
uniform vec3 uFogTint;
uniform float uDebug;
varying vec2 vUv;

float aoUpsample(vec2 uv, float z) {
  if (uAOHalf < 0.5) return texture(tAO, uv).r;
  // joint bilateral: 4 nearest low-res texels weighted by depth similarity
  vec2 p = uv / uAOTexel - 0.5;
  vec2 f = fract(p);
  vec2 b = (floor(p) + 0.5) * uAOTexel;
  float s = 0.0, ws = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 q = b + vec2(i, j) * uAOTexel;
    float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float zq = texture(tAOZ, q).r;
    float w = bw / (1e-3 + abs(zq - z) / z * 40.0) + 1e-5;
    s += texture(tAO, q).r * w; ws += w;
  }
  return s / ws;
}

vec3 multiBounce(float v, vec3 alb) {
  vec3 a = 2.0404 * alb - 0.3324;
  vec3 b = -4.7951 * alb + 0.6417;
  vec3 c = 2.7552 * alb + 0.6903;
  return max(vec3(v), ((v * a + b) * v + c) * v);
}

void main() {
  vec4 c = texture(tColor, vUv);
  float d = texture(tDepth, vUv).r;
  if (d >= 1.0) { gl_FragColor = vec4(c.rgb, 1.0); return; }
  float z = rpLinearDepth(d);
  if (uAOOn > 0.5) {
    float ao = aoUpsample(vUv, z);
    // albedo chroma estimate from the lit colour; bright sandy albedos bounce more
    float l = max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    vec3 alb = clamp(c.rgb / l * 0.42, 0.0, 0.85);
    vec3 aoc = multiBounce(ao, alb);
    c.rgb *= mix(vec3(1.0), aoc, clamp(c.a, 0.0, 1.0));
    if (uDebug > 0.5 && uDebug < 1.5) { gl_FragColor = vec4(aoc, 1.0); return; }
  }
  // world-space view ray
  vec3 vp = vec3((vUv * 2.0 - 1.0) * uTanHalf * z, -z);
  float dist = length(vp);
  vec3 rd = normalize((uCamWorld * vec4(vp / dist, 0.0)).xyz);
  // exponential height fog, analytic integral along the ray
  float k = uFog.y;
  float h0 = uCamPos.y - uFog.z;
  float dy = rd.y * dist;
  float fy = abs(dy * k) > 1e-4 ? (1.0 - exp(-dy * k)) / (dy * k) : 1.0;
  float tau = uFog.x * exp(-h0 * k) * dist * fy;
  float fog = min(1.0 - exp(-tau), uFog.w);
  // inscatter: sky radiance just above the horizon in this azimuth (so distant walls melt into
  // the horizon haze) tinted by the map's haze colour
  vec3 hd = normalize(vec3(rd.x, clamp(rd.y, 0.0, 0.25) * 0.35 + 0.01, rd.z));
  vec3 fogCol = rpSkyRadiance(hd, 0.0) * uFogTint;
  c.rgb = mix(c.rgb, fogCol, fog);
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

export class AtmospherePass {
  constructor() {
    this.material = fsMaterial({
      name: 'rp.atmosphere', fragmentShader: FS,
      uniforms: {
        ...skyUniforms,
        tColor: { value: null }, tDepth: { value: null }, tAO: { value: null }, tAOZ: { value: null },
        uAOTexel: { value: new THREE.Vector2(1, 1) }, uAOOn: { value: 1 }, uAOHalf: { value: 0 },
        uNearFar: { value: new THREE.Vector2(1, 12000) },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uFog: { value: new THREE.Vector4(1.2e-4, 1 / 700, 0, 0.82) },
        uFogTint: { value: new THREE.Color(1, 1, 1) },
        uDebug: { value: 0 },
      },
    });
  }
  update(camera) {
    const u = this.material.uniforms;
    u.uNearFar.value.set(camera.near, camera.far);
    const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);
    u.uTanHalf.value.set(ty * camera.aspect, ty);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  }
}
