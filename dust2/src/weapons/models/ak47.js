// AK-47 (AKM pattern): stamped receiver, ribbed dust cover, laminated wood furniture,
// bakelite grip, curved steel 30-rd magazine, slant brake. Gun space per geo.js
// (inches, muzzle -Z); profiles authored in (u forward from receiver rear, v up from bore).
import * as G from './geo.js';

const { side, cross, lathe, cyl, box, sphere, torus, deform, rivet, screw } = G;

// Curved AK magazine side profile. Returns { pts, center(t) } in (u, v).
export function akMagProfile({ top = [8.05, -0.8], R = 13.5, len = 8.6, d0 = 2.3, d1 = 2.55, n = 14 } = {}) {
  const C = [top[0] + R, top[1]];
  const at = (s) => {
    const th = s / R;
    return { p: [C[0] - R * Math.cos(th), C[1] - R * Math.sin(th)], n: [Math.cos(th), Math.sin(th)] };
  };
  const back = [], front = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * len, { p, n: nn } = at(s);
    const d = d0 + (d1 - d0) * (i / n);
    // normal (pointing "forward" in the local frame is along the tangent-perp)
    front.push([p[0] + nn[0] * d / 2, p[1] + nn[1] * d / 2]);
    back.push([p[0] - nn[0] * d / 2, p[1] - nn[1] * d / 2]);
  }
  return { back, front, at, R, len };
}

export function buildAK47(b) {
  const D = b.detail;
  // ---------------- receiver ----------------
  b.add('steel', side([[0, 0.42], [0.1, -1.1], [0.45, -1.3], [8.6, -1.3], [9.2, -1.18], [10.2, -1.18], [10.2, 0.42]], 1.14, { r: 0.06, bevel: 0.05 }));
  // rolled top rails the dust cover sits on
  b.add('steel', box(1.22, 0.1, 9.9, { r: 0.04 }), { p: [0, 0.4, -5.1] });
  // rear trunnion block + stock tang
  b.add('steel', side([[-0.35, 0.36], [0.6, 0.36], [0.6, -1.2], [-0.2, -1.2], [-0.35, -1.0]], 1.2, { r: 0.08, bevel: 0.05 }));
  // front trunnion (slightly proud)
  b.add('steel', side([[8.65, 0.38], [10.25, 0.38], [10.25, -1.12], [8.65, -1.12]], 1.2, { r: 0.07, bevel: 0.05 }));
  // magazine well lips (front + rear) under the receiver
  b.add('steel', side([[6.72, -1.28], [7.05, -1.28], [7.0, -1.48], [6.78, -1.48]], 1.18, { r: 0.04 }));
  b.add('steel', side([[9.05, -1.2], [9.55, -1.2], [9.5, -1.42], [9.1, -1.42]], 1.18, { r: 0.04 }));
  if (D) {
    // rivets: front trunnion, rear trunnion, trigger-group pins (both sides)
    for (const s of [1, -1]) {
      const x = 0.6 * s;
      for (const [u, v] of [[9.0, -0.25], [9.0, -0.92], [9.72, -0.58], [9.95, -0.98], [0.25, -0.2], [0.25, -0.95], [8.1, -1.05], [7.3, -1.05]]) rivet(b, 'steel', [x, v, -u], 0.1, s);
      for (const [u, v] of [[4.35, -0.8], [5.35, -0.85], [2.2, -0.75]]) rivet(b, 'steel', [x, v, -u], 0.085, s);
      // magazine-well dimples (AKM): shallow ovals read as a raised stamped ring
      for (const u of [7.55, 8.25]) b.add('steel', torus(0.12, 0.028, { rs: 5, ts: 14 }), { p: [x * 1.005, -0.72, -u], r: [0, 90, 0], s: [1, 1.5, 1] });
    }
    // stamped side reinforcement plate around the magazine well (left & right)
    b.add('steel', side([[6.6, -0.45], [9.1, -0.45], [9.1, -1.28], [6.6, -1.28]], 1.2, { r: 0.12, bevel: 0.03 }));
  }
  // ---------------- dust cover ----------------
  const dc = [[-0.61, 0], [0.61, 0], [0.61, 0.28, 0.1], [0.5, 0.62, 0.25], [0, 0.76, 0.3], [-0.5, 0.62, 0.25], [-0.61, 0.28, 0.1]];
  b.add('steel', cross(dc, 9.0, { u0: 0.35, bevel: 0.04, cseg: 4 }), { p: [0, 0.4, 0] });
  // rounded rear end of the cover
  b.add('steel', sphere(0.61, 16, 8, { tLen: Math.PI / 2 }), { p: [0, 0.42, -0.35], r: [90, 0, 0], s: [1, 0.5, 1.22] });
  if (D) {
    // transverse stiffening ribs
    for (const u of [1.6, 3.1, 4.6, 6.1, 7.6]) {
      b.add('steel', cross(dc.map((p) => [p[0] * 1.03, p[1] * 1.04 - 0.005, 0.06]), 0.16, { u0: u, bevel: 0.03, cseg: 3 }), { p: [0, 0.4, 0] });
    }
    // recoil spring guide button poking through the rear of the cover
    b.add('steel', cyl(0.13, 0.12, 0.28, 12, { u0: -0.55 }), { p: [0, 0.62, 0] });
  }
  // ---------------- rear sight block + leaf ----------------
  b.add('steel', side([[9.25, 0.4], [9.35, 0.95], [9.9, 1.05], [11.1, 1.18], [11.55, 0.95], [11.6, 0.2], [9.25, 0.2]], 1.2, { r: 0.08, bevel: 0.05 }));
  b.add('steel', side([[9.8, 1.05], [11.3, 1.3], [11.3, 1.42], [9.9, 1.2]], 0.72, { r: 0.03, bevel: 0.02 }));
  if (D) {
    // notch block at the rear of the leaf + sliding range adjuster
    for (const x of [-0.24, 0.24]) b.add('steel', box(0.26, 0.3, 0.28, { r: 0.03 }), { p: [x, 1.3, -9.85] });
    b.add('blued', box(0.9, 0.2, 0.34, { r: 0.04 }), { p: [0, 1.32, -10.55] });
    b.add('blued', box(0.14, 0.14, 0.2, { r: 0.03 }), { p: [0.48, 1.32, -10.55] });
    b.add('blued', box(0.14, 0.14, 0.2, { r: 0.03 }), { p: [-0.48, 1.32, -10.55] });
    // leaf spring pin
    b.add('steel', cyl(0.07, 0.07, 1.3, 10, { axis: 'x' }), { p: [0, 0.98, -11.2] });
  }
  // ---------------- barrel, gas system ----------------
  b.add('blued', lathe([[0.6, 10.1], [0.55, 10.3], [0.42, 11.0], [0.36, 11.4], [0.33, 13], [0.31, 18.2], [0.3, 23.4], [0.29, 24.9], [0.24, 25.1]], 22));
  // gas tube (exposed front with vent holes) + gas block
  b.add('blued', cyl(0.33, 0.33, 7.4, 18, { u0: 11.4 }), { p: [0, 0.98, 0] });
  if (D) for (let i = 0; i < 3; i++) for (const x of [-0.325, 0.325]) b.add('dark', cyl(0.07, 0.07, 0.05, 8, { axis: 'x' }), { p: [x, 0.98, -(17.65 + i * 0.2)] });
  b.add('steel', side([[18.3, -0.42], [19.85, -0.42], [19.95, 0.2], [19.95, 1.28], [19.6, 1.42], [18.7, 1.42], [18.3, 1.05], [18.3, 0.7], [18.2, 0.5]], 0.9, { r: 0.1, bevel: 0.05 }));
  b.add('steel', lathe([[0.5, 18.3], [0.52, 18.4], [0.52, 19.8], [0.46, 19.95]], 20), {});
  b.add('steel', cyl(0.4, 0.38, 0.5, 18, { u0: 19.9 }), { p: [0, 0.98, 0] });
  if (D) {
    // bayonet lug + rod stop under the gas block
    b.add('steel', side([[19.0, -0.4], [20.4, -0.4], [20.4, -0.72], [19.3, -0.72]], 0.32, { r: 0.05 }));
    // gas block pin
    b.add('steel', cyl(0.06, 0.06, 1.0, 8, { axis: 'x' }), { p: [0, 1.05, -18.95] });
  }
  // ---------------- front sight block + ears ----------------
  b.add('steel', lathe([[0.46, 23.35], [0.48, 23.45], [0.48, 24.75], [0.44, 24.85]], 18));
  b.add('steel', side([[23.4, 0.2], [24.8, 0.2], [24.8, 0.55], [24.35, 1.12], [23.95, 1.22], [23.6, 1.02], [23.4, 0.55]], 0.62, { r: 0.1, bevel: 0.05 }));
  b.add('steel', side([[23.45, -0.35], [24.7, -0.35], [24.7, -0.95], [24.3, -1.0], [23.6, -0.62]], 0.55, { r: 0.1, bevel: 0.05 }));
  // protective ears (open-top U) and post
  b.add('steel', cross([[-0.42, 0], [0.42, 0], [0.42, 0.4, 0.12], [0.3, 0.65, 0.05], [0.22, 0.65], [0.25, 0.2, 0.1], [-0.25, 0.2, 0.1], [-0.22, 0.65], [-0.3, 0.65, 0.05], [-0.42, 0.4, 0.12]], 0.4, { u0: 23.85, bevel: 0.03, cseg: 3 }), { p: [0, 0.9, 0] });
  b.add('blued', cyl(0.045, 0.06, 0.45, 8, { axis: 'y' }), { p: [0, 1.3, -24.05] });
  // ---------------- slant muzzle brake ----------------
  const brake = lathe([[0.19, 24.85], [0.42, 24.85], [0.45, 24.95], [0.45, 26.3], [0.36, 26.3], [0.19, 26.2], [0.19, 25.0]], 24, { crease: 50 });
  b.add('blued', deform(brake, (v) => {
    const u = -v.z;
    if (u > 25.6) { const k = (u - 25.6) / 0.7; v.z = -(u - k * (v.y + 0.45) * 0.62); }
  }, 50));
  if (D) b.add('dark', cyl(0.18, 0.18, 0.1, 12, { u0: 25.2 }));
  // ---------------- cleaning rod ----------------
  b.add('blued', cyl(0.1, 0.1, 13.3, 10, { u0: 11.3 }), { p: [0, -0.72, 0] });
  b.add('blued', side([[24.35, -0.6], [24.75, -0.6], [24.75, -0.86], [24.35, -0.86]], 0.3, { r: 0.06 }));
  // ---------------- handguards (laminated wood) ----------------
  // lower: palm-swell profile, flares at the bottom
  const lower = side([[11.2, 0.25], [17.7, 0.25], [17.75, -0.2], [17.55, -0.95], [17.1, -1.2], [15.6, -1.36], [13.4, -1.4], [11.8, -1.32], [11.2, -1.05]], 1.95, { r: 0.18, bevel: 0.36, bseg: 4, cseg: 5 });
  b.add('wood_ak', deform(lower, (v) => {
    const t = Math.min(1, Math.max(0, (0.25 - v.y) / 1.6));
    v.x *= 0.8 + 0.2 * Math.sin(t * Math.PI * 0.85 + 0.2);
  }, 55));
  // upper gas-tube cover
  const up = cross([[-0.62, 0], [0.62, 0], [0.65, 0.3, 0.15], [0.52, 0.6, 0.22], [0, 0.73, 0.3], [-0.52, 0.6, 0.22], [-0.65, 0.3, 0.15]], 5.9, { u0: 11.55, bevel: 0.14, bseg: 3, cseg: 4 });
  b.add('wood_ak', up, { p: [0, 0.72, 0] });
  // handguard retainers (steel ferrules) + sling loop on the front one (left side)
  b.add('steel', side([[10.95, 0.35], [11.4, 0.35], [11.4, -1.12], [10.95, -1.1]], 1.72, { r: 0.1, bevel: 0.06 }));
  b.add('steel', side([[17.7, 0.28], [18.25, 0.28], [18.3, -0.7], [17.75, -1.05]], 1.25, { r: 0.1, bevel: 0.06 }));
  b.add('steel', cross([[-0.66, 0], [0.66, 0], [0.66, 0.3, 0.2], [0, 0.72, 0.3], [-0.66, 0.3, 0.2]], 0.35, { u0: 17.2, bevel: 0.04 }), { p: [0, 0.7, 0] });
  if (D) {
    G.slingLoop(b, 'steel', [-0.72, -0.35, -18.0], [0, 90, 0], 0.3);
    // handguard retainer lever (right side)
    b.add('steel', box(0.08, 0.3, 1.2, { r: 0.03 }), { p: [0.62, 0.75, -11.3], r: [8, 0, 0] });
  }
  // ---------------- pistol grip (bakelite) ----------------
  const grip = side([[2.45, -1.28], [4.05, -1.28], [3.9, -1.7], [3.62, -2.55], [3.32, -3.6], [3.1, -4.55], [3.0, -5.15, 0.2], [1.65, -5.28, 0.25], [1.72, -4.5], [1.95, -3.4], [2.2, -2.3], [2.35, -1.7]], 1.12, { r: 0.25, bevel: 0.26, bseg: 4, cseg: 5 });
  b.add('bakelite', deform(grip, (v) => { const t = Math.min(1, Math.max(0, (-1.3 - v.y) / 4)); v.x *= 0.92 + 0.12 * Math.sin(t * Math.PI); }, 55));
  if (D) b.add('steel', cyl(0.14, 0.14, 0.08, 12, { axis: 'y' }), { p: [0, -5.3, -2.3], r: [0, 0, 0] });
  // ---------------- trigger guard, trigger, mag release ----------------
  b.add('steel', side([[4.05, -1.26], [6.85, -1.26], [6.85, -1.5], [6.55, -2.38], [4.6, -2.4], [4.1, -1.95]], 0.42,
    { r: 0.12, bevel: 0.04, holes: [[[4.3, -1.42], [6.62, -1.42], [6.4, -2.24], [4.72, -2.25], [4.32, -1.88]]] }));
  b.add('steel', side([[6.8, -1.35], [7.05, -1.35], [7.12, -2.05], [6.98, -2.12], [6.85, -1.9]], 0.55, { r: 0.05, bevel: 0.03 }));
  b.part('trigger', [0, -1.35, -5.1]);
  b.add('blued', side([[4.95, -1.3], [5.3, -1.3], [5.25, -1.7], [5.08, -2.02], [4.92, -2.08], [4.98, -1.7]], 0.24, { r: 0.08, bevel: 0.03 }));
  b.part('body');
  // ---------------- right side: selector lever, ejection port, bolt carrier ----------------
  b.add('steel', side([[0.9, 0.05], [5.3, 0.3], [5.9, 0.28], [6.0, -0.1], [5.55, -0.25], [5.3, -0.05], [0.9, -0.3]], 0.07, { r: 0.08, bevel: 0.02, x: 0.62 }));
  b.add('steel', cyl(0.18, 0.18, 0.1, 14, { axis: 'x' }), { p: [0.64, -0.12, -1.05] });
  b.add('dark', side([[5.1, -0.25], [8.4, -0.25], [8.4, 0.38], [5.1, 0.38]], 0.02, { x: 0.575, bevel: 0 }));
  b.part('bolt', [0, 0.2, -7.6]);
  b.add('bright', side([[4.9, -0.2], [8.5, -0.2], [8.5, 0.34], [4.9, 0.34]], 0.9, { r: 0.08, bevel: 0.04 }));
  b.add('bright', side([[7.35, -0.02], [7.95, -0.02], [7.95, 0.34], [7.35, 0.34]], 0.5, { r: 0.08, bevel: 0.03, x: 0.72 }));
  b.add('bright', lathe([[0.001, 0.0], [0.16, 0.02], [0.2, 0.15], [0.2, 0.32], [0.14, 0.4], [0.001, 0.42]], 14), { p: [0.92, 0.16, -7.65], r: [0, -90, 0] });
  b.anchor('charge', [1.1, 0.16, -7.65]);
  b.part('body');
  // ---------------- stock (laminated wood) + buttplate ----------------
  const stock = side([[0.35, 0.3], [-0.4, 0.28], [-4.5, -0.75], [-8.55, -1.72], [-8.75, -1.9], [-8.75, -5.95], [-8.5, -6.1], [-5.0, -4.25], [-2.4, -2.55], [-0.9, -1.55], [0.35, -1.25]], 1.02, { r: 0.35, bevel: 0.32, bseg: 4, cseg: 5 });
  b.add('wood_ak', deform(stock, (v) => { const t = Math.min(1, Math.max(0, v.z / 8.75)); v.x *= 1 + 0.5 * t; }, 55));
  b.add('steel', side([[-8.98, -1.8], [-8.72, -1.8], [-8.72, -6.08], [-8.98, -6.0]], 1.52, { r: 0.12, bevel: 0.08 }));
  if (D) {
    G.slingLoop(b, 'steel', [-0.82, -3.9, 6.8], [0, 90, 0], 0.32);
    b.add('steel', box(0.14, 0.5, 1.0, { r: 0.05 }), { p: [-0.78, -3.9, 6.8] });
    screw(b, 'steel', [0, -1.82, 8.8], 0.1, 'y');
  }
  // ---------------- magazine (part: rocks around the front lug) ----------------
  b.part('mag', [0, -1.3, -9.3]);
  const M = akMagProfile();
  const magPts = [...M.back, ...M.front.slice().reverse()];
  b.add('steel', side(magPts.map((p, i) => [p[0], p[1], i === 0 || i === magPts.length - 1 ? 0.05 : 0.15]), 1.1, { r: 0.15, bevel: 0.07, bseg: 2, cseg: 3 }), { c: 0xb8b8b8 });
  if (D) {
    // lugs
    b.add('steel', side([[9.05, -0.8], [9.4, -0.8], [9.4, -1.35], [9.1, -1.35]], 0.9, { r: 0.04 }), { c: 0xb8b8b8 });
    b.add('steel', side([[6.8, -1.0], [7.05, -1.0], [7.05, -1.4], [6.8, -1.4]], 0.7, { r: 0.04 }), { c: 0xb8b8b8 });
    // stamped side ribs following the curve (both sides)
    for (const f of [0.25, 0.7]) {
      const rib = [];
      for (let i = 1; i < 13; i++) {
        const s = (i / 14) * M.len, th = s / M.R;
        const { p } = M.at(s);
        const d = 2.3 + 0.25 * (i / 14);
        const k = (f - 0.5) * d;
        rib.push([p[0] + Math.cos(th) * k, p[1] + Math.sin(th) * k]);
      }
      const pts = [...rib.map((q) => [q[0] - 0.08, q[1]]), ...rib.slice().reverse().map((q) => [q[0] + 0.08, q[1]])];
      b.add('steel', side(pts.map((q) => [q[0], q[1], 0.05]), 1.2, { bevel: 0.05, bseg: 2, cseg: 2 }), { c: 0xb8b8b8 });
    }
    // top rounds peeking between the feed lips
    b.add('brass', lathe([[0.001, 0], [0.2, 0.02], [0.22, 1.35], [0.17, 1.6], [0.15, 1.8]], 10), { p: [0, -0.62, -6.95], r: [-2, 0, 0] });
    b.add('copper', lathe([[0.15, 0], [0.155, 0.2], [0.09, 0.7], [0.001, 0.82]], 10), { p: [0, -0.66, -8.75], r: [-2, 0, 0] });
  }
  // floor plate with the tab
  const bt = M.at(M.len);
  b.push([0, bt.p[1], -bt.p[0]], [(M.len / M.R) * 57.3, 0, 0]);
  b.add('steel', box(1.24, 0.22, 2.75, { r: 0.08 }), { p: [0, -0.02, 0], c: 0xb0b0b0 });
  b.add('steel', box(0.5, 0.2, 0.4, { r: 0.06 }), { p: [0, -0.02, 1.45], c: 0xb0b0b0 });
  b.pop();
  b.part('body');

  // ---------------- anchors ----------------
  b.anchor('muzzle', [0, 0, -26.35]);
  b.anchor('eject', [0.7, 0.1, -6.7]);
  b.anchor('pivot', [0, -1.2, -7.5]);
  b.anchor('sight', [0, 1.35, -10.0]);
  return {
    hands: {
      R: { p: [0.98, -2.15, -2.5], across: [0, -0.968, 0.25], palm: [-1, 0, -0.05], pose: 'trigger' },
      L: { p: [-0.5, -1.45, -14.6], across: [0, 0.05, 1], palm: [0.42, 0.9, 0], pose: 'wrap' },
      magGrab: { p: [-0.55, -3.6, -9.6], across: [0, 0, 1], palm: [0.9, 0.1, -0.35], pose: 'cup' },
      chargeGrab: { p: [1.3, 0.55, -7.2], across: [0, 0, 1], palm: [-0.4, -0.9, 0], pose: 'pinch' },
    },
    magPivot: 'rock',
    boltTravel: 3.7,
  };
}
