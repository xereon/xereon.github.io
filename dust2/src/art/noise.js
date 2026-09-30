// GLSL (ES 3.0) procedural library for the texture baker. Everything here is *periodic*:
// every function takes a lattice period so a [0,1) uv domain tiles seamlessly. Hashes are
// integer PCG so results are identical on every GPU (no sin-hash precision drift).
//
// Conventions: p = uv * F where F is an integer frequency, per = vec2(F) (or per-axis).
// gnoise / fbm / warpFbm are normalised to mean 0, sd ~0.33 (measured): percentiles
// p80 0.28, p90 0.42, p95 0.54, p98 0.68, extremes ~±1.1. vnoise is uniform-ish [0,1].
// Threshold masks against those numbers (e.g. > 0.54 covers ~5% of the tile).

export const NOISE_GLSL = /* glsl */`
#define PI 3.14159265
#define TAU 6.28318531
#define sat(x) clamp(x, 0.0, 1.0)
uniform float uSeed;

// Lattice randoms come from a 1024² RGBA32F table of uniform values (uRand) instead of
// arithmetic hashing: a texelFetch is ~10x cheaper than an integer hash on software
// rasterisers and just as fast on GPUs. Seeds pick a different offset into the table.
// Lattice indices are already wrapped to their period, so periodicity is unaffected.
uniform highp sampler2D uRand;
vec4 rnd4(vec2 i, float s) {
  int si = int(s) + int(uSeed) * 131;
  ivec2 o = ivec2(si * 389 + (si >> 3) * 17, si * 631 + (si >> 5) * 13);
  return texelFetch(uRand, (ivec2(floor(i)) + o) & 1023, 0);
}
float hash1(vec2 i, float s) { return rnd4(i, s).x; }
vec2 hash2(vec2 i, float s) { return rnd4(i, s).xy; }
vec3 hash3(vec2 i, float s) { return rnd4(i, s).xyz; }
float hashf(float i, float s) { return rnd4(vec2(i, 17.0), s).x; }

vec2 fade2(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

// periodic value noise, [0,1]
float vnoise(vec2 p, vec2 per, float s) {
  vec2 i = floor(p), f = fract(p), u = fade2(f);
  vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
  float a = hash1(i0, s), b = hash1(vec2(i1.x, i0.y), s);
  float c = hash1(vec2(i0.x, i1.y), s), d = hash1(i1, s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// trig-free gradient: random vector in [-1,1]^2 (cheap on software rasterisers)
vec2 grad2(vec2 i, float s) { return hash2(i, s) * 2.0 - 1.0; }
// periodic gradient noise, ~[-1,1]
float gnoise(vec2 p, vec2 per, float s) {
  vec2 i = floor(p), f = fract(p), u = fade2(f);
  vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
  float a = dot(grad2(i0, s), f);
  float b = dot(grad2(vec2(i1.x, i0.y), s), f - vec2(1.0, 0.0));
  float c = dot(grad2(vec2(i0.x, i1.y), s), f - vec2(0.0, 1.0));
  float d = dot(grad2(i1, s), f - 1.0);
  return 1.9 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// periodic fBm (lacunarity 2, per-octave offsets to hide lattice alignment). ~[-1,1]
float fbm(vec2 p, vec2 per, int oct, float gain, float s) {
  float a = 1.0, t = 0.0, n = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= oct) break;
    t += a * gnoise(p + vec2(0.31, 0.67) * float(k), per, s + float(k) * 31.0);
    n += a; a *= gain; p *= 2.0; per *= 2.0;
  }
  return 1.55 * t / n;
}
// convenience: uv-domain fbm at integer frequency F
float fbmU(vec2 uv, float F, int oct, float gain, float s) { return fbm(uv * F, vec2(F), oct, gain, s); }
float fbmU2(vec2 uv, vec2 F, int oct, float gain, float s) { return fbm(uv * F, F, oct, gain, s); }
float gnU(vec2 uv, float F, float s) { return gnoise(uv * F, vec2(F), s); }
float vnU(vec2 uv, float F, float s) { return vnoise(uv * F, vec2(F), s); }

// ridged multifractal-ish: sharp creases (cracks, veins)
float ridged(vec2 p, vec2 per, int oct, float s) {
  float a = 0.5, t = 0.0, n = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= oct) break;
    float r = 1.0 - abs(0.6 * gnoise(p + vec2(0.17, 0.53) * float(k), per, s + float(k) * 7.0));
    t += a * r * r; n += a; a *= 0.5; p *= 2.0; per *= 2.0;
  }
  return t / n;
}

// periodic domain-warped fbm (IQ style), uv domain
float warpFbm(vec2 uv, float F, float warp, int oct, float s) {
  vec2 q = vec2(fbmU(uv, F, 4, 0.5, s + 1.0), fbmU(uv + 0.37, F, 4, 0.5, s + 2.0));
  // warp amount is in uv units; the warped lookup is still periodic because q is
  return 1.08 * fbmU(uv + warp * 0.4 * q, F, oct, 0.5, s + 3.0);
}

// Periodic Worley / Voronoi. Returns (F1, F2, cell hash, border distance) in cell units.
// center receives the nearest feature point (in p space, unwrapped).
vec4 worleyC(vec2 p, vec2 per, float jitter, float s, out vec2 center) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0, id = 0.0; vec2 mr = vec2(0.0), mg = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec3 h = hash3(mod(i + g, per), s);
    vec2 r = g + 0.5 + (h.xy - 0.5) * jitter - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; mr = r; mg = g; id = h.z; }
    else if (d < d2) d2 = d;
  }
  float md = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = mg + vec2(float(x), float(y));
    vec3 h = hash3(mod(i + g, per), s);
    vec2 r = g + 0.5 + (h.xy - 0.5) * jitter - f;
    vec2 dr = r - mr;
    if (dot(dr, dr) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(dr)));
  }
  center = p + mr;
  return vec4(sqrt(d1), sqrt(d2), id, md);
}
vec4 worley(vec2 p, vec2 per, float jitter, float s) { vec2 c; return worleyC(p, per, jitter, s, c); }

// Cheap F1-only worley (pits, pebbles)
vec2 worleyF1(vec2 p, vec2 per, float jitter, float s) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec3 h = hash3(mod(i + g, per), s);
    vec2 r = g + 0.5 + (h.xy - 0.5) * jitter - f;
    float d = dot(r, r);
    if (d < d1) { d1 = d; id = h.z; }
  }
  return vec2(sqrt(d1), id);
}

// Scattered sparse features: returns (dist to feature, feature hash, local vec) for the
// closest of one random point per cell, present with probability 'density'.
vec4 sparse(vec2 p, vec2 per, float density, float s) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0; float id = -1.0; vec2 lv = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec3 h = hash3(mod(i + g, per), s);
    if (h.z > density) continue;
    vec2 r = g + h.xy - f;
    float d = dot(r, r);
    if (d < d1) { d1 = d; id = h.z / density; lv = r; }
  }
  return vec4(sqrt(d1), id, lv);
}

// ---- layouts ---------------------------------------------------------------------------

// Running-bond bricks. uv in [0,1), rows x cols per tile (integers). Returns
// local coords within the brick (0..1), brick size in uv, id hash, and distance (in uv) to
// the brick's rectangle edge. 'stagger' 0.5 = half-bond.
struct Cell { vec2 local; vec2 size; vec2 id; float rnd; float edge; };
Cell bricks(vec2 uv, float rows, float cols, float stagger, float s) {
  Cell c;
  float r = floor(uv.y * rows);
  float off = mod(r, 2.0) * stagger;
  float x = uv.x * cols + off;
  float ci = floor(x);
  c.local = vec2(fract(x), fract(uv.y * rows));
  c.size = vec2(1.0 / cols, 1.0 / rows);
  c.id = vec2(mod(ci, cols), r);
  c.rnd = hash1(c.id, s);
  vec2 e = min(c.local, 1.0 - c.local) * c.size;
  c.edge = min(e.x, e.y);
  return c;
}

// Irregular ashlar coursing: 'rows' courses with jittered heights; each course picks its
// own block count from [cmin,cmax] with jittered joints. Periodic in both axes.
Cell ashlar(vec2 uv, float rows, float cmin, float cmax, float jit, float s) {
  Cell c;
  float y = uv.y * rows;
  float r0 = floor(y);
  // row boundaries b(k) = k + jitter(k), jitter periodic in k (mod rows)
  float r = r0, lo = 0.0, hi = 1.0;
  for (int k = -1; k <= 1; k++) {
    float rk = r0 + float(k);
    float b0 = rk + (hashf(mod(rk, rows), s) - 0.5) * jit;
    float b1 = rk + 1.0 + (hashf(mod(rk + 1.0, rows), s) - 0.5) * jit;
    if (y >= b0 && y < b1) { r = rk; lo = b0; hi = b1; }
  }
  float rw = mod(r, rows);
  float n = floor(mix(cmin, cmax + 0.999, hashf(rw, s + 11.0)));
  float xo = hashf(rw, s + 23.0);            // row phase
  float x = fract(uv.x + xo) * n;
  float c0 = floor(x), cl = 0.0, ch = 1.0, ci = c0;
  for (int k = -1; k <= 1; k++) {
    float ck = c0 + float(k);
    float b0 = ck + (hash1(vec2(mod(ck, n), rw), s + 5.0) - 0.5) * jit * 0.9;
    float b1 = ck + 1.0 + (hash1(vec2(mod(ck + 1.0, n), rw), s + 5.0) - 0.5) * jit * 0.9;
    if (x >= b0 && x < b1) { ci = ck; cl = b0; ch = b1; }
  }
  c.size = vec2((ch - cl) / n, (hi - lo) / rows);
  c.local = vec2((x - cl) / (ch - cl), (y - lo) / (hi - lo));
  c.id = vec2(mod(ci, n), rw);
  c.rnd = hash1(c.id, s + 3.0);
  vec2 e = min(c.local, 1.0 - c.local) * c.size;
  c.edge = min(e.x, e.y);
  return c;
}

// Smooth rounded-rectangle edge distance: rounds block corners with radius rad (uv units)
float roundEdge(Cell c, float rad) {
  vec2 d = (min(c.local, 1.0 - c.local)) * c.size;   // distances to nearest vertical/horizontal edge
  vec2 q = max(rad - d, 0.0);
  return min(min(d.x, d.y), rad - length(q)) ;
}

// ---- colour helpers --------------------------------------------------------------------
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }                // author colours in sRGB-ish
vec3 hex(float h) {                                             // 0xRRGGBB -> linear
  float r = floor(h / 65536.0), g = floor(mod(h / 256.0, 256.0)), b = mod(h, 256.0);
  return srgb(vec3(r, g, b) / 255.0);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 saturation(vec3 c, float s) { return mix(vec3(luma(c)), c, s); }
float smin(float a, float b, float k) { float h = sat(0.5 + 0.5 * (b - a) / k); return mix(b, a, h) - k * h * (1.0 - h); }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float remap(float x, float a, float b) { return sat((x - a) / (b - a)); }
`;
