// Baked irradiance volume: the "GI" that makes shadowed Dust II alleys warm and readable.
//
//  1. CPU voxelisation (32u) of the map: solid collision brushes (conservative plane test)
//     + render triangles (tri/box SAT) carrying per-material albedo; columns below the
//     lowest surface are filled so nothing leaks under the floor.
//  2. GPU gather: one fragment per probe (64u grid), N spherical-Fibonacci rays DDA-marched
//     through the voxel texture. Escaping rays sample the analytic sky; hits are lit by the
//     sun (static shadow cascade lookup) + the previous iteration's irradiance (multi-bounce).
//     Radiance is projected to L1 SH and stored as irradiance E(n) = a + b·n.
//  3. Probes inside solids are dilated from valid neighbours; the result is uploaded as three
//     RGBA16F 3D textures sampled per fragment with hardware trilinear (lighting.js).
import * as THREE from 'three';
import { SKY_GLSL, skyUniforms } from './sky.js';
import { lightUniforms } from './lighting.js';
import { Dbg } from '../core/debug.js';

// surface key -> linear albedo used for brushes that have no render triangle nearby
const SURF_ALBEDO = {
  sand: [0.46, 0.36, 0.24], gravel: [0.36, 0.32, 0.27], concrete: [0.40, 0.37, 0.33],
  plaster: [0.55, 0.47, 0.36], brick: [0.40, 0.27, 0.18], wood: [0.30, 0.21, 0.13],
  crate: [0.36, 0.27, 0.16], metal: [0.25, 0.25, 0.25], metalgrate: [0.2, 0.2, 0.2],
  metaldoor: [0.22, 0.26, 0.27], tile: [0.42, 0.33, 0.24], cloth: [0.35, 0.18, 0.14],
  rock: [0.40, 0.34, 0.26], dirt: [0.34, 0.26, 0.18], rubber: [0.08, 0.08, 0.08],
  default: [0.45, 0.38, 0.28],
};

const PRESETS = {
  low:    { voxel: 48, sh: 96, sv: 64, rays: 32, iters: 2, steps: 64 },
  medium: { voxel: 32, sh: 80, sv: 56, rays: 48, iters: 2, steps: 80 },
  high:   { voxel: 32, sh: 64, sv: 48, rays: 64, iters: 2, steps: 80 },
  ultra:  { voxel: 24, sh: 56, sv: 40, rays: 96, iters: 3, steps: 128 },
};

// ---------------------------------------------------------------------------------------
// tri/box overlap (Akenine-Möller), box centred at origin with half size h
function triBox(h, a0x, a0y, a0z, a1x, a1y, a1z, a2x, a2y, a2z) {
  const e0x = a1x - a0x, e0y = a1y - a0y, e0z = a1z - a0z;
  const e1x = a2x - a1x, e1y = a2y - a1y, e1z = a2z - a1z;
  const e2x = a0x - a2x, e2y = a0y - a2y, e2z = a0z - a2z;
  let p0, p1, p2, mn, mx, rad, fa, fb;
  const T = (pa, pb, r) => { mn = Math.min(pa, pb); mx = Math.max(pa, pb); return mn > r || mx < -r; };
  // X axis tests
  fa = Math.abs(e0z); fb = Math.abs(e0y);
  p0 = e0z * a0y - e0y * a0z; p2 = e0z * a2y - e0y * a2z; rad = (fa + fb) * h; if (T(p0, p2, rad)) return false;
  p0 = -e0z * a0x + e0x * a0z; p2 = -e0z * a2x + e0x * a2z; fa = Math.abs(e0z); fb = Math.abs(e0x); rad = (fa + fb) * h; if (T(p0, p2, rad)) return false;
  p1 = e0y * a1x - e0x * a1y; p2 = e0y * a2x - e0x * a2y; fa = Math.abs(e0y); fb = Math.abs(e0x); rad = (fa + fb) * h; if (T(p1, p2, rad)) return false;
  fa = Math.abs(e1z); fb = Math.abs(e1y);
  p0 = e1z * a0y - e1y * a0z; p2 = e1z * a2y - e1y * a2z; rad = (fa + fb) * h; if (T(p0, p2, rad)) return false;
  p0 = -e1z * a0x + e1x * a0z; p2 = -e1z * a2x + e1x * a2z; fa = Math.abs(e1z); fb = Math.abs(e1x); rad = (fa + fb) * h; if (T(p0, p2, rad)) return false;
  p0 = e1y * a0x - e1x * a0y; p1 = e1y * a1x - e1x * a1y; fa = Math.abs(e1y); fb = Math.abs(e1x); rad = (fa + fb) * h; if (T(p0, p1, rad)) return false;
  fa = Math.abs(e2z); fb = Math.abs(e2y);
  p0 = e2z * a0y - e2y * a0z; p1 = e2z * a1y - e2y * a1z; rad = (fa + fb) * h; if (T(p0, p1, rad)) return false;
  p0 = -e2z * a0x + e2x * a0z; p1 = -e2z * a1x + e2x * a1z; fa = Math.abs(e2z); fb = Math.abs(e2x); rad = (fa + fb) * h; if (T(p0, p1, rad)) return false;
  p1 = e2y * a1x - e2x * a1y; p2 = e2y * a2x - e2x * a2y; fa = Math.abs(e2y); fb = Math.abs(e2x); rad = (fa + fb) * h; if (T(p1, p2, rad)) return false;
  // plane
  const nx = e0y * e1z - e0z * e1y, ny = e0z * e1x - e0x * e1z, nz = e0x * e1y - e0y * e1x;
  const d = -(nx * a0x + ny * a0y + nz * a0z);
  const r = h * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
  return Math.abs(d) <= r;
}

// Chebyshev (L-inf) distance in voxels from each empty voxel to the nearest solid one,
// capped at `cap`. Separable: x, then y (max with |dy|), then z.
function chebyshev(flag, nx, ny, nz, cap) {
  const N = nx * ny * nz, sx = 1, sy = nx, sz = nx * ny;
  let a = new Uint8Array(N), b = new Uint8Array(N);
  for (let i = 0; i < N; i++) a[i] = flag[i] & 1 ? 0 : cap;
  const pass = (src, dst, n, stride, lines) => {
    for (const base of lines) {
      for (let i = 0; i < n; i++) {
        let best = src[base + i * stride];
        for (let k = 1; k < best && k <= cap; k++) {
          if (i - k >= 0) { const v = Math.max(k, src[base + (i - k) * stride]); if (v < best) best = v; }
          if (i + k < n) { const v = Math.max(k, src[base + (i + k) * stride]); if (v < best) best = v; }
        }
        dst[base + i * stride] = best;
      }
    }
  };
  const linesX = [], linesY = [], linesZ = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) linesX.push(y * sy + z * sz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) linesY.push(x + z * sz);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) linesZ.push(x + y * sy);
  pass(a, b, nx, sx, linesX);
  pass(b, a, ny, sy, linesY);
  pass(a, b, nz, sz, linesZ);
  return b;
}

// ---------------------------------------------------------------------------------------
const AVG_VS = `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const AVG_FS = `precision highp float; uniform sampler2D tex; out vec4 o;
void main() { vec4 s = vec4(0.0);
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) s += textureLod(tex, (vec2(i, j) + 0.5) / 16.0, 0.0);
  o = s / 256.0; }`;

/** Average colour of each texture (linear), via one GPU pass per texture + one readback. */
function textureAverages(renderer, textures) {
  const out = new Map();
  if (!textures.length) return out;
  const n = textures.length;
  const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, depthBuffer: false });
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: AVG_VS, fragmentShader: AVG_FS,
    uniforms: { tex: { value: null } }, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const cam = new THREE.Camera();
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  for (let i = 0; i < n; i++) {
    mat.uniforms.tex.value = textures[i];
    rt.viewport.set(i, 0, 1, 1);
    renderer.setRenderTarget(rt);
    renderer.render(quad, cam);
  }
  const buf = new Float32Array(n * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, n, 1, buf);
  renderer.setRenderTarget(prevRT);
  for (let i = 0; i < n; i++) {
    const c = new THREE.Color(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
    if (!(c.r + c.g + c.b > 0.005) || !isFinite(c.r)) c.setRGB(0.5, 0.5, 0.5);
    out.set(textures[i], c);
  }
  rt.dispose(); mat.dispose(); quad.geometry.dispose();
  return out;
}

// ---------------------------------------------------------------------------------------
const GATHER_VS = `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function gatherFS(rays, steps) {
  return /* glsl */`
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp sampler2DShadow;
${SKY_GLSL}
uniform sampler3D uOcc;
uniform ivec3 uVDims;
uniform vec3 uVMin;
uniform float uVSize;
uniform vec3 uPMin, uPStep;
uniform int uPNZ, uLayer;
uniform sampler2DShadow uSun;
uniform mat4 uSunMat;
uniform float uSunBias;
uniform vec3 uSunE, uAmbGuess;
uniform float uBounce, uPrevOn, uPrevBias;
uniform sampler3D uP0, uP1, uP2;
uniform vec3 uPrevMin, uPrevInv;
uniform highp usampler3D uValid;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;

vec3 prevE(vec3 p, vec3 n) {
  vec3 uvw = (p - uPrevMin) * uPrevInv;
  vec4 t0 = texture(uP0, uvw), t1 = texture(uP1, uvw), t2 = texture(uP2, uvw);
  vec3 a = t0.rgb;
  vec3 e = a + vec3(t0.a, t1.rg) * n.x + vec3(t1.ba, t2.r) * n.y + t2.gba * n.z;
  return max(e, a * 0.2);
}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  int iz = pix.y;
  if (texelFetch(uValid, ivec3(pix.x, uLayer, iz), 0).r == 0u) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); return; }
  vec3 P = uPMin + (vec3(float(pix.x), float(uLayer), float(iz)) + 0.5) * uPStep;
  vec3 o = (P - uVMin) / uVSize;
  vec3 A = vec3(0.0), BX = vec3(0.0), BY = vec3(0.0), BZ = vec3(0.0);
  const int K = ${rays};
  for (int k = 0; k < K; k++) {
    float fk = float(k);
    float z = 1.0 - (2.0 * fk + 1.0) / float(K);
    float r = sqrt(max(0.0, 1.0 - z * z));
    float ph = 2.399963229728653 * fk;
    vec3 d = vec3(r * cos(ph), z, r * sin(ph));
    // DDA
    ivec3 cell = ivec3(floor(o));
    ivec3 st = ivec3(sign(d));
    vec3 ad = max(abs(d), vec3(1e-6));
    vec3 tD = 1.0 / ad;
    float invMax = 1.0 / max(ad.x, max(ad.y, ad.z));
    vec3 fc = vec3(cell);
    vec3 tM = vec3(
      d.x > 0.0 ? (fc.x + 1.0 - o.x) * tD.x : (d.x < 0.0 ? (o.x - fc.x) * tD.x : 1e30),
      d.y > 0.0 ? (fc.y + 1.0 - o.y) * tD.y : (d.y < 0.0 ? (o.y - fc.y) * tD.y : 1e30),
      d.z > 0.0 ? (fc.z + 1.0 - o.z) * tD.z : (d.z < 0.0 ? (o.z - fc.z) * tD.z : 1e30));
    float t = 0.0; int ax = 0; bool hit = false; vec3 alb = vec3(0.0);
    for (int s = 0; s < ${steps}; s++) {
      if (tM.x < tM.y && tM.x < tM.z) { t = tM.x; tM.x += tD.x; cell.x += st.x; ax = 0; }
      else if (tM.y < tM.z) { t = tM.y; tM.y += tD.y; cell.y += st.y; ax = 1; }
      else { t = tM.z; tM.z += tD.z; cell.z += st.z; ax = 2; }
      if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, uVDims))) break;
      vec4 v = texelFetch(uOcc, cell, 0);
      if (v.a > 0.0) { hit = true; alb = v.rgb; break; }
      // empty: .r holds the Chebyshev distance to the nearest solid voxel -> skip ahead
      float k = floor(v.r * 255.0 + 0.5);
      if (k >= 2.0) {
        t += (k - 1.0) * invMax;
        vec3 q = o + d * t;
        cell = ivec3(floor(q));
        fc = vec3(cell);
        tM = vec3(
          d.x > 0.0 ? t + (fc.x + 1.0 - q.x) * tD.x : (d.x < 0.0 ? t + (q.x - fc.x) * tD.x : 1e30),
          d.y > 0.0 ? t + (fc.y + 1.0 - q.y) * tD.y : (d.y < 0.0 ? t + (q.y - fc.y) * tD.y : 1e30),
          d.z > 0.0 ? t + (fc.z + 1.0 - q.z) * tD.z : (d.z < 0.0 ? t + (q.z - fc.z) * tD.z : 1e30));
        if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, uVDims))) break;
      }
    }
    vec3 L;
    if (hit) {
      vec3 n = vec3(0.0);
      if (ax == 0) n.x = -float(st.x); else if (ax == 1) n.y = -float(st.y); else n.z = -float(st.z);
      vec3 hp = P + d * (t * uVSize);
      vec3 sp = hp + n * (0.5 * uVSize) + rpSunDir * 2.0;
      vec4 sc = uSunMat * vec4(sp, 1.0);
      float vis = 1.0;
      if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) vis = texture(uSun, vec3(sc.xy, sc.z - uSunBias));
      vec3 E = uSunE * max(dot(n, rpSunDir), 0.0) * vis;
      E += uPrevOn > 0.5 ? prevE(hp + n * uPrevBias, n) : uAmbGuess;
      L = alb * E * (uBounce / 3.14159265);
    } else {
      L = rpSkyRadiance(d, 0.0);
    }
    A += L; BX += L * d.x; BY += L * d.y; BZ += L * d.z;
  }
  const float PI = 3.14159265;
  A *= PI / float(K);
  float kb = 2.0 * PI / float(K);
  BX *= kb; BY *= kb; BZ *= kb;
  o0 = vec4(A, BX.r);
  o1 = vec4(BX.gb, BY.rg);
  o2 = vec4(BY.b, BZ);
}
`;
}

// ---------------------------------------------------------------------------------------
export class GIVolume {
  constructor(renderer) {
    this.renderer = renderer;
    this.preset = PRESETS.high;
    this.textures = null;
    this.ready = false;
    this.data = null;      // CPU copy (Float32, 12 per probe) for ambientAt()
    this.epoch = 0;        // bumps on every bake
    this.stats = {};
  }

  setQuality(q) { this.preset = PRESETS[q] || PRESETS.high; }

  /** Playable-area bounds from solid collision brushes (falls back to render bounds). */
  static bounds(map) {
    const box = new THREE.Box3();
    const brushes = map.collision?.brushes;
    if (brushes?.length) {
      for (const b of brushes) {
        if (!(b.contents & 1)) continue;
        if (!isFinite(b.min.x) || !isFinite(b.max.x)) continue;
        box.expandByPoint(b.min); box.expandByPoint(b.max);
      }
    }
    if (box.isEmpty()) box.setFromObject(map.root);
    // clamp absurd extents (skybox / background props)
    const c = box.getCenter(new THREE.Vector3());
    const lim = 7000;
    box.min.max(c.clone().subScalar(lim)); box.max.min(c.clone().addScalar(lim));
    box.min.y = Math.max(box.min.y, c.y - 1500); box.max.y = Math.min(box.max.y, c.y + 1500);
    return box;
  }

  /**
   * Bake. opts: { map, bounds, sunMat (Matrix4), sunDepth (DepthTexture), sunBias, sunE (Color),
   *               bounce, openSkyGuess (Color) }
   */
  bake(opts) {
    const t0 = performance.now();
    const P = this.preset;
    const { map } = opts;
    const bounds = opts.bounds.clone();
    bounds.min.y -= P.voxel; bounds.max.y += P.sv * 2;

    // ---- probe grid ----
    const pad = new THREE.Vector3(P.sh * 0.5, P.sv * 0.5, P.sh * 0.5);
    const gmin = bounds.min.clone().sub(pad);
    const gsize = bounds.getSize(new THREE.Vector3()).add(pad.clone().multiplyScalar(2));
    const nx = Math.max(2, Math.ceil(gsize.x / P.sh));
    const ny = Math.max(2, Math.ceil(gsize.y / P.sv));
    const nz = Math.max(2, Math.ceil(gsize.z / P.sh));
    const step = new THREE.Vector3(P.sh, P.sv, P.sh);
    const gext = new THREE.Vector3(nx * P.sh, ny * P.sv, nz * P.sh);

    // ---- voxel grid ----
    const V = P.voxel;
    const vmin = gmin.clone();
    const vx = Math.ceil(gext.x / V), vy = Math.ceil(gext.y / V), vz = Math.ceil(gext.z / V);
    const occ = this._voxelize(map, vmin, V, vx, vy, vz);
    const t1 = performance.now();

    const occTex = new THREE.Data3DTexture(occ.rgba, vx, vy, vz);
    occTex.format = THREE.RGBAFormat; occTex.type = THREE.UnsignedByteType;
    occTex.minFilter = occTex.magFilter = THREE.NearestFilter;
    occTex.unpackAlignment = 1; occTex.needsUpdate = true;

    // ---- probe validity (inside solid brush or below-ground fill) ----
    const nP = nx * ny * nz;
    const valid = new Uint8Array(nP);
    const col = map.collision;
    const p = new THREE.Vector3();
    for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      p.set(gmin.x + (ix + 0.5) * P.sh, gmin.y + (iy + 0.5) * P.sv, gmin.z + (iz + 0.5) * P.sh);
      let ok = true;
      const cx = Math.floor((p.x - vmin.x) / V), cy = Math.floor((p.y - vmin.y) / V), cz = Math.floor((p.z - vmin.z) / V);
      if (cx >= 0 && cy >= 0 && cz >= 0 && cx < vx && cy < vy && cz < vz && occ.fill[cx + cy * vx + cz * vx * vy]) ok = false;
      if (ok && col?.pointContents && (col.pointContents(p) & 1)) ok = false;
      valid[ix + iy * nx + iz * nx * ny] = ok ? 1 : 0;
    }
    const t2 = performance.now();
    const validTex = new THREE.Data3DTexture(valid, nx, ny, nz);
    validTex.format = THREE.RedIntegerFormat; validTex.type = THREE.UnsignedByteType;
    validTex.internalFormat = 'R8UI';
    validTex.minFilter = validTex.magFilter = THREE.NearestFilter;
    validTex.unpackAlignment = 1; validTex.needsUpdate = true;

    // ---- GPU gather ----
    const r = this.renderer;
    const rt = new THREE.WebGLRenderTarget(nx, nz, {
      type: THREE.FloatType, format: THREE.RGBAFormat, count: 3, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    const u = {
      ...skyUniforms,
      uOcc: { value: occTex }, uVDims: { value: new THREE.Vector3(vx, vy, vz) },
      uVMin: { value: vmin }, uVSize: { value: V },
      uPMin: { value: gmin }, uPStep: { value: step }, uPNZ: { value: nz }, uLayer: { value: 0 },
      uSun: { value: opts.sunDepth }, uSunMat: { value: opts.sunMat }, uSunBias: { value: opts.sunBias ?? 0.0005 },
      uSunE: { value: opts.sunE.clone() }, uAmbGuess: { value: opts.openSkyGuess.clone() },
      uBounce: { value: opts.bounce ?? 1 }, uPrevOn: { value: 0 }, uPrevBias: { value: P.sh * 0.5 },
      uP0: { value: null }, uP1: { value: null }, uP2: { value: null },
      uPrevMin: { value: gmin }, uPrevInv: { value: new THREE.Vector3(1 / gext.x, 1 / gext.y, 1 / gext.z) },
      uValid: { value: validTex },
    };
    u.uVDims.value = new THREE.Vector3(vx, vy, vz);
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GATHER_VS, fragmentShader: gatherFS(P.rays, P.steps),
      uniforms: u, depthTest: false, depthWrite: false,
    });
    // ivec3 uniform: three maps Vector3 -> vec3; use a plain array for ivec3
    u.uVDims.value = [vx, vy, vz];
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const cam = new THREE.Camera();
    const prevRT = r.getRenderTarget();
    const layer = new Float32Array(nx * nz * 4);
    const raw = [new Float32Array(nP * 4), new Float32Array(nP * 4), new Float32Array(nP * 4)];
    let tex = null;
    for (let it = 0; it < P.iters; it++) {
      if (tex) { u.uP0.value = tex[0]; u.uP1.value = tex[1]; u.uP2.value = tex[2]; u.uPrevOn.value = 1; }
      for (let iy = 0; iy < ny; iy++) {
        u.uLayer.value = iy;
        r.setRenderTarget(rt);
        r.render(quad, cam);
        for (let t = 0; t < 3; t++) {
          r.readRenderTargetPixels(rt, 0, 0, nx, nz, layer, undefined, t);
          const dst = raw[t];
          for (let iz = 0; iz < nz; iz++) {
            const src = iz * nx * 4, di = (iy * nx + iz * nx * ny) * 4;
            dst.set(layer.subarray(src, src + nx * 4), di);
          }
        }
      }
      this._dilate(raw, valid, nx, ny, nz);
      const next = this._upload(raw, nx, ny, nz);
      if (tex && tex !== this.textures) for (const t of tex) t.dispose();
      tex = next;
    }
    r.setRenderTarget(prevRT);
    rt.dispose(); mat.dispose(); quad.geometry.dispose(); occTex.dispose(); validTex.dispose();

    // ---- publish ----
    const old = this.textures;
    this.textures = tex;
    if (old && old !== tex) for (const t of old) t.dispose();
    const L = lightUniforms;
    L.rpGI0.value = tex[0]; L.rpGI1.value = tex[1]; L.rpGI2.value = tex[2];
    L.rpGIMin.value.copy(gmin);
    L.rpGIInvSize.value.set(1 / gext.x, 1 / gext.y, 1 / gext.z);
    L.rpGIBias.value = P.sh * 0.55;
    L.rpGIOn.value = 1;
    this.grid = { gmin, gext, nx, ny, nz, step };
    this.data = raw;
    // specular occlusion reference: brightest ambient term among valid probes in the top layer
    let ref = 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = (ix + (ny - 1) * nx + iz * nx * ny) * 4;
      ref = Math.max(ref, 0.2126 * raw[0][i] + 0.7152 * raw[0][i + 1] + 0.0722 * raw[0][i + 2]);
    }
    L.rpSpecRef.value = Math.max(ref * 0.9, 1e-3);
    this.ready = true;
    this.epoch++;
    const t3 = performance.now();
    this.stats = {
      probes: [nx, ny, nz], voxels: [vx, vy, vz], rays: P.rays, iters: P.iters,
      voxelMs: Math.round(t1 - t0), validMs: Math.round(t2 - t1), gatherMs: Math.round(t3 - t2), totalMs: Math.round(t3 - t0),
      invalid: nP - valid.reduce((s, v) => s + v, 0), ...this._vt,
    };
    Dbg.log('[gi] baked', this.stats);
    return this.stats;
  }

  _dilate(raw, valid, nx, ny, nz) {
    const nP = nx * ny * nz;
    const ok = valid.slice();
    const idx = (x, y, z) => x + y * nx + z * nx * ny;
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const acc = new Float32Array(12);
    for (let pass = 0; pass < 8; pass++) {
      const fill = [];
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = idx(x, y, z);
        if (ok[i]) continue;
        acc.fill(0); let w = 0;
        for (const [dx, dy, dz] of nb) {
          const X = x + dx, Y = y + dy, Z = z + dz;
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
          const j = idx(X, Y, Z);
          if (!ok[j]) continue;
          // prefer neighbours above (open air) over those to the side
          const wt = dy > 0 ? 1.5 : 1;
          for (let t = 0; t < 3; t++) for (let c = 0; c < 4; c++) acc[t * 4 + c] += raw[t][j * 4 + c] * wt;
          w += wt;
        }
        if (w > 0) fill.push(i, ...Array.from(acc, (v) => v / w));
      }
      if (!fill.length) break;
      for (let k = 0; k < fill.length; k += 13) {
        const i = fill[k];
        for (let t = 0; t < 3; t++) for (let c = 0; c < 4; c++) raw[t][i * 4 + c] = fill[k + 1 + t * 4 + c];
        ok[i] = 1;
      }
    }
    // anything still invalid (deep inside big solids): global mean of valid probes
    let m = new Float32Array(12), n = 0;
    for (let i = 0; i < nP; i++) if (ok[i]) { for (let t = 0; t < 3; t++) for (let c = 0; c < 4; c++) m[t * 4 + c] += raw[t][i * 4 + c]; n++; }
    if (n) for (let i = 0; i < nP; i++) if (!ok[i]) for (let t = 0; t < 3; t++) for (let c = 0; c < 4; c++) raw[t][i * 4 + c] = m[t * 4 + c] / n;
  }

  _upload(raw, nx, ny, nz) {
    const out = [];
    for (let t = 0; t < 3; t++) {
      const src = raw[t];
      const half = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
      const tex = new THREE.Data3DTexture(half, nx, ny, nz);
      tex.format = THREE.RGBAFormat; tex.type = THREE.HalfFloatType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      out.push(tex);
    }
    return out;
  }

  _voxelize(map, vmin, V, vx, vy, vz) {
    this._t0 = performance.now();
    const N = vx * vy * vz;
    const flag = new Uint8Array(N);          // 1 solid, 2 has triangle albedo, 4 fill
    const sum = new Float32Array(N * 3);
    const cnt = new Uint16Array(N);
    const h = V * 0.5;
    const stride = vx * vy;
    // 1) solid brushes (conservative plane test against voxel boxes)
    const brushes = map.collision?.brushes || [];
    for (const b of brushes) {
      if (!(b.contents & 1)) continue;
      const alb = SURF_ALBEDO[b.surface] || SURF_ALBEDO.default;
      const x0 = Math.max(0, Math.floor((b.min.x - vmin.x) / V)), x1 = Math.min(vx - 1, Math.floor((b.max.x - vmin.x) / V));
      const y0 = Math.max(0, Math.floor((b.min.y - vmin.y) / V)), y1 = Math.min(vy - 1, Math.floor((b.max.y - vmin.y) / V));
      const z0 = Math.max(0, Math.floor((b.min.z - vmin.z) / V)), z1 = Math.min(vz - 1, Math.floor((b.max.z - vmin.z) / V));
      if (x1 < x0 || y1 < y0 || z1 < z0) continue;
      const planes = b.planes.map((pl) => [pl.n.x, pl.n.y, pl.n.z, pl.dist, h * (Math.abs(pl.n.x) + Math.abs(pl.n.y) + Math.abs(pl.n.z))]);
      for (let z = z0; z <= z1; z++) {
        const cz = vmin.z + (z + 0.5) * V;
        for (let y = y0; y <= y1; y++) {
          const cy = vmin.y + (y + 0.5) * V;
          for (let x = x0; x <= x1; x++) {
            const cx = vmin.x + (x + 0.5) * V;
            let inside = true;
            for (let k = 0; k < planes.length; k++) {
              const q = planes[k];
              // strictly separated or merely touching -> outside (keeps floors 1 voxel thin)
              if (q[0] * cx + q[1] * cy + q[2] * cz - q[4] >= q[3] - 0.01) { inside = false; break; }
            }
            if (!inside) continue;
            const i = x + y * vx + z * stride;
            flag[i] |= 1;
            if (!cnt[i]) { sum[i * 3] = alb[0]; sum[i * 3 + 1] = alb[1]; sum[i * 3 + 2] = alb[2]; }
          }
        }
      }
    }
    // 2) render triangles with material albedo
    const tb = performance.now();
    const albedoOf = this._materialAlbedos(map.root);
    const ta = performance.now();
    const m4 = new THREE.Matrix4(), im = new THREE.Matrix4();
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const tn = new THREE.Vector3(), te = new THREE.Vector3();
    let tris = 0;
    map.root.updateMatrixWorld(true);
    map.root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || !o.visible || o.userData?.rpSkip || o.userData?.noGI) return;
      const g = o.geometry;
      const pos = g?.attributes?.position;
      if (!pos) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const index = g.index;
      const groups = g.groups?.length ? g.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
      const instances = o.isInstancedMesh ? o.count : 1;
      for (let inst = 0; inst < instances; inst++) {
        if (o.isInstancedMesh) { o.getMatrixAt(inst, im); m4.multiplyMatrices(o.matrixWorld, im); }
        else m4.copy(o.matrixWorld);
        for (const gr of groups) {
          const mat = mats[gr.materialIndex ?? 0];
          if (!mat || mat.visible === false || mat.transparent || mat.colorWrite === false) continue;
          const alb = albedoOf.get(mat);
          if (!alb) continue;
          const end = Math.min(gr.start + gr.count, index ? index.count : pos.count);
          for (let t = gr.start; t + 2 < end; t += 3) {
            const i0 = index ? index.getX(t) : t, i1 = index ? index.getX(t + 1) : t + 1, i2 = index ? index.getX(t + 2) : t + 2;
            va.fromBufferAttribute(pos, i0).applyMatrix4(m4);
            vb.fromBufferAttribute(pos, i1).applyMatrix4(m4);
            vc.fromBufferAttribute(pos, i2).applyMatrix4(m4);
            // nudge 1u behind the face so boundary-aligned surfaces land in the solid voxel
            tn.subVectors(vc, vb).cross(te.subVectors(va, vb));
            const tl = tn.length();
            if (tl > 1e-8) { tn.multiplyScalar(-1 / tl); va.add(tn); vb.add(tn); vc.add(tn); }
            this._rasterTri(va, vb, vc, alb, vmin, V, vx, vy, vz, flag, sum, cnt);
            tris++;
          }
        }
      }
    });
    this._vt = { brushMs: Math.round(tb - this._t0), albedoMs: Math.round(ta - tb), triMs: Math.round(performance.now() - ta), tris };
    // 3) fill each column below its lowest occupied voxel (under-floor never leaks)
    for (let z = 0; z < vz; z++) for (let x = 0; x < vx; x++) {
      let lowest = -1;
      for (let y = 0; y < vy; y++) if (flag[x + y * vx + z * stride] & 1) { lowest = y; break; }
      if (lowest <= 0) continue;
      const top = lowest;
      const ai = x + top * vx + z * stride;
      for (let y = 0; y < top; y++) {
        const i = x + y * vx + z * stride;
        flag[i] |= 5;
        sum[i * 3] = sum[ai * 3]; sum[i * 3 + 1] = sum[ai * 3 + 1]; sum[i * 3 + 2] = sum[ai * 3 + 2];
        cnt[i] = cnt[ai] ? 1 : 0;
        if (cnt[ai]) { sum[i * 3] /= cnt[ai]; sum[i * 3 + 1] /= cnt[ai]; sum[i * 3 + 2] /= cnt[ai]; }
      }
    }
    const rgba = new Uint8Array(N * 4);
    const fill = new Uint8Array(N);
    const dist = chebyshev(flag, vx, vy, vz, 12);
    for (let i = 0; i < N; i++) {
      if (!(flag[i] & 1)) { rgba[i * 4] = dist[i]; continue; }
      const c = cnt[i] || 1;
      rgba[i * 4] = Math.min(255, Math.round((sum[i * 3] / c) * 255));
      rgba[i * 4 + 1] = Math.min(255, Math.round((sum[i * 3 + 1] / c) * 255));
      rgba[i * 4 + 2] = Math.min(255, Math.round((sum[i * 3 + 2] / c) * 255));
      rgba[i * 4 + 3] = 255;
      if (flag[i] & 4) fill[i] = 1;
    }
    return { rgba, fill };
  }

  _rasterTri(a, b, c, alb, vmin, V, vx, vy, vz, flag, sum, cnt) {
    const h = V * 0.5;
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - vmin.x) / V));
    const x1 = Math.min(vx - 1, Math.floor((Math.max(a.x, b.x, c.x) - vmin.x) / V));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y, c.y) - vmin.y) / V));
    const y1 = Math.min(vy - 1, Math.floor((Math.max(a.y, b.y, c.y) - vmin.y) / V));
    const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - vmin.z) / V));
    const z1 = Math.min(vz - 1, Math.floor((Math.max(a.z, b.z, c.z) - vmin.z) / V));
    if (x1 < x0 || y1 < y0 || z1 < z0) return;
    const stride = vx * vy;
    const single = x0 === x1 && y0 === y1 && z0 === z1;
    for (let z = z0; z <= z1; z++) {
      const cz = vmin.z + (z + 0.5) * V;
      for (let y = y0; y <= y1; y++) {
        const cy = vmin.y + (y + 0.5) * V;
        for (let x = x0; x <= x1; x++) {
          const cx = vmin.x + (x + 0.5) * V;
          if (!single && !triBox(h * 1.001, a.x - cx, a.y - cy, a.z - cz, b.x - cx, b.y - cy, b.z - cz, c.x - cx, c.y - cy, c.z - cz)) continue;
          const i = x + y * vx + z * stride;
          if (!(flag[i] & 2)) { sum[i * 3] = 0; sum[i * 3 + 1] = 0; sum[i * 3 + 2] = 0; cnt[i] = 0; }
          flag[i] |= 3;
          if (cnt[i] < 65000) { sum[i * 3] += alb.r; sum[i * 3 + 1] += alb.g; sum[i * 3 + 2] += alb.b; cnt[i]++; }
        }
      }
    }
  }

  _materialAlbedos(root) {
    const mats = new Set();
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
    });
    const texs = new Set();
    for (const m of mats) if (m.map) texs.add(m.map);
    let avg = new Map();
    try { avg = textureAverages(this.renderer, [...texs]); }
    catch (e) { Dbg.warn('[gi] texture averages failed', e); }
    const out = new Map();
    for (const m of mats) {
      if (!m.color) { out.set(m, new THREE.Color(0.45, 0.38, 0.28)); continue; }
      const c = m.color.clone();
      if (m.map) c.multiply(avg.get(m.map) || new THREE.Color(0.5, 0.5, 0.5));
      // emissive/unlit materials still bounce their colour
      c.r = Math.min(c.r, 0.9); c.g = Math.min(c.g, 0.9); c.b = Math.min(c.b, 0.9);
      out.set(m, c);
    }
    return out;
  }

  /** CPU irradiance at a world point for normal n (for FX/HUD tinting). */
  ambientAt(pos, n, out = new THREE.Color()) {
    const g = this.grid, d = this.data;
    if (!g || !d) return out.setRGB(0.3, 0.3, 0.3);
    const fx = THREE.MathUtils.clamp((pos.x - g.gmin.x) / g.step.x - 0.5, 0, g.nx - 1);
    const fy = THREE.MathUtils.clamp((pos.y - g.gmin.y) / g.step.y - 0.5, 0, g.ny - 1);
    const fz = THREE.MathUtils.clamp((pos.z - g.gmin.z) / g.step.z - 0.5, 0, g.nz - 1);
    const ix = Math.round(fx), iy = Math.round(fy), iz = Math.round(fz);
    const i = (ix + iy * g.nx + iz * g.nx * g.ny) * 4;
    const t0 = d[0], t1 = d[1], t2 = d[2];
    const r = t0[i] + t0[i + 3] * n.x + t1[i + 2] * n.y + t2[i + 1] * n.z;
    const gg = t0[i + 1] + t1[i] * n.x + t1[i + 3] * n.y + t2[i + 2] * n.z;
    const b = t0[i + 2] + t1[i + 1] * n.x + t2[i] * n.y + t2[i + 3] * n.z;
    return out.setRGB(Math.max(r, 0), Math.max(gg, 0), Math.max(b, 0));
  }
}
