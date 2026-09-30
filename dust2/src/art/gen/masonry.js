// Walls: lime plaster family, painted bands, adobe, stone, brick, concrete, tiles, roof.
// Heights are in world units (inches); world = units covered by one tile.
import { C } from './util.js';

const PLASTER_LOW = (seed) => /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) { plasterLow(uv, ${seed.toFixed(1)}, a, b); }
`;

// Dominant Dust II wall: off-white lime plaster, crisp flakes to tan render and brick.
export const plaster_white = {
  hero: true, world: 256, normal: 1.0, ao: 0.9, aoRadius: 6, cavity: 0.4, cavRough: 0.04,
  antiTile: true, macro: [0.10, 0.05], surface: 'plaster', seed: 101,
  lowGlsl: PLASTER_LOW(0),
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  limePlaster(uv, LOWA(uv), LOWB(uv), ${C('#e0dacd')}, ${C('#d4c9b4')}, 0.5, 0.9, 0.0, o);
  float cr = crackNet(uv, 5.0, 0.3, 1.1, 40.0) * step(0.99, o.h);
  o.h -= cr * 0.12; o.col *= 1.0 - cr * 0.25; o.ao = 1.0 - cr * 0.3;
}
`,
};

// Older, warmer cream plaster (the classic sandstone-toned Dust look), more worn.
export const plaster_wall = {
  hero: true, world: 256, normal: 1.0, ao: 0.9, aoRadius: 6, cavity: 0.4, cavRough: 0.04,
  antiTile: true, macro: [0.12, 0.05], surface: 'plaster', seed: 11,
  lowGlsl: PLASTER_LOW(7),
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  limePlaster(uv, LOWA(uv), LOWB(uv), ${C('#dccaa6')}, ${C('#cbb38a')}, 0.42, 1.0, 7.0, o);
  float cr = crackNet(uv, 5.0, 0.4, 1.2, 40.0) * step(0.99, o.h);
  o.h -= cr * 0.15; o.col *= 1.0 - cr * 0.3; o.ao = 1.0 - cr * 0.35;
}
`,
};

// Ledges, cornices, window surrounds: smoother, paler, edge-worn.
export const plaster_trim = {
  world: 128, normal: 0.9, ao: 0.8, aoRadius: 5, cavity: 0.35, antiTile: true, macro: [0.08, 0.04],
  surface: 'plaster', seed: 31,
  lowGlsl: PLASTER_LOW(31),
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  limePlaster(uv, LOWA(uv), LOWB(uv), ${C('#e8e3d8')}, ${C('#d9d1c2')}, 0.5, 0.9, 31.0, o);
  o.col *= mix(vec3(1.0), vec3(0.86, 0.84, 0.8), LOWA(uv).z * 0.3);
}
`,
};

// Painted lower band (use as its own strip of wall ~48-64u tall; tiles both ways).
function band(paint0, paint1, grime, loss, seed) {
  return {
    world: 128, normal: 1.0, ao: 0.9, aoRadius: 5, cavity: 0.4, antiTile: true, macro: [0.08, 0.05],
    surface: 'plaster', seed,
    lowGlsl: PLASTER_LOW(seed),
    glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv), L2 = LOWB(uv);
  float cover = limePlaster(uv, L, L2, ${C('#e2dccf')}, ${C('#d6ccb8')}, 0.66, 0.4, 3.0, o);
  // paint film: gentle sun fade, clustered flaking to the lime below, horizontal scuffs
  vec3 pc = mix(${C(paint0)}, ${C(paint1)}, sat(L2.z * 0.6 + 0.45));
  float dens = L2.w;                                   // where the paint is failing
  float chips = fbmU(uv, 10.0, 3, 0.5, 61.0) + 0.06 * gnU(uv, 60.0, 62.0);
  float scuff = fbm(uv * vec2(3.0, 36.0), vec2(3.0, 36.0), 3, 0.5, 63.0);
  float fn = 0.8 * chips + 0.6 * dens + 0.08 * scuff;
  float lost = smoothstep(${loss.toFixed(3)}, ${(loss + 0.012).toFixed(3)}, fn);
  float edge = smoothstep(${(loss - 0.08).toFixed(3)}, ${loss.toFixed(3)}, fn) * (1.0 - lost);
  float paint = cover * (1.0 - lost);
  pc *= mix(vec3(1.0), vec3(${grime}), L.z * 0.6);
  pc *= 0.975 + 0.025 * fbmU(uv, 40.0, 2, 0.5, 65.0);
  pc *= 1.0 - 0.06 * edge;
  o.col = mix(o.col, pc, paint);
  o.h += paint * 0.035;
  o.rough = mix(o.rough, 0.72 + 0.12 * L.z, paint);
}
`,
  };
}
export const plaster_band_teal = band('#5a9888', '#6ea696', '0.86, 0.85, 0.8', 0.52, 71);
export const plaster_band_ochre = band('#c89a48', '#d0a65a', '0.88, 0.86, 0.84', 0.62, 72);

// B-site earthen render over mud brick: orange-tan, lumpy, trowel swirls, straw flecks.
export const adobe = {
  world: 192, normal: 1.1, ao: 1.0, aoRadius: 7, cavity: 0.4, antiTile: true, macro: [0.12, 0.05],
  surface: 'plaster', seed: 81,
  lowGlsl: /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) {
  a = vec4(flakeField(uv, 3.0, 10.0), fbmU(uv, 2.0, 3, 0.5, 20.0), stainField(uv, 3.0, 21.0), warpFbm(uv, 10.0, 0.06, 4, 2.0));
  b = vec4(0.0);
}
`,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv);
  float low = fbmU(uv, 4.0, 4, 0.5, 1.0);
  float lump = L.w + 0.4 * fbmU(uv, 30.0, 2, 0.5, 5.0);
  float grain = fbmU(uv, 110.0, 2, 0.6, 3.0);
  float hA = 0.9 + 0.14 * low + 0.08 * lump + 0.018 * grain;
  // exposed mud bricks where the render has washed away
  float n = L.x + 0.2 * fbmU(uv, 24.0, 3, 0.5, 6.0);
  float lost = smoothstep(0.55, 0.565, n);
  Cell b = bricks(uv, 18.0, 8.0, 0.5, 11.0);
  float e = b.edge + 0.0016 * gnU(uv, 40.0, 12.0);
  float face = smoothstep(0.002, 0.009, e);
  float hB = face * (0.3 + 0.05 * fbmU(uv + b.rnd, 20.0, 3, 0.5, 13.0)) - 0.1;
  vec3 cB = mix(${C('#b07a4a')}, ${C('#c28e5a')}, b.rnd) * (0.93 + 0.06 * grain);
  cB = mix(${C('#a58a68')}, cB, face);
  // straw flecks
  vec4 sp = sparse(uv * 90.0, vec2(90.0), 0.35, 14.0);
  float straw = (1.0 - smoothstep(0.02, 0.06, abs(dot(sp.zw, normalize(vec2(1.0, 0.35 + sp.y))))))
              * (1.0 - smoothstep(0.1, 0.35, sp.x));
  vec3 ca = mix(${C('#cf9c62')}, ${C('#bf8a54')}, sat(L.y * 0.7 + 0.5));
  ca = mix(ca, ${C('#dab07c')}, sat(lump * 0.8) * 0.35);
  ca *= 0.96 + 0.04 * grain;
  ca *= mix(vec3(1.0), vec3(0.85, 0.81, 0.77), L.z * 0.5);
  ca = mix(ca, ${C('#e0c290')}, straw * 0.5);
  float cr = crackNet(uv, 6.0, 0.22, 1.1, 30.0) * (1.0 - lost);
  o.h = mix(hA, hB, lost) - cr * 0.1;
  o.col = mix(ca, cB, lost) * (1.0 - cr * 0.18);
  o.rough = mix(0.93, 0.96, lost);
  o.ao = 1.0 - cr * 0.3;
}
`,
};

// Pale sandstone ashlar with rounded, eroded arrises and recessed mortar.
export const stone_block = {
  hero: true, world: 256, normal: 1.1, ao: 1.0, aoRadius: 8, cavity: 0.5, cavRough: 0.05,
  antiTile: false, macro: [0.08, 0.04], surface: 'rock', seed: 21,
  lowGlsl: /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) {
  a = vec4(stainField(uv, 3.0, 14.0), fbmU(uv, 10.0, 3, 0.5, 1.0), fbmU(uv + 0.3, 10.0, 3, 0.5, 2.0), 0.0);
  b = vec4(0.0);
}
`,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv);
  vec2 wu = uv + vec2(0.0012 * L.y, 0.001 * L.z);
  Cell c = ashlar(wu, 8.0, 3.0, 5.0, 0.45, 3.0);
  vec3 hr = hash3(c.id, 9.0);
  float e = roundEdge(c, 0.022);
  float ero = fbmU(uv, 16.0, 4, 0.55, 4.0);
  float eN = e + 0.005 * ero + 0.001 * gnU(uv, 90.0, 5.0) - 0.004 * hr.z;
  float mortarW = 0.0028 + 0.0018 * vnU(uv, 20.0, 6.0);
  float prof = pillow(eN - mortarW, 0.02);
  float bump = fbmU(uv + c.rnd * 7.31, 8.0, 4, 0.5, 6.0);
  float fine = fbmU(uv, 96.0, 2, 0.5, 7.0);
  vec4 pit = sparse(uv * 48.0, vec2(48.0), mix(0.0, 0.35, smoothstep(0.7, 1.0, hr.x)), 8.0);
  float pits = (1.0 - smoothstep(0.1, 0.22, pit.x * (0.8 + 0.5 * pit.y))) * step(0.0, pit.y);
  float tilt = dot(c.local - 0.5, hr.xy - 0.5) * 1.2;
  float hS = 1.6 * prof + (0.16 * bump + 0.02 * fine + tilt - 0.3 * pits) * prof;
  float mf = fbmU(uv, 140.0, 2, 0.6, 12.0);
  float hM = 0.25 + 0.03 * mf;
  o.h = max(hS, hM);
  float isM = 1.0 - smoothstep(0.0, 0.1, hS - hM);
  vec3 sc = mix(${C('#d8c49a')}, ${C('#c7aa7c')}, hr.y);
  sc = mix(sc, ${C('#e0d2b2')}, smoothstep(0.6, 1.0, hr.z) * 0.8);
  sc = mix(sc, ${C('#bf9f74')}, smoothstep(0.75, 1.0, c.rnd) * 0.8);
  float mot = fbmU(uv + c.rnd * 3.1, 14.0, 4, 0.55, 13.0);
  sc *= 0.96 + 0.05 * mot + 0.015 * fine;
  sc = mix(sc * 1.05, sc, prof);                                  // fresh worn arrises
  sc *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.35, c.local.y)) * prof;   // grime settles at block feet
  sc *= 1.0 - pits * 0.25;
  sc *= mix(vec3(1.0), vec3(0.84, 0.81, 0.76), L.x * 0.5);
  vec3 mc = ${C('#a8977a')} * (0.88 + 0.08 * mf);
  o.col = mix(sc, mc, isM);
  o.rough = mix(0.82 + 0.03 * mot + 0.06 * pits, 0.96, isM);
  o.ao = 1.0 - pits * 0.3;
}
`,
};

// Rounded field stones set in mortar (wall bases, B site plinths).
export const stone_wall = {
  world: 128, normal: 1.2, ao: 1.0, aoRadius: 8, cavity: 0.55, antiTile: true, macro: [0.08, 0.04],
  surface: 'rock', seed: 41,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec3 st = fieldStones(uv, vec2(8.0, 11.0), 0.6, 1.35, 1.0, 1.0);
  vec3 hr = hash3(vec2(st.y * 997.0, 1.0), 2.0);
  float bump = fbmU(uv + hr.xy, 16.0, 4, 0.55, 4.0);
  float hS = st.x * (1.6 + 0.6 * hr.y) + (0.18 * bump + 0.03 * fbmU(uv, 90.0, 2, 0.5, 8.0)) * st.x;
  float mf = fbmU(uv, 120.0, 2, 0.6, 5.0);
  float hM = 0.45 + 0.04 * mf + 0.05 * fbmU(uv, 16.0, 2, 0.5, 6.0);
  o.h = max(hS, hM);
  float isM = 1.0 - smoothstep(0.0, 0.12, hS - hM);
  vec3 sc = mix(${C('#cbbda2')}, ${C('#9c8e78')}, hr.z * hr.z);
  sc = mix(sc, ${C('#dcd0b8')}, smoothstep(0.65, 1.0, hr.x) * 0.7);
  sc = mix(sc, ${C('#b89a76')}, smoothstep(0.7, 1.0, hr.y) * 0.6);
  sc *= 0.94 + 0.08 * fbmU(uv + hr.yz, 24.0, 3, 0.5, 7.0) + 0.05 * bump;
  vec3 mc = ${C('#bda886')} * (0.9 + 0.07 * mf);
  o.col = mix(sc, mc, isM);
  o.rough = mix(0.72 + 0.12 * hr.x, 0.96, isM);
}
`,
};

// Dressed arch voussoirs / quoins: big smooth sandstone blocks with chisel tooling.
export const arch_stone = {
  world: 128, normal: 1.0, ao: 0.9, aoRadius: 6, cavity: 0.45, antiTile: false, macro: [0.06, 0.03],
  surface: 'rock', seed: 51,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  Cell c = ashlar(uv, 3.0, 2.0, 2.0, 0.2, 1.0);
  vec3 hr = hash3(c.id, 2.0);
  float e = roundEdge(c, 0.03) + 0.0025 * fbmU(uv, 14.0, 4, 0.55, 3.0);
  float prof = pillow(e - 0.004, 0.03);
  vec2 dq = hr.x > 0.5 ? vec2(uv.x + uv.y, uv.x - uv.y) : vec2(uv.x - uv.y, uv.x + uv.y);
  float tool = fbm(dq * vec2(90.0, 12.0), vec2(90.0, 12.0), 2, 0.5, 4.0);
  float bump = fbmU(uv + c.rnd, 6.0, 4, 0.5, 5.0);
  float hS = 1.4 * prof + (0.08 * bump + 0.014 * tool) * prof;
  o.h = max(hS, 0.35);
  float isM = 1.0 - smoothstep(0.0, 0.1, hS - 0.35);
  vec3 sc = mix(${C('#dcc9a0')}, ${C('#cdb487')}, hr.y) * (0.97 + 0.04 * bump);
  float st = stainField(uv, 3.0, 6.0);
  sc *= mix(vec3(1.0), vec3(0.86, 0.83, 0.78), st * 0.45);
  sc = mix(sc * 1.04, sc, prof);
  o.col = mix(sc, ${C('#b3a084')}, isM);
  o.rough = mix(0.78 + 0.02 * tool, 0.95, isM);
}
`,
};

function brick(c0, c1, cBurnt, mortar, rows, cols, seed, world, rough) {
  return {
    world, normal: 1.1, ao: 1.0, aoRadius: 5, cavity: 0.45, antiTile: true, macro: [0.08, 0.04],
    surface: 'brick', seed,
    glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 wu = uv + vec2(0.0, 0.0005 * gnU(uv, 12.0, 1.0));
  Cell b = bricks(wu, ${rows.toFixed(1)}, ${cols.toFixed(1)}, 0.5, 2.0);
  vec3 hr = hash3(b.id, 3.0);
  float ero = fbmU(uv, 40.0, 3, 0.55, 4.0);
  float mw = 0.12 * b.size.y;
  float e = roundEdge(b, 0.25 * b.size.y) + 0.05 * b.size.y * ero - 0.08 * b.size.y * hr.z;
  float prof = pillow(e - mw, 0.3 * b.size.y);
  float bump = fbmU(uv + hr.xy, 24.0, 3, 0.5, 5.0);
  vec4 pit = sparse(uv * 120.0, vec2(120.0), 0.3, 6.0);
  float pits = (1.0 - smoothstep(0.1, 0.28, pit.x)) * step(0.0, pit.y);
  float hB = prof * (0.55 + 0.1 * hr.x) + 0.03 * bump * prof - 0.1 * pits * prof;
  float mf = fbmU(uv, 150.0, 2, 0.6, 7.0);
  float hM = 0.12 + 0.02 * mf;
  o.h = max(hB, hM);
  float isM = 1.0 - smoothstep(0.0, 0.05, hB - hM);
  vec3 bc = mix(${C(c0)}, ${C(c1)}, hr.y);
  bc = mix(bc, ${C(cBurnt)}, smoothstep(0.8, 1.0, hr.x) * 0.8);
  bc *= 0.95 + 0.06 * fbmU(uv, 60.0, 3, 0.5, 8.0) + 0.03 * bump;
  bc = mix(bc * 1.06, bc, prof);
  float st = stainField(uv, 3.0, 9.0);
  bc *= mix(vec3(1.0), vec3(0.85, 0.82, 0.8), st * 0.5);
  vec3 mc = ${C(mortar)} * (0.9 + 0.08 * mf);
  o.col = mix(bc * (1.0 - pits * 0.2), mc, isM);
  o.rough = mix(${rough.toFixed(2)} + 0.02 * bump, 0.97, isM);
}
`,
  };
}
export const brick_tan = brick('#c49a6a', '#b48658', '#8f6444', '#c2b397', 16, 4, 61, 64, 0.86);
export const brick_red = brick('#a85a44', '#b8705a', '#7a3e30', '#c9bca4', 16, 4, 62, 64, 0.84);

// Cast concrete wall panels: V-seams, tie holes, water streaks, pores.
export const concrete_wall = {
  world: 128, normal: 1.0, ao: 0.9, aoRadius: 5, cavity: 0.4, antiTile: true, macro: [0.09, 0.05],
  surface: 'concrete', seed: 91,
  lowGlsl: /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) {
  a = vec4(stainField(uv, 3.0, 5.0), streaks(uv, 26.0, 2.0, 6.0), fbmU(uv, 4.0, 3, 0.5, 1.0), fbmU(uv, 16.0, 3, 0.5, 4.0));
  b = vec4(0.0);
}
`,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv);
  float fine = fbmU(uv, 80.0, 3, 0.55, 2.0);
  vec4 pw = sparse(uv * 90.0, vec2(90.0), 0.4, 3.0);
  float pores = (1.0 - smoothstep(0.06, 0.2, pw.x)) * step(0.0, pw.y);
  float sx = abs(fract(uv.x * 2.0 + 0.25) - 0.5) / 2.0;
  float sy = abs(fract(uv.y * 1.0 + 0.1) - 0.5);
  float seam = 1.0 - smoothstep(0.0015, 0.004, min(sx, sy * 0.6));
  vec2 tg = fract(uv * vec2(4.0, 4.0) + vec2(0.125, 0.125)) - 0.5;
  float tie = 1.0 - smoothstep(0.02, 0.035, length(tg));
  o.h = 0.5 + 0.06 * L.z + 0.008 * fine - 0.1 * pores - 0.25 * seam - 0.18 * tie;
  vec3 c = mix(${C('#d3cdc1')}, ${C('#c3bbac')}, sat(L.z * 0.6 + 0.5));
  c *= 0.975 + 0.03 * L.w + 0.012 * fine;
  c *= mix(vec3(1.0), vec3(0.84, 0.83, 0.8), L.x * 0.5);
  c *= mix(vec3(1.0), vec3(0.8, 0.79, 0.77), L.y * 0.6);
  c *= 1.0 - 0.25 * pores - 0.15 * seam - 0.3 * tie;
  o.col = c;
  o.rough = 0.86 + 0.06 * L.x + 0.05 * pores;
}
`,
};

// Pale concrete ground slabs / rooftops: joints, cracks, dark water stains, dust.
export const concrete_floor = {
  world: 256, normal: 1.0, ao: 0.9, aoRadius: 5, cavity: 0.4, antiTile: true, macro: [0.12, 0.06],
  surface: 'concrete', seed: 92,
  lowGlsl: /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) {
  a = vec4(fbmU(uv, 4.0, 3, 0.5, 1.0), fbmU(uv, 18.0, 3, 0.5, 5.0), warpFbm(uv, 3.0, 0.3, 4, 6.0), fbmU(uv, 5.0, 4, 0.5, 7.0));
  b = vec4(0.0);
}
`,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv);
  float fine = fbmU(uv, 110.0, 2, 0.55, 2.0);
  vec2 g = abs(fract(uv * 2.0) - 0.5);
  float joint = 1.0 - smoothstep(0.494, 0.4975, max(g.x, g.y));
  float cr = crackNet(uv, 4.0, 0.35, 1.3, 3.0);
  vec4 pw = sparse(uv * 150.0, vec2(150.0), 0.35, 4.0);
  float pores = (1.0 - smoothstep(0.06, 0.2, pw.x)) * step(0.0, pw.y);
  o.h = 0.5 + 0.05 * L.x + 0.008 * fine - 0.25 * joint - 0.15 * cr - 0.06 * pores;
  vec3 c = mix(${C('#c9c1b2')}, ${C('#b9b09f')}, sat(L.x * 0.6 + 0.5));
  c *= 0.97 + 0.03 * L.y + 0.012 * fine;
  float wet = smoothstep(0.2, 0.6, L.z);
  c *= mix(vec3(1.0), vec3(0.74, 0.74, 0.73), wet * 0.5);
  float dust = smoothstep(0.0, 0.6, L.w);
  c = mix(c, ${C('#d8ccb4')}, dust * 0.35);
  c *= 1.0 - 0.3 * joint - 0.35 * cr - 0.2 * pores;
  o.col = c;
  o.rough = 0.88 - 0.08 * wet + 0.05 * dust;
  o.ao = 1.0 - cr * 0.3;
}
`,
};

// Glazed ceramic wall tiles, crackled, some chipped to the terracotta body.
export const tile_wall = {
  world: 64, normal: 1.0, ao: 0.8, aoRadius: 4, cavity: 0.35, antiTile: true, macro: [0.06, 0.08],
  surface: 'tile', seed: 111,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  Cell t = bricks(uv, 8.0, 8.0, 0.0, 1.0);
  vec3 hr = hash3(t.id, 2.0);
  float gw = 0.06 * t.size.x;
  float e = roundEdge(t, 0.08 * t.size.x);
  float face = pillow(e - gw, 0.06 * t.size.x);
  float chip = smoothstep(0.8, 0.82, fbmU(uv, 16.0, 4, 0.55, 3.0) + 0.3 * (1.0 - face) + 0.15 * hr.z);
  float craq = crackNet(uv, 14.0, 0.5, 0.8, 4.0);
  o.h = face * 0.3 - chip * 0.08 + 0.004 * gnU(uv + hr.xy, 12.0, 5.0);
  vec3 glaze = mix(${C('#e6e2d6')}, ${C('#d8d2c0')}, hr.y);
  glaze = mix(glaze, ${C('#5f9c96')}, (1.0 - step(0.5, abs(t.id.y - 2.0))) * 0.9);   // accent course
  glaze *= 1.0 - craq * 0.2;
  float st = stainField(uv, 3.0, 6.0);
  glaze *= mix(vec3(1.0), vec3(0.85, 0.83, 0.78), st * 0.4);
  vec3 body = ${C('#b87a56')} * (0.95 + 0.05 * gnU(uv, 80.0, 7.0));
  vec3 grout = ${C('#a79d8a')} * (0.92 + 0.08 * fbmU(uv, 120.0, 2, 0.5, 8.0));
  vec3 c = mix(glaze, body, chip);
  o.col = mix(grout, c, smoothstep(0.0, 0.2, face));
  o.rough = mix(0.95, mix(0.22 + 0.12 * st + 0.05 * craq, 0.9, chip), smoothstep(0.0, 0.2, face));
  o.ao = 1.0 - craq * 0.2;
}
`,
};

// Terracotta barrel (Spanish) roof tiles: courses along v, curved channels along u.
export const roof_tile = {
  world: 96, normal: 1.3, ao: 1.0, aoRadius: 6, cavity: 0.5, antiTile: false, macro: [0.1, 0.04],
  surface: 'tile', seed: 121,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float cols = 8.0, rows = 6.0;
  float x = uv.x * cols, y = uv.y * rows;
  float ci = floor(x), ri = floor(y);
  vec3 hr = hash3(vec2(ci, ri), 1.0);
  float fx = fract(x), fy = fract(y);
  float cap = mod(ci, 2.0);
  float arc = sin(fx * PI);
  float prof = mix(1.6 - 1.3 * arc, 1.0 + 2.2 * arc, cap);
  float lip = smoothstep(0.0, 0.85, 1.0 - fy) * 0.8 + smoothstep(0.93, 1.0, fy) * -0.7;
  float bump = fbmU(uv, 24.0, 3, 0.5, 2.0);
  o.h = prof + lip + 0.016 * bump + 0.05 * hr.x;
  vec3 c = mix(${C('#b8683f')}, ${C('#c98458')}, hr.y);
  c = mix(c, ${C('#9a5234')}, smoothstep(0.8, 1.0, hr.z) * 0.8);
  c *= 0.95 + 0.05 * fbmU(uv, 30.0, 3, 0.5, 3.0);
  float dust = smoothstep(0.0, 0.6, fbmU(uv, 6.0, 3, 0.5, 4.0)) * (1.0 - arc * cap);
  c = mix(c, ${C('#cdb38e')}, dust * 0.45);
  float lichen = smoothstep(0.55, 0.75, fbmU(uv, 12.0, 4, 0.5, 5.0));
  c = mix(c, ${C('#8f8a6a')}, lichen * 0.35);
  o.col = c;
  o.rough = 0.82 + 0.1 * dust;
}
`,
};
