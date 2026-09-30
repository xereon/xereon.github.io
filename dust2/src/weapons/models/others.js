// Remaining families at "good" quality: SMGs (MP9, MAC-10, MP5-SD, UMP-45, P90), shotguns
// (Nova, XM1014, MAG-7), LMGs (Negev, M249) and rifles (Galil AR, FAMAS, AUG, SG 553).
// Profiles in (u, v): u from the receiver rear toward the muzzle, v up from the bore.
import * as G from './geo.js';
import { stanag } from './m4.js';
import { akMagProfile } from './ak47.js';
import { scope } from './snipers.js';

const { side, cross, lathe, cyl, box, sphere, torus, deform, screw, picatinny } = G;

const H = (R, L, extra = {}) => ({ hands: { R, L, ...extra } });
const RH = (u, v, ang = 16, x = 0.98) => ({ p: [x, v, -u], across: [0, -Math.cos(ang * Math.PI / 180), Math.sin(ang * Math.PI / 180)], palm: [-1, 0, -0.05], pose: 'trigger' });
const LHg = (u, v, x = -0.55) => ({ p: [x, v, -u], across: [0, 0.05, 1], palm: [0.45, 0.9, 0], pose: 'wrap' });
// left hand on a vertical foregrip
const LHv = (u, v) => ({ p: [-0.95, v, -u], across: [0, -1, 0.15], palm: [1, 0, -0.1], pose: 'grip' });
const MAGG = (u, v) => ({ p: [-0.65, v, -u], across: [0, 0, 1], palm: [0.95, 0.1, -0.2], pose: 'cup' });

function pistolGrip(b, u0, u1, v0, L, ang, mat = 'stipple', w = 1.1) {
  const t = Math.tan(ang * Math.PI / 180);
  const f = (y) => u1 - (v0 - y) * t, bk = (y) => u0 - (v0 - y) * t;
  const yb = v0 - L;
  b.add(mat, side([[u0, v0], [u1, v0], [f(v0 - L * 0.35) + 0.05, v0 - L * 0.35, 0.5], [f(yb), yb, 0.2], [bk(yb) - 0.1, yb, 0.2], [bk(v0 - L * 0.5) - 0.15, v0 - L * 0.5, 0.6]], w, { r: 0.15, bevel: 0.22, bseg: 3 }));
}
function guard(b, u0, u1, v0, mat = 'polymer', w = 0.45, depth = 0.85) {
  const vb = v0 - depth;
  b.add(mat, side([[u0, v0], [u1, v0], [u1, vb + 0.25], [u1 - 0.3, vb], [u0 + 0.3, vb], [u0, vb + 0.4]], w,
    { r: 0.12, bevel: 0.04, holes: [[[u0 + 0.22, v0 - 0.1], [u1 - 0.18, v0 - 0.1], [u1 - 0.18, vb + 0.3], [u1 - 0.38, vb + 0.15], [u0 + 0.38, vb + 0.15], [u0 + 0.22, vb + 0.45]]] }));
}
function trigger(b, u, v, mat = 'steel') {
  b.part('trigger', [0, v, -u]);
  b.add(mat, side([[u - 0.15, v + 0.05], [u + 0.15, v + 0.05], [u + 0.1, v - 0.3], [u - 0.05, v - 0.58], [u - 0.2, v - 0.6], [u - 0.12, v - 0.28]], 0.2, { r: 0.06 }));
  b.part('body');
}
function muzzleDev(b, u, r = 0.34, len = 1.2, mat = 'park') {
  b.add(mat, lathe([[r * 0.6, u], [r, u + 0.05], [r, u + len - 0.05], [r * 0.9, u + len], [r * 0.55, u + len], [r * 0.55, u + 0.2]], 18));
  if (b.detail) for (let i = 0; i < 4; i++) b.add('dark', box(0.06, 0.05, len * 0.6, { r: 0.02 }), { p: [Math.cos(i * 1.57 + 0.78) * r, Math.sin(i * 1.57 + 0.78) * r, -(u + len * 0.5)], r: [0, 0, i * 90 + 45] });
}
function straightMag(b, u0, u1, v0, len, w = 0.9, mat = 'park', curve = 0, pivotFront = true) {
  b.part('mag', [0, v0, -(pivotFront ? u1 : u0)]);
  const pts = [];
  const n = 8;
  for (let i = 0; i <= n; i++) { const s = i / n; pts.push([u0 + curve * s * s, v0 - s * len]); }
  for (let i = n; i >= 0; i--) { const s = i / n; pts.push([u1 + curve * s * s * 1.1, v0 - s * len]); }
  b.add(mat, side(pts.map((p, i) => [p[0], p[1], i === 0 || i === pts.length - 1 ? 0.03 : 0.1]), w, { r: 0.1, bevel: 0.05 }), { c: 0xb0b0b0 });
  const e = v0 - len;
  b.add('polymer', box(w + 0.12, 0.25, u1 - u0 + 0.25, { r: 0.07 }), { p: [0, e - 0.05, -((u0 + u1) / 2 + curve)] });
  b.part('body');
}

// ======================= SMGs =======================
export function buildMP9(b) {
  const D = b.detail;
  b.add('polymer', side([[0, -0.6], [8.8, -0.6], [9.2, -0.3], [9.2, 0.75], [0.2, 0.75], [0, 0.5]], 1.2, { r: 0.12, bevel: 0.08 }));
  picatinny(b, 'alu', 0.4, 8.4, 0.75);
  b.add('park', lathe([[0.3, 9.1], [0.3, 10.3], [0.25, 10.4]], 14));
  muzzleDev(b, 10.3, 0.32, 0.9);
  pistolGrip(b, 1.3, 2.8, -0.55, 4.0, 10);
  guard(b, 2.8, 5.3, -0.55, 'polymer', 0.55, 1.0);
  trigger(b, 3.6, -0.6);
  // folding vertical foregrip + side-folded stock
  b.add('polymer', side([[6.8, -0.6], [7.8, -0.6], [7.75, -3.4], [7.5, -3.6], [6.95, -3.6], [6.85, -3.3]], 0.9, { r: 0.15, bevel: 0.2, bseg: 2 }));
  b.add('polymer', side([[-0.1, 0.4], [7.5, 0.4], [7.5, -0.2], [-0.1, -0.2]], 0.3, { x: 0.78, r: 0.1, bevel: 0.05 }));
  b.add('rubber', side([[-0.45, 0.6], [0.0, 0.6], [0.0, -1.6], [-0.45, -1.6]], 0.4, { x: 0.78, r: 0.1, bevel: 0.06 }));
  b.part('bolt', [0, 0.95, -0.4]);
  b.add('polymer', side([[-0.3, 0.75], [0.4, 0.75], [0.4, 1.05], [-0.3, 1.05]], 1.3, { r: 0.08, bevel: 0.04 }));
  b.part('body');
  const t = Math.tan(10 * Math.PI / 180);
  straightMag(b, 1.55 - 0.5 * t, 2.55 - 0.5 * t, -1.0, 7.2, 0.8, 'park', -7.2 * t, false);
  b.anchor('muzzle', [0, 0, -11.25]); b.anchor('eject', [0.62, 0.3, -4.5]); b.anchor('pivot', [0, -1.5, -4]);
  return { ...H(RH(1.9, -1.9, 12), LHv(7.3, -2.1), { magGrab: MAGG(2.2, -6.5) }), magPivot: 'straight', boltTravel: 1.5 };
}

export function buildMAC10(b) {
  const D = b.detail;
  b.add('park', side([[0, -0.75], [9.6, -0.75], [9.6, 1.0], [0, 1.0]], 1.55, { r: 0.1, bevel: 0.07 }));
  if (D) for (const s of [1, -1]) for (const [u, v] of [[0.6, 0.6], [0.6, -0.4], [9.0, 0.6], [9.0, -0.4], [4.5, 0.6]]) G.rivet(b, 'steel', [0.78 * s, v, -u], 0.1, s);
  b.add('park', lathe([[0.36, 9.5], [0.36, 11.2], [0.3, 11.3]], 16));
  if (D) for (let i = 0; i < 10; i++) b.add('park', torus(0.36, 0.03, { rs: 4, ts: 14 }), { p: [0, 0, -(10.0 + i * 0.12)] });
  b.add('polymer', side([[3.0, -0.7], [4.7, -0.7], [4.55, -4.5], [4.4, -4.75], [3.05, -4.75], [2.9, -4.5]], 1.35, { r: 0.15, bevel: 0.18 }));
  guard(b, 4.7, 6.8, -0.7, 'park', 0.5, 0.9);
  trigger(b, 5.3, -0.75);
  // strap loop at the front for the support hand + collapsed wire stock
  b.add('rubber', torus(0.9, 0.12, { rs: 6, ts: 18, arc: Math.PI }), { p: [0, -0.75, -8.8], r: [0, 90, 180] });
  b.add('steel', cyl(0.12, 0.12, 8.5, 8, { u0: -1.0 }), { p: [0.55, -0.4, 0] });
  b.add('steel', cyl(0.12, 0.12, 8.5, 8, { u0: -1.0 }), { p: [-0.55, -0.4, 0] });
  b.add('rubber', box(1.5, 1.4, 0.4, { r: 0.1 }), { p: [0, -0.4, 1.2] });
  b.part('bolt', [0, 1.1, -5.5]);
  b.add('steel', cyl(0.12, 0.12, 0.45, 10, { axis: 'y' }), { p: [0, 1.2, -5.5] });
  b.add('polymer', sphere(0.28, 12, 8), { p: [0, 1.5, -5.5], s: [1, 0.7, 1] });
  b.part('body');
  straightMag(b, 3.25, 4.4, -4.6, 5.2, 0.75, 'park', 0, false);
  b.anchor('muzzle', [0, 0, -11.35]); b.anchor('eject', [0, -0.8, -6.5]); b.anchor('pivot', [0, -1.5, -5]);
  return { ...H(RH(3.8, -2.0, 4, 1.1), { p: [-0.2, -1.95, -8.8], across: [0, 0.1, 1], palm: [0.3, 0.95, 0], pose: 'wrap' }, { magGrab: MAGG(3.8, -8.5) }), magPivot: 'straight', boltTravel: 2.5, elbowL: [-4, -8, 5] };
}

export function buildMP5(b) {
  const D = b.detail;
  // stamped receiver with the cocking tube on top
  b.add('park', side([[0, -0.6], [9.2, -0.6], [9.2, 0.55], [0, 0.55]], 1.2, { r: 0.12, bevel: 0.06 }));
  b.add('park', cyl(0.42, 0.42, 9.3, 18, { u0: 0 }), { p: [0, 0.75, 0] });
  if (D) {
    // drum rear sight + front sight hood on the cocking tube
    b.add('park', side([[0.6, 0.9], [1.6, 0.9], [1.5, 1.8], [0.7, 1.8]], 0.9, { r: 0.15, bevel: 0.05 }));
    b.add('steel', cyl(0.45, 0.45, 0.35, 16, { axis: 'x' }), { p: [0, 1.55, -1.1] });
  }
  // SD integral suppressor + slim handguard
  b.add('park', lathe([[0.72, 9.0], [0.95, 9.2], [0.95, 20.2], [0.8, 20.4], [0.25, 20.45]], 26), { c: 0xbbbbbb });
  b.add('dark', cyl(0.2, 0.2, 0.05, 12, { u0: 20.4 }));
  b.add('polymer', side([[9.3, 0.45], [15.5, 0.45], [15.6, -1.25], [9.3, -1.25]], 2.25, { r: 0.35, bevel: 0.35, bseg: 3 }));
  if (D) for (let i = 0; i < 5; i++) b.add('polymer', box(2.3, 0.08, 0.35, { r: 0.04 }), { p: [0, -1.25, -(10.0 + i * 1.1)] });
  // curved mag well + mag
  b.add('park', side([[4.6, -0.6], [6.6, -0.6], [6.6, -1.4], [4.6, -1.4]], 1.1, { r: 0.08 }));
  b.part('mag', [0, -1.2, -6.5]);
  const M = akMagProfile({ top: [5.55, -0.9], R: 16, len: 6.6, d0: 1.6, d1: 1.7 });
  b.add('park', side([...M.back, ...M.front.slice().reverse()], 0.95, { r: 0.1, bevel: 0.05 }), { c: 0xaaaaaa });
  b.part('body');
  // HK "Navy" trigger group + grip, retractable stock
  pistolGrip(b, 1.6, 3.2, -0.6, 3.8, 12, 'polymer');
  guard(b, 3.2, 4.8, -0.6, 'polymer', 0.55, 0.9);
  trigger(b, 3.8, -0.65);
  b.add('park', cyl(0.12, 0.12, 7.5, 8, { u0: -7.8 }), { p: [0.55, 0.3, 0] });
  b.add('park', cyl(0.12, 0.12, 7.5, 8, { u0: -7.8 }), { p: [-0.55, 0.3, 0] });
  b.add('rubber', side([[-8.2, 1.0], [-7.6, 1.0], [-7.6, -3.0], [-8.2, -3.0]], 1.5, { r: 0.3, bevel: 0.1 }));
  b.part('bolt', [0, 0.75, -8.3]);
  b.add('steel', cyl(0.1, 0.1, 0.9, 10, { axis: 'x' }), { p: [-0.7, 0.75, -8.3], r: [0, 0, 0] });
  b.add('polymer', sphere(0.18, 10, 8), { p: [-1.15, 0.75, -8.3] });
  b.part('body');
  b.anchor('muzzle', [0, 0, -20.5]); b.anchor('eject', [0.62, 0.2, -4.5]); b.anchor('pivot', [0, -1.2, -6]);
  return { ...H(RH(2.4, -1.9, 12), LHg(12.5, -1.5, -0.7), { magGrab: MAGG(6.2, -3.6), chargeGrab: { p: [-1.6, 1.0, -8.2], across: [0, -0.1, 1], palm: [0.9, -0.3, 0], pose: 'pinch' } }), magPivot: 'rock', boltTravel: 2.8 };
}

export function buildUMP(b) {
  const D = b.detail;
  b.add('polymer', side([[0, -0.9], [11.8, -0.9], [12.2, -0.5], [12.2, 0.8], [0.3, 0.8], [0, 0.5]], 1.45, { r: 0.18, bevel: 0.1 }));
  picatinny(b, 'alu', 1.0, 10.5, 0.8);
  if (D) for (const s of [1, -1]) { picatinny(b, 'alu', 9.3, 2.5, 0, { x: 0.72 * s, rot: -90 * s }); }
  b.add('park', lathe([[0.3, 12.1], [0.3, 13.3], [0.25, 13.35]], 14));
  muzzleDev(b, 13.2, 0.33, 0.8);
  pistolGrip(b, 1.3, 2.9, -0.85, 3.9, 20, 'stipple', 1.15);
  guard(b, 2.9, 5.1, -0.85, 'polymer', 0.55, 0.95);
  trigger(b, 3.6, -0.9);
  b.add('polymer', side([[-0.2, 0.6], [-9.0, 0.6], [-9.3, 0.1], [-9.3, -2.8], [-8.7, -3.0], [-7.5, -1.2], [-0.2, -0.6]], 1.2, { r: 0.4, bevel: 0.2, holes: [[[-7.0, 0.1], [-1.2, 0.1], [-1.2, -0.3], [-6.8, -0.8]]] }));
  b.part('bolt', [0, 0.6, -9.0]);
  b.add('polymer', side([[8.5, 0.35], [9.4, 0.35], [9.4, 0.75], [8.5, 0.75]], 0.25, { x: -0.8, r: 0.08 }));
  b.part('body');
  straightMag(b, 5.4, 7.1, -0.9, 7.0, 0.95, 'polymer', 0.2);
  b.anchor('muzzle', [0, 0, -14.05]); b.anchor('eject', [0.75, 0.2, -5]); b.anchor('pivot', [0, -1.5, -5]);
  return { ...H(RH(2.0, -2.2, 20), LHg(10.4, -1.95, -0.65), { magGrab: MAGG(6.4, -4.2), chargeGrab: { p: [-1.5, 0.6, -9], across: [0, -0.1, 1], palm: [0.9, -0.3, 0], pose: 'pinch' } }), magPivot: 'straight', boltTravel: 2.4 };
}

export function buildP90(b) {
  const D = b.detail;
  // flowing bullpup shell (side profile), thumbhole grip at the front, magazine on top
  const shell = side([
    [-5.5, 0.6, 0.3], [-5.6, -2.8, 0.4], [-4.8, -3.4, 0.6], [-1.8, -3.0, 1.0], [0.8, -3.0, 0.8], [1.6, -3.9, 0.6], [2.6, -5.2, 0.4],
    [3.6, -5.4, 0.4], [4.6, -5.1, 0.5], [5.2, -3.4, 0.6], [6.8, -2.2, 0.6], [9.0, -1.4, 0.5], [9.5, -0.6, 0.3], [9.4, 0.5, 0.2], [-5.0, 0.8, 0.3],
  ], 2.1, { r: 0.3, bevel: 0.4, bseg: 3, cseg: 5, holes: [[[2.3, -3.1, 0.3], [4.8, -2.4, 0.5], [4.6, -3.3, 0.3], [3.9, -4.6, 0.3], [3.2, -4.7, 0.3], [2.6, -3.9, 0.3]], [[5.8, -1.7, 0.3], [8.3, -1.1, 0.4], [8.3, -1.3, 0.2], [6.2, -2.0, 0.3]]] });
  b.add('polymer', deform(shell, (v) => { const u = -v.z; if (u < -1.5) v.x *= 0.9; if (v.y < -2.8) v.x *= 0.72; }, 50));
  b.add('park', lathe([[0.26, 9.2], [0.26, 10.6], [0.22, 10.7]], 12));
  muzzleDev(b, 10.3, 0.35, 1.0, 'polymer');
  // triad sight housing on top
  b.add('polymer', side([[3.0, 2.2], [7.2, 2.2], [7.4, 2.8], [6.6, 3.3], [3.8, 3.2], [3.0, 2.8]], 1.1, { r: 0.25, bevel: 0.15 }));
  b.add('lens', cyl(0.38, 0.38, 0.05, 16, { u0: 7.35 }), { p: [0, 2.72, 0] });
  trigger(b, 2.2, -2.9, 'polymer');
  b.part('mag', [0, 2.0, -9.0]);
  const mag = side([[-3.2, 0.7], [9.0, 0.7], [9.2, 1.0], [9.2, 2.2], [-3.0, 2.2], [-3.3, 1.8]], 1.9, { r: 0.2, bevel: 0.12 });
  b.add('glass_green', mag, { c: 0x886644 });
  b.add('polymer', side([[-3.4, 0.6], [-2.6, 0.6], [-2.6, 2.3], [-3.4, 2.3]], 2.0, { r: 0.15, bevel: 0.08 }));
  if (D) b.add('brass', box(0.7, 0.6, 11, { r: 0.15 }), { p: [0, 1.4, -2.9] });
  b.part('body');
  b.part('bolt', [0, 0.2, -6.0]);
  b.add('polymer', box(0.25, 0.3, 0.6, { r: 0.08 }), { p: [1.12, 0.2, -6.0] });
  b.part('body');
  b.anchor('muzzle', [0, 0, -11.3]); b.anchor('eject', [0, -3.2, 1]); b.anchor('pivot', [0, -1.5, -2]);
  return { ...H({ p: [1.2, -2.9, -1.0], across: [0, -0.94, 0.33], palm: [-1, 0, -0.1], pose: 'trigger' }, { p: [-1.1, -2.5, -7.2], across: [0, -0.9, 0.3], palm: [1, 0, -0.15], pose: 'grip' },
    { magGrab: { p: [-1.3, 2.0, -3.0], across: [0, 0, 1], palm: [0.9, -0.3, 0], pose: 'cup' } }), magPivot: 'straight', boltTravel: 1.8, elbowL: [-4, -8, 5] };
}

// ======================= shotguns =======================
export function buildShotgun(b, key) {
  const D = b.detail;
  const nova = key === 'nova', mag7 = key === 'mag7';
  if (mag7) {
    b.add('park', side([[0, -0.6], [7.5, -0.6], [7.5, 1.0], [0.2, 1.0], [0, 0.7]], 1.45, { r: 0.12, bevel: 0.07 }));
    picatinny(b, 'park', 0.5, 6.8, 1.0);
    b.add('park', lathe([[0.45, 7.4], [0.45, 16.0], [0.38, 16.1]], 18));
    pistolGrip(b, 1.3, 2.8, -0.55, 4.2, 12, 'stipple', 1.25);
    guard(b, 2.8, 4.9, -0.55, 'park', 0.5, 0.95);
    trigger(b, 3.5, -0.6);
    b.add('polymer', side([[-0.2, 0.9], [-7.5, 0.7], [-7.8, -2.4], [-7.0, -2.6], [-3.0, -0.9], [-0.2, -0.6]], 1.3, { r: 0.3, bevel: 0.2 }));
    b.part('pump', [0, -0.6, -9.0]);
    b.add('polymer', side([[7.8, -0.2], [12.2, -0.2], [12.2, -1.5], [7.8, -1.5]], 1.7, { r: 0.35, bevel: 0.3, bseg: 3 }));
    if (D) for (let i = 0; i < 8; i++) b.add('polymer', box(1.8, 0.1, 0.18, { r: 0.04 }), { p: [0, -1.5, -(8.3 + i * 0.5)] });
    b.part('body');
    const t = Math.tan(12 * Math.PI / 180);
    straightMag(b, 1.55 - 0.5 * t, 2.55 - 0.5 * t, -1.2, 4.2, 1.1, 'park', -4.2 * t, false);
    b.anchor('muzzle', [0, 0, -16.15]); b.anchor('eject', [0.75, 0.2, -4]); b.anchor('pivot', [0, -1.2, -4]);
    return { ...H(RH(1.9, -2.0, 14), LHg(10.0, -2.35, -0.6), { magGrab: MAGG(2.1, -5.5) }), magFed: true, magPivot: 'straight', pumpTravel: 3.0, pumpAction: true, boltTravel: 0 };
  }
  // tube-magazine shotguns
  const recMat = nova ? 'polymer' : 'alu';
  b.add(recMat, side([[0, -0.9], [8.2, -0.9], [8.2, 0.65], [0.6, 0.85], [0, 0.6]], 1.4, { r: 0.18, bevel: 0.1 }));
  if (!nova) { picatinny(b, 'alu', 0.8, 7.0, 0.8); b.add('alu', side([[1.0, 1.1], [1.7, 1.1], [1.65, 1.7], [1.05, 1.7]], 0.9, { r: 0.08, holes: [[[1.2, 1.35], [1.5, 1.35], [1.5, 1.6], [1.2, 1.6]]] })); }
  b.add('park', lathe([[0.42, 8.0], [0.42, 26.0], [0.38, 26.1], [0.3, 26.1], [0.3, 25.8]], 18));
  b.add('park', lathe([[0.42, 8.0], [0.42, 22.5], [0.38, 22.7]], 16), { p: [0, -0.95, 0] });
  b.add('park', side([[21.0, 0.3], [22.0, 0.3], [22.0, -1.2], [21.0, -1.2]], 0.9, { r: 0.15 }));
  b.add('paint_white', sphere(0.08, 8, 6), { p: [0, 0.48, -25.8] });
  // load port (underside) + grip / stock
  if (D) b.add('dark', side([[3.2, -0.92], [6.8, -0.92], [6.8, -0.95], [3.2, -0.95]], 0.8, { bevel: 0 }));
  if (nova) {
    b.add('polymer', side([[0.2, 0.7], [-13.5, -0.4], [-13.8, -1.0], [-13.8, -5.2], [-13.0, -5.4], [-7.0, -3.2], [-2.5, -3.0], [-0.8, -5.0], [0.6, -5.0], [1.6, -1.5], [2.0, -0.9]], 1.5,
      { r: 0.35, bevel: 0.3, bseg: 3, holes: [[[-6.0, -1.0], [-2.2, -0.8], [-1.3, -1.8], [-2.8, -2.6], [-6.3, -2.4]]] }));
    b.add('rubber', side([[-14.3, -0.5], [-13.7, -0.5], [-13.7, -5.3], [-14.3, -5.2]], 1.6, { r: 0.3 }));
  } else {
    pistolGrip(b, 0.9, 2.5, -0.85, 4.0, 14, 'stipple', 1.2);
    b.add('alu', cyl(0.55, 0.55, 8.5, 18, { u0: -8.8 }), { p: [0, 0.1, 0] });
    b.add('polymer', side([[-4.0, 0.9], [-10.5, 0.9], [-10.8, -3.5], [-9.9, -3.7], [-6.0, -1.4], [-4.0, -0.9]], 1.5, { r: 0.35, bevel: 0.25 }));
    b.add('rubber', side([[-11.2, 1.0], [-10.7, 1.0], [-10.7, -3.7], [-11.2, -3.7]], 1.6, { r: 0.3 }));
  }
  guard(b, 2.5, 4.6, -0.85, recMat, 0.5, 0.9);
  trigger(b, 3.2, -0.9);
  b.part('pump', [0, -0.95, -12]);
  b.add('polymer', side([[9.5, -0.3], [15.5, -0.3], [15.5, -1.6], [9.5, -1.6]], 1.9, { r: 0.4, bevel: 0.35, bseg: 3 }));
  if (D) for (let i = 0; i < 10; i++) b.add('polymer', box(2.0, 0.12, 0.2, { r: 0.05 }), { p: [0, -1.6, -(10.0 + i * 0.55)] });
  b.part('body');
  b.part('bolt', [0, 0.2, -5]);
  b.add('bright', side([[3.3, -0.1], [6.5, -0.1], [6.5, 0.45], [3.3, 0.45]], 0.05, { x: 0.71 }));
  b.add('steel', cyl(0.12, 0.12, 0.6, 10, { axis: 'x' }), { p: [0.95, 0.2, -3.8] });
  b.part('body');
  b.anchor('muzzle', [0, 0, -26.2]); b.anchor('eject', [0.75, 0.2, -5]); b.anchor('pivot', [0, -1.5, -5]);
  return { ...H(RH(nova ? 0.2 : 1.6, nova ? -2.6 : -2.2, nova ? 25 : 16), LHg(12.5, -2.55, -0.65)), shells: 4, loadPort: [0.1, -2.1, -5.4], pumpTravel: 3.2, pumpAction: nova, boltTravel: 2.8, magPivot: 'straight' };
}

// ======================= LMGs =======================
export function buildLMG(b, key) {
  const D = b.detail, negev = key === 'negev';
  b.add('park', side([[0, -0.9], [11.5, -0.9], [11.5, 1.3], [0.4, 1.3], [0, 0.9]], 1.7, { r: 0.12, bevel: 0.07 }));
  // feed cover (hinged at the front, opens during reload)
  b.part('cover', [0, 1.3, -8.5]);
  b.add('park', side([[1.5, 1.2], [8.5, 1.2], [8.5, 1.9], [2.0, 2.0], [1.5, 1.7]], 1.8, { r: 0.12, bevel: 0.06 }));
  if (D) b.add('park', side([[1.2, 1.7], [2.2, 1.7], [2.2, 2.3], [1.2, 2.3]], 0.6, { r: 0.08 }));
  b.part('body');
  picatinny(b, 'park', 2.5, 5.5, 2.0, { w: 0.8 });
  // barrel + heat shield/handguard + carry handle + bipod (folded)
  b.add('park', lathe([[0.55, 11.4], [0.5, 12], [0.45, 30.0], [0.4, 30.1]], 18));
  muzzleDev(b, 30.0, 0.42, 1.6);
  b.add('polymer', side([[11.5, 0.9], [19.0, 0.9], [19.2, -1.4], [11.5, -1.4]], 2.1, { r: 0.3, bevel: 0.3 }));
  if (D) for (let i = 0; i < 6; i++) for (const s of [1, -1]) b.add('dark', box(0.05, 0.9, 0.35, { r: 0.1 }), { p: [s * 0.98, -0.3, -(12.3 + i * 1.1)] });
  b.add('steel', side([[20.0, 0.5], [21.0, 0.5], [21.0, 2.2], [20.0, 2.2]], 0.3, { r: 0.1 }));
  b.add('steel', side([[23, -0.5], [23.8, -0.5], [23.8, -0.9], [23, -0.9]], 1.0, { r: 0.1 }));
  for (const s of [1, -1]) b.add('steel', cyl(0.12, 0.1, 8, 10, { u0: 20.5 }), { p: [s * 0.45, -0.95, 0] });
  b.add('steel', side([[9.0, 2.0], [9.3, 2.0], [9.6, 3.4], [13.0, 3.4], [13.3, 2.0], [13.6, 2.0], [13.3, 3.7], [9.3, 3.7]], 0.4, { r: 0.1, bevel: 0.04 }));
  pistolGrip(b, 1.0, 2.6, -0.85, 4.1, 16, 'stipple', 1.2);
  guard(b, 2.6, 4.8, -0.85, 'park', 0.55, 0.95);
  trigger(b, 3.3, -0.9);
  b.add('polymer', side([[-0.2, 1.1], [-12.0, 0.4], [-12.3, -3.2], [-11.5, -3.4], [-6.0, -1.6], [-0.2, -0.8]], 1.6, { r: 0.35, bevel: 0.25, holes: [[[-9.5, -0.2], [-3.0, 0.3], [-3.0, -0.6], [-8.5, -1.5]]] }));
  b.add('rubber', side([[-12.8, 0.5], [-12.2, 0.5], [-12.2, -3.4], [-12.8, -3.4]], 1.7, { r: 0.3 }));
  b.part('bolt', [0, 0.2, -7]);
  b.add('steel', cyl(0.14, 0.14, 1.0, 10, { axis: 'x' }), { p: [0.95, 0.2, -7] });
  b.add('polymer', box(0.4, 0.5, 0.5, { r: 0.1 }), { p: [1.45, 0.2, -7] });
  b.part('body');
  // box magazine / drum under the receiver (left-feed look)
  b.part('mag', [0, -0.9, -6.5]);
  if (negev) {
    b.add('paint_od', side([[4.8, -0.9], [8.8, -0.9], [8.8, -5.3], [8.4, -5.6], [5.2, -5.6], [4.8, -5.3]], 3.2, { r: 0.35, bevel: 0.2 }), { p: [-0.8, 0, 0] });
  } else {
    b.add('wrapper', side([[4.6, -0.9], [9.2, -0.9], [9.2, -5.0], [8.8, -5.4], [5.0, -5.4], [4.6, -5.0]], 3.4, { r: 0.4, bevel: 0.3, bseg: 3 }), { p: [-0.9, 0, 0] });
    if (D) b.add('tape', box(3.5, 0.3, 4.7, { r: 0.1 }), { p: [-0.9, -3.0, -6.9] });
  }
  b.part('body');
  b.anchor('muzzle', [0, 0, -31.6]); b.anchor('eject', [0, -1, -5]); b.anchor('pivot', [0, -1.5, -6]);
  return { ...H(RH(1.6, -2.2, 16), LHg(15.5, -2.3, -0.7), { magGrab: MAGG(6.8, -3.5) }), coverGrab: [-0.2, 2.8, -6], boltTravel: 3.0, magPivot: 'straight' };
}

// ======================= other rifles =======================
export function buildGalil(b) {
  const D = b.detail;
  b.add('park', side([[0, 0.4], [0.1, -1.1], [0.45, -1.3], [8.6, -1.3], [9.2, -1.2], [10.3, -1.2], [10.3, 0.4]], 1.2, { r: 0.08, bevel: 0.06 }));
  b.add('park', cross([[-0.62, 0], [0.62, 0], [0.62, 0.28, 0.1], [0.5, 0.62, 0.25], [0, 0.74, 0.3], [-0.5, 0.62, 0.25], [-0.62, 0.28, 0.1]], 9.0, { u0: 0.3, bevel: 0.04 }), { p: [0, 0.4, 0] });
  // carry handle over the gas block, wood + polymer handguard
  b.add('wood_walnut', side([[10.8, 0.9], [17.8, 0.9], [18.0, -1.2], [11.0, -1.3], [10.8, -0.8]], 2.0, { r: 0.3, bevel: 0.35, bseg: 3 }));
  b.add('park', lathe([[0.55, 10.2], [0.4, 11], [0.33, 19], [0.3, 23.5]], 18));
  b.add('park', cyl(0.3, 0.3, 7.5, 12, { u0: 11.0 }), { p: [0, 1.1, 0] });
  b.add('park', side([[18.0, -0.5], [19.5, -0.5], [19.5, 1.6], [18.0, 1.6]], 0.8, { r: 0.1 }));
  b.add('steel', side([[20.5, 0.1], [21.2, 0.1], [21.2, 1.9], [20.5, 1.9]], 0.45, { r: 0.1, holes: [[[20.7, 1.3], [21.0, 1.3], [21.0, 1.7], [20.7, 1.7]]] }));
  b.add('steel', side([[6.5, 1.2], [7.0, 1.2], [7.0, 2.4], [11.0, 2.4], [11.0, 1.2], [11.5, 1.2], [11.5, 2.8], [6.5, 2.8]], 0.4, { r: 0.1 }));
  muzzleDev(b, 23.3, 0.36, 1.3);
  pistolGrip(b, 2.45, 4.05, -1.28, 4.1, 18, 'stipple', 1.1);
  b.add('park', side([[4.05, -1.26], [6.85, -1.26], [6.85, -1.5], [6.55, -2.38], [4.6, -2.4], [4.1, -1.95]], 0.42, { r: 0.12, holes: [[[4.3, -1.42], [6.62, -1.42], [6.4, -2.24], [4.72, -2.25], [4.32, -1.88]]] }));
  trigger(b, 5.1, -1.35);
  // folding stock (folded? keep extended skeleton)
  b.add('park', side([[0.3, 0.2], [-9.0, -0.8], [-9.2, -5.0], [-8.6, -5.2], [-8.3, -1.9], [0.3, -1.1]], 1.0, { r: 0.2, bevel: 0.08, holes: [[[-7.8, -1.3], [-1.0, -0.7], [-1.0, -0.8], [-7.6, -1.65]]] }));
  b.add('rubber', side([[-9.6, -0.6], [-9.1, -0.6], [-9.1, -5.2], [-9.6, -5.2]], 1.3, { r: 0.2 }));
  b.part('bolt', [0, 0.2, -7.6]);
  b.add('steel', cyl(0.1, 0.1, 1.2, 10, { axis: 'x' }), { p: [0.95, 0.25, -7.6], r: [0, 0, -15] });
  b.add('polymer', sphere(0.2, 10, 8), { p: [1.5, 0.4, -7.6] });
  b.part('body');
  b.part('mag', [0, -1.3, -9.3]);
  const M = akMagProfile({ top: [8.05, -0.8], R: 14, len: 8.2, d0: 2.25, d1: 2.45 });
  b.add('park', side([...M.back, ...M.front.slice().reverse()], 1.1, { r: 0.12, bevel: 0.06 }), { c: 0xaaaaaa });
  b.part('body');
  b.anchor('muzzle', [0, 0, -24.65]); b.anchor('eject', [0.7, 0.1, -6.7]); b.anchor('pivot', [0, -1.2, -7.5]);
  return { ...H(RH(3.35, -2.15, 18), LHg(14.6, -1.55, -0.55), { magGrab: MAGG(9.6, -3.6), chargeGrab: { p: [1.4, 0.8, -7.3], across: [0, 0, 1], palm: [-0.4, -0.9, 0], pose: 'pinch' } }), magPivot: 'rock', boltTravel: 3.6 };
}

export function buildFAMAS(b) {
  const D = b.detail;
  // bullpup: long body, mag behind the trigger, long carry handle with the cocking lever
  b.add('polymer', side([[-9.5, 0.8], [8.5, 0.8], [9.0, 0.3], [9.0, -1.2], [5.5, -1.3], [1.0, -1.4], [-6.5, -1.4], [-9.0, -3.8], [-10.3, -3.9], [-10.3, 0.5]], 1.7, { r: 0.25, bevel: 0.2, bseg: 3 }));
  b.add('polymer', side([[-1.5, 0.8], [0.0, 0.8], [0.6, 3.0], [8.8, 3.0], [9.4, 0.8], [10.2, 0.8], [9.2, 3.4], [-0.6, 3.4]], 1.0, { r: 0.2, bevel: 0.12 }));
  b.add('rubber', side([[-10.8, 0.6], [-10.3, 0.6], [-10.3, -4.0], [-10.8, -4.0]], 1.8, { r: 0.3 }));
  b.add('park', lathe([[0.4, 8.9], [0.36, 12], [0.33, 15.5], [0.3, 15.6]], 16));
  muzzleDev(b, 15.4, 0.4, 1.6);
  if (D) for (const s of [1, -1]) b.add('steel', cyl(0.1, 0.1, 6.5, 8, { u0: 2.5 }), { p: [s * 0.95, -0.2, 0] });
  pistolGrip(b, 3.5, 5.0, -1.3, 3.9, 12, 'stipple', 1.1);
  guard(b, 5.0, 7.3, -1.3, 'polymer', 1.5, 1.0);
  trigger(b, 5.7, -1.35);
  b.part('bolt', [0, 2.5, -4]);
  b.add('steel', side([[3.2, 2.2], [4.6, 2.2], [4.6, 2.9], [3.2, 2.9]], 0.3, { r: 0.1 }));
  b.part('body');
  straightMag(b, -4.2, -2.2, -1.3, 4.5, 0.85, 'alu', 0.2);
  b.anchor('muzzle', [0, 0, -17.1]); b.anchor('eject', [0.9, 0, 2]); b.anchor('pivot', [0, -1.5, -1]);
  return { ...H(RH(4.35, -2.2, 12), LHg(7.8, -2.3, -0.9), { magGrab: MAGG(-3.2, -3.6), chargeGrab: { p: [0, 2.7, -3.9], across: [1, 0, 0], palm: [0, -1, 0], pose: 'pinch' } }), magPivot: 'straight', boltTravel: 2.4, elbowR: [6, -5, 5] };
}

export function buildAUG(b) {
  const D = b.detail;
  // green polymer bullpup stock, integrated optic, translucent mag behind the grip
  b.add('polymer_od', side([[-10.0, 0.9], [7.0, 0.9], [7.5, 0.3], [7.5, -1.2], [2.0, -1.3], [0.0, -1.5], [-6.5, -1.5], [-9.0, -3.6], [-10.4, -3.7], [-10.4, 0.6]], 2.0, { r: 0.35, bevel: 0.3, bseg: 3 }));
  b.add('polymer_od', side([[0.0, -1.4], [5.5, -1.4], [5.9, -2.2], [5.3, -4.6], [4.3, -4.7], [4.4, -2.4], [1.2, -2.4], [0.6, -4.4], [-0.4, -4.4], [0.0, -2.0]], 1.2, { r: 0.3, bevel: 0.25, bseg: 3 }));
  b.add('rubber', side([[-10.9, 0.7], [-10.4, 0.7], [-10.4, -3.8], [-10.9, -3.8]], 1.9, { r: 0.3 }));
  b.add('alu', cyl(0.6, 0.6, 4.0, 18, { u0: 7.4 }), { p: [0, 0.1, 0] });
  b.add('park', lathe([[0.4, 11.3], [0.36, 14], [0.33, 18.0], [0.3, 18.1]], 16));
  muzzleDev(b, 17.8, 0.38, 1.4);
  // integrated 1.5x optic on a handle
  b.add('polymer_od', side([[-2.5, 0.9], [5.5, 0.9], [5.0, 1.8], [-2.0, 1.8]], 0.9, { r: 0.25, bevel: 0.12 }));
  b.add('polymer_od', lathe([[0.62, -3.0], [0.72, -2.8], [0.72, -1.0], [0.55, -0.6], [0.55, 3.5], [0.8, 4.4], [0.85, 6.2], [0.78, 6.4]], 24), { p: [0, 2.6, 0] });
  b.add('lens', cyl(0.72, 0.72, 0.04, 20, { u0: 6.25 }), { p: [0, 2.6, 0] });
  b.add('lens', cyl(0.6, 0.6, 0.04, 20, { u0: -2.95 }), { p: [0, 2.6, 0] });
  b.anchor('sight', [0, 2.6, 3.5]);
  trigger(b, 2.6, -1.45, 'polymer');
  b.part('bolt', [0, 0.4, -6]);
  b.add('steel', cyl(0.12, 0.12, 0.8, 10, { axis: 'x' }), { p: [-1.3, 0.4, -6] });
  b.part('body');
  b.part('mag', [0, -1.5, -3.5]);
  b.add('glass_green', side([[-5.2, -1.3], [-2.7, -1.3], [-2.4, -6.0], [-4.7, -6.2]], 0.9, { r: 0.15, bevel: 0.06 }), { c: 0xaaaaaa });
  b.add('polymer', box(1.05, 0.3, 2.5, { r: 0.08 }), { p: [0, -6.15, 3.6] });
  if (D) b.add('brass', box(0.45, 3.5, 1.9, { r: 0.1 }), { p: [0, -3.2, 3.9] });
  b.part('body');
  b.anchor('muzzle', [0, 0, -19.3]); b.anchor('eject', [1.0, 0, 2.5]); b.anchor('pivot', [0, -1.5, -1]);
  return { ...H(RH(-0.1 + 0.3, -2.4, 16), { p: [-0.8, -3.3, -4.9], across: [0, -1, 0.1], palm: [1, 0, -0.15], pose: 'grip' }, { magGrab: MAGG(-3.8, -4.2) }), magPivot: 'straight', scope: true, boltTravel: 2.4 };
}

export function buildSG553(b) {
  const D = b.detail;
  b.add('alu', side([[0, -0.6], [9.0, -0.6], [9.0, 0.9], [0.2, 0.9], [0, 0.6]], 1.2, { r: 0.1, bevel: 0.06 }));
  picatinny(b, 'alu', 0.3, 8.5, 0.9);
  b.add('polymer', side([[0, -0.6], [7.0, -0.6], [7.0, -1.5], [4.5, -1.6], [0, -1.5]], 1.25, { r: 0.12, bevel: 0.06 }));
  b.add('polymer', side([[9.0, 0.7], [16.0, 0.7], [16.2, -1.4], [9.0, -1.4]], 1.9, { r: 0.35, bevel: 0.3, bseg: 3 }));
  if (D) for (let i = 0; i < 7; i++) for (const s of [1, -1]) b.add('dark', box(0.05, 0.5, 0.45, { r: 0.1 }), { p: [s * 0.9, -0.3, -(9.8 + i * 0.85)] });
  b.add('park', lathe([[0.4, 16.0], [0.34, 17], [0.32, 20.5], [0.3, 20.6]], 16));
  muzzleDev(b, 20.4, 0.36, 1.2);
  pistolGrip(b, 0.9, 2.5, -1.45, 3.9, 16, 'stipple', 1.1);
  guard(b, 2.5, 4.6, -1.45, 'polymer', 0.5, 0.85);
  trigger(b, 3.2, -1.5);
  b.add('polymer', side([[-0.2, 0.6], [-9.5, 0.4], [-9.8, -3.2], [-9.0, -3.4], [-5.0, -1.8], [-0.2, -1.3]], 1.3, { r: 0.3, bevel: 0.2, holes: [[[-7.5, -0.3], [-1.5, 0.1], [-1.5, -0.8], [-7.0, -1.6]]] }));
  scope(b, 2.3, { u0: 0.3, len: 7.5, tube: 0.5, obj: 0.8, oc: 0.72, tr: 0.35, th: 0.6, rings: [1.8, 5.2], parallax: false });
  b.part('bolt', [0, 0.3, -7.5]);
  b.add('steel', cyl(0.1, 0.1, 1.0, 10, { axis: 'x' }), { p: [0.95, 0.3, -7.5] });
  b.add('polymer', sphere(0.2, 10, 8), { p: [1.45, 0.3, -7.5] });
  b.part('body');
  b.part('mag', [0, -1.5, -7.0]);
  const M = akMagProfile({ top: [5.9, -1.0], R: 16, len: 7.0, d0: 2.2, d1: 2.3 });
  b.add('glass_green', side([...M.back, ...M.front.slice().reverse()], 0.9, { r: 0.1, bevel: 0.05 }), { c: 0xbbbbbb });
  b.part('body');
  b.anchor('muzzle', [0, 0, -21.7]); b.anchor('eject', [0.62, 0.2, -5]); b.anchor('pivot', [0, -1.5, -5.5]);
  return { ...H(RH(1.8, -2.4, 16), LHg(12.5, -2.0, -0.65), { magGrab: MAGG(6.5, -4.0), chargeGrab: { p: [1.4, 0.8, -7.3], across: [0, 0, 1], palm: [-0.4, -0.9, 0], pose: 'pinch' } }), magPivot: 'rock', scope: true, boltTravel: 3.0 };
}
