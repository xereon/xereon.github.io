// Glass and paper.
import { C } from './util.js';

// Dirty window glass: transparent, smudged roughness, dust film raises opacity.
export const glass = {
  world: 48, size: 256, normal: 0.3, ao: 0.0, cavity: 0.0, antiTile: false, surface: 'glass', seed: 601,
  mat: { transparent: true, depthWrite: false, side: 2, envMapIntensity: 1.2 },
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  float wav = fbmU(uv, 3.0, 3, 0.5, 1.0);
  float smudge = smoothstep(0.0, 0.6, fbmU(uv, 6.0, 4, 0.5, 2.0));
  float dust = smoothstep(-0.2, 0.7, fbmU(uv, 4.0, 3, 0.5, 3.0)) + 0.5 * (1.0 - smoothstep(0.0, 0.3, uv.y));
  float sk = streaks(uv, 16.0, 2.0, 4.0);
  o.h = 0.05 * wav;
  o.col = mix(${C('#3e4a48')}, ${C('#9c937f')}, sat(dust * 0.35 + sk * 0.2));
  o.alpha = sat(0.3 + 0.2 * dust + 0.12 * sk);
  o.rough = 0.06 + 0.3 * smudge + 0.4 * sat(dust);
}
`,
};

// Street poster (original design) on thin paper: faded print, fold creases, torn edges.
export const poster = {
  world: 32, normal: 0.8, ao: 0.4, cavity: 0.2, antiTile: false, surface: 'default', seed: 611,
  mat: { alphaTest: 0.5, side: 2 },
  canvas(ctx, S) {
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#e9dcc0'); g.addColorStop(1, '#e2cfa8');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    // sun disc + rays
    ctx.save(); ctx.translate(S * 0.5, S * 0.4);
    ctx.fillStyle = '#d9713a';
    for (let i = 0; i < 18; i++) {
      ctx.rotate(Math.PI / 9);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(S * 0.6, -S * 0.04); ctx.lineTo(S * 0.6, S * 0.04); ctx.fill();
    }
    ctx.fillStyle = '#c8452c'; ctx.beginPath(); ctx.arc(0, 0, S * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // skyline silhouette: domes, towers, a palm
    ctx.fillStyle = '#2a211c';
    ctx.fillRect(0, S * 0.56, S, S * 0.12);
    const dome = (x, w, h) => { ctx.beginPath(); ctx.ellipse(x, S * 0.56, w, h, 0, Math.PI, 0); ctx.fill(); };
    dome(S * 0.3, S * 0.09, S * 0.1); dome(S * 0.62, S * 0.06, S * 0.07);
    ctx.fillRect(S * 0.44, S * 0.34, S * 0.035, S * 0.25);
    ctx.fillRect(S * 0.78, S * 0.42, S * 0.06, S * 0.15);
    ctx.fillRect(S * 0.1, S * 0.46, S * 0.08, S * 0.12);
    ctx.lineWidth = S * 0.012; ctx.strokeStyle = '#2a211c';
    ctx.beginPath(); ctx.moveTo(S * 0.88, S * 0.57); ctx.quadraticCurveTo(S * 0.9, S * 0.45, S * 0.86, S * 0.36); ctx.stroke();
    for (const a of [-2.6, -2.0, -1.2, -0.5, 0.2]) {
      ctx.beginPath(); ctx.moveTo(S * 0.86, S * 0.36);
      ctx.quadraticCurveTo(S * (0.86 + Math.cos(a) * 0.06), S * (0.36 + Math.sin(a) * 0.06 - 0.02), S * (0.86 + Math.cos(a) * 0.11), S * (0.36 + Math.sin(a) * 0.08 + 0.03));
      ctx.stroke();
    }
    // title block
    ctx.fillStyle = '#1f3b4a';
    ctx.fillRect(0, S * 0.68, S, S * 0.32);
    ctx.fillStyle = '#efe3c6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const font = (w, px) => `${w} ${Math.round(px * S)}px "Arial Black", Impact, "DejaVu Sans", sans-serif`;
    ctx.font = font(900, 0.1); ctx.fillText('GRAND BAZAAR', S * 0.5, S * 0.77);
    ctx.font = font(700, 0.045); ctx.fillText('MUSIC · FOOD · NIGHT MARKET', S * 0.5, S * 0.86);
    ctx.fillStyle = '#d9713a'; ctx.font = font(800, 0.05); ctx.fillText('EVERY FRIDAY', S * 0.5, S * 0.93);
    ctx.fillStyle = '#1f3b4a'; ctx.font = font(800, 0.05); ctx.fillText('FESTIVAL 1987', S * 0.5, S * 0.08);
  },
  glsl: /* glsl */`
void surface(vec2 uv, inout Surf o) {
  vec3 print = pow(texture(uCanvas, uv).rgb, vec3(2.2));
  // sun fading: desaturate + lift, stronger towards the top
  float fade = 0.35 + 0.25 * uv.y + 0.15 * fbmU(uv, 3.0, 3, 0.5, 1.0);
  print = mix(print, vec3(luma(print)) * 1.1 + 0.08, sat(fade));
  // fold creases + wrinkles
  float fx = 1.0 - smoothstep(0.0, 0.006, abs(uv.x - 0.5));
  float fy = max(1.0 - smoothstep(0.0, 0.006, abs(uv.y - 0.333)), 1.0 - smoothstep(0.0, 0.006, abs(uv.y - 0.667)));
  float wr = ridged(uv * 6.0, vec2(6.0), 3, 2.0);
  float stain = stainField(uv, 3.0, 3.0);
  // torn edges and missing corner
  vec2 d = min(uv, 1.0 - uv);
  float edge = min(d.x, d.y) + 0.012 * fbmU(uv, 12.0, 4, 0.6, 4.0) + 0.006 * gnU(uv, 80.0, 5.0);
  float torn = smoothstep(0.012, 0.016, edge);
  float corner = step(0.18, length(uv - vec2(1.0, 0.0)) + 0.03 * fbmU(uv, 16.0, 3, 0.5, 6.0));
  o.alpha = torn * corner;
  o.h = 0.1 * pow(wr, 4.0) - 0.08 * (fx + fy);
  vec3 c = print * mix(vec3(1.0), vec3(0.82, 0.76, 0.66), stain * 0.6);
  c *= 1.0 - 0.18 * (fx + fy);
  c = mix(c, ${C('#e8dcc2')}, (1.0 - smoothstep(0.012, 0.03, edge)) * 0.5);   // white paper at tears
  o.col = c;
  o.rough = 0.85;
}
`,
};
