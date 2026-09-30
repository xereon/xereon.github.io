// Knives (CT / T defaults), grenades (HE, flashbang, smoke, molotov, incendiary, decoy), C4 and
// the defuse kit. Gun space per geo.js: the held item's handle/body sits at the origin area.
import * as G from './geo.js';

const { side, cross, lathe, cyl, box, sphere, torus, deform, screw, tube } = G;

// Blade from a side profile, ground to an edge: x thickness tapers from the spine to the edge.
function blade(pts, spineV, edgeV, t, mat, b, o = {}) {
  const g = side(pts, t, { r: 0.02, bevel: 0.015, bseg: 1, cseg: 4 });
  b.add(mat, deform(g, (v) => {
    const k = Math.min(1, Math.max(0, (v.y - edgeV) / (spineV - edgeV)));
    const grind = o.flat ? Math.max(0.12, Math.min(1, (k - 0.05) / 0.45)) : Math.max(0.1, Math.pow(k, 0.7));
    v.x *= grind;
  }, 30), o.opt || {});
}

export function buildKnife(b, variant = 'ct') {
  const D = b.detail;
  if (variant === 't') {
    // T default: satin clip-point blade, brass guard + pommel, wrapped dark handle
    blade([[0, -0.35], [6.2, -0.35], [7.0, -0.1], [7.35, 0.25], [6.1, 0.42], [5.2, 0.38], [4.4, 0.55], [0, 0.55]], 0.55, -0.35, 0.2, 'stainless', b, { flat: true });
    if (D) b.add('dark', box(0.03, 0.12, 3.2, { r: 0.01 }), { p: [0.08, 0.35, -2.2] });
    b.add('brass', side([[-0.45, -0.7], [0.05, -0.7], [0.05, 0.9], [-0.45, 0.9]], 0.62, { r: 0.12, bevel: 0.06 }));
    const handle = side([[-0.45, 0.6], [-0.45, -0.42], [-0.9, -0.55], [-1.5, -0.45], [-2.1, -0.58], [-2.7, -0.45], [-3.3, -0.58], [-4.2, -0.5], [-5.0, -0.52], [-5.1, 0.05], [-5.0, 0.6]], 0.9, { r: 0.18, bevel: 0.28, bseg: 3 });
    b.add('leather_ct', handle, { c: 0x9a7a60 });
    if (D) for (let i = 0; i < 7; i++) b.add('leather_ct', torus(0.5, 0.06, { rs: 6, ts: 18 }), { p: [0, 0.05, 1.0 + i * 0.55], s: [0.95, 1.2, 1], c: 0x7a5a45 });
    b.add('brass', lathe([[0.001, 5.0], [0.45, 5.02], [0.55, 5.3], [0.45, 5.7], [0.001, 5.75]], 16), { r: [0, 180, 0], p: [0, 0.05, 0] });
    b.anchor('muzzle', [0, 0.1, -7.3]);
    b.anchor('pivot', [0, 0, 2]);
    return knifeCfg(0.05);
  }
  // CT default: coated tanto-ish clip point, rubber handle with finger grooves, steel guard
  blade([[0, -0.4], [5.6, -0.4], [6.6, -0.2], [7.0, 0.2], [6.2, 0.36], [0, 0.58]], 0.58, -0.4, 0.22, 'blued', b);
  if (D) {
    // edge bevel highlight + serrations near the guard
    b.add('stainless', deform(side([[0.2, -0.42], [5.6, -0.42], [6.55, -0.22], [6.8, 0.05], [6.1, -0.05], [5.5, -0.25], [0.2, -0.25]], 0.06, { bevel: 0.01, r: 0.02 }), (v) => { v.x *= 0.6; }, 30));
    for (let i = 0; i < 8; i++) b.add('blued', box(0.12, 0.1, 0.12, { r: 0.02 }), { p: [0, 0.6, -(0.4 + i * 0.22)], r: [45, 0, 0] });
  }
  b.add('steel', side([[-0.4, -0.75], [0.05, -0.75], [0.05, 0.85], [-0.4, 0.85]], 0.55, { r: 0.12, bevel: 0.05 }));
  const handle = side([[-0.4, 0.62], [-0.4, -0.48], [-0.85, -0.6], [-1.4, -0.46], [-2.0, -0.62], [-2.6, -0.48], [-3.2, -0.62], [-4.0, -0.55], [-4.9, -0.58], [-5.05, 0.1], [-4.9, 0.62]], 0.92, { r: 0.18, bevel: 0.3, bseg: 3 });
  b.add('knurl', handle);
  b.add('steel', lathe([[0.001, 4.85], [0.42, 4.9], [0.5, 5.15], [0.38, 5.45], [0.001, 5.5]], 16), { r: [0, 180, 0], p: [0, 0.05, 0] });
  if (D) b.add('steel', torus(0.16, 0.05, { rs: 6, ts: 14 }), { p: [0, 0.05, 5.55], r: [0, 90, 0] });
  b.anchor('muzzle', [0, 0.1, -7.0]);
  b.anchor('pivot', [0, 0, 2]);
  return knifeCfg(0.05);
}
function knifeCfg(y) {
  return {
    hands: { R: { p: [0.72, y + 0.25, 2.35], across: [0, 0, 1], palm: [-1, -0.22, 0], pose: 'fist' } },
    family: 'knife',
  };
}

// ---------------- grenades ----------------
// Common fuze: spoon (lever) along the body, fuze head, pin + ring (part 'pin').
function fuze(b, top, bodyR, spoonLen, mat = 'paint_grey') {
  b.add(mat, lathe([[0.36, top - 0.05], [0.4, top], [0.4, top + 0.5], [0.3, top + 0.62], [0.001, top + 0.65]], 16), { r: [90, 0, 0] });
  // spoon: a bent strip running down the +Z side (toward the palm)
  const pts = [[0, top + 0.55, -0.1], [0, top + 0.6, 0.35], [0, top + 0.3, 0.55], [0, top - 0.3, bodyR + 0.12], [0, top - spoonLen, bodyR + 0.05]];
  b.add('paint_grey', tube(pts, 0.1, { rs: 4, seg: 20 }), { s: [3.2, 1, 0.4], p: [0, 0, 0] });
  b.part('pin', [0.45, top + 0.35, 0]);
  b.add('steel', torus(0.42, 0.04, { rs: 6, ts: 20 }), { p: [0.95, top + 0.25, 0], r: [0, 90, 0] });
  b.add('steel', cyl(0.04, 0.04, 0.6, 6, { axis: 'x' }), { p: [0.45, top + 0.35, 0] });
  b.part('body');
}

export function buildGrenade(b, key) {
  const D = b.detail;
  let top = 2.0;
  if (key === 'hegrenade' || key === 'decoy') {
    // M67-style sphere
    const mat = key === 'decoy' ? 'paint_grey' : 'paint_od';
    const prof = [];
    for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + (i / 16) * Math.PI * 0.86; prof.push([Math.max(0.001, Math.cos(a) * 1.3), Math.sin(a) * 1.28 * (a > 0 ? 1.05 : 1)]); }
    prof.push([0.42, 1.38], [0.4, 1.5]);
    b.add(mat, lathe(prof, 32, { crease: 60 }), { r: [90, 0, 0] });
    if (D) {
      b.add('paint_yellow', lathe([[1.29, -0.12], [1.31, -0.1], [1.31, 0.1], [1.29, 0.12]], 28), { r: [90, 0, 0] });
      if (key === 'decoy') for (let i = 0; i < 5; i++) b.add('dark', cyl(0.08, 0.08, 0.05, 8, { axis: 'y' }), { p: [Math.cos(i * 1.25) * 0.6, 1.2, Math.sin(i * 1.25) * 0.6] });
    }
    top = 1.45;
    fuze(b, top, 1.2, 2.2);
  } else if (key === 'flashbang') {
    b.add('paint_grey', lathe([[0.001, -2.2], [0.78, -2.15], [0.82, -2.0], [0.82, 1.6], [0.7, 1.75], [0.38, 1.8]], 24), { r: [90, 0, 0] });
    if (D) for (let k = 0; k < 3; k++) for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.add('dark', cyl(0.1, 0.1, 0.05, 8, { axis: 'y' }), { p: [Math.cos(a) * 0.82, -1.2 + k * 1.1, Math.sin(a) * 0.82], r: [0, -a * 57.3, 90] });
    }
    if (D) b.add('paint_blue', lathe([[0.83, 0.8], [0.84, 0.82], [0.84, 1.1], [0.83, 1.12]], 24), { r: [90, 0, 0] });
    top = 1.8;
    fuze(b, top, 0.82, 2.8);
  } else if (key === 'smokegrenade' || key === 'incgrenade') {
    const inc = key === 'incgrenade';
    b.add(inc ? 'paint_grey' : 'paint_green', lathe([[0.001, -2.4], [1.12, -2.35], [1.2, -2.2], [1.2, 1.9], [1.05, 2.05], [0.4, 2.1]], 28), { r: [90, 0, 0] });
    if (D) {
      b.add(inc ? 'paint_red' : 'paint_white', lathe([[1.21, 0.2], [1.22, 0.22], [1.22, 0.9], [1.21, 0.92]], 28), { r: [90, 0, 0] });
      for (let i = 0; i < 4; i++) b.add('dark', cyl(0.12, 0.12, 0.3, 8, { axis: 'y' }), { p: [Math.cos(i * 1.57) * 0.7, 2.05, Math.sin(i * 1.57) * 0.7] });
    }
    top = 2.1;
    fuze(b, top, 1.2, 3.0);
  } else if (key === 'molotov') {
    // glass bottle with a rag stuffed in the neck
    b.add('glass_green', lathe([[0.001, -3.8], [1.0, -3.75], [1.1, -3.5], [1.12, 0.6], [0.95, 1.4], [0.45, 2.3], [0.4, 3.4], [0.46, 3.5], [0.44, 3.7]], 28, { crease: 50 }), { r: [90, 0, 0] });
    if (D) b.add('wrapper', lathe([[1.13, -1.2], [1.14, -1.15], [1.14, 0.3], [1.13, 0.35]], 28), { r: [90, 0, 0], c: 0xd8c898 });
    b.add('cloth_rag', deform(tube([[0, 3.2, 0], [0, 3.9, 0.05], [0.1, 4.5, 0.3], [0.35, 4.9, 0.1], [0.6, 5.0, -0.3]], 0.34, { rs: 8, seg: 16 }), (v) => { v.x += Math.sin(v.y * 7) * 0.06; v.z += Math.cos(v.y * 5) * 0.05; }, 70));
    if (D) b.add('cloth_rag', deform(tube([[0, 4.2, 0], [-0.5, 4.5, 0.4], [-0.9, 4.2, 0.7]], 0.12, { rs: 6, seg: 10 }), (v) => { v.y += Math.sin(v.x * 9) * 0.04; }, 70));
    b.anchor('muzzle', [0.6, 5.0, -0.3]);
    b.anchor('pivot', [0, 0, 0]);
    return nadeCfg(0, true);
  }
  b.anchor('muzzle', [0, top + 0.6, 0]);
  b.anchor('pivot', [0, 0, 0]);
  return nadeCfg(top, false);
}
function nadeCfg(top, bottle) {
  return {
    hands: {
      R: bottle ? { p: [0.95, -0.5, 0.4], across: [0, -1, 0.1], palm: [-1, 0, -0.2], pose: 'wrap' }
        : { p: [1.1, -0.2, 0.4], across: [0, -0.95, 0.2], palm: [-0.95, 0, -0.3], pose: 'cup' },
      L: { p: [-2.5, -2.0, 1.0], across: [0, -0.9, 0.3], palm: [0.9, 0.2, -0.3], pose: 'relaxed' },
    },
    family: 'grenade',
  };
}

// ---------------- C4 ----------------
export function buildC4(b) {
  const D = b.detail;
  // three wrapped explosive blocks strapped together, control box + keypad + LCD on top
  for (let i = 0; i < 3; i++) {
    b.add('c4_clay', box(2.0, 1.25, 7.0, { r: 0.2 }), { p: [(i - 1) * 2.05, -0.65, 0] });
    if (D) b.add('wrapper', box(2.04, 1.28, 5.0, { r: 0.22 }), { p: [(i - 1) * 2.05, -0.65, 0], c: 0xb0b098 });
  }
  for (const z of [-2.4, 2.4]) b.add('tape', box(6.4, 1.4, 0.9, { r: 0.15 }), { p: [0, -0.62, z] });
  // control box
  b.add('paint_black', box(3.6, 0.7, 4.2, { r: 0.12 }), { p: [0, 0.35, 0.3] });
  b.add('lcd', box(2.2, 0.06, 0.8, { r: 0.04 }), { p: [0, 0.72, -1.05] });
  if (D) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) b.add('polymer', box(0.55, 0.14, 0.42, { r: 0.06 }), { p: [(c - 1) * 0.68, 0.74, 0.0 + r * 0.55] });
    b.add('led_red', sphere(0.1, 8, 6), { p: [1.45, 0.75, -1.05] });
    // wires from the box into the blocks
    b.add('wire_red', tube([[-1.5, 0.4, 1.8], [-2.4, 0.6, 2.4], [-2.3, 0.1, 3.2], [-2.0, -0.2, 3.5]], 0.07, { rs: 6 }));
    b.add('wire_blue', tube([[1.4, 0.4, 1.9], [2.3, 0.7, 2.6], [2.2, 0.0, 3.3], [2.0, -0.2, 3.5]], 0.07, { rs: 6 }));
    b.add('wire_yellow', tube([[0.5, 0.4, 2.3], [0.6, 0.9, 3.0], [0.2, 0.3, 3.6], [0.0, -0.2, 3.55]], 0.06, { rs: 6 }));
    for (const x of [-2.0, 0, 2.0]) b.add('steel', cyl(0.12, 0.12, 0.6, 8, { axis: 'y' }), { p: [x, 0.0, 3.55] });
  }
  b.anchor('muzzle', [0, 0.8, -3]);
  b.anchor('pivot', [0, 0, 0]);
  return {
    hands: {
      R: { p: [3.55, -0.7, 0.8], across: [0, 0, 1], palm: [-1, 0.1, 0], pose: 'cup' },
      L: { p: [-3.55, -0.7, 0.8], across: [0, 0, 1], palm: [1, 0.1, 0], pose: 'cup' },
    },
    family: 'c4',
  };
}

// ---------------- defuse kit (world / HUD model) ----------------
export function buildDefuseKit(b) {
  b.add('wrapper', box(3.2, 1.2, 5.2, { r: 0.35 }), { c: 0x6a7a55 });
  b.add('tape', box(3.3, 0.3, 0.8, { r: 0.1 }), { p: [0, 0.55, 1.2] });
  // pliers + cutters peeking out
  b.add('wire_red', box(0.5, 0.35, 2.4, { r: 0.12 }), { p: [-0.6, 0.7, -2.6], r: [0, 8, 0] });
  b.add('wire_red', box(0.5, 0.35, 2.4, { r: 0.12 }), { p: [0.2, 0.7, -2.6], r: [0, -8, 0] });
  b.add('steel', box(0.6, 0.25, 1.4, { r: 0.08 }), { p: [-0.2, 0.75, -4.2] });
  b.add('steel', cyl(0.12, 0.12, 0.8, 10, { axis: 'y' }), { p: [0.9, 1.0, -1.8] });
  b.anchor('muzzle', [0, 0, -5]);
  b.anchor('pivot', [0, 0, 0]);
  return { hands: {}, family: 'c4' };
}
