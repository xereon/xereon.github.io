// Walls: plaster, stone, brick, concrete, arches, tiles, roof tiles.
import { C } from './util.js';

export const plaster_wall = {
  hero: true, world: 256, normal: 1.0, ao: 0.9, aoRadius: 10, cavity: 0.35, cavRough: 0.04,
  antiTile: true, macro: [0.12, 0.05], surface: 'plaster', seed: 11,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  // plaster relief: hand-laid undulation, lumps, sand grain, horizontal trowel strokes
  float low = fbmU(uv, 3.0, 4, 0.5, 1.0);
  float mid = fbmU(uv, 14.0, 4, 0.5, 2.0);
  float grain = fbmU(uv, 160.0, 2, 0.6, 3.0);
  float tro = fbm(uv * vec2(5.0, 40.0), vec2(5.0, 40.0), 3, 0.55, 4.0);
  float hP = 0.9 + 0.35 * low + 0.10 * mid + 0.022 * grain + 0.05 * tro;

  // spalled patches exposing brick
  float cn = warpFbm(uv, 3.0, 0.3, 5, 30.0) + 0.16 * fbmU(uv, 40.0, 3, 0.5, 31.0);
  float chip = smoothstep(0.40, 0.425, cn);
  float rim = smoothstep(0.33, 0.40, cn) * (1.0 - chip);
  float hB; vec3 cB; float rB;
  brickUnder(uv, 60.0, 20.0, hB, cB, rB);

  // hairline cracks
  float cr = crackNet(uv, 5.0, 0.45, 1.3, 40.0) + 0.7 * crackNet(uv, 11.0, 0.3, 1.0, 44.0);
  cr = sat(cr) * (1.0 - chip);

  o.h = mix(hP - rim * 0.12, hB, chip) - cr * 0.2;

  // colour: warm ochre plaster, large soft hue drift, stains, streaks
  float hue = fbmU(uv, 2.0, 3, 0.5, 50.0);
  vec3 base = mix(${C('#d8c29c')}, ${C('#ccb083')}, sat(hue * 1.4 + 0.5));
  base = mix(base, ${C('#e4d6b8')}, sat(-hue * 1.8 - 0.15) * 0.8);
  base *= 0.955 + 0.06 * fbmU(uv, 22.0, 3, 0.5, 51.0) + 0.03 * grain;
  float st = stainField(uv, 3.0, 52.0);
  float sk = streaks(uv, 34.0, 2.0, 53.0);
  base *= mix(vec3(1.0), vec3(0.83, 0.80, 0.75), st * 0.6);
  base *= mix(vec3(1.0), vec3(0.86, 0.84, 0.80), sk * 0.55);
  base = mix(base, ${C('#ece2cc')}, rim * 0.35);                 // fresh break is paler
  base *= 1.0 - cr * 0.45;
  o.col = mix(base, cB, chip);

  o.rough = mix(0.9 - 0.06 * sat(tro) + 0.04 * st, rB, chip);
  o.rough = mix(o.rough, 1.0, cr);
  o.ao = 1.0 - cr * 0.4;
}
`,
};

export const stone_block = {
  hero: true, world: 256, normal: 1.1, ao: 1.0, aoRadius: 12, cavity: 0.45, cavRough: 0.05,
  antiTile: false, macro: [0.08, 0.04], surface: 'rock', seed: 21,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 wu = uv + vec2(0.003 * fbmU(uv, 10.0, 3, 0.5, 1.0), 0.0025 * fbmU(uv + 0.3, 10.0, 3, 0.5, 2.0));
  Cell c = ashlar(wu, 7.0, 3.0, 5.0, 0.4, 3.0);
  float r = c.rnd;
  vec3 hr = hash3(c.id, 9.0);

  // worn, chipped arrises
  float e = roundEdge(c, 0.014);
  float ero = fbmU(uv, 20.0, 5, 0.55, 4.0);
  float eN = e + 0.005 * ero + 0.0015 * gnU(uv, 110.0, 5.0) - 0.004 * hr.z;
  float mortarW = 0.0028;
  float face = smoothstep(mortarW, mortarW + 0.016, eN);
  float prof = 1.0 - pow(1.0 - face, 2.2);

  // face relief: per-block offset noise, tilt, pits
  float bump = fbmU(uv + r * 7.31, 9.0, 5, 0.5, 6.0);
  float fine = fbmU(uv, 96.0, 3, 0.5, 7.0);
  vec2 pw = worleyF1(uv * 150.0 + r * 11.0, vec2(150.0), 0.9, 8.0);
  float pitAmt = mix(0.15, 0.9, smoothstep(0.55, 0.95, hr.x));
  float pits = (1.0 - smoothstep(0.08, 0.28, pw.x)) * step(0.55, fract(pw.y * 7.0)) * pitAmt;
  float tilt = dot(c.local - 0.5, hr.xy - 0.5) * 0.9;
  float hS = 1.4 * prof + (0.3 * bump + 0.05 * fine + tilt) * face - 0.22 * pits * face;

  float mf = fbmU(uv, 140.0, 2, 0.6, 12.0);
  float hM = 0.25 + 0.06 * mf;
  o.h = max(hS, hM);
  float isM = 1.0 - smoothstep(0.0, 0.08, hS - hM);

  // colour: pale limestone, per-block tint, mottling, lighter worn edges, darker pits
  vec3 tA = ${C('#d7c7a4')}, tB = ${C('#c8b28c')}, tC = ${C('#ddd1b8')}, tD = ${C('#cbb694')};
  vec3 sc = mix(tA, tB, hr.y);
  sc = mix(sc, tC, smoothstep(0.7, 1.0, hr.z) * 0.8);
  sc = mix(sc, tD, smoothstep(0.8, 1.0, r) * 0.7);
  float mot = fbmU(uv + r * 3.1, 16.0, 4, 0.55, 13.0);
  sc *= 0.94 + 0.10 * mot + 0.04 * fine;
  sc = mix(sc, sc * vec3(1.06, 1.05, 1.03), (1.0 - face) * 0.8);
  sc *= 1.0 - pits * 0.25;
  float st = stainField(uv, 3.0, 14.0);
  sc *= mix(vec3(1.0), vec3(0.85, 0.82, 0.77), st * 0.5);
  vec3 mc = ${C('#b8a888')} * (0.9 + 0.15 * mf);
  o.col = mix(sc, mc, isM);
  o.rough = mix(0.84 + 0.06 * mot + 0.05 * pits, 0.96, isM);
  o.ao = 1.0 - pits * 0.3;
}
`,
};
