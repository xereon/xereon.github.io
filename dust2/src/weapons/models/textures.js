// Procedural PBR texture sets for weapons, hands and equipment (CONTRACT §13 viewmodel).
// Every set is generated from tileable noise fields into DataTextures and cached by recipe.
// UVs on weapon meshes are box-projected in inches, so a set covers `tile` inches.
import * as THREE from 'three';

const cache = new Map();

// ---- tileable value noise -----------------------------------------------------------------
function hash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ix0 = ((x0 % px) + px) % px, iy0 = ((y0 % py) + py) % py;
  const ix1 = (ix0 + 1) % px, iy1 = (iy0 + 1) % py;
  const a = hash(ix0, iy0, seed), b = hash(ix1, iy0, seed), c = hash(ix0, iy1, seed), d = hash(ix1, iy1, seed);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
// u,v in [0,1); fx,fy = base lattice frequency per tile (integers keep it seamless)
function fbm(u, v, fx, fy, oct, seed, gain = 0.5) {
  let s = 0, a = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise(u * fx, v * fy, fx, fy, seed + o * 17);
    n += a; a *= gain; fx *= 2; fy *= 2;
  }
  return s / n;
}
// Tileable cellular noise: returns [F1, F2] distances in cell units.
function worley(u, v, cells, seed) {
  const x = u * cells, y = v * cells;
  const cx = Math.floor(x), cy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const gx = cx + i, gy = cy + j;
    const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
    const px = gx + hash(wx, wy, seed), py = gy + hash(wx, wy, seed + 7);
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [f1, f2];
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---- texture assembly -----------------------------------------------------------------------
function dataTex(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Height field -> tangent-space normal map (OpenGL convention, rows = +v).
function heightToNormal(h, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (h[yc + xm] - h[yc + xp]) * strength;
      const dy = (h[ym + x] - h[yp + x]) * strength;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yc + x) * 4;
      out[i] = (dx * il * 0.5 + 0.5) * 255;
      out[i + 1] = (dy * il * 0.5 + 0.5) * 255;
      out[i + 2] = (il * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Runs a per-pixel recipe `fn(u, v, out)` that writes out.r,g,b (sRGB 0..1), out.rough,
 * out.metal, out.h (height 0..1), out.ao. Returns { map, normalMap, ormMap }.
 */
function generate(key, size, normalStrength, fn) {
  if (cache.has(key)) return cache.get(key);
  const N = size * size;
  const alb = new Uint8Array(N * 4), orm = new Uint8Array(N * 4), h = new Float32Array(N);
  const o = { r: 0, g: 0, b: 0, rough: 0.5, metal: 0, h: 0, ao: 1 };
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      o.ao = 1; o.h = 0;
      fn(u, v, o, x, y);
      const i = y * size + x, i4 = i * 4;
      alb[i4] = clamp01(o.r) * 255; alb[i4 + 1] = clamp01(o.g) * 255; alb[i4 + 2] = clamp01(o.b) * 255; alb[i4 + 3] = 255;
      orm[i4] = clamp01(o.ao) * 255; orm[i4 + 1] = clamp01(o.rough) * 255; orm[i4 + 2] = clamp01(o.metal) * 255; orm[i4 + 3] = 255;
      h[i] = o.h;
    }
  }
  const set = {
    map: dataTex(alb, size, true),
    ormMap: dataTex(orm, size, false),
    normalMap: dataTex(heightToNormal(h, size, normalStrength * size / 256), size, false),
  };
  cache.set(key, set);
  return set;
}

// Scratches: sparse thin lines baked into a Float32 field (0..1), tileable.
function scratchField(size, count, seed, maxLen = 0.25, dirBias = null) {
  const f = new Float32Array(size * size);
  let s = seed;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9E3779B9) | 0; return ((s >>> 0) % 100000) / 100000; };
  for (let k = 0; k < count; k++) {
    const x0 = rnd() * size, y0 = rnd() * size;
    const ang = dirBias != null ? dirBias + (rnd() - 0.5) * 0.5 : rnd() * Math.PI;
    const len = (0.02 + rnd() * maxLen) * size;
    const w = 0.35 + rnd() * 0.6;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const curve = (rnd() - 0.5) * 0.004;
    for (let t = 0; t < len; t += 0.5) {
      const a = t * curve;
      const px = x0 + (dx - dy * a) * t, py = y0 + (dy + dx * a) * t;
      const fade = Math.sin(Math.PI * t / len);
      const ix = Math.floor(px), iy = Math.floor(py);
      for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) {
        const cx = ix + i, cy = iy + j;
        const d = Math.hypot(cx - px, cy - py);
        const val = Math.max(0, 1 - d / (w + 0.5)) * fade * w;
        const id = (((cy % size) + size) % size) * size + (((cx % size) + size) % size);
        if (val > f[id]) f[id] = val;
      }
    }
  }
  return f;
}

// ---- recipes -----------------------------------------------------------------------------------
// Generic worked metal: mottling, oily smudges, micro grain, fine scratches.
export function metalSet({ key = 'metal', base = [0.23, 0.23, 0.24], rough = 0.45, metal = 0.8, var: vr = 0.18,
  smudge = 0.18, grain = 1, scratches = 90, size = 512 } = {}) {
  const k = `metal:${key}`;
  if (cache.has(k)) return cache.get(k);
  const sc = scratchField(size, scratches, 1234 + key.length * 77, 0.18);
  return generate(k, size, 2.2 * grain, (u, v, o, x, y) => {
    const mott = fbm(u, v, 4, 4, 5, 11);
    const fine = fbm(u, v, 48, 48, 3, 23);
    const sm = fbm(u, v, 3, 3, 4, 31);
    const pits = sstep(0.72, 0.85, fbm(u, v, 64, 64, 2, 41));
    const s = sc[y * size + x];
    const m = 1 + (mott - 0.5) * vr * 2 + (fine - 0.5) * 0.08 - pits * 0.1;
    o.r = base[0] * m + s * 0.18; o.g = base[1] * m + s * 0.18; o.b = base[2] * m + s * 0.18;
    o.rough = rough + (sm - 0.5) * smudge * 2 + (fine - 0.5) * 0.06 - s * 0.18 + pits * 0.08;
    o.metal = metal + s * 0.2;
    o.h = fine * 0.35 * grain - pits * 0.4 - s * 0.6;
  });
}

// Brushed stainless: long streaks along U.
export function brushedSet({ key = 'brushed', base = [0.68, 0.68, 0.67], rough = 0.3, size = 512 } = {}) {
  const k = `brushed:${key}`;
  if (cache.has(k)) return cache.get(k);
  const sc = scratchField(size, 60, 555, 0.2);
  return generate(k, size, 1.4, (u, v, o, x, y) => {
    const streak = fbm(u, v, 1, 180, 3, 5) * 0.6 + fbm(u, v, 2, 420, 2, 9) * 0.4;
    const mott = fbm(u, v, 3, 3, 4, 13);
    const s = sc[y * size + x];
    const m = 0.94 + (streak - 0.5) * 0.14 + (mott - 0.5) * 0.12;
    o.r = base[0] * m; o.g = base[1] * m; o.b = base[2] * m;
    o.rough = rough + (streak - 0.5) * 0.14 + (mott - 0.5) * 0.12 - s * 0.1;
    o.metal = 1;
    o.h = streak * 0.5 - s * 0.5;
  });
}

// Wood: grain runs along U. Laminated AK-style or oiled walnut.
export function woodSet({ key = 'wood', dark = [0.24, 0.08, 0.035], light = [0.52, 0.22, 0.09], rough = 0.42,
  rings = 22, lam = 0, size = 512 } = {}) {
  const k = `wood:${key}`;
  if (cache.has(k)) return cache.get(k);
  return generate(k, size, 2.4, (u, v, o) => {
    const warp = fbm(u, v, 2, 6, 4, 3) * 2.2 + fbm(u, v, 1, 2, 2, 8) * 1.5;
    const r = (v * rings + warp * 2.4);
    const ring = r - Math.floor(r);
    const late = sstep(0.0, 0.12, ring) * (1 - sstep(0.45, 0.95, ring));
    const fig = fbm(u, v, 3, 12, 4, 19);
    const pore = sstep(0.62, 0.8, fbm(u, v, 24, 220, 2, 27));
    const lamLine = lam ? sstep(0.8, 0.98, Math.abs(Math.sin(v * Math.PI * lam + fig * 0.6))) : 0;
    let t = 0.25 + late * 0.45 + (fig - 0.5) * 0.5 + lamLine * 0.2;
    t = clamp01(t);
    o.r = dark[0] + (light[0] - dark[0]) * t; o.g = dark[1] + (light[1] - dark[1]) * t; o.b = dark[2] + (light[2] - dark[2]) * t;
    const pd = 1 - pore * 0.35;
    o.r *= pd; o.g *= pd; o.b *= pd;
    o.rough = rough + pore * 0.25 + (1 - late) * 0.06;
    o.metal = 0;
    o.h = late * 0.35 - pore * 0.6 + fig * 0.1;
  });
}

// Moulded polymer with stipple texture (grips), or smooth (`stip` 0).
export function polymerSet({ key = 'poly', base = [0.13, 0.13, 0.135], rough = 0.6, stip = 1, cells = 46, size = 512 } = {}) {
  const k = `poly:${key}`;
  if (cache.has(k)) return cache.get(k);
  const sc = scratchField(size, 40, 999 + cells, 0.12);
  return generate(k, size, 3.2 * Math.max(0.25, stip), (u, v, o, x, y) => {
    const [f1] = worley(u, v, cells, 71);
    const bump = stip ? Math.pow(clamp01(1 - f1 * 1.25), 1.5) : 0;
    const mott = fbm(u, v, 4, 4, 4, 29);
    const fine = fbm(u, v, 64, 64, 2, 33);
    const s = sc[y * size + x];
    const m = 1 + (mott - 0.5) * 0.18 + bump * 0.1 * stip;
    o.r = base[0] * m + s * 0.05; o.g = base[1] * m + s * 0.05; o.b = base[2] * m + s * 0.05;
    o.rough = rough + (mott - 0.5) * 0.14 - bump * 0.12 * stip + s * 0.1;
    o.metal = 0;
    o.h = bump * stip + fine * 0.15 - s * 0.4;
  });
}

// Painted / coated surface (grenades, AWP green, C4 wrapper): paint mottle, chips.
export function paintSet({ key = 'paint', base = [0.3, 0.33, 0.2], rough = 0.55, size = 256, orange = 0.6 } = {}) {
  const k = `paint:${key}`;
  if (cache.has(k)) return cache.get(k);
  return generate(k, size, 1.6, (u, v, o) => {
    const mott = fbm(u, v, 4, 4, 5, 51);
    const peel = fbm(u, v, 16, 16, 3, 53);
    const m = 1 + (mott - 0.5) * 0.22;
    o.r = base[0] * m; o.g = base[1] * m; o.b = base[2] * m;
    o.rough = rough + (mott - 0.5) * 0.16;
    o.metal = 0;
    o.h = peel * orange + mott * 0.2;
  });
}

// Woven fabric (sleeves, glove backs). `twill` biases the weave diagonally.
export function fabricSet({ key = 'fabric', base = [0.16, 0.17, 0.16], rough = 0.85, freq = 64, size = 512, camo = null } = {}) {
  const k = `fabric:${key}`;
  if (cache.has(k)) return cache.get(k);
  return generate(k, size, 2.6, (u, v, o) => {
    const fu = u * freq, fv = v * freq;
    const iu = Math.floor(fu), iv = Math.floor(fv);
    const tu = fu - iu, tv = fv - iv;
    const over = ((iu + iv) & 1) === 0;
    const a = Math.sin(Math.PI * tv), b = Math.sin(Math.PI * tu);
    const thread = over ? Math.max(a * 0.9, b * 0.55) : Math.max(b * 0.9, a * 0.55);
    const fiber = fbm(u, v, 128, 32, 2, 61);
    const mott = fbm(u, v, 3, 3, 4, 67);
    const wear = fbm(u, v, 6, 6, 3, 71);
    let c = base;
    if (camo) {
      const cm = fbm(u, v, 3, 3, 4, 91);
      c = cm < 0.42 ? camo[0] : cm < 0.56 ? camo[1] : camo[2];
    }
    const m = 0.82 + thread * 0.22 + (fiber - 0.5) * 0.12 + (mott - 0.5) * 0.18 + sstep(0.6, 0.8, wear) * 0.12;
    o.r = c[0] * m; o.g = c[1] * m; o.b = c[2] * m;
    o.rough = rough + (1 - thread) * 0.08;
    o.metal = 0;
    o.ao = 0.8 + thread * 0.2;
    o.h = thread * 0.8 + fiber * 0.2;
  });
}

// Pebbled leather.
export function leatherSet({ key = 'leather', base = [0.13, 0.11, 0.1], rough = 0.55, cells = 70, size = 512 } = {}) {
  const k = `leather:${key}`;
  if (cache.has(k)) return cache.get(k);
  return generate(k, size, 2.4, (u, v, o) => {
    const [f1, f2] = worley(u, v, cells, 81);
    const crease = sstep(0.0, 0.12, f2 - f1);
    const mott = fbm(u, v, 5, 5, 4, 83);
    const wear = sstep(0.55, 0.75, fbm(u, v, 8, 8, 3, 87));
    const m = 0.85 + crease * 0.18 + (mott - 0.5) * 0.25 + wear * 0.15;
    o.r = base[0] * m; o.g = base[1] * m; o.b = base[2] * m;
    o.rough = rough + (1 - crease) * 0.12 - wear * 0.12 + (mott - 0.5) * 0.1;
    o.metal = 0;
    o.h = crease * 0.7 + mott * 0.2;
  });
}

// Skin: pores, fine creases, blotchy redness.
export function skinSet({ key = 'skin', base = [0.62, 0.43, 0.33], rough = 0.55, size = 512 } = {}) {
  const k = `skin:${key}`;
  if (cache.has(k)) return cache.get(k);
  return generate(k, size, 1.6, (u, v, o) => {
    const pore = sstep(0.66, 0.82, fbm(u, v, 96, 96, 2, 91));
    const blot = fbm(u, v, 4, 4, 4, 93);
    const vein = sstep(0.48, 0.52, fbm(u, v, 3, 7, 3, 97));
    const cre = sstep(0.7, 0.9, fbm(u, v, 40, 6, 2, 99));
    o.r = base[0] * (0.94 + blot * 0.12) - pore * 0.03;
    o.g = base[1] * (0.95 + (1 - blot) * 0.08) - pore * 0.03 - vein * 0.01;
    o.b = base[2] * (0.95 + (1 - blot) * 0.1) - pore * 0.02 + vein * 0.01;
    o.rough = rough + pore * 0.12 - blot * 0.06 + cre * 0.05;
    o.metal = 0;
    o.h = -pore * 0.5 - cre * 0.4 + blot * 0.1;
  });
}

// Rubber / hard rubber with fine grain.
export function rubberSet({ key = 'rubber', base = [0.075, 0.075, 0.075], rough = 0.86, size = 256 } = {}) {
  return generate(`rubber:${key}`, size, 1.5, (u, v, o) => {
    const f = fbm(u, v, 32, 32, 3, 101);
    const m = fbm(u, v, 4, 4, 3, 103);
    o.r = base[0] * (0.9 + m * 0.2); o.g = base[1] * (0.9 + m * 0.2); o.b = base[2] * (0.9 + m * 0.2);
    o.rough = rough + (f - 0.5) * 0.1; o.metal = 0; o.h = f * 0.5;
  });
}

// Diamond knurl / checkering (deagle grip, knife handle, pistol backstraps).
export function knurlSet({ key = 'knurl', base = [0.12, 0.12, 0.12], rough = 0.55, freq = 24, metal = 0, size = 512 } = {}) {
  return generate(`knurl:${key}`, size, 3.5, (u, v, o) => {
    const a = u * freq + v * freq, b = u * freq - v * freq;
    const ta = Math.abs(a - Math.round(a)) * 2, tb = Math.abs(b - Math.round(b)) * 2;
    const hgt = Math.min(ta, tb);
    const mott = fbm(u, v, 4, 4, 3, 107);
    const m = 0.85 + hgt * 0.25 + (mott - 0.5) * 0.15;
    o.r = base[0] * m; o.g = base[1] * m; o.b = base[2] * m;
    o.rough = rough - hgt * 0.12 + (mott - 0.5) * 0.1;
    o.metal = metal;
    o.h = hgt;
  });
}

// Vertical ribs/grooves (AK bakelite grip), grooves vary along U.
export function ribSet({ key = 'ribs', base = [0.3, 0.1, 0.05], rough = 0.36, freq = 20, size = 256 } = {}) {
  return generate(`ribs:${key}`, size, 3, (u, v, o) => {
    const t = u * freq;
    const g = Math.abs(t - Math.round(t)) * 2;
    const rib = sstep(0.18, 0.5, g);
    const mott = fbm(u, v, 4, 4, 4, 113);
    const fine = fbm(u, v, 48, 48, 2, 117);
    const m = 0.8 + rib * 0.25 + (mott - 0.5) * 0.3;
    o.r = base[0] * m; o.g = base[1] * m; o.b = base[2] * m;
    o.rough = rough + (1 - rib) * 0.12 + (fine - 0.5) * 0.08;
    o.metal = 0;
    o.h = rib + fine * 0.1;
  });
}

// Tiny noise texture used by the edge-wear shader patch to break up the wear mask.
export function wearNoise() {
  if (cache.has('wearNoise')) return cache.get('wearNoise');
  const size = 256, d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = (y * size + x) * 4;
    const n = fbm(u, v, 8, 8, 5, 131, 0.6);
    const n2 = fbm(u, v, 32, 32, 3, 137);
    d[i] = clamp01(n * 0.75 + n2 * 0.25) * 255; d[i + 1] = n2 * 255; d[i + 2] = fbm(u, v, 3, 3, 3, 139) * 255; d[i + 3] = 255;
  }
  const t = dataTex(d, size, false);
  cache.set('wearNoise', t);
  return t;
}

// Small HDR "sunny courtyard" environment (equirect, float). Bright sky dome, warm sandy
// bounce, a few soft window/sky panels so metals catch readable highlights.
export function envTexture() {
  if (cache.has('env')) return cache.get('env');
  const W = 256, H = 128;
  const d = new Float32Array(W * H * 4);
  const sky = [0.55, 0.72, 1.05], hor = [1.25, 1.12, 0.95], gnd = [0.42, 0.3, 0.19], wall = [0.8, 0.62, 0.42];
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1); // 0 = bottom (theta = pi), 1 = top
    const el = (v - 0.5) * Math.PI; // elevation
    for (let x = 0; x < W; x++) {
      const u = x / W, az = u * Math.PI * 2;
      let r, g, b;
      if (el > 0) {
        const t = Math.pow(Math.sin(el), 0.6);
        r = hor[0] + (sky[0] - hor[0]) * t; g = hor[1] + (sky[1] - hor[1]) * t; b = hor[2] + (sky[2] - hor[2]) * t;
        // sandstone walls rising around the horizon (dust2 courtyard feel)
        const wallH = 0.18 + 0.12 * fbm(u, 0.5, 6, 1, 3, 141);
        if (el < wallH) { const k = 0.75 + 0.25 * fbm(u, v, 16, 8, 3, 143); r = wall[0] * k; g = wall[1] * k; b = wall[2] * k; }
      } else {
        const t = Math.pow(-Math.sin(el), 0.5);
        r = wall[0] + (gnd[0] - wall[0]) * t; g = wall[1] + (gnd[1] - wall[1]) * t; b = wall[2] + (gnd[2] - wall[2]) * t;
      }
      // soft sky panels (key highlights)
      const panel = (azc, elc, w, h, k) => {
        const da = Math.abs(((az - azc + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const e = Math.abs(el - elc);
        const f = sstep(w, w * 0.6, da) * sstep(h, h * 0.6, e);
        r += f * k; g += f * k * 0.97; b += f * k * 0.9;
      };
      panel(Math.PI * 0.5, 0.95, 0.5, 0.35, 3.5);   // overhead-front
      panel(Math.PI * 1.15, 0.55, 0.3, 0.25, 2.2);  // right
      panel(Math.PI * 0.1, 0.45, 0.22, 0.2, 1.6);   // left
      // sun
      const sa = Math.abs(((az - 1.2 + Math.PI * 3) % (Math.PI * 2)) - Math.PI), se = el - 0.9;
      const sd = Math.hypot(sa * Math.cos(el), se);
      const sun = Math.exp(-sd * sd / 0.004) * 30 + Math.exp(-sd * sd / 0.05) * 1.5;
      r += sun; g += sun * 0.93; b += sun * 0.8;
      const i = (y * W + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  cache.set('env', t);
  return t;
}
