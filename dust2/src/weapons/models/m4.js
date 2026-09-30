// M4A4 / M4A1-S: flat-top AR-15 upper + lower, quad-rail or slim handguard, collapsible stock,
// STANAG magazine, A2 birdcage or suppressor. Gun space per geo.js; profiles in (u, v).
import * as G from './geo.js';

const { side, cross, lathe, cyl, box, sphere, torus, deform, screw, picatinny } = G;

/** STANAG aluminium magazine into part 'mag' (top rear at u0, top at v0). n = 30 | 20. */
export function stanag(b, u0 = 4.45, v0 = -1.0, n = 30, mat = 'alu') {
  const len = n === 30 ? 7.0 : 5.0, d = 2.45;
  b.part('mag', [0, v0, -(u0 + d)]);
  // straight top section then a gentle forward curve over the lower half
  const back = [], front = [];
  for (let i = 0; i <= 10; i++) {
    const s = i / 10, y = v0 - s * len;
    const bend = s > 0.45 ? Math.pow((s - 0.45) / 0.55, 2) * (n === 30 ? 0.75 : 0.2) : 0;
    back.push([u0 + bend, y]); front.push([u0 + d + bend * 1.15, y]);
  }
  b.add(mat, side([...back, ...front.reverse()].map((p, i, a) => [p[0], p[1], i === 0 || i === a.length - 1 ? 0.03 : 0.12]), 0.87, { bevel: 0.05, r: 0.1 }), { c: 0xc8c8c8 });
  if (b.detail) {
    // pressed side ribs + witness-hole row
    for (const f of [0.18, 0.82]) {
      const pts = [];
      for (let i = 1; i < 10; i++) { const p = back[i], q = front[10 - i]; pts.push([p[0] + (q[0] - p[0]) * f, p[1]]); }
      const rib = [...pts.map((p) => [p[0] - 0.07, p[1]]), ...pts.slice().reverse().map((p) => [p[0] + 0.07, p[1]])];
      b.add(mat, side(rib.map((p) => [p[0], p[1], 0.04]), 0.93, { bevel: 0.03, cseg: 2 }), { c: 0xc8c8c8 });
    }
    b.add(mat, side([[u0 + 0.35, v0 - 0.6], [u0 + d - 0.35, v0 - 0.6], [u0 + d - 0.35, v0 - 1.2], [u0 + 0.35, v0 - 1.2]].map((p) => [...p, 0.08]), 0.93, { bevel: 0.03 }), { c: 0xc8c8c8 });
    // rounds visible at the feed lips
    b.add('brass', lathe([[0.001, 0], [0.18, 0.02], [0.19, 1.5], [0.14, 1.7], [0.12, 1.85]], 10), { p: [0, v0 + 0.22, -(u0 + 0.1)], r: [-3, 0, 0] });
    b.add('copper', lathe([[0.12, 0], [0.12, 0.12], [0.07, 0.55], [0.001, 0.68]], 10), { p: [0, v0 + 0.13, -(u0 + 1.95)], r: [-3, 0, 0] });
  }
  // polymer floor plate
  const fb = back[10], ff = front[0];
  b.add('polymer', box(1.0, 0.28, ff[0] - fb[0] + 0.3, { r: 0.08 }), { p: [0, fb[1] - 0.08, -(fb[0] + ff[0]) / 2], r: [n === 30 ? -8 : -2, 0, 0] });
  b.part('body');
  return { top: [u0, v0], d };
}

export function buildM4(b, key) {
  const D = b.detail;
  const S = key === 'm4a1s';
  // ---------------- upper receiver (flat-top) ----------------
  b.add('alu', side([[0, -0.55], [7.1, -0.55], [7.1, 0.35], [6.9, 0.85], [0.15, 0.85], [0, 0.6]], 1.05, { r: 0.08, bevel: 0.06 }));
  // shell deflector + forward assist housing (right)
  b.add('alu', side([[0.9, 0.0], [2.5, 0.0], [2.5, 0.8], [1.2, 0.8], [0.9, 0.55]], 1.35, { r: 0.12, bevel: 0.06 }));
  b.add('alu', cyl(0.28, 0.26, 1.1, 14, {}), { p: [0.62, 0.35, -1.4], r: [0, -35, 0] });
  if (D) {
    b.add('steel', cyl(0.18, 0.2, 0.35, 14, {}), { p: [0.98, 0.35, -0.9], r: [0, -35, 0] });
    // ejection port + dust cover (right)
    b.add('dark', side([[2.6, -0.15], [5.1, -0.15], [5.1, 0.55], [2.6, 0.55]], 0.02, { x: 0.53, bevel: 0 }));
    b.add('alu', side([[2.55, -0.2], [5.15, -0.2], [5.15, 0.0], [2.55, 0.0]], 0.08, { x: 0.56, bevel: 0.02, r: 0.03 }));
    b.add('bright', side([[2.9, 0.05], [4.8, 0.05], [4.8, 0.48], [2.9, 0.48]], 0.02, { x: 0.535, bevel: 0 }));
    // takedown pin heads, both sides
    for (const s of [1, -1]) { G.rivet(b, 'steel', [0.55 * s, -0.45, -0.6], 0.14, s); G.rivet(b, 'steel', [0.55 * s, -0.35, -6.7], 0.14, s); }
  }
  // picatinny on top of the upper
  picatinny(b, 'alu', 0.1, 7.0, 0.85);
  // charging handle (part 'bolt' so it can be pulled)
  b.part('bolt', [0, 0.95, 0.3]);
  b.add('alu', side([[-0.6, 0.8], [0.9, 0.8], [0.9, 1.05], [-0.6, 1.05]], 0.5, { r: 0.05, bevel: 0.03 }));
  b.add('alu', side([[-0.85, 0.72], [-0.45, 0.72], [-0.45, 1.1], [-0.85, 1.1]], 1.6, { r: 0.1, bevel: 0.05 }));
  b.anchor('charge', [0, 0.95, 0.6]);
  b.part('body');
  // ---------------- lower receiver ----------------
  b.add('alu', side([[-0.1, -0.5], [6.95, -0.5], [6.95, -1.2], [6.8, -2.2], [4.2, -2.2], [4.0, -1.3], [0.5, -1.3], [-0.1, -1.0]], 1.0, { r: 0.1, bevel: 0.06 }));
  // magwell flare + front lip
  b.add('alu', side([[4.15, -1.7], [6.85, -1.7], [6.8, -2.3], [4.2, -2.3]], 1.14, { r: 0.06, bevel: 0.05 }));
  // buffer tube tang / castle nut region
  b.add('alu', side([[-0.35, -0.4], [0.2, -0.4], [0.2, 0.55], [-0.35, 0.55]], 1.0, { r: 0.1, bevel: 0.05 }));
  if (D) {
    // selector (left side, visible) + bolt catch paddle + mag release (right)
    b.add('steel', cyl(0.24, 0.24, 0.1, 16, { axis: 'x' }), { p: [-0.55, -0.85, -1.25] });
    b.add('steel', side([[0.9, -0.95], [1.35, -0.75], [1.4, -0.6], [0.95, -0.72]], 0.08, { x: -0.6, r: 0.05, bevel: 0.02 }));
    b.add('steel', side([[3.95, -0.45], [4.9, -0.35], [5.0, -0.8], [4.1, -0.95]], 0.12, { x: -0.56, r: 0.08, bevel: 0.03 }));
    b.add('steel', cyl(0.2, 0.2, 0.18, 14, { axis: 'x' }), { p: [0.58, -1.05, -4.05] });
    b.add('alu', cyl(0.32, 0.32, 0.08, 16, { axis: 'x' }), { p: [0.52, -1.05, -4.05] });
    // trigger / hammer pins
    for (const s of [1, -1]) { G.rivet(b, 'steel', [0.51 * s, -0.95, -2.2], 0.08, s); G.rivet(b, 'steel', [0.51 * s, -0.95, -3.1], 0.08, s); }
  }
  // trigger guard (flat, lower rear) + trigger
  b.add('alu', side([[1.9, -1.25], [4.1, -1.25], [4.1, -2.05], [2.3, -2.1], [1.95, -1.9]], 0.55, { r: 0.12, bevel: 0.04, holes: [[[2.25, -1.35], [3.9, -1.35], [3.9, -1.9], [2.4, -1.94], [2.2, -1.75]]] }));
  b.part('trigger', [0, -1.3, -2.9]);
  b.add('steel', side([[2.75, -1.25], [3.05, -1.25], [3.0, -1.6], [2.85, -1.85], [2.7, -1.88], [2.78, -1.55]], 0.22, { r: 0.06, bevel: 0.03 }));
  b.part('body');
  // A2 pistol grip with finger nub
  const grip = side([[0.25, -1.28], [1.95, -1.28], [1.8, -1.9], [1.62, -2.55], [1.72, -2.85], [1.55, -3.1], [1.35, -3.9], [1.28, -4.75], [0.05, -4.85], [-0.05, -4.2], [0.05, -3.2], [0.2, -2.2]], 1.08, { r: 0.22, bevel: 0.24, bseg: 3, cseg: 5 });
  b.add('stipple', grip);
  // ---------------- buffer tube + collapsible stock ----------------
  b.add('alu', cyl(0.58, 0.58, 7.6, 20, { u0: -7.9 }), { p: [0, 0.18, 0] });
  if (D) b.add('steel', lathe([[0.72, -0.45], [0.75, -0.4], [0.75, -0.2], [0.62, -0.15]], 20), { p: [0, 0.18, 0] });
  const stock = side(S
    ? [[-3.8, 1.0], [-10.2, 0.95], [-10.4, 0.7], [-10.4, -3.4], [-9.9, -3.6], [-8.2, -2.4], [-6.2, -0.95], [-3.8, -0.75]]
    : [[-4.2, 0.95], [-10.0, 0.95], [-10.3, 0.6], [-10.3, -3.3], [-9.6, -3.4], [-9.0, -2.3], [-7.8, -1.35], [-6.0, -0.7], [-4.2, -0.6]], 1.55, { r: 0.35, bevel: 0.25, bseg: 3, cseg: 4 });
  b.add('polymer', stock);
  b.add('rubber', side([[-10.65, 1.0], [-10.25, 1.0], [-10.25, -3.45], [-10.65, -3.4]], 1.7, { r: 0.2, bevel: 0.1 }));
  if (D) {
    b.add('steel', box(0.3, 0.25, 1.1, { r: 0.05 }), { p: [0, -0.62, 5.8] });   // adjustment lever
    G.slingLoop(b, 'steel', [0, -0.95, 9.7], [0, 0, 90], 0.28);
  }
  // ---------------- barrel, gas block / FSB, muzzle ----------------
  b.add('park', lathe([[0.62, 7.0], [0.62, 7.6], [0.4, 7.7], [0.38, 14.5], [0.33, 16.3], [0.31, 16.4], [0.31, S ? 18.6 : 21.6]], 18));
  if (!S) {
    // A-frame front sight base
    b.add('park', lathe([[0.48, 14.7], [0.5, 14.8], [0.5, 15.8], [0.46, 15.9]], 18));
    b.add('park', side([[14.9, 0.3], [15.8, 0.3], [15.6, 1.2], [15.55, 2.05], [15.2, 2.1], [15.05, 1.2]], 0.62, { r: 0.08, bevel: 0.05, holes: [[[15.22, 1.25], [15.43, 1.25], [15.4, 1.8], [15.25, 1.8]]] }));
    b.add('park', cross([[-0.42, 0], [0.42, 0], [0.42, 0.3, 0.1], [0.1, 0.62], [-0.1, 0.62], [-0.42, 0.3, 0.1]].map((p) => [p[0], p[1]]), 0.55, { u0: 15.1, bevel: 0.03 }), { p: [0, 1.7, 0] });
    b.add('steel', cyl(0.05, 0.06, 0.55, 8, { axis: 'y' }), { p: [0, 2.15, -15.35] });
    b.add('park', side([[15.0, -0.45], [15.8, -0.45], [15.65, -0.95], [15.15, -0.95]], 0.5, { r: 0.08 }));
    G.slingLoop(b, 'steel', [0, -1.2, -15.4], [0, 90, 0], 0.26);
    // A2 birdcage flash hider
    b.add('park', lathe([[0.31, 21.6], [0.36, 21.65], [0.36, 23.2], [0.3, 23.3], [0.22, 23.3], [0.22, 21.8]], 18));
    if (D) for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.6;
      b.add('dark', box(0.08, 0.04, 0.9, { r: 0.015 }), { p: [Math.cos(a) * 0.35, Math.sin(a) * 0.35, -22.65], r: [0, 0, a * 57.3 + 90] });
    }
  } else {
    // low-profile gas block
    b.add('park', side([[14.9, -0.35], [15.8, -0.35], [15.8, 0.5], [14.9, 0.5]], 0.8, { r: 0.08, bevel: 0.04 }));
  }
  // ---------------- handguard ----------------
  if (!S) {
    // KAC-style quad rail with ladder covers on the sides
    const hgPts = [[-0.95, -0.95, 0.25], [0.95, -0.95, 0.25], [0.95, 0.95, 0.25], [-0.95, 0.95, 0.25]];
    b.add('alu', cross(hgPts, 6.9, { u0: 7.3, bevel: 0.05, cseg: 3 }), { p: [0, 0.18, 0] });
    b.add('alu', lathe([[0.95, 7.1], [1.02, 7.15], [1.02, 7.45], [0.95, 7.5]], 20), { p: [0, 0.18, 0] });
    picatinny(b, 'alu', 7.35, 6.8, 1.13);
    picatinny(b, 'alu', 7.35, 6.8, -0.77, { rot: 180 });
    // ladder rail covers (left & right) — ribbed polymer strips
    for (const s of [1, -1]) {
      b.push([s * 1.02, 0.18, 0], [0, 0, 0]);
      b.add('polymer', box(0.18, 0.9, 5.4, { r: 0.06 }), { p: [s * 0.04, 0, -10.8] });
      if (D) for (let i = 0; i < 13; i++) b.add('polymer', box(0.14, 0.95, 0.12, { r: 0.04 }), { p: [s * 0.12, 0, -8.5 - i * 0.39] });
      b.pop();
    }
    b.add('alu', lathe([[1.0, 14.1], [1.02, 14.15], [1.02, 14.35], [0.6, 14.4]], 20), { p: [0, 0.18, 0] });
  } else {
    // slim round free-float handguard with short top rail + vent slots
    b.add('alu', lathe([[0.92, 7.2], [0.98, 7.3], [0.98, 17.9], [0.92, 18.0], [0.5, 18.05]], 24), { p: [0, 0.12, 0] });
    picatinny(b, 'alu', 7.25, 4.2, 1.1);
    if (D) for (let i = 0; i < 9; i++) for (const s of [1, -1]) b.add('dark', box(0.05, 0.3, 0.8, { r: 0.1 }), { p: [s * 0.96, 0.05, -(9.4 + i * 0.95)] });
  }
  // flip-up rear sight on the upper rail
  if (D && !S) {
    b.add('alu', side([[0.6, 1.2], [1.6, 1.2], [1.55, 1.55], [0.7, 1.55]], 0.9, { r: 0.06, bevel: 0.03 }));
    b.add('alu', side([[0.95, 1.5], [1.25, 1.5], [1.2, 2.2], [1.0, 2.2]], 0.7, { r: 0.05, bevel: 0.03, holes: [[[1.05, 1.85], [1.15, 1.85], [1.15, 2.05], [1.05, 2.05]]] }));
  }
  // ---------------- suppressor (M4A1-S) ----------------
  if (S) {
    b.part('silencer', [0, 0, -19.0]);
    b.add('park', lathe([[0.3, 18.6], [0.68, 18.7], [0.78, 19.0], [0.78, 26.6], [0.7, 26.9], [0.2, 26.95], [0.18, 26.8]], 28), { c: 0xd8d8d8 });
    if (D) {
      for (const u of [19.2, 26.0]) b.add('park', lathe([[0.8, u], [0.82, u + 0.05], [0.82, u + 0.4], [0.8, u + 0.45]], 28), { c: 0xb0b0b0 });
      b.add('dark', cyl(0.17, 0.17, 0.05, 12, { u0: 26.92 }));
    }
    b.anchor('muzzle_s', [0, 0, -27.0]);
    b.anchor('silGrab', [0, 0, -23.5]);
    b.part('body');
    // thread + short barrel end (visible when detached)
    b.add('steel', cyl(0.3, 0.3, 0.8, 16, { u0: 18.3 }));
  }
  // ---------------- magazine ----------------
  stanag(b, 4.4, -1.0, S ? 20 : 30);

  b.anchor('muzzle', [0, 0, S ? -19.2 : -23.35]);
  b.anchor('eject', [0.62, 0.25, -3.9]);
  b.anchor('pivot', [0, -1.0, -5.5]);
  const hands = {
    R: { p: [0.98, -2.2, -0.8], across: [0, -0.96, 0.28], palm: [-1, 0, -0.05], pose: 'trigger' },
    L: S ? { p: [-0.55, -1.08, -11.0], across: [0, 0.05, 1], palm: [0.45, 0.9, 0], pose: 'wrap' }
      : { p: [-0.55, -1.12, -11.2], across: [0, 0.05, 1], palm: [0.45, 0.9, 0], pose: 'wrap' },
    magGrab: { p: [-0.62, -3.2, -5.6], across: [0, 0, 1], palm: [0.95, 0.1, -0.2], pose: 'cup' },
    chargeGrab: { p: [0.15, 1.9, 0.95], across: [1, 0, 0], palm: [0, -0.9, -0.4], pose: 'pinch' },
    silGrab: { p: [-0.95, 0.0, -23.5], across: [0, 0.1, 1], palm: [0.95, 0.2, 0], pose: 'cup' },
  };
  return { hands, magPivot: 'straight', boltTravel: 2.4, silencer: S, inspectL: [0.5, -3.2, -6.5] };
}
