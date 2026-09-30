// Procedural agent bodies + gear. All geometry is authored in the bind pose (skeleton.js):
// facing +X, right = +Z, arms in an A-pose. One MeshBuilder per team/LOD -> one skinned mesh.
import * as THREE from 'three';
import { MeshBuilder, chainWeights, smooth, normSkin } from './builder.js';
import { BONE, ARM_L, ARM_R, LEG_L, LEG_R, GRIP_LOCAL, handBindFrame } from './skeleton.js';
import * as PT from './paint.js';
import { STYLE } from './styles.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const Y = V(0, 1, 0), X = V(1, 0, 0), Z = V(0, 0, 1);
const Q = (ax, ay, az) => new THREE.Quaternion().setFromEuler(new THREE.Euler(ax, ay, az, 'YXZ'));
const QID = new THREE.Quaternion();
const rigid = (name) => [[BONE[name], 1]];

/** Vertical-axis ring (t = +Y, f = +X, "left" = -Z). */
function vr(y, rf, rb, rs, n = 2, o = {}) {
  return { c: V(o.cx ?? 0, y, o.cz ?? 0), t: Y, f: X, rf, rb, rl: o.rl ?? rs, rr: o.rr ?? rs, n, bump: o.bump };
}
/** Limb ring around point c with axis t; front reference = +X projected. rs = [inner, outer]. */
function lr(c, t, rf, rb, rIn, rOut, side, n = 2, o = {}) {
  // l = t x f. For downward limbs l points to +Z (character right).
  const f = o.f || X;
  const tt = t.clone().normalize();
  const l = new THREE.Vector3().crossVectors(tt, f.clone().addScaledVector(tt, -f.dot(tt)).normalize());
  const lIsRight = l.z > 0;
  const outerIsRight = side === 'R';
  const rl = lIsRight === outerIsRight ? rOut : rIn;
  const rr = lIsRight === outerIsRight ? rIn : rOut;
  return { c: c.clone(), t: tt, f, rf, rb, rl, rr, n, bump: o.bump };
}

function yChain(y, bones, cuts, bw) {
  let res = [[bones[0], 1]];
  for (let k = 0; k < cuts.length; k++) {
    const t = smooth(cuts[k] - bw, cuts[k] + bw, y);
    if (t <= 0) break;
    res = res.map(([b, w]) => [b, w * (1 - t)]);
    res.push([bones[k + 1], t]);
  }
  return res;
}

// torso skinning: vertical spine chain + clavicle / upper-arm blend around the shoulders
function torsoSkin(p) {
  let w = yChain(p.y, [BONE.pelvis, BONE.spine1, BONE.spine2, BONE.chest], [41.0, 45.0, 49.2], 1.8);
  const az = Math.abs(p.z);
  const side = p.z < 0 ? 'L' : 'R';
  const wc = smooth(4.2, 7.0, az) * smooth(51.5, 55.5, p.y);
  if (wc > 0) {
    const wa = smooth(6.6, 8.6, az) * smooth(58.5, 55, p.y) * 0.35;
    w = w.map(([b, x]) => [b, x * (1 - wc)]);
    w.push([BONE['clav_' + side], wc * (1 - wa)], [BONE['upperarm_' + side], wc * wa]);
  }
  // front of the neck opening follows the neck a little
  const wn = smooth(58.4, 60.4, p.y) * 0.5;
  if (wn > 0) { w = w.map(([b, x]) => [b, x * (1 - wn)]); w.push([BONE.neck, wn]); }
  return w;
}
function hipsSkin(p) {
  let w = yChain(p.y, [BONE.pelvis, BONE.spine1], [41.5], 1.5);
  const az = Math.abs(p.z);
  const wt = smooth(37.5, 31, p.y) * smooth(1.2, 4.5, az) * 0.75;
  if (wt > 0) { w = w.map(([b, x]) => [b, x * (1 - wt)]); w.push([BONE[p.z < 0 ? 'thigh_L' : 'thigh_R'], wt]); }
  return w;
}

function armJoints(side) {
  const A = side === 'L' ? ARM_L : ARM_R;
  const s = side === 'L' ? -1 : 1;
  const inner = A.sh.clone().addScaledVector(A.dU, -2.4).add(V(0, 0.3, -1.2 * s));
  return { ...A, inner };
}
function armSkin(side) {
  const A = armJoints(side);
  return chainWeights([A.inner, A.sh, A.el, A.wr], [BONE['clav_' + side], BONE['upperarm_' + side], BONE['forearm_' + side], BONE['hand_' + side]], [1.3, 1.9, 1.3]);
}
function legSkin(side) {
  const L = side === 'L' ? LEG_L : LEG_R;
  const top = L.hip.clone().add(V(0, 4, 0));
  const ch = chainWeights([top, L.hip, L.knee, L.ankle], [BONE.pelvis, BONE['thigh_' + side], BONE['calf_' + side], BONE['foot_' + side]], [1.6, 2.2, 1.2]);
  return ch;
}

// point along an arm: which = 'u' (from shoulder along dU) or 'f' (from elbow along dF)
function armPt(side, which, d) {
  const A = side === 'L' ? ARM_L : ARM_R;
  return which === 'u' ? A.sh.clone().addScaledVector(A.dU, d) : A.el.clone().addScaledVector(A.dF, d);
}
function legPt(side, which, t) {
  const L = side === 'L' ? LEG_L : LEG_R;
  return which === 't' ? L.hip.clone().lerp(L.knee, t) : L.knee.clone().lerp(L.ankle, t);
}

// ---- body pieces ---------------------------------------------------------------------------
function buildHips(mb, S, R) {
  mb.part('hips', S.pants, { group: 'core', data: { kind: 'hips' } });
  const rings = [
    vr(31.9, 1.4, 1.8, 2.2),
    vr(33.0, 3.7, 4.2, 4.9, 2.2),
    vr(34.8, 5.0, 5.6, 7.2, 2.3),
    vr(37.8, 4.95, 5.45, 7.45, 2.4),
    vr(40.6, 4.6, 4.9, 7.1, 2.4),
    vr(42.4, 4.4, 4.6, 6.8, 2.4),
  ];
  mb.loft(rings, R.torsoU, hipsSkin, { sub: R.sub });
}

function buildTorso(mb, S, R) {
  mb.part('shirt', S.shirt, { group: 'core', data: { kind: 'torso' } });
  const rings = [
    vr(39.2, 4.5, 4.8, 6.95, 2.4),
    vr(43.0, 4.25, 4.45, 6.55, 2.4),
    vr(47.0, 4.75, 4.6, 6.8, 2.5),
    vr(51.0, 5.25, 4.95, 7.35, 2.6),
    vr(54.4, 5.0, 4.9, 7.8, 2.9),
    vr(56.9, 4.1, 4.4, 7.7, 3.4),
    vr(58.7, 3.0, 3.4, 5.6, 2.8),
    vr(60.0, 2.45, 2.6, 3.1, 2),
    vr(60.7, 1.2, 1.3, 1.4, 2),
  ];
  mb.loft(rings, R.torsoU, torsoSkin, { sub: R.sub });
}

function buildNeck(mb, S, R) {
  mb.part('neck', S.neck, { group: 'head', data: { texScale: 1.3 } });
  const skin = (p) => yChain(p.y, [BONE.chest, BONE.neck, BONE.head], [59.4, 62.4], 1.1);
  const rings = [
    vr(57.4, 2.5, 2.7, 2.8, 2, { cx: 0.1 }),
    vr(59.6, 2.35, 2.55, 2.6, 2, { cx: 0.35 }),
    vr(61.6, 2.3, 2.55, 2.55, 2, { cx: 0.7 }),
    vr(63.2, 2.2, 2.4, 2.4, 2, { cx: 0.95 }),
  ];
  mb.loft(rings, R.limbU, skin, { sub: R.sub });
}

// head: loft of face-aware rings; nose / brow / eye-socket bumps
export const HEAD_C = V(1.15, 66.4, 0);
function headBump(th, r) {
  // th: 0 front, +pi/2 left(-Z)
  const y = r.c.y;
  const a = Math.atan2(Math.sin(th), Math.cos(th));
  let b = 0;
  // nose
  b += 0.95 * Math.exp(-((a / 0.2) ** 2)) * Math.exp(-(((y - 65.6) / 0.95) ** 2));
  // brow ridge
  b += 0.22 * Math.exp(-((a / 0.75) ** 2)) * Math.exp(-(((y - 67.55) / 0.4) ** 2));
  // eye sockets
  b -= 0.32 * (Math.exp(-(((a - 0.5) / 0.22) ** 2)) + Math.exp(-(((a + 0.5) / 0.22) ** 2))) * Math.exp(-(((y - 66.75) / 0.45) ** 2));
  // cheekbones
  b += 0.18 * (Math.exp(-(((Math.abs(a) - 0.95) / 0.3) ** 2))) * Math.exp(-(((y - 65.6) / 0.6) ** 2));
  // chin
  b += 0.2 * Math.exp(-((a / 0.4) ** 2)) * Math.exp(-(((y - 62.6) / 0.5) ** 2));
  // ears
  b += 0.35 * (Math.exp(-(((Math.abs(a) - 1.62) / 0.16) ** 2))) * Math.exp(-(((y - 66.0) / 1.0) ** 2));
  return b;
}
function buildHead(mb, S, R) {
  mb.part('head', S.head, { group: 'head', data: { kind: 'head', texScale: 1.7 } });
  const skin = (p) => yChain(p.y, [BONE.neck, BONE.head], [62.2], 0.9);
  const H = (y, cx, rf, rb, rs, n = 2) => vr(y, rf, rb, rs, n, { cx, bump: headBump });
  const rings = [
    H(60.9, 0.55, 2.2, 2.45, 2.3),
    H(62.2, 1.35, 2.75, 2.75, 2.75),
    H(63.4, 1.35, 3.45, 3.3, 3.15),
    H(64.8, 1.2, 3.85, 3.75, 3.35),
    H(66.3, 1.1, 4.0, 3.95, 3.45, 2.1),
    H(67.6, 1.0, 4.05, 4.05, 3.45, 2.1),
    H(69.0, 0.9, 3.7, 3.95, 3.3),
    H(70.3, 0.8, 2.85, 3.15, 2.55),
    H(71.2, 0.8, 1.5, 1.7, 1.35),
    H(71.5, 0.8, 0.05, 0.05, 0.05),
  ];
  mb.loft(rings, R.headU, skin, { sub: R.headSub, seam: Math.PI });
}

function buildArm(mb, S, R, side) {
  const A = armJoints(side);
  const sk = armSkin(side);
  const up = A.dU, fo = A.dF;
  const elT = up.clone().add(fo).normalize();
  const ring = (c, t, rf, rb, ri, ro, n) => lr(c, t, rf, rb, ri, ro, side, n);
  const sleeve = S.sleeve;
  const g = side === 'L' ? 'armL' : 'armR';
  if (sleeve === 'rolled') {
    // T: short rolled sleeve, bare forearm
    mb.part('sleeve_' + side, S.shirt, { group: g, data: { kind: 'sleeve' } });
    mb.loft([
      ring(A.inner, up, 2.6, 2.6, 2.6, 2.6),
      ring(armPt(side, 'u', -0.9), up, 3.45, 3.45, 3.2, 3.5),
      ring(armPt(side, 'u', 1.6), up, 3.55, 3.5, 3.3, 3.55),
      ring(armPt(side, 'u', 4.5), up, 3.25, 3.2, 3.1, 3.3),
      ring(armPt(side, 'u', 6.6), up, 3.1, 3.05, 3.0, 3.1),
      ring(armPt(side, 'u', 7.1), up, 3.45, 3.4, 3.35, 3.45), // rolled cuff
      ring(armPt(side, 'u', 8.3), up, 3.45, 3.4, 3.35, 3.45),
      ring(armPt(side, 'u', 8.8), up, 3.0, 2.95, 2.9, 3.0),
      ring(armPt(side, 'u', 8.4), up, 2.5, 2.5, 2.5, 2.5),
    ], R.limbU, sk, { sub: R.sub, seam: -Math.PI / 2 });
    mb.part('forearm_' + side, S.skin, { group: g, data: { kind: 'arm' } });
    mb.loft([
      ring(armPt(side, 'u', 5.5), up, 2.3, 2.3, 2.2, 2.3),
      ring(armPt(side, 'u', 8.5), up, 2.15, 2.1, 2.0, 2.1),
      ring(armPt(side, 'u', 11.0), up, 1.9, 1.95, 1.8, 1.9),
      ring(A.el, elT, 1.8, 1.95, 1.75, 1.85),
      ring(armPt(side, 'f', 1.8), fo, 2.0, 1.85, 1.85, 2.1),
      ring(armPt(side, 'f', 4.5), fo, 1.85, 1.65, 1.7, 1.95),
      ring(armPt(side, 'f', 7.5), fo, 1.5, 1.35, 1.4, 1.55),
      ring(A.wr, fo, 1.2, 1.15, 1.1, 1.25),
      ring(armPt(side, 'f', 11.4), fo, 1.1, 1.05, 1.0, 1.15),
    ], R.limbU, sk, { sub: R.sub, seam: -Math.PI / 2 });
  } else {
    mb.part('sleeve_' + side, S.shirt, { group: g, data: { kind: 'sleeve', full: true } });
    mb.loft([
      ring(A.inner, up, 2.6, 2.6, 2.6, 2.6),
      ring(armPt(side, 'u', -0.9), up, 3.2, 3.2, 3.0, 3.3),
      ring(armPt(side, 'u', 1.6), up, 3.25, 3.2, 3.05, 3.3),
      ring(armPt(side, 'u', 4.5), up, 2.95, 2.9, 2.8, 3.0),
      ring(armPt(side, 'u', 8.0), up, 2.7, 2.65, 2.55, 2.7),
      ring(armPt(side, 'u', 11.0), up, 2.35, 2.4, 2.25, 2.35),
      ring(A.el, elT, 2.25, 2.45, 2.2, 2.3),
      ring(armPt(side, 'f', 1.8), fo, 2.4, 2.25, 2.25, 2.45),
      ring(armPt(side, 'f', 4.5), fo, 2.25, 2.1, 2.1, 2.3),
      ring(armPt(side, 'f', 7.5), fo, 1.9, 1.8, 1.8, 1.95),
      ring(armPt(side, 'f', 9.6), fo, 1.65, 1.6, 1.55, 1.7),
      ring(armPt(side, 'f', 10.4), fo, 1.6, 1.6, 1.6, 1.6),
    ], R.limbU, sk, { sub: R.sub, seam: -Math.PI / 2 });
  }
}

function buildLeg(mb, S, R, side) {
  const L = side === 'L' ? LEG_L : LEG_R;
  const sk = legSkin(side);
  const th = L.knee.clone().sub(L.hip).normalize(), ca = L.ankle.clone().sub(L.knee).normalize();
  const kn = th.clone().add(ca).normalize();
  const ring = (c, t, rf, rb, ri, ro, n = 2.1) => lr(c, t, rf, rb, ri, ro, side, n);
  const g = side === 'L' ? 'legL' : 'legR';
  const top = L.hip.clone().add(V(0, 2.6, side === 'L' ? 0.8 : -0.8));
  const bag = S.pantsBag ?? 0.25;
  mb.part('leg_' + side, S.pants, { group: g, data: { kind: 'leg', side } });
  mb.loft([
    ring(top, th, 3.9, 4.1, 3.5, 4.1),
    ring(L.hip, th, 4.3 + bag, 4.6 + bag, 3.55 + bag, 4.45 + bag),
    ring(legPt(side, 't', 0.3), th, 4.0 + bag, 4.2 + bag, 3.35 + bag, 4.1 + bag),
    ring(legPt(side, 't', 0.62), th, 3.5 + bag, 3.55 + bag, 3.0 + bag, 3.55 + bag),
    ring(legPt(side, 't', 0.86), th, 3.05 + bag, 3.0 + bag, 2.8 + bag, 3.05 + bag),
    ring(L.knee, kn, 3.05 + bag, 2.8 + bag, 2.7 + bag, 2.9 + bag),
    ring(legPt(side, 'c', 0.14), ca, 2.95 + bag * 0.8, 3.1 + bag * 0.8, 2.7 + bag * 0.8, 2.85 + bag * 0.8),
    ring(legPt(side, 'c', 0.38), ca, 2.75 + bag * 0.7, 3.25 + bag * 0.7, 2.6 + bag * 0.7, 2.75 + bag * 0.7),
    ring(legPt(side, 'c', 0.62), ca, 2.55 + bag * 0.7, 2.75 + bag * 0.7, 2.45 + bag * 0.7, 2.55 + bag * 0.7),
    ring(legPt(side, 'c', 0.76), ca, 2.75 + bag * 0.8, 2.9 + bag * 0.8, 2.7 + bag * 0.8, 2.8 + bag * 0.8),
    ring(legPt(side, 'c', 0.84), ca, 2.35, 2.45, 2.3, 2.35),
    ring(legPt(side, 'c', 0.9), ca, 1.9, 2.0, 1.9, 1.9),
  ], R.limbU, sk, { sub: R.sub, seam: side === 'L' ? -Math.PI / 2 : Math.PI / 2 });
}

function buildBoot(mb, S, R, side) {
  const L = side === 'L' ? LEG_L : LEG_R;
  const s = side === 'L' ? -1 : 1;
  const a = L.ankle;
  const fwd = V(L.toe.x - a.x, 0, L.toe.z - a.z).normalize();
  const g = side === 'L' ? 'legL' : 'legR';
  const shaftSkin = (p) => {
    const t = smooth(5.2, 8.6, p.y);
    return [[BONE['foot_' + side], 1 - t], [BONE['calf_' + side], t]];
  };
  mb.part('boot_' + side, S.boot, { group: g, data: { kind: 'boot' } });
  // shaft around the ankle
  const sr = (y, rf, rb, rs, n = 2.2) => ({ c: V(a.x + 0.1, y, a.z), t: Y, f: fwd, rf, rb, rl: rs, rr: rs, n });
  mb.loft([
    sr(2.2, 2.3, 2.75, 2.25), sr(4.5, 2.45, 2.7, 2.3), sr(7.0, 2.45, 2.55, 2.4),
    sr(8.8, 2.6, 2.7, 2.55), sr(9.5, 2.7, 2.8, 2.65), sr(9.9, 2.2, 2.3, 2.1), sr(9.6, 1.8, 1.8, 1.8),
  ], R.limbU, shaftSkin, { sub: R.subLow, seam: Math.PI });
  // foot: loft along the foot axis, cross-section "front" = up
  const toeSkin = (p) => {
    const d = (p.x - a.x) * fwd.x + (p.z - a.z) * fwd.z;
    const t = smooth(4.2, 6.4, d);
    return [[BONE['foot_' + side], 1 - t], [BONE['toe_' + side], t]];
  };
  const up = Y;
  const fr = (d, cy, rUp, rDn, hw, n = 2.6) => {
    const c = V(a.x + fwd.x * d, cy, a.z + fwd.z * d);
    return { c, t: fwd, f: up, rf: rUp, rb: rDn, rl: hw, rr: hw, n };
  };
  mb.loft([
    fr(-3.25, 2.4, 0.05, 0.05, 0.1),
    fr(-3.1, 2.5, 1.3, 1.2, 1.2, 2.4),
    fr(-2.4, 2.75, 2.3, 1.65, 1.9),
    fr(-0.6, 2.95, 2.5, 1.9, 2.1),
    fr(1.9, 2.45, 1.95, 1.4, 2.15, 2.8),
    fr(4.4, 2.1, 1.35, 1.05, 2.2, 3.0),
    fr(6.6, 1.95, 1.15, 0.95, 2.0, 3.0),
    fr(7.9, 1.85, 0.85, 0.85, 1.55, 2.6),
    fr(8.55, 1.8, 0.3, 0.35, 0.65, 2.2),
    fr(8.7, 1.8, 0.02, 0.02, 0.05),
  ], R.limbU, toeSkin, { sub: R.subLow, seam: Math.PI });
  // sole (rubber): flat loft following the foot outline, rounded toe and heel
  mb.part('sole_' + side, S.sole, { group: g, data: { kind: 'sole' } });
  const sr2 = (d, hw, h = 0.55, n = 6) => ({ c: V(a.x + fwd.x * d, h, a.z + fwd.z * d), t: fwd, f: up, rf: h, rb: h, rl: hw, rr: hw, n });
  mb.loft([
    sr2(-3.45, 0.2, 0.45), sr2(-3.35, 1.3), sr2(-2.6, 1.95), sr2(-0.6, 2.1), sr2(1.9, 2.1), sr2(4.4, 2.3),
    sr2(6.6, 2.15), sr2(7.9, 1.75), sr2(8.75, 1.0, 0.5), sr2(9.0, 0.2, 0.4),
  ], R.limbU, toeSkin, { sub: R.subLow, seam: Math.PI });
}

// Gloved fist in hand-local space (see skeleton.js GRIP_LOCAL / handBindFrame).
function buildHand(mb, S, R, side) {
  const A = side === 'L' ? ARM_L : ARM_R;
  const { xh, yh, M, mirror } = handBindFrame(side);
  const toBind = (p) => {
    const q = V(p.x, p.y, p.z * mirror).applyMatrix4(M);
    return q.add(A.wr);
  };
  const g = side === 'L' ? 'armL' : 'armR';
  const hs = rigid('hand_' + side);
  const cuffSkin = (p) => {
    const d = p.clone().sub(A.wr).dot(xh);
    const t = smooth(-1.2, 0.3, d);
    return [[BONE['forearm_' + side], 1 - t], [BONE['hand_' + side], t]];
  };
  mb.part('glove_' + side, S.glove, { group: g, data: { kind: 'glove', texScale: 1.2 } });
  // hand in local space via a tiny local builder then transformed
  const L = new MeshBuilder();
  L.part('x', null);
  // palm / back block
  L.rbox(V(2.05, -0.05, -0.1), V(1.95, 1.72, 0.82), 0.62, QID, 0, { seg: R.boxSeg2, mid: 1 });
  // fingers
  const fingers = [
    { y: 1.2, l: [1.95, 1.2, 0.95], r: 0.43, k: 3.95 },
    { y: 0.4, l: [2.1, 1.3, 1.0], r: 0.45, k: 4.05 },
    { y: -0.4, l: [2.0, 1.2, 0.95], r: 0.43, k: 3.95 },
    { y: -1.15, l: [1.65, 0.95, 0.85], r: 0.38, k: 3.7 },
  ];
  for (const f of fingers) {
    const pts = [V(f.k - 0.6, f.y, 0.05), V(f.k, f.y, 0.05)];
    let ang = 0, px = f.k, pz = 0.05;
    const flex = [1.62, 1.55, 0.7];
    for (let j = 0; j < 3; j++) {
      ang += flex[j];
      const steps = 2;
      for (let s2 = 1; s2 <= steps; s2++) {
        px += Math.cos(ang) * f.l[j] / steps; pz -= Math.sin(ang) * f.l[j] / steps;
        pts.push(V(px, f.y, pz));
      }
    }
    const n = pts.length;
    const rad = (t) => {
      const e = t * (n - 1);
      const tip = Math.max(0, e - (n - 2));
      return f.r * (1 - 0.15 * t) * Math.sqrt(Math.max(0.02, 1 - tip * tip));
    };
    L.tube(pts, rad, R.fingerU, 0, {});
  }
  // thumb
  const tp = [V(0.9, 1.1, -0.35), V(1.9, 1.75, -1.35), V(2.9, 2.0, -2.05), V(3.8, 1.95, -2.35), V(4.35, 1.85, -2.4)];
  L.tube(tp, (t) => 0.55 * (1 - 0.2 * t) * Math.sqrt(Math.max(0.03, 1 - Math.max(0, t * 4 - 3) ** 2)), R.fingerU, 0, { smooth: 2 });
  // knuckle ridge (padded glove)
  L.rbox(V(3.75, 0.02, 0.62), V(0.45, 1.7, 0.28), 0.25, QID, 0, { seg: 1 });
  // copy into the main builder with the bind transform
  appendTransformed(mb, L, toBind, (n) => V(n.x, n.y, n.z * mirror).transformDirection(M), hs, mirror < 0);
  // cuff
  const cr = (d, r, n = 2) => ({ c: A.wr.clone().addScaledVector(xh, d), t: xh, f: yh, rf: r, rb: r, rl: r * 1.12, rr: r * 1.12, n });
  mb.loft([cr(-1.1, 1.1), cr(-0.9, 1.3), cr(0.3, 1.38), cr(1.1, 1.45), cr(1.5, 1.2)], R.limbU, cuffSkin, { sub: R.subLow });
}

/** Append geometry from a local builder, transforming positions/normals. Keeps its islands. */
function appendTransformed(mb, L, fp, fn, skin, flip) {
  const base = mb.pos.length / 3;
  for (const is of L.islands) {
    const isl = mb._beginIsland();
    for (let k = is.vStart; k < is.vEnd; k++) {
      const p = fp(V(L.pos[k * 3], L.pos[k * 3 + 1], L.pos[k * 3 + 2]));
      const n = fn(V(L.nrm[k * 3], L.nrm[k * 3 + 1], L.nrm[k * 3 + 2])).normalize();
      mb.pos.push(p.x, p.y, p.z); mb.nrm.push(n.x, n.y, n.z);
      mb.uv.push(L.uv[k * 2], L.uv[k * 2 + 1]);
      mb.skin.push(normSkin(typeof skin === 'function' ? skin(p) : skin));
    }
    for (let t = is.iStart; t < is.iEnd; t += 3) {
      const a = L.idx[t] - is.vStart + isl.vStart, b = L.idx[t + 1] - is.vStart + isl.vStart, c = L.idx[t + 2] - is.vStart + isl.vStart;
      if (flip) mb.idx.push(a, c, b); else mb.idx.push(a, b, c);
    }
    mb._endIsland(isl).face = is.face;
  }
  return base;
}

// ---- gear helpers ---------------------------------------------------------------------------
/** Rounded box placed on the torso surface: pos (x,y,z) is the back face centre. */
function pouch(mb, c, h, r, q, skin, R, o = {}) {
  mb.rbox(c, h, r, q, skin, { seg: R.boxSeg, ...o });
}
/** Point on the torso loft surface at height y, angle th (0 front, +left) plus outward offset. */
export function torsoSurf(y, th, off = 0) {
  // piecewise rings used by buildTorso (keep in sync roughly)
  const T = [[39.2, 4.5, 4.8, 6.95, 2.4], [43.0, 4.25, 4.45, 6.55, 2.4], [47.0, 4.75, 4.6, 6.8, 2.5],
    [51.0, 5.25, 4.95, 7.35, 2.6], [54.4, 5.0, 4.9, 7.8, 2.9], [56.9, 4.1, 4.4, 7.7, 3.4], [58.7, 3.0, 3.4, 5.6, 2.8]];
  let k = 0;
  while (k < T.length - 2 && T[k + 1][0] < y) k++;
  const a = T[k], b = T[k + 1];
  const t = Math.min(1, Math.max(0, (y - a[0]) / (b[0] - a[0])));
  const ip = (i) => a[i] + (b[i] - a[i]) * t;
  const c = Math.cos(th), s = Math.sin(th), ex = 2 / ip(4);
  const rx = c >= 0 ? ip(1) : ip(2), rz = ip(3);
  const x = Math.sign(c) * Math.abs(c) ** ex * rx, z = -Math.sign(s) * Math.abs(s) ** ex * rz;
  const n = V(x / (rx * rx), 0, z / (rz * rz)).normalize();
  return { p: V(x, y, z).addScaledVector(n, off), n };
}

// ---- assemble ---------------------------------------------------------------------------------
export const LOD_RES = [
  { torsoU: 26, limbU: 12, headU: 24, sub: 2, subLow: 1, headSub: 3, fingerU: 5, boxSeg: 1, boxSeg2: 2, fingerSmooth: 1 },
  { torsoU: 14, limbU: 8, headU: 12, sub: 1, subLow: 1, headSub: 1, fingerU: 4, boxSeg: 1, boxSeg2: 1, fingerSmooth: 1 },
];

export function buildAgent(team, lod = 0) {
  const S = STYLE[team] || STYLE.T;
  const R = LOD_RES[lod] || LOD_RES[0];
  const mb = new MeshBuilder();
  buildHips(mb, S, R);
  buildTorso(mb, S, R);
  buildNeck(mb, S, R);
  buildHead(mb, S, R);
  for (const side of ['L', 'R']) {
    buildArm(mb, S, R, side);
    buildHand(mb, S, R, side);
    buildLeg(mb, S, R, side);
    buildBoot(mb, S, R, side);
  }
  S.gear(mb, R, { vr, lr, yChain, torsoSkin, rigid, pouch, torsoSurf, armPt, legPt, V, Q, QID, HEAD_C, armSkin, legSkin, BONE, LEG_L, LEG_R, ARM_L, ARM_R });
  return mb;
}
