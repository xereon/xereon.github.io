// Procedural FX atlases, rendered once on the GPU at init.
//
// Particle atlas (square, 8x8 cells of equal size):
//   rows 0-3, cols 0-3 : smoke flipbook, 16 frames (dense puff -> eroded wisps)
//   rows 0-3, cols 4-7 : fire flipbook, 16 frames (a flame lick's life)
//   rows 4-7           : 32 misc sprites (see SPR)
// Channels: R = alpha/density, G/B = sprite-space normal xy (0.5 = flat), A = value
// (smoke: cavity/AO, fire: temperature, misc: brightness).
//
// Decal atlas (4x4 cells): albedo(+alpha), tangent-space normal, ORM (AO, rough, metal).
import * as THREE from 'three';
import { NOISE_GLSL } from './shaders/noise.js';

export const SPR = {
  SMOKE0: 0, FIRE0: 16,
  GLOW: 32, SPARK: 33, STAR0: 34, PRONG0: 38, CHIP0: 40, SPLINTER: 44, SHARD0: 45,
  DROP: 47, MIST0: 48, RING: 50, STREAK: 51, GRAINS: 52, FLARE: 53, EMBER: 54, WISP: 55,
  PUFF: 56, SHOTGUN: 57, CHIPS: 58, CONE: 59, SUPP: 60,
};

export const DECAL = {
  concrete: [0, 1, 15], plaster: [2, 3], wood: [4, 5], metal: [6, 7], glass: [8], sand: [9],
  blood: [10, 11], blood_drip: [12], scorch: [13], burn: [14],
};

const FS_TRI = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ---------------------------------------------------------------------------------------
// Particle atlas, raw pass: R alpha, G height, B value.
const PARTICLE_RAW = /* glsl */`
precision highp float;
uniform float uSize;
${NOISE_GLSL}
const float PI = 3.14159265;

float hsh(float n) { return fract(sin(n * 91.3458) * 47453.5453); }

// Smooth-topped billows: 1 - F1^2 (parabolic bumps, soft creases).
float sbillow(vec3 p) { return 1.0 - clamp(sworley(p, 7.0) * 1.3, 0.0, 1.0); }

vec4 genSmoke(vec2 p, float t, float fi) {
  float r = length(p);
  float z = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
  vec3 q = vec3(p * 1.0, z * 0.5 + t * 0.75 + fi * 0.011);
  vec3 w = vec3(fbm(q * 1.1 + 3.1, 2), fbm(q * 1.1 + 7.4, 2), fbm(q * 1.1 + 5.2, 2));
  q += w * (0.15 + 0.45 * t);
  float b1 = sbillow(q * 1.45);
  float b2 = sbillow(q * 2.9 + 3.0);
  float n = fbm(q * 5.0 + 11.0, 3);
  float lumps = clamp(b1 * 0.65 + b2 * 0.35, 0.0, 1.0);
  float R = mix(0.8, 0.93, t) * (0.78 + 0.3 * lumps + 0.06 * n);
  float d = 1.0 - smoothstep(R * 0.4, R, r);
  d *= 0.7 + 0.38 * lumps + 0.14 * n;
  float er = t * t;
  d = d - er * (1.05 - lumps * 1.1 - n * 0.4) * 0.75;
  d = smoothstep(0.02, 0.72, d);
  d *= 1.0 - smoothstep(0.9, 0.99, r);
  float h = z * 0.8 + lumps * 0.11 + b2 * 0.03 + n * 0.01;
  return vec4(d, h, clamp(0.2 + lumps * 0.95, 0.0, 1.0), 1.0);
}

// A flame lick's life: a tall tongue grows from the base, flickers, detaches and shrinks.
vec4 genFire(vec2 p, float t, float fi) {
  float yb = mix(-0.94, -0.45, smoothstep(0.5, 1.0, t));
  float len = mix(1.0, 1.7, smoothstep(0.0, 0.4, t)) * mix(1.0, 0.5, smoothstep(0.55, 1.0, t));
  float yy = (p.y - yb) / len;
  float n = fbm(vec3(p.x * 2.4, p.y * 1.6 - t * 3.0, fi * 0.13), 4);
  float n2 = fbm(vec3(p.x * 6.0, p.y * 3.5 - t * 5.0, fi * 0.29 + 7.0), 3);
  float w = 0.36 * pow(max(0.0, 1.0 - yy), 0.7) * (0.85 + 0.35 * n) + 0.015;
  float x = p.x + n * 0.26 * yy + n2 * 0.05 * yy;
  float d = abs(x) / w;
  float tip = 1.0 - smoothstep(0.8, 1.05, yy + n2 * 0.18);
  float body = (1.0 - smoothstep(0.3, 1.0, d)) * smoothstep(-0.1, 0.05, yy) * tip;
  float T = body * (1.0 - 0.72 * clamp(yy, 0.0, 1.0)) * (0.78 + 0.4 * n) * (1.0 - 0.3 * t);
  T += (1.0 - smoothstep(0.0, 0.55, d)) * (1.0 - smoothstep(0.0, 0.4, yy)) * smoothstep(-0.1, 0.02, yy) * 0.28;
  T *= 1.0 - smoothstep(0.85, 0.99, max(abs(p.x), abs(p.y)));
  T = clamp(T, 0.0, 1.0);
  float a = smoothstep(0.02, 0.18, T);
  return vec4(a, T, T, 1.0);
}

// Tapered prong from origin along dir, returns intensity.
float prong(vec2 p, vec2 dir, float len, float wid) {
  float along = dot(p, dir);
  float perp = abs(p.x * dir.y - p.y * dir.x);
  if (along < 0.0) return 0.0;
  float tp = 1.0 - along / len;
  if (tp <= 0.0) return 0.0;
  float w = wid * (0.15 + 0.85 * tp);
  return exp(-perp * perp / (w * w)) * pow(tp, 0.8);
}

// Leaf-shaped flame petal from the origin along dir.
float petal(vec2 p, vec2 dir, float len, float wid) {
  float along = dot(p, dir);
  float perp = abs(p.x * dir.y - p.y * dir.x);
  if (along <= 0.0 || along >= len) return 0.0;
  float u = along / len;
  float w = wid * pow(sin(PI * pow(u, 0.6)), 0.8) + 0.004;
  return exp(-perp * perp / (w * w)) * pow(1.0 - u, 0.5);
}

vec4 genStar(vec2 p, float seed, int n, float rayLen, float wid) {
  float r = length(p);
  float s = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= n) break;
    float fi = float(i);
    float ang = (fi + 0.45 * (hsh(seed + fi) - 0.5)) / float(n) * 2.0 * PI + seed;
    float len = rayLen * mix(0.5, 1.0, hsh(seed * 3.1 + fi * 1.7));
    s += petal(p, vec2(cos(ang), sin(ang)), len, wid * mix(0.6, 1.4, hsh(seed + fi * 7.3)));
    // thin ray between petals
    float a2 = ang + PI / float(n) * mix(0.7, 1.3, hsh(seed * 9.0 + fi));
    s += 0.55 * prong(p, vec2(cos(a2), sin(a2)), rayLen * mix(0.35, 0.75, hsh(seed * 5.3 + fi)), wid * 0.22);
  }
  float nz = fbm(vec3(p * 6.0, seed), 4);
  s *= 0.6 + 0.8 * clamp(nz + 0.5, 0.0, 1.0);
  float core = exp(-r * r * 28.0) * 1.3 + exp(-r * r * 6.0) * 0.45;
  float v = clamp(s + core, 0.0, 1.6);
  float a = clamp(v * 1.1, 0.0, 1.0) * (1.0 - smoothstep(0.9, 1.0, r));
  return vec4(a, 0.0, clamp(v / 1.6, 0.0, 1.0), 1.0);
}

// Side view of a flame prong: base at bottom (y=-1), tip at top.
vec4 genProng(vec2 p, float seed, float fat) {
  float y01 = p.y * 0.5 + 0.5;
  float nz = fbm(vec3(p.x * 5.0, p.y * 1.6, seed), 4);
  float prof = sin(PI * pow(clamp(y01, 0.0, 1.0), 0.72));
  float w = fat * prof * (0.85 + 0.3 * nz);
  float d = abs(p.x + nz * 0.08 * y01) / max(w, 1e-3);
  float v = (1.0 - smoothstep(0.25, 1.0, d)) * (1.0 - smoothstep(0.8, 1.0, y01));
  v *= 0.7 + 0.55 * fbm(vec3(p.x * 9.0, p.y * 3.0, seed + 2.0), 3);
  float core = exp(-(p.x * p.x * 40.0 + y01 * y01 * 10.0)) * 1.2;
  v = clamp(v + core, 0.0, 1.4);
  return vec4(clamp(v, 0.0, 1.0), 0.0, v / 1.4, 1.0);
}

vec4 genChip(vec2 p, float seed, float elong) {
  p.x /= elong;
  float ang = atan(p.y, p.x);
  float r = length(p);
  // polar radius from 7 random verts
  float rr = 0.0;
  float a01 = (ang + PI) / (2.0 * PI) * 7.0;
  float i0 = floor(a01), f = fract(a01);
  float r0 = mix(0.45, 0.85, hsh(seed + mod(i0, 7.0)));
  float r1 = mix(0.45, 0.85, hsh(seed + mod(i0 + 1.0, 7.0)));
  rr = mix(r0, r1, f) * 0.95;
  float inside = rr - r;
  float a = smoothstep(0.0, 0.03, inside);
  float h = clamp(inside * 4.0, 0.0, 1.0) + fbm(vec3(p * 9.0, seed), 2) * 0.15;
  float v = 0.7 + 0.3 * fbm(vec3(p * 5.0, seed + 4.0), 2);
  return vec4(a, h, v, 1.0);
}

vec4 genShard(vec2 p, float seed) {
  vec2 a = vec2(-0.7, -0.6) + (vec2(hsh(seed), hsh(seed + 1.0)) - 0.5) * 0.3;
  vec2 b = vec2(0.75, -0.3) + (vec2(hsh(seed + 2.0), hsh(seed + 3.0)) - 0.5) * 0.3;
  vec2 c = vec2(-0.1, 0.8) + (vec2(hsh(seed + 4.0), hsh(seed + 5.0)) - 0.5) * 0.3;
  vec2 e0 = b - a, e1 = c - b, e2 = a - c;
  vec2 v0 = p - a, v1 = p - b, v2 = p - c;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  float sd = -sqrt(d.x) * sign(d.y);
  float al = smoothstep(0.0, 0.02, -sd);
  float edge = exp(-sd * sd * 900.0);
  return vec4(al, clamp(-sd * 3.0, 0.0, 1.0), 0.45 + 0.55 * edge, 1.0);
}

vec4 genMisc(int m, vec2 p) {
  float r = length(p);
  float fm = float(m);
  if (m == 0) { // glow
    float v = exp(-r * r * 5.0) * 0.75 + exp(-r * r * 30.0) * 0.5;
    v *= 1.0 - smoothstep(0.85, 1.0, r);
    return vec4(clamp(v, 0.0, 1.0), 0.0, clamp(v, 0.0, 1.0), 1.0);
  }
  if (m == 1) { // spark streak (along y), head at top
    float y01 = p.y * 0.5 + 0.5;
    float w = 0.05 + 0.08 * y01;
    float v = exp(-p.x * p.x / (w * w)) * smoothstep(0.0, 0.5, y01) * (1.0 - smoothstep(0.92, 1.0, y01));
    v += exp(-(p.x * p.x + (p.y - 0.75) * (p.y - 0.75)) * 60.0) * 0.8;
    return vec4(clamp(v, 0.0, 1.0), 0.0, clamp(v, 0.0, 1.0), 1.0);
  }
  if (m >= 2 && m <= 5) {
    int n = m == 2 ? 4 : m == 3 ? 5 : m == 4 ? 6 : 7;
    return genStar(p, fm * 1.37 + 0.3, n, 0.97, m == 5 ? 0.13 : 0.17);
  }
  if (m == 6 || m == 7) return genProng(p, fm, m == 6 ? 0.42 : 0.62);
  if (m >= 8 && m <= 11) return genChip(p, fm * 3.7, m == 11 ? 1.6 : 1.0);
  if (m == 12) { // splinter
    vec2 q = vec2(p.x * 5.0, p.y);
    float jag = fbm(vec3(p.y * 8.0, 1.0, 3.0), 2) * 0.3;
    float w = (1.0 - abs(p.y)) * 0.9 + jag;
    float a = smoothstep(0.0, 0.1, w - abs(q.x));
    return vec4(a, clamp(w - abs(q.x), 0.0, 1.0), 0.8 + 0.2 * fbm(vec3(p * 12.0, 5.0), 2), 1.0);
  }
  if (m == 13 || m == 14) return genShard(p, fm * 2.3);
  if (m == 15) { // blood droplet
    float a = 1.0 - smoothstep(0.6, 0.75, r);
    float z = sqrt(max(0.0, 1.0 - (r / 0.75) * (r / 0.75)));
    return vec4(a, z, 0.8, 1.0);
  }
  if (m == 16 || m == 17) { // blood mist
    vec3 q = vec3(p * 2.2, fm);
    float n = fbm(q, 5) + (billow(q * 1.4, 2) - 0.5) * 0.6;
    float d = (1.0 - smoothstep(0.1, 0.9, r)) * 1.4 + n * 0.9 - 0.45;
    d = clamp(d, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, r));
    float z = sqrt(max(0.0, 1.0 - r * r));
    return vec4(d, z * 0.8 + n * 0.3, 0.6 + 0.4 * n, 1.0);
  }
  if (m == 18) { // ring
    float v = exp(-pow((r - 0.78) / 0.12, 2.0)) * (0.7 + 0.3 * fbm(vec3(p * 6.0, 2.0), 3));
    v *= 1.0 - smoothstep(0.93, 1.0, r);
    return vec4(v, 0.5, v, 1.0);
  }
  if (m == 19) { // dust streak (sand spray), soft elongated plume, head at top
    vec2 q = vec2(p.x * 2.4, p.y);
    float n = fbm(vec3(p * vec2(4.0, 2.0), 7.0), 4);
    float d = (1.0 - length(q * vec2(1.0, 0.9))) * 1.5 + n * 0.8;
    d = clamp(d, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y))));
    return vec4(d, sqrt(max(0.0, 1.0 - dot(q, q))) * 0.7 + n * 0.2, 0.8, 1.0);
  }
  if (m == 20) { // grains
    float v = 0.0;
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      vec2 c = (vec2(hsh(fi * 1.3), hsh(fi * 2.7 + 1.0)) - 0.5) * 1.4;
      float rr = mix(0.02, 0.06, hsh(fi * 5.1));
      v = max(v, 1.0 - smoothstep(rr * 0.6, rr, length(p - c)));
    }
    return vec4(v, v, 0.8, 1.0);
  }
  if (m == 21) { // flare: bright core + long thin rays
    float ang = atan(p.y, p.x);
    float rays = pow(abs(cos(ang * 3.0)), 60.0) * 0.8 + pow(abs(cos(ang * 3.0 + 0.52)), 120.0) * 0.4;
    float v = exp(-r * r * 14.0) + rays * exp(-r * 2.5) + exp(-r * r * 2.0) * 0.25;
    v *= 1.0 - smoothstep(0.9, 1.0, r);
    return vec4(clamp(v, 0.0, 1.0), 0.0, clamp(v, 0.0, 1.0), 1.0);
  }
  if (m == 22) { // ember
    float v = exp(-r * r * 25.0) + exp(-r * r * 4.0) * 0.2;
    return vec4(clamp(v, 0.0, 1.0), 0.0, clamp(v, 0.0, 1.0), 1.0);
  }
  if (m == 23) { // smoke wisp (vertical, curling)
    float n = fbm(vec3(p.x * 2.0, p.y * 1.3, 4.0), 4);
    float cx = n * 0.55 + sin(p.y * 3.0) * 0.12;
    float w = mix(0.08, 0.38, p.y * 0.5 + 0.5);
    float d = exp(-pow((p.x - cx) / w, 2.0)) * (1.0 - smoothstep(0.55, 1.0, abs(p.y)));
    d *= 0.6 + 0.6 * fbm(vec3(p * 5.0, 9.0), 3);
    return vec4(clamp(d, 0.0, 1.0), 0.6, 0.8, 1.0);
  }
  if (m == 24) { // soft puff
    float n = fbm(vec3(p * 3.0, 12.0), 4);
    float d = clamp((1.0 - smoothstep(0.0, 0.95, r)) * 1.3 + n * 0.4 - 0.2, 0.0, 1.0);
    float z = sqrt(max(0.0, 1.0 - r * r));
    return vec4(d, z * 0.8 + n * 0.2, 0.8, 1.0);
  }
  if (m == 25) return genStar(p, 7.7, 9, 0.97, 0.09); // shotgun: many thin prongs
  if (m == 26) { // chips cluster
    float v = 0.0, h = 0.0;
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      vec2 c = (vec2(hsh(fi * 3.3 + 2.0), hsh(fi * 1.9 + 4.0)) - 0.5) * 1.3;
      vec4 ch = genChip((p - c) * 4.0, fi * 5.0, 1.0);
      v = max(v, ch.x); h = max(h, ch.y * ch.x);
    }
    return vec4(v, h, 0.8, 1.0);
  }
  if (m == 27) { // forward flame cone (side view), base at bottom
    float y01 = p.y * 0.5 + 0.5;
    float nz = fbm(vec3(p.x * 4.0, p.y * 2.5, 3.0), 4);
    float w = mix(0.1, 0.85, pow(y01, 0.7)) * (1.0 - smoothstep(0.65, 1.0, y01));
    float d = 1.0 - smoothstep(0.2, 1.0, abs(p.x) / max(w, 1e-3) + nz * 0.3);
    d *= smoothstep(0.0, 0.12, y01) * (0.65 + 0.5 * nz);
    return vec4(clamp(d, 0.0, 1.0), 0.0, clamp(d, 0.0, 1.0), 1.0);
  }
  if (m == 28) { // suppressed puff: small bright core in soft grey ball
    float v = exp(-r * r * 30.0);
    float d = clamp((1.0 - smoothstep(0.0, 0.9, r)) + fbm(vec3(p * 3.0, 21.0), 3) * 0.4, 0.0, 1.0);
    return vec4(max(v, d * 0.7), 0.5, v, 1.0);
  }
  return vec4(0.0);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float cell = uSize / 8.0;
  vec2 ci = floor(px / cell);
  vec2 p = fract(px / cell) * 2.0 - 1.0;
  vec4 o;
  if (ci.y < 4.0) {
    float f = ci.y * 4.0 + mod(ci.x, 4.0);
    if (ci.x < 4.0) o = genSmoke(p, f / 15.0, f);
    else o = genFire(p, f / 15.0, f);
  } else {
    int m = int((ci.y - 4.0) * 8.0 + ci.x);
    o = genMisc(m, p);
  }
  gl_FragColor = o;
}`;

// Final pass: height -> normal, pack channels.
const PARTICLE_FINAL = /* glsl */`
precision highp float;
uniform sampler2D uRaw;
uniform float uSize;
uniform float uStrength;
void main() {
  vec2 px = gl_FragCoord.xy;
  float cell = uSize / 8.0;
  vec2 c0 = floor(px / cell) * cell;
  vec2 lo = (c0 + 0.5) / uSize, hi = (c0 + cell - 0.5) / uSize;
  vec2 uv = px / uSize;
  vec2 e = vec2(1.5 / uSize, 0.0);
  vec4 raw = texture2D(uRaw, uv);
  float hl = texture2D(uRaw, clamp(uv - e.xy, lo, hi)).g;
  float hr = texture2D(uRaw, clamp(uv + e.xy, lo, hi)).g;
  float hd = texture2D(uRaw, clamp(uv - e.yx, lo, hi)).g;
  float hu = texture2D(uRaw, clamp(uv + e.yx, lo, hi)).g;
  // true slope in cell units (cell spans p = -1..1): dh/dp = dh / (2 * 1.5px) * (cell / 2)
  vec2 g = vec2(hr - hl, hu - hd) * (cell / 6.0) * uStrength;
  vec3 n = normalize(vec3(-g, 1.0));
  gl_FragColor = vec4(raw.r, n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, raw.b);
}`;

// ---------------------------------------------------------------------------------------
// Decal atlas, raw pass: R alpha, G height, B lum, A mask (1 = exposed/bright material).
const DECAL_RAW = /* glsl */`
precision highp float;
uniform float uSize;
${NOISE_GLSL}
const float PI = 3.14159265;
float hsh(float n) { return fract(sin(n * 91.3458) * 47453.5453); }

// Irregular crater radius as a function of angle.
float craterR(float ang, float base, float seed) {
  float n = fbm(vec3(cos(ang) * 1.6, sin(ang) * 1.6, seed), 4);
  return base * (1.0 + 0.55 * n);
}

// Radial jagged cracks, returns crack intensity 0..1.
float cracks(vec2 p, float seed, int n, float len) {
  float c = 0.0;
  float r = length(p);
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float fi = float(i);
    float a = (fi + hsh(seed + fi) * 0.8) / float(n) * 2.0 * PI;
    float L = len * mix(0.5, 1.0, hsh(seed * 2.0 + fi));
    // wobble the crack angle with distance
    float wob = fbm(vec3(r * 9.0, fi, seed), 3) * 0.35;
    vec2 d = vec2(cos(a + wob), sin(a + wob));
    float along = dot(p, d);
    float perp = abs(p.x * d.y - p.y * d.x);
    float tp = 1.0 - along / L;
    if (along > 0.0 && tp > 0.0) c = max(c, exp(-perp * perp / (0.00004 + 0.0002 * tp)) * tp);
  }
  return c;
}

vec4 bulletHole(vec2 p, float seed, float holeR, float crater, float bright, int nCracks, float crackLen, float ring) {
  float r = length(p), ang = atan(p.y, p.x);
  float cr = craterR(ang, crater, seed);
  float hr = holeR * (1.0 + 0.25 * fbm(vec3(p * 12.0, seed + 3.0), 2));
  float nz = fbm(vec3(p * 18.0, seed + 1.0), 3);
  float a = 0.0, h = 0.0, lum = 0.5, mask = 0.0;
  // soot / scuff ring
  float ringA = ring * (1.0 - smoothstep(cr, cr * 2.4, r)) * (0.6 + 0.4 * nz);
  a = ringA; lum = 0.35; h = -0.02;
  // cracks
  float ck = cracks(p, seed, nCracks, crackLen);
  if (ck > 0.02) { a = max(a, ck * 0.9); lum = mix(lum, 0.12, ck); h -= ck * 0.15; }
  // crater: exposed material, bowl toward the hole, chunky noise
  if (r < cr) {
    float t = r / cr;
    a = 1.0;
    mask = 1.0;
    lum = bright * (0.8 + 0.35 * nz) * mix(0.75, 1.0, t);
    h = -0.55 * (1.0 - t * t) + nz * 0.12;
    // rim lip
    h += 0.12 * exp(-pow((t - 0.92) / 0.08, 2.0));
  }
  if (r < hr) { a = 1.0; mask = 0.0; lum = 0.03; h = -1.0; }
  else if (r < hr * 1.5) { float t = (r - hr) / (hr * 0.5); lum = mix(0.05, lum, t); h = mix(-1.0, h, t); }
  a *= 1.0 - smoothstep(0.9, 1.0, r);
  return vec4(clamp(a, 0.0, 1.0), h, lum, mask);
}

vec4 metalHole(vec2 p, float seed) {
  float r = length(p);
  float nz = fbm(vec3(p * 10.0, seed), 3);
  float a = 0.0, h = 0.0, lum = 0.5, mask = 0.0;
  // dent
  float dent = 1.0 - smoothstep(0.0, 0.42, r);
  a = smoothstep(0.0, 0.3, dent) * 0.55; h = -dent * 0.5; lum = 0.45;
  // paint chipped ring -> bare metal
  float cr = 0.2 * (1.0 + 0.35 * nz);
  if (r < cr) { a = 1.0; mask = 1.0; lum = 0.85; h = -0.4 * (1.0 - r / cr) - 0.2; }
  // hole
  float hr = 0.075;
  if (r < hr) { a = 1.0; mask = 0.0; lum = 0.02; h = -1.0; }
  else if (r < hr * 1.4) { float t = (r - hr) / (hr * 0.4); h = mix(0.25, h, t); lum = mix(0.95, lum, t); mask = 1.0; }
  a *= 1.0 - smoothstep(0.85, 1.0, r);
  return vec4(a, h, lum, mask);
}

vec4 glassHole(vec2 p) {
  float r = length(p), ang = atan(p.y, p.x);
  float ck = cracks(p, 3.3, 8, 0.95);
  float rings = 0.0;
  for (int i = 1; i <= 3; i++) {
    float rr = 0.12 * float(i) * (1.0 + 0.2 * fbm(vec3(cos(ang) * 3.0, sin(ang) * 3.0, float(i)), 2));
    rings = max(rings, exp(-pow((r - rr) / 0.006, 2.0)) * 0.8);
  }
  float frost = (1.0 - smoothstep(0.0, 0.14, r)) * 0.9;
  float a = max(max(ck, rings * step(r, 0.45)), frost);
  float hole = 1.0 - smoothstep(0.035, 0.045, r);
  a = max(a, hole);
  a *= 1.0 - smoothstep(0.9, 1.0, r);
  return vec4(a, -ck * 0.2, mix(0.9, 0.05, hole), 1.0 - hole);
}

vec4 sandHole(vec2 p) {
  float r = length(p);
  float nz = fbm(vec3(p * 7.0, 4.0), 3);
  float pit = 1.0 - smoothstep(0.05, 0.28 + nz * 0.05, r);
  float ring = exp(-pow((r - 0.32) / 0.12, 2.0)) * (0.6 + 0.4 * nz);
  float a = max(pit, ring * 0.7) * (1.0 - smoothstep(0.7, 0.95, r));
  float h = -pit * 0.6 + ring * 0.25;
  return vec4(a, h, mix(0.55, 0.3, pit), ring * 0.8);
}

vec4 bloodSplat(vec2 p, float seed, float spray) {
  float r = length(p);
  float ang = atan(p.y, p.x);
  vec2 q = p;
  q.x /= 1.0 + spray;
  float n = fbm(vec3(q * 3.5, seed), 5);
  float blob = (1.0 - smoothstep(0.1, 0.5, length(q) + n * 0.25));
  // droplets
  float drops = 0.0;
  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    float da = hsh(seed + fi * 1.7) * 2.0 * PI;
    float dr = mix(0.35, 0.9, pow(hsh(seed * 1.3 + fi), 0.7));
    vec2 c = vec2(cos(da) * (1.0 + spray), sin(da)) * dr;
    c.x = clamp(c.x, -0.9, 0.9);
    float sz = mix(0.012, 0.045, hsh(fi * 3.1 + seed)) * (1.0 - dr * 0.4);
    vec2 dd = p - c;
    // elongate along radial direction
    vec2 rd = normalize(c + 1e-4);
    float al = dot(dd, rd), pe = dd.x * rd.y - dd.y * rd.x;
    drops = max(drops, 1.0 - smoothstep(sz * 0.7, sz, length(vec2(al / (1.0 + spray * 1.5), pe))));
  }
  // spray streaks
  float streak = 0.0;
  if (spray > 0.0) {
    float s = fbm(vec3(ang * 6.0, 0.0, seed), 3);
    streak = smoothstep(0.35, 0.6, s) * smoothstep(0.95, 0.3, r) * smoothstep(0.1, 0.3, r) * 0.8;
  }
  float a = clamp(max(max(blob, drops), streak), 0.0, 1.0) * (1.0 - smoothstep(0.92, 1.0, r));
  float thick = blob * (0.6 + 0.4 * n);
  return vec4(a, thick * 0.35, 0.55 + 0.45 * thick, 0.0);
}

vec4 dripDecal(vec2 p) {
  float a = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 c = (vec2(hsh(fi * 2.1), hsh(fi * 4.7 + 1.0)) - 0.5) * 1.3;
    float sz = mix(0.04, 0.12, hsh(fi * 7.7));
    float n = fbm(vec3((p - c) * 8.0, fi), 2) * 0.3;
    a = max(a, 1.0 - smoothstep(sz * 0.8, sz, length(p - c) * (1.0 + n)));
  }
  return vec4(a * (1.0 - smoothstep(0.9, 1.0, length(p))), a * 0.3, 0.8, 0.0);
}

vec4 scorch(vec2 p, float seed, float streaky) {
  float r = length(p);
  float ang = atan(p.y, p.x);
  float n = fbm(vec3(p * 3.0, seed), 5);
  float rays = fbm(vec3(cos(ang) * 4.0, sin(ang) * 4.0, seed + r * 0.5), 4);
  float d = 1.0 - smoothstep(0.0, 0.85, r + n * 0.25 - rays * streaky * 0.35);
  float a = clamp(d * 1.3, 0.0, 1.0) * (1.0 - smoothstep(0.8, 1.0, r));
  float lum = mix(0.12, 0.02, d) + n * 0.03;
  return vec4(a * 0.95, -d * 0.05 + n * 0.03, lum, 0.0);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float cell = uSize / 4.0;
  vec2 ci = floor(px / cell);
  vec2 p = fract(px / cell) * 2.0 - 1.0;
  int k = int(ci.y * 4.0 + ci.x);
  vec4 o = vec4(0.0);
  if (k == 0) o = bulletHole(p, 1.0, 0.11, 0.27, 0.78, 5, 0.78, 0.45);
  else if (k == 1) o = bulletHole(p, 2.7, 0.1, 0.31, 0.8, 4, 0.82, 0.4);
  else if (k == 2) o = bulletHole(p, 5.1, 0.12, 0.42, 0.95, 2, 0.6, 0.3);
  else if (k == 3) o = bulletHole(p, 6.6, 0.11, 0.46, 0.92, 3, 0.55, 0.25);
  else if (k == 4 || k == 5) {
    // wood: stretch along grain (x), splintered
    vec2 q = vec2(p.x * 0.62, p.y * 1.2);
    o = bulletHole(q, 8.0 + float(k), 0.11, 0.3, 0.95, 0, 0.0, 0.35);
    float spl = smoothstep(0.55, 0.8, fbm(vec3(p.x * 1.5, p.y * 10.0, float(k)), 3)) * (1.0 - smoothstep(0.3, 0.9, abs(p.x))) * (1.0 - smoothstep(0.08, 0.3, abs(p.y)));
    o.x = max(o.x, spl); o.z = mix(o.z, 0.25, spl * (1.0 - o.w)); o.y -= spl * 0.2;
  }
  else if (k == 6) o = metalHole(p * 0.62, 1.3);
  else if (k == 7) o = metalHole(p * 0.7, 4.4);
  else if (k == 8) o = glassHole(p);
  else if (k == 9) o = sandHole(p);
  else if (k == 10) o = bloodSplat(p, 3.0, 0.0);
  else if (k == 11) o = bloodSplat(p, 7.0, 0.9);
  else if (k == 12) o = dripDecal(p);
  else if (k == 13) o = scorch(p, 2.0, 1.0);
  else if (k == 14) o = scorch(p * 1.1, 9.0, 0.2);
  else if (k == 15) o = bulletHole(p, 11.0, 0.09, 0.24, 0.72, 6, 0.85, 0.5);
  gl_FragColor = o;
}`;

// Final decal passes: 0 albedo, 1 normal, 2 ORM.
const DECAL_FINAL = /* glsl */`
precision highp float;
uniform sampler2D uRaw;
uniform float uSize;
uniform int uOut;
void main() {
  vec2 px = gl_FragCoord.xy;
  float cell = uSize / 4.0;
  vec2 ci = floor(px / cell);
  int k = int(ci.y * 4.0 + ci.x);
  vec2 c0 = ci * cell;
  vec2 lo = (c0 + 0.5) / uSize, hi = (c0 + cell - 0.5) / uSize;
  vec2 uv = px / uSize;
  vec4 raw = texture2D(uRaw, uv);
  bool blood = k >= 10 && k <= 12;
  bool scorch = k == 13 || k == 14;
  bool metal = k == 6 || k == 7;
  if (uOut == 0) {
    vec3 col = vec3(raw.b);
    if (blood) col = mix(vec3(0.075, 0.004, 0.003), vec3(0.19, 0.012, 0.008), raw.b);
    else if (scorch) col = vec3(raw.b * 1.05, raw.b, raw.b * 0.92);
    else if (metal) col = mix(vec3(raw.b * 0.9), vec3(0.62, 0.62, 0.64), raw.a);
    gl_FragColor = vec4(col, raw.r);
  } else if (uOut == 1) {
    vec2 e = vec2(1.0 / uSize, 0.0);
    float hl = texture2D(uRaw, clamp(uv - e.xy, lo, hi)).g, hr = texture2D(uRaw, clamp(uv + e.xy, lo, hi)).g;
    float hd = texture2D(uRaw, clamp(uv - e.yx, lo, hi)).g, hu = texture2D(uRaw, clamp(uv + e.yx, lo, hi)).g;
    float s = 6.0 * (cell / 256.0);
    vec3 n = normalize(vec3(-(hr - hl) * s, -(hu - hd) * s, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  } else {
    float rough = blood ? 0.28 : scorch ? 0.95 : metal ? mix(0.8, 0.32, raw.a) : mix(0.9, 0.97, raw.a);
    float metalness = metal ? raw.a * 0.9 : 0.0;
    float ao = mix(1.0, 0.35, clamp(-raw.g, 0.0, 1.0));
    gl_FragColor = vec4(ao, rough, metalness, 1.0);
  }
}`;

// ---------------------------------------------------------------------------------------

function fsPass(renderer, frag, uniforms, target) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: FS_TRI, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevRT = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevXR = renderer.xr?.enabled;
  if (renderer.xr) renderer.xr.enabled = false;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevRT);
  renderer.autoClear = prevAuto;
  if (renderer.xr) renderer.xr.enabled = prevXR;
  geo.dispose(); mat.dispose();
}

function makeRT(size, type, mips) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: !!mips,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter,
    magFilter: mips ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

function fallbackTex(rgba) {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** Build all FX atlases. Returns { particles, decalAlbedo, decalNormal, decalOrm, targets }. */
export function buildAtlases(renderer, { size = 2048, decalSize = 1024 } = {}) {
  if (!renderer?.render) {
    return {
      particles: fallbackTex([255, 128, 128, 255]),
      decalAlbedo: fallbackTex([40, 40, 40, 255]), decalNormal: fallbackTex([128, 128, 255, 255]),
      decalOrm: fallbackTex([255, 230, 0, 255]), targets: [],
    };
  }
  const aniso = renderer.capabilities?.getMaxAnisotropy?.() || 1;
  const raw = makeRT(size, THREE.HalfFloatType, false);
  fsPass(renderer, PARTICLE_RAW, { uSize: { value: size } }, raw);
  const part = makeRT(size, THREE.UnsignedByteType, true);
  fsPass(renderer, PARTICLE_FINAL, { uRaw: { value: raw.texture }, uSize: { value: size }, uStrength: { value: 1.0 } }, part);
  raw.dispose();
  part.texture.anisotropy = Math.min(4, aniso);

  const draw = makeRT(decalSize, THREE.HalfFloatType, false);
  fsPass(renderer, DECAL_RAW, { uSize: { value: decalSize } }, draw);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const rt = makeRT(decalSize, THREE.UnsignedByteType, true);
    fsPass(renderer, DECAL_FINAL, { uRaw: { value: draw.texture }, uSize: { value: decalSize }, uOut: { value: i } }, rt);
    rt.texture.anisotropy = aniso;
    out.push(rt);
  }
  draw.dispose();
  // Albedo is authored in linear space; flag as such so no decode is applied.
  return {
    particles: part.texture, decalAlbedo: out[0].texture, decalNormal: out[1].texture, decalOrm: out[2].texture,
    targets: [part, ...out],
  };
}
