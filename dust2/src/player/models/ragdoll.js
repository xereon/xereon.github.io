// Verlet / position-based ragdoll over the joint chain. Particles sit on joints, distance
// constraints keep bone lengths, braced clusters keep the torso rigid, inequality + hinge
// constraints stop knees / elbows folding the wrong way, and every particle is swept against
// the brush world with World.collision.hullTrace (small boxes). Sleeps once settled and stays.
import * as THREE from 'three';
import { World } from '../../core/world.js';
import { BONE, BIND, NBONES, PARENT, REST_OFS } from './skeleton.js';
import { qFromXY } from './pose.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const GRAV = 620;
// particles: [name, bone (joint), bind-space offset from that joint, radius, inverse mass]
const P_DEF = [
  ['pelvis', 'pelvis', V(0, 0, 0), 4.6, 0.6],
  ['hipL', 'thigh_L', V(0, 0, 0), 3.8, 0.9], ['hipR', 'thigh_R', V(0, 0, 0), 3.8, 0.9],
  ['kneeL', 'calf_L', V(0, 0, 0), 2.9, 1.1], ['kneeR', 'calf_R', V(0, 0, 0), 2.9, 1.1],
  ['ankL', 'foot_L', V(0, 0, 0), 2.4, 1.3], ['ankR', 'foot_R', V(0, 0, 0), 2.4, 1.3],
  ['toeL', 'toe_L', V(1.5, 0, 0), 1.6, 1.5], ['toeR', 'toe_R', V(1.5, 0, 0), 1.6, 1.5],
  ['spine', 'spine2', V(0, 0, 0), 5.0, 0.7],
  ['neck', 'neck', V(0, 0, 0), 3.2, 0.9],
  ['head', 'head', V(0.5, 3.8, 0), 4.0, 1.0],
  ['shL', 'upperarm_L', V(0, 0, 0), 3.2, 1.0], ['shR', 'upperarm_R', V(0, 0, 0), 3.2, 1.0],
  ['elL', 'forearm_L', V(0, 0, 0), 2.4, 1.3], ['elR', 'forearm_R', V(0, 0, 0), 2.4, 1.3],
  ['wrL', 'hand_L', V(0, 0, 0), 2.2, 1.5], ['wrR', 'hand_R', V(0, 0, 0), 2.2, 1.5],
];
const PI = {};
P_DEF.forEach(([n], i) => { PI[n] = i; });
const NP = P_DEF.length;
const bindPos = P_DEF.map(([, b, o]) => BIND[BONE[b]].clone().add(o));

// constraints: [a, b, kind] kind 0 = rigid, 1 = min only (fraction of rest), 2 = soft
const C_DEF = [];
const rigid = (a, b, k = 1) => C_DEF.push([PI[a], PI[b], 0, k]);
const minD = (a, b, f) => C_DEF.push([PI[a], PI[b], 1, f]);
// lower torso cluster + upper torso cluster sharing 'spine'
for (const [a, b] of [['pelvis', 'hipL'], ['pelvis', 'hipR'], ['hipL', 'hipR'], ['pelvis', 'spine'], ['hipL', 'spine'], ['hipR', 'spine']]) rigid(a, b);
for (const [a, b] of [['spine', 'neck'], ['spine', 'shL'], ['spine', 'shR'], ['neck', 'shL'], ['neck', 'shR'], ['shL', 'shR']]) rigid(a, b);
rigid('pelvis', 'neck', 0.25); rigid('hipL', 'shL', 0.2); rigid('hipR', 'shR', 0.2); rigid('hipL', 'shR', 0.15); rigid('hipR', 'shL', 0.15);
// limbs
for (const s of ['L', 'R']) {
  rigid('hip' + s, 'knee' + s); rigid('knee' + s, 'ank' + s); rigid('ank' + s, 'toe' + s); rigid('knee' + s, 'toe' + s, 0.6);
  rigid('sh' + s, 'el' + s); rigid('el' + s, 'wr' + s);
  minD('hip' + s, 'ank' + s, 0.45); minD('sh' + s, 'wr' + s, 0.3);
  minD('knee' + s, 'spine', 0.75); minD('knee' + s, 'neck', 0.8);
  minD('el' + s, 'hipL', 0.35); minD('el' + s, 'hipR', 0.35);
}
rigid('neck', 'head'); minD('head', 'shL', 0.8); minD('head', 'shR', 0.8); minD('head', 'spine', 0.85);
minD('kneeL', 'kneeR', 0.25); minD('ankL', 'ankR', 0.25);
const REST = C_DEF.map(([a, b]) => bindPos[a].distanceTo(bindPos[b]));

// bone <- particle frame mapping: bone -> [pA, pB, pC, pD] vector a = pB - pA, vector b = pD - pC
const FRAMES = {
  pelvis: ['hipL', 'hipR', 'pelvis', 'spine'],
  chest: ['shL', 'shR', 'spine', 'neck'],
  neck: ['neck', 'head', 'shL', 'shR'],
};
const bindQinv = {};
for (const [b, [a0, a1, b0, b1]] of Object.entries(FRAMES)) {
  const va = bindPos[PI[a1]].clone().sub(bindPos[PI[a0]]), vb = bindPos[PI[b1]].clone().sub(bindPos[PI[b0]]);
  bindQinv[b] = qFromXY(new THREE.Quaternion(), va, vb).invert();
}
const LIMBS = [
  ['upperarm_L', 'forearm_L', 'shL', 'elL', 'wrL'], ['upperarm_R', 'forearm_R', 'shR', 'elR', 'wrR'],
  ['thigh_L', 'calf_L', 'hipL', 'kneeL', 'ankL'], ['thigh_R', 'calf_R', 'hipR', 'kneeR', 'ankR'],
];
const limbBind = LIMBS.map(([, , a, b, c]) => {
  const d1 = bindPos[PI[b]].clone().sub(bindPos[PI[a]]).normalize(), d2 = bindPos[PI[c]].clone().sub(bindPos[PI[b]]).normalize();
  const n = new THREE.Vector3().crossVectors(d1, d2).normalize();
  return { n, inv1: qFromXY(new THREE.Quaternion(), d1, n).invert(), inv2: qFromXY(new THREE.Quaternion(), d2, n).invert() };
});
const footBind = ['L', 'R'].map((s, k) => {
  const d = bindPos[PI['toe' + s]].clone().sub(bindPos[PI['ank' + s]]);
  return qFromXY(new THREE.Quaternion(), d, limbBind[2 + k].n).invert();
});

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _mins = new THREE.Vector3(), _maxs = new THREE.Vector3();

export class Ragdoll {
  constructor(model) {
    const A = model.anim;
    this.p = []; this.o = []; this.r = P_DEF.map((d) => d[3]); this.w = P_DEF.map((d) => d[4]);
    const rp = model.root.position, rq = model.rootQuat;
    for (let i = 0; i < NP; i++) {
      const [, b, ofs] = P_DEF[i];
      const bi = BONE[b];
      const p = ofs.clone().applyQuaternion(A.Qm[bi]).add(A.Pm[bi]).applyQuaternion(rq).add(rp);
      this.p.push(p); this.o.push(p.clone());
    }
    // current limb hinge normals (used when a limb is straight)
    this.n = LIMBS.map(() => new THREE.Vector3(0, 0, 1));
    // keep the hands' / head's relative rotation from the death pose
    this.handRel = ['L', 'R'].map((s) => A.Qm[BONE['forearm_' + s]].clone().invert().multiply(A.Qm[BONE['hand_' + s]]));
    this.headRel = A.Qm[BONE.neck].clone().invert().multiply(A.Qm[BONE.head]);
    this.Qm = A.Qm.map((q) => q.clone());
    this.Pm = A.Pm.map((p) => p.clone());
    this.rootQuat = new THREE.Quaternion();
    this.model = model;
    this.time = 0; this.still = 0; this.asleep = false; this.acc = 0;
    // inherit body velocity
    const ent = model.anim._lastVel;
    if (ent) for (let i = 0; i < NP; i++) this.o[i].addScaledVector(ent, -1 / 60);
  }

  /** Add an impulse: dir (world, normalised), force (~0.3..4, 1 = rifle body shot). */
  impulse(dir, force = 1, hitgroup = 0) {
    const d = _a.copy(dir || _a.set(0, 0, 0));
    if (d.lengthSq() < 1e-6) d.set(0, 0, 0); else d.normalize();
    const v = 55 * Math.min(4, Math.max(0.2, force));
    const add = (name, k) => { const i = PI[name]; this.o[i].addScaledVector(d, -v * k / 60); };
    // whole body shove
    for (const n of Object.keys(PI)) add(n, hitgroup === 0 ? 0.8 : 0.3);
    if (hitgroup === 0) { // explosion: lift everything
      for (let i = 0; i < NP; i++) this.o[i].y -= (v * 0.9) / 60;
    }
    const focus = {
      1: [['head', 2.6], ['neck', 1.0]],
      2: [['neck', 1.3], ['shL', 1.0], ['shR', 1.0], ['spine', 0.8]],
      3: [['spine', 1.2], ['pelvis', 1.0]],
      4: [['elL', 1.6], ['wrL', 1.6]], 5: [['elR', 1.6], ['wrR', 1.6]],
      6: [['kneeL', 1.8], ['ankL', 1.2]], 7: [['kneeR', 1.8], ['ankR', 1.2]],
    }[hitgroup] || [];
    for (const [n, k] of focus) add(n, k);
    if (hitgroup === 1) this.o[PI.head].y -= 18 / 60; // headshot snaps the head back and up
    this.asleep = false; this.still = 0;
  }

  step(dt) {
    if (this.asleep || dt <= 0) return;
    this.acc += Math.min(dt, 0.1);
    const h = 1 / 60;
    let n = 0;
    while (this.acc >= h && n < 3) { this._sub(h); this.acc -= h; n++; }
    if (n === 3) this.acc = 0;
  }

  _sub(h) {
    this.time += h;
    const p = this.p, o = this.o, col = World.collision;
    const pre = this._pre || (this._pre = p.map((x) => x.clone()));
    // integrate
    for (let i = 0; i < NP; i++) {
      pre[i].copy(p[i]);
      _a.subVectors(p[i], o[i]).multiplyScalar(0.992);
      o[i].copy(p[i]);
      p[i].add(_a);
      p[i].y -= GRAV * h * h;
    }
    this._collide(pre, col);
    // constraints
    for (let it = 0; it < 6; it++) {
      for (let k = 0; k < C_DEF.length; k++) {
        const [ia, ib, kind, stiff] = C_DEF[k];
        const pa = p[ia], pb = p[ib];
        _a.subVectors(pb, pa);
        const d = _a.length() || 1e-6;
        let rest = REST[k];
        if (kind === 1) { rest *= stiff; if (d >= rest) continue; }
        const wa = this.w[ia], wb = this.w[ib];
        const s = ((d - rest) / (d * (wa + wb))) * (kind === 0 ? stiff : 1);
        pa.addScaledVector(_a, s * wa);
        pb.addScaledVector(_a, -s * wb);
      }
      this._hinges();
    }
    this._collide(pre, col, true);
    // sleep check
    let maxMove = 0;
    for (let i = 0; i < NP; i++) maxMove = Math.max(maxMove, p[i].distanceToSquared(o[i]));
    if (Math.sqrt(maxMove) < 0.05) this.still++; else this.still = 0;
    if ((this.still > 40 && this.time > 0.6) || this.time > 4) this.asleep = true;
  }

  _hinges() {
    // knees bend forward (relative to the pelvis frame); elbows don't hyper-extend backwards
    const p = this.p;
    _b.subVectors(p[PI.hipR], p[PI.hipL]).normalize();                    // right
    _c.subVectors(p[PI.spine], p[PI.pelvis]).normalize();                 // up
    _d.crossVectors(_c, _b).normalize();                                  // forward
    for (const s of ['L', 'R']) {
      const H = p[PI['hip' + s]], K = p[PI['knee' + s]], A = p[PI['ank' + s]];
      _a.subVectors(A, H);
      const l2 = _a.lengthSq() || 1;
      const t = Math.max(0, Math.min(1, _c.copy(K).sub(H).dot(_a) / l2));
      _c.copy(H).addScaledVector(_a, t);               // closest point on hip-ankle line
      const off = _c.subVectors(K, _c).dot(_d);
      if (off < 0.4) {
        const k = 0.4 - off;
        K.addScaledVector(_d, k * 0.6); H.addScaledVector(_d, -k * 0.2); A.addScaledVector(_d, -k * 0.2);
      }
    }
  }

  _collide(pre, col, second = false) {
    if (!col?.hullTrace) {
      for (let i = 0; i < NP; i++) if (this.p[i].y < this.r[i]) this.p[i].y = this.r[i];
      return;
    }
    const p = this.p, o = this.o;
    for (let i = 0; i < NP; i++) {
      const r = this.r[i] * 0.72;
      _mins.set(-r, -r, -r); _maxs.set(r, r, r);
      if (pre[i].distanceToSquared(p[i]) < 1e-8) continue;
      const tr = col.hullTrace(_mins, _maxs, pre[i], p[i], 5); // solid + grate (not player clip)
      if (tr.startSolid) { p[i].copy(pre[i]); continue; }
      if (tr.fraction < 1) {
        p[i].copy(tr.endpos).addScaledVector(tr.normal, 0.05);
        // friction + inelastic: kill normal velocity, damp tangential
        _a.subVectors(p[i], o[i]);
        const vn = _a.dot(tr.normal);
        if (vn < 0) _a.addScaledVector(tr.normal, -vn);
        _a.multiplyScalar(second ? 0.55 : 0.7);
        o[i].subVectors(p[i], _a);
      }
      if (second) pre[i].copy(p[i]);
    }
  }

  /** Write bone transforms (model = world - root position, root rotation identity). */
  apply(model) {
    if (this.asleep && this.appliedAsleep) return;
    this.appliedAsleep = this.asleep;
    const p = this.p, Qm = this.Qm, Pm = this.Pm;
    const root = model.root;
    root.position.copy(p[PI.pelvis]);
    root.rotation.set(0, 0, 0);
    const frame = (bone, out) => {
      const [a0, a1, b0, b1] = FRAMES[bone];
      _a.subVectors(p[PI[a1]], p[PI[a0]]); _b.subVectors(p[PI[b1]], p[PI[b0]]);
      return qFromXY(out, _a, _b).multiply(bindQinv[bone]);
    };
    frame('pelvis', Qm[BONE.pelvis]);
    frame('chest', Qm[BONE.chest]);
    Qm[BONE.spine1].slerpQuaternions(Qm[BONE.pelvis], Qm[BONE.chest], 0.33);
    Qm[BONE.spine2].slerpQuaternions(Qm[BONE.pelvis], Qm[BONE.chest], 0.66);
    frame('neck', Qm[BONE.neck]);
    Qm[BONE.head].multiplyQuaternions(Qm[BONE.neck], this.headRel);
    Qm[BONE.clav_L].copy(Qm[BONE.chest]); Qm[BONE.clav_R].copy(Qm[BONE.chest]);
    LIMBS.forEach(([b1, b2, a, b, c], k) => {
      _a.subVectors(p[PI[b]], p[PI[a]]); _b.subVectors(p[PI[c]], p[PI[b]]);
      const n = _c.crossVectors(_a, _b);
      if (n.lengthSq() > 1e-3 * _a.lengthSq() * _b.lengthSq()) this.n[k].copy(n.normalize());
      qFromXY(Qm[BONE[b1]], _a, this.n[k]).multiply(limbBind[k].inv1);
      qFromXY(Qm[BONE[b2]], _b, this.n[k]).multiply(limbBind[k].inv2);
    });
    ['L', 'R'].forEach((s, k) => {
      Qm[BONE['hand_' + s]].multiplyQuaternions(Qm[BONE['forearm_' + s]], this.handRel[k]);
      _a.subVectors(p[PI['toe' + s]], p[PI['ank' + s]]);
      qFromXY(Qm[BONE['foot_' + s]], _a, this.n[2 + k]).multiply(footBind[k]);
      Qm[BONE['toe_' + s]].copy(Qm[BONE['foot_' + s]]);
    });
    // FK positions from the pelvis (keeps the skin unstretched)
    Pm[0].set(0, 0, 0);
    for (let i = 1; i < NBONES; i++) {
      const par = PARENT[i];
      Pm[i].copy(REST_OFS[i]).applyQuaternion(Qm[par]).add(Pm[par]);
    }
    const bones = model.bones;
    bones[0].position.copy(Pm[0]); bones[0].quaternion.copy(Qm[0]);
    for (let i = 1; i < NBONES; i++) bones[i].quaternion.copy(Qm[PARENT[i]]).invert().multiply(Qm[i]);
  }
}
