// Timber: planks, crates, doors, frames, shutters, stencilled crate panels.
// Crates / doors / labels / shutters are laid out per face: use mesh uvs (0..1 per face).
import { C } from './util.js';

// Horizontal weathered boards with butt joints and nails (fences, floors, scaffolds).
export const wood_planks = {
  world: 128, normal: 1.0, ao: 1.0, aoRadius: 5, cavity: 0.45, antiTile: true, macro: [0.1, 0.05],
  surface: 'wood', seed: 301,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float rows = 12.0;
  float r = floor(uv.y * rows), fy = fract(uv.y * rows);
  vec3 hr = hash3(vec2(r, 0.0), 1.0);
  float x = fract(uv.x + hr.x);
  float j1 = 0.35 + 0.3 * hr.y;
  float seg = step(j1, x);
  float dj = min(min(x, 1.0 - x), abs(x - j1));
  vec3 hb = hash3(vec2(r, seg), 2.0);
  float across = min(fy, 1.0 - fy) / rows;
  float e = min(across, dj) + 0.0012 * fbmU(uv, 40.0, 3, 0.5, 3.0);
  float prof = pillow(e - 0.0025, 0.004);
  float rings, fib, check;
  float g = woodGrain(uv, vec2(2.0, 48.0), hb.x * 7.0, 4.0, false, rings, fib, check);
  float cup = 0.15 * (1.0 - pow(abs(fy - 0.5) * 2.0, 2.0));
  vec2 nd = vec2((dj - 0.012) * 8.0, (abs(fy - 0.5) - 0.25) / rows * 8.0) * rows;
  float nail = (1.0 - smoothstep(0.05, 0.09, length(vec2(dj - 0.012, (abs(fy - 0.5) - 0.25) / rows) * rows)));
  o.h = prof * (0.6 + cup + g + 0.1 * hb.y) - 0.05 * nail;
  float silver = sat(0.45 + 0.5 * fbmU(uv + hb.xy, 3.0, 3, 0.5, 5.0) + 0.3 * (hb.z - 0.5));
  vec3 c = woodColour(hb.y, silver, rings, fib, check);
  c *= 0.93 + 0.1 * hb.x;
  c = mix(c * 0.6, c, prof);
  c = mix(c, ${C('#4a4038')}, nail * 0.85);
  float dust = smoothstep(0.1, 0.7, fbmU(uv, 5.0, 3, 0.5, 6.0));
  c = mix(c, ${C('#c8b898')}, dust * 0.25);
  o.col = c;
  o.rough = 0.8 + 0.1 * silver - 0.1 * rings + 0.05 * dust;
  o.metal = nail * 0.0;
  o.ao = 1.0 - check * 0.4;
}
`,
};

const CRATE_WOOD = /* glsl */`
// pale weathered crate board. dir: grain vertical?
vec3 crateBoard(vec2 uv, float id, bool vertical, float prof, out float h, out float rough) {
  float rings, fib, check;
  float g = woodGrain(uv, vec2(2.0, 40.0), id * 7.0, 11.0, vertical, rings, fib, check);
  vec3 hb = hash3(vec2(id * 131.0, 3.0), 12.0);
  float silver = sat(0.55 + 0.4 * fbmU(uv + hb.xy, 3.0, 3, 0.5, 13.0) + 0.3 * (hb.z - 0.5));
  vec3 c = woodColour(hb.y, silver, rings, fib, check);
  c = mix(c, vec3(luma(c)), 0.25) * 1.18;
  h = prof * (0.5 + g + 0.08 * hb.x);
  rough = 0.78 + 0.1 * silver - 0.08 * rings;
  return c * (0.94 + 0.1 * hb.x);
}
`;

// Crate side: raised frame, recessed horizontal planks, steel corner plates with rivets.
export const wood_crate = {
  world: 48, normal: 1.0, ao: 1.0, aoRadius: 6, cavity: 0.5, cavRough: 0.04,
  antiTile: false, surface: 'crate', seed: 311, clamp: false,
  glsl: CRATE_WOOD + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float fw = 0.13;
  float ero = 0.004 * fbmU(uv, 30.0, 3, 0.5, 1.0);
  bool rail = uv.y < fw || uv.y > 1.0 - fw;
  bool stile = !rail && (uv.x < fw || uv.x > 1.0 - fw);
  float h, rough; vec3 c;
  if (rail || stile) {
    // frame member: distance to its own rectangle edges
    vec2 lo = rail ? vec2(0.0, uv.y < fw ? 0.0 : 1.0 - fw) : vec2(uv.x < fw ? 0.0 : 1.0 - fw, fw);
    vec2 hi = rail ? vec2(1.0, uv.y < fw ? fw : 1.0) : vec2(uv.x < fw ? fw : 1.0, 1.0 - fw);
    vec2 d = min(uv - lo, hi - uv);
    float e = min(d.x, d.y) + ero;
    float prof = pillow(e - 0.003, 0.012);
    float id = rail ? (uv.y < fw ? 1.0 : 2.0) : (uv.x < fw ? 3.0 : 4.0);
    c = crateBoard(uv, id, stile, prof, h, rough);
    h += 0.7;
    c = mix(c * 0.55, c, prof);
  } else {
    float y = (uv.y - fw) / (1.0 - 2.0 * fw) * 5.0;
    float pi = floor(y), fy = fract(y);
    float e = min(fy, 1.0 - fy) * (1.0 - 2.0 * fw) / 5.0 + ero;
    float prof = pillow(e - 0.002, 0.008);
    c = crateBoard(uv, 10.0 + pi, false, prof, h, rough);
    c = mix(c * 0.5, c, prof);
  }
  // steel corner plates with rivets
  vec2 cq = min(uv, 1.0 - uv);
  float plate = step(max(cq.x, cq.y), 0.105) * step(0.0, 1.0);
  float pe = 0.105 - max(cq.x, cq.y);
  float pprof = smoothstep(0.0, 0.006, pe);
  vec2 rv = cq - 0.05;
  float rivet = 1.0 - smoothstep(0.008, 0.013, min(length(rv - vec2(0.0, 0.03)), min(length(rv - vec2(0.03, 0.0)), length(rv))));
  float rust = smoothstep(0.2, 0.6, fbmU(uv, 24.0, 3, 0.5, 20.0) + 0.5 * (1.0 - pprof));
  vec3 steel = mix(${C('#5c6164')}, ${C('#7a5a42')}, rust * 0.8);
  float bare = smoothstep(0.55, 0.6, fbmU(uv, 40.0, 3, 0.5, 21.0)) * (1.0 - rust);
  steel = mix(steel, ${C('#9a9c9c')}, bare);
  float onPlate = plate * pprof;
  o.h = mix(h, 1.5 + 0.2 * rivet, onPlate);
  o.col = mix(c, steel * (1.0 + 0.2 * rivet), onPlate);
  o.rough = mix(rough, mix(0.6 + 0.3 * rust, 0.35, bare), onPlate);
  o.metal = onPlate * bare;
  // dust settles on the lower part of the face
  float dust = (1.0 - smoothstep(0.0, 0.35, uv.y)) * 0.25 + 0.15 * smoothstep(0.2, 0.7, fbmU(uv, 4.0, 3, 0.5, 22.0));
  o.col = mix(o.col, ${C('#cbbd9e')}, dust * (1.0 - onPlate * 0.5));
}
`,
};

// Double-door leaf: vertical planks, rails + Z-brace, iron strap hinges, faded teal paint.
export const wood_door = {
  world: 108, normal: 1.0, ao: 1.0, aoRadius: 6, cavity: 0.5, cavRough: 0.04,
  antiTile: false, surface: 'wood', seed: 321,
  glsl: /* glsl */`
float railMask(vec2 uv, float y0, float y1) { return step(y0, uv.y) * step(uv.y, y1); }
void surface(vec2 uv, inout Surf o) {
  float ero = 0.003 * fbmU(uv, 30.0, 3, 0.5, 1.0);
  // planks
  float px = uv.x * 5.0, pi = floor(px), fx = fract(px);
  float pe = min(fx, 1.0 - fx) / 5.0 + ero;
  float pprof = pillow(pe - 0.003, 0.006);
  float rings, fib, check;
  float g = woodGrain(uv, vec2(2.0, 30.0), pi * 3.3, 2.0, true, rings, fib, check);
  float h = pprof * (0.5 + g);
  float id = pi;
  bool vert = true;
  // rails
  float r1 = railMask(uv, 0.07, 0.17), r2 = railMask(uv, 0.46, 0.56), r3 = railMask(uv, 0.83, 0.93);
  float rail = max(r1, max(r2, r3));
  float ry = r1 > 0.5 ? 0.12 : r2 > 0.5 ? 0.51 : 0.88;
  float re = min(0.05 - abs(uv.y - ry), min(uv.x, 1.0 - uv.x)) + ero;
  // Z braces between rails (diagonal board, width 0.08)
  vec2 a0 = vec2(0.1, 0.17), a1 = vec2(0.9, 0.46), b0 = vec2(0.1, 0.56), b1 = vec2(0.9, 0.83);
  vec2 da = a1 - a0, db = b1 - b0;
  float ta = clamp(dot(uv - a0, da) / dot(da, da), 0.0, 1.0);
  float tb = clamp(dot(uv - b0, db) / dot(db, db), 0.0, 1.0);
  float dA = length(uv - a0 - da * ta), dB = length(uv - b0 - db * tb);
  float inBand = step(0.17, uv.y) * step(uv.y, 0.46) + step(0.56, uv.y) * step(uv.y, 0.83);
  float bd = min(dA, dB);
  float brace = step(bd, 0.045) * inBand;
  float be = 0.045 - bd + ero;
  float g2r, f2r, c2r;
  if (rail > 0.5) {
    float g2 = woodGrain(uv, vec2(2.0, 30.0), ry * 9.0, 3.0, false, rings, fib, check);
    h = 0.7 + pillow(re - 0.002, 0.008) * (0.5 + g2);
    id = 10.0 + ry;
  } else if (brace > 0.5) {
    vec2 dir = normalize(dA < dB ? da : db);
    vec2 q = vec2(dot(uv, dir), dot(uv, vec2(-dir.y, dir.x)));
    float g2 = woodGrain(fract(q * 2.0), vec2(2.0, 30.0), 20.0 + step(dB, dA), 4.0, false, rings, fib, check);
    h = 0.7 + pillow(be - 0.002, 0.008) * (0.5 + g2);
    id = 20.0 + step(dB, dA);
  }
  vec3 hb = hash3(vec2(id, 1.0), 5.0);
  float silver = sat(0.55 + 0.35 * fbmU(uv + hb.xy, 3.0, 3, 0.5, 6.0));
  vec3 wood = woodColour(hb.y, silver, rings, fib, check) * (0.93 + 0.1 * hb.x);
  float prof = rail > 0.5 ? pillow(re, 0.01) : brace > 0.5 ? pillow(be, 0.01) : pprof;
  wood = mix(wood * 0.5, wood, prof);
  // faded teal paint, worn back to grey wood on edges and in blotches
  float pn = 0.6 * fbmU(uv, 4.0, 4, 0.5, 7.0) + 0.25 * fbmU(uv, 24.0, 3, 0.5, 8.0) + 0.3 * fib - 0.5 * (1.0 - prof) + 0.25 * (0.5 - rings);
  float paint = smoothstep(0.06, 0.09, pn) * (0.6 + 0.4 * smoothstep(0.1, 0.4, pn));
  vec3 pc = mix(${C('#6a8b93')}, ${C('#8aa3a4')}, sat(fbmU(uv, 3.0, 3, 0.5, 9.0) * 0.6 + 0.5));
  pc *= 0.94 + 0.08 * fib;
  vec3 c = mix(wood, pc, paint * 0.9);
  // iron strap hinges on the rails (left side) with nail heads
  float strap = step(abs(uv.y - ry), 0.02) * step(uv.x, 0.5) * rail;
  float tip = 1.0 - smoothstep(0.018, 0.022, length(uv - vec2(0.5, ry)));
  strap = max(strap, tip * rail);
  vec2 nq = vec2(fract(uv.x * 12.0) - 0.5, uv.y - ry);
  float nailH = (1.0 - smoothstep(0.1, 0.18, length(nq * vec2(1.0, 12.0)))) * rail * step(0.5, uv.x);
  float rust = smoothstep(0.1, 0.6, fbmU(uv, 20.0, 3, 0.5, 10.0));
  vec3 iron = mix(${C('#3d3b39')}, ${C('#6a4a36')}, rust);
  o.h = h + 0.25 * strap + 0.15 * nailH;
  o.col = mix(c, iron, max(strap, nailH));
  o.rough = mix(mix(0.8 + 0.1 * silver, 0.7, paint), 0.55 + 0.3 * rust, max(strap, nailH));
  o.metal = max(strap, nailH) * (1.0 - rust) * 0.7;
  o.ao = 1.0 - check * 0.4;
}
`,
};

// Painted timber for window frames / trims: dark green-teal paint, alligatored + chipped.
export const window_frame = {
  world: 48, normal: 1.0, ao: 0.9, aoRadius: 4, cavity: 0.4, antiTile: true, macro: [0.06, 0.04],
  surface: 'wood', seed: 331,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float rings, fib, check;
  float g = woodGrain(uv, vec2(2.0, 20.0), 1.0, 1.0, false, rings, fib, check);
  vec3 wood = woodColour(0.5, 0.7, rings, fib, check);
  vec4 w = worley(uv * vec2(20.0, 36.0), vec2(20.0, 36.0), 0.8, 2.0);
  float alli = (1.0 - smoothstep(0.015, 0.035, w.w)) * smoothstep(0.0, 0.5, fbmU(uv, 4.0, 3, 0.5, 8.0));   // alligator crazing
  float chip = smoothstep(0.74, 0.76, 0.8 * fbmU(uv, 6.0, 4, 0.5, 3.0) + 0.3 * rings + 0.15 * fbmU(uv, 40.0, 2, 0.5, 9.0));
  vec3 pc = mix(${C('#3f6b5a')}, ${C('#5a8a74')}, sat(fbmU(uv, 3.0, 3, 0.5, 4.0) + 0.5));
  pc *= 1.0 - 0.3 * alli;
  o.h = 0.4 + g * 0.5 + (1.0 - chip) * (0.06 - 0.03 * alli);
  o.col = mix(pc, wood, chip);
  o.rough = mix(0.55 + 0.2 * alli, 0.85, chip);
}
`,
};

// Louvered shutter leaf (green, as on Dust II's houses). Per-leaf uvs.
export const wood_shutter = {
  world: 64, normal: 1.2, ao: 1.0, aoRadius: 5, cavity: 0.5, antiTile: false, surface: 'wood', seed: 341,
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float fw = 0.12;
  float rings, fib, check;
  bool stile = uv.x < fw || uv.x > 1.0 - fw || uv.y < 0.06 || uv.y > 0.94;
  float h;
  if (stile) {
    float g = woodGrain(uv, vec2(2.0, 20.0), 3.0, 1.0, uv.y > 0.06 && uv.y < 0.94, rings, fib, check);
    vec2 d = min(uv, 1.0 - uv);
    float e = min(abs(uv.x - (uv.x < 0.5 ? fw : 1.0 - fw)), abs(uv.y - (uv.y < 0.5 ? 0.06 : 0.94)));
    h = 1.0 + 0.3 * g + 0.3 * pillow(min(e, min(d.x, d.y)), 0.01);
  } else {
    float s = (uv.y - 0.06) / 0.88 * 16.0;
    float fs = fract(s);
    float g = woodGrain(uv, vec2(2.0, 40.0), floor(s), 2.0, false, rings, fib, check);
    h = 0.2 + 0.6 * fs + 0.2 * g - 0.5 * smoothstep(0.9, 1.0, fs);   // tilted slats
  }
  vec3 wood = woodColour(0.4, 0.6, rings, fib, check);
  float chip = smoothstep(0.62, 0.64, fbmU(uv, 8.0, 4, 0.5, 5.0) + 0.25 * rings + 0.12 * fbmU(uv, 40.0, 2, 0.5, 6.0));
  vec3 pc = mix(${C('#4b8a5e')}, ${C('#6ea07a')}, sat(fbmU(uv, 2.0, 3, 0.5, 7.0) + 0.5));
  pc *= 0.95 + 0.06 * fib;
  o.h = h;
  o.col = mix(pc, wood, chip);
  o.rough = mix(0.62, 0.85, chip);
}
`,
};

// Crate panel with stencilled markings (original designs, drawn on a 2D canvas).
export const crate_label = {
  world: 48, normal: 1.0, ao: 1.0, aoRadius: 5, cavity: 0.45, antiTile: false, surface: 'crate', seed: 351,
  canvas(ctx, S) {
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const font = (w, px) => `${w} ${Math.round(px * S)}px "Arial Black", Impact, "DejaVu Sans", sans-serif`;
    ctx.font = font(900, 0.34);
    ctx.fillText('07', S * 0.5, S * 0.44);
    ctx.font = font(800, 0.075);
    ctx.fillText('HANDLE WITH CARE', S * 0.5, S * 0.72);
    ctx.font = font(700, 0.055);
    ctx.fillText('NET 120 KG  ·  LOT 4417-B', S * 0.5, S * 0.81);
    // up arrows
    const arrow = (x, y, s) => {
      ctx.beginPath();
      ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.7, y - s * 0.2); ctx.lineTo(x + s * 0.25, y - s * 0.2);
      ctx.lineTo(x + s * 0.25, y + s * 0.7); ctx.lineTo(x - s * 0.25, y + s * 0.7); ctx.lineTo(x - s * 0.25, y - s * 0.2);
      ctx.lineTo(x - s * 0.7, y - s * 0.2); ctx.closePath(); ctx.fill();
    };
    arrow(S * 0.16, S * 0.22, S * 0.07);
    arrow(S * 0.84, S * 0.22, S * 0.07);
    // stencil bridges
    ctx.globalCompositeOperation = 'destination-out';
    for (const x of [0.36, 0.5, 0.64]) ctx.fillRect(S * x - S * 0.006, S * 0.25, S * 0.012, S * 0.38);
    ctx.fillRect(0, S * 0.438, S, S * 0.01);
    ctx.globalCompositeOperation = 'source-over';
  },
  glsl: CRATE_WOOD + /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float y = uv.y * 6.0, pi = floor(y), fy = fract(y);
  float e = min(fy, 1.0 - fy) / 6.0 + 0.003 * fbmU(uv, 30.0, 3, 0.5, 1.0);
  float prof = pillow(e - 0.002, 0.008);
  float h, rough;
  vec3 c = crateBoard(uv, 30.0 + pi, false, prof, h, rough);
  c = mix(c * 0.5, c, prof);
  // stencil paint with overspray and wear
  float ink = texture(uCanvas, uv).a;
  float spray = texture(uCanvas, uv + uPx * 2.0).a * 0.15;
  float wear = smoothstep(0.1, 0.5, fbmU(uv, 20.0, 3, 0.5, 2.0) + 0.3 * fbmU(uv, 80.0, 2, 0.5, 3.0));
  float paint = sat(ink * (1.0 - wear * 0.8) + spray) * prof;
  vec3 pc = ${C('#2c2a28')};
  o.h = h;
  o.col = mix(c, pc, paint * 0.85);
  o.rough = mix(rough, 0.7, paint);
}
`,
};
