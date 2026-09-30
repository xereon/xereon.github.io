// Floors: sand, setts, cobbles, asphalt, curbs, flagstones, gravel, rubble, floor tiles.
import { C } from './util.js';

const SAND_LOW = (s) => /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) {
  a = sandLow(uv, ${s.toFixed(1)});
  b = vec4(warpFbm(uv, 3.0, 0.3, 4, 40.0), fbmU(uv, 6.0, 3, 0.5, 41.0), 0.0, 0.0);
}
`;

// Pale compacted dust / sand: the default ground everywhere.
export const sand_floor = {
  hero: true, world: 256, normal: 1.0, ao: 0.7, aoRadius: 5, cavity: 0.3, cavRough: 0.02,
  antiTile: true, macro: [0.12, 0.04], surface: 'sand', seed: 201,
  lowGlsl: SAND_LOW(0),
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  sandSurf(uv, LOWA(uv), 0.35, 0.0, o);
}
`,
};

// Sand drifted over buried setts: mostly sand, stones peek through in patches.
export const sand_blend = {
  world: 256, normal: 1.0, ao: 0.8, aoRadius: 5, cavity: 0.35, antiTile: true, macro: [0.12, 0.04],
  surface: 'sand', seed: 202,
  lowGlsl: SAND_LOW(5),
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv), L2 = LOWB(uv);
  float hs = sandSurf(uv, L, 0.4, 5.0, o);
  vec4 st = setts(uv, 26.0, 0.35, 0.05, 0.12, 50.0);
  vec3 hr = hash3(vec2(st.y * 991.0, 1.0), 51.0);
  float expose = smoothstep(0.35, 0.6, L2.x + 0.25 * fbmU(uv, 20.0, 2, 0.5, 52.0));
  float hStone = 0.35 * st.x + 0.03 * st.w;
  float stone = expose * smoothstep(0.1, 0.4, st.x);
  vec3 sc = mix(${C('#9d9180')}, ${C('#7f766a')}, hr.x) * (0.95 + 0.06 * fbmU(uv, 60.0, 2, 0.5, 53.0));
  sc = mix(sc, o.col, 0.35 * (1.0 - expose));                  // dust film on the stones
  o.h = mix(hs, max(hs, hStone), expose);
  o.col = mix(o.col, sc, stone);
  o.rough = mix(o.rough, 0.8, stone);
}
`,
};

// Grey-beige setts laid in courses, sand in the joints, dust film in patches (T road, mid).
export const cobblestone = {
  hero: true, world: 256, normal: 1.1, ao: 1.0, aoRadius: 5, cavity: 0.45, cavRough: 0.04,
  antiTile: true, macro: [0.1, 0.04], surface: 'rock', seed: 203,
  lowGlsl: SAND_LOW(9),
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv), L2 = LOWB(uv);
  vec2 wu = uv + 0.0015 * vec2(gnU(uv, 24.0, 1.0), gnU(uv, 24.0, 2.0));
  Cell c = ashlar(wu, 22.0, 19.0, 25.0, 0.3, 60.0);
  vec3 hr = hash3(c.id, 61.0);
  float jw = 0.0022 + 0.0014 * hr.x;
  float e = roundEdge(c, 0.006) + 0.0012 * fbmU(uv, 60.0, 2, 0.5, 66.0);
  float crown = pillow(e - jw, 0.0075);
  float bump = fbmU(uv + hr.xy, 70.0, 2, 0.5, 62.0);
  float tilt = dot(c.local - 0.5, hr.yz - 0.5) * 0.25;
  float sink = -0.12 * smoothstep(0.8, 1.0, hr.z);
  float hS = 0.5 * crown + (0.03 * bump + tilt + sink + 0.05 * hr.x) * crown;
  float hJ = 0.1 + 0.03 * fbmU(uv, 140.0, 2, 0.5, 63.0);
  float h = max(hS, hJ);
  float inJ = 1.0 - smoothstep(0.0, 0.05, hS - hJ);
  vec3 sc = mix(${C('#b4a996')}, ${C('#998e7e')}, hr.y);
  sc = mix(sc, ${C('#827a70')}, smoothstep(0.78, 1.0, hr.x) * 0.9);
  sc = mix(sc, ${C('#c6bca8')}, smoothstep(0.82, 1.0, hr.z) * 0.7);
  sc *= 0.96 + 0.04 * bump + 0.025 * fbmU(uv, 12.0, 2, 0.5, 64.0);
  vec3 dustC = ${C('#cfc2a6')} * (0.97 + 0.04 * fbmU(uv, 90.0, 2, 0.5, 65.0));
  // dust: fills joints, films crowns where the low field says so, thicker at sunken setts
  float film = smoothstep(-0.05, 0.55, L2.x - 2.0 * sink);
  vec3 col = mix(sc, dustC, film * (0.45 + 0.4 * (1.0 - crown)));
  col = mix(col, dustC * 0.96, inJ);
  col *= 1.0 - 0.08 * (1.0 - crown) * (1.0 - inJ);
  o.h = h; o.col = col;
  o.rough = mix(mix(0.72 + 0.1 * hr.y, 0.9, film), 0.97, inJ);
}
`,
};

// Rectangular stone paving slabs in running bond (sidewalks, plazas).
export const paving_setts = {
  world: 128, normal: 1.0, ao: 1.0, aoRadius: 5, cavity: 0.45, antiTile: true, macro: [0.1, 0.04],
  surface: 'rock', seed: 204,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 wu = uv + 0.0008 * vec2(gnU(uv, 8.0, 1.0), gnU(uv, 8.0, 2.0));
  Cell b = bricks(wu, 8.0, 5.0, 0.5, 3.0);
  vec3 hr = hash3(b.id, 4.0);
  float ero = fbmU(uv, 30.0, 3, 0.5, 5.0);
  float e = roundEdge(b, 0.012) + 0.002 * ero - 0.0015 * hr.z;
  float prof = pillow(e - 0.004, 0.01);
  float bump = fbmU(uv + hr.xy, 20.0, 3, 0.5, 6.0);
  float cr = crackNet(uv, 6.0, 0.25, 1.0, 7.0) * step(0.7, hr.x);
  float hS = 0.5 * prof + 0.04 * bump + 0.05 * dot(b.local - 0.5, hr.yz - 0.5) - 0.12 * cr;
  float hJ = 0.1 + 0.02 * fbmU(uv, 120.0, 2, 0.5, 8.0);
  o.h = max(hS, hJ);
  float inJ = 1.0 - smoothstep(0.0, 0.05, hS - hJ);
  vec3 sc = mix(${C('#bcb3a3')}, ${C('#a59c8d')}, hr.y);
  sc = mix(sc, ${C('#958c80')}, smoothstep(0.8, 1.0, hr.x) * 0.7);
  sc *= 0.96 + 0.04 * bump + 0.02 * fbmU(uv, 70.0, 2, 0.5, 9.0);
  float dust = smoothstep(0.0, 0.6, warpFbm(uv, 3.0, 0.3, 3, 10.0));
  sc = mix(sc, ${C('#cdbfa2')}, dust * 0.4);
  sc *= 1.0 - 0.3 * cr;
  o.col = mix(sc, ${C('#c8b99c')}, inJ);
  o.rough = mix(0.8 + 0.08 * dust, 0.96, inJ);
}
`,
};

// Warm grey road asphalt: aggregate grain, cracks, repair patches, sandy blotches.
export const asphalt = {
  hero: true, world: 256, normal: 0.8, ao: 0.8, aoRadius: 4, cavity: 0.35, cavRough: 0.03,
  antiTile: true, macro: [0.1, 0.05], surface: 'concrete', seed: 205,
  lowGlsl: /* glsl */`
void lowField(vec2 uv, out vec4 a, out vec4 b) {
  a = vec4(fbmU(uv, 3.0, 3, 0.5, 1.0), warpFbm(uv, 5.0, 0.25, 4, 2.0), fbmU(uv, 2.0, 3, 0.5, 3.0), warpFbm(uv, 4.0, 0.3, 4, 4.0));
  b = vec4(0.0);
}
`,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec4 L = LOWA(uv);
  float fine = fbmU(uv, 160.0, 2, 0.6, 5.0);
  vec4 ag = sparse(uv * 240.0, vec2(240.0), 0.55, 6.0);
  float agg = (1.0 - smoothstep(0.15, 0.4, ag.x)) * step(0.0, ag.y);
  float cr = crackNet(uv, 5.0, 0.35, 1.4, 7.0) + 0.6 * crackNet(uv, 13.0, 0.2, 1.0, 8.0);
  cr = sat(cr);
  // repair patches: rounded rectangles of fresher, darker tarmac (rare)
  vec4 rp = sparse(uv * 5.0, vec2(5.0), 0.12, 9.0);
  vec2 rd = abs(rp.zw) - vec2(0.18 + 0.2 * fract(rp.y * 7.0), 0.12 + 0.15 * fract(rp.y * 3.0));
  float patchM = (1.0 - smoothstep(-0.01, 0.0, max(rd.x, rd.y))) * step(0.0, rp.y);
  // pale sandy blotches with crisp, ragged edges
  float bl = L.y + 0.3 * fbmU(uv, 30.0, 3, 0.5, 10.0) + 0.05 * gnU(uv, 120.0, 11.0);
  float blot = smoothstep(0.66, 0.69, bl);
  float dusty = smoothstep(0.1, 0.8, L.w);
  vec4 oil = sparse(uv * 7.0, vec2(7.0), 0.15, 12.0);
  float oilM = (1.0 - smoothstep(0.1, 0.4, oil.x * (1.0 + 0.4 * gnU(uv, 40.0, 13.0)))) * step(0.0, oil.y);
  o.h = 0.4 + 0.04 * L.x + 0.012 * fine + 0.03 * agg - 0.15 * cr + 0.03 * patchM + 0.02 * blot;
  vec3 c = mix(${C('#857d74')}, ${C('#7a736c')}, sat(L.z * 0.5 + 0.5));
  c = mix(c, ${C('#67615c')}, patchM * 0.8);
  c *= 0.97 + 0.03 * fine;
  c = mix(c, ${C('#a39a8e')}, agg * 0.3);
  c = mix(c, ${C('#9d9282')}, dusty * 0.25);
  c = mix(c, ${C('#5a5550')}, oilM * 0.5);
  c = mix(c, ${C('#b8ac98')} * (0.95 + 0.06 * fine), blot * 0.8);
  c *= 1.0 - 0.35 * cr;
  o.col = c;
  o.rough = 0.86 + 0.06 * dusty + 0.05 * blot - 0.04 * patchM;
  o.ao = 1.0 - cr * 0.3;
}
`,
};

// Concrete kerb painted in alternating red / white blocks along u. One tile = 64u:
// map u along the kerb (world uv does this for kerbs running along x or z).
export const curb_redwhite = {
  world: 64, normal: 1.0, ao: 0.8, aoRadius: 4, cavity: 0.35, antiTile: false, macro: [0.06, 0.04],
  surface: 'concrete', seed: 206,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float fine = fbmU(uv, 90.0, 2, 0.55, 1.0);
  float seg = step(0.5, fract(uv.x));
  float joint = 1.0 - smoothstep(0.004, 0.008, min(abs(fract(uv.x) - 0.5), min(fract(uv.x), 1.0 - fract(uv.x))));
  float chips = fbmU(uv, 12.0, 4, 0.5, 2.0) + 0.1 * gnU(uv, 60.0, 3.0);
  float wear = smoothstep(0.62, 0.64, chips + 0.3 * fbmU(uv, 3.0, 2, 0.5, 4.0));
  float scuff = smoothstep(0.1, 0.7, fbm(uv * vec2(4.0, 24.0), vec2(4.0, 24.0), 3, 0.5, 5.0));
  vec3 red = mix(${C('#a4463a')}, ${C('#b25a4c')}, sat(fbmU(uv, 4.0, 3, 0.5, 6.0) + 0.5));
  vec3 wht = ${C('#dcd6ca')} * (0.97 + 0.03 * fbmU(uv, 6.0, 2, 0.5, 7.0));
  vec3 paint = mix(red, wht, seg);
  vec3 conc = ${C('#a8a092')} * (0.94 + 0.05 * fine);
  float dirt = smoothstep(0.0, 0.6, warpFbm(uv, 3.0, 0.3, 3, 8.0));
  paint *= mix(vec3(1.0), vec3(0.85, 0.82, 0.78), dirt * 0.5 + scuff * 0.2);
  o.h = 0.5 + 0.01 * fine + 0.03 * (1.0 - wear) - 0.2 * joint;
  o.col = mix(paint, conc, wear) * (1.0 - 0.35 * joint);
  o.rough = mix(0.7 + 0.1 * dirt, 0.92, wear);
}
`,
};

// B-site irregular flagstones: big rounded polygons, sandy joints, warm tan.
export const flagstone = {
  world: 192, normal: 1.1, ao: 1.0, aoRadius: 6, cavity: 0.45, antiTile: true, macro: [0.1, 0.04],
  surface: 'rock', seed: 207,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 wq = uv + 0.012 * vec2(fbmU(uv, 6.0, 3, 0.5, 1.0), fbmU(uv + 0.4, 6.0, 3, 0.5, 2.0));
  vec2 cen; vec4 w = worleyC(wq * 5.0, vec2(5.0), 0.95, 3.0, cen);
  vec3 hr = hash3(vec2(w.z * 997.0, 1.0), 4.0);
  float e = w.w - 0.03 - 0.02 * hr.x + 0.012 * fbmU(uv, 30.0, 3, 0.5, 5.0);
  float prof = pillow(e, 0.07);
  float bump = fbmU(uv + hr.xy, 10.0, 4, 0.5, 6.0);
  float fine = fbmU(uv, 80.0, 2, 0.5, 7.0);
  float hS = 0.6 * prof + (0.07 * bump + 0.01 * fine) * prof + 0.06 * dot(wq * 5.0 - cen, hr.yz - 0.5);
  float hJ = 0.15 + 0.03 * fbmU(uv, 100.0, 2, 0.5, 8.0);
  o.h = max(hS, hJ);
  float inJ = 1.0 - smoothstep(0.0, 0.06, hS - hJ);
  vec3 sc = mix(${C('#d2b88e')}, ${C('#c2a47c')}, hr.y);
  sc = mix(sc, ${C('#dcc6a0')}, smoothstep(0.7, 1.0, hr.z) * 0.7);
  sc = mix(sc, ${C('#b2987a')}, smoothstep(0.8, 1.0, hr.x) * 0.6);
  sc *= 0.96 + 0.05 * bump + 0.015 * fine;
  float dust = smoothstep(0.0, 0.6, warpFbm(uv, 3.0, 0.3, 3, 9.0));
  sc = mix(sc, ${C('#dcc8a4')}, dust * 0.35);
  sc *= 1.0 - 0.08 * (1.0 - prof);
  o.col = mix(sc, ${C('#d6c09a')} * (0.95 + 0.05 * fine), inJ);
  o.rough = mix(0.82 + 0.06 * dust, 0.97, inJ);
}
`,
};

// Packed pebbles in dirt.
export const gravel = {
  world: 64, normal: 1.2, ao: 1.0, aoRadius: 5, cavity: 0.5, antiTile: true, macro: [0.12, 0.05],
  surface: 'gravel', seed: 208,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec3 a = fieldStones(uv, vec2(22.0), 0.55, 1.4, 1.2, 1.0);
  vec3 b = fieldStones(uv + 0.013, vec2(34.0), 0.5, 1.3, 1.2, 2.0);
  float ha = a.x * 0.5, hb = b.x * 0.38 - 0.05;
  float top = step(hb, ha);
  float id = mix(b.y, a.y, top);
  float hp = max(ha, hb);
  vec3 hr = hash3(vec2(id * 991.0, 3.0), 4.0);
  float dirtH = 0.12 + 0.05 * fbmU(uv, 16.0, 3, 0.5, 5.0) + 0.02 * fbmU(uv, 120.0, 2, 0.5, 6.0);
  o.h = max(hp, dirtH);
  float isD = 1.0 - smoothstep(0.0, 0.04, hp - dirtH);
  vec3 pc = mix(${C('#b0a490')}, ${C('#857a6c')}, hr.x);
  pc = mix(pc, ${C('#a08466')}, smoothstep(0.7, 1.0, hr.y) * 0.7);
  pc = mix(pc, ${C('#cfc6b6')}, smoothstep(0.85, 1.0, hr.z) * 0.8);
  pc *= 0.94 + 0.08 * fbmU(uv, 90.0, 2, 0.5, 7.0);
  vec3 dc = ${C('#b8a585')} * (0.93 + 0.08 * fbmU(uv, 40.0, 3, 0.5, 8.0));
  o.col = mix(pc, dc, isD);
  o.rough = mix(0.7 + 0.15 * hr.y, 0.96, isD);
}
`,
};

// Loose rubble: broken angular stone and plaster chunks in dust.
export const rubble = {
  world: 128, normal: 1.3, ao: 1.0, aoRadius: 7, cavity: 0.55, antiTile: true, macro: [0.1, 0.05],
  surface: 'rock', seed: 209,
  glsl: /* glsl */`
float chunkLayer(vec2 uv, float F, float s, out float id) {
  vec2 cen; vec4 w = worleyC(uv * F, vec2(F), 0.9, s, cen);
  vec3 hr = hash3(vec2(w.z * 997.0, s), s + 1.0);
  vec2 d = uv * F - cen;
  // angular: planar facets per chunk, cut by the cell border
  float face = 0.6 + dot(d, (hr.xy - 0.5) * 1.6) + 0.1 * hr.z;
  float edge = smoothstep(0.02, 0.12 + 0.1 * hr.z, w.w - 0.04);
  id = w.z;
  return face * edge * (0.6 + 0.8 * hr.z) - (1.0 - edge) * 0.2;
}
void surface(vec2 uv, inout Surf o) {
  float i1, i2;
  float a = chunkLayer(uv, 7.0, 1.0, i1) * 1.4;
  float b = chunkLayer(uv + 0.031, 13.0, 2.0, i2) * 0.8;
  float bump = fbmU(uv, 40.0, 3, 0.5, 3.0);
  float top = step(b, a);
  float id = mix(i2, i1, top);
  float hc = max(a, b) + 0.05 * bump;
  float dust = 0.1 + 0.08 * fbmU(uv, 10.0, 3, 0.5, 4.0);
  o.h = max(hc, dust);
  float isD = 1.0 - smoothstep(0.0, 0.05, hc - dust);
  vec3 hr = hash3(vec2(id * 991.0, 5.0), 6.0);
  vec3 cc = mix(${C('#cdbf9f')}, ${C('#a49680')}, hr.x);
  cc = mix(cc, ${C('#ddd6c6')}, step(0.8, hr.y) * 0.8);       // plaster chunks
  cc = mix(cc, ${C('#a8704e')}, step(0.9, hr.z) * 0.8);       // brick bits
  cc *= 0.93 + 0.08 * bump;
  vec3 dc = ${C('#c9b898')} * (0.94 + 0.06 * fbmU(uv, 70.0, 2, 0.5, 7.0));
  o.col = mix(cc, dc, isD);
  o.rough = mix(0.84, 0.96, isD);
}
`,
};

// Terracotta floor tiles, worn centres, dusty grout, the odd cracked tile.
export const tile_floor = {
  world: 64, normal: 1.0, ao: 0.9, aoRadius: 4, cavity: 0.4, antiTile: true, macro: [0.1, 0.05],
  surface: 'tile', seed: 210,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  Cell t = bricks(uv, 4.0, 4.0, 0.0, 1.0);
  vec3 hr = hash3(t.id, 2.0);
  float e = roundEdge(t, 0.015) + 0.002 * fbmU(uv, 30.0, 3, 0.5, 3.0);
  float prof = pillow(e - 0.006, 0.012);
  float cr = crackNet(uv, 5.0, 0.3, 1.0, 4.0) * step(0.75, hr.z);
  float wearN = fbmU(uv, 6.0, 3, 0.5, 5.0);
  float fine = fbmU(uv, 90.0, 2, 0.5, 6.0);
  o.h = 0.35 * prof + 0.01 * fine - 0.1 * cr;
  float inJ = 1.0 - smoothstep(0.0, 0.25, prof);
  vec3 tc = mix(${C('#b8744e')}, ${C('#a8603e')}, hr.y);
  tc = mix(tc, ${C('#c88c62')}, smoothstep(0.7, 1.0, hr.x) * 0.7);
  tc *= 0.95 + 0.04 * fine + 0.03 * wearN;
  float dust = smoothstep(-0.1, 0.6, wearN);
  tc = mix(tc, ${C('#c9ad8a')}, dust * 0.35);
  tc *= 1.0 - 0.3 * cr;
  o.col = mix(tc, ${C('#bca888')}, inJ);
  o.rough = mix(0.7 + 0.15 * dust, 0.96, inJ);
}
`,
};
