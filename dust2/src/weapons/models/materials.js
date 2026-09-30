// Weapon / arms material library. PBR sets from textures.js plus a shader patch that derives
// surface curvature from screen-space derivatives (dN/dP) to add edge wear on convex bevels
// and grime in concave corners — works on any procedural mesh without baking.
import * as THREE from 'three';
import * as TX from './textures.js';

const srgb = (r, g, b) => [r, g, b].map((c) => Math.pow(c / 255, 2.2));   // linear (uniforms)
const sc = (r, g, b) => [r / 255, g / 255, b / 255];                        // sRGB-encoded (textures)
const mats = new Map();
let envOverride = null;       // set by Viewmodel when the renderer provides an environment
const allMats = new Set();

function patch(mat, w) {
  const u = {
    vmNoise: { value: TX.wearNoise() },
    vmWear: { value: new THREE.Vector4(w.k0 ?? 5, w.k1 ?? 14, w.jit ?? 8, w.amt ?? 0) },
    vmWearColor: { value: new THREE.Color().setRGB(...(w.color || [0.5, 0.5, 0.5])) },
    vmWearRM: { value: new THREE.Vector2(w.rough ?? 0.3, w.metal ?? 1) },
    vmGrime: { value: new THREE.Vector3(w.g0 ?? 2, w.g1 ?? 12, w.grime ?? 0.35) },
  };
  mat.userData.vm = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D vmNoise; uniform vec4 vmWear; uniform vec3 vmWearColor; uniform vec2 vmWearRM; uniform vec3 vmGrime;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
{
  vec3 vmN = normalize(vNormal);
  vec3 vmP = -vViewPosition;
  vec3 dNx = dFdx(vmN), dNy = dFdy(vmN), dPx = dFdx(vmP), dPy = dFdy(vmP);
  float den = max(dot(dPx, dPx) + dot(dPy, dPy), 1e-9);
  float curv = (dot(dNx, dPx) + dot(dNy, dPy)) / den;
  vec3 nz = texture2D(vmNoise, vMapUv * 1.7).rgb;
  float wear = smoothstep(vmWear.x, vmWear.y, curv + (nz.r - 0.5) * vmWear.z) * vmWear.w;
  wear *= smoothstep(0.25, 0.6, nz.r + 0.25);
  float grime = smoothstep(vmGrime.x, vmGrime.y, -curv + (nz.g - 0.5) * 4.0) * vmGrime.z;
  diffuseColor.rgb = mix(diffuseColor.rgb, vmWearColor, wear);
  roughnessFactor = mix(roughnessFactor, vmWearRM.x, wear);
  metalnessFactor = mix(metalnessFactor, vmWearRM.y, wear);
  diffuseColor.rgb *= 1.0 - grime;
  roughnessFactor = min(1.0, roughnessFactor + grime * 0.3);
}`);
  };
  mat.customProgramCacheKey = () => 'vmwear1';
}

function std(set, o = {}) {
  const P = o.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const m = new P({
    map: set.map, normalMap: set.normalMap, roughnessMap: set.ormMap, metalnessMap: set.ormMap,
    aoMap: o.ao ? set.ormMap : null, aoMapIntensity: o.ao ?? 1,
    color: 0xffffff, roughness: 1, metalness: 1, vertexColors: true,
    normalScale: new THREE.Vector2(o.ns ?? 1, o.ns ?? 1),
    envMapIntensity: o.env ?? 1,
  });
  if (o.physical) {
    for (const k of ['clearcoat', 'clearcoatRoughness', 'sheen', 'sheenRoughness', 'iridescence', 'iridescenceIOR',
      'transmission', 'thickness', 'ior', 'specularIntensity']) if (o[k] != null) m[k] = o[k];
    if (o.sheenColor) m.sheenColor = new THREE.Color().setRGB(...o.sheenColor);
    if (o.iridescenceThicknessRange) m.iridescenceThicknessRange = o.iridescenceThicknessRange;
  }
  const rep = o.tile ? (Array.isArray(o.tile) ? o.tile : [o.tile, o.tile]) : [4, 4];
  m.userData.tile = rep;
  if (o.wear !== false) patch(m, o.wear || {});
  return m;
}

// Texture repeat is per-texture in three.js, so each material gets its own clones when its
// tile size differs from the source. Clones share the GPU image (same source).
function tiled(m) {
  const [tu, tv] = m.userData.tile;
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
    const t = m[k];
    if (!t) continue;
    const c = t.clone();
    c.repeat.set(1 / tu, 1 / tv);
    c.needsUpdate = true;
    m[k] = c;
  }
  if (m.roughnessMap && m.metalnessMap && m.roughnessMap !== m.metalnessMap) m.metalnessMap = m.roughnessMap;
  return m;
}

const DEFS = {
  // --- metals ---
  steel: () => std(TX.metalSet({ key: 'steel', base: sc(66, 66, 68), rough: 0.44, metal: 0.82, grain: 0.5 }),
    { tile: 5, wear: { amt: 0.9, color: srgb(170, 168, 162), rough: 0.26, metal: 1 } }),
  blued: () => std(TX.metalSet({ key: 'blued', base: sc(50, 52, 58), rough: 0.38, metal: 0.88, var: 0.12, grain: 0.35 }),
    { tile: 5, wear: { amt: 0.85, color: srgb(165, 165, 165), rough: 0.25, metal: 1 } }),
  park: () => std(TX.metalSet({ key: 'park', base: sc(66, 66, 62), rough: 0.6, metal: 0.55, var: 0.1, grain: 0.6 }),
    { tile: 4, wear: { amt: 0.8, color: srgb(150, 148, 142), rough: 0.3, metal: 1 } }),
  gunmetal: () => std(TX.metalSet({ key: 'gunmetal', base: sc(72, 73, 76), rough: 0.4, metal: 0.9, var: 0.1, grain: 0.3 }),
    { tile: 5, wear: { amt: 0.8, color: srgb(175, 175, 175), rough: 0.22, metal: 1 } }),
  bright: () => std(TX.metalSet({ key: 'bright', base: sc(150, 150, 148), rough: 0.26, metal: 1, var: 0.08, smudge: 0.1, grain: 0.3 }),
    { tile: 4, wear: { amt: 0.3, color: srgb(200, 200, 200), rough: 0.15, metal: 1 } }),
  alu: () => std(TX.metalSet({ key: 'alu', base: sc(46, 46, 48), rough: 0.52, metal: 0.45, var: 0.08, grain: 0.35 }),
    { tile: 5, wear: { amt: 0.9, color: srgb(185, 185, 190), rough: 0.3, metal: 1 } }),
  stainless: () => std(TX.brushedSet({ key: 'stainless', base: sc(172, 172, 170), rough: 0.3 }),
    { tile: [6, 3], wear: { amt: 0.4, color: srgb(220, 220, 218), rough: 0.14, metal: 1 } }),
  brass: () => std(TX.metalSet({ key: 'brass', base: sc(205, 150, 70), rough: 0.28, metal: 1, var: 0.08, scratches: 20 }),
    { tile: 3, wear: false }),
  copper: () => std(TX.metalSet({ key: 'copper', base: sc(200, 110, 70), rough: 0.3, metal: 1, var: 0.1, scratches: 10 }),
    { tile: 3, wear: false }),
  // --- wood / plastics ---
  wood_ak: () => std(TX.woodSet({ key: 'ak', dark: sc(52, 22, 12), light: sc(122, 58, 30), rough: 0.48, rings: 16, lam: 3 }),
    { physical: true, clearcoat: 0.35, clearcoatRoughness: 0.35, tile: [16, 5], ns: 0.35, wear: { amt: 0.7, color: srgb(170, 110, 60), rough: 0.6, metal: 0, k0: 5, k1: 16 } }),
  wood_walnut: () => std(TX.woodSet({ key: 'walnut', dark: sc(40, 22, 12), light: sc(110, 64, 34), rough: 0.5, rings: 18 }),
    { physical: true, clearcoat: 0.3, clearcoatRoughness: 0.45, tile: [12, 4], wear: { amt: 0.6, color: srgb(150, 105, 65), rough: 0.6, metal: 0 } }),
  bakelite: () => std(TX.ribSet({ key: 'bake', base: sc(74, 32, 18), rough: 0.42, freq: 12 }),
    { tile: [3, 3], ns: 0.45, wear: { amt: 0.4, color: srgb(140, 70, 40), rough: 0.3, metal: 0 } }),
  polymer: () => std(TX.polymerSet({ key: 'polymer', base: sc(38, 38, 40), rough: 0.62, stip: 0.25, cells: 30 }),
    { tile: 4, wear: { amt: 0.5, color: srgb(70, 70, 72), rough: 0.45, metal: 0, k0: 7, k1: 18 } }),
  stipple: () => std(TX.polymerSet({ key: 'stipple', base: sc(36, 36, 38), rough: 0.72, stip: 1, cells: 44 }),
    { tile: 2.2, ns: 1.2, wear: { amt: 0.4, color: srgb(70, 70, 72), rough: 0.45, metal: 0, k0: 7, k1: 18 } }),
  polymer_tan: () => std(TX.polymerSet({ key: 'ptan', base: sc(150, 128, 96), rough: 0.62, stip: 0.3, cells: 30 }),
    { tile: 4, wear: { amt: 0.5, color: srgb(185, 165, 130), rough: 0.5, metal: 0, k0: 7, k1: 18 } }),
  polymer_od: () => std(TX.polymerSet({ key: 'pod', base: sc(70, 76, 56), rough: 0.6, stip: 0.3, cells: 30 }),
    { tile: 4, wear: { amt: 0.5, color: srgb(110, 115, 92), rough: 0.5, metal: 0, k0: 7, k1: 18 } }),
  awp_green: () => std(TX.paintSet({ key: 'awp', base: sc(76, 92, 58), rough: 0.62, orange: 0.9, size: 512 }),
    { tile: 6, ns: 0.8, wear: { amt: 0.85, color: srgb(40, 40, 40), rough: 0.5, metal: 0.2, k0: 5, k1: 14 } }),
  rubber: () => std(TX.rubberSet({ key: 'rubber' }), { tile: 3, wear: false }),
  knurl: () => std(TX.knurlSet({ key: 'knurl', base: sc(32, 32, 33), rough: 0.6, freq: 28 }), { tile: 2, wear: false }),
  knurl_steel: () => std(TX.knurlSet({ key: 'knurls', base: sc(70, 70, 72), rough: 0.4, freq: 30, metal: 0.9 }), { tile: 1.5, wear: false }),
  // --- paints ---
  paint_od: () => std(TX.paintSet({ key: 'od', base: sc(72, 80, 50) }), { tile: 4, wear: { amt: 0.9, color: srgb(120, 120, 118), rough: 0.35, metal: 1 } }),
  paint_grey: () => std(TX.paintSet({ key: 'grey', base: sc(110, 112, 110) }), { tile: 4, wear: { amt: 0.9, color: srgb(170, 170, 170), rough: 0.3, metal: 1 } }),
  paint_black: () => std(TX.paintSet({ key: 'black', base: sc(30, 30, 32), rough: 0.45 }), { tile: 4, wear: { amt: 0.9, color: srgb(150, 150, 150), rough: 0.3, metal: 1 } }),
  paint_yellow: () => std(TX.paintSet({ key: 'yellow', base: sc(200, 160, 30), rough: 0.45 }), { tile: 4, wear: { amt: 0.6, color: srgb(60, 60, 60), rough: 0.5, metal: 0 } }),
  paint_red: () => std(TX.paintSet({ key: 'red', base: sc(150, 28, 22), rough: 0.45 }), { tile: 4, wear: { amt: 0.6, color: srgb(120, 120, 120), rough: 0.3, metal: 1 } }),
  paint_blue: () => std(TX.paintSet({ key: 'blue', base: sc(60, 80, 110), rough: 0.5 }), { tile: 4, wear: { amt: 0.8, color: srgb(160, 160, 160), rough: 0.3, metal: 1 } }),
  paint_white: () => std(TX.paintSet({ key: 'white', base: sc(200, 198, 190), rough: 0.5 }), { tile: 4, wear: { amt: 0.5, color: srgb(120, 120, 120), rough: 0.4, metal: 0.6 } }),
  paint_green: () => std(TX.paintSet({ key: 'green', base: sc(60, 90, 50), rough: 0.5 }), { tile: 4, wear: { amt: 0.8, color: srgb(150, 150, 150), rough: 0.3, metal: 1 } }),
  c4_clay: () => std(TX.paintSet({ key: 'clay', base: sc(170, 150, 110), rough: 0.8, orange: 0.4 }), { tile: 3, wear: false }),
  wrapper: () => std(TX.fabricSet({ key: 'wrap', base: sc(88, 90, 60), rough: 0.7, freq: 40, size: 256 }), { tile: 3, wear: false }),
  tape: () => std(TX.fabricSet({ key: 'tape', base: sc(60, 60, 58), rough: 0.55, freq: 90, size: 256 }), { tile: 2, ns: 0.5, wear: false }),
  wire_red: () => std(TX.rubberSet({ key: 'wr', base: sc(170, 25, 20), rough: 0.4 }), { tile: 1, wear: false }),
  wire_blue: () => std(TX.rubberSet({ key: 'wb', base: sc(30, 60, 170), rough: 0.4 }), { tile: 1, wear: false }),
  wire_yellow: () => std(TX.rubberSet({ key: 'wy', base: sc(190, 160, 30), rough: 0.4 }), { tile: 1, wear: false }),
  pcb: () => std(TX.paintSet({ key: 'pcb', base: sc(30, 80, 40), rough: 0.35 }), { tile: 2, wear: false }),
  cloth_rag: () => std(TX.fabricSet({ key: 'rag', base: sc(170, 150, 120), rough: 0.9, freq: 36, size: 256 }), { tile: 3, wear: false }),
  // --- glass / emissive ---
  lens: () => {
    const m = std(TX.paintSet({ key: 'lens', base: sc(4, 6, 9), rough: 0.04, orange: 0 }), {
      physical: true, clearcoat: 0.6, clearcoatRoughness: 0.03, iridescence: 0.7, iridescenceIOR: 1.5,
      iridescenceThicknessRange: [250, 500], env: 1.1, wear: false, tile: 4,
    });
    m.metalness = 0.2; m.metalnessMap = null; m.roughness = 0.05; m.roughnessMap = null; m.normalMap = null;
    return m;
  },
  glass_green: () => {
    const m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(...srgb(70, 120, 60)), roughness: 0.08, metalness: 0,
      transmission: 0.6, thickness: 0.3, ior: 1.5, transparent: true, opacity: 0.85, vertexColors: true, envMapIntensity: 1.5 });
    m.userData.tile = [4, 4];
    return m;
  },
  tritium: () => { const m = new THREE.MeshStandardMaterial({ color: 0x223322, emissive: new THREE.Color(0.35, 1, 0.3), emissiveIntensity: 1.8, roughness: 0.3, vertexColors: true }); m.userData.tile = [1, 1]; return m; },
  lcd: () => { const m = new THREE.MeshStandardMaterial({ color: 0x0a1a08, emissive: new THREE.Color(0.2, 0.55, 0.12), emissiveIntensity: 1.2, roughness: 0.15, vertexColors: true }); m.userData.tile = [1, 1]; return m; },
  led_red: () => { const m = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: new THREE.Color(1, 0.08, 0.05), emissiveIntensity: 3, roughness: 0.2, vertexColors: true }); m.userData.tile = [1, 1]; return m; },
  dark: () => { const m = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, metalness: 0, vertexColors: true }); m.userData.tile = [1, 1]; return m; },
  // --- arms ---
  glove_ct: () => std(TX.fabricSet({ key: 'gct', base: sc(52, 54, 52), rough: 0.86, freq: 96 }), { tile: 2, ns: 0.35, wear: false }),
  leather_ct: () => std(TX.leatherSet({ key: 'lct', base: sc(30, 29, 28), rough: 0.58 }), { tile: 2.5, wear: false }),
  armor_ct: () => std(TX.polymerSet({ key: 'act', base: sc(34, 34, 35), rough: 0.5, stip: 0.4, cells: 60 }), { tile: 2, wear: { amt: 0.4, color: srgb(80, 80, 80), rough: 0.4, metal: 0, k0: 9, k1: 20 } }),
  sleeve_ct: () => std(TX.fabricSet({ key: 'sct', base: sc(56, 64, 76), rough: 0.9, freq: 120 }), { tile: 4, ns: 0.3, wear: false }),
  glove_t: () => std(TX.leatherSet({ key: 'gt', base: sc(96, 72, 50), rough: 0.6, cells: 90 }), { tile: 2, ns: 0.5, wear: false }),
  glove_t2: () => std(TX.fabricSet({ key: 'gt2', base: sc(74, 64, 50), rough: 0.85, freq: 96 }), { tile: 2, ns: 0.35, wear: false }),
  sleeve_t: () => std(TX.fabricSet({ key: 'st', base: sc(98, 86, 64), rough: 0.9, freq: 110 }), { tile: 4, ns: 0.35, wear: false }),
  skin: () => std(TX.skinSet({ key: 'skin', base: sc(170, 116, 84), rough: 0.55 }),
    { physical: true, sheen: 0.25, sheenRoughness: 0.6, sheenColor: [0.5, 0.2, 0.12], tile: 3, ns: 0.5, wear: false }),
  nail: () => std(TX.skinSet({ key: 'nail', base: sc(210, 170, 150), rough: 0.3 }), { tile: 1, wear: false }),
};

export function getMaterial(key) {
  let m = mats.get(key);
  if (m) return m;
  const def = DEFS[key] || DEFS.steel;
  m = def();
  if (m.userData.tile && m.map) tiled(m);
  m.name = `vm_${key}`;
  if (!m.envMap && envOverride !== false) m.envMap = envOverride || TX.envTexture();
  mats.set(key, m);
  allMats.add(m);
  return m;
}

/** Point every weapon material at `env` (a texture), or null to use scene.environment. */
export function setEnvironment(env) {
  envOverride = env === null ? false : env;
  for (const m of allMats) { m.envMap = env === null ? null : (env || TX.envTexture()); m.needsUpdate = true; }
}

export const materialKeys = () => Object.keys(DEFS);
export { srgb, sc };
