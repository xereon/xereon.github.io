// Steel: roller shutters, grilles, beams, drums. Paint is dielectric (metal 0), rust is
// dielectric, only scratched bare steel is metallic.
import { C } from './util.js';

// Roll-up shop shutter / metal door: horizontal curved slats, faded paint, rust streaks.
export const metal_door = {
  world: 64, normal: 1.1, ao: 1.0, aoRadius: 4, cavity: 0.45, antiTile: true, macro: [0.08, 0.06],
  surface: 'metaldoor', seed: 401, metal: true,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float y = uv.y * 20.0, fy = fract(y), si = floor(y);
  float prof = 0.45 * sin(fy * PI) - 0.3 * (1.0 - smoothstep(0.0, 0.1, fy)) + 0.08 * smoothstep(0.8, 1.0, fy);
  float dent = 0.12 * fbmU(uv, 4.0, 3, 0.5, 1.0);
  float groove = 1.0 - smoothstep(0.0, 0.12, fy);
  // rust bleeding down from each hinge groove + big blooms
  float runs = smoothstep(0.1, 0.7, fbm(uv * vec2(40.0, 3.0), vec2(40.0, 3.0), 3, 0.5, 2.0));
  float bloom = smoothstep(0.5, 0.75, warpFbm(uv, 3.0, 0.3, 4, 3.0) + 0.2 * fbmU(uv, 30.0, 2, 0.5, 4.0));
  float rust = sat(max(bloom, groove * runs * 0.7) + 0.15 * groove);
  float chips = smoothstep(0.78, 0.8, fbmU(uv, 16.0, 3, 0.5, 5.0) + 0.2 * rust);
  float scratch = smoothstep(0.75, 0.9, fbm(uv * vec2(3.0, 90.0), vec2(3.0, 90.0), 2, 0.5, 6.0)) * (1.0 - rust);
  vec3 paint = mix(${C('#b9c0bc')}, ${C('#a3aca9')}, sat(fbmU(uv, 3.0, 3, 0.5, 7.0) + 0.5));
  paint *= 0.95 + 0.05 * fbmU(uv, 50.0, 2, 0.5, 8.0);
  float grime = smoothstep(0.0, 0.7, fbmU(uv, 5.0, 3, 0.5, 9.0));
  paint *= mix(vec3(1.0), vec3(0.8, 0.78, 0.74), grime * 0.4);
  vec3 rc = mix(${C('#8a5a3c')}, ${C('#6a4030')}, fbmU(uv, 40.0, 2, 0.5, 10.0) + 0.5);
  vec3 steel = ${C('#a4a6a6')};
  vec3 c = mix(paint, rc, rust * 0.85);
  c = mix(c, steel, max(chips * (1.0 - rust), scratch));
  o.h = prof + dent - 0.05 * rust;
  o.col = c;
  o.rough = mix(mix(0.55 + 0.15 * grime, 0.88, rust), 0.35, max(chips * (1.0 - rust), scratch));
  o.metal = 0.8 * max(chips * (1.0 - rust), scratch);
}
`,
};

// Welded bar grille (alpha-cut). Flat bars every 4u, cross bars every 8u.
export const metal_grate = {
  world: 32, normal: 1.0, ao: 0.8, aoRadius: 3, cavity: 0.3, antiTile: false, surface: 'metalgrate', seed: 411,
  metal: true, mat: { alphaTest: 0.5, side: 2 },
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 g = abs(fract(uv * vec2(8.0, 4.0)) - 0.5) / vec2(8.0, 4.0);   // distance to bar centres (uv)
  float wv = 0.009, wh = 0.012;
  float bv = 1.0 - smoothstep(wv - uPx.x, wv + uPx.x, g.x);
  float bh = 1.0 - smoothstep(wh - uPx.x, wh + uPx.x, g.y);
  float bar = max(bv, bh);
  float prof = max(bv * pillow(wv - g.x, wv), bh * (1.0 + 0.3 * pillow(wh - g.y, wh)));
  float rust = smoothstep(0.1, 0.6, fbmU(uv, 12.0, 3, 0.5, 1.0) + 0.3 * bv * bh);
  vec3 paint = ${C('#4d5450')} * (0.95 + 0.08 * fbmU(uv, 40.0, 2, 0.5, 2.0));
  vec3 c = mix(paint, ${C('#6e4834')}, rust * 0.8);
  float bare = smoothstep(0.6, 0.65, fbmU(uv, 30.0, 3, 0.5, 3.0)) * (1.0 - rust);
  o.h = prof * 0.5;
  o.col = mix(c, ${C('#8e9090')}, bare);
  o.rough = mix(0.6 + 0.3 * rust, 0.35, bare);
  o.metal = bare;
  o.alpha = bar;
}
`,
};

// Painted structural steel: rust blooms, flaking paint edges, bolt heads.
export const metal_beam = {
  world: 64, normal: 1.0, ao: 0.9, aoRadius: 4, cavity: 0.4, antiTile: true, macro: [0.1, 0.06],
  surface: 'metal', seed: 421, metal: true,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float n = warpFbm(uv, 3.0, 0.3, 4, 1.0) + 0.3 * fbmU(uv, 20.0, 3, 0.5, 2.0);
  float rust = smoothstep(0.3, 0.34, n);
  float halo = smoothstep(0.1, 0.3, n) * (1.0 - rust);
  float runs = smoothstep(0.2, 0.8, fbm(uv * vec2(24.0, 2.0), vec2(24.0, 2.0), 3, 0.5, 3.0)) * 0.5;
  float pits = smoothstep(0.3, 0.8, fbmU(uv, 90.0, 2, 0.5, 4.0)) * rust;
  float scratch = smoothstep(0.78, 0.9, fbm(uv * vec2(60.0, 4.0), vec2(60.0, 4.0), 2, 0.5, 5.0)) * (1.0 - rust);
  vec3 paint = mix(${C('#6d7470')}, ${C('#5c625f')}, sat(fbmU(uv, 3.0, 3, 0.5, 6.0) + 0.5));
  paint = mix(paint, ${C('#7a5a44')}, max(halo * 0.5, runs * 0.6));
  vec3 rc = mix(${C('#7c4a30')}, ${C('#5a3424')}, sat(fbmU(uv, 30.0, 3, 0.5, 7.0) + 0.5));
  vec3 c = mix(paint, rc, rust);
  c = mix(c, ${C('#909292')}, scratch);
  o.h = 0.4 + 0.08 * (1.0 - rust) - 0.08 * pits + 0.02 * fbmU(uv, 60.0, 2, 0.5, 8.0);
  o.col = c * (1.0 - 0.2 * pits);
  o.rough = mix(mix(0.5, 0.6, halo), 0.9, rust) - 0.2 * scratch;
  o.metal = scratch;
}
`,
};

// 55-gal drum: u = around, v = height (use mesh uvs of a cylinder). Rolling hoops, chimes,
// pale blue paint, rust at every edge, dents, dust at the foot.
export const metal_barrel = {
  world: 48, normal: 1.1, ao: 1.0, aoRadius: 4, cavity: 0.4, antiTile: false, surface: 'metal', seed: 431,
  metal: true,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float hoop = max(1.0 - smoothstep(0.0, 0.025, abs(uv.y - 0.333)), 1.0 - smoothstep(0.0, 0.025, abs(uv.y - 0.667)));
  float chime = max(1.0 - smoothstep(0.0, 0.03, uv.y), 1.0 - smoothstep(0.0, 0.03, 1.0 - uv.y));
  float hp = pillow(0.025 - min(abs(uv.y - 0.333), abs(uv.y - 0.667)), 0.02);
  float dents = 0.25 * min(0.0, fbmU(uv, 4.0, 3, 0.5, 1.0));
  float edge = max(hoop, chime);
  float n = fbmU(uv, 10.0, 4, 0.5, 2.0) + 0.2 * fbmU(uv, 40.0, 2, 0.5, 3.0);
  float rust = smoothstep(0.6, 0.63, n + 0.45 * edge);
  float runs = smoothstep(0.2, 0.8, fbm(uv * vec2(30.0, 2.0), vec2(30.0, 2.0), 3, 0.5, 4.0)) * smoothstep(0.35, 0.95, uv.y);
  vec3 paint = mix(${C('#8aa6b4')}, ${C('#a4bcc6')}, sat(fbmU(uv, 3.0, 3, 0.5, 5.0) + 0.5));
  float band = step(0.76, uv.y) * step(uv.y, 0.86);
  paint = mix(paint, ${C('#dcdcd4')}, band);
  paint = mix(paint, paint * vec3(0.78, 0.7, 0.62), runs * 0.35);
  vec3 rc = mix(${C('#7a4a30')}, ${C('#5a3626')}, sat(fbmU(uv, 30.0, 2, 0.5, 6.0) + 0.5));
  float bare = smoothstep(0.78, 0.8, fbmU(uv, 24.0, 3, 0.5, 7.0) + 0.3 * edge) * (1.0 - rust);
  vec3 c = mix(paint, rc, rust);
  c = mix(c, ${C('#8e9090')}, bare);
  float dust = (1.0 - smoothstep(0.0, 0.25, uv.y)) * 0.4;
  c = mix(c, ${C('#c9b99a')}, dust * (1.0 - rust));
  o.h = 0.5 + 0.35 * hp + 0.25 * chime + dents;
  o.col = c;
  o.rough = mix(mix(0.5, 0.7, dust), 0.9, rust) - 0.15 * bare;
  o.metal = bare;
}
`,
};
