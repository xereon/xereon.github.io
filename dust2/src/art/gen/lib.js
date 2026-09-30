// Shared GLSL building blocks used by several materials (appended after NOISE_GLSL).
import { C } from './util.js';

export const LIB = /* glsl */`
// Hairline crack network on a warped Voronoi graph. density 0..1 = fraction of edges that
// crack; width in texels. Returns 0..1 (1 = crack centre).
float crackNet(vec2 uv, float F, float density, float widthPx, float s) {
  vec2 w = uv + (0.11 / F) * vec2(fbmU(uv, F * 2.0, 2, 0.55, s), fbmU(uv + 0.5, F * 2.0, 2, 0.55, s + 1.0));
  vec4 v = worley(w * F, vec2(F), 0.95, s + 2.0);
  float keep = smoothstep(1.0 - density - 0.08, 1.0 - density + 0.08, vnU(uv, F * 2.0, s + 3.0));
  float wid = widthPx * uPx.x * F * (0.6 + 0.8 * vnU(uv, F * 6.0, s + 4.0));
  return (1.0 - smoothstep(wid * 0.5, wid * 1.6, v.w)) * keep;
}

// Soft large-scale staining 0..1 (water marks, grime blooms)
float stainField(vec2 uv, float F, float s) {
  float n = warpFbm(uv, F, 0.35, 4, s);
  return smoothstep(-0.1, 0.75, n);
}

// Vertical run-off streaks 0..1
float streaks(vec2 uv, float Fx, float Fy, float s) {
  float n = fbm(uv * vec2(Fx, Fy), vec2(Fx, Fy), 3, 0.5, s);
  float m = vnU(uv, 3.0, s + 5.0);
  return smoothstep(0.1, 0.75, n) * smoothstep(0.35, 0.8, m);
}

// Jagged flaking field (threshold it: > t = material lost). Crisp, clustered, multi-scale.
float flakeField(vec2 uv, float F, float s) {
  float base = warpFbm(uv, F, 0.22, 4, s);
  return base + 0.24 * fbmU(uv, F * 6.0, 3, 0.5, s + 5.0) + 0.07 * gnU(uv, F * 24.0, s + 6.0);
}

// Tan fired brick (exposed under render). uv-periodic.
void brickUnder(vec2 uv, float rows, float cols, out float h, out vec3 col, out float rough) {
  Cell b = bricks(uv, rows, cols, 0.5, 71.0);
  float mortarW = 0.16 * b.size.y;
  float e = b.edge + 0.12 * mortarW * gnU(uv, 64.0, 72.0);
  float face = smoothstep(mortarW * 0.5, mortarW * 1.4, e);
  vec3 bc = mix(${C('#9a6a4a')}, ${C('#a97a54')}, b.rnd);
  bc = mix(bc, ${C('#80533a')}, smoothstep(0.7, 1.0, hash1(b.id, 73.0)) * 0.7);
  bc *= 0.88 + 0.22 * vnU(uv, 96.0, 74.0);
  vec3 mc = ${C('#a8987e')} * (0.9 + 0.2 * vnU(uv, 128.0, 75.0));
  col = mix(mc, bc, face);
  h = face * (0.3 + 0.03 * gnU(uv, 48.0, 76.0)) - 0.2;
  rough = mix(0.97, 0.9, face);
}

// Coarse tan render / scratch coat (what lies under the lime finish)
void renderCoat(vec2 uv, out float h, out vec3 col, out float rough) {
  float g = fbmU(uv, 64.0, 3, 0.6, 81.0);
  float m = fbmU(uv, 10.0, 3, 0.5, 82.0);
  h = 0.35 + 0.04 * g + 0.025 * m;
  col = mix(${C('#b09172')}, ${C('#9a785a')}, sat(m * 0.6 + 0.5));
  col = mix(col, ${C('#c0a585')}, sat(g) * 0.4);
  col *= 0.92 + 0.12 * vnU(uv, 180.0, 83.0);
  rough = 0.96;
}

// Smooth plaster fields for the quarter-res pass:
//   a: x flake base (warped), y hue drift, z grime stains, w run-off streaks
//   b: x smooth relief (world units), y colour mottle, z paint fade, w paint-failure density
void plasterLow(vec2 uv, float s, out vec4 a, out vec4 b) {
  float fl = 0.75 * warpFbm(uv, 4.0, 0.22, 4, s + 10.0) + 0.45 * fbmU(uv, 2.0, 3, 0.5, s + 11.0);
  a = vec4(fl, fbmU(uv, 2.0, 3, 0.5, s + 20.0), stainField(uv, 3.0, s + 22.0), streaks(uv, 30.0, 2.0, s + 23.0));
  float relief = 0.12 * fbmU(uv, 3.0, 3, 0.5, s + 1.0) + 0.035 * fbmU(uv, 12.0, 3, 0.5, s + 2.0);
  b = vec4(relief, fbmU(uv, 20.0, 3, 0.5, s + 21.0), fbmU(uv, 3.0, 3, 0.5, 60.0), warpFbm(uv, 3.0, 0.25, 3, 66.0));
}

// Lime plaster / whitewash system over render over brick. L/L2 = plasterLow() samples.
// pc0/pc1: plaster colour range. loss: flake threshold (lower = more loss).
// Returns plaster coverage (1 = intact plaster) so paint layers can sit on top.
float limePlaster(vec2 uv, vec4 L, vec4 L2, vec3 pc0, vec3 pc1, float loss, float stain, float s, inout Surf o) {
  float grain = fbmU(uv, 90.0, 2, 0.6, s + 3.0);
  float peel = gnU(uv, 200.0, s + 4.0);
  float tro = fbm(uv * vec2(6.0, 48.0), vec2(6.0, 48.0), 2, 0.5, s + 5.0);
  float hP = 0.85 + L2.x + 0.02 * grain + 0.006 * peel + 0.01 * tro;

  // big clustered flakes + a scatter of small chips near them
  float det = fbmU(uv, 24.0, 3, 0.5, s + 15.0);
  float n = L.x + 0.18 * det + 0.03 * gnU(uv, 96.0, s + 16.0);
  float n2 = fbmU(uv, 14.0, 3, 0.5, s + 14.0) + 0.05 * gnU(uv, 110.0, s + 17.0) + 0.5 * L.x;
  float lostP = max(smoothstep(loss, loss + 0.01, n), smoothstep(loss + 0.42, loss + 0.43, n2));
  float lostR = smoothstep(loss + 0.22, loss + 0.23, n + 0.2 * L2.x);
  float halo = smoothstep(loss - 0.12, loss, n) * (1.0 - lostP);

  // under-layers only where something is missing (branch is coherent: big patches)
  float hR = 0.35, rR = 0.96, hB = 0.0, rB = 0.9; vec3 cR = vec3(0.4), cB = vec3(0.3);
  if (lostP > 0.0) {
    renderCoat(uv, hR, cR, rR);
    if (lostR > 0.0) brickUnder(uv, 60.0, 20.0, hB, cB, rB);
  }

  vec3 pc = mix(pc0, pc1, sat(L.y * 0.8 + 0.5));
  pc *= 0.975 + 0.028 * L2.y + 0.015 * grain;
  pc *= mix(vec3(1.0), vec3(0.83, 0.81, 0.77), L.z * stain);
  pc *= mix(vec3(1.0), vec3(0.87, 0.86, 0.83), L.w * stain * 0.8);
  pc *= mix(vec3(1.0), vec3(0.9, 0.87, 0.82), halo * 0.8);

  o.h = mix(hP, mix(hR, hB, lostR), lostP);
  o.col = mix(pc, mix(cR, cB, lostR), lostP);
  o.rough = mix(0.88 - 0.04 * sat(tro) + 0.03 * L.z, mix(rR, rB, lostR), lostP);
  return 1.0 - lostP;
}

// Pillow-shaped stone from a Voronoi cell: edge = border distance (cell units),
// r = rounding radius (cell units). 0 at joint, 1 on the crown.
float pillow(float edge, float r) { float t = sat(edge / r); return sqrt(t * (2.0 - t)); }

// Rounded field stones packed on a jittered grid (cells F): each cell holds one oriented
// ellipse with its own size/aspect and a noisy outline. Returns (height 0..1, stone id,
// coverage 0..1 = inside a stone). size ~0.5-0.65 of a cell keeps mortar gaps.
vec3 fieldStones(vec2 uv, vec2 F, float size, float aspect, float rough, float s) {
  vec2 p = uv * F, i = floor(p);
  float best = -9.0, id = 0.0, cov = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = i + vec2(float(x), float(y));
    vec3 h = hash3(mod(g, F), s);
    vec3 h2 = hash3(mod(g, F), s + 1.0);
    vec2 c = g + 0.5 + (h.xy - 0.5) * 0.45;
    vec2 d = p - c;
    float a = (h2.x - 0.5) * 0.9;
    d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
    float r = size * (0.8 + 0.4 * h.z);
    float asp = 1.0 + (aspect - 1.0) * h2.y;
    float dist = length(d / vec2(r * asp, r / sqrt(asp)));
    float ang = atan(d.y, d.x);
    dist *= 1.0 + rough * (0.12 * sin(ang * 3.0 + h2.z * 6.28) + 0.07 * sin(ang * 5.0 + h.x * 6.28));
    float t = 1.0 - dist;
    float ht = t > 0.0 ? pillow(t, 0.55) * (0.75 + 0.35 * h2.z) : t * 2.0;
    if (ht > best) { best = ht; id = h.z; cov = step(0.0, t); }
  }
  return vec3(max(best, 0.0), id, cov);
}
`;

export const LIB_GROUND = /* glsl */`
// Squarish setts on a lightly jittered Voronoi grid. Returns (crown height 0..1, id,
// joint mask 0..1 (1 = in joint), local tilt term).
vec4 setts(vec2 uv, float F, float jit, float jointW, float round_, float s) {
  vec2 cen; vec4 w = worleyC(uv * F, vec2(F), jit, s, cen);
  vec3 hr = hash3(vec2(w.z * 1013.0, 7.0), s + 1.0);
  float e = w.w - jointW * (0.8 + 0.4 * hr.x);
  float crown = pillow(e, round_);
  float joint = 1.0 - smoothstep(0.0, 0.03, e);
  float tilt = dot(uv * F - cen, hr.yz - 0.5);
  return vec4(crown, w.z, joint, tilt);
}

// Compacted dusty sand: returns height, writes colour/roughness. tone: 0 = pale A-site
// dust, 1 = warm B-site sand. L = (drift, patches, hue, scuffs) from sandLow().
vec4 sandLow(vec2 uv, float s) {
  return vec4(fbmU(uv, 3.0, 4, 0.5, s + 1.0), warpFbm(uv, 4.0, 0.3, 4, s + 2.0),
              fbmU(uv, 2.0, 3, 0.5, s + 3.0), fbmU(uv, 8.0, 3, 0.5, s + 4.0));
}
float sandSurf(vec2 uv, vec4 L, float tone, float s, inout Surf o) {
  float mid = fbmU(uv, 18.0, 3, 0.5, s + 5.0);
  float fine = fbmU(uv, 90.0, 2, 0.55, s + 6.0);
  float grit = gnU(uv, 300.0, s + 7.0);
  // shallow scuffs / footprint-scale dents: sparse oriented ellipses
  vec4 sp = sparse(uv * 22.0, vec2(22.0), 0.45, s + 8.0);
  vec2 d = sp.zw; float a = sp.y * 3.14;
  d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
  float dent = (1.0 - smoothstep(0.1, 0.32, length(d * vec2(1.0, 2.2)))) * step(0.0, sp.y);
  // pebbles
  vec4 pb = sparse(uv * 70.0, vec2(70.0), 0.22, s + 9.0);
  float pr = 0.12 + 0.12 * fract(pb.y * 13.0);
  float peb = pillow(pr - pb.x, 0.12) * step(0.0, pb.y);
  float h = 0.2 * L.x + 0.05 * mid + 0.012 * fine + 0.004 * grit - 0.12 * dent + 0.25 * peb;
  vec3 c0 = mix(${C('#d4c6aa')}, ${C('#d6ba90')}, tone);
  vec3 c1 = mix(${C('#c2b192')}, ${C('#c6a57a')}, tone);
  vec3 c2 = mix(${C('#ddd1b8')}, ${C('#dfc7a0')}, tone);
  vec3 c = mix(c0, c1, smoothstep(0.0, 0.6, L.y) * 0.8);   // compacted darker patches
  c = mix(c, c2, smoothstep(0.1, 0.6, L.x) * 0.6);          // loose pale drift on highs
  c *= 0.97 + 0.04 * L.z + 0.02 * mid + 0.025 * fine;
  c *= 1.0 - 0.06 * smoothstep(0.3, 0.8, grit);              // dark grit specks
  c *= 1.0 - 0.05 * dent;
  vec3 pc = mix(${C('#8f8272')}, ${C('#b3a58e')}, fract(pb.y * 7.0));
  o.col = mix(c, pc, smoothstep(0.0, 0.25, peb));
  o.rough = 0.95 - 0.05 * smoothstep(0.0, 0.6, L.y) - 0.12 * peb;
  o.h = h;
  return h;
}
`;

export const LIB_WOOD = /* glsl */`
// Weathered wood grain in uv space. Grain runs along +u when vertical == false, along +v
// when true. F = (along, across) integer frequencies of the ring pattern; id shifts the
// pattern per board. Outputs: ring lines 0..1 (latewood), fibre noise, checks (cracks).
float woodGrain(vec2 uv, vec2 F, float id, float s, bool vertical, out float rings, out float fib, out float check) {
  vec2 q = vertical ? uv.yx : uv;
  vec2 Fq = vertical ? F : F;
  q.x += id * 0.371;
  q.y += id * 0.113;
  float bend = fbm(q * vec2(Fq.x, max(1.0, floor(Fq.y * 0.25))), vec2(Fq.x, max(1.0, floor(Fq.y * 0.25))), 3, 0.5, s);
  float y = q.y * Fq.y + 0.45 * bend + 0.12 * gnoise(q * vec2(Fq.x * 4.0, Fq.y), vec2(Fq.x * 4.0, Fq.y), s + 1.0);
  float r = abs(fract(y) - 0.5) * 2.0;
  rings = smoothstep(0.55, 0.95, r);
  fib = fbm(q * vec2(Fq.x * 3.0, Fq.y * 6.0), vec2(Fq.x * 3.0, Fq.y * 6.0), 3, 0.6, s + 2.0);
  float cn = fbm(q * vec2(Fq.x * 0.5, Fq.y * 3.0), vec2(max(1.0, Fq.x * 0.5), Fq.y * 3.0), 3, 0.5, s + 3.0);
  float cm = smoothstep(0.1, 0.5, fbm(q * vec2(Fq.x * 2.0, Fq.y), vec2(Fq.x * 2.0, Fq.y), 2, 0.5, s + 4.0));
  check = (1.0 - smoothstep(0.0, 0.035, abs(cn))) * cm;
  return 0.12 * rings + 0.04 * fib - 0.25 * check;
}

// Weathered timber colour: grey silvered wood <-> warm tan, darker latewood, dark checks.
vec3 woodColour(float tone, float silver, float rings, float fib, float check) {
  vec3 warm = mix(${C('#b89a74')}, ${C('#a07f5c')}, tone);
  vec3 grey = mix(${C('#b2aa9a')}, ${C('#958c7e')}, tone);
  vec3 c = mix(warm, grey, silver);
  c *= 1.0 - 0.14 * rings + 0.05 * fib;
  c = mix(c, c * 0.45, check);
  return c;
}
`;
