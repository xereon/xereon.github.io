// GPU material baker. Each material is one GLSL function `surface(uv, inout Surf o)` that
// writes height (world units), linear albedo, roughness, metalness, cavity weight and alpha
// from the SAME masks, so every map correlates. Two passes per material:
//   1. field    : surface() -> 2x RGBA16F (h, rough, metal, aoMul) + (albedo, alpha)
//   2. finalize : Sobel normal + horizon AO from the height field -> albedo (sRGB8),
//                 normal (RGBA8, OpenGL), ORM (R=AO, G=roughness, B=metalness)
// Outputs stay on the GPU as render-target textures (zero copy, hardware mipmaps).
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const HEADER = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform vec2 uPx;          // 1/uRes, one texel in uv
uniform float uTexel;      // world units per texel
uniform sampler2D uCanvas; // optional 2D-canvas overlay (stencils, print); flipY'd so uv matches
uniform sampler2D uLowA, uLowB; // quarter-res smooth fields from lowField() (bilinear, wrapped)
vec4 LOWA(vec2 uv) { return texture(uLowA, uv); }
vec4 LOWB(vec2 uv) { return texture(uLowB, uv); }
struct Surf { float h; vec3 col; float rough; float metal; float ao; float alpha; };
`;

const LOW_MAIN = /* glsl */`
layout(location = 0) out highp vec4 oA;
layout(location = 1) out highp vec4 oB;
void main() {
  vec2 uv = gl_FragCoord.xy * uPx;
  vec4 a = vec4(0.0), b = vec4(0.0);
  lowField(uv, a, b);
  oA = a; oB = b;
}
`;

const FIELD_MAIN = /* glsl */`
layout(location = 0) out highp vec4 oA;
layout(location = 1) out highp vec4 oB;
void main() {
  vec2 uv = gl_FragCoord.xy * uPx;
  Surf o = Surf(0.0, vec3(0.5), 0.9, 0.0, 1.0, 1.0);
  surface(uv, o);
  oA = vec4(o.h, o.rough, o.metal, o.ao);
  oB = vec4(max(o.col, vec3(0.0)), o.alpha);
}
`;

const FINAL_FRAG = /* glsl */`
precision highp float;
precision highp int;
uniform sampler2D tA, tB;
uniform vec2 uRes, uPx;
uniform float uTexel, uNormal, uAO, uAOLod, uCavity, uCavRough, uHRange;
layout(location = 0) out highp vec4 oAlb;
layout(location = 1) out highp vec4 oNrm;
layout(location = 2) out highp vec4 oOrm;
ivec2 N;
float H(ivec2 p, int dx, int dy) { return texelFetch(tA, (p + ivec2(dx, dy) + N) % N, 0).r; }
void main() {
  vec2 px = uPx, uv = gl_FragCoord.xy * px;
  N = ivec2(uRes);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(tA, p, 0), B = texelFetch(tB, p, 0);
  float h = A.r;
  float tl = H(p, -1, 1), t = H(p, 0, 1), tr = H(p, 1, 1);
  float l = H(p, -1, 0), r = H(p, 1, 0);
  float bl = H(p, -1, -1), b = H(p, 0, -1), br = H(p, 1, -1);
  float dx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / (8.0 * uTexel);
  float dy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) / (8.0 * uTexel);
  vec3 n = normalize(vec3(-dx * uNormal, -dy * uNormal, 1.0));

  // Cavity AO from the height mip chain: how far this texel sits below its neighbourhood
  // average at three radii (4, 16, 64 texels), scaled to an occlusion slope.
  float occ = 0.0;
  for (int k = 0; k < 3; k++) {
    float lod = uAOLod + 2.0 * float(k);
    float rad = exp2(lod) * uTexel;
    float dh = textureLod(tA, uv, lod).r - h;
    occ += max(dh, 0.0) / rad * (k == 0 ? 0.5 : k == 1 ? 0.35 : 0.25);
  }
  occ = occ / (1.0 + occ);
  float ao = clamp(1.0 - occ * uAO, 0.0, 1.0) * A.a;
  vec3 col = B.rgb * mix(1.0, ao, uCavity);
  float rough = clamp(A.g + (1.0 - ao) * uCavRough, 0.02, 1.0);
  oAlb = vec4(col, B.a);
  oNrm = vec4(n * 0.5 + 0.5, 1.0);
  // A = height relative to the tile mean, for height-blended anti-tiling in the material
  float avg = textureLod(tA, vec2(0.5), 16.0).r;
  oOrm = vec4(ao, rough, A.b, clamp(0.5 + (h - avg) / uHRange, 0.0, 1.0));
}
`;

export class Baker {
  constructor(renderer) {
    this.r = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(this.geo);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    const ext = renderer.extensions;
    this.floatOK = !!(ext?.has?.('EXT_color_buffer_float') || ext?.has?.('EXT_color_buffer_half_float'));
    this.maxAniso = renderer.capabilities?.getMaxAnisotropy?.() || 1;
    this.blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    this.blank.needsUpdate = true;
    // 1024² uniform random table for lattice hashing (see noise.js rnd4)
    const N = 1024, rnd = new Float32Array(N * N * 4);
    let x = 0x9e3779b9 >>> 0;
    for (let i = 0; i < rnd.length; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      rnd[i] = x / 4294967296;
    }
    this.rand = new THREE.DataTexture(rnd, N, N, THREE.RGBAFormat, THREE.FloatType);
    this.rand.minFilter = this.rand.magFilter = THREE.NearestFilter;
    this.rand.generateMipmaps = false;
    this.rand.needsUpdate = true;
    this.final = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FINAL_FRAG,
      uniforms: {
        tA: { value: null }, tB: { value: null }, uRes: { value: new THREE.Vector2() }, uPx: { value: new THREE.Vector2() },
        uTexel: { value: 1 }, uNormal: { value: 1 }, uAO: { value: 1 }, uAOLod: { value: 2 }, uCavity: { value: 0.3 }, uCavRough: { value: 0.05 }, uHRange: { value: 1 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  fieldMaterial(def, size, canvasTex) {
    const mk = (main, sz) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: HEADER + NOISE_GLSL + (def.lib || '') + (def.lowGlsl || '') + (main === FIELD_MAIN ? def.glsl : '') + main,
      uniforms: {
        uRes: { value: new THREE.Vector2(sz, sz) },
        uPx: { value: new THREE.Vector2(1 / sz, 1 / sz) },
        uTexel: { value: (def.world || 128) / sz },
        uSeed: { value: def.seed || 1 },
        uCanvas: { value: canvasTex || this.blank },
        uLowA: { value: this.blank }, uLowB: { value: this.blank },
        uRand: { value: this.rand },
      },
      depthTest: false, depthWrite: false,
    });
    const m = mk(FIELD_MAIN, size);
    if (def.lowGlsl) {
      const ls = Math.max(32, size >> 2);
      m.userData.low = mk(LOW_MAIN, ls);
      m.userData.lowSize = ls;
    }
    return m;
  }

  // Compile every field shader in parallel where KHR_parallel_shader_compile exists.
  async precompile(mats) {
    const scene = new THREE.Scene();
    for (const m of mats.flatMap((x) => x.userData.low ? [x, x.userData.low] : [x])) {
      const q = new THREE.Mesh(this.geo, m);
      q.frustumCulled = false;
      scene.add(q);
    }
    const q = new THREE.Mesh(this.geo, this.final);
    q.frustumCulled = false;
    scene.add(q);
    try {
      if (this.r.compileAsync) await this.r.compileAsync(scene, this.cam);
      else this.r.compile(scene, this.cam);
    } catch (e) { /* compile errors surface on first render */ }
  }

  _sync(rt, label) {
    if (!this.profile) return;
    const px = new Uint8Array(4);
    this.r.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
    const t = performance.now();
    this.stages[label] = (this.stages[label] || 0) + (t - this._t);
    this._t = t;
  }

  bake(def, size, fieldMat, aniso) {
    const r = this.r;
    if (this.profile) { this.stages ||= {}; this._t = performance.now(); }
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXR = r.xr?.enabled;
    if (r.xr) r.xr.enabled = false;
    r.autoClear = false;

    const ftype = this.floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const field = new THREE.WebGLRenderTarget(size, size, {
      count: 2, type: ftype, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true,
    });
    for (const t of field.textures) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    field.textures[1].generateMipmaps = false;
    field.textures[1].minFilter = THREE.LinearFilter;

    let low = null;
    if (fieldMat.userData.low) {
      const ls = fieldMat.userData.lowSize;
      low = new THREE.WebGLRenderTarget(ls, ls, {
        count: 2, type: ftype, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: false,
      });
      for (const t of low.textures) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
      this.quad.material = fieldMat.userData.low;
      r.setRenderTarget(low);
      r.render(this.scene, this.cam);
      this._sync(low, 'low');
      fieldMat.uniforms.uLowA.value = low.textures[0];
      fieldMat.uniforms.uLowB.value = low.textures[1];
    }

    this.quad.material = fieldMat;
    r.setRenderTarget(field);
    r.render(this.scene, this.cam);
    this._sync(field, 'field+mips');
    if (low) { low.dispose(); fieldMat.userData.low.dispose(); }

    const out = new THREE.WebGLRenderTarget(size, size, {
      count: 3, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true,
      anisotropy: aniso,
    });
    const [alb, nrm, orm] = out.textures;
    for (const t of out.textures) {
      t.wrapS = t.wrapT = def.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      t.anisotropy = aniso;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
    }
    alb.colorSpace = THREE.SRGBColorSpace;
    nrm.colorSpace = orm.colorSpace = THREE.NoColorSpace;
    alb.name = `${def.key}_albedo`; nrm.name = `${def.key}_normal`; orm.name = `${def.key}_orm`;

    const u = this.final.uniforms;
    u.tA.value = field.textures[0];
    u.tB.value = field.textures[1];
    u.uRes.value.set(size, size);
    u.uPx.value.set(1 / size, 1 / size);
    u.uTexel.value = (def.world || 128) / size;
    u.uNormal.value = def.normal ?? 1;
    u.uAO.value = def.ao ?? 1;
    u.uAOLod.value = Math.log2(Math.max(1, (def.aoRadius ?? 8) * size / 512));
    u.uCavity.value = def.cavity ?? 0.3;
    u.uCavRough.value = def.cavRough ?? 0.05;
    u.uHRange.value = def.hRange ?? 1.0;
    this.quad.material = this.final;
    r.setRenderTarget(out);
    r.render(this.scene, this.cam);   // three generates mipmaps for every attachment after this
    this._sync(out, 'final+mips');

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    if (r.xr) r.xr.enabled = prevXR;
    field.dispose();
    return { target: out, map: alb, normalMap: nrm, orm };
  }

  dispose() {
    this.geo.dispose();
    this.final.dispose();
    this.blank.dispose();
    this.rand.dispose();
  }
}
