// Third-person held items. Hold frame: +X muzzle, +Y up, +Z right, origin = right-hand grip.
// Uses the viewmodel agent's buildWorldModel(key) when it knows the key (gun space: muzzle
// toward -Z, userData.grip / support), otherwise small procedural stand-ins.
import * as THREE from 'three';
import { World } from '../../core/world.js';

let VM = null, VMCFG = null, vmPromise = null;
/** Lazily resolve the viewmodel module once WeaponSystem (its owner) exists. */
function resolveVM(force = false) {
  if (vmPromise || (!force && !World.weapons)) return vmPromise;
  vmPromise = Promise.all([
    import('../../weapons/viewmodel.js').then((m) => { if (typeof m.buildWorldModel === 'function') VM = m; }).catch(() => {}),
    import('../../weapons/models/index.js').then((m) => { VMCFG = m.VM_CFG || null; }).catch(() => {}),
  ]);
  return vmPromise;
}
export function preloadWorldModels() { return resolveVM(true); }
export const vmAvailable = () => { resolveVM(); return !!VM; };

// ---- procedural stand-ins -------------------------------------------------------------------
const geoCache = new Map();
let fallbackMat = null;
function mat() {
  if (!fallbackMat) {
    fallbackMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
    try { World.renderer?.setupMaterial?.(fallbackMat); } catch (err) { /* no hook */ }
  }
  return fallbackMat;
}
function part(list, geo, color, pos, rot) {
  const g = geo.toNonIndexed();
  if (rot) g.rotateX(rot[0]).rotateY(rot[1]).rotateZ(rot[2]);
  g.translate(pos[0], pos[1], pos[2]);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  list.push(g);
}
function merge(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'color']) {
    const arr = new Float32Array(n * 3);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, 3));
  }
  out.computeBoundingSphere();
  return out;
}
const B = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const Cy = (r, h, n = 8) => new THREE.CylinderGeometry(r, r, h, n);
const METAL = 0x1d1e1f, WOOD = 0x6a3d22, POLY = 0x232323, TAN = 0x6f6450;

function buildFallback(kind, team) {
  const key = kind === 'rifle' ? `rifle_${team}` : kind;
  if (geoCache.has(key)) return geoCache.get(key);
  const L = [];
  let info;
  if (kind === 'rifle' && team !== 'CT') {
    // AK-style: wood furniture, curved mag
    part(L, B(10.5, 2.1, 1.4), METAL, [2.2, 2.2, 0]);                  // receiver
    part(L, B(10, 2.4, 1.3), WOOD, [-8.2, 1.4, 0], [0, 0, -0.1]);       // stock
    part(L, B(2.2, 3.4, 1.2), WOOD, [-12.6, 0.6, 0], [0, 0, -0.1]);     // butt
    part(L, B(1.2, 3.6, 1.1), POLY, [-0.3, -0.7, 0], [0, 0, 0.26]);     // pistol grip
    part(L, B(2.3, 6.5, 1.0), METAL, [5.4, -1.8, 0], [0, 0, -0.32]);    // magazine
    part(L, B(7.5, 1.9, 1.6), WOOD, [11, 2.1, 0]);                      // handguard
    part(L, Cy(0.34, 8), METAL, [14, 3.4, 0], [0, 0, Math.PI / 2]);     // gas tube
    part(L, Cy(0.36, 9), METAL, [18.5, 2.2, 0], [0, 0, Math.PI / 2]);   // barrel
    part(L, B(0.4, 1.3, 0.35), METAL, [20.5, 3.0, 0]);                  // front sight
    info = { butt: -13.7, lGrip: [11.2, 1.9, 0], muzzle: [23, 2.2, 0] };
  } else if (kind === 'rifle') {
    // M4-style: black polymer, straight mag, rail
    part(L, B(10, 2.3, 1.3), POLY, [2.5, 2.2, 0]);
    part(L, B(6.5, 2.6, 1.4), POLY, [-6.2, 1.8, 0]);                    // stock tube + stock
    part(L, B(1.4, 3.8, 1.5), POLY, [-9.2, 1.2, 0]);
    part(L, B(1.2, 3.4, 1.1), POLY, [-0.3, -0.7, 0], [0, 0, 0.26]);
    part(L, B(2.1, 6.2, 0.95), METAL, [4.6, -1.7, 0], [0, 0, -0.08]);
    part(L, B(8.5, 2.3, 2.1), TAN, [11.5, 2.3, 0]);                     // rail / handguard
    part(L, Cy(0.34, 7), METAL, [18.5, 2.2, 0], [0, 0, Math.PI / 2]);
    part(L, B(3.5, 0.7, 0.8), METAL, [3, 3.7, 0]);                      // optic rail
    part(L, B(2.4, 1.5, 1.4), POLY, [3, 4.6, 0]);                       // red dot
    info = { butt: -10, lGrip: [11.5, 1.9, 0], muzzle: [22, 2.2, 0] };
  } else if (kind === 'pistol') {
    part(L, B(7.2, 1.3, 1.0), POLY, [2.4, 1.8, 0]);                     // slide
    part(L, B(1.3, 3.8, 1.1), POLY, [0, -0.3, 0], [0, 0, 0.25]);        // grip
    part(L, B(2.0, 0.5, 0.9), POLY, [1.6, 0.6, 0]);                     // trigger guard
    info = { butt: -1, lGrip: null, muzzle: [6, 1.8, 0] };
  } else if (kind === 'knife') {
    part(L, B(4.2, 1.05, 0.95), POLY, [0, 0, 0]);                       // handle
    part(L, B(0.5, 1.6, 1.1), METAL, [2.3, 0, 0]);                      // guard
    part(L, B(6.2, 1.1, 0.14), 0x8a8e92, [5.6, 0.1, 0]);                // blade
    info = { butt: -2.1, lGrip: null, muzzle: [8.7, 0, 0] };
  } else if (kind === 'nade') {
    part(L, new THREE.SphereGeometry(1.35, 10, 8), 0x3d4a2e, [0, 0.2, 0]);
    part(L, Cy(0.5, 0.9), METAL, [0, 1.8, 0]);
    part(L, B(0.3, 2.2, 0.5), METAL, [0.5, 1.0, 0.6]);
    info = { butt: 0, lGrip: null, muzzle: [0, 2, 0] };
  } else { // c4
    part(L, B(4.4, 2.6, 7.4), 0x6b5a3c, [0, 0, 0]);
    part(L, B(2.4, 0.6, 3.0), 0x2a2a2a, [0.2, 1.5, 0]);
    part(L, Cy(0.35, 7), 0x8a2a20, [-1.2, 1.4, 0], [Math.PI / 2, 0, 0]);
    info = { butt: -2, lGrip: null, muzzle: [2, 0, 0] };
  }
  const r = { geo: merge(L), info };
  geoCache.set(key, r);
  return r;
}

/** Build a held item. Returns { obj, lGrip: Vector3|null, butt: number, key }. */
export function makeHeldItem(kind, key, team) {
  resolveVM();
  if ((kind === 'rifle' || kind === 'pistol') && VM && key && (!VMCFG || VMCFG[key])) {
    try {
      const wm = VM.buildWorldModel(key);
      const ud = wm.userData || {};
      const grip = ud.grip || new THREE.Vector3();
      // gun space (muzzle -Z) -> hold frame (muzzle +X): rotate -90° about Y, grip to origin
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      const holder = new THREE.Group();
      wm.quaternion.copy(q);
      wm.position.copy(grip).applyQuaternion(q).negate();
      holder.add(wm);
      const box = new THREE.Box3().setFromObject(wm);
      const lGrip = ud.support ? ud.support.clone().sub(grip).applyQuaternion(q) : null;
      const muzzle = ud.muzzle ? ud.muzzle.clone().sub(grip).applyQuaternion(q) : null;
      // guard against a registry that silently returns a different gun (pistol key -> rifle)
      const len = box.max.x - box.min.x;
      if (!(kind === 'pistol' && len > 14) && !(kind === 'rifle' && len < 16)) {
        holder.userData = { key, lGrip, butt: box.min.x, muzzle, source: 'viewmodel' };
        holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        return holder;
      }
    } catch (err) { /* fall through to stand-in */ }
  }
  const { geo, info } = buildFallback(kind, team);
  const mesh = new THREE.Mesh(geo, mat());
  mesh.castShadow = true; mesh.receiveShadow = true;
  const holder = new THREE.Group();
  holder.add(mesh);
  holder.userData = {
    key, butt: info.butt, source: 'fallback',
    lGrip: info.lGrip ? new THREE.Vector3(...info.lGrip) : null,
    muzzle: new THREE.Vector3(...info.muzzle),
  };
  return holder;
}
