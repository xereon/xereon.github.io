// Scoped rifles: AWP (Arctic Warfare Magnum), SSG 08, G3SG1, SCAR-20.
import * as G from './geo.js';
import { stanag } from './m4.js';

const { side, cross, lathe, cyl, box, sphere, torus, deform, screw, picatinny } = G;

/** Riflescope along the bore at height h. o: { u0 (ocular end), len, tube, obj, oc, turrets }. */
export function scope(b, h, o = {}) {
  const u0 = o.u0 ?? -1.5, L = o.len ?? 13.5, t = o.tube ?? 0.59, ob = o.obj ?? 1.15, oc = o.oc ?? 0.88;
  const mat = o.mat || 'alu';
  const u1 = u0 + L;
  b.push([0, h, 0]);
  b.add(mat, lathe([
    [oc * 0.82, u0], [oc, u0 + 0.1], [oc, u0 + 1.6], [oc * 0.92, u0 + 2.1], [t * 1.08, u0 + 3.0], [t, u0 + 3.2],
    [t, u1 - 4.2], [t * 1.05, u1 - 4.0], [ob * 0.95, u1 - 1.9], [ob, u1 - 1.6], [ob, u1 - 0.1], [ob * 0.9, u1],
  ], 32, { crease: 35 }));
  // eyepiece rubber ring + focus ring knurl bands
  b.add('rubber', lathe([[oc * 0.8, u0 - 0.35], [oc * 0.98, u0 - 0.3], [oc * 1.02, u0 + 0.05], [oc * 0.86, u0 + 0.1]], 28));
  if (b.detail) for (const [a, w, r] of [[u0 + 0.35, 0.8, oc * 1.02], [u1 - 1.3, 0.7, ob * 1.02]]) b.add('knurl', lathe([[r * 0.97, a], [r, a + 0.05], [r, a + w - 0.05], [r * 0.97, a + w]], 28));
  // lenses (coated glass) set slightly inside the bells
  b.add('lens', cyl(ob * 0.86, ob * 0.86, 0.04, 28, { u0: u1 - 0.25 }));
  b.add('lens', cyl(oc * 0.72, oc * 0.72, 0.04, 24, { u0: u0 - 0.2 }));
  b.add('dark', cyl(ob * 0.9, ob * 0.9, 0.3, 24, { u0: u1 - 0.6 }));
  // turret saddle + turrets (elevation top, windage right, parallax left)
  const tc = u0 + L * 0.42;
  b.add(mat, side([[tc - 1.2, -0.72], [tc + 1.2, -0.72], [tc + 1.0, 0.72], [tc - 1.0, 0.72]], 1.45, { r: 0.35, bevel: 0.12, bseg: 3 }));
  const turret = (p, r, rad, hgt) => {
    b.push(p, r);
    b.add(mat, cyl(rad * 0.85, rad * 0.85, hgt * 0.4, 20, { axis: 'y' }), { p: [0, hgt * 0.2, 0] });
    b.add('knurl_steel', cyl(rad, rad, hgt * 0.55, 24, { axis: 'y' }), { p: [0, hgt * 0.62, 0] });
    b.add(mat, cyl(rad * 0.9, rad * 0.8, 0.08, 20, { axis: 'y' }), { p: [0, hgt * 0.93, 0] });
    if (b.detail) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; b.add('paint_white', box(0.03, 0.12, 0.012, { r: 0.004 }), { p: [Math.cos(a) * rad * 0.87, hgt * 0.4, Math.sin(a) * rad * 0.87], r: [0, -a * 57.3 + 90, 0] }); }
    b.pop();
  };
  turret([0, 0.6, -tc], [0, 0, 0], o.tr ?? 0.5, o.th ?? 0.9);
  turret([0.6, 0, -tc], [0, 0, -90], o.tr ?? 0.5, o.th ?? 0.8);
  if (o.parallax !== false) turret([-0.6, 0, -(tc + 0.2)], [0, 0, 90], (o.tr ?? 0.5) * 0.9, 0.6);
  b.pop();
  // rings
  for (const u of o.rings || [u0 + 3.6, u1 - 4.6]) {
    b.add(mat, lathe([[t * 1.02, u], [t * 1.2, u + 0.05], [t * 1.2, u + 0.75], [t * 1.02, u + 0.8]], 24), { p: [0, h, 0] });
    b.add(mat, side([[u + 0.05, 0.9], [u + 0.75, 0.9], [u + 0.75, h - 0.3], [u + 0.05, h - 0.3]], 0.9, { r: 0.08, bevel: 0.04 }));
    if (b.detail) { screw(b, 'steel', [0.47, h - 0.1, -(u + 0.4)], 0.08, 'x'); screw(b, 'steel', [0.47, 1.2, -(u + 0.4)], 0.1, 'x'); }
  }
  b.anchor('sight', [0, h, -(u0 - 0.5)]);
}

export function buildAWP(b) {
  const D = b.detail;
  // ---------------- action (round receiver) + rail ----------------
  b.add('park', lathe([[0.55, -0.1], [0.68, 0.0], [0.68, 8.7], [0.62, 8.9], [0.52, 9.0]], 24));
  b.add('park', side([[0.0, -0.5], [8.9, -0.5], [8.9, -0.9], [0.0, -0.9]], 1.25, { r: 0.08, bevel: 0.05 }));
  picatinny(b, 'park', -0.3, 9.1, 0.6, { w: 0.9 });
  if (D) {
    b.add('dark', side([[2.6, -0.3], [6.2, -0.3], [6.2, 0.45], [2.6, 0.45]], 0.02, { x: 0.66, bevel: 0 }));
    for (const u of [0.5, 8.3]) { screw(b, 'steel', [0, -0.95, -u], 0.12, 'y'); }
  }
  // ---------------- bolt (rotates about bore, then slides back) ----------------
  b.part('bolt', [0, 0, -0.9]);
  b.add('bright', cyl(0.46, 0.46, 5.6, 20, { u0: 0.9 }), { c: 0xd0d0d0 });
  b.add('park', lathe([[0.3, -1.4], [0.48, -1.3], [0.52, -0.5], [0.55, 0.0], [0.5, 0.2]], 20));
  b.push([0, 0, -0.95]);
  b.add('park', cyl(0.14, 0.12, 1.85, 12, { axis: 'x' }), { p: [0.95, -0.35, 0], r: [0, 0, -38] });
  b.add('park', cyl(0.2, 0.2, 0.5, 14, { axis: 'x' }), { p: [0.55, 0, 0] });
  b.add('polymer', sphere(0.36, 16, 12), { p: [1.75, -0.95, 0], s: [1, 1, 1.05] });
  b.pop();
  b.anchor('boltGrab', [1.9, -0.6, 0.6]);
  b.part('body');
  // ---------------- stock (green polymer over chassis) ----------------
  const stock = side([
    [19.5, 0.1, 0.3], [9.5, 0.12, 0.2], [9.0, -0.55, 0.1], [-0.3, -0.55, 0.1], [-0.8, 0.2, 0.3], [-2.8, 0.55, 0.4],
    [-7.5, 0.9, 0.3], [-15.8, 1.05, 0.25], [-16.1, 0.7, 0.2], [-16.1, -5.3, 0.3], [-15.5, -5.55, 0.3], [-10.0, -5.35, 1.5],
    [-5.2, -5.65, 0.4], [-2.9, -5.6, 0.35], [-2.2, -4.2, 0.4], [-1.4, -2.3, 0.4], [4.0, -2.3, 0.2], [9.0, -2.0, 0.4],
    [19.0, -1.75, 0.4], [19.6, -1.2, 0.3],
  ], 2.05, {
    r: 0.3, bevel: 0.38, bseg: 4, cseg: 5,
    holes: [[[-9.5, -1.0, 0.9], [-5.2, -0.6, 0.9], [-3.9, -1.4, 0.6], [-4.2, -3.6, 0.6], [-4.9, -4.5, 0.5], [-8.2, -4.3, 0.9], [-10.8, -3.4, 0.9]]],
  });
  b.add('awp_green', deform(stock, (v) => {
    const u = -v.z;
    if (u > 9.5) v.x *= 0.88;                 // slimmer fore-end
    if (u < -7) v.x *= 0.92;
    if (v.y > 0.3 && u < -3) v.x *= 0.85;     // cheek comb
  }, 50));
  // chassis rail + mag well (black)
  b.add('alu', side([[-0.6, -1.9], [9.0, -1.9], [9.0, -2.4], [-0.6, -2.4]], 1.6, { r: 0.08, bevel: 0.05 }));
  // butt pad + spacers
  b.add('rubber', side([[-16.55, 1.0], [-16.05, 1.0], [-16.05, -5.35], [-16.55, -5.3]], 1.95, { r: 0.3, bevel: 0.15 }));
  if (D) {
    b.add('alu', side([[-16.1, 0.9], [-15.9, 0.9], [-15.9, -5.3], [-16.1, -5.3]], 1.92, { r: 0.1, bevel: 0.04 }));
    // fore-end vent slots (both sides) + sling studs
    for (let i = 0; i < 4; i++) for (const s of [1, -1]) b.add('dark', box(0.05, 0.55, 1.1, { r: 0.25 }), { p: [s * 0.93, -0.85, -(11.0 + i * 1.8)] });
    G.slingLoop(b, 'steel', [0, -2.05, -18.2], [0, 90, 0], 0.3);
    G.slingLoop(b, 'steel', [0, -4.95, 13.5], [0, 90, 0], 0.3);
    // cheek-piece adjustment knobs
    for (const u of [-9, -12.5]) b.add('polymer', cyl(0.25, 0.25, 0.3, 14, { axis: 'x' }), { p: [-0.95, 0.35, -u] });
  }
  // trigger guard (black) + trigger
  b.add('alu', side([[-1.3, -2.25], [1.3, -2.25], [1.2, -3.2], [-0.9, -3.25], [-1.4, -2.9]], 0.5, { r: 0.2, bevel: 0.04, holes: [[[-1.0, -2.4], [1.05, -2.4], [0.95, -3.02], [-0.8, -3.06], [-1.1, -2.85]]] }));
  b.part('trigger', [0, -2.25, 0.1]);
  b.add('steel', side([[-0.2, -2.2], [0.1, -2.2], [0.05, -2.6], [-0.1, -2.85], [-0.25, -2.85], [-0.15, -2.55]], 0.22, { r: 0.06, bevel: 0.03 }));
  b.part('body');
  // ---------------- barrel (fluted) + brake ----------------
  b.add('park', lathe([[0.62, 8.9], [0.6, 9.4], [0.5, 10.0], [0.5, 30.0], [0.44, 34.6], [0.3, 34.8]], 24));
  if (D) for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.add('dark', box(0.1, 0.04, 17, { r: 0.018 }), { p: [Math.cos(a) * 0.47, Math.sin(a) * 0.47, -21.5], r: [0, 0, a * 57.3 + 90] });
  }
  b.add('park', lathe([[0.25, 34.6], [0.58, 34.65], [0.62, 34.8], [0.62, 37.0], [0.5, 37.1], [0.22, 37.1], [0.2, 36.8]], 24));
  if (D) for (let k = 0; k < 3; k++) for (const s of [1, -1]) b.add('dark', box(0.3, 0.5, 0.22, { r: 0.05 }), { p: [s * 0.55, 0, -(35.3 + k * 0.55)] });
  // ---------------- magazine ----------------
  b.part('mag', [0, -2.1, -5.4]);
  b.add('park', side([[1.7, -1.9], [5.6, -1.9], [5.6, -3.7], [5.45, -3.95], [1.85, -3.95], [1.7, -3.7]], 1.05, { r: 0.1, bevel: 0.06 }), { c: 0x999999 });
  b.add('polymer', side([[1.6, -3.85], [5.7, -3.85], [5.7, -4.15], [1.6, -4.15]], 1.15, { r: 0.08, bevel: 0.05 }));
  if (D) b.add('brass', lathe([[0.001, 0], [0.28, 0.02], [0.29, 2.6], [0.2, 2.95], [0.17, 3.2]], 12), { p: [0, -1.7, -1.9] });
  b.part('body');
  // ---------------- scope ----------------
  scope(b, 2.35, { u0: -2.6, len: 14.2, tube: 0.59, obj: 1.18, oc: 0.9, rings: [1.0, 6.8] });

  b.anchor('muzzle', [0, 0, -37.2]);
  b.anchor('eject', [0.7, 0.1, -4.4]);
  b.anchor('pivot', [0, -1.5, -3]);
  return {
    hands: {
      R: { p: [1.02, -3.0, 2.75], across: [0, -0.93, 0.37], palm: [-1, 0, -0.05], pose: 'trigger' },
      L: { p: [-0.5, -2.55, -13.8], across: [0, 0.05, 1], palm: [0.45, 0.9, 0], pose: 'wrap' },
      magGrab: { p: [-0.7, -3.8, -3.8], across: [0, 0, 1], palm: [0.95, 0.1, -0.2], pose: 'cup' },
      boltGrab: { p: [2.2, -0.3, 0.2], across: [0, -0.3, 1], palm: [-0.6, -0.4, -0.5], pose: 'pinch' },
    },
    bolt: true, scope: true, boltTravel: 4.4, boltLiftDeg: 62, magPivot: 'straight', inspectL: [0.5, -4.5, -8],
  };
}

// SSG 08: slim synthetic stock, fluted barrel, compact scope.
export function buildSSG(b) {
  const D = b.detail;
  b.add('park', lathe([[0.5, -0.1], [0.6, 0.0], [0.6, 7.6], [0.5, 7.8]], 22));
  picatinny(b, 'park', -0.2, 7.9, 0.52, { w: 0.85 });
  b.part('bolt', [0, 0, -0.9]);
  b.add('bright', cyl(0.42, 0.42, 5.0, 18, { u0: 0.9 }), { c: 0xd0d0d0 });
  b.add('park', lathe([[0.28, -1.2], [0.44, -1.1], [0.48, 0.0]], 18));
  b.add('park', cyl(0.12, 0.1, 1.6, 12, { axis: 'x' }), { p: [0.85, -0.3, -0.95], r: [0, 0, -40] });
  b.add('polymer', sphere(0.3, 14, 10), { p: [1.52, -0.82, -0.95] });
  b.anchor('boltGrab', [1.7, -0.5, -0.4]);
  b.part('body');
  const stock = side([
    [17.0, 0.0, 0.3], [8.5, 0.0, 0.2], [-0.5, -0.3, 0.2], [-3.0, 0.3, 0.4], [-14.5, 0.55, 0.3], [-14.8, 0.2, 0.2],
    [-14.8, -4.9, 0.3], [-14.2, -5.1, 0.3], [-8.0, -3.0, 1.2], [-4.2, -2.5, 0.8], [-3.3, -4.9, 0.3], [-1.9, -4.95, 0.3],
    [-1.3, -2.1, 0.3], [8.0, -1.8, 0.4], [16.8, -1.5, 0.4], [17.2, -0.8, 0.3],
  ], 1.8, { r: 0.3, bevel: 0.32, bseg: 3, cseg: 4 });
  b.add('polymer', deform(stock, (v) => { if (-v.z > 8.5) v.x *= 0.85; }, 50));
  b.add('rubber', side([[-15.2, 0.6], [-14.8, 0.6], [-14.8, -5.0], [-15.2, -5.0]], 1.75, { r: 0.25, bevel: 0.12 }));
  b.add('alu', side([[-1.2, -2.05], [1.2, -2.05], [1.1, -2.9], [-0.8, -2.95], [-1.3, -2.6]], 0.45, { r: 0.18, bevel: 0.04, holes: [[[-0.95, -2.2], [0.95, -2.2], [0.85, -2.75], [-0.7, -2.78], [-1.0, -2.55]]] }));
  b.part('trigger', [0, -2.05, 0]);
  b.add('steel', side([[-0.2, -2.0], [0.1, -2.0], [0.05, -2.35], [-0.1, -2.6], [-0.25, -2.6], [-0.15, -2.3]], 0.2, { r: 0.06 }));
  b.part('body');
  b.add('park', lathe([[0.55, 7.8], [0.46, 8.6], [0.44, 26], [0.36, 28.8], [0.3, 29]], 22));
  if (D) for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.add('dark', box(0.08, 0.035, 14, { r: 0.015 }), { p: [Math.cos(a) * 0.42, Math.sin(a) * 0.42, -17.5], r: [0, 0, a * 57.3 + 90] }); }
  b.add('park', lathe([[0.2, 28.8], [0.45, 28.85], [0.47, 29.0], [0.47, 30.2], [0.2, 30.25]], 20));
  b.part('mag', [0, -1.8, -4.4]);
  b.add('polymer', side([[1.8, -1.7], [4.4, -1.7], [4.4, -3.3], [1.8, -3.3]], 0.95, { r: 0.12, bevel: 0.05 }));
  b.part('body');
  scope(b, 1.95, { u0: -1.8, len: 12, tube: 0.5, obj: 0.92, oc: 0.78, tr: 0.42, th: 0.7, rings: [1.0, 6.0], parallax: false });
  b.anchor('muzzle', [0, 0, -30.3]);
  b.anchor('eject', [0.6, 0.1, -4]);
  b.anchor('pivot', [0, -1.4, -3]);
  return {
    hands: {
      R: { p: [0.95, -2.7, 2.6], across: [0, -0.94, 0.33], palm: [-1, 0, -0.05], pose: 'trigger' },
      L: { p: [-0.5, -2.2, -12.5], across: [0, 0.05, 1], palm: [0.45, 0.9, 0], pose: 'wrap' },
      magGrab: { p: [-0.7, -3.3, -3.2], across: [0, 0, 1], palm: [0.95, 0.1, -0.2], pose: 'cup' },
      boltGrab: { p: [1.95, -0.2, -0.3], across: [0, -0.3, 1], palm: [-0.6, -0.4, -0.5], pose: 'pinch' },
    },
    bolt: true, scope: true, boltTravel: 3.6, boltLiftDeg: 60, magPivot: 'straight',
  };
}

// G3SG1 (roller-delayed, black, big scope, padded stock) and SCAR-20 (tan/black modular).
export function buildAutoSniper(b, key) {
  const D = b.detail, scar = key === 'scar20';
  const bodyMat = scar ? 'polymer_tan' : 'park';
  if (!scar) {
    // G3: stamped receiver with a cocking tube above the barrel
    b.add('park', side([[0, -0.6], [10.5, -0.6], [10.5, 0.75], [0.2, 0.75], [0, 0.4]], 1.2, { r: 0.12, bevel: 0.06 }));
    b.add('park', cyl(0.45, 0.45, 8.5, 18, { u0: 10.3 }), { p: [0, 0.75, 0] });
    b.add('polymer', side([[10.4, 1.0], [18.5, 1.0], [18.6, -1.3], [10.4, -1.3]], 2.0, { r: 0.4, bevel: 0.4, bseg: 3 }));
    b.add('polymer', side([[-0.2, 0.4], [-9.5, 0.1], [-9.8, -3.6], [-7.0, -3.2], [-2.5, -1.8], [-0.2, -1.3]], 1.6, { r: 0.4, bevel: 0.3, bseg: 3 }));
    b.add('rubber', side([[-10.3, 0.4], [-9.7, 0.4], [-9.7, -3.8], [-10.3, -3.8]], 1.7, { r: 0.3, bevel: 0.1 }));
    b.add('polymer', side([[-2.5, 0.6], [-8.5, 0.35], [-8.5, 0.9], [-2.5, 1.1]], 1.3, { r: 0.3, bevel: 0.25 }));
  } else {
    b.add('alu', side([[0, -0.4], [9.8, -0.4], [9.8, 0.85], [0, 0.85]], 1.3, { r: 0.12, bevel: 0.06 }));
    picatinny(b, 'alu', 0.1, 13.0, 0.85);
    b.add('polymer_tan', side([[0, -0.4], [7.5, -0.4], [7.8, -2.0], [5.5, -2.1], [4.8, -1.3], [0, -1.3]], 1.2, { r: 0.15, bevel: 0.08 }));
    b.add('alu', cross([[-1.0, -1.0, 0.2], [1.0, -1.0, 0.2], [1.0, 0.85, 0.2], [-1.0, 0.85, 0.2]], 5.5, { u0: 9.8, bevel: 0.05 }));
    b.add('polymer_tan', side([[-0.2, 0.7], [-9.8, 0.9], [-10.0, -3.4], [-7.5, -3.0], [-2.6, -1.4], [-0.2, -1.1]], 1.5, { r: 0.35, bevel: 0.28, bseg: 3 }));
    b.add('rubber', side([[-10.4, 1.0], [-9.9, 1.0], [-9.9, -3.5], [-10.4, -3.5]], 1.6, { r: 0.25, bevel: 0.1 }));
  }
  b.add('stipple', side([[0.4, -1.2], [2.0, -1.2], [1.75, -2.4], [1.55, -3.8], [1.4, -4.6], [0.15, -4.7], [0.25, -3.3], [0.45, -2.0]], 1.1, { r: 0.2, bevel: 0.24, bseg: 3 }));
  b.add(scar ? 'alu' : 'park', side([[2.0, -1.2], [4.2, -1.2], [4.2, -2.05], [2.3, -2.1], [2.0, -1.8]], 0.5, { r: 0.12, bevel: 0.04, holes: [[[2.3, -1.3], [3.95, -1.3], [3.95, -1.9], [2.45, -1.95], [2.25, -1.7]]] }));
  b.part('trigger', [0, -1.25, -2.9]);
  b.add('steel', side([[2.75, -1.2], [3.05, -1.2], [3.0, -1.55], [2.85, -1.8], [2.7, -1.82], [2.78, -1.5]], 0.2, { r: 0.06 }));
  b.part('bolt', [0, 0.45, -8.2]);
  b.add('steel', cyl(0.1, 0.1, 1.0, 10, { axis: 'x' }), { p: scar ? [-0.9, 0.2, -8.2] : [-0.8, 0.75, -12.5] });
  b.add('polymer', sphere(0.18, 10, 8), { p: scar ? [-1.4, 0.2, -8.2] : [-1.3, 0.75, -12.5] });
  b.part('body');
  b.add('park', lathe([[0.45, 10.2], [0.42, 12], [0.4, 24.5], [0.3, 24.6]], 18));
  b.add('park', lathe([[0.22, 24.5], [0.48, 24.55], [0.5, 24.7], [0.5, 26.6], [0.22, 26.6]], 18));
  if (D) for (let i = 0; i < 4; i++) b.add('dark', box(0.06, 0.06, 1.2, { r: 0.02 }), { p: [Math.cos(i * 1.57) * 0.48, Math.sin(i * 1.57) * 0.48, -25.6] });
  if (scar) stanag(b, 4.6, -0.9, 20, 'polymer');
  else {
    b.part('mag', [0, -0.9, -7]);
    b.add('park', side([[4.6, -0.9], [7.0, -0.9], [7.0, -5.0], [6.8, -5.2], [4.8, -5.2], [4.6, -5.0]], 0.95, { r: 0.12, bevel: 0.05 }), { c: 0x999999 });
    for (const y of [-2.0, -3.2, -4.3]) b.add('park', side([[4.7, y], [6.9, y], [6.9, y - 0.25], [4.7, y - 0.25]], 1.02, { r: 0.08, bevel: 0.03 }), { c: 0x999999 });
    b.part('body');
  }
  scope(b, 2.4, { u0: -1.5, len: 13, tube: 0.59, obj: 1.1, oc: 0.85, rings: [1.8, 7.2] });
  b.anchor('muzzle', [0, 0, -26.8]);
  b.anchor('eject', [0.65, 0.2, -5]);
  b.anchor('pivot', [0, -1.0, -5.5]);
  return {
    hands: {
      R: { p: [0.98, -2.2, -0.9], across: [0, -0.96, 0.28], palm: [-1, 0, -0.05], pose: 'trigger' },
      L: { p: [-0.55, -1.75, -14.5], across: [0, 0.05, 1], palm: [0.45, 0.9, 0], pose: 'wrap' },
      magGrab: { p: [-0.62, -3.4, -5.8], across: [0, 0, 1], palm: [0.95, 0.1, -0.2], pose: 'cup' },
      chargeGrab: scar ? { p: [-1.6, 0.5, -8.0], across: [0, -0.1, 1], palm: [0.9, -0.3, 0], pose: 'pinch' } : { p: [-1.5, 1.0, -12.3], across: [0, -0.1, 1], palm: [0.9, -0.3, 0], pose: 'pinch' },
    },
    scope: true, magPivot: 'straight', boltTravel: 3.0,
  };
}
