// Sun shadows: up to 3 camera-fitted cascades + 1 static whole-map cascade.
//
// Three.js renders every shadow map (so castShadow, alphaTest, skinning and instancing are
// all handled by its depth materials); we only place the shadow cameras and sample the depth
// textures ourselves with hardware PCF (sampler2DShadow) in lighting.js. Light 0 carries the
// real sun intensity (so unpatched materials are still lit correctly); the other cascade
// lights have intensity 0 and exist only to own a shadow map.
//
// Dynamic cascades use bounding spheres of the view-frustum slices, snapped to texels, so
// edges never shimmer while turning. The static cascade covers the whole playable area at
// 4096² and is rendered once per map; beyond the last dynamic split it is the only shadow,
// and inside the last split it is min()'d in so static geometry keeps full resolution.
import * as THREE from 'three';

const DEG = Math.PI / 180;
export const MAX_DYN = 3;
export const shadowConfig = { pcf: 5 };
export const STATIC_SLOT = 3;

export const shadowUniforms = {
  rpShadowMap0: { value: null }, rpShadowMap1: { value: null },
  rpShadowMap2: { value: null }, rpShadowMap3: { value: null },
  rpShadowMat: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
  // x: normal offset (world units), y: depth bias (depth units), z: texel (uv), w: 1 = min with static
  rpShadowParams: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  rpShadowSplit: { value: new THREE.Vector4(1e9, 1e9, 1e9, 0.12) }, // far of dyn cascades, w = blend band
  rpShadowDyn: { value: 0 },
  rpShadowOn: { value: 1 },
};

const PRESETS = {
  low:    { dyn: 1, size: 1024, staticSize: 2048, splits: [520], pcf: 3, stagger: false },
  medium: { dyn: 2, size: 2048, staticSize: 2048, splits: [260, 1100], pcf: 3, stagger: true },
  high:   { dyn: 3, size: 2048, staticSize: 4096, splits: [190, 680, 1700], pcf: 5, stagger: true },
  ultra:  { dyn: 3, size: 2048, staticSize: 4096, splits: [170, 600, 1700], pcf: 5, stagger: false },
};

const _v = new THREE.Vector3(), _fwd = new THREE.Vector3(), _pos = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function makeShadowRT(size, packed) {
  const dt = new THREE.DepthTexture(size, size);
  dt.type = THREE.UnsignedIntType;
  dt.compareFunction = THREE.LessEqualCompare;
  dt.minFilter = dt.magFilter = THREE.LinearFilter;
  dt.name = 'rp.shadowDepth';
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    format: packed ? THREE.RGBAFormat : THREE.RedFormat,
    type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false, depthTexture: dt,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

export class SunShadows {
  constructor(scene) {
    this.scene = scene;
    this.toSun = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
    this.bias = 1;          // shadow_bias cvar multiplier
    this.preset = PRESETS.high;
    this.frame = 0;
    this.bounds = null;     // Box3 of the playable area (static cascade)
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 0);
      l.name = i === STATIC_SLOT ? 'rp.sun.static' : `rp.sun.c${i}`;
      l.castShadow = true;
      l.shadow.bias = 0;
      l.shadow.normalBias = 0;
      l.shadow.autoUpdate = i !== STATIC_SLOT;
      l.userData.rpSkip = true;
      l.target.userData.rpSkip = true;
      scene.add(l, l.target);
      this.lights.push(l);
      shadowUniforms.rpShadowMat.value[i] = l.shadow.matrix; // live reference
    }
    this.sun = this.lights[0]; // carries the real intensity/colour
    this._r = [0, 0, 0, 0];
    this._sig = [NaN, NaN, NaN];
    this.staticRoot = null;   // map root: static casters, excluded from the per-frame hash
    this.force = true;
  }

  /**
   * Hash of every dynamic object's transform (and a few bones for skinned meshes, attribute
   * versions for particles). Returns the caster-only hash; the all-objects hash is left in
   * this.sceneHash for the renderer's static-frame cache.
   */
  _dynamicHash() {
    let h = 0, n = 0, all = 0;
    const visit = (o) => {
      if (!o.visible || o === this.staticRoot || o.userData?.rpSkip) return;
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
        const e = o.matrixWorld.elements;
        all += e[12] * 1.13 + e[13] * 2.41 + e[14] * 3.37 + e[0] * 5.9 + e[2] * 7.7 + e[5] * 2.3 + e[10] * 0.61;
        const at = o.geometry?.attributes;
        if (at) for (const k in at) all += (at[k].version || 0) * 0.917;
        if (o.isInstancedMesh) all += o.count * 0.37 + (o.instanceMatrix?.version || 0) * 1.7;
        if (o.material && !Array.isArray(o.material)) all += (o.material.opacity ?? 1) * 0.3 + (o.material.version || 0) * 0.07;
        all += 11.3;
      }
      if (o.castShadow && (o.isMesh || o.isPoints || o.isLine)) {
        const e = o.matrixWorld.elements;
        h += e[12] * 1.31 + e[13] * 2.17 + e[14] * 3.07 + e[0] * 5.3 + e[2] * 7.1 + e[5] * 1.9;
        if (o.isSkinnedMesh && o.skeleton) {
          const b = o.skeleton.bones;
          for (let i = 0; i < b.length; i += Math.max(1, b.length >> 3)) {
            const m = b[i].matrixWorld.elements;
            h += m[12] * 0.71 + m[13] * 0.37 + m[14] * 0.53 + m[0] * 0.29;
          }
        }
        if (o.isInstancedMesh) h += o.count * 0.013 + (o.instanceMatrix?.version || 0) * 0.77;
        n++;
      }
      const c = o.children;
      for (let i = 0; i < c.length; i++) visit(c[i]);
    };
    visit(this.scene);
    this.sceneHash = all + h;
    return h + n * 101.3;
  }

  setSun(toSun, color, intensity) {
    this.toSun.copy(toSun).normalize();
    this.sun.color.copy(color);
    this.sun.intensity = intensity;
    this._fitStatic();
    this.force = true;
  }

  setQuality(q) {
    const p = PRESETS[q] || PRESETS.high;
    const prev = this.preset;
    this.preset = p;
    const u = shadowUniforms;
    u.rpShadowDyn.value = p.dyn;
    u.rpShadowSplit.value.set(p.splits[0] ?? 1e9, p.splits[1] ?? 1e9, p.splits[2] ?? 1e9, 0.12);
    for (let i = 0; i < 4; i++) {
      const l = this.lights[i];
      const used = i === STATIC_SLOT || i < p.dyn;
      l.visible = used;
      const size = i === STATIC_SLOT ? p.staticSize : p.size;
      if (used && (!l.shadow.map || l.shadow.map.width !== size)) {
        l.shadow.map?.dispose();
        l.shadow.map = makeShadowRT(size, i === 0);
        l.shadow.mapSize.set(size, size);
        l.shadow.needsUpdate = true;
      }
      u[`rpShadowMap${i}`].value = used ? l.shadow.map.depthTexture : null;
      u.rpShadowParams.value[i].w = 0;
    }
    this.lights[STATIC_SLOT].shadow.needsUpdate = true;
    shadowConfig.pcf = this.software ? 3 : p.pcf;
    this._fitStatic();
    this.force = true;
    return prev !== p;
  }

  get pcf() { return shadowConfig.pcf; }

  setBounds(box) { this.bounds = box.clone(); this._fitStatic(); }

  // Light-space basis identical to Object3D.lookAt on the shadow camera.
  _basis() {
    _z.copy(this.toSun);
    _x.crossVectors(UP, _z);
    if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
    _x.normalize();
    _y.crossVectors(_z, _x);
  }

  _fitStatic() {
    const l = this.lights[STATIC_SLOT];
    if (!this.bounds) return;
    this._basis();
    const b = this.bounds;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      const px = _v.dot(_x), py = _v.dot(_y), pz = _v.dot(_z);
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      z0 = Math.min(z0, pz); z1 = Math.max(z1, pz);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const hx = (x1 - x0) / 2 + 32, hy = (y1 - y0) / 2 + 32;
    const back = 400;
    // camera sits on the sun side of the bounds, looking toward -toSun
    _pos.copy(_x).multiplyScalar(cx).addScaledVector(_y, cy).addScaledVector(_z, z1 + back);
    l.position.copy(_pos);
    l.target.position.copy(_pos).sub(this.toSun);
    l.updateMatrixWorld(); l.target.updateMatrixWorld();
    const cam = l.shadow.camera;
    cam.left = -hx; cam.right = hx; cam.top = hy; cam.bottom = -hy;
    cam.near = 1; cam.far = (z1 - z0) + back + 64;
    cam.updateProjectionMatrix();
    const size = this.preset.staticSize;
    const texel = Math.max(2 * hx, 2 * hy) / size;
    this._setParams(STATIC_SLOT, texel, cam.far - cam.near);
    this._r[STATIC_SLOT] = texel;
    l.shadow.needsUpdate = true;
  }

  _setParams(i, texelWorld, depthRange) {
    const P = shadowUniforms.rpShadowParams.value[i];
    const pcfR = shadowConfig.pcf === 5 ? 2.5 : 1.5;
    // normal offset ~ filter radius in world units; tiny constant depth bias
    P.x = texelWorld * (0.6 + 0.35 * pcfR) * this.bias;
    P.y = (texelWorld * 0.35 * this.bias + 0.05) / depthRange;
    P.z = 1 / (i === STATIC_SLOT ? this.preset.staticSize : this.preset.size);
  }

  setBias(b) { this.bias = b; this._fitStatic(); this.force = true; }

  /** Fit dynamic cascades to the camera. Call once per frame before rendering. */
  update(camera) {
    const p = this.preset;
    this.frame++;
    this._basis();
    camera.matrixWorld.decompose(_pos, _q, _s);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    const ty = Math.tan(camera.fov * DEG / 2) / (camera.zoom || 1);
    const tx = ty * camera.aspect;
    const t2 = tx * tx + ty * ty;
    let near = camera.near;
    const dyn = this._dynamicHash();
    for (let i = 0; i < p.dyn; i++) {
      const l = this.lights[i];
      const far = p.splits[i];
      l.shadow.autoUpdate = false;
      // stagger the outermost dynamic cascade: every other frame, and only fit when rendered
      const stag = p.stagger && i === p.dyn - 1 && p.dyn > 1;
      if (stag && (this.frame & 1) === 0 && this._r[i] > 0 && !this.force) { l.shadow.needsUpdate = false; near = far; continue; }
      // bounding sphere of the frustum slice [near, far]
      let zc = (far + near) * (1 + t2) / 2;
      if (zc > far) zc = far;
      const r = Math.sqrt((far - zc) ** 2 + far * far * t2) * 1.03 + 8;
      const size = p.size;
      const texel = (2 * r) / size;
      _c.copy(_pos).addScaledVector(_fwd, zc);
      // snap the centre to the light-space texel grid
      const cx = _c.dot(_x), cy = _c.dot(_y), cz = _c.dot(_z);
      const sx = Math.round(cx / texel) * texel, sy = Math.round(cy / texel) * texel;
      const back = r + 2600; // casters between the slice and the sun (tall buildings)
      l.position.copy(_x).multiplyScalar(sx).addScaledVector(_y, sy).addScaledVector(_z, cz + back);
      l.target.position.copy(l.position).sub(this.toSun);
      l.updateMatrixWorld(); l.target.updateMatrixWorld();
      const cam = l.shadow.camera;
      if (Math.abs(this._r[i] - r) > 1e-3) {
        cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
        cam.near = 1; cam.far = back + r + 64;
        cam.updateProjectionMatrix();
        this._r[i] = r;
      }
      this._setParams(i, texel, cam.far - cam.near);
      // re-render only if the cascade moved or something dynamic moved
      const sig = sx * 0.913 + sy * 1.771 + Math.round(cz) * 0.531 + r * 3.3 + dyn + this.toSun.x * 97 + this.toSun.y * 131;
      l.shadow.needsUpdate = this.force || sig !== this._sig[i] || !l.shadow.map;
      this._sig[i] = sig;
      near = far;
    }
    this.force = false;
  }

  invalidate() { this.force = true; this.lights[STATIC_SLOT].shadow.needsUpdate = true; }

  /** World-space texel size per cascade (debug/probe). */
  texels() { return this._r.map((r, i) => (i === STATIC_SLOT ? r : (2 * r) / this.preset.size)); }
}

const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Vector3();

// GLSL: cascade selection + Castaño optimised PCF on hardware-compare depth textures.
export const SHADOW_GLSL = /* glsl */`
uniform sampler2DShadow rpShadowMap0, rpShadowMap1, rpShadowMap2, rpShadowMap3;
uniform mat4 rpShadowMat[4];
uniform vec4 rpShadowParams[4];
uniform vec4 rpShadowSplit;
uniform int rpShadowDyn;
uniform float rpShadowOn;

float rpPCF(sampler2DShadow sm, vec3 c, float texel) {
  vec2 uv = c.xy / texel;
  vec2 base = floor(uv + 0.5);
  float s = uv.x + 0.5 - base.x, t = uv.y + 0.5 - base.y;
  base = (base - 0.5) * texel;
  float z = c.z;
#if RP_PCF == 5
  float uw0 = 4.0 - 3.0 * s, uw1 = 7.0, uw2 = 1.0 + 3.0 * s;
  float u0 = (3.0 - 2.0 * s) / uw0 - 2.0, u1 = (3.0 + s) / uw1, u2 = s / uw2 + 2.0;
  float vw0 = 4.0 - 3.0 * t, vw1 = 7.0, vw2 = 1.0 + 3.0 * t;
  float v0 = (3.0 - 2.0 * t) / vw0 - 2.0, v1 = (3.0 + t) / vw1, v2 = t / vw2 + 2.0;
  float sum = 0.0;
  sum += uw0 * vw0 * texture(sm, vec3(base + vec2(u0, v0) * texel, z));
  sum += uw1 * vw0 * texture(sm, vec3(base + vec2(u1, v0) * texel, z));
  sum += uw2 * vw0 * texture(sm, vec3(base + vec2(u2, v0) * texel, z));
  sum += uw0 * vw1 * texture(sm, vec3(base + vec2(u0, v1) * texel, z));
  sum += uw1 * vw1 * texture(sm, vec3(base + vec2(u1, v1) * texel, z));
  sum += uw2 * vw1 * texture(sm, vec3(base + vec2(u2, v1) * texel, z));
  sum += uw0 * vw2 * texture(sm, vec3(base + vec2(u0, v2) * texel, z));
  sum += uw1 * vw2 * texture(sm, vec3(base + vec2(u1, v2) * texel, z));
  sum += uw2 * vw2 * texture(sm, vec3(base + vec2(u2, v2) * texel, z));
  return sum / 144.0;
#else
  float uw0 = 3.0 - 2.0 * s, uw1 = 1.0 + 2.0 * s;
  float u0 = (2.0 - s) / uw0 - 1.0, u1 = s / uw1 + 1.0;
  float vw0 = 3.0 - 2.0 * t, vw1 = 1.0 + 2.0 * t;
  float v0 = (2.0 - t) / vw0 - 1.0, v1 = t / vw1 + 1.0;
  float sum = 0.0;
  sum += uw0 * vw0 * texture(sm, vec3(base + vec2(u0, v0) * texel, z));
  sum += uw1 * vw0 * texture(sm, vec3(base + vec2(u1, v0) * texel, z));
  sum += uw0 * vw1 * texture(sm, vec3(base + vec2(u0, v1) * texel, z));
  sum += uw1 * vw1 * texture(sm, vec3(base + vec2(u1, v1) * texel, z));
  return sum / 16.0;
#endif
}

// Shadow coords for cascade i with slope-scaled normal offset (geometric normal).
vec3 rpShadowCoord(int i, vec3 wp, vec3 wgn, float nl) {
  vec4 P = rpShadowParams[i];
  float slope = sqrt(clamp(1.0 - nl * nl, 0.0, 1.0));
  vec3 p = wp + wgn * (P.x * (0.25 + slope));
  vec4 c = rpShadowMat[i] * vec4(p, 1.0);
  return vec3(c.xy, c.z - P.y * (1.0 + 2.0 * slope));
}
bool rpInside(vec3 c) { return c.x > 0.0 && c.x < 1.0 && c.y > 0.0 && c.y < 1.0 && c.z < 1.0; }

float rpStaticShadow(vec3 wp, vec3 wgn, float nl) {
  vec3 c = rpShadowCoord(3, wp, wgn, nl);
  return rpInside(c) ? rpPCF(rpShadowMap3, c, rpShadowParams[3].z) : 1.0;
}
float rpCascade(int i, vec3 wp, vec3 wgn, float nl) {
  vec3 c = rpShadowCoord(i, wp, wgn, nl);
  if (!rpInside(c)) return -1.0;
  float s;
  if (i == 0) s = rpPCF(rpShadowMap0, c, rpShadowParams[0].z);
  else if (i == 1) s = rpPCF(rpShadowMap1, c, rpShadowParams[1].z);
  else s = rpPCF(rpShadowMap2, c, rpShadowParams[2].z);
  if (rpShadowParams[i].w > 0.5) s = min(s, rpStaticShadow(wp, wgn, nl));
  return s;
}
// wp: world position, wgn: world geometric normal, viewZ: positive view depth
float rpSunShadow(vec3 wp, vec3 wgn, float viewZ, vec3 toSun) {
  float nl = dot(wgn, toSun);
  if (nl <= 0.0) return 0.0;
  if (rpShadowOn < 0.5) return 1.0;
  float splits[3] = float[3](rpShadowSplit.x, rpShadowSplit.y, rpShadowSplit.z);
  for (int i = 0; i < 3; i++) {
    if (i >= rpShadowDyn) break;
    float f = splits[i];
    if (viewZ < f) {
      float s = rpCascade(i, wp, wgn, nl);
      if (s < 0.0) break;
      float band = f * rpShadowSplit.w;
      float t = smoothstep(f - band, f, viewZ);
      if (t > 0.0) {
        float s2 = (i + 1 < rpShadowDyn) ? rpCascade(i + 1, wp, wgn, nl) : rpStaticShadow(wp, wgn, nl);
        if (s2 >= 0.0) s = mix(s, s2, t);
      }
      return s;
    }
  }
  return rpStaticShadow(wp, wgn, nl);
}
`;
