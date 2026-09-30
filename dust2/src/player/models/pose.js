// Procedural animation solver. Produces model-space bone rotations (Qm) and joint positions
// (Pm) from entity state each frame: speed-synced gait (feet planted, no skating), lower body
// turning toward the move direction while the upper body keeps the aim, crouch, air/landing,
// weapon stances with two-bone IK onto the held weapon, recoil, reload and breathing.
import * as THREE from 'three';
import { World } from '../../core/world.js';
import {
  BONE, NBONES, PARENT, REST_OFS, BIND, ARM, LEG, ARM_L, ARM_R, LEG_L, LEG_R, HAND_L, HAND_R,
} from './skeleton.js';

const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (l, dt) => 1 - Math.exp(-l * dt);
const angN = (a) => { a %= 360; if (a > 180) a -= 360; if (a < -180) a += 360; return a; };
const frac = (x) => x - Math.floor(x);

// ---- scratch -----------------------------------------------------------------------------------
const _v = Array.from({ length: 16 }, () => new THREE.Vector3());
const _q = Array.from({ length: 8 }, () => new THREE.Quaternion());
const _ik = Array.from({ length: 7 }, () => new THREE.Vector3());   // two-bone IK only
const _gs = new THREE.Vector3(), _ge = new THREE.Vector3(), _qt = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

/** Quaternion of the right-handed basis (x, y', x × y) with y orthogonalised against x. */
export function qFromXY(out, x, y) {
  _bx.copy(x).normalize();
  _bz.crossVectors(_bx, y).normalize();
  _by.crossVectors(_bz, _bx);
  _m.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_m);
}
function qYZ(out, yawDeg, pitchDownDeg, rollDeg = 0) {
  // yaw about +Y, then pitch (positive = nose down) about the yawed +Z, then roll about +X
  _q[7].setFromAxisAngle(AY, yawDeg * DEG);
  out.setFromAxisAngle(AZ, -pitchDownDeg * DEG);
  out.premultiply(_q[7]);
  if (rollDeg) { _q[6].setFromAxisAngle(AX, rollDeg * DEG); out.multiply(_q[6]); }
  return out;
}

// bind-frame quaternions for limb bones: x = bone axis, y = hinge axis
function limbBind(a, b, c) {
  const d1 = b.clone().sub(a).normalize(), d2 = c.clone().sub(b).normalize();
  const n = new THREE.Vector3().crossVectors(d1, d2).normalize();
  const q1 = qFromXY(new THREE.Quaternion(), d1, n).invert();
  const q2 = qFromXY(new THREE.Quaternion(), d2, n).invert();
  return { d1, d2, n, inv1: q1, inv2: q2, l1: a.distanceTo(b), l2: b.distanceTo(c) };
}
const LIMB = {
  armL: limbBind(ARM_L.sh, ARM_L.el, ARM_L.wr), armR: limbBind(ARM_R.sh, ARM_R.el, ARM_R.wr),
  legL: limbBind(LEG_L.hip, LEG_L.knee, LEG_L.ankle), legR: limbBind(LEG_R.hip, LEG_R.knee, LEG_R.ankle),
};
const HANDINV = {
  L: qFromXY(new THREE.Quaternion(), HAND_L.xh, HAND_L.yh).invert(),
  R: qFromXY(new THREE.Quaternion(), HAND_R.xh, HAND_R.yh).invert(),
};
const TOE_OFS = { L: REST_OFS[BONE.toe_L].clone(), R: REST_OFS[BONE.toe_R].clone() };
const ANKLE_H = BIND[BONE.foot_L].y;          // ankle height above the sole when flat
const HIP_OFS = { L: REST_OFS[BONE.thigh_L], R: REST_OFS[BONE.thigh_R] };

/** Weapon hold definitions (weapon-local space: +X muzzle, +Y up, origin = pistol grip). */
export const HOLDS = {
  rifle: {
    anchor: 'shoulder', ofs: new THREE.Vector3(12.5, 1.2, -0.4),
    rGrip: new THREE.Vector3(0, 0, 0), rThumb: new THREE.Vector3(0.26, 0.97, 0), rFing: new THREE.Vector3(0.97, -0.26, 0),
    lGrip: new THREE.Vector3(9.5, 0.7, 0), lThumb: new THREE.Vector3(1, 0.1, 0), lFing: new THREE.Vector3(0, 0.35, 1),
    poleR: new THREE.Vector3(-0.35, -1, 0.75), poleL: new THREE.Vector3(-0.1, -1, -0.25),
  },
  pistol: {
    anchor: 'chest', ofs: new THREE.Vector3(17.5, 1.6, 1.0),
    rGrip: new THREE.Vector3(0, 0, 0), rThumb: new THREE.Vector3(0.26, 0.97, 0), rFing: new THREE.Vector3(0.97, -0.26, 0),
    lGrip: new THREE.Vector3(-0.3, -0.9, -1.45), lThumb: new THREE.Vector3(0.95, 0.3, 0), lFing: new THREE.Vector3(0.05, -0.45, 0.9),
    poleR: new THREE.Vector3(-0.3, -1, 0.9), poleL: new THREE.Vector3(-0.3, -1, -0.9),
  },
  knife: {
    anchor: 'chest', ofs: new THREE.Vector3(11, -5, 4.5), pitchK: 0.5,
    rGrip: new THREE.Vector3(0, 0, 0), rThumb: new THREE.Vector3(1, 0.15, 0), rFing: new THREE.Vector3(0, -1, 0),
    lFree: new THREE.Vector3(8.5, -3.5, -5.5), lThumb: new THREE.Vector3(0.2, 1, 0), lFing: new THREE.Vector3(1, 0, 0.2),
    poleR: new THREE.Vector3(-0.6, -1, 0.5), poleL: new THREE.Vector3(-0.6, -1, -0.5),
  },
  nade: {
    anchor: 'shoulder', ofs: new THREE.Vector3(-1.5, 5.5, 1.5), pitchK: 0.2,
    rGrip: new THREE.Vector3(0, 0, 0), rThumb: new THREE.Vector3(0.3, 0.95, 0), rFing: new THREE.Vector3(1, -0.3, 0),
    lFree: new THREE.Vector3(15, 2, -4), lThumb: new THREE.Vector3(0.3, 1, 0), lFing: new THREE.Vector3(1, 0, 0),
    poleR: new THREE.Vector3(-0.8, -0.4, 1), poleL: new THREE.Vector3(-0.2, -1, -0.6),
  },
  c4: {
    anchor: 'chest', ofs: new THREE.Vector3(9.5, -9.5, 0), pitchK: 0.15,
    rGrip: new THREE.Vector3(0, 0.3, 2.6), rThumb: new THREE.Vector3(0.2, 1, 0), rFing: new THREE.Vector3(1, 0, -0.3),
    lGrip: new THREE.Vector3(0, 0.3, -2.6), lThumb: new THREE.Vector3(0.2, 1, 0), lFing: new THREE.Vector3(1, 0, 0.3),
    poleR: new THREE.Vector3(-0.3, -1, 0.8), poleL: new THREE.Vector3(-0.3, -1, -0.8),
  },
};

// torso yaw (deg, negative = turned right) per stance
const BLADE = { rifle: -30, pistol: -8, knife: -14, nade: -22, c4: 0 };

const PISTOLS = /^(glock|usp|usp_silencer|hkp2000|p2000|p250|deagle|tec9|fiveseven|dualberettas|elite|cz75a?|revolver|r8)$/;
export function holdKind(ent) {
  const a = ent?.active;
  if (!a) return 'rifle';
  if (typeof a === 'string') {
    if (a === 'secondary' || PISTOLS.test(a) || a === 'taser' || a === 'zeus') return 'pistol';
    if (a === 'knife') return 'knife';
    if (a === 'c4') return 'c4';
    if (a === 'grenades' || /grenade|flash|molotov|decoy/.test(a)) return 'nade';
    return 'rifle';
  }
  const slot = a.def?.slot || a.slot;
  const key = a.key || a.def?.key || '';
  if (!slot && PISTOLS.test(key)) return 'pistol';
  if (slot === 'secondary' || slot === 'pistol') return 'pistol';
  if (slot === 'knife' || slot === 'melee' || key === 'knife') return 'knife';
  if (slot === 'grenade' || slot === 'utility' || /grenade|flash|molotov|decoy|incgren/.test(key)) return 'nade';
  if (slot === 'c4' || key === 'c4') return 'c4';
  if (key === 'taser' || key === 'zeus') return 'pistol';
  return 'rifle';
}

// ---- animator ---------------------------------------------------------------------------------
export class Animator {
  constructor() {
    this.Qm = Array.from({ length: NBONES }, () => new THREE.Quaternion());
    this.Pm = BIND.map((p) => p.clone());
    this.rootPos = new THREE.Vector3();
    this.rootYaw = 0;          // lower-body world yaw (deg)
    this.aimYaw = 0; this.aimPitch = 0;
    this.phase = 0; this.spd = 0; this.moveX = 1; this.moveZ = 0;
    this.duck = 0; this.air = 0; this.wasGround = true; this.landV = 0; this.landX = 0; this.vy = 0;
    this.recoil = 0; this.reloadT = -1; this.reloadDur = 2.4; this.drawT = 1;
    this.kind = 'rifle'; this.prevKind = 'rifle'; this.kindBlend = 1;
    this.turnLift = 0; this.time = Math.random() * 10; this.init = false;
    this.plant = 0; this.pelvisDrop = 0;
    this.weaponPos = new THREE.Vector3(); this.weaponQuat = new THREE.Quaternion();
    this.holdPos = new THREE.Vector3(); this.holdQuat = new THREE.Quaternion();
    this.gaitBob = 0;
    this.heldButt = null; this.heldL = null; this.heldKind = null; this.blade = 0;
    this.footIK = true; this.gnd = { L: { dy: 0, n: new THREE.Vector3(0, 1, 0) }, R: { dy: 0, n: new THREE.Vector3(0, 1, 0) } };
    this._onGround = true;
    this.slash = 0; this.slashHeavy = false; this.slashSide = 1; this.pinT = 9; this.throwT = 9;
    this._lastVel = new THREE.Vector3();
  }

  /** Geometry of the held item (hold frame): butt x (rifles) and support-hand point. */
  setHeld(kind, butt, lGrip) {
    this.heldKind = kind;
    this.heldButt = Number.isFinite(butt) ? butt : null;
    this.heldL = lGrip ? lGrip.clone() : null;
    if (this.heldL && kind === 'rifle') this.heldL.x = Math.min(this.heldL.x, 10.8);
  }

  fire(e) {
    if (this.kind === 'knife' || e?.weapon === 'knife') { this.slash = 1; this.slashHeavy = !!e?.heavy; this.slashSide = -this.slashSide || 1; return; }
    this.recoil = Math.min(1.25, this.recoil + 0.75);
  }
  pin() { this.pinT = 0; }
  throwNade() { this.throwT = 0; }

  update(ent, dt) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const o = ent.renderOrigin || ent.origin;
    const vel = ent.velocity || _v[15].set(0, 0, 0);
    const onGround = ent.onGround !== false;
    this._onGround = onGround;
    const aimYaw = ent.yaw || 0, aimPitch = clamp(ent.pitch || 0, -89, 89);
    if (!this.init) {
      this.init = true; this.rootYaw = aimYaw; this.aimYaw = aimYaw; this.aimPitch = aimPitch;
    }
    this.rootPos.copy(o);
    this._lastVel.copy(vel);
    // aim smoothing (bots snap; keep it crisp but not jittery)
    this.aimYaw += angN(aimYaw - this.aimYaw) * damp(30, dt);
    this.aimPitch += (aimPitch - this.aimPitch) * damp(30, dt);

    // --- locomotion state
    const hs = Math.hypot(vel.x, vel.z);
    this.spd += (hs - this.spd) * damp(12, dt);
    const spd = this.spd;
    const m = smooth(6, 40, spd);
    const moveYaw = hs > 1 ? Math.atan2(-vel.z, vel.x) / DEG : this.aimYaw;
    const duckT = clamp(ent.duckAmount ?? (ent.ducking ? 1 : 0), 0, 1);
    this.duck += (duckT - this.duck) * damp(14, dt);
    const airT = onGround ? 0 : 1;
    this.air += (airT - this.air) * damp(onGround ? 18 : 10, dt);
    if (!onGround) this.vy = vel.y;
    if (onGround && !this.wasGround) this.landV -= clamp(-this.vy / 500, 0.15, 1.2) * 40;
    this.wasGround = onGround;
    // critically damped landing dip
    const k = 170, c = 2 * Math.sqrt(k);
    this.landV += (-k * this.landX - c * this.landV) * dt;
    this.landX += this.landV * dt;

    // --- lower body yaw
    let rel = angN(moveYaw - this.aimYaw);
    let lowerTarget;
    const back = Math.abs(rel) > 105;
    if (m > 0.05) {
      const r2 = back ? angN(rel + 180) : rel;
      lowerTarget = this.aimYaw + clamp(r2 * 0.75, -58, 58);
    } else {
      const d = angN(this.aimYaw - this.rootYaw);
      if (Math.abs(d) > 50) this.turning = true;
      if (this.turning && Math.abs(d) < 4) this.turning = false;
      lowerTarget = this.turning ? this.aimYaw : this.rootYaw;
      if (this.turning) this.turnLift = 0.3;
    }
    const dy = angN(lowerTarget - this.rootYaw);
    const rate = (m > 0.05 ? 300 : 260) * dt;
    this.rootYaw = angN(this.rootYaw + clamp(dy * damp(10, dt) * 1.0, -rate, rate));
    if (this.turnLift > 0) this.turnLift = Math.max(0, this.turnLift - dt);
    const ay = clamp(angN(this.aimYaw - this.rootYaw), -110, 110);
    // local move direction in the lower-body frame (x fwd, z right)
    const ry = this.rootYaw * DEG;
    const cr = Math.cos(ry), sr = Math.sin(ry);
    if (hs > 1) {
      const lx = vel.x * cr - vel.z * sr, lz = vel.x * sr + vel.z * cr;
      const l = Math.hypot(lx, lz);
      this.moveX = lx / l; this.moveZ = lz / l;
    }

    // --- stance / weapon kind
    const kind = ent.alive === false ? this.kind : holdKind(ent);
    if (kind !== this.kind) { this.prevKind = this.kind; this.kind = kind; this.kindBlend = 0; this.drawT = 0; }
    this.kindBlend = Math.min(1, this.kindBlend + dt * 5);
    this.drawT = Math.min(1, this.drawT + dt / Math.max(0.3, (ent.active?.def?.deployTime || 1) * 0.6));
    const reloading = !!(ent.active?.reloading);
    if (reloading && this.reloadT < 0) { this.reloadT = 0; this.reloadDur = ent.active?.def?.reloadTime || (kind === 'pistol' ? 2.2 : 2.5); }
    if (!reloading) this.reloadT = -1; else this.reloadT += dt;
    this.recoil *= Math.exp(-dt * 13);
    this.slash = Math.max(0, this.slash - dt / (this.slashHeavy ? 0.55 : 0.35));
    this.pinT += dt; this.throwT += dt;
    const planting = !!(ent.planting || ent.isPlanting || ent.defusing || ent.isDefusing);
    this.plant += ((planting ? 1 : 0) - this.plant) * damp(8, dt);

    // --- gait
    const runB = smooth(110, 230, spd);
    let freq = 0.85 + 0.0036 * spd;
    freq *= 1 - 0.1 * this.duck;
    const stance = 0.52 - 0.2 * smooth(40, 250, spd);
    if (m > 0.001 && this.air < 0.5) this.phase = frac(this.phase + freq * dt * (back ? 1 : 1));
    const D = spd / freq;
    const half = stance * D * 0.5;
    const liftH = (2.6 + 0.028 * spd) * (1 - 0.45 * this.duck);
    const Qm = this.Qm, Pm = this.Pm;

    // pelvis
    const standH = 37.4, duckH = 23.2;
    let pelvisY = standH + (duckH - standH) * this.duck;
    const bobA = (0.55 - 1.9 * runB) * m * (1 - 0.5 * this.duck);
    pelvisY += bobA * Math.cos(4 * Math.PI * (this.phase - stance / 2));
    pelvisY += this.landX * (1 - this.duck * 0.5);
    pelvisY -= this.plant * 4;
    pelvisY += this.air * 1.5;
    const breath = Math.sin(this.time * 1.7);
    const swing = Math.sin(2 * Math.PI * (this.phase + 0.25)) * m;
    const leanF = 4 * runB * m * (back ? -0.6 : 1) + 13 * this.duck + 6 * this.plant + this.air * 3;
    const sideLean = -this.moveZ * 3 * runB * m;
    const pelvisPos = _v[0].set(-0.2 - this.duck * 2.5, pelvisY, 0.6 * swing * (1 - runB) * m);
    // bladed stance: torso turned right so the support shoulder leads (rifles), head keeps the aim
    const bladeT = (BLADE[this.kind] ?? 0) * (1 - 0.45 * m) * (1 - this.plant);
    this.blade += (bladeT - this.blade) * damp(8, dt);
    const blade = this.blade;
    const hipYaw = swing * 7 * (1 - this.duck * 0.5) + blade * 0.35 * (1 - m);
    qYZ(Qm[BONE.pelvis], hipYaw, leanF * 0.6, sideLean + swing * 2.5 * (1 - runB));
    Pm[BONE.pelvis].copy(pelvisPos);

    // spine chain (twist toward the aim, pitch distribution, lean compensation)
    const p = this.aimPitch;
    const rec = this.recoil;
    const leanComp = leanF * 0.6;
    const spineYaw = [0.22, 0.26, 0.3];
    const bl = ay * 0.78 + blade - hipYaw - (ay * 0.78 - swing * 7);   // extra yaw the spine must add
    const spinePitch = [0.06, 0.1, 0.16];
    const brP = breath * 0.8;
    this._local(BONE.spine1, ay * spineYaw[0] - swing * 5.5 + bl * 0.28, p * spinePitch[0] + leanF * 0.25 + brP * 0.3, -sideLean * 0.5);
    this._local(BONE.spine2, ay * spineYaw[1] - swing * 1.5 + bl * 0.33, p * spinePitch[1] + leanF * 0.15 - brP * 0.2, -sideLean * 0.3);
    this._local(BONE.chest, ay * spineYaw[2] + bl * 0.39, p * spinePitch[2] - rec * 2.5 - brP * 0.4 - this.duck * 3, 0);
    const spineSumP = p * (spinePitch[0] + spinePitch[1] + spinePitch[2]) + leanF * 0.6 + leanF * 0.4 - rec * 2.5 - this.duck * 3;
    const headP = p - spineSumP;
    this._local(BONE.neck, ay * 0.12 - blade * 0.55, headP * 0.45, 0);
    this._local(BONE.head, ay * 0.1 - blade * 0.45, headP * 0.55 + rec * 1.5, 0);

    // weapon / held item placement
    this._placeHold(this.kind, ay, p, _v[1], _q[0], dt, ent);
    if (this.kindBlend < 1) {
      this._placeHold(this.prevKind, ay, p, _v[2], _q[1], dt, ent);
      const t = this.kindBlend * this.kindBlend * (3 - 2 * this.kindBlend);
      _v[1].lerpVectors(_v[2], _v[1], t);
      _q[1].slerp(_q[0], t); _q[0].copy(_q[1]);
    }
    this.weaponPos.copy(_v[1]); this.weaponQuat.copy(_q[0]);
    this._fitReach(this.kind);
    this._arms(this.kind, ay, p, dt);

    // legs
    this._legs(dt, m, stance, half, liftH, back, runB);
    return this;
  }

  // set local rotation of a spine-like bone and FK its model transform
  _local(b, yaw, pitchDown, roll) {
    const par = PARENT[b];
    qYZ(_q[2], yaw, pitchDown, roll);
    this.Qm[b].multiplyQuaternions(this.Qm[par], _q[2]);
    this.Pm[b].copy(REST_OFS[b]).applyQuaternion(this.Qm[par]).add(this.Pm[par]);
  }
  _fk(b) {
    const par = PARENT[b];
    this.Pm[b].copy(REST_OFS[b]).applyQuaternion(this.Qm[par]).add(this.Pm[par]);
  }

  _aimQuat(out, ay, p, k = 1) { return qYZ(out, ay, p * k); }

  _placeHold(kind, ay, p, outPos, outQuat, dt, ent) {
    const H = HOLDS[kind];
    const Qm = this.Qm, Pm = this.Pm;
    let pitch = p * (H.pitchK ?? 1);
    // draw: weapon comes up from low-ready
    const dr = 1 - this.drawT;
    pitch += dr * dr * 50;
    // reload cant / dip
    let roll = 0;
    if (this.reloadT >= 0) {
      const t = clamp(this.reloadT / this.reloadDur, 0, 1);
      const w = smooth(0, 0.12, t) * (1 - smooth(0.85, 1, t));
      roll = -24 * w; pitch += 12 * w;
    }
    let yawK = 0;
    const ofs = _v[4].copy(H.ofs);
    if (kind === 'knife' && this.slash > 0) {
      // slash: sweep across the body (alternating), heavy = forward stab
      const t = 1 - this.slash, e = Math.sin(Math.PI * Math.min(1, t * 1.25));
      if (this.slashHeavy) { ofs.x += 7 * e; ofs.y += 2 * e; pitch -= 10 * e; }
      else {
        const a = (t - 0.4) * 2.2 * this.slashSide;
        ofs.z = H.ofs.z * (1 - e) + -a * 7 * e; ofs.x += 4 * e; ofs.y += 3 * e - 5 * t * e;
        yawK = a * 35 * e; roll = -40 * e * this.slashSide;
      }
    } else if (kind === 'nade') {
      // wind-up after the pin is pulled, overhand throw on release
      const w = smooth(0, 0.35, this.pinT) * (this.throwT < this.pinT ? 0 : 1);
      ofs.x -= 5 * w; ofs.y += 2.5 * w; pitch -= 20 * w;
      if (this.throwT < 0.6) {
        const t = this.throwT / 0.6, e = Math.sin(Math.PI * Math.min(1, t * 1.6));
        ofs.x += 12 * e; ofs.y -= 5 * e * t; ofs.z -= 3 * e; pitch += 50 * e;
      }
    }
    qYZ(outQuat, ay + yawK, pitch, roll);
    // recoil kick: up + back
    if (this.recoil > 0.001) { _q[5].setFromAxisAngle(AZ, this.recoil * 5 * DEG); outQuat.multiply(_q[5]); }
    // anchor
    const anc = _v[3];
    if (H.anchor === 'shoulder') anc.set(5.4, 4.6, 4.3);
    else anc.set(2.6, 5.5, 0);
    anc.applyQuaternion(Qm[BONE.chest]).add(Pm[BONE.chest]);
    if (kind === 'rifle' && kind === this.heldKind && this.heldButt !== null) ofs.x = -this.heldButt + 0.4;
    ofs.x -= this.recoil * 1.6;
    // gait sway of the weapon
    const sway = Math.sin(this.phase * Math.PI * 4) * this.spd * 0.0035;
    ofs.y += sway - (1 - this.drawT) * 4;
    ofs.applyQuaternion(outQuat);
    outPos.copy(anc).add(ofs);
  }

  /** Slide a two-handed weapon back along its bore until the support hand can reach it. */
  _fitReach(kind) {
    const H = HOLDS[kind];
    if (!H.lGrip || kind === 'c4') return;
    const Qm = this.Qm, Pm = this.Pm;
    const lSrc = kind === 'rifle' && this.heldKind === 'rifle' && this.heldL ? this.heldL : H.lGrip;
    // left shoulder (FK through the clavicle at rest)
    const sh = _v[5].copy(REST_OFS[BONE.upperarm_L]).applyQuaternion(Qm[BONE.chest]).add(_v[6].copy(REST_OFS[BONE.clav_L]).applyQuaternion(Qm[BONE.chest]).add(Pm[BONE.chest]));
    const reach = (ARM.upper + ARM.fore) * 0.93 + 2.2;
    const fwd = _v[6].set(1, 0, 0).applyQuaternion(this.weaponQuat);
    for (let k = 0; k < 3; k++) {
      const t = _v[7].copy(lSrc).applyQuaternion(this.weaponQuat).add(this.weaponPos);
      const ex = t.distanceTo(sh) - reach;
      if (ex <= 0) break;
      this.weaponPos.addScaledVector(fwd, -Math.min(ex, 6));
    }
  }

  _arms(kind, ay, p, dt) {
    const H = HOLDS[kind];
    const Qm = this.Qm, Pm = this.Pm;
    const wq = this.weaponQuat, wp = this.weaponPos;
    // right hand on the grip
    const rG = _v[5].copy(H.rGrip).applyQuaternion(wq).add(wp);
    const rX = _v[6].copy(H.rFing).applyQuaternion(wq), rY = _v[7].copy(H.rThumb).applyQuaternion(wq);
    qFromXY(_q[3], rX, rY).multiply(HANDINV.R);           // hand model rotation
    // left hand
    const lG = _v[8];
    const lSrc = kind === 'rifle' && this.heldKind === 'rifle' && this.heldL ? this.heldL : H.lGrip;
    if (H.lGrip) lG.copy(lSrc).applyQuaternion(wq).add(wp);
    else { lG.copy(H.lFree); _q[5].setFromAxisAngle(AY, ay * DEG); lG.applyQuaternion(_q[5]).applyQuaternion(Qm[BONE.pelvis]); lG.add(Pm[BONE.chest]); }
    const lX = _v[9].copy(H.lFing), lY = _v[10].copy(H.lThumb);
    if (H.lGrip) { lX.applyQuaternion(wq); lY.applyQuaternion(wq); }
    else { _q[5].setFromAxisAngle(AY, ay * DEG); lX.applyQuaternion(_q[5]); lY.applyQuaternion(_q[5]); }
    // reload: left hand visits the magazine, the vest pouch, and back
    if (this.reloadT >= 0 && H.lGrip && kind !== 'c4') {
      const t = clamp(this.reloadT / this.reloadDur, 0, 1);
      const mag = _v[11].set(kind === 'pistol' ? -0.6 : 3.2, kind === 'pistol' ? -4.5 : -3.6, -1.2).applyQuaternion(wq).add(wp);
      const pouch = _v[12].set(6.5, -4.5, -3.5).applyQuaternion(Qm[BONE.chest]).add(Pm[BONE.chest]);
      let tgt = null, w = 0;
      if (t < 0.18) { w = smooth(0, 0.18, t); tgt = mag; }
      else if (t < 0.32) { w = 1; tgt = _v[13].lerpVectors(mag, pouch, smooth(0.18, 0.32, t)); tgt.y -= Math.sin(smooth(0.18, 0.32, t) * Math.PI) * 5; }
      else if (t < 0.5) { w = 1; tgt = _v[13].lerpVectors(pouch, mag, smooth(0.36, 0.5, t)); }
      else if (t < 0.7) { w = 1; tgt = _v[13].copy(mag); tgt.addScaledVector(rY, Math.sin(smooth(0.5, 0.7, t) * Math.PI) * 1.2); }
      else { w = 1 - smooth(0.7, 0.9, t); tgt = mag; }
      if (tgt) lG.lerp(tgt, w);
    }
    qFromXY(_q[4], lX, lY).multiply(HANDINV.L);
    // clavicles shrug toward the targets
    this._clav('R', rG);
    this._clav('L', lG);
    // IK
    this._armIK('R', rG, _q[3], _v[14].copy(H.poleR).applyQuaternion(qYZ(_q[5], ay, 0)));
    this._armIK('L', lG, _q[4], _v[14].copy(H.poleL).applyQuaternion(qYZ(_q[5], ay, 0)));
    this.holdQuat.copy(_q[3]);
  }

  _clav(side, target) {
    const b = BONE['clav_' + side], Qm = this.Qm, Pm = this.Pm;
    const s = side === 'L' ? -1 : 1;
    const ch = Qm[BONE.chest];
    // target in chest-local frame
    const t = _v[11].copy(target).sub(Pm[BONE.chest]).applyQuaternion(_q[6].copy(ch).invert());
    const elev = clamp((t.y - 5) / 32, -0.1, 0.3);
    const prot = clamp((t.x - 10) / 60, -0.05, 0.15);
    _q[2].setFromAxisAngle(AY, prot * s);
    _q[5].setFromAxisAngle(AX, -elev * s);
    _q[2].multiply(_q[5]);
    Qm[b].multiplyQuaternions(ch, _q[2]);
    this._fk(b);
  }

  _armIK(side, grip, handQ, pole) {
    const Qm = this.Qm, Pm = this.Pm;
    const L = side === 'L' ? LIMB.armL : LIMB.armR;
    const HB = side === 'L' ? HAND_L : HAND_R;
    const up = BONE['upperarm_' + side], fo = BONE['forearm_' + side], ha = BONE['hand_' + side];
    this._fk(up);
    // wrist target = grip - handQ * gripOffset
    const W = _v[12].copy(HB.grip).applyQuaternion(handQ).negate().add(grip);
    this._twoBone(up, fo, L, Pm[up], W, pole);
    Qm[ha].copy(handQ);
    this._fk(ha);
  }

  /** Two-bone IK. Writes Qm/Pm for bones a (root) and b (mid). */
  _twoBone(a, b, L, S, W, pole) {
    const Qm = this.Qm, Pm = this.Pm;
    const [d0, pp, E, Wc, e1, e2, n] = _ik;
    d0.subVectors(W, S);
    let d = d0.length();
    const maxD = (L.l1 + L.l2) * 0.999, minD = Math.abs(L.l1 - L.l2) + 0.5;
    d = clamp(d, minD, maxD);
    const u = d0.normalize();
    const ca = clamp((L.l1 * L.l1 + d * d - L.l2 * L.l2) / (2 * L.l1 * d), -1, 1);
    const sa = Math.sqrt(1 - ca * ca);
    pp.copy(pole).addScaledVector(u, -pole.dot(u));
    if (pp.lengthSq() < 1e-6) pp.set(0, -1, 0).addScaledVector(u, u.y);
    pp.normalize();
    // elbow / knee
    E.copy(S).addScaledVector(u, L.l1 * ca).addScaledVector(pp, L.l1 * sa);
    Wc.copy(S).addScaledVector(u, d);
    e1.subVectors(E, S).normalize();
    e2.subVectors(Wc, E).normalize();
    // hinge axis: (e1 x e2), falls back to (pp x u) when straight
    n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-5) n.crossVectors(pp, u);
    n.normalize();
    qFromXY(Qm[a], e1, n).multiply(L.inv1);
    qFromXY(Qm[b], e2, n).multiply(L.inv2);
    Pm[b].copy(E);
  }

  _legs(dt, m, stance, half, liftH, back, runB) {
    const Qm = this.Qm, Pm = this.Pm;
    const duck = this.duck, air = this.air;
    let maxDrop = 0;
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? -1 : 1;
      const ph = frac(this.phase + (side === 'L' ? 0 : 0.5));
      // idle stance (rifle: left foot forward), crouch stance
      const idleX = side === 'L' ? 2.4 + duck * 2.6 : -2.6 - duck * 2.2;
      const idleZ = s * (5.4 - duck * 0.7);
      const idleYaw = side === 'L' ? 10 : -22 + duck * 8;
      // gait
      let along, lift = 0, heelUp = 0, toeUp = 0;
      if (ph < stance) {
        const t = ph / stance;
        along = half * (1 - 2 * t);
        toeUp = (1 - smooth(0, 0.18, t)) * 14 * (1 - runB * 0.6);
        heelUp = smooth(0.62, 1, t) * (25 + 15 * runB);
      } else {
        const t = (ph - stance) / (1 - stance);
        const e = t * t * (3 - 2 * t);
        along = -half + 2 * half * e;
        lift = liftH * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.9);
        heelUp = (1 - smooth(0, 0.55, t)) * (40 + 20 * runB);
        toeUp = smooth(0.6, 1, t) * 16;
        if (runB > 0) along -= Math.sin(Math.PI * t) * 3.5 * runB; // heel kick
      }
      if (back) { const tmp = toeUp; toeUp = heelUp * 0.4; heelUp = tmp; }
      const gx = this.moveX * along, gz = this.moveZ * along + s * 4.3;
      const w = m;
      let fx = idleX + (gx - idleX) * w, fz = idleZ + (gz - idleZ) * w;
      let fy = lift * w;
      let fyaw = idleYaw * (1 - w) + s * -6 * w;
      heelUp *= w; toeUp *= w;
      if (side === 'R') heelUp += duck * 38 * (1 - w);        // crouch: back foot up on the toes
      // shuffle while turning in place
      if (this.turnLift > 0 && w < 0.5) fy += Math.max(0, Math.sin((this.turnLift / 0.35) * Math.PI * 2 * (side === 'L' ? 1 : -1))) * 2.5;
      // airborne tuck
      if (air > 0.01) {
        fx += (side === 'L' ? 3.5 : -4.5 - fx) * air * 0.6;
        fy += (side === 'L' ? 11 : 8) * air;
        heelUp += 25 * air;
      }
      // planting bomb: kneel on the right knee
      if (this.plant > 0.01 && side === 'R') { fx += (-6 - fx) * this.plant; heelUp += 45 * this.plant; }
      // ground under the foot (stairs / ramps)
      const gr = this._ground(side, fx, fz, dt);
      fy += gr.dy;
      // foot rotation: yaw then pitch, then tilt onto the ground normal
      const pitch = toeUp - heelUp;
      qYZ(Qm[BONE['foot_' + side]], fyaw, -pitch);
      if (gr.n.y < 0.999) { _qt.setFromUnitVectors(AY, gr.n); Qm[BONE['foot_' + side]].premultiply(_qt); }
      this['_tilt' + side] = gr.n.y < 0.999;
      // ankle position from the planted pivot (ball when heel-up, heel when toe-up)
      const ank = _v[5].set(fx, ANKLE_H + fy, fz);
      if (heelUp > toeUp) {
        const ball = _v[6].copy(TOE_OFS[side]); ball.y = 0;
        qYZ(_q[5], fyaw, 0); ball.applyQuaternion(_q[5]).add(ank); // ball position (flat)
        ball.y += (gr.n.y < 0.999 ? -(gr.n.x * (ball.x - fx) + gr.n.z * (ball.z - fz)) / gr.n.y : 0);
        const r = _v[7].copy(TOE_OFS[side]).applyQuaternion(Qm[BONE['foot_' + side]]);
        ank.copy(ball).sub(r);
        ank.y += TOE_OFS[side].y;
      } else if (toeUp > 0) {
        const heel = _v[6].set(-2.8, -ANKLE_H + 0.4, 0);
        qYZ(_q[5], fyaw, 0);
        const h0 = _v[7].copy(heel).applyQuaternion(_q[5]).add(ank);
        const r = _v[4].copy(heel).applyQuaternion(Qm[BONE['foot_' + side]]);
        ank.copy(h0).sub(r);
      }
      // hip position from pelvis FK
      const th = BONE['thigh_' + side];
      this._fk(th);
      const hip = Pm[th];
      const L = side === 'L' ? LIMB.legL : LIMB.legR;
      const reach = (L.l1 + L.l2) * 0.985;
      const dx = ank.x - hip.x, dz = ank.z - hip.z;
      const hmax = Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz));
      const drop = hip.y - ank.y - hmax;
      if (drop > maxDrop) maxDrop = drop;
      (side === 'L' ? this._ankL || (this._ankL = new THREE.Vector3()) : this._ankR || (this._ankR = new THREE.Vector3())).copy(ank);
      this['_yaw' + side] = fyaw;
    }
    // lower the pelvis if a leg can't reach (prevents hyper-extension pops)
    const dropT = maxDrop > 0 ? maxDrop : 0;
    this.pelvisDrop += (-dropT - this.pelvisDrop) * damp(25, dt);
    if (maxDrop > 0) {
      Pm[BONE.pelvis].y -= maxDrop;
      for (const b of [BONE.spine1, BONE.spine2, BONE.chest, BONE.neck, BONE.head, BONE.clav_L, BONE.clav_R,
        BONE.upperarm_L, BONE.upperarm_R, BONE.forearm_L, BONE.forearm_R, BONE.hand_L, BONE.hand_R]) Pm[b].y -= maxDrop;
      this.weaponPos.y -= maxDrop;
    }
    for (const side of ['L', 'R']) {
      const th = BONE['thigh_' + side], ca = BONE['calf_' + side], ft = BONE['foot_' + side], to = BONE['toe_' + side];
      this._fk(th);
      const L = side === 'L' ? LIMB.legL : LIMB.legR;
      const yaw = this['_yaw' + side] * DEG;
      const pole = _v[3].set(Math.cos(yaw), 0, -Math.sin(yaw)).addScaledVector(AZ, side === 'L' ? -0.15 : 0.15);
      if (this.plant > 0.01 && side === 'R') pole.y -= this.plant * 0.8;
      this._twoBone(th, ca, L, Pm[th], side === 'L' ? this._ankL : this._ankR, pole);
      this._fk(ft);
      // toes stay flat on the ground when the heel is up
      qYZ(Qm[to], this['_yaw' + side], 0);
      if (this['_tilt' + side]) { _qt.setFromUnitVectors(AY, this.gnd[side].n); Qm[to].premultiply(_qt); }
      this._fk(to);
    }
  }

  /** Ground under a model-space foot position: smoothed height offset + normal (model space). */
  _ground(side, fx, fz, dt) {
    const g = this.gnd[side];
    const col = World.collision;
    let dy = 0;
    const n = _v[2].set(0, 1, 0);
    if (this.footIK && col?.rayTrace && this._onGround && this.air < 0.3) {
      const ry = this.rootYaw * DEG, c = Math.cos(ry), sn = Math.sin(ry);
      const wx = this.rootPos.x + fx * c + fz * sn, wz = this.rootPos.z - fx * sn + fz * c;
      _gs.set(wx, this.rootPos.y + 20, wz); _ge.set(wx, this.rootPos.y - 26, wz);
      const tr = col.rayTrace(_gs, _ge, 1);
      if (tr.fraction < 1 && !tr.startSolid && tr.normal.y > 0.55) {
        dy = clamp(tr.endpos.y - this.rootPos.y, -20, 18);
        // world normal -> model space
        n.set(tr.normal.x * c - tr.normal.z * sn, tr.normal.y, tr.normal.x * sn + tr.normal.z * c);
      }
    }
    const k = damp(18, dt);
    g.dy += (dy - g.dy) * k;
    g.n.lerp(n, k).normalize();
    return g;
  }

  /** Write the pose into THREE.Bone objects (local transforms). */
  apply(bones) {
    const Qm = this.Qm, Pm = this.Pm;
    bones[0].position.copy(Pm[0]);
    bones[0].quaternion.copy(Qm[0]);
    for (let i = 1; i < NBONES; i++) {
      const par = PARENT[i];
      bones[i].quaternion.copy(Qm[par]).invert().multiply(Qm[i]);
      // positions stay at rest offsets except where IK stretched nothing (lengths preserved)
    }
  }
}
