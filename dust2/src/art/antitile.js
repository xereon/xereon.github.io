// Material shader patch shared by every TextureLib material:
//   * uv source: mesh uv * repeat, or world-space box projection ({ world: true })
//   * stochastic anti-tiling (IQ "texture repetition" #3: two offset lookups blended by a
//     low-frequency index noise, textureGrad keeps mips/aniso correct). Albedo, normal and
//     ORM share the same offsets + blend weight so the maps stay registered.
//   * macro variation: low-frequency albedo/roughness modulation so big surfaces never
//     read as a grid.
// The patch is installed through a chaining onBeforeCompile property so that other
// modules (e.g. CSM.setupMaterial, which *assigns* onBeforeCompile) compose with it.
import * as THREE from 'three';

let noiseTex = null;

// 256² RGBA8: R = white noise (anti-tile index), G/B/A = smooth periodic value noise at
// three scales (macro variation). Built on the CPU once; tiny.
export function atNoiseTexture() {
  if (noiseTex) return noiseTex;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const lattice = (n) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const smooth = (t) => t * t * (3 - 2 * t);
  const octave = (lat, n, x, y) => {
    const fx = x * n / N, fy = y * n / N;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
    const g = (i, j) => lat[((j % n + n) % n) * n + ((i % n + n) % n)];
    const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
  };
  const L = [4, 8, 16, 32, 64].map((n) => [n, lattice(n)]);
  const fb = (x, y, o0, cnt) => {
    let t = 0, amp = 1, norm = 0;
    for (let k = o0; k < o0 + cnt; k++) { t += amp * octave(L[k][1], L[k][0], x, y); norm += amp; amp *= 0.5; }
    return t / norm;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = rnd() * 255;
      data[i + 1] = Math.min(255, Math.max(0, (fb(x, y, 0, 3) - 0.5) * 1.8 * 255 + 128));
      data[i + 2] = Math.min(255, Math.max(0, (fb(x, y, 1, 3) - 0.5) * 1.8 * 255 + 128));
      data[i + 3] = Math.min(255, Math.max(0, (fb(x, y, 2, 3) - 0.5) * 1.8 * 255 + 128));
    }
  }
  noiseTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter;
  noiseTex.generateMipmaps = false;
  noiseTex.needsUpdate = true;
  noiseTex.name = 'antitile_noise';
  return noiseTex;
}

const PARS = /* glsl */`
varying vec2 vAtUv;
uniform sampler2D atNoise;
uniform vec4 atCfg;     // x macro albedo, y macro roughness, z macro scale (per tile), w anti-tile scale
`;

const VERT_UV = /* glsl */`
#ifdef AT_WORLD
{
  vec4 atP = vec4(transformed, 1.0);
  vec3 atN = objectNormal;
  #ifdef USE_BATCHING
    atP = batchingMatrix * atP; atN = mat3(batchingMatrix) * atN;
  #endif
  #ifdef USE_INSTANCING
    atP = instanceMatrix * atP; atN = mat3(instanceMatrix) * atN;
  #endif
  atP = modelMatrix * atP;
  atN = mat3(modelMatrix) * atN;
  vec3 an = abs(atN);
  vec2 wuv;
  if (an.y >= an.x && an.y >= an.z) wuv = vec2(atP.x, -atP.z);
  else if (an.x >= an.z) wuv = vec2(-atP.z * sign(atN.x), atP.y);
  else wuv = vec2(atP.x * sign(atN.z), atP.y);
  vAtUv = wuv * atWorld.xy + atWorld.zw;
}
#else
  vAtUv = uv * atWorld.xy + atWorld.zw;
#endif
#ifdef USE_MAP
  vMapUv = vAtUv;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv = vAtUv;
#endif
#ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = vAtUv;
#endif
#ifdef USE_METALNESSMAP
  vMetalnessMapUv = vAtUv;
#endif
#ifdef USE_AOMAP
  vAoMapUv = vAtUv;
#endif
`;

const FRAG_FUNCS = /* glsl */`
vec2 at_dx, at_dy, at_oa, at_ob;
float at_w = 0.0, at_macro = 0.0;
vec4 at_orm = vec4(1.0);
void atSetup() {
  at_dx = dFdx(vAtUv); at_dy = dFdy(vAtUv);
  #ifdef AT_ANTITILE
    float k = texture2D(atNoise, vAtUv * atCfg.w).r * 8.0;
    float i = floor(k);
    at_w = fract(k);
    at_oa = sin(vec2(3.0, 7.0) * i);
    at_ob = sin(vec2(3.0, 7.0) * (i + 1.0));
  #endif
  #ifdef AT_MACRO
    vec2 mu = vAtUv * atCfg.z;
    float m1 = texture2D(atNoise, mu).g - 0.5;
    float m2 = texture2D(atNoise, mu * 0.29 + vec2(0.37, 0.61)).b - 0.5;
    at_macro = m1 + 0.8 * m2;
  #endif
}
vec4 atTex(sampler2D t) {
  #ifdef AT_ANTITILE
    return mix(textureGrad(t, vAtUv + at_oa, at_dx, at_dy), textureGrad(t, vAtUv + at_ob, at_dx, at_dy), at_w);
  #else
    return texture2D(t, vAtUv);
  #endif
}
`;

const FRAG_MAP = /* glsl */`
atSetup();
#ifdef USE_MAP
  #ifdef AT_ANTITILE
    vec4 atCa = textureGrad(map, vAtUv + at_oa, at_dx, at_dy);
    vec4 atCb = textureGrad(map, vAtUv + at_ob, at_dx, at_dy);
    at_w = smoothstep(0.2, 0.8, at_w - 0.25 * dot(atCa.rgb - atCb.rgb, vec3(1.0)));
    vec4 sampledDiffuseColor = mix(atCa, atCb, at_w);
  #else
    vec4 sampledDiffuseColor = texture2D(map, vAtUv);
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
#ifdef AT_MACRO
  // darker patches drift towards a dusty umber, lighter ones towards sun-bleached
  float atM = at_macro * atCfg.x;
  diffuseColor.rgb *= 1.0 + atM * vec3(1.0, 1.06, 1.18);
#endif
`;

const FRAG_ROUGH = /* glsl */`
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  at_orm = atTex(roughnessMap);
  roughnessFactor *= at_orm.g;
#endif
#ifdef AT_MACRO
  roughnessFactor = clamp(roughnessFactor - at_macro * atCfg.y, 0.03, 1.0);
#endif
`;

const FRAG_METAL = /* glsl */`
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  #ifndef USE_ROUGHNESSMAP
    at_orm = atTex(metalnessMap);
  #endif
  metalnessFactor *= at_orm.b;
#endif
`;

function patch(shader, mat) {
  const u = mat.userData.at;
  shader.uniforms.atNoise = u.noise;
  shader.uniforms.atCfg = u.cfg;
  shader.uniforms.atWorld = u.world;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + PARS + 'uniform vec4 atWorld;\n')
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_UV);
  let aoChunk = THREE.ShaderChunk.aomap_fragment
    .replace('texture2D( aoMap, vAoMapUv ).r', 'at_orm.r');
  aoChunk = '#if defined( USE_AOMAP ) && !defined( USE_ROUGHNESSMAP )\n at_orm = atTex(aoMap);\n#endif\n' + aoChunk;
  const nrmChunk = THREE.ShaderChunk.normal_fragment_maps
    .replace('texture2D( normalMap, vNormalMapUv )', 'atTex( normalMap )');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + PARS + FRAG_FUNCS)
    .replace('#include <map_fragment>', FRAG_MAP)
    .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
    .replace('#include <metalnessmap_fragment>', FRAG_METAL)
    .replace('#include <normal_fragment_maps>', nrmChunk)
    .replace('#include <aomap_fragment>', aoChunk);
}

// cfg: { antiTile, macro:[albedo, rough], macroScale, world (units per tile) | 0, repeat:[x,y], offset:[x,y] }
export function installPatch(mat, cfg) {
  const repeat = cfg.repeat || [1, 1];
  const world = cfg.world ? 1 / cfg.world : 0;
  mat.userData.at = {
    noise: { value: atNoiseTexture() },
    cfg: { value: new THREE.Vector4(cfg.macro?.[0] ?? 0, cfg.macro?.[1] ?? 0, cfg.macroScale ?? 0.11, cfg.antiTileScale ?? 1 / 190) },
    world: { value: new THREE.Vector4(
      (world || 1) * repeat[0], (world || 1) * repeat[1], cfg.offset?.[0] ?? 0, cfg.offset?.[1] ?? 0) },
  };
  mat.defines = mat.defines || {};
  if (cfg.antiTile) mat.defines.AT_ANTITILE = '';
  if (cfg.macro && (cfg.macro[0] || cfg.macro[1])) mat.defines.AT_MACRO = '';
  if (world) mat.defines.AT_WORLD = '';

  // Chain instead of overwrite: anything later assigned to onBeforeCompile runs after us.
  let extra = null;
  const mine = function (shader, renderer) {
    patch(shader, mat);
    if (extra) extra.call(this, shader, renderer);
  };
  Object.defineProperty(mat, 'onBeforeCompile', {
    configurable: true, enumerable: true,
    get: () => mine,
    set: (fn) => { extra = fn === mine ? extra : fn; },
  });
  const key = `at1|${cfg.antiTile ? 1 : 0}|${world ? 1 : 0}`;
  mat.customProgramCacheKey = () => key;
}
