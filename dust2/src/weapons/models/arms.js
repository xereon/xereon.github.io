// First-person arms: one skinned hand + forearm rig per side, rigidly bound (each part to a
// bone), posed per weapon with finger-curl presets. The left arm is the right rig mirrored by
// its mount (scale.x = -1), so poses are authored once.
//
// Hand space (right hand): origin at the wrist centre, fingers toward -Z, back of the hand +Y,
// thumb on -X. The `arm` bone points +Z toward the elbow and is aimed every frame.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as G from './geo.js';
import { getMaterial } from './materials.js';

const DEG = Math.PI / 180;
// finger: knuckle position, segment lengths, radii (base, mid, tip), splay (deg about Y)
const FINGERS = [
  { k: [-1.1, 0.02, -3.5], L: [1.6, 0.96, 0.78], R: [0.37, 0.34, 0.31, 0.28], splay: 5 },
  { k: [-0.37, 0.06, -3.68], L: [1.76, 1.08, 0.82], R: [0.38, 0.35, 0.32, 0.29], splay: 1 },
  { k: [0.37, 0.0, -3.56], L: [1.66, 1.02, 0.8], R: [0.36, 0.33, 0.3, 0.27], splay: -3 },
  { k: [1.04, -0.12, -3.2], L: [1.28, 0.78, 0.7], R: [0.31, 0.28, 0.26, 0.24], splay: -8 },
];
const THUMB = { base: [-0.95, -0.36, -0.8], L: [1.55, 1.22, 1.0], R: [0.5, 0.42, 0.39, 0.34] };
// Thumb metacarpal rest frame: the bone points along `dir` (forward, thumb-side, palmar) and
// flexes (rotation about its local X) toward `curl` — across the palm, i.e. opposition.
const THUMB_DIR = [-0.62, -0.42, -0.66], THUMB_CURL = [0.85, -0.45, -0.3];
function thumbRest() {
  const d = new THREE.Vector3(...THUMB_DIR).normalize();
  const c = new THREE.Vector3(...THUMB_CURL).normalize();
  const z = d.clone().negate();
  const y = c.clone().addScaledVector(d, -c.dot(d)).normalize().negate();
  const x = new THREE.Vector3().crossVectors(y, z);
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return [e.x / DEG, e.y / DEG, e.z / DEG];
}
const THUMB_REST = thumbRest();

const STYLE = {
  CT: { glove: 'glove_ct', palm: 'leather_ct', armor: 'armor_ct', sleeve: 'sleeve_ct', bareTips: 0, skin: 'skin', cuff: 'glove_ct' },
  T: { glove: 'glove_t', palm: 'glove_t', armor: null, sleeve: 'sleeve_t', bareTips: 2, skin: 'skin', cuff: 'glove_t2' },
};

// Tapered capsule along -Z from 0 (radius r0) to L (radius r1), flattened dorsally.
function phalanx(r0, r1, L, flat = 0.86, tip = false) {
  const prof = [];
  const n = 4;
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI / 2; prof.push([r0 * Math.cos(a), r0 * Math.sin(a)]); }
  // shaft: bulge near the base joint, slight waist, flare into the next joint
  prof.push([r0 * 1.02, L * 0.12], [(r0 + r1) * 0.5 * 0.94, L * 0.5], [r1 * 1.01, L * 0.86]);
  const tr = tip ? r1 * 1.06 : r1;
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI / 2; prof.push([tr * Math.cos(a), L + tr * Math.sin(a) * (tip ? 1.2 : 1)]); }
  const g = G.lathe(prof, 14, { crease: 80 });
  g.scale(1, flat, 1);
  if (tip) G.deform(g, (v) => { const u = -v.z; if (u > L * 0.3 && v.y < 0) v.y *= 1 - 0.18 * Math.min(1, (u - L * 0.3) / (L * 0.6)); }, 80);
  return g;
}

class SkinBuilder {
  constructor() { this.byMat = new Map(); }
  add(mat, geo, bone, bindM, o = {}) {
    const g = geo.clone();
    if (o.m) g.applyMatrix4(o.m);
    g.applyMatrix4(bindM);
    // box-projected uvs in bone-local-ish inches
    const p = g.attributes.position, n = p.count;
    const uv = new Float32Array(n * 2), col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3(), t = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      nn.subVectors(c, b).cross(t.subVectors(a, b));
      const ax = Math.abs(nn.x), ay = Math.abs(nn.y), az = Math.abs(nn.z);
      for (let k = 0; k < 3; k++) {
        const q = k === 0 ? a : k === 1 ? b : c;
        let u, v;
        if (ax >= ay && ax >= az) { u = q.z; v = q.y; } else if (ay >= az) { u = q.z; v = q.x; } else { u = q.x; v = q.y; }
        uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
      }
    }
    const tint = o.c ? new THREE.Color(o.c) : new THREE.Color(1, 1, 1);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b;
      si[i * 4] = bone; sw[i * 4] = 1;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    let l = this.byMat.get(mat);
    if (!l) this.byMat.set(mat, (l = []));
    l.push(g);
  }
  build() {
    const geos = [], mats = [];
    for (const [k, l] of this.byMat) { geos.push(mergeGeometries(l, false)); mats.push(getMaterial(k)); }
    const geo = mergeGeometries(geos, true);
    return { geo, mats };
  }
}

const cache = new Map();

/** Builds the (unposed) rig template for a team; returns { geo, mats, bones: [{name, parent, pos, rot}] }. */
function template(team) {
  if (cache.has(team)) return cache.get(team);
  const st = STYLE[team] || STYLE.CT;
  const bones = [];
  const add = (name, parent, pos, rot = [0, 0, 0]) => { bones.push({ name, parent, pos, rot }); return bones.length - 1; };
  const root = add('hand', -1, [0, 0, 0]);
  const arm = add('arm', root, [0, 0, 0]);
  const fingerIdx = FINGERS.map((f, i) => {
    const b0 = add(`f${i}0`, root, f.k, [0, f.splay, 0]);
    const b1 = add(`f${i}1`, b0, [0, 0, -f.L[0]]);
    const b2 = add(`f${i}2`, b1, [0, 0, -f.L[1]]);
    return [b0, b1, b2];
  });
  const t0 = add('t0', root, THUMB.base, THUMB_REST);
  const t1 = add('t1', t0, [0, 0, -THUMB.L[0]]);
  const t2 = add('t2', t1, [0, 0, -THUMB.L[1]]);

  // rest world matrices (relative to hand root)
  const world = bones.map(() => new THREE.Matrix4());
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  bones.forEach((b, i) => {
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...b.pos), q.setFromEuler(e.set(b.rot[0] * DEG, b.rot[1] * DEG, b.rot[2] * DEG)), new THREE.Vector3(1, 1, 1));
    world[i] = b.parent < 0 ? local : world[b.parent].clone().multiply(local);
  });

  const sb = new SkinBuilder();
  const M = (p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) => new THREE.Matrix4().compose(new THREE.Vector3(...p),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG)), new THREE.Vector3(...s));

  // --- palm (top-view outline, extruded in Y with a fat bevel => pillowy) ---
  // outline in (x, u) with u = distance toward the fingers
  const palmPts = [
    [-1.05, -0.3, 0.5], [1.0, -0.3, 0.6], [1.42, 2.6, 0.7], [1.3, 3.3, 0.4], [0.7, 3.72, 0.4],
    [-0.3, 3.85, 0.4], [-1.25, 3.62, 0.45], [-1.52, 2.8, 0.5], [-1.45, 1.2, 0.6],
  ];
  const palmGeo = G.deform(G.top(palmPts, 1.18, { bevel: 0.42, bseg: 4, cseg: 4 }), (v) => {
    // dorsal arch across the knuckles and thinning toward the fingers
    v.y += -0.12 * (v.x * v.x) / 2;
    const u = -v.z;
    if (v.y < 0) v.y *= 1 - 0.18 * Math.max(0, (u - 2.2) / 1.6);
    if (v.y > 0) v.y *= 0.92;
  }, 70);
  sb.add(st.palm, palmGeo, root, world[root], { m: M([0, -0.06, 0]) });
  // back of the hand: glove shell (slightly larger, top half) for CT fabric / T leather
  if (st.palm !== st.glove) {
    const back = G.deform(G.top(palmPts.map((p) => [p[0] * 1.02, p[1], p[2]]), 0.7, { bevel: 0.3, bseg: 3, cseg: 4 }), (v) => { v.y += -0.12 * (v.x * v.x) / 2; }, 70);
    sb.add(st.glove, back, root, world[root], { m: M([0, 0.26, 0]) });
  }
  // hypothenar pad on the pinky edge of the palm
  sb.add(st.palm, G.sphere(0.62, 14, 10), root, world[root], { m: M([0.95, -0.28, -1.5], [0, 0, 0], [0.75, 0.85, 1.9]) });
  // knuckles
  FINGERS.forEach((f) => {
    sb.add(st.glove, G.sphere(f.R[0] * 1.05, 12, 8), root, world[root], { m: M([f.k[0], f.k[1] + 0.1, f.k[2] + 0.12], [0, 0, 0], [1.05, 0.9, 1.1]) });
  });
  if (st.armor) {
    // hard knuckle guard across the MCP line + wrist-side vent plate
    const guard = G.deform(G.box(2.9, 0.15, 0.78, { r: 0.07 }), (v) => { v.y -= 0.15 * v.x * v.x; v.z += 0.12 * v.x; }, 60);
    sb.add(st.armor, guard, root, world[root], { m: M([-0.02, 0.56, -3.28], [4, 0, -1]) });
    // vented ridges on the guard
    for (let i = -2; i <= 2; i++) sb.add(st.armor, G.box(0.08, 0.06, 0.5, { r: 0.025 }), root, world[root], { m: M([i * 0.5, 0.64 - 0.15 * (i * 0.5) ** 2, -3.3 + 0.06 * i], [4, 0, 0]) });
    sb.add(st.glove, G.deform(G.box(2.3, 0.14, 1.5, { r: 0.07 }), (v) => { v.y -= 0.12 * v.x * v.x; }, 60), root, world[root], { m: M([0.05, 0.52, -1.75], [2, 0, 0]) });
  }

  // --- fingers ---
  FINGERS.forEach((f, i) => {
    for (let j = 0; j < 3; j++) {
      const bare = j >= 3 - st.bareTips;
      const mat = bare ? st.skin : st.glove;
      const r0 = f.R[j] + (bare ? 0 : 0.04), r1 = f.R[j + 1] + (bare ? 0 : 0.04);
      sb.add(mat, phalanx(r0, r1, f.L[j], 0.86, j === 2), fingerIdx[i][j], world[fingerIdx[i][j]]);
      if (bare && j === 2) {
        // nail
        sb.add('nail', G.deform(G.box(f.R[3] * 1.3, 0.05, f.L[2] * 0.62, { r: 0.08 }), (v) => { v.y -= 0.35 * v.x * v.x; }, 70),
          fingerIdx[i][j], world[fingerIdx[i][j]], { m: M([0, f.R[3] * 0.84, -f.L[2] * 0.62]) });
      }
      if (!bare && j === 3 - st.bareTips - 1 && st.bareTips) {
        // fingerless cut edge: rolled leather rim
        sb.add(st.glove, G.torus(r1 * 0.98, 0.05, { rs: 6, ts: 14 }), fingerIdx[i][j], world[fingerIdx[i][j]], { m: M([0, 0, -f.L[j] + 0.05], [0, 0, 0], [1, 0.86, 1]) });
      }
      if (st.armor && j === 0) {
        sb.add(st.armor, G.deform(G.box(r0 * 1.45, 0.08, f.L[0] * 0.5, { r: 0.035 }), (v) => { v.y -= 0.55 * v.x * v.x; }, 70),
          fingerIdx[i][j], world[fingerIdx[i][j]], { m: M([0, r0 * 0.84, -f.L[0] * 0.55]) });
      }
    }
    // palm-side finger crease pads (fabric seam at the joints)
    sb.add(st.palm, G.sphere(f.R[1] * 0.92, 10, 6), fingerIdx[i][1], world[fingerIdx[i][1]], { m: M([0, -0.1, -0.02], [0, 0, 0], [1, 0.8, 1]) });
  });

  // --- thumb ---
  const tb = [t0, t1, t2];
  for (let j = 0; j < 3; j++) {
    const bare = st.bareTips && j === 2;
    const mat = bare ? st.skin : (j === 0 ? st.palm : st.glove);
    sb.add(mat, phalanx(THUMB.R[j] + (bare ? 0 : 0.04), THUMB.R[j + 1] + (bare ? 0 : 0.04), THUMB.L[j], 0.9, j === 2), tb[j], world[tb[j]]);
    if (bare) sb.add('nail', G.deform(G.box(THUMB.R[3] * 1.35, 0.05, THUMB.L[2] * 0.6, { r: 0.08 }), (v) => { v.y -= 0.35 * v.x * v.x; }, 70), tb[j], world[tb[j]], { m: M([0, THUMB.R[3] * 0.86, -THUMB.L[2] * 0.62]) });
  }
  // thenar muscle mass (bound to the thumb metacarpal so it bulges with it)
  sb.add(st.palm, G.sphere(0.62, 14, 10), t0, world[t0], { m: M([0.25, -0.1, -0.55], [0, 0, 0], [1.05, 0.9, 1.5]) });

  // --- wrist + forearm (bound to `arm`, pointing +Z) ---
  const toBack = M([0, 0, 0], [0, 180, 0]);
  const fore = G.lathe([[0.001, -0.6], [0.95, -0.5], [1.12, 0.0], [1.2, 2.0], [1.42, 5.0], [1.62, 8.0], [1.72, 11.5], [1.74, 14]], 20, { crease: 80 });
  fore.scale(1, 0.8, 1);
  const cuffLen = team === 'T' ? 1.3 : 2.4;
  if (team === 'T') {
    sb.add(st.skin, fore, arm, world[arm], { m: toBack });
    // rolled sleeve
    const roll = G.lathe([[1.5, 5.4], [1.95, 5.6], [2.12, 6.2], [2.05, 6.9], [1.85, 7.2]], 20, { crease: 80 });
    roll.scale(1, 0.86, 1);
    sb.add(st.sleeve, G.deform(roll, (v) => { const a = Math.atan2(v.y, v.x); v.x *= 1 + 0.05 * Math.sin(a * 5); }), arm, world[arm], { m: toBack });
    const sl = G.lathe([[1.9, 7.0], [2.0, 9], [2.2, 14]], 18, { crease: 80 }); sl.scale(1, 0.86, 1);
    sb.add(st.sleeve, sl, arm, world[arm], { m: toBack });
  } else {
    const sl = G.lathe([[1.42, 1.6], [1.62, 1.9], [1.7, 2.6], [1.8, 5], [1.95, 8], [2.1, 11], [2.2, 14]], 22, { crease: 80, });
    sl.scale(1, 0.84, 1);
    // folds
    sb.add(st.sleeve, G.deform(sl, (v) => {
      const a = Math.atan2(v.y, v.x), u = -v.z;
      const fold = Math.sin(u * 1.7 + a * 2) * 0.05 + Math.sin(u * 0.9 - a * 3) * 0.04;
      v.x *= 1 + fold; v.y *= 1 + fold;
    }, 80), arm, world[arm], { m: toBack });
  }
  // glove cuff around the wrist, with a strap on top
  const cuff = G.lathe([[1.08, -0.4], [1.24, -0.2], [1.3, 0.4], [1.32, cuffLen - 0.2], [1.2, cuffLen]], 20, { crease: 70 });
  cuff.scale(1, 0.82, 1);
  sb.add(st.cuff, cuff, arm, world[arm], { m: toBack });
  sb.add(st.palm, G.deform(G.box(1.5, 0.14, 1.0, { r: 0.08 }), (v) => { v.y -= 0.22 * v.x * v.x; }, 70), arm, world[arm], { m: M([0.15, 1.08, cuffLen * 0.45]) });
  if (st.armor) sb.add(st.armor, G.box(0.3, 0.1, 0.3, { r: 0.04 }), arm, world[arm], { m: M([0.15, 1.2, cuffLen * 0.45]) });

  const t = { ...sb.build(), bones };
  cache.set(team, t);
  return t;
}

/** Finger pose presets: per finger [mcp, pip, dip, spread], thumb [[x,y,z], flex1, flex2]. */
export const POSES = {
  relaxed: { f: [[15, 20, 12, 0], [18, 24, 12, 0], [22, 28, 14, 0], [26, 30, 16, 0]], t: [[0, 0, 0], 10, 10] },
  grip: { f: [[40, 80, 40, 0], [70, 95, 50, 0], [75, 95, 50, 0], [78, 90, 48, 0]], t: [[28, 0, 0], 25, 20] },
  trigger: { f: [[32, 62, 38, 4], [70, 95, 50, 0], [75, 95, 50, 0], [78, 90, 48, 0]], t: [[28, 0, 0], 25, 20] },
  wrap: { f: [[45, 70, 35, 0], [50, 72, 35, 0], [52, 72, 35, 0], [55, 72, 35, 0]], t: [[10, -5, 0], 10, 15] },
  cup: { f: [[35, 55, 28, 0], [38, 58, 30, 0], [40, 60, 30, 0], [44, 62, 32, 0]], t: [[18, 0, 0], 20, 25] },
  pinch: { f: [[30, 55, 25, 0], [55, 80, 40, 0], [70, 90, 45, 0], [78, 90, 48, 0]], t: [[30, 0, 0], 25, 20] },
  flat: { f: [[5, 5, 3, 0], [5, 5, 3, 0], [5, 5, 3, 0], [5, 5, 3, 0]], t: [[-10, 0, 0], 5, 5] },
  fist: { f: [[85, 100, 60, 0], [88, 100, 60, 0], [88, 100, 60, 0], [88, 100, 60, 0]], t: [[40, 0, 0], 30, 30] },
};

/**
 * One posable arm. mount: Object3D whose transform = hand wrist frame (set by the viewmodel).
 */
export class Arm {
  constructor(team, left) {
    const T = template(team);
    this.mount = new THREE.Group();
    this.mount.name = left ? 'arm_L' : 'arm_R';
    if (left) this.mount.scale.x = -1;
    this.bones = T.bones.map((b) => { const bone = new THREE.Bone(); bone.name = b.name; bone.position.set(...b.pos); bone.rotation.set(b.rot[0] * DEG, b.rot[1] * DEG, b.rot[2] * DEG); bone.userData.rest = bone.quaternion.clone(); return bone; });
    T.bones.forEach((b, i) => { if (b.parent >= 0) this.bones[b.parent].add(this.bones[i]); });
    this.root = this.bones[0];
    this.armBone = this.bones[1];
    this.mesh = new THREE.SkinnedMesh(T.geo, T.mats);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mount.add(this.root);
    this.mount.add(this.mesh);
    this.mount.updateMatrixWorld(true);   // bone inverses + bind matrix from the same rest state
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.byName = Object.fromEntries(this.bones.map((b) => [b.name, b]));
    this.elbow = new THREE.Vector3();
    this._pose = { f: FINGERS.map(() => [0, 0, 0, 0]), t: [[0, 0, 0], 0, 0] };
    this._e = new THREE.Euler(); this._q = new THREE.Quaternion();
    this._inv = new THREE.Matrix4(); this._d = new THREE.Vector3(); this._z = new THREE.Vector3(0, 0, 1);
    this.setPose('relaxed');
  }
  /** Blend two presets (a -> b by t) or apply a preset / pose object. */
  setPose(a, b = null, t = 0) {
    const A = typeof a === 'string' ? POSES[a] : a;
    const B = b ? (typeof b === 'string' ? POSES[b] : b) : null;
    const P = this._pose;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) P.f[i][j] = B ? A.f[i][j] + (B.f[i][j] - A.f[i][j]) * t : A.f[i][j];
    for (let j = 0; j < 3; j++) P.t[0][j] = B ? A.t[0][j] + (B.t[0][j] - A.t[0][j]) * t : A.t[0][j];
    P.t[1] = B ? A.t[1] + (B.t[1] - A.t[1]) * t : A.t[1];
    P.t[2] = B ? A.t[2] + (B.t[2] - A.t[2]) * t : A.t[2];
    this._apply();
  }
  _apply() {
    const P = this._pose, e = this._e, q = this._q;
    for (let i = 0; i < 4; i++) {
      const f = P.f[i];
      for (let j = 0; j < 3; j++) {
        const bone = this.byName[`f${i}${j}`];
        e.set(-f[j] * DEG, j === 0 ? f[3] * DEG : 0, 0);
        bone.quaternion.copy(bone.userData.rest).multiply(q.setFromEuler(e));
      }
    }
    const t0 = this.byName.t0, t1 = this.byName.t1, t2 = this.byName.t2;
    e.set(-P.t[0][0] * DEG, P.t[0][1] * DEG, P.t[0][2] * DEG);
    t0.quaternion.copy(t0.userData.rest).multiply(q.setFromEuler(e));
    e.set(-P.t[1] * DEG, 0, 0); t1.quaternion.copy(t1.userData.rest).multiply(q.setFromEuler(e));
    e.set(-P.t[2] * DEG, 0, 0); t2.quaternion.copy(t2.userData.rest).multiply(q.setFromEuler(e));
  }
  /** Aim the forearm at the elbow point (world space). Call after the mount's matrixWorld is current. */
  aim(elbowWorld) {
    this.root.updateMatrixWorld(true);
    this._inv.copy(this.root.matrixWorld).invert();
    const d = this._d.copy(elbowWorld).applyMatrix4(this._inv).normalize();
    this.armBone.quaternion.setFromUnitVectors(this._z, d);
    this.armBone.updateMatrixWorld(true);
  }
}

/** Build a hand orientation: `across` = index->pinky knuckle direction, `palm` = palm normal
 *  (pointing into the held object). Returns a quaternion for the mount (mirror for left). */
export function handQuat(across, palm, left = false, out = new THREE.Quaternion()) {
  const x = new THREE.Vector3(...across).normalize();
  const y = new THREE.Vector3(...palm).normalize().negate();
  y.addScaledVector(x, -y.dot(x)).normalize();
  if (left) x.negate();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}
