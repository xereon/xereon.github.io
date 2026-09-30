// Ground-truth AO (Jimenez 2016 / XeGTAO formulation) from the depth buffer alone.
// Normals are reconstructed from depth, so no extra geometry pass is needed. Runs at full or
// half resolution, then a depth-aware separable blur removes the 4x4 noise pattern.
// Output: R = visibility. The atmosphere pass upsamples it and applies it to ambient only.
import * as THREE from 'three';
import { fsMaterial, makeRT, Blitter, DEPTH_GLSL, NOISE_GLSL } from './common.js';

const LINZ_FS = DEPTH_GLSL + /* glsl */`
uniform sampler2D tDepth;
uniform vec2 uSrcTexel;
uniform float uHalf;
varying vec2 vUv;
void main() {
  float d;
  if (uHalf > 0.5) {
    // checkerboard min/max keeps both sides of edges represented for the upsample
    vec2 px = floor(gl_FragCoord.xy);
    float d0 = texture(tDepth, vUv + vec2(-0.25, -0.25) * uSrcTexel * 2.0).r;
    float d1 = texture(tDepth, vUv + vec2( 0.25, -0.25) * uSrcTexel * 2.0).r;
    float d2 = texture(tDepth, vUv + vec2(-0.25,  0.25) * uSrcTexel * 2.0).r;
    float d3 = texture(tDepth, vUv + vec2( 0.25,  0.25) * uSrcTexel * 2.0).r;
    bool odd = mod(px.x + px.y, 2.0) > 0.5;
    d = odd ? max(max(d0, d1), max(d2, d3)) : min(min(d0, d1), min(d2, d3));
  } else d = texture(tDepth, vUv).r;
  gl_FragColor = vec4(d >= 1.0 ? 1e6 : rpLinearDepth(d), 0.0, 0.0, 1.0);
}`;

const GTAO_FS = NOISE_GLSL + /* glsl */`
#define SLICES 3
#define STEPS 5
#define PI 3.14159265
#define HALF_PI 1.5707963
uniform sampler2D tZ;
uniform vec2 uRes, uTexel, uTanHalf;
uniform float uRadius, uProjScale, uPower, uMaxPx;
varying vec2 vUv;
vec3 vpos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z); }
float Z(vec2 uv) { return texture(tZ, uv).r; }
float fastAcos(float x) {
  float r = -0.156583 * abs(x) + HALF_PI;
  r *= sqrt(1.0 - abs(x));
  return x >= 0.0 ? r : PI - r;
}
void main() {
  float z = Z(vUv);
  if (z > 1e5) { gl_FragColor = vec4(1.0); return; }
  vec3 P = vpos(vUv, z);
  // normal from the smaller of forward/backward differences (no halos at depth edges)
  vec3 pl = vpos(vUv - vec2(uTexel.x, 0.0), Z(vUv - vec2(uTexel.x, 0.0)));
  vec3 pr = vpos(vUv + vec2(uTexel.x, 0.0), Z(vUv + vec2(uTexel.x, 0.0)));
  vec3 pd = vpos(vUv - vec2(0.0, uTexel.y), Z(vUv - vec2(0.0, uTexel.y)));
  vec3 pu = vpos(vUv + vec2(0.0, uTexel.y), Z(vUv + vec2(0.0, uTexel.y)));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  float rpx = min(uRadius * uProjScale / z, uMaxPx);
  if (rpx < 1.0) { gl_FragColor = vec4(1.0); return; }
  vec2 fc = gl_FragCoord.xy;
  // 4x4 interleaved noise: slice rotation + step jitter
  float n0 = rpIGN(fc);
  float n1 = rpIGN(fc + vec2(5.3, 7.1));
  float falloffRange = 0.62 * uRadius;
  float falloffMul = -1.0 / falloffRange;
  float falloffAdd = (uRadius - falloffRange) / falloffRange + 1.0;
  float vis = 0.0;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + n0) * PI / float(SLICES);
    vec2 om = vec2(cos(phi), sin(phi));
    vec3 dir = vec3(om, 0.0);
    vec3 ortho = dir - dot(dir, V) * V;
    vec3 axis = normalize(cross(ortho, dir));
    vec3 pn = N - axis * dot(N, axis);
    float pnl = max(length(pn), 1e-4);
    float sgn = sign(dot(ortho, pn));
    float cosn = clamp(dot(pn, V) / pnl, 0.0, 1.0);
    float n = sgn * fastAcos(cosn);
    float lo0 = cos(n + HALF_PI), lo1 = cos(n - HALF_PI);
    float h0c = lo0, h1c = lo1;
    for (int j = 0; j < STEPS; j++) {
      float t = (float(j) + n1) / float(STEPS);
      t = t * t;
      float px = max(t * rpx, float(j) + 1.0);
      vec2 off = om * px * uTexel;
      vec2 u0 = vUv + off, u1 = vUv - off;
      vec3 D0 = vpos(u0, Z(u0)) - P;
      vec3 D1 = vpos(u1, Z(u1)) - P;
      float l0 = length(D0), l1 = length(D1);
      float c0 = dot(D0, V) / l0, c1 = dot(D1, V) / l1;
      float w0 = clamp(l0 * falloffMul + falloffAdd, 0.0, 1.0);
      float w1 = clamp(l1 * falloffMul + falloffAdd, 0.0, 1.0);
      h0c = max(h0c, mix(lo0, c0, w0));
      h1c = max(h1c, mix(lo1, c1, w1));
    }
    float h0 = -fastAcos(h1c);
    float h1 = fastAcos(h0c);
    h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
    h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
    float sn = sin(n);
    float a0 = (cosn + 2.0 * h0 * sn - cos(2.0 * h0 - n)) * 0.25;
    float a1 = (cosn + 2.0 * h1 * sn - cos(2.0 * h1 - n)) * 0.25;
    vis += pnl * (a0 + a1);
  }
  vis = clamp(vis / float(SLICES), 0.0, 1.0);
  gl_FragColor = vec4(pow(vis, uPower), 0.0, 0.0, 1.0);
}`;

const BLUR_FS = /* glsl */`
uniform sampler2D tAO, tZ;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float z0 = texture(tZ, vUv).r;
  float sum = texture(tAO, vUv).r, wsum = 1.0;
  for (int i = 1; i <= 3; i++) {
    for (int s = -1; s <= 1; s += 2) {
      vec2 uv = vUv + uDir * float(i * s);
      float z = texture(tZ, uv).r;
      float w = exp(-float(i * i) * 0.12) * max(0.0, 1.0 - abs(z - z0) / (z0 * 0.04 + 0.5));
      sum += texture(tAO, uv).r * w; wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

export class GTAO {
  constructor() {
    this.scale = 1;
    this.radius = 40;
    this.power = 1.6;
    this.enabled = true;
    this.blit = new Blitter();
    this.zRT = makeRT(1, 1, { type: THREE.FloatType, format: THREE.RedFormat, filter: THREE.NearestFilter, name: 'rp.aoZ' });
    this.aoRT = makeRT(1, 1, { type: THREE.HalfFloatType, format: THREE.RedFormat, filter: THREE.LinearFilter, name: 'rp.ao' });
    this.tmpRT = makeRT(1, 1, { type: THREE.HalfFloatType, format: THREE.RedFormat, filter: THREE.LinearFilter, name: 'rp.aoTmp' });
    this.linz = fsMaterial({ name: 'rp.ao.linz', fragmentShader: LINZ_FS, uniforms: {
      tDepth: { value: null }, uNearFar: { value: new THREE.Vector2() }, uSrcTexel: { value: new THREE.Vector2() }, uHalf: { value: 0 },
    } });
    this.gtao = fsMaterial({ name: 'rp.ao.gtao', fragmentShader: GTAO_FS, uniforms: {
      tZ: { value: this.zRT.texture }, uRes: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() },
      uTanHalf: { value: new THREE.Vector2() }, uRadius: { value: 40 }, uProjScale: { value: 1 }, uPower: { value: 1.6 }, uMaxPx: { value: 80 },
    } });
    this.blur = fsMaterial({ name: 'rp.ao.blur', fragmentShader: BLUR_FS, uniforms: {
      tAO: { value: null }, tZ: { value: this.zRT.texture }, uDir: { value: new THREE.Vector2() },
    } });
    this.w = this.h = 1;
  }

  get texture() { return this.aoRT.texture; }
  get depthTexture() { return this.zRT.texture; }

  setSize(w, h) {
    this.fw = w; this.fh = h;
    const s = this.scale;
    this.w = Math.max(1, Math.round(w * s)); this.h = Math.max(1, Math.round(h * s));
    for (const rt of [this.zRT, this.aoRT, this.tmpRT]) rt.setSize(this.w, this.h);
  }

  setScale(s) { this.scale = s; if (this.fw) this.setSize(this.fw, this.fh); }

  render(renderer, depthTexture, camera) {
    const L = this.linz.uniforms;
    L.tDepth.value = depthTexture;
    L.uNearFar.value.set(camera.near, camera.far);
    L.uSrcTexel.value.set(1 / this.fw, 1 / this.fh);
    L.uHalf.value = this.scale < 0.99 ? 1 : 0;
    this.blit.draw(renderer, this.linz, this.zRT);

    const G = this.gtao.uniforms;
    const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);
    G.uTanHalf.value.set(ty * camera.aspect, ty);
    G.uRes.value.set(this.w, this.h);
    G.uTexel.value.set(1 / this.w, 1 / this.h);
    G.uProjScale.value = 0.5 * this.h / ty;
    G.uRadius.value = this.radius;
    G.uPower.value = this.power;
    G.uMaxPx.value = 90 * this.scale + 20;
    this.blit.draw(renderer, this.gtao, this.aoRT);

    const B = this.blur.uniforms;
    B.tAO.value = this.aoRT.texture; B.uDir.value.set(1 / this.w, 0);
    this.blit.draw(renderer, this.blur, this.tmpRT);
    B.tAO.value = this.tmpRT.texture; B.uDir.value.set(0, 1 / this.h);
    this.blit.draw(renderer, this.blur, this.aoRT);
  }

  dispose() { for (const rt of [this.zRT, this.aoRT, this.tmpRT]) rt.dispose(); this.blit.dispose(); }
}
