// Pistols: Desert Eagle (bespoke) + a parameterised builder for Glock-18, USP-S, P250,
// Five-SeveN, Dual Berettas (92FS), Tec-9 (bespoke-ish) and the Zeus x27.
// Profiles in (u, v): u from the slide rear toward the muzzle, v up from the bore.
import * as G from './geo.js';

const { side, cross, lathe, cyl, box, sphere, torus, deform, screw, picatinny } = G;

/** Grip profile: top from (u0..u1) at v0 raking back by `ang` deg over length L. */
function gripPts(u0, u1, v0, L, ang, o = {}) {
  const t = Math.tan(ang * Math.PI / 180);
  const back = (y) => u0 - (v0 - y) * t, front = (y) => u1 - (v0 - y) * t;
  const yb = v0 - L;
  const pts = [[u0 - 0.05, v0], [u1, v0]];
  if (o.grooves) {
    // finger grooves on the front strap
    const n = o.grooves;
    for (let i = 1; i <= n * 2; i++) {
      const y = v0 - 0.55 - (i / (n * 2)) * (L - 0.9);
      pts.push([front(y) + (i % 2 ? -0.1 : 0.06), y, 0.25]);
    }
  } else pts.push([front(v0 - L * 0.4) + (o.belly || 0), v0 - L * 0.4, 0.5]);
  pts.push([front(yb) + 0.05, yb, 0.18], [back(yb) - 0.12, yb, 0.2]);
  pts.push([back(v0 - L * 0.55) - (o.palm || 0.12), v0 - L * 0.55, 0.6]);
  if (o.beaver) pts.push([u0 - 0.35, v0 + 0.05, 0.2]);
  return pts;
}

// ---------------- Desert Eagle ----------------
export function buildDeagle(b) {
  const D = b.detail;
  const ST = 'stainless';
  // slide (moves back)
  b.part('slide', [0, 0, 0]);
  b.add(ST, side([[0, -0.52], [5.75, -0.52], [5.75, 0.62], [5.55, 0.82], [0.45, 0.82], [0.0, 0.55]], 1.26, { r: 0.07, bevel: 0.07 }));
  if (D) {
    for (let i = 0; i < 11; i++) b.add(ST, side([[0.35 + i * 0.13, -0.35], [0.41 + i * 0.13, -0.35], [0.41 + i * 0.13, 0.7], [0.35 + i * 0.13, 0.7]], 1.32, { r: 0.02, bevel: 0.025 }), { c: 0x8a8a8a });
    // ambidextrous safety levers
    for (const s of [1, -1]) b.add('blued', side([[0.2, 0.25], [1.1, 0.35], [1.15, 0.6], [0.25, 0.6]], 0.1, { x: 0.66 * s, r: 0.08, bevel: 0.03 }));
    // rear sight
    b.add('blued', side([[0.15, 0.8], [0.75, 0.8], [0.7, 1.12], [0.2, 1.12]], 0.95, { r: 0.04, bevel: 0.03 }));
    b.add('dark', box(0.14, 0.2, 0.62, { r: 0.02 }), { p: [0, 1.06, -0.45] });
  }
  b.part('body');
  // fixed triangular barrel with a top rib
  const tri = [[-0.52, -0.55], [0.52, -0.55], [0.5, 0.2, 0.08], [0.33, 0.82, 0.08], [-0.33, 0.82, 0.08], [-0.5, 0.2, 0.08]];
  b.add(ST, cross(tri, 5.0, { u0: 5.6, bevel: 0.05 }), { c: 0xe6e6e6 });
  if (D) {
    b.add(ST, cross([[-0.28, 0], [0.28, 0], [0.24, 0.12], [-0.24, 0.12]], 4.9, { u0: 5.65, bevel: 0.02 }), { p: [0, 0.82, 0] });
    for (let i = 0; i < 9; i++) b.add('dark', box(0.4, 0.03, 0.05, { r: 0.01 }), { p: [0, 0.95, -(5.9 + i * 0.5)] });
    b.add('blued', side([[10.1, 0.9], [10.5, 0.9], [10.45, 1.18], [10.15, 1.18]], 0.14, { r: 0.03 }));
    // flat side facet highlight line
    for (const s of [1, -1]) b.add(ST, box(0.02, 0.55, 4.9, { r: 0.01 }), { p: [0.42 * s, 0.5, -8.1], r: [0, 0, 12 * s], c: 0xf2f2f2 });
  }
  b.add('dark', cyl(0.25, 0.25, 0.06, 16, { u0: 10.57 }));
  // frame (under the slide / barrel)
  b.add(ST, side([[0.9, -0.52], [9.7, -0.52], [9.75, -0.8], [9.4, -1.08], [4.6, -1.08], [1.6, -1.05], [0.9, -0.95]], 1.08, { r: 0.08, bevel: 0.06 }), { c: 0xc8c8c8 });
  // trigger guard (squared front)
  b.add(ST, side([[1.85, -1.0], [4.5, -1.0], [4.6, -1.3], [4.45, -2.05, 0.2], [2.3, -2.05], [1.85, -1.7]], 0.46,
    { r: 0.12, bevel: 0.05, holes: [[[2.15, -1.12], [4.25, -1.12], [4.2, -1.88], [2.4, -1.9], [2.1, -1.6]]] }), { c: 0xc8c8c8 });
  // grip frame + rubber panels
  b.add(ST, side(gripPts(-0.35, 1.95, -0.9, 4.75, 17, { beaver: true }), 1.0, { r: 0.12, bevel: 0.1 }), { c: 0xb0b0b0 });
  b.add('knurl', side(gripPts(-0.1, 1.7, -1.2, 4.2, 17), 1.34, { r: 0.2, bevel: 0.2, bseg: 3 }));
  if (D) {
    screw(b, 'steel', [0.68, -2.2, 0.35], 0.1, 'x'); screw(b, 'steel', [-0.68, -2.2, 0.35], 0.1, '-x');
    b.add('steel', side([[2.9, -0.6], [3.9, -0.6], [3.9, -0.82], [2.9, -0.82]], 0.08, { x: -0.56, r: 0.05 }));
    G.rivet(b, 'steel', [-0.56, -0.72, -2.4], 0.1, -1);
  }
  // hammer
  b.part('hammer', [0, 0.1, 0.1]);
  b.add('blued', side([[-0.45, 0.1], [0.1, 0.1], [0.05, 0.65], [-0.25, 0.95], [-0.55, 0.85], [-0.35, 0.55]], 0.36, { r: 0.08, bevel: 0.04 }));
  b.part('trigger', [0, -1.0, -2.8]);
  b.add('blued', side([[2.6, -1.0], [2.95, -1.0], [2.9, -1.4], [2.75, -1.75], [2.6, -1.8], [2.68, -1.4]], 0.24, { r: 0.07, bevel: 0.03 }));
  // magazine (drops from the grip)
  b.part('mag', [0, -5.6, -0.6]);
  const t = Math.tan(17 * Math.PI / 180);
  b.add('steel', side([[-0.05 - 0.7 * t, -1.2], [1.4 - 0.7 * t, -1.2], [1.4 - 4.5 * t, -5.55], [-0.05 - 4.5 * t, -5.55]], 0.95, { r: 0.05, bevel: 0.04 }));
  b.add('polymer', side([[-0.3 - 4.5 * t, -5.5], [1.6 - 4.5 * t, -5.5], [1.6 - 4.5 * t, -5.85], [-0.3 - 4.5 * t, -5.85]], 1.3, { r: 0.12, bevel: 0.06 }));
  b.part('body');
  b.anchor('muzzle', [0, 0.05, -10.7]);
  b.anchor('eject', [0.6, 0.55, -3.2]);
  b.anchor('pivot', [0, -1.5, -2.0]);
  return pistolCfg({ gripTop: [0.8, -1.0], ang: 17, width: 1.34, slideTravel: 1.4 });
}

// Shared hand layout for two-handed pistol grips. gripTop = (u, v) of the grip top centre.
export function pistolCfg({ gripTop, ang, width = 1.2, slideTravel = 1.2, extra = {} }) {
  const [gu, gv] = gripTop;
  const a = ang * Math.PI / 180;
  const across = [0, -Math.cos(a), Math.sin(a)];
  const hw = width / 2;
  const at = (dy) => [gu - dy * Math.tan(a), gv - dy];
  const [ru, rv] = at(1.25), [lu, lv] = at(1.75);
  return {
    hands: {
      R: { p: [hw + 0.42, rv, -(ru - 1.45)], across, palm: [-1, 0, -0.1], pose: 'trigger' },
      L: { p: [-(hw + 0.78), lv, -(lu + 0.1)], across, palm: [0.95, -0.05, -0.25], pose: 'wrap' },
      magGrab: { p: [-0.9, gv - 5.2, -(gu - 1.3)], across: [0, 0, 1], palm: [0.8, 0.5, 0], pose: 'cup' },
    },
    slideTravel, ...extra,
  };
}

/**
 * Generic modern pistol. o: { L (slide length), H (slide height), W, top: 'square'|'round'|'chamfer',
 * slide, frame, grip (materials), ang, gripL, grooves, tg: 'square'|'round', hammer, rail, bx (barrel
 * past slide), front/rear sights, dots (tritium), sup (suppressor), serr }
 */
export function buildPistol(b, o) {
  const D = b.detail;
  const L = o.L, H = o.H ?? 1.1, W = o.W ?? 0.95, top = o.top || 'chamfer';
  const vb = -0.38, vt = vb + H;
  // slide
  b.part('slide', [0, 0, 0]);
  const cs = top === 'round' ? [[-W / 2, vb], [W / 2, vb], [W / 2, vt - 0.3, 0.05], [W / 2 - 0.05, vt - 0.08, 0.2], [0, vt, 0.3], [-W / 2 + 0.05, vt - 0.08, 0.2], [-W / 2, vt - 0.3, 0.05]]
    : top === 'chamfer' ? [[-W / 2, vb], [W / 2, vb], [W / 2, vt - 0.22, 0.03], [W / 2 - 0.2, vt, 0.03], [-W / 2 + 0.2, vt, 0.03], [-W / 2, vt - 0.22, 0.03]]
      : [[-W / 2, vb], [W / 2, vb], [W / 2, vt, 0.06], [-W / 2, vt, 0.06]];
  b.add(o.slide, cross(cs, L, { u0: 0, bevel: 0.05, cseg: 3 }));
  if (o.cutaway) {
    // Beretta-style open top: barrel visible between the slide wings
    b.add('dark', box(W * 0.55, 0.05, L * 0.55, { r: 0.02 }), { p: [0, vt - 0.02, -(L * 0.55)] });
  }
  if (D) {
    const [s0, s1] = o.serr || [0.25, 1.35];
    const n = Math.floor((s1 - s0) / 0.12);
    for (let i = 0; i < n; i++) for (const sx of [1, -1]) b.add(o.slide, box(0.04, H * 0.7, 0.05, { r: 0.012 }), { p: [sx * (W / 2 + 0.005), vb + H * 0.45, -(s0 + i * 0.12)], c: 0x777777 });
    // sights
    b.add(o.slide, side([[0.12, vt], [0.62, vt], [0.58, vt + 0.2], [0.16, vt + 0.2]], 0.72, { r: 0.03, bevel: 0.02 }), { c: 0x6a6a6a });
    b.add('dark', box(0.12, 0.14, 0.52, { r: 0.02 }), { p: [0, vt + 0.14, -0.37] });
    b.add(o.slide, side([[L - 0.5, vt], [L - 0.2, vt], [L - 0.22, vt + 0.2], [L - 0.45, vt + 0.2]], 0.14, { r: 0.03 }), { c: 0x6a6a6a });
    if (o.dots !== false) {
      b.add('paint_white', cyl(0.035, 0.035, 0.02, 8, { u0: 0.11 }), { p: [0.22, vt + 0.12, 0] });
      b.add('paint_white', cyl(0.035, 0.035, 0.02, 8, { u0: 0.11 }), { p: [-0.22, vt + 0.12, 0] });
      b.add(o.tritium ? 'tritium' : 'paint_white', cyl(0.04, 0.04, 0.02, 8, { u0: L - 0.49 }), { p: [0, vt + 0.13, 0] });
    }
    // ejection port (right) with the barrel hood inside
    b.add('dark', side([[L * 0.34, vt - 0.02], [L * 0.56, vt - 0.02], [L * 0.56, vt - 0.55], [L * 0.34, vt - 0.55]], 0.02, { x: W / 2 + 0.005, bevel: 0 }));
    b.add('steel', side([[L * 0.36, vt - 0.05], [L * 0.54, vt - 0.05], [L * 0.54, vt - 0.3], [L * 0.36, vt - 0.3]], 0.3, { x: W / 2 - 0.1, bevel: 0.02 }), { c: 0xb0b0b0 });
    if (o.selector) b.add('steel', side([[0.4, vb + 0.35], [0.9, vb + 0.35], [0.9, vb + 0.55], [0.4, vb + 0.55]], 0.08, { x: -W / 2 - 0.03, r: 0.05 }));
  }
  b.part('body');
  // barrel crown + optional thread / extension
  const bx = o.bx ?? 0.05;
  b.add('steel', lathe([[0.2, L - 0.3], [0.26, L - 0.2], [0.26, L + bx], [0.14, L + bx + 0.02], [0.14, L - 0.1]], 16), { c: 0xaaaaaa });
  b.add('dark', cyl(0.14, 0.14, 0.05, 12, { u0: L + bx - 0.06 }));
  // frame
  const fb = vb - (o.frameH ?? 0.5);
  const fL = o.frameL ?? L - 0.25;
  b.add(o.frame, side([[0.55, vb + 0.02], [fL, vb + 0.02], [fL, vb - 0.15], [fL - 0.15, fb], [2.0, fb], [0.55, fb + 0.1]], W * 0.96, { r: 0.07, bevel: 0.06 }));
  if (o.rail && D) b.add(o.frame, cross([[-0.33, 0], [0.33, 0], [0.33, 0.12], [-0.33, 0.12]], 1.3, { u0: fL - 1.55, bevel: 0.02 }), { p: [0, fb - 0.12, 0] });
  // trigger guard
  const tg0 = o.tg0 ?? 1.9, tg1 = o.tg1 ?? 4.1, tgb = fb - 0.95;
  const sq = o.tg === 'square';
  b.add(o.frame, side([[tg0, fb + 0.05], [tg1, fb + 0.05], [tg1 + 0.05, fb - 0.2], [tg1 - (sq ? 0.02 : 0.35), tgb, sq ? 0.15 : 0.4], [tg0 + 0.35, tgb, 0.2], [tg0, fb - 0.6]], 0.42,
    { r: 0.1, bevel: 0.05, holes: [[[tg0 + 0.28, fb - 0.08], [tg1 - 0.2, fb - 0.08], [tg1 - (sq ? 0.24 : 0.5), tgb + 0.17, sq ? 0.1 : 0.3], [tg0 + 0.5, tgb + 0.18, 0.15], [tg0 + 0.25, fb - 0.55]]] }));
  // grip
  const ang = o.ang ?? 20, gL = o.gripL ?? 4.0, gW = o.gripW ?? 1.12;
  const g0 = o.g0 ?? -0.25, g1 = o.g1 ?? tg0 + 0.05;
  b.add(o.grip || o.frame, side(gripPts(g0, g1, fb + 0.15, gL, ang, { grooves: o.grooves, beaver: true, palm: o.palmSwell ?? 0.15 }), gW, { r: 0.12, bevel: 0.22, bseg: 3, cseg: 4 }));
  if (o.gripPanel && D) b.add(o.gripPanel, side(gripPts(g0 + 0.25, g1 - 0.2, fb - 0.3, gL - 0.9, ang), gW + 0.12, { r: 0.15, bevel: 0.12, bseg: 2 }));
  // controls
  if (D) {
    b.add('steel', side([[2.6, vb - 0.12], [3.7, vb - 0.1], [3.7, vb - 0.32], [2.7, vb - 0.3]], 0.07, { x: -W / 2 - 0.02, r: 0.05 }));  // slide stop
    b.add('polymer', box(0.08, 0.3, 0.3, { r: 0.04 }), { p: [-gW / 2 - 0.02, fb - 0.2, -(g1 + 0.15)] });                            // mag release
    if (o.lever) b.add('steel', side([[0.1, vb - 0.1], [0.9, vb - 0.05], [0.95, vb - 0.3], [0.3, vb - 0.4]], 0.1, { x: -gW / 2 - 0.02, r: 0.08, bevel: 0.03 }));
  }
  if (o.hammer) {
    b.part('hammer', [0, vb + 0.2, 0.05]);
    b.add('steel', side([[-0.35, vb + 0.15], [0.1, vb + 0.15], [0.05, vb + 0.6], [-0.2, vb + 0.8], [-0.45, vb + 0.65]], 0.3, { r: 0.1, bevel: 0.04 }));
    b.part('body');
  }
  b.part('trigger', [0, fb, -(tg0 + 0.9)]);
  b.add(o.trig || 'polymer', side([[tg0 + 0.7, fb + 0.05], [tg0 + 1.02, fb + 0.05], [tg0 + 0.98, fb - 0.35], [tg0 + 0.85, fb - 0.65], [tg0 + 0.68, fb - 0.68], [tg0 + 0.78, fb - 0.3]], 0.22, { r: 0.07, bevel: 0.03 }));
  b.part('body');
  // magazine
  b.part('mag', [0, fb - gL + 0.1, -g0]);
  const t = Math.tan(ang * Math.PI / 180), mb = fb + 0.15 - gL;
  b.add('steel', side([[g0 + 0.3 + 0.9 * t, fb - 0.6], [g1 - 0.25 + 0.9 * t, fb - 0.6], [g1 - 0.25 - (gL - 0.8) * t, mb + 0.1], [g0 + 0.3 - (gL - 0.8) * t, mb + 0.1]], gW * 0.72, { r: 0.05, bevel: 0.03 }), { c: 0x999999 });
  b.add(o.magBase || 'polymer', side([[g0 + 0.05 - gL * t, mb + 0.12], [g1 + 0.02 - gL * t, mb + 0.12], [g1 + 0.02 - gL * t - 0.05, mb - 0.18], [g0 + 0.1 - gL * t, mb - 0.18]], gW + 0.02, { r: 0.08, bevel: 0.05 }));
  b.part('body');
  // suppressor
  let muz = [0, 0, -(L + bx + 0.02)];
  if (o.sup) {
    const s0 = L + bx - 0.1;
    b.part('silencer', [0, 0, -s0]);
    b.add(o.slide, lathe([[0.18, s0], [0.55, s0 + 0.08], [0.6, s0 + 0.3], [0.6, s0 + o.sup - 0.2], [0.52, s0 + o.sup], [0.16, s0 + o.sup], [0.15, s0 + o.sup - 0.1]], 24), { c: 0xcccccc });
    if (D) for (const u of [s0 + 0.35, s0 + o.sup - 0.6]) b.add('knurl_steel', lathe([[0.61, u], [0.63, u + 0.04], [0.63, u + 0.32], [0.61, u + 0.36]], 24));
    b.add('dark', cyl(0.14, 0.14, 0.05, 12, { u0: s0 + o.sup - 0.03 }));
    b.anchor('muzzle_s', [0, 0, -(s0 + o.sup + 0.02)]);
    b.anchor('silGrab', [0, 0, -(s0 + o.sup * 0.6)]);
    b.part('body');
    b.add('steel', cyl(0.24, 0.24, 0.5, 14, { u0: L + bx - 0.1 }), { c: 0x999999 });
    muz = [0, 0, -(L + bx + 0.02)];
  }
  b.anchor('muzzle', muz);
  b.anchor('eject', [W / 2 + 0.1, vt - 0.2, -(L * 0.45)]);
  b.anchor('pivot', [0, -1.6, -(g1 * 0.8)]);
  const cfg = pistolCfg({ gripTop: [(g0 + g1) / 2 + 0.05, fb + 0.1], ang, width: gW, slideTravel: o.travel ?? L * 0.24 });
  if (o.sup) cfg.hands.silGrab = { p: [-0.85, 0.0, -(L + bx + o.sup * 0.55)], across: [0, 0.1, 1], palm: [0.95, 0.2, 0], pose: 'cup' };
  cfg.silencer = !!o.sup;
  return cfg;
}

export const PISTOLS = {
  glock: { L: 6.85, H: 1.08, W: 0.94, top: 'chamfer', slide: 'gunmetal', frame: 'polymer', grip: 'stipple', ang: 22, gripL: 4.1, gripW: 1.18, grooves: 3, tg: 'square', rail: true, selector: true, serr: [0.3, 1.45], magBase: 'polymer' },
  usp: { L: 7.1, H: 1.12, W: 1.0, top: 'round', slide: 'gunmetal', frame: 'polymer', grip: 'stipple', ang: 18, gripL: 4.3, gripW: 1.2, tg: 'square', hammer: true, lever: true, rail: true, bx: 0.55, sup: 6.9, serr: [0.3, 1.3] },
  p250: { L: 7.0, H: 1.15, W: 1.0, top: 'chamfer', slide: 'blued', frame: 'polymer', grip: 'stipple', ang: 18, gripL: 4.2, gripW: 1.2, tg: 'square', rail: true, tritium: true },
  fiveseven: { L: 7.9, H: 1.05, W: 0.9, top: 'square', slide: 'polymer', frame: 'polymer_tan', grip: 'polymer_tan', gripPanel: 'stipple', ang: 16, gripL: 4.5, gripW: 1.25, tg: 'square', rail: true, tg1: 4.3 },
  dualberettas: { L: 8.0, H: 1.15, W: 0.98, top: 'round', slide: 'gunmetal', frame: 'gunmetal', grip: 'gunmetal', gripPanel: 'knurl', ang: 16, gripL: 4.3, gripW: 1.25, tg: 'round', hammer: true, lever: true, cutaway: true, bx: 0.25, tg1: 4.4 },
  zeus: { L: 5.5, H: 1.5, W: 1.3, top: 'round', slide: 'paint_yellow', frame: 'polymer', grip: 'polymer', ang: 12, gripL: 3.4, gripW: 1.25, tg: 'round', dots: false, bx: -0.2 },
};

export function buildGenericPistol(b, key) {
  const o = PISTOLS[key] || PISTOLS.glock;
  const cfg = buildPistol(b, o);
  if (key === 'zeus' && b.detail) {
    // cartridge face with electrode contacts
    b.add('paint_black', box(1.2, 1.35, 0.3, { r: 0.1 }), { p: [0, 0.37, -5.65] });
    for (const x of [-0.3, 0.3]) b.add('bright', cyl(0.08, 0.08, 0.08, 10, { u0: 5.8 }), { p: [x, 0.37, 0] });
  }
  if (key === 'usp') cfg.silencer = true;
  return cfg;
}

// ---------------- Tec-9 ----------------
export function buildTec9(b) {
  const D = b.detail;
  // boxy stamped receiver + ventilated barrel shroud, magazine ahead of the trigger guard
  b.add('park', side([[0, -0.55], [6.2, -0.55], [6.2, 0.7], [0.3, 0.7], [0, 0.4]], 1.15, { r: 0.1, bevel: 0.06 }));
  b.add('polymer', side([[1.5, -0.55], [6.3, -0.55], [6.3, -1.3], [1.3, -1.3]], 1.2, { r: 0.12, bevel: 0.07 }));
  b.add('park', lathe([[0.55, 6.1], [0.55, 10.2], [0.45, 10.3]], 20));
  if (D) for (let i = 0; i < 6; i++) for (const a of [0, 1.2, 2.4, 3.6, 4.8]) b.add('dark', cyl(0.12, 0.12, 0.1, 10, { axis: 'y' }), { p: [Math.cos(a) * 0.55, Math.sin(a) * 0.55, -(6.6 + i * 0.6)], r: [0, 0, a * 57.3 - 90] });
  b.add('steel', lathe([[0.2, 10.2], [0.28, 10.25], [0.28, 10.9], [0.14, 10.92]], 14));
  b.add('polymer', side(gripPts(0.2, 1.9, -1.2, 3.9, 12, { grooves: 3 }), 1.15, { r: 0.12, bevel: 0.2, bseg: 3 }));
  b.add('polymer', side([[1.9, -1.2], [3.8, -1.2], [3.9, -1.5], [3.7, -2.25], [2.3, -2.25], [1.9, -1.8]], 0.42, { r: 0.1, holes: [[[2.2, -1.32], [3.55, -1.32], [3.5, -2.05], [2.45, -2.05], [2.2, -1.75]]] }));
  b.part('trigger', [0, -1.25, -2.9]);
  b.add('steel', side([[2.75, -1.2], [3.05, -1.2], [3.0, -1.55], [2.85, -1.85], [2.7, -1.88], [2.78, -1.5]], 0.2, { r: 0.06 }));
  b.part('bolt', [0, 0.72, -1.5]);
  b.add('steel', cyl(0.09, 0.09, 0.8, 10, { axis: 'x' }), { p: [-0.9, 0.3, -1.5] });
  b.add('polymer', sphere(0.16, 10, 8), { p: [-1.35, 0.3, -1.5] });
  b.part('body');
  b.part('mag', [0, -1.3, -5.2]);
  b.add('park', side([[4.3, -1.0], [5.6, -1.0], [5.35, -7.2], [4.1, -7.2]], 0.85, { r: 0.08, bevel: 0.04 }), { c: 0xaaaaaa });
  b.add('polymer', side([[4.0, -7.1], [5.45, -7.1], [5.45, -7.4], [4.0, -7.4]], 1.0, { r: 0.08 }));
  b.part('body');
  b.add('park', side([[4.1, -1.3], [5.8, -1.3], [5.8, -1.9], [4.1, -1.9]], 1.05, { r: 0.08, bevel: 0.04 }));
  b.anchor('muzzle', [0, 0, -10.95]);
  b.anchor('eject', [0.6, 0.3, -3.5]);
  b.anchor('pivot', [0, -1.5, -3]);
  const cfg = pistolCfg({ gripTop: [1.05, -1.2], ang: 12, width: 1.15, slideTravel: 0 });
  cfg.hands.L = { p: [-0.1, -2.6, -4.9], across: [0, 0.2, 1], palm: [0.5, 0.2, -0.85], pose: 'wrap' };
  cfg.hands.magGrab = { p: [-0.7, -4.8, -4.9], across: [0, 0, 1], palm: [0.95, 0.1, 0], pose: 'cup' };
  cfg.boltTravel = 2.2;
  return cfg;
}
