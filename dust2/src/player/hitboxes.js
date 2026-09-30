// CS-style oriented capsule hitboxes (CONTRACT.md §12). Capsules are defined in the bind pose
// against a bone and follow the animated (or ragdolled) skeleton. rayVsHitboxes is analytic
// (ray vs swept sphere) and returns the nearest hit.
import * as THREE from 'three';
import { BONE, BIND, ARM_L, ARM_R, LEG_L, LEG_R } from './models/skeleton.js';

export const HG = { HEAD: 1, CHEST: 2, STOMACH: 3, LARM: 4, RARM: 5, LLEG: 6, RLEG: 7 };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// [bone, hitgroup, a, b, radius] in bind (model) space
function defs(team) {
  const ct = team === 'CT';
  const d = [
    // head: capsule along the skull; CT version covers the helmet shell + ear-pro
    ct ? ['head', 1, V(1.35, 64.7, 0), V(1.0, 68.1, 0), 4.6] : ['head', 1, V(1.45, 64.2, 0), V(1.0, 68.0, 0), 3.95],
    ['neck', 1, V(0.25, 58.8, 0), V(0.85, 62.2, 0), 2.45],
    ['chest', 2, V(ct ? 0.55 : 0.3, 53.2, -3.5), V(ct ? 0.55 : 0.3, 53.2, 3.5), ct ? 6.2 : 5.6],
    ['spine2', 3, V(0.0, 46.6, -3.2), V(0.0, 46.6, 3.2), ct ? 5.4 : 5.0],
    ['pelvis', 3, V(-0.3, 38.8, -3.3), V(-0.3, 38.8, 3.3), 5.3],
  ];
  for (const [s, A, Lg, hgA, hgL] of [['L', ARM_L, LEG_L, 4, 6], ['R', ARM_R, LEG_R, 5, 7]]) {
    d.push(['upperarm_' + s, hgA, A.sh.clone().addScaledVector(A.dU, 0.6), A.el.clone(), 3.1]);
    d.push(['forearm_' + s, hgA, A.el.clone(), A.wr.clone().addScaledVector(A.dF, 3.2), 2.35]);
    d.push(['thigh_' + s, hgL, Lg.hip.clone().add(V(0, 0.5, 0)), Lg.knee.clone(), ct ? 4.1 : 4.3]);
    d.push(['calf_' + s, hgL, Lg.knee.clone(), Lg.ankle.clone(), 3.1]);
    d.push(['foot_' + s, hgL, Lg.ankle.clone().add(V(-1.2, -1.2, 0)), Lg.toe.clone().add(V(2.2, 0.4, 0)), 2.2]);
  }
  return d;
}

/** Hitbox set for one character: array of { bone, hitgroup, r, la, lb, a, b } + .bound. */
export function createHitboxSet(team) {
  const set = defs(team).map(([bone, hitgroup, a, b, r]) => {
    const bi = BONE[bone];
    return { bone: bi, hitgroup, r, la: a.clone().sub(BIND[bi]), lb: b.clone().sub(BIND[bi]), a: a.clone(), b: b.clone() };
  });
  set.bound = { c: V(0, 36, 0), r: 48 };
  return set;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
/** Pose a hitbox set from model-space bone transforms and the root transform. */
export function poseHitboxes(set, Qm, Pm, rootPos, rootQuat) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const h of set) {
    const q = Qm[h.bone], p = Pm[h.bone];
    h.a.copy(h.la).applyQuaternion(q).add(p).applyQuaternion(rootQuat).add(rootPos);
    h.b.copy(h.lb).applyQuaternion(q).add(p).applyQuaternion(rootQuat).add(rootPos);
    for (const e of [h.a, h.b]) {
      if (e.x - h.r < minX) minX = e.x - h.r; if (e.y - h.r < minY) minY = e.y - h.r; if (e.z - h.r < minZ) minZ = e.z - h.r;
      if (e.x + h.r > maxX) maxX = e.x + h.r; if (e.y + h.r > maxY) maxY = e.y + h.r; if (e.z + h.r > maxZ) maxZ = e.z + h.r;
    }
  }
  const b = set.bound;
  b.c.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  b.r = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return set;
}

/**
 * Ray vs capsule (segment pa-pb, radius r). dir must be normalised. Returns entry t or -1.
 * Rays starting inside the capsule return 0.
 */
export function rayCapsule(ro, rd, pa, pb, r) {
  const bax = pb.x - pa.x, bay = pb.y - pa.y, baz = pb.z - pa.z;
  const oax = ro.x - pa.x, oay = ro.y - pa.y, oaz = ro.z - pa.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * rd.x + bay * rd.y + baz * rd.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = rd.x * oax + rd.y * oay + rd.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  // inside test
  const tt = baba > 1e-9 ? Math.min(1, Math.max(0, baoa / baba)) : 0;
  const cx = oax - bax * tt, cy = oay - bay * tt, cz = oaz - baz * tt;
  if (cx * cx + cy * cy + cz * cz <= r * r) return 0;
  const a = baba - bard * bard;
  const b = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;
  let best = -1;
  if (a > 1e-9) {
    const h = b * b - a * c;
    if (h >= 0) {
      const t = (-b - Math.sqrt(h)) / a;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) return t >= 0 ? t : -1;
    }
  }
  // caps (spheres at both ends)
  for (let k = 0; k < 2; k++) {
    const ox = k ? ro.x - pb.x : oax, oy = k ? ro.y - pb.y : oay, oz = k ? ro.z - pb.z : oaz;
    const bb = rd.x * ox + rd.y * oy + rd.z * oz;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    const h = bb * bb - cc;
    if (h < 0) continue;
    const t = -bb - Math.sqrt(h);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/** Nearest hit of a ray against a hitbox set: { t, hitgroup, point, normal, box } | null. */
export function rayVsHitboxes(boxes, start, dir, maxDist = Infinity) {
  if (!boxes || !boxes.length) return null;
  const bd = boxes.bound;
  if (bd) {
    // ray vs bounding sphere early-out
    const ox = start.x - bd.c.x, oy = start.y - bd.c.y, oz = start.z - bd.c.z;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const c = ox * ox + oy * oy + oz * oz - bd.r * bd.r;
    if (c > 0 && (b > 0 || b * b - c < 0)) return null;
    if (c > 0 && -b - Math.sqrt(b * b - c) > maxDist) return null;
  }
  let bestT = Infinity, best = null;
  for (const h of boxes) {
    const t = rayCapsule(start, dir, h.a, h.b, h.r);
    if (t >= 0 && t < bestT && t <= maxDist) {
      // head wins ties inside the neck/shoulder overlap only when it is actually first
      bestT = t; best = h;
    }
  }
  if (!best) return null;
  const point = new THREE.Vector3().copy(start).addScaledVector(dir, bestT);
  // normal from the closest point on the capsule axis
  const ax = best.b.x - best.a.x, ay = best.b.y - best.a.y, az = best.b.z - best.a.z;
  const l2 = ax * ax + ay * ay + az * az;
  const s = l2 > 1e-9 ? Math.min(1, Math.max(0, ((point.x - best.a.x) * ax + (point.y - best.a.y) * ay + (point.z - best.a.z) * az) / l2)) : 0;
  const normal = new THREE.Vector3(point.x - best.a.x - ax * s, point.y - best.a.y - ay * s, point.z - best.a.z - az * s);
  if (normal.lengthSq() < 1e-9) normal.copy(dir).negate(); else normal.normalize();
  return { t: bestT, hitgroup: best.hitgroup, point, normal, box: best };
}

// ---- debug drawing (r_drawhitboxes) --------------------------------------------------------------
const HG_COLOR = { 1: 0xff3030, 2: 0x30ff60, 3: 0x3080ff, 4: 0xffd030, 5: 0xffd030, 6: 0xff40ff, 7: 0xff40ff };
const capGeoCache = new Map();
function capsuleLines(r, len) {
  const k = `${r.toFixed(2)}:${len.toFixed(1)}`;
  let g = capGeoCache.get(k);
  if (!g) { g = new THREE.WireframeGeometry(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 3, 8)); capGeoCache.set(k, g); }
  return g;
}
const lineMats = {};
const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
/** Create / update a Group of wireframe capsules for a hitbox set (world space). */
export function debugDrawHitboxes(parent, boxes, group = null) {
  if (!group) {
    group = new THREE.Group();
    group.name = 'hitboxes';
    for (const h of boxes) {
      const mat = lineMats[h.hitgroup] || (lineMats[h.hitgroup] = new THREE.LineBasicMaterial({ color: HG_COLOR[h.hitgroup] || 0xffffff, depthTest: false, transparent: true, opacity: 0.85 }));
      const len = h.a.distanceTo(h.b);
      const l = new THREE.LineSegments(capsuleLines(h.r, len), mat);
      l.renderOrder = 999; l.frustumCulled = false;
      group.add(l);
    }
    parent.add(group);
  }
  boxes.forEach((h, i) => {
    const l = group.children[i];
    l.position.addVectors(h.a, h.b).multiplyScalar(0.5);
    _d.subVectors(h.b, h.a);
    if (_d.lengthSq() > 1e-9) l.quaternion.setFromUnitVectors(_up, _d.normalize());
  });
  return group;
}
