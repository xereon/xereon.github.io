// Impact decals (RGBA + normal) and the tiling detail normal. Decal uv is centred at
// 0.5; alpha fades to 0 well before the border. worldSize = suggested quad size (units).
import { C } from './util.js';

const HOLE = /* glsl */`
// radial helpers around the centre
vec2 dc(vec2 uv) { return uv - 0.5; }
float radialCracks(vec2 p, float n, float s) {
  float a = atan(p.y, p.x) / TAU + 0.5;
  float k = a * n;
  float jitter = hashf(floor(k), s) - 0.5;
  float line = abs(fract(k + jitter * 0.3 + 0.1 * gnoise(vec2(length(p) * 20.0, floor(k)), vec2(64.0), s)) - 0.5);
  float keep = step(0.45, hashf(floor(k), s + 1.0));
  float len = 0.18 + 0.2 * hashf(floor(k), s + 2.0);
  return (1.0 - smoothstep(0.0, 0.06, line)) * keep * (1.0 - smoothstep(len * 0.6, len, length(p)));
}
`;

function bulletDecal(body, fresh, holeR, craterR, crackAmt, seed, worldSize, metal = false) {
  return {
    size: 256, world: worldSize, worldSize, normal: 1.0, ao: 0.8, aoRadius: 4, cavity: 0.4, clamp: true,
    seed, metal,
    glsl: HOLE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 p = dc(uv);
  float r = length(p);
  float rn = r * (1.0 + 0.25 * fbm(uv * 6.0, vec2(6.0), 4, 0.5, 1.0));
  float hole = 1.0 - smoothstep(${holeR.toFixed(3)} * 0.8, ${holeR.toFixed(3)}, rn);
  float crater = 1.0 - smoothstep(${(craterR * 0.5).toFixed(3)}, ${craterR.toFixed(3)}, rn);
  float cracks = radialCracks(p, 14.0, 3.0) * ${crackAmt.toFixed(2)};
  float chips = smoothstep(0.35, 0.45, fbmU(uv, 12.0, 3, 0.5, 4.0)) * (1.0 - smoothstep(${craterR.toFixed(3)}, ${(craterR * 1.5).toFixed(3)}, rn));
  float dust = (1.0 - smoothstep(${(craterR * 0.8).toFixed(3)}, ${(craterR * 2.2).toFixed(3)}, rn)) * (0.5 + 0.5 * fbmU(uv, 10.0, 3, 0.5, 5.0));
  o.h = -0.6 * crater * (1.0 - r / ${craterR.toFixed(3)}) - 1.5 * hole - 0.15 * cracks - 0.1 * chips;
  vec3 c = mix(${C(body)}, ${C(fresh)}, crater * 0.8 + chips * 0.5);
  c = mix(c, ${C('#1c1814')}, hole);
  c *= 1.0 - 0.5 * cracks;
  o.col = c;
  o.alpha = sat(max(max(crater, hole), max(cracks, chips * 0.8)) + dust * 0.35);
  o.rough = 0.9;
  o.metal = ${metal ? '(1.0 - hole) * crater' : '0.0'};
}
`,
  };
}

export const DECALS = {
  bullet_concrete: bulletDecal('#8f877a', '#c9c1b2', 0.035, 0.12, 1.0, 701, 4),
  bullet_plaster: bulletDecal('#a0907a', '#ece6da', 0.03, 0.16, 0.6, 702, 5),
  bullet_metal: bulletDecal('#5c5e5e', '#a9abab', 0.03, 0.08, 0.0, 704, 3, true),
  bullet_wood: {
    size: 256, world: 4, worldSize: 4, normal: 1.0, ao: 0.8, cavity: 0.4, clamp: true, seed: 703,
    glsl: HOLE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 p = dc(uv);
  vec2 q = p * vec2(1.6, 0.7);                    // splinters run along the (vertical) grain
  float r = length(q);
  float hole = 1.0 - smoothstep(0.03, 0.045, length(p * vec2(1.2, 1.0)));
  float spl = fbm(vec2(p.x * 40.0, p.y * 4.0) + 3.0, vec2(64.0, 8.0), 3, 0.5, 2.0);
  float splinter = (1.0 - smoothstep(0.08, 0.2, r + 0.05 * spl)) * smoothstep(-0.2, 0.3, spl);
  float torn = 1.0 - smoothstep(0.05, 0.12, r);
  o.h = -1.4 * hole - 0.3 * torn + 0.15 * splinter;
  vec3 c = mix(${C('#8a6a4a')}, ${C('#d0b088')}, max(splinter, torn * 0.7));
  c = mix(c, ${C('#1e1610')}, hole);
  o.col = c;
  o.alpha = sat(max(hole, max(splinter, torn)));
  o.rough = 0.85;
}
`,
  },
  bullet_sand: {
    size: 256, world: 6, worldSize: 6, normal: 1.0, ao: 0.8, cavity: 0.3, clamp: true, seed: 705,
    glsl: HOLE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 p = dc(uv);
  float r = length(p) * (1.0 + 0.3 * fbm(uv * 5.0, vec2(5.0), 4, 0.5, 1.0));
  float pit = 1.0 - smoothstep(0.02, 0.12, r);
  float rim = smoothstep(0.08, 0.14, r) * (1.0 - smoothstep(0.14, 0.24, r));
  float spray = step(0.5, fbmU(uv, 30.0, 2, 0.5, 2.0)) * (1.0 - smoothstep(0.1, 0.35, r));
  o.h = -0.8 * pit + 0.2 * rim;
  o.col = mix(${C('#c3ad88')}, ${C('#a08c6c')}, pit);
  o.alpha = sat(pit + rim * 0.6 + spray * 0.4);
  o.rough = 0.95;
}
`,
  },
  bullet_glass: {
    size: 256, world: 8, worldSize: 8, normal: 0.6, ao: 0.0, cavity: 0.0, clamp: true, seed: 706,
    glsl: HOLE + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 p = dc(uv);
  float r = length(p);
  float hole = 1.0 - smoothstep(0.02, 0.03, r);
  float rad = radialCracks(p, 22.0, 3.0);
  float ring = 0.0;
  for (int i = 0; i < 3; i++) {
    float rr = 0.06 + 0.05 * float(i) + 0.01 * gnoise(p * 8.0 + float(i), vec2(8.0), 4.0);
    ring = max(ring, (1.0 - smoothstep(0.0, 0.004, abs(r - rr))) * step(0.4, hashf(floor((atan(p.y, p.x) + 3.2) * 3.0), float(i))));
  }
  float frost = 1.0 - smoothstep(0.02, 0.06, r);
  float crack = max(rad, ring);
  o.h = -0.2 * crack;
  o.col = mix(${C('#e4ecea')}, ${C('#202624')}, hole);
  o.alpha = sat(max(hole, max(crack * 0.9, frost * 0.7)));
  o.rough = 0.3;
}
`,
  },
  blood: {
    size: 256, world: 24, worldSize: 24, normal: 0.5, ao: 0.0, cavity: 0.0, clamp: true, seed: 707,
    glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 p = uv - 0.5;
  float r = length(p) * (1.0 + 0.4 * fbm(uv * 4.0, vec2(4.0), 4, 0.5, 1.0));
  float main = 1.0 - smoothstep(0.14, 0.17, r);
  vec4 sp = sparse(uv * 14.0, vec2(14.0), 0.5, 2.0);
  float drops = (1.0 - smoothstep(0.08, 0.16, sp.x * (0.6 + sp.y))) * step(0.0, sp.y) * (1.0 - smoothstep(0.2, 0.45, length(p)));
  float a = max(main, drops);
  float thick = main * (1.0 - smoothstep(0.0, 0.15, r));
  o.h = 0.3 * a + 0.2 * thick;
  o.col = mix(${C('#6e0d0a')}, ${C('#3e0604')}, thick);
  o.alpha = a;
  o.rough = 0.25;
}
`,
  },
  scorch: {
    size: 256, world: 64, worldSize: 64, normal: 0.3, ao: 0.0, cavity: 0.0, clamp: true, seed: 708,
    glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec2 p = uv - 0.5;
  float n = fbm(uv * 5.0, vec2(5.0), 5, 0.55, 1.0);
  float r = length(p) * (1.0 + 0.5 * n);
  float soot = 1.0 - smoothstep(0.05, 0.42, r);
  float streak = 0.5 + 0.5 * sin(atan(p.y, p.x) * 11.0 + 3.0 * n);
  o.h = 0.0;
  o.col = mix(${C('#2a2520')}, ${C('#141210')}, soot);
  o.alpha = sat(soot * (0.75 + 0.25 * streak) * 1.2);
  o.rough = 0.95;
}
`,
  },
};

export const DETAIL = {
  size: 256, world: 16, normal: 1.0, ao: 0.0, cavity: 0.0, seed: 5,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  o.h = 0.03 * fbmU(uv, 16.0, 4, 0.55, 1.0) + 0.012 * fbmU(uv, 64.0, 2, 0.5, 2.0);
}
`,
};
