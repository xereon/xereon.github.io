// Fabrics & fibres: awnings, tarps, rope, sandbags.
import { C } from './util.js';

const WEAVE = /* glsl */`
// plain weave: over/under threads at F threads per tile (integer)
float weave(vec2 uv, float F, out float thr) {
  vec2 p = uv * F;
  vec2 f = fract(p), i = floor(p);
  float over = mod(i.x + i.y, 2.0);
  float wx = sin(f.x * PI), wy = sin(f.y * PI);
  thr = mix(wy, wx, over);
  return mix(wx * 0.6 + wy * 0.4, wy * 0.6 + wx * 0.4, over);
}
`;

// Striped canvas awning, sun-faded red / cream, stitched seams, water stains.
export const cloth_awning = {
  world: 64, normal: 0.8, ao: 0.7, aoRadius: 4, cavity: 0.3, antiTile: true, macro: [0.08, 0.03],
  surface: 'cloth', seed: 501,
  glsl: WEAVE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float thr; float w = weave(uv, 128.0, thr);
  float s = fract(uv.x * 8.0);
  float stripe = step(0.5, s);
  float seam = 1.0 - smoothstep(0.0, 0.02, min(abs(s - 0.5), min(s, 1.0 - s)));
  float stitch = seam * step(0.5, fract(uv.y * 64.0));
  float sag = 0.3 * fbmU(uv, 3.0, 3, 0.5, 1.0) + 0.1 * fbmU(uv, 10.0, 2, 0.5, 2.0);
  vec3 red = mix(${C('#9c4638')}, ${C('#ac5a4a')}, sat(fbmU(uv, 2.0, 3, 0.5, 3.0) * 0.5 + 0.5));
  vec3 cream = ${C('#dcd0b8')};
  vec3 c = mix(red, cream, stripe);
  c *= 0.93 + 0.08 * w + 0.03 * fbmU(uv, 40.0, 2, 0.5, 4.0);
  float st = stainField(uv, 3.0, 5.0);
  c *= mix(vec3(1.0), vec3(0.86, 0.84, 0.8), st * 0.35);
  float sk = streaks(uv, 20.0, 2.0, 6.0);
  c *= mix(vec3(1.0), vec3(0.88, 0.86, 0.83), sk * 0.4);
  c *= 1.0 - 0.25 * stitch;
  o.h = sag + 0.02 * w - 0.03 * seam;
  o.col = c;
  o.rough = 0.9 - 0.05 * thr;
}
`,
};

// Canvas tarp (teal, as on the A-site crates): folds, creases, dust. Tint for variants.
export const cloth_tarp = {
  world: 96, normal: 1.0, ao: 0.9, aoRadius: 6, cavity: 0.35, antiTile: true, macro: [0.08, 0.03],
  surface: 'cloth', seed: 511,
  glsl: WEAVE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float thr; float w = weave(uv, 160.0, thr);
  // folds: ridged noise along three periodic directions
  float f1 = ridged(vec2(uv.x * 3.0 + uv.y * 1.0, uv.y * 2.0) * 1.0, vec2(3.0, 2.0), 3, 1.0);
  float f2 = ridged(vec2(uv.x * 2.0 - uv.y * 2.0, uv.x + uv.y) * 2.0, vec2(4.0, 2.0), 3, 2.0);
  float crease = pow(ridged(uv * vec2(6.0, 5.0), vec2(6.0, 5.0), 2, 3.0), 6.0);
  float folds = 0.5 * f1 + 0.3 * f2 + 0.2 * crease;
  vec3 c = mix(${C('#64aaa2')}, ${C('#7cb8ae')}, sat(fbmU(uv, 2.0, 3, 0.5, 4.0) * 0.5 + 0.5));
  c *= 0.97 + 0.03 * w;
  float dust = smoothstep(0.35, 0.8, fbmU(uv, 4.0, 3, 0.5, 5.0) + 0.4 * (0.6 - folds));
  c = mix(c, ${C('#c9bd9f')}, dust * 0.3);
  float st = stainField(uv, 3.0, 6.0);
  c *= mix(vec3(1.0), vec3(0.86, 0.86, 0.82), st * 0.3);
  o.h = 4.0 * folds + 0.015 * w;
  o.col = c;
  o.rough = 0.88 + 0.06 * dust - 0.04 * thr;
}
`,
};

// Three-strand laid rope; u runs along the rope.
export const rope = {
  world: 16, size: 256, normal: 1.3, ao: 1.0, aoRadius: 4, cavity: 0.5, antiTile: false,
  surface: 'cloth', seed: 521,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float t = fract(uv.x * 6.0 + uv.y * 3.0);
  float strand = sin(t * PI);
  float fib = fbm(vec2(uv.x * 6.0 + uv.y * 3.0, uv.y * 3.0 - uv.x * 6.0) * vec2(8.0, 30.0), vec2(8.0, 30.0) * vec2(9.0, 9.0), 3, 0.6, 1.0);
  o.h = 0.6 * sqrt(strand) + 0.04 * fib;
  vec3 c = mix(${C('#b6a078')}, ${C('#98825e')}, sat(fbmU(uv, 4.0, 3, 0.5, 2.0) + 0.5));
  c *= 0.85 + 0.2 * strand + 0.06 * fib;
  o.col = c;
  o.rough = 0.92;
}
`,
};

// Stacked burlap sandbags in running bond (4 rows x 2 bags per tile).
export const sandbag = {
  world: 64, normal: 1.2, ao: 1.0, aoRadius: 8, cavity: 0.55, antiTile: false, macro: [0.08, 0.03],
  surface: 'cloth', seed: 531,
  glsl: WEAVE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 wu = uv + 0.01 * vec2(fbmU(uv, 4.0, 3, 0.5, 1.0), fbmU(uv, 4.0, 3, 0.5, 2.0));
  Cell b = bricks(wu, 4.0, 2.0, 0.5, 3.0);
  vec3 hr = hash3(b.id, 4.0);
  float e = roundEdge(b, 0.1);
  float bag = pillow(e - 0.004, 0.09);
  float tie = (1.0 - smoothstep(0.0, 0.08, min(b.local.x, 1.0 - b.local.x))) * bag;
  float thr; float w = weave(uv, 96.0, thr);
  float wr = fbm(uv * vec2(20.0, 30.0), vec2(20.0, 30.0), 3, 0.5, 5.0);
  o.h = 3.0 * bag + 0.15 * wr * bag + 0.03 * w - 0.4 * tie * (0.5 + 0.5 * sin(b.local.y * 40.0));
  vec3 c = mix(${C('#b8a27e')}, ${C('#9c8664')}, hr.x);
  c = mix(c, ${C('#c9b690')}, smoothstep(0.7, 1.0, hr.y) * 0.6);
  c *= 0.9 + 0.1 * w + 0.05 * wr;
  float dirt = smoothstep(0.1, 0.7, fbmU(uv, 5.0, 3, 0.5, 6.0));
  c = mix(c, ${C('#8a7454')}, dirt * 0.3);
  o.col = c;
  o.rough = 0.95;
}
`,
};
