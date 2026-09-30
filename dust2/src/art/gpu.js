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
struct Surf { float h; vec3 col; float rough; float metal; float ao; float alpha; };
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
uniform float uTexel, uNormal, uAO, uAORad, uCavity, uCavRough;
layout(location = 0) out highp vec4 oAlb;
layout(location = 1) out highp vec4 oNrm;
layout(location = 2) out highp vec4 oOrm;
float H(vec2 uv) { return texture(tA, uv).r; }
void main() {
  vec2 px = uPx, uv = gl_FragCoord.xy * px;
  vec4 A = texture(tA, uv), B = texture(tB, uv);
  float h = A.r;
  float tl = H(uv + px * vec2(-1, 1)), t = H(uv + px * vec2(0, 1)), tr = H(uv + px * vec2(1, 1));
  float l = H(uv + px * vec2(-1, 0)), r = H(uv + px * vec2(1, 0));
  float bl = H(uv + px * vec2(-1, -1)), b = H(uv + px * vec2(0, -1)), br = H(uv + px * vec2(1, -1));
  float dx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / (8.0 * uTexel);
  float dy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) / (8.0 * uTexel);
  vec3 n = normalize(vec3(-dx * uNormal, -dy * uNormal, 1.0));

  // Horizon-based AO: for 8 directions find the steepest occluder within uAORad texels.
  float occ = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.785398 + 0.3927;
    vec2 dir = vec2(cos(a), sin(a));
    float hz = 0.0;
    for (int s = 1; s <= 4; s++) {
      float rr = uAORad * float(s * s) / 16.0 + 0.75;
      float dh = H(uv + dir * rr * px) - h;
      hz = max(hz, dh / (rr * uTexel));
    }
    occ += hz * inversesqrt(1.0 + hz * hz);
  }
  occ *= 0.125;
  float ao = clamp(1.0 - occ * uAO, 0.0, 1.0) * A.a;
  vec3 col = B.rgb * mix(1.0, ao, uCavity);
  float rough = clamp(A.g + (1.0 - ao) * uCavRough, 0.02, 1.0);
  oAlb = vec4(col, B.a);
  oNrm = vec4(n * 0.5 + 0.5, 1.0);
  oOrm = vec4(ao, rough, A.b, 1.0);
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
    this.final = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FINAL_FRAG,
      uniforms: {
        tA: { value: null }, tB: { value: null }, uRes: { value: new THREE.Vector2() }, uPx: { value: new THREE.Vector2() },
        uTexel: { value: 1 }, uNormal: { value: 1 }, uAO: { value: 1 }, uAORad: { value: 12 }, uCavity: { value: 0.3 }, uCavRough: { value: 0.05 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  fieldMaterial(def, size, canvasTex) {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: HEADER + NOISE_GLSL + (def.lib || '') + def.glsl + FIELD_MAIN,
      uniforms: {
        uRes: { value: new THREE.Vector2(size, size) },
        uPx: { value: new THREE.Vector2(1 / size, 1 / size) },
        uTexel: { value: (def.world || 128) / size },
        uSeed: { value: def.seed || 1 },
        uCanvas: { value: canvasTex || this.blank },
      },
      depthTest: false, depthWrite: false,
    });
  }

  // Compile every field shader in parallel where KHR_parallel_shader_compile exists.
  async precompile(mats) {
    const scene = new THREE.Scene();
    for (const m of mats) {
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

  bake(def, size, fieldMat, aniso) {
    const r = this.r;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXR = r.xr?.enabled;
    if (r.xr) r.xr.enabled = false;
    r.autoClear = false;

    const ftype = this.floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const field = new THREE.WebGLRenderTarget(size, size, {
      count: 2, type: ftype, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: false,
    });
    for (const t of field.textures) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }

    this.quad.material = fieldMat;
    r.setRenderTarget(field);
    r.render(this.scene, this.cam);

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
    u.uAORad.value = (def.aoRadius ?? 10) * size / 512;
    u.uCavity.value = def.cavity ?? 0.3;
    u.uCavRough.value = def.cavRough ?? 0.05;
    this.quad.material = this.final;
    r.setRenderTarget(out);
    r.render(this.scene, this.cam);   // three generates mipmaps for every attachment after this

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
  }
}
