// Weapon model registry: builder + viewmodel placement + animation family per weapon key.
import * as THREE from 'three';
import { ModelBuilder } from './geo.js';
import { buildAK47 } from './ak47.js';
import { buildM4 } from './m4.js';
import { buildAWP, buildSSG, buildAutoSniper } from './snipers.js';
import { buildDeagle, buildGenericPistol, buildTec9 } from './pistols.js';
import { buildKnife, buildGrenade, buildC4, buildDefuseKit } from './equipment.js';
import { buildMP9, buildMAC10, buildMP5, buildUMP, buildP90, buildShotgun, buildLMG, buildGalil, buildFAMAS, buildAUG, buildSG553 } from './others.js';

// pos: gun-space origin in camera space before cvar offsets (CS2 viewmodel_offset 2.5 0 -1.5 is
// added on top). rot: extra [pitch, yaw, roll] deg. kick: [back in, up deg] per shot.
export const VM_CFG = {
  ak47: { build: buildAK47, family: 'rifle', pos: [4.4, -2.6, -11.8], rot: [0, 2.5, -5], kick: [1.3, 2.6], team: 'T' },
  m4a4: { build: buildM4, family: 'rifle', pos: [4.4, -2.9, -13.4], rot: [0, 2.5, -5], kick: [1.1, 2.2], team: 'CT' },
  deagle: { build: buildDeagle, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [1.6, 13], team: 'CT' },
  glock: { build: buildGenericPistol, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.9, 6], team: 'T' },
  usp: { build: buildGenericPistol, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.8, 5], team: 'CT' },
  p250: { build: buildGenericPistol, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [1.0, 7], team: 'CT' },
  fiveseven: { build: buildGenericPistol, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.9, 6], team: 'CT' },
  dualberettas: { build: buildGenericPistol, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.9, 6], team: 'T', dual: true },
  tec9: { build: buildTec9, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.8, 5], team: 'T' },
  zeus: { build: buildGenericPistol, family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.6, 4], team: 'CT' },
  taser: { build: (b) => buildGenericPistol(b, 'zeus'), family: 'pistol', pos: [2.3, -1.1, -12.4], rot: [0, 3, -3], kick: [0.6, 4], team: 'CT' },
  knife_ct: { build: (b) => buildKnife(b, 'ct'), family: 'knife', pos: [3.4, -2.6, -10.5], rot: [18, 20, -12], team: 'CT' },
  knife: { build: (b) => buildKnife(b, 'ct'), family: 'knife', pos: [3.4, -2.6, -10.5], rot: [18, 20, -12], team: 'CT' },
  knife_t: { build: (b) => buildKnife(b, 't'), family: 'knife', pos: [3.4, -2.6, -10.5], rot: [18, 20, -12], team: 'T' },
  hegrenade: { build: buildGrenade, family: 'grenade', pos: [2.6, -2.2, -11.0], rot: [8, 10, 0] },
  flashbang: { build: buildGrenade, family: 'grenade', pos: [2.6, -2.2, -11.0], rot: [8, 10, 0] },
  smokegrenade: { build: buildGrenade, family: 'grenade', pos: [2.6, -2.2, -11.0], rot: [8, 10, 0] },
  incgrenade: { build: buildGrenade, family: 'grenade', pos: [2.6, -2.2, -11.0], rot: [8, 10, 0] },
  molotov: { build: buildGrenade, family: 'grenade', pos: [2.6, -3.4, -11.0], rot: [8, 10, -8] },
  decoy: { build: buildGrenade, family: 'grenade', pos: [2.6, -2.2, -11.0], rot: [8, 10, 0] },
  c4: { build: buildC4, family: 'c4', pos: [-1.8, -3.2, -12.5], rot: [40, 0, 0] },
  defusekit: { build: buildDefuseKit, family: 'c4', pos: [0.5, -6.0, -13.0], rot: [28, 0, 0] },
  mp9: { build: buildMP9, family: 'smg', pos: [4.2, -3.0, -11.5], rot: [0, 2.5, -4], kick: [0.8, 1.6], team: 'CT' },
  mac10: { build: buildMAC10, family: 'smg', pos: [4.0, -2.4, -12.0], rot: [0, 2.5, -4], kick: [0.8, 1.8], team: 'T' },
  mp5sd: { build: buildMP5, family: 'smg', pos: [4.3, -2.8, -12.0], rot: [0, 2.5, -4], kick: [0.7, 1.4], team: 'CT' },
  ump45: { build: buildUMP, family: 'smg', pos: [4.3, -2.6, -12.0], rot: [0, 2.5, -4], kick: [0.9, 1.9], team: 'CT' },
  p90: { build: buildP90, family: 'smg', pos: [4.0, -1.2, -12.5], rot: [0, 2.5, -4], kick: [0.7, 1.3], team: 'CT' },
  nova: { build: buildShotgun, family: 'shotgun', pos: [4.4, -2.4, -11.0], rot: [0, 2.5, -4], kick: [2.4, 6], team: 'CT' },
  xm1014: { build: buildShotgun, family: 'shotgun', pos: [4.4, -2.6, -12.0], rot: [0, 2.5, -4], kick: [2.0, 5], team: 'CT' },
  mag7: { build: buildShotgun, family: 'shotgun', pos: [4.3, -2.7, -12.0], rot: [0, 2.5, -4], kick: [2.2, 5.5], team: 'CT' },
  negev: { build: buildLMG, family: 'lmg', pos: [4.6, -3.0, -12.5], rot: [0, 2.5, -4], kick: [1.0, 1.6], team: 'T' },
  m249: { build: buildLMG, family: 'lmg', pos: [4.6, -3.0, -12.5], rot: [0, 2.5, -4], kick: [1.1, 1.8], team: 'CT' },
  galil: { build: buildGalil, family: 'rifle', pos: [4.4, -2.6, -11.8], rot: [0, 2.5, -5], kick: [1.1, 2.2], team: 'T' },
  famas: { build: buildFAMAS, family: 'rifle', pos: [4.2, -2.2, -8.5], rot: [0, 2.5, -4], kick: [1.0, 2.0], team: 'CT' },
  aug: { build: buildAUG, family: 'rifle', pos: [4.2, -2.4, -7.5], rot: [0, 2.5, -4], kick: [1.0, 2.0], team: 'CT' },
  sg553: { build: buildSG553, family: 'rifle', pos: [4.3, -2.3, -12.5], rot: [0, 2.5, -5], kick: [1.1, 2.2], team: 'T' },
  awp: { build: buildAWP, family: 'sniper', pos: [4.2, -2.7, -12.4], rot: [0, 2, -4], kick: [2.4, 6], team: 'CT' },
  ssg08: { build: buildSSG, family: 'sniper', pos: [4.2, -2.6, -12.2], rot: [0, 2, -4], kick: [1.8, 4.5], team: 'CT' },
  g3sg1: { build: buildAutoSniper, family: 'sniper', pos: [4.4, -3.3, -13.0], rot: [0, 2.5, -5], kick: [1.6, 3.5], team: 'T' },
  scar20: { build: buildAutoSniper, family: 'sniper', pos: [4.4, -3.3, -13.0], rot: [0, 2.5, -5], kick: [1.6, 3.5], team: 'CT' },
  m4a1s: { build: buildM4, family: 'rifle', pos: [4.4, -2.9, -13.4], rot: [0, 2.5, -5], kick: [0.9, 1.8], team: 'CT' },
};

export const FALLBACK = 'ak47';
const ALIAS = { zeus: 'zeus', incendiary: 'incgrenade', smoke: 'smokegrenade', he: 'hegrenade', flash: 'flashbang' };
export const resolveKey = (key) => (VM_CFG[key] ? key : ALIAS[key] || FALLBACK);
export const cfgFor = (key) => VM_CFG[resolveKey(key)];

const worldCache = new Map();

/** Full-detail viewmodel mesh: { root, parts, anchors, cfg, tris }. */
export function buildWeaponModel(key, lod = 0) {
  key = resolveKey(key);
  const base = cfgFor(key);
  const b = new ModelBuilder({ lod });
  const extra = base.build(b, key === 'taser' ? 'zeus' : key) || {};
  const m = b.build();
  return { ...m, cfg: { ...base, ...extra, key } };
}

/**
 * Third-person / dropped model (lower detail, parts baked, shared geometry). Gun space:
 * inches, muzzle toward -Z, +Y up. userData: { muzzle, eject, grip, support } (Vector3).
 */
export function buildWorldModel(key) {
  key = resolveKey(key);
  let tpl = worldCache.get(key);
  if (!tpl) {
    const m = buildWeaponModel(key, 1);
    m.root.updateMatrixWorld(true);
    const byMat = new Map();
    m.root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const l = byMat.get(o.material) || [];
      l.push(g); byMat.set(o.material, l);
    });
    tpl = { meshes: [], ud: {} };
    for (const [mat, list] of byMat) {
      const g = list.length === 1 ? list[0] : mergeList(list);
      g.computeBoundingSphere();
      tpl.meshes.push([g, mat]);
    }
    const a = m.anchors, h = m.cfg.hands || {};
    tpl.ud = {
      muzzle: a.muzzle?.p.clone() || new THREE.Vector3(0, 0, -20),
      eject: a.eject?.p.clone() || new THREE.Vector3(0.6, 0, -5),
      grip: h.R ? new THREE.Vector3(0, h.R.p[1], h.R.p[2]) : new THREE.Vector3(),
      support: h.L ? new THREE.Vector3(0, h.L.p[1] + 1, h.L.p[2]) : null,
    };
    worldCache.set(key, tpl);
  }
  const g = new THREE.Group();
  g.name = `wm_${key}`;
  for (const [geo, mat] of tpl.meshes) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh);
  }
  g.userData = { key, muzzle: tpl.ud.muzzle.clone(), eject: tpl.ud.eject.clone(), grip: tpl.ud.grip.clone(), support: tpl.ud.support?.clone() || null };
  return g;
}

function mergeList(list) {
  // local import to keep this module light at load
  let n = 0;
  for (const g of list) n += g.index ? g.index.count : g.attributes.position.count;
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'color']) {
    if (!geos[0].attributes[k]) continue;
    const size = geos[0].attributes[k].itemSize;
    const arr = new Float32Array(n * size);
    let o = 0;
    for (const g of geos) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  return out;
}
