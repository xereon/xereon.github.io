// Shared GLSL building blocks used by several materials (appended after NOISE_GLSL).
import { C } from './util.js';

export const LIB = /* glsl */`
// Hairline crack network on a warped Voronoi graph. density 0..1 = fraction of edges that
// crack; width in texels. Returns 0..1 (1 = crack centre).
float crackNet(vec2 uv, float F, float density, float widthPx, float s) {
  vec2 w = uv + (0.28 / F) * vec2(fbmU(uv, F * 2.0, 3, 0.55, s), fbmU(uv + 0.5, F * 2.0, 3, 0.55, s + 1.0));
  vec4 v = worley(w * F, vec2(F), 0.95, s + 2.0);
  float keep = smoothstep(1.0 - density - 0.08, 1.0 - density + 0.08, vnU(uv, F * 2.0, s + 3.0));
  float wid = widthPx * uPx.x * F * (0.6 + 0.8 * vnU(uv, F * 6.0, s + 4.0));
  return (1.0 - smoothstep(wid * 0.5, wid * 1.6, v.w)) * keep;
}

// Soft large-scale staining 0..1 (water marks, grime blooms)
float stainField(vec2 uv, float F, float s) {
  float n = warpFbm(uv, F, 0.35, 5, s);
  return smoothstep(-0.05, 0.6, n);
}

// Vertical run-off streaks 0..1
float streaks(vec2 uv, float Fx, float Fy, float s) {
  float n = fbm(uv * vec2(Fx, Fy), vec2(Fx, Fy), 4, 0.5, s);
  float m = vnU(uv, 3.0, s + 5.0);
  return smoothstep(0.05, 0.5, n) * smoothstep(0.35, 0.8, m);
}

// Tan fired brick underneath plaster (exposed in chips). uv-periodic.
void brickUnder(vec2 uv, float rows, float cols, out float h, out vec3 col, out float rough) {
  Cell b = bricks(uv, rows, cols, 0.5, 71.0);
  float mortarW = 0.18 * b.size.y;
  float e = b.edge + 0.25 * mortarW * gnU(uv, 64.0, 72.0);
  float face = smoothstep(mortarW * 0.5, mortarW * 1.3, e);
  float tone = b.rnd;
  vec3 bc = mix(${C('#b88e62')}, ${C('#c9a071')}, tone);
  bc = mix(bc, ${C('#a8744c')}, smoothstep(0.75, 1.0, hash1(b.id, 73.0)) * 0.7);
  bc *= 0.9 + 0.2 * vnU(uv, 96.0, 74.0);
  vec3 mc = ${C('#b9aa8c')} * (0.9 + 0.2 * vnU(uv, 128.0, 75.0));
  col = mix(mc, bc, face);
  h = face * (0.35 + 0.08 * gnU(uv, 48.0, 76.0)) - 0.15;
  rough = mix(0.97, 0.88, face);
}
`;
