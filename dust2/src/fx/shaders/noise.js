// GLSL noise helpers shared by the atlas generators. Hash-based (no textures), deterministic.
export const NOISE_GLSL = /* glsl */`
vec3 fxHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return -1.0 + 2.0 * fract((p.xxy + p.yxx) * p.zyx);
}
float fxHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float fxHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 fxHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// Quintic gradient noise, ~[-1, 1].
float gnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(fxHash33(i), f);
  float b = dot(fxHash33(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float c = dot(fxHash33(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float d = dot(fxHash33(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float e = dot(fxHash33(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float g = dot(fxHash33(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float h = dot(fxHash33(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float k = dot(fxHash33(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return 1.6 * mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
// Worley F1 distance (0 at feature points).
float worley(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + 0.5 + 0.45 * fxHash33(i + o) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
// Smooth-min Worley (rounded creases), returns ~squared distance.
float sworley(vec3 p, float k) {
  vec3 i = floor(p), f = fract(p);
  float res = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + 0.5 + 0.45 * fxHash33(i + o) - f;
    res += exp(-k * dot(r, r));
  }
  return -log(max(res, 1e-6)) / k;
}
// 2D Worley returning F1 and F2 (for cracks / cells).
vec2 worley2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + fxHash22(i + o) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(vec2(d1, d2));
}
float billow(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * (1.0 - worley(p));
    p = p * 2.1 + vec3(3.3, 1.1, 7.7);
    a *= 0.5;
  }
  return s;
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;
