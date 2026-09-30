// Procedural prop textures + materials. Everything is generated lazily on first use from
// value noise (no DOM needed) except the stencil/label atlas, which uses a 2D canvas when one
// exists. All materials use vertex colours so props can tint/weather per plank.
//
// Texel conventions (so prop UVs can be authored in inches):
//   wood atlases : 1024 px along the grain = 128u, 8 strips of 128 px (16u) across.
//   tileables    : UV 1.0 = one tile; props scale their UVs per texture (see TILE below).
import * as THREE from 'three';

// ---- noise -----------------------------------------------------------------------------------
const LAT = new Float32Array(256 * 256);
{ let s = 1337; for (let i = 0; i < LAT.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; LAT[i] = s / 4294967296; } }
export function vn(x, y, px = 256, py = 256) {
  const xf = Math.floor(x), yf = Math.floor(y);
  let fx = x - xf, fy = y - yf;
  let x0 = xf % px; if (x0 < 0) x0 += px; let x1 = x0 + 1; if (x1 >= px) x1 = 0;
  let y0 = yf % py; if (y0 < 0) y0 += py; let y1 = y0 + 1; if (y1 >= py) y1 = 0;
  x0 &= 255; x1 &= 255; y0 = (y0 & 255) << 8; y1 = (y1 & 255) << 8;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = LAT[y0 + x0], b = LAT[y0 + x1], c = LAT[y1 + x0], d = LAT[y1 + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, oct, px = 256, py = 256) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vn(x, y, px, py); n += a; x *= 2; y *= 2; px *= 2; py *= 2; a *= 0.5; }
  return s / n;
}
const sm = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---- texture assembly --------------------------------------------------------------------------
function dataTex(data, W, H, srgb) {
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Run fill(x, y, o) per pixel; o = {r,g,b (sRGB 0..1), a, h (height), rough, metal}.
 * Returns { map, normalMap, roughMap } (rough in G, metal in B, like glTF ORM).
 */
function texSet(W, H, fill, { nStrength = 2.0, alpha = false, albedoOnly = false } = {}) {
  const alb = new Uint8Array(W * H * 4), orm = new Uint8Array(W * H * 4), hgt = new Float32Array(W * H);
  const o = { r: 0, g: 0, b: 0, a: 1, h: 0, rough: 0.8, metal: 0 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    o.a = 1; o.h = 0; o.rough = 0.8; o.metal = 0;
    fill(x, y, o);
    const i = y * W + x, j = i * 4;
    alb[j] = Math.max(0, Math.min(255, o.r * 255)); alb[j + 1] = Math.max(0, Math.min(255, o.g * 255));
    alb[j + 2] = Math.max(0, Math.min(255, o.b * 255)); alb[j + 3] = alpha ? Math.max(0, Math.min(255, o.a * 255)) : 255;
    orm[j] = 255; orm[j + 1] = Math.max(0, Math.min(255, o.rough * 255)); orm[j + 2] = Math.max(0, Math.min(255, o.metal * 255)); orm[j + 3] = 255;
    hgt[i] = o.h;
  }
  if (albedoOnly) return { map: dataTex(alb, W, H, true) };
  const map = alpha ? alphaMipTex(alb, W, H) : null;
  const nrm = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xl = (x - 1 + W) % W, xr = (x + 1) % W, yd = (y - 1 + H) % H, yu = (y + 1) % H;
    const dx = (hgt[y * W + xr] - hgt[y * W + xl]) * nStrength, dy = (hgt[yu * W + x] - hgt[yd * W + x]) * nStrength;
    const l = Math.hypot(dx, dy, 1), j = (y * W + x) * 4;
    nrm[j] = (-dx / l * 0.5 + 0.5) * 255; nrm[j + 1] = (-dy / l * 0.5 + 0.5) * 255; nrm[j + 2] = (1 / l * 0.5 + 0.5) * 255; nrm[j + 3] = 255;
  }
  return { map: map || dataTex(alb, W, H, true), normalMap: dataTex(nrm, W, H, false), roughMap: dataTex(orm, W, H, false) };
}

/** Albedo with a hand-built mip chain whose alpha keeps its coverage (foliage stays dense far away). */
function alphaMipTex(src, W, H) {
  const t = dataTex(src, W, H, true);
  const mips = [{ data: src, width: W, height: H }];
  let cur = src, w = W, h = H, level = 0;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4);
    level++;
    const boost = 1 + level * 0.35;
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy), j = (sy * w + sx) * 4;
        const aw = cur[j + 3] / 255 + 1e-3; // colour weighted by alpha so edges don't go dark
        r += cur[j] * aw; g += cur[j + 1] * aw; b += cur[j + 2] * aw; a += cur[j + 3]; wsum += aw;
      }
      const o = (y * nw + x) * 4;
      out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = Math.min(255, (a / 4) * boost);
    }
    mips.push({ data: out, width: nw, height: nh });
    cur = out; w = nw; h = nh;
  }
  t.mipmaps = mips;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---- wood atlases --------------------------------------------------------------------------------
const WOOD_W = 1024, WOOD_H = 1024, STRIPS = 8, STRIP_PX = 128;
export const WOOD = { W: WOOD_W, H: WOOD_H, STRIPS, STRIP_PX, PX_PER_UNIT: 8 };
let woodF = null;
function woodFields() {
  if (woodF) return woodF;
  const W = WOOD_W, H = WOOD_H, N = W * H;
  const late = new Float32Array(N), fib = new Float32Array(N), crack = new Float32Array(N), knot = new Float32Array(N), mot = new Float32Array(N), pore = new Float32Array(N);
  let seed = 91;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  // low-frequency terms on a 1/4-res grid (bilinear) — they dominate the cost otherwise
  const Q = 4, GW = W / Q + 1, GH = STRIP_PX / Q + 1;
  const gWarp = new Float32Array(GW * GH), gMot = new Float32Array(GW * GH), gCm = new Float32Array(GW * GH);
  const bil = (g, x, y) => {
    const fx = x / Q, fy = y / Q, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const i = y0 * GW + x0, a = g[i], b = g[i + 1], c = g[i + GW], d = g[i + GW + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  for (let s = 0; s < STRIPS; s++) {
    const ringPx = 9 + rnd() * 12, warpAmp = 0.5 + rnd() * 1.3, off = rnd() * 50;
    const knots = [];
    const nk = Math.floor(rnd() * 2.6);
    for (let k = 0; k < nk; k++) knots.push({ x: rnd() * W, y: 20 + rnd() * (STRIP_PX - 40), r: 3 + rnd() * 6 });
    const sy = s * 37;
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const X = (gx * Q) / W, y = gy * Q, j = gy * GW + gx;
      gWarp[j] = (fbm(X * 2, (y + sy * 3) / 90 + s * 5, 3, 2) - 0.5) * warpAmp * 4;
      gMot[j] = fbm(X * 10, y / 26 + s * 4, 3, 10);
      gCm[j] = sm(0.5, 0.72, vn(X * 5 + 13, y / 30 + s * 9, 5));
    }
    for (let y = 0; y < STRIP_PX; y++) {
      const Y = s * STRIP_PX + y;
      for (let x = 0; x < W; x++) {
        const X = x / W, i = Y * W + x;
        // flat-sawn: rings drift slowly along the board (cathedral arches), tiny wiggle
        let r = (y + off) / ringPx + bil(gWarp, x, y) + vn(X * 24, y / 8 + sy, 24) * 0.12;
        let kc = 0;
        for (const k of knots) {
          let dx = x - k.x; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
          const dy = y - k.y, d = Math.hypot(dx / 2.2, dy);
          if (d > k.r * 6) continue;
          const w = Math.exp(-(d * d) / (k.r * k.r * 6));
          r = r * (1 - w) + (Math.hypot(dx / 1.3, dy) / (ringPx * 0.45)) * w;
          kc = Math.max(kc, 1 - sm(k.r * 0.55, k.r * 1.05, Math.hypot(dx / 1.2, dy)));
        }
        const t = r - Math.floor(r);
        late[i] = sm(0.68, 0.86, t) * (1 - sm(0.9, 1.0, t));
        fib[i] = vn(X * 96, y * 0.55 + sy * 11, 96) - 0.5 + (vn(X * 256, y * 1.3 + sy * 5, 256) - 0.5) * 0.6;
        const c = vn(X * 7, (y + sy * 7) * 0.22, 7);
        crack[i] = (1 - sm(0.0, 0.028, Math.abs(c - 0.5))) * bil(gCm, x, y);
        knot[i] = kc;
        mot[i] = bil(gMot, x, y);
        pore[i] = sm(0.72, 0.8, vn(X * 512, y * 1.1 + sy, 512));
      }
    }
  }
  return (woodF = { late, fib, crack, knot, mot, pore });
}

let paintF = null;
function paintField() {
  if (paintF) return paintF;
  paintF = new Float32Array(WOOD_W * WOOD_H);
  for (let y = 0; y < WOOD_H; y++) for (let x = 0; x < WOOD_W; x++) paintF[y * WOOD_W + x] = fbm((x / WOOD_W) * 16, y / 18, 4, 16);
  return paintF;
}

const WOOD_PALETTES = {
  // sun-bleached crate pine (CS2 A-site crates are almost white-grey)
  crate: { E: [0.83, 0.79, 0.72], L: [0.63, 0.57, 0.49], G: [0.74, 0.73, 0.70], K: [0.42, 0.33, 0.25], weather: 0.55, crack: 0.55, rough: 0.82 },
  // darker, heavier weathered planks for doors, gates, beams
  door: { E: [0.66, 0.61, 0.54], L: [0.45, 0.40, 0.34], G: [0.66, 0.65, 0.62], K: [0.28, 0.22, 0.17], weather: 0.7, crack: 0.9, rough: 0.86 },
  // fresher tan timber (pallets, slat crates, ladders)
  tan: { E: [0.80, 0.66, 0.47], L: [0.60, 0.46, 0.30], G: [0.70, 0.66, 0.58], K: [0.40, 0.29, 0.19], weather: 0.3, crack: 0.45, rough: 0.8 },
};
export const PAINTS = {
  teal: [0.33, 0.60, 0.60], blue: [0.28, 0.43, 0.56], green: [0.31, 0.47, 0.35], red: [0.56, 0.24, 0.20],
  olive: [0.38, 0.40, 0.26], cream: [0.86, 0.82, 0.72], white: [0.86, 0.84, 0.79], grey: [0.58, 0.59, 0.58],
  sand: [0.74, 0.64, 0.47], orange: [0.72, 0.40, 0.18], yellow: [0.80, 0.66, 0.25], black: [0.12, 0.12, 0.12],
  bluegrey: [0.55, 0.64, 0.70], sky: [0.55, 0.70, 0.78], brown: [0.46, 0.32, 0.22],
};

function woodAtlas(pal, paint = null, cover = 0.5, albedoOnly = false) {
  const F = woodFields(), P = WOOD_PALETTES[pal];
  const W = WOOD_W;
  return texSet(WOOD_W, WOOD_H, (x, y, o) => {
    const i = y * W + x;
    const late = F.late[i], fib = F.fib[i], cr = F.crack[i] * P.crack, kn = F.knot[i], mo = F.mot[i], po = F.pore[i];
    const lt = late * 0.8 + fib * 0.17;
    let r = mix(P.E[0], P.L[0], lt), g = mix(P.E[1], P.L[1], lt), b = mix(P.E[2], P.L[2], lt);
    const w = P.weather * sm(0.35, 0.75, mo);
    r = mix(r, P.G[0], w); g = mix(g, P.G[1], w); b = mix(b, P.G[2], w);
    const dirt = 1 - 0.18 * sm(0.5, 0.9, mo) - po * 0.12;
    r *= dirt; g *= dirt; b *= dirt;
    r = mix(r, P.K[0], kn * 0.85); g = mix(g, P.K[1], kn * 0.85); b = mix(b, P.K[2], kn * 0.85);
    const cd = 1 - cr * 0.75; r *= cd; g *= cd; b *= cd;
    let h = late * 0.35 + fib * 0.22 - cr * 1.6 - po * 0.12 + kn * 0.2;
    let rough = P.rough + (1 - late) * 0.06 + cr * 0.1;
    if (paint) {
      // flaking paint that clings in streaks along the grain
      const th = 0.94 - cover;
      const pm = sm(th - 0.03, th + 0.03, paintField()[i] + (fib + 0.5) * 0.1 - late * 0.08);
      const fade = 0.8 + 0.2 * mo;
      r = mix(r, paint[0] * fade, pm); g = mix(g, paint[1] * fade, pm); b = mix(b, paint[2] * fade, pm);
      h += pm * 0.6; rough = mix(rough, 0.62, pm);
    }
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { nStrength: 0.9, albedoOnly });
}

// ---- tileable surfaces ------------------------------------------------------------------------------
// noise fields shared by every metal/paint texture (computed once)
let metalF = null;
function metalFields() {
  if (metalF) return metalF;
  const S = 512, N = S * S;
  const F = { big: new Float32Array(N), pit: new Float32Array(N), streak: new Float32Array(N), speck: new Float32Array(N), fine: new Float32Array(N), dust: new Float32Array(N), spang: new Float32Array(N) };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const X = x / S, Y = y / S, i = y * S + x;
    F.big[i] = fbm(X * 4, Y * 4, 5, 4, 4);
    F.pit[i] = vn(X * 128, Y * 128, 128, 128);
    F.streak[i] = fbm(X * 48, Y * 3, 3, 48, 3);
    F.speck[i] = sm(0.78, 0.86, vn(X * 256 + 9, Y * 256 + 3, 256, 256));
    F.fine[i] = fbm(X * 40 + 5, Y * 40, 3, 40, 40);
    F.dust[i] = fbm(X * 6 + 3, Y * 6, 3, 6, 6);
    F.spang[i] = vn(X * 40, Y * 40, 40, 40);
  }
  return (metalF = F);
}
function metalTex(kind, col, wear0 = 0.3, albedoOnly = false) {
  const S = 512, F = metalFields();
  return texSet(S, S, (x, y, o) => {
    const i = y * S + x;
    const big = F.big[i], pit = F.pit[i], streak = F.streak[i], speck = F.speck[i];
    let rust = sm(0.52, 0.66, big + streak * 0.18 - 0.05);
    let r, g, b, rough, metal = 0, h;
    const rc = mix(0.42, 0.30, pit), rg = mix(0.24, 0.16, pit), rb = mix(0.12, 0.08, pit);
    if (kind === 'iron') {
      const base = 0.46 + (big - 0.5) * 0.1 + (streak - 0.5) * 0.06;
      rust = sm(0.6, 0.74, big + streak * 0.2);
      r = mix(base, rc, rust); g = mix(base * 0.97, rg, rust); b = mix(base * 0.93, rb, rust);
      rough = mix(0.5, 0.92, rust) + speck * 0.05; metal = mix(0.25, 0.05, rust);
      h = rust * 0.6 + pit * 0.3 * rust + speck * 0.2;
    } else if (kind === 'galv') {
      // galvanised / zinc drum steel: mottled spangle, dust, a little rust bloom
      const spang = F.spang[i];
      const base = 0.78 + (spang - 0.5) * 0.08 + (big - 0.5) * 0.12;
      rust = sm(0.74, 0.86, big + streak * 0.15);
      r = mix(base * col[0], rc, rust * 0.8); g = mix(base * col[1], rg, rust * 0.8); b = mix(base * col[2], rb, rust * 0.8);
      const d = sm(0.4, 0.8, streak) * 0.12; r -= d; g -= d; b -= d;
      rough = 0.5 + big * 0.15 + rust * 0.3; metal = mix(0.2, 0.05, rust);
      h = spang * 0.1 + rust * 0.5 + pit * 0.2 * rust;
    } else {
      // painted steel: small chips (gated by a low-frequency wear mask) reveal rust,
      // vertical run streaks, sun fading and dust
      const wear = big;
      const fine = F.fine[i];
      const th = 0.86 - wear0 * 0.3 - (wear - 0.5) * 0.5;
      const chip = sm(th, th + 0.02, fine + (pit - 0.5) * 0.08);
      const edge = sm(th - 0.035, th, fine) - chip; // primer ring round chips
      const fade = 0.9 + 0.12 * (big - 0.5) + (streak - 0.5) * 0.1;
      r = col[0] * fade; g = col[1] * fade; b = col[2] * fade;
      const dust = sm(0.45, 0.8, F.dust[i]) * 0.12;
      r = mix(r, 0.72, dust); g = mix(g, 0.66, dust); b = mix(b, 0.56, dust);
      const run = sm(0.55, 0.75, streak) * sm(0.45, 0.7, wear) * 0.5 * wear0; // rust tears running down
      r = mix(r, 0.5, run * 0.5); g = mix(g, 0.36, run * 0.5); b = mix(b, 0.24, run * 0.5);
      r = mix(r, 0.62, edge * 0.5); g = mix(g, 0.6, edge * 0.5); b = mix(b, 0.56, edge * 0.5);
      r = mix(r, rc, chip); g = mix(g, rg, chip); b = mix(b, rb, chip);
      rough = mix(0.55 + dust, 0.9, chip); metal = 0;
      h = -chip * 0.6 - edge * 0.15 + pit * 0.06 + speck * 0.08;
    }
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough; o.metal = metal;
  }, { nStrength: 2.5, albedoOnly });
}

function clothTex(kind, col, col2) {
  const S = 512;
  return texSet(S, S, (x, y, o) => {
    const X = x / S, Y = y / S;
    const period = kind === 'burlap' ? 6 : 3;
    const wx = Math.sin((x / period) * Math.PI), wy = Math.sin((y / period) * Math.PI);
    const weave = (wx * wy) * 0.5 + 0.5;
    const thread = vn(X * 256, Y * 32, 256, 32) * 0.5 + vn(X * 32, Y * 256, 32, 256) * 0.5;
    const stain = fbm(X * 5, Y * 5, 4, 5, 5);
    let r = col[0], g = col[1], b = col[2];
    if (kind === 'stripe') {
      const st = Math.floor(X * 8) % 2 === 0;
      if (!st) { r = col2[0]; g = col2[1]; b = col2[2]; }
    }
    const f = 0.9 + (thread - 0.5) * (kind === 'burlap' ? 0.35 : 0.15) + (weave - 0.5) * 0.08;
    r *= f; g *= f; b *= f;
    const sd = sm(0.5, 0.8, stain) * 0.22, fade = sm(0.3, 0.6, fbm(X * 3 + 7, Y * 3, 3, 3, 3)) * 0.18;
    r = mix(r, 0.78, fade) - sd * 0.5; g = mix(g, 0.74, fade) - sd * 0.55; b = mix(b, 0.66, fade) - sd * 0.6;
    o.r = r; o.g = g; o.b = b; o.h = weave * 0.5 + thread * 0.4; o.rough = 0.92;
  }, { nStrength: kind === 'burlap' ? 3 : 1.5 });
}

function stoneTex(col, pores = 1) {
  const S = 512;
  return texSet(S, S, (x, y, o) => {
    const X = x / S, Y = y / S;
    const m = fbm(X * 6, Y * 6, 5, 6, 6), f = vn(X * 160, Y * 160, 160, 160), p = sm(0.84, 0.9, vn(X * 90 + 5, Y * 90, 90, 90)) * pores;
    const band = Math.sin((Y * 7 + m * 2) * Math.PI) * 0.03;
    const k = 0.9 + (m - 0.5) * 0.26 + (f - 0.5) * 0.06 + band - p * 0.1;
    o.r = col[0] * k; o.g = col[1] * k; o.b = col[2] * k;
    o.h = m * 0.6 + f * 0.12 - p * 0.3; o.rough = 0.9 - (1 - pores) * 0.15;
  }, { nStrength: 2 });
}

function rubberTex() {
  const W = 512, H = 256;
  return texSet(W, H, (x, y, o) => {
    const X = x / W, V = y / H;
    const tread = V > 0.3 && V < 0.7;
    let h = 0;
    if (tread) {
      // chevron blocks with a centre rib
      const u = X * 48 + Math.abs(V - 0.5) * 3;
      const g = Math.abs((u % 1) - 0.5) < 0.12;
      const rib = Math.abs(V - 0.5) < 0.03 || Math.abs(Math.abs(V - 0.5) - 0.12) < 0.012;
      h = g || rib ? -1 : 0;
    } else h = (vn(X * 64, V * 16, 64, 16) - 0.5) * 0.2;
    const dust = sm(0.45, 0.8, fbm(X * 8, V * 4, 3, 8, 4)) * 0.18 + (h < 0 ? 0.08 : 0);
    const base = 0.075 + (vn(X * 200, V * 100, 200, 100) - 0.5) * 0.02;
    o.r = mix(base, 0.55, dust); o.g = mix(base, 0.5, dust); o.b = mix(base, 0.42, dust);
    o.h = h; o.rough = 0.88 + dust * 0.1;
  }, { nStrength: 3 });
}

function ropeTex() {
  const W = 256, H = 64;
  return texSet(W, H, (x, y, o) => {
    const s = ((x / W) * 8 + (y / H) * 1) % 1;
    const strand = Math.abs(Math.sin(s * Math.PI));
    const fib = vn(x / 2, y / 8, 128, 8);
    const k = 0.55 + strand * 0.45 + (fib - 0.5) * 0.2;
    o.r = 0.64 * k; o.g = 0.55 * k; o.b = 0.4 * k; o.h = strand + fib * 0.3; o.rough = 0.95;
  }, { nStrength: 3 });
}

function glassTex() {
  const S = 256;
  return texSet(S, S, (x, y, o) => {
    const X = x / S, Y = y / S;
    const d = sm(0.35, 0.85, fbm(X * 4, Y * 4, 4, 4, 4) + (1 - Y) * 0.25);
    o.r = mix(0.05, 0.62, d * 0.8); o.g = mix(0.06, 0.58, d * 0.8); o.b = mix(0.07, 0.5, d * 0.8);
    o.rough = mix(0.08, 0.75, d); o.h = d * 0.2;
  }, { nStrength: 1 });
}

function frondTex(dead) {
  const W = 256, H = 512;
  return texSet(W, H, (x, y, o) => {
    const u = (x / W) * 2 - 1, v = y / H; // v: 0 base -> 1 tip
    const au = Math.abs(u);
    const maxLen = Math.sin(Math.min(1, v * 1.08) * Math.PI) * 0.95 * (0.3 + 0.7 * Math.min(1, v * 3));
    const n = 34;
    const phase = (v + au * 0.55) * n;
    const f = phase - Math.floor(phase);
    const wid = 0.3 * (1 - au / (maxLen + 0.001)) + 0.12;
    const jag = vn(Math.floor(phase) * 3.3, 1, 256) * 0.25;
    const leaf = au < maxLen * (1 - jag) && Math.abs(f - 0.5) < wid;
    const rib = au < 0.035 * (1 - v * 0.6) && v < 0.99;
    o.a = leaf || rib ? 1 : 0;
    const t = au / (maxLen + 0.01);
    const dry = dead ? 1 : sm(0.75, 1.0, t) * 0.8 + sm(0.8, 1, v) * 0.5;
    const shade = 0.85 + (f - 0.5) * 0.3;
    let r = mix(0.30, 0.62, dry) * shade, g = mix(0.44, 0.50, dry) * shade, b = mix(0.16, 0.30, dry) * shade;
    if (rib) { r = mix(0.55, 0.62, dry); g = mix(0.55, 0.52, dry); b = mix(0.28, 0.34, dry); }
    o.r = r; o.g = g; o.b = b; o.rough = 0.75; o.h = rib ? 1 : (leaf ? 0.5 - Math.abs(f - 0.5) : 0);
  }, { nStrength: 2, alpha: true });
}

// ---- label / stencil atlas (canvas) ----------------------------------------------------------------
// 2 cols x 4 rows of 512x256 cells. Names -> cell index.
export const LABELS = { num14: 0, num07: 1, arrows: 2, care: 3, stamp: 4, star: 5, hazard: 6, plate: 7 };
export function labelUV(name) {
  const i = LABELS[name] ?? 0, c = i % 2, r = Math.floor(i / 2);
  // canvas textures are flipped (row 0 at top -> v = 1)
  return { u0: c / 2, u1: (c + 1) / 2, v0: 1 - (r + 1) / 4, v1: 1 - r / 4 };
}
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
}
function labelAtlas() {
  const W = 1024, H = 1024, cv = makeCanvas(W, H);
  if (!cv) return null;
  const x = cv.getContext('2d');
  const ink = 'rgb(38,33,28)', red = 'rgb(150,44,34)';
  const cell = (i, fn) => { x.save(); x.translate((i % 2) * 512, Math.floor(i / 2) * 256); fn(); x.restore(); };
  const txt = (s, cx, cy, size, col, font = 'DejaVu Sans, Arial, sans-serif', weight = 'bold', stretch = 1) => {
    x.save(); x.translate(cx, cy); x.scale(stretch, 1);
    x.font = `${weight} ${size}px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 3; x.fillText(s, 0, 0); x.restore();
  };
  // stencil bridges: thin vertical cuts through big glyphs
  const bridges = (x0, y0, w, h, n) => {
    x.save(); x.globalCompositeOperation = 'destination-out';
    for (let k = 1; k < n; k++) x.fillRect(x0 + (w * k) / n - 2, y0, 4, h);
    x.restore();
  };
  const star = (cx, cy, R, col) => {
    x.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? R * 0.42 : R; x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    x.closePath(); x.fillStyle = col; x.fill();
  };
  cell(0, () => { txt('14', 256, 112, 180, ink, 'DejaVu Sans, sans-serif', 'bold', 0.95); bridges(256, 40, 6, 150, 2); txt('LOT 3-B', 256, 226, 30, ink); });
  cell(1, () => { txt('07', 200, 128, 180, ink, 'DejaVu Sans, sans-serif', 'bold', 0.95); bridges(200, 50, 6, 150, 2); star(410, 125, 60, red); });
  cell(2, () => {
    for (const cx of [190, 322]) { x.beginPath(); x.moveTo(cx, 30); x.lineTo(cx + 46, 90); x.lineTo(cx + 18, 90); x.lineTo(cx + 18, 150); x.lineTo(cx - 18, 150); x.lineTo(cx - 18, 90); x.lineTo(cx - 46, 90); x.closePath(); x.fillStyle = ink; x.fill(); }
    txt('HAUT  ·  TOP', 256, 200, 44, ink); x.fillStyle = ink; x.fillRect(90, 234, 332, 6);
  });
  cell(3, () => {
    x.strokeStyle = ink; x.lineWidth = 8; x.strokeRect(40, 28, 432, 200);
    x.beginPath(); x.moveTo(100, 60); x.lineTo(150, 60); x.lineTo(140, 120); x.quadraticCurveTo(125, 140, 110, 120); x.closePath(); x.fillStyle = ink; x.fill();
    x.fillRect(122, 128, 6, 50); x.fillRect(105, 176, 40, 6);
    txt('FRAGILE', 300, 100, 58, ink); txt('MANIPULER AVEC SOIN', 300, 170, 26, ink);
  });
  cell(4, () => {
    x.strokeStyle = red; x.lineWidth = 9; x.beginPath(); x.arc(256, 128, 104, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 4; x.beginPath(); x.arc(256, 128, 84, 0, Math.PI * 2); x.stroke();
    txt('S.T.C.', 256, 112, 60, red); txt('CASABLANCA', 256, 162, 24, red);
  });
  cell(5, () => { star(140, 128, 88, red); txt('EXPORT', 350, 104, 62, ink); txt('Nº 4417', 350, 170, 40, ink); });
  cell(6, () => {
    x.fillStyle = 'rgb(222,178,40)'; x.strokeStyle = 'rgb(20,18,16)'; x.lineWidth = 12;
    x.beginPath(); x.moveTo(256, 22); x.lineTo(386, 234); x.lineTo(126, 234); x.closePath(); x.fill(); x.stroke();
    x.beginPath(); x.moveTo(268, 70); x.lineTo(222, 160); x.lineTo(258, 160); x.lineTo(240, 214); x.lineTo(296, 128); x.lineTo(260, 128); x.lineTo(282, 70); x.closePath(); x.fillStyle = 'rgb(20,18,16)'; x.fill();
  });
  cell(7, () => {
    x.fillStyle = 'rgb(214,206,186)'; x.fillRect(16, 48, 480, 160); x.strokeStyle = 'rgb(30,30,30)'; x.lineWidth = 8; x.strokeRect(24, 56, 464, 144);
    txt('41 | ب | 2917', 256, 130, 76, 'rgb(25,25,25)', 'DejaVu Sans, sans-serif', 'bold', 0.85);
  });
  // weathering: erode paint (not the hazard sticker / plate) with noise
  const img = x.getImageData(0, 0, W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const j = (y * W + xx) * 4; if (!d[j + 3]) continue;
    const ci = Math.floor(xx / 512) + Math.floor(y / 256) * 2;
    const e = fbm(xx / 40, y / 40, 4) + (vn(xx / 3, y / 3) - 0.5) * 0.35;
    const k = ci >= 6 ? sm(0.2, 0.25, e) * 0.97 : sm(0.36, 0.52, e) * 0.9;
    d[j + 3] *= k;
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ---- materials -------------------------------------------------------------------------------------
const MATS = new Map();
const TEX = new Map();
const tex = (key, fn) => { if (!TEX.has(key)) TEX.set(key, fn()); return TEX.get(key); };

function std(set, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, ...extra });
  if (set) {
    m.map = set.map; m.normalMap = set.normalMap; m.roughnessMap = set.roughMap;
    if (extra.metalness > 0) m.metalnessMap = set.roughMap;
  }
  return m;
}

/** Material by key. Cached; safe to call often. */
export function material(key) {
  let m = MATS.get(key);
  if (m) return m;
  const [base, arg] = key.split(':');
  switch (base) {
    case 'wood': {
      // palettes share the crate atlas' normal + roughness maps; only albedo differs
      const full = tex('wood:crate', () => woodAtlas('crate'));
      const pal = arg || 'crate';
      m = std(pal === 'crate' ? full : { ...full, map: tex('wood:' + pal, () => woodAtlas(pal, null, 0, true)).map });
      break;
    }
    case 'woodpaint': {
      // colours with the same paint coverage share normal + roughness maps
      const cover = +(key.split(':')[2] || 0.5);
      const nr = tex('woodpaintNR:' + cover, () => woodAtlas('door', PAINTS.teal, cover));
      m = std({ ...nr, map: tex(key, () => woodAtlas('door', PAINTS[arg] || PAINTS.teal, cover, true)).map });
      break;
    }
    case 'iron': m = std(tex('iron', () => metalTex('iron')), { metalness: 1 }); break;
    case 'galv': m = std(tex(key, () => metalTex('galv', PAINTS[arg] || [1, 1, 1])), { metalness: 1 }); break;
    case 'paint': {
      const wear = +(key.split(':')[2] || 0.12);
      const nr = tex('paintNR:' + wear, () => metalTex('paint', PAINTS.grey, wear));
      m = std({ ...nr, map: tex(key, () => metalTex('paint', PAINTS[arg] || PAINTS.grey, wear, true)).map });
      break;
    }
    case 'canvas': m = std(tex(key, () => clothTex('canvas', PAINTS[arg] || PAINTS.teal)), { side: THREE.DoubleSide }); break;
    case 'awning': m = std(tex(key, () => clothTex('stripe', PAINTS[arg] || PAINTS.teal, PAINTS.cream)), { side: THREE.DoubleSide }); break;
    case 'burlap': m = std(tex('burlap', () => clothTex('burlap', [0.72, 0.64, 0.5]))); break;
    case 'stone': m = std(tex(key, () => stoneTex(arg === 'white' ? [0.86, 0.83, 0.77] : arg === 'clay' ? [0.80, 0.58, 0.43] : [0.82, 0.68, 0.50], arg === 'clay' ? 0.25 : 1))); break;
    case 'rubber': m = std(tex('rubber', rubberTex)); break;
    case 'rope': m = std(tex('rope', ropeTex)); break;
    case 'glass': m = std(tex('glass', glassTex), { roughness: 1 }); m.envMapIntensity = 1.5; break;
    case 'frond': m = std(tex('frond:' + (arg || ''), () => frondTex(arg === 'dead')), { side: THREE.DoubleSide, alphaTest: 0.35 }); break;
    case 'foliage': m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }); break;
    case 'plain': m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: arg ? +arg : 0.85 }); break;
    case 'seam': m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case 'bulb': m = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffd9a0, emissiveIntensity: 4, roughness: 0.3, vertexColors: true }); break;
    case 'label': {
      const t = tex('label', labelAtlas);
      m = new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 0.85, vertexColors: true,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, opacity: t ? 1 : 0 });
      break;
    }
    default: m = new THREE.MeshStandardMaterial({ color: 0xff00ff, vertexColors: true });
  }
  m.name = 'prop:' + key;
  MATS.set(key, m);
  return m;
}
/** Tint of a named paint (sRGB 0..1), for vertex-colour use. */
export const paintRGB = (n) => PAINTS[n] || PAINTS.grey;
