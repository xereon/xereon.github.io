// Texture-atlas baker for procedural characters.
//  1. packs the builder's UV islands (world-unit parameterisations) into one atlas,
//  2. bakes per-vertex ambient occlusion by ray-marching a voxelised copy of the bind pose,
//  3. rasterises every triangle into texel space and calls its part's paint function with
//     the interpolated bind-pose position / normal / island uv / AO,
//  4. derives a tangent-space normal map from the painted height field, dilates the islands,
//     and uploads albedo (sRGB), normal and ORM (R = AO, G = roughness, B = metalness).
import * as THREE from 'three';

// ---- noise ----------------------------------------------------------------------------------
const PERM = new Uint8Array(512);
{
  let s = 1337;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
/** 3D value noise in [-1, 1]. */
const HV = new Float32Array(512);
for (let i = 0; i < 512; i++) HV[i] = PERM[i] / 127.5 - 1;
export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const a = PERM[X] + Y, b = PERM[X + 1] + Y;
  const aa = PERM[a] + Z, ab = PERM[a + 1] + Z, ba = PERM[b] + Z, bb = PERM[b + 1] + Z;
  const x00 = HV[aa] + (HV[ba] - HV[aa]) * u, x10 = HV[ab] + (HV[bb] - HV[ab]) * u;
  const x01 = HV[aa + 1] + (HV[ba + 1] - HV[aa + 1]) * u, x11 = HV[ab + 1] + (HV[bb + 1] - HV[ab + 1]) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
export function fbm(x, y, z, oct = 3) {
  let a = 0.5, s = 0, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
export function hash2(x, y) {
  return PERM[(PERM[x & 255] + (y & 255)) & 511] / 255;
}
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export function hex(h) { return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; }
export function mix3(o, c, t) { o.r += (c[0] - o.r) * t; o.g += (c[1] - o.g) * t; o.b += (c[2] - o.b) * t; }
export function set3(o, c, k = 1) { o.r = c[0] * k; o.g = c[1] * k; o.b = c[2] * k; }

// ---- vertex AO -------------------------------------------------------------------------------
const GROUP_BITS = { core: 1, armL: 2, armR: 4, legL: 8, legR: 16, head: 32 };
const OCCLUDERS = { core: 1 | 8 | 16 | 32, head: 32 | 1, armL: 2, armR: 4, legL: 8 | 1, legR: 16 | 1 };

function* bakeVertexAO(mb, partOfVertex, out) {
  const P = mb.pos, nv = P.length / 3;
  const cs = 0.7;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < nv; k++) {
    const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2];
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
    if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
  }
  x0 -= 2; y0 -= 2; z0 -= 2;
  const nx = Math.ceil((x1 - x0 + 2) / cs) + 1, ny = Math.ceil((y1 - y0 + 2) / cs) + 1, nz = Math.ceil((z1 - z0 + 2) / cs) + 1;
  const grid = new Uint8Array(nx * ny * nz);
  const cell = (x, y, z) => {
    const i = ((x - x0) / cs) | 0, j = ((y - y0) / cs) | 0, k = ((z - z0) / cs) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return (k * ny + j) * nx + i;
  };
  const I = mb.idx;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const bit = GROUP_BITS[mb.parts[partOfVertex[a]].group] || 1;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const l = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
    const n = Math.max(1, Math.ceil(l / (cs * 0.7)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      const id = cell(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
      if (id >= 0) grid[id] |= bit;
    }
  }
  // fixed ray set: cosine-ish hemisphere in a local frame
  const RAYS = 18;
  const dirs = [];
  for (let k = 0; k < RAYS; k++) {
    const u = (k + 0.5) / RAYS, phi = k * 2.399963;
    const r = Math.sqrt(u);
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)]);
  }
  const ao = out;
  const N = mb.nrm;
  const maxD = 9, step = cs * 0.9;
  for (let k = 0; k < nv; k++) {
    if ((k & 511) === 511) yield;
    const px = P[k * 3], py = P[k * 3 + 1], pz = P[k * 3 + 2];
    const qx = N[k * 3], qy = N[k * 3 + 1], qz = N[k * 3 + 2];
    // tangent frame
    let tx, ty, tz;
    if (Math.abs(qy) < 0.9) { tx = qz; ty = 0; tz = -qx; } else { tx = 0; ty = -qz; tz = qy; }
    let tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = qy * tz - qz * ty, by = qz * tx - qx * tz, bz = qx * ty - qy * tx;
    const mask = OCCLUDERS[mb.parts[partOfVertex[k]].group] ?? 1;
    let occ = 0;
    for (const d of dirs) {
      const dx = tx * d[0] + bx * d[1] + qx * d[2];
      const dy = ty * d[0] + by * d[1] + qy * d[2];
      const dz = tz * d[0] + bz * d[1] + qz * d[2];
      for (let s = 1.3; s < maxD; s += step) {
        const id = cell(px + dx * s, py + dy * s, pz + dz * s);
        if (id < 0) break;
        if (grid[id] & mask) { occ += 1 - (s / maxD) * 0.6; break; }
      }
    }
    // ground plane occlusion for the feet
    const g = py < 6 ? (1 - py / 6) * 0.35 * Math.max(0, -qy + 0.3) : 0;
    ao[k] = clamp01(1 - (occ / RAYS) * 1.15 - g);
  }
}

// ---- packing ---------------------------------------------------------------------------------
function packIslands(islands, size, pad) {
  let area = 0;
  const ts = (is) => is.part.data?.texScale || 1;
  for (const is of islands) area += (is.u1 - is.u0) * (is.v1 - is.v0) * ts(is) ** 2;
  let D = Math.sqrt((size * size * 0.62) / Math.max(1, area));
  for (let attempt = 0; attempt < 40; attempt++) {
    const rects = islands.map((is, k) => {
      const d = D * ts(is);
      let w = Math.ceil((is.u1 - is.u0) * d) + pad * 2, h = Math.ceil((is.v1 - is.v0) * d) + pad * 2;
      const rot = h > w;
      if (rot) [w, h] = [h, w];
      return { k, w, h, rot };
    }).sort((a, b) => b.h - a.h || b.w - a.w);
    let x = 0, y = 0, rowH = 0, ok = true;
    for (const r of rects) {
      if (r.w > size) { ok = false; break; }
      if (x + r.w > size) { x = 0; y += rowH; rowH = 0; }
      r.x = x; r.y = y; x += r.w; rowH = Math.max(rowH, r.h);
      if (y + r.h > size) { ok = false; break; }
    }
    if (ok) {
      for (const r of rects) Object.assign(islands[r.k], { ax: r.x + pad, ay: r.y + pad, rot: r.rot, D: D * ts(islands[r.k]) });
      return D;
    }
    D *= 0.96;
  }
  throw new Error('atlas pack failed');
}

/** Map island-local uv to atlas pixel coords. */
function toAtlas(is, u, v, out) {
  const lu = (u - is.u0) * is.D, lv = (v - is.v0) * is.D;
  if (is.rot) { out[0] = is.ax + lv; out[1] = is.ay + lu; }
  else { out[0] = is.ax + lu; out[1] = is.ay + lv; }
}

// ---- bake ------------------------------------------------------------------------------------
/**
 * Pack the islands and rewrite the builder's uvs into atlas space (keeps the island-local uvs
 * in mb.localUV for the painter). Cheap; call before building the geometry.
 */
export function layoutAtlas(mb, size = 1024) {
  packIslands(mb.islands, size, 3);
  mb.localUV = Float32Array.from(mb.uv);
  const layout = { size, islands: mb.islands, remap: (b) => remapUVs(b, mb.islands, size) };
  remapUVs(mb, mb.islands, size, mb.localUV);
  return layout;
}

/** Synchronous bake (node tests / tools). Returns { maps, raw, remap, islands }. */
export function bakeAtlas(mb, size = 1024, opts = {}) {
  const layout = mb.localUV ? { size, islands: mb.islands, remap: (b) => remapUVs(b, mb.islands, size) } : layoutAtlas(mb, size);
  const g = bakeSteps(mb, layout, opts);
  let r; while (!(r = g.next()).done);
  return { ...r.value, remap: layout.remap, islands: layout.islands };
}

/** Time-sliced bake: runs the generator in ~sliceMs chunks between frames. */
export function bakeAtlasAsync(mb, layout, opts = {}, sliceMs = 6) {
  const g = bakeSteps(mb, layout, opts);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        const t0 = now();
        let r;
        do { r = g.next(); } while (!r.done && now() - t0 < sliceMs);
        if (r.done) resolve(r.value); else setTimeout(run, 0);
      } catch (err) { reject(err); }
    };
    setTimeout(run, 0);
  });
}

/** Per-vertex colours from the paint functions (placeholder until the atlas is baked). */
export function vertexPaint(mb) {
  const nv = mb.pos.length / 3, col = new Float32Array(nv * 3);
  const UV = mb.localUV || mb.uv, P = mb.pos, NR = mb.nrm;
  const ctx = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, u: 0, v: 0, ao: 1, island: null, part: null, r: 0, g: 0, b: 0, rough: 0.8, metal: 0, h: 0, occ: 1 };
  for (const is of mb.islands) {
    ctx.island = is; ctx.part = is.part;
    for (let k = is.vStart; k < is.vEnd; k++) {
      ctx.x = P[k * 3]; ctx.y = P[k * 3 + 1]; ctx.z = P[k * 3 + 2];
      ctx.nx = NR[k * 3]; ctx.ny = NR[k * 3 + 1]; ctx.nz = NR[k * 3 + 2];
      ctx.u = UV[k * 2]; ctx.v = UV[k * 2 + 1];
      ctx.r = ctx.g = ctx.b = 0.5; ctx.h = 0; ctx.occ = 1;
      is.part.paint(ctx);
      col[k * 3] = Math.pow(clamp01(ctx.r), 2.2); col[k * 3 + 1] = Math.pow(clamp01(ctx.g), 2.2); col[k * 3 + 2] = Math.pow(clamp01(ctx.b), 2.2);
    }
  }
  return col;
}


const A = [0, 0], B = [0, 0], C = [0, 0];
function rasterTri(S, t, isIdx, is, paint) {
  const { P, NR, UV, I, vao, ctx, alb, rough, metal, hgt, aoT, owner, size } = S;
  const a = I[t], b = I[t + 1], c = I[t + 2];
  toAtlas(is, UV[a * 2], UV[a * 2 + 1], A);
  toAtlas(is, UV[b * 2], UV[b * 2 + 1], B);
  toAtlas(is, UV[c * 2], UV[c * 2 + 1], C);
  const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]) - 0.5));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(A[0], B[0], C[0]) + 0.5));
  const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]) - 0.5));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(A[1], B[1], C[1]) + 0.5));
  const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
  if (Math.abs(den) < 1e-9) return;
  const tol = -0.35 / Math.sqrt(Math.abs(den));
  for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
    const sx = px + 0.5, sy = py + 0.5;
    let wa = ((B[1] - C[1]) * (sx - C[0]) + (C[0] - B[0]) * (sy - C[1])) / den;
    let wb = ((C[1] - A[1]) * (sx - C[0]) + (A[0] - C[0]) * (sy - C[1])) / den;
    let wc = 1 - wa - wb;
    if (wa < tol || wb < tol || wc < tol) continue;
    const o = py * size + px;
    const inside = wa >= 0 && wb >= 0 && wc >= 0;
    if (owner[o] >= 0 && !inside) continue;
    if (!inside) { // clamp to the triangle for edge texels
      wa = Math.max(0, wa); wb = Math.max(0, wb); wc = Math.max(0, wc);
      const s = wa + wb + wc; wa /= s; wb /= s; wc /= s;
    }
    ctx.x = P[a * 3] * wa + P[b * 3] * wb + P[c * 3] * wc;
    ctx.y = P[a * 3 + 1] * wa + P[b * 3 + 1] * wb + P[c * 3 + 1] * wc;
    ctx.z = P[a * 3 + 2] * wa + P[b * 3 + 2] * wb + P[c * 3 + 2] * wc;
    let nx = NR[a * 3] * wa + NR[b * 3] * wb + NR[c * 3] * wc;
    let ny = NR[a * 3 + 1] * wa + NR[b * 3 + 1] * wb + NR[c * 3 + 1] * wc;
    let nz = NR[a * 3 + 2] * wa + NR[b * 3 + 2] * wb + NR[c * 3 + 2] * wc;
    const nl = Math.hypot(nx, ny, nz) || 1;
    ctx.nx = nx / nl; ctx.ny = ny / nl; ctx.nz = nz / nl;
    ctx.u = UV[a * 2] * wa + UV[b * 2] * wb + UV[c * 2] * wc;
    ctx.v = UV[a * 2 + 1] * wa + UV[b * 2 + 1] * wb + UV[c * 2 + 1] * wc;
    ctx.ao = vao[a] * wa + vao[b] * wb + vao[c] * wc;
    ctx.r = 0.5; ctx.g = 0.5; ctx.b = 0.5; ctx.rough = 0.8; ctx.metal = 0; ctx.h = 0; ctx.occ = 1;
    paint(ctx);
    alb[o * 3] = ctx.r; alb[o * 3 + 1] = ctx.g; alb[o * 3 + 2] = ctx.b;
    rough[o] = ctx.rough; metal[o] = ctx.metal; hgt[o] = ctx.h;
    aoT[o] = ctx.ao * ctx.occ; owner[o] = isIdx;
  }
}

function* bakeSteps(mb, layout, opts) {
  const size = layout.size;
  const islands = layout.islands;
  const nv = mb.pos.length / 3;
  const partOf = new Int16Array(nv);
  for (const is of islands) for (let k = is.vStart; k < is.vEnd; k++) partOf[k] = is.part.id;
  const vao = new Float32Array(nv).fill(1);
  if (opts.ao !== false) yield* bakeVertexAO(mb, partOf, vao);
  const N = size * size;
  const alb = new Float32Array(N * 3), rough = new Float32Array(N), metal = new Float32Array(N);
  const hgt = new Float32Array(N), aoT = new Float32Array(N), owner = new Int32Array(N).fill(-1);
  const P = mb.pos, NR = mb.nrm, UV = mb.localUV || mb.uv, I = mb.idx;
  const ctx = {
    x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, u: 0, v: 0, ao: 1, island: null, part: null,
    r: 0, g: 0, b: 0, rough: 0.8, metal: 0, h: 0, occ: 1,
  };
  const S = { P, NR, UV, I, vao, ctx, alb, rough, metal, hgt, aoT, owner, size };
  for (let isIdx = 0; isIdx < islands.length; isIdx++) {
    const is = islands[isIdx];
    ctx.island = is; ctx.part = is.part;
    const paint = is.part.paint;
    for (let t = is.iStart; t < is.iEnd; t += 3) {
      if (((t / 3) & 63) === 63) yield;
      rasterTri(S, t, isIdx, is, paint);
    }
  }
  yield;

  // normals from height (island-local differences), plus cavity darkening
  const nrmT = new Uint8Array(N * 4), albT = new Uint8Array(N * 4), ormT = new Uint8Array(N * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x === 0 && (y & 31) === 31) yield;
    const o = y * size + x, isl = owner[o];
    if (isl < 0) continue;
    const D = islands[isl].D;
    const hC = hgt[o];
    const hs = (xx, yy) => {
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) return hC;
      const q = yy * size + xx;
      return owner[q] === isl ? hgt[q] : hC;
    };
    const hL = hs(x - 1, y), hR = hs(x + 1, y), hD = hs(x, y - 1), hU = hs(x, y + 1);
    let gx = -(hR - hL) * D * 0.5, gy = -(hU - hD) * D * 0.5;
    const l = Math.hypot(gx, gy, 1);
    nrmT[o * 4] = ((gx / l) * 0.5 + 0.5) * 255;
    nrmT[o * 4 + 1] = ((gy / l) * 0.5 + 0.5) * 255;
    nrmT[o * 4 + 2] = ((1 / l) * 0.5 + 0.5) * 255;
    nrmT[o * 4 + 3] = 255;
    const lap = (hL + hR + hD + hU) * 0.25 - hC; // >0 in creases
    const cav = clamp01(1 - lap * D * 1.6);
    const ao = aoT[o] * (0.55 + 0.45 * cav);
    const albK = 0.8 + 0.2 * cav;
    albT[o * 4] = Math.round(clamp01(alb[o * 3] * albK) * 255);
    albT[o * 4 + 1] = Math.round(clamp01(alb[o * 3 + 1] * albK) * 255);
    albT[o * 4 + 2] = Math.round(clamp01(alb[o * 3 + 2] * albK) * 255);
    albT[o * 4 + 3] = 255;
    ormT[o * 4] = Math.round(clamp01(ao) * 255);
    ormT[o * 4 + 1] = Math.round(clamp01(rough[o]) * 255);
    ormT[o * 4 + 2] = Math.round(clamp01(metal[o]) * 255);
    ormT[o * 4 + 3] = 255;
  }
  yield;
  dilate([albT, nrmT, ormT], owner, size, 6);
  yield;

  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4; t.flipY = false;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const maps = { map: mk(albT, true), normalMap: mk(nrmT, false), ormMap: mk(ormT, false) };
  const raw = { albT, nrmT, ormT, size };
  return { maps, raw };
}

function remapUVs(b, ref, size, src = null) {
  const out = [0, 0];
  const S = src || b.uv;
  if (b.islands.length !== ref.length) throw new Error(`island mismatch ${b.islands.length} vs ${ref.length}`);
  b.islands.forEach((is, k) => {
    const r = ref[k];
    // normalise within its own extents, then place into the reference rect
    const su = (r.u1 - r.u0) / Math.max(1e-6, is.u1 - is.u0), sv = (r.v1 - r.v0) / Math.max(1e-6, is.v1 - is.v0);
    for (let q = is.vStart; q < is.vEnd; q++) {
      const u = r.u0 + (S[q * 2] - is.u0) * su, v = r.v0 + (S[q * 2 + 1] - is.v0) * sv;
      toAtlas(r, u, v, out);
      b.uv[q * 2] = out[0] / size; b.uv[q * 2 + 1] = out[1] / size;
    }
  });
}

function dilate(bufs, owner, size, iters) {
  // grow islands outward `iters` texels (average of filled neighbours), frontier based
  const filled = new Uint8Array(size * size);
  let front = [];
  for (let o = 0; o < filled.length; o++) if (owner[o] >= 0) filled[o] = 1;
  for (let o = 0; o < filled.length; o++) {
    if (filled[o]) continue;
    const x = o % size, y = (o / size) | 0;
    if ((x > 0 && filled[o - 1]) || (x < size - 1 && filled[o + 1]) || (y > 0 && filled[o - size]) || (y < size - 1 && filled[o + size])) front.push(o);
  }
  const acc = new Float32Array(12);
  for (let it = 0; it < iters && front.length; it++) {
    const done = [];
    for (const o of front) {
      if (filled[o]) continue;
      const x = o % size, y = (o / size) | 0;
      let cnt = 0; acc.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const q = yy * size + xx;
        if (filled[q] !== 1) continue;
        cnt++;
        for (let b = 0; b < 3; b++) { const B = bufs[b]; for (let c = 0; c < 4; c++) acc[b * 4 + c] += B[q * 4 + c]; }
      }
      if (!cnt) continue;
      for (let b = 0; b < 3; b++) for (let c = 0; c < 4; c++) bufs[b][o * 4 + c] = acc[b * 4 + c] / cnt;
      done.push(o);
    }
    for (const o of done) filled[o] = 2;
    const next = [];
    for (const o of done) {
      filled[o] = 1;
      const x = o % size, y = (o / size) | 0;
      if (x > 0 && !filled[o - 1]) next.push(o - 1);
      if (x < size - 1 && !filled[o + 1]) next.push(o + 1);
      if (y > 0 && !filled[o - size]) next.push(o - size);
      if (y < size - 1 && !filled[o + size]) next.push(o + size);
    }
    front = next;
  }
}

// ---- material presets --------------------------------------------------------------------------
// Each returns paint(ctx). Colours are sRGB triples; heights are world units (inches).

/** Seam / stitch helper: distance-to-line ridge. */
export function stitch(ctx, d, width = 0.06, depth = 0.012) {
  if (d < width * 3) {
    const k = Math.exp(-(d * d) / (width * width));
    ctx.h -= depth * k;
    return k;
  }
  return 0;
}

export function dustAmount(ctx, hTop = 16, k = 1) {
  // desert dust settles on the lower legs / boots and in creases
  const n = fbm(ctx.x * 0.3, ctx.y * 0.3, ctx.z * 0.3, 2);
  return clamp01((1 - ctx.y / hTop) * 0.9 * k + n * 0.3) * sstep(-0.2, 0.6, ctx.ny + 0.5);
}

const DUST = hex(0xb9a27c);

/** Plain woven cloth with optional pattern callback(ctx) that sets base colour. */
export function cloth(o) {
  const base = hex(o.color), dark = o.dark ? hex(o.dark) : null;
  const weave = o.weave ?? 1;
  return (ctx) => {
    if (o.pattern) o.pattern(ctx); else set3(ctx, base);
    // fabric mottling / fading
    const m = fbm(ctx.x * 0.45, ctx.y * 0.45, ctx.z * 0.45, 2);
    const k = 1 + m * (o.mottle ?? 0.12);
    ctx.r *= k; ctx.g *= k; ctx.b *= k;
    // fabric slubs: band-limited anisotropic noise (a real twill is far below texel size)
    ctx.h += vnoise(ctx.u * 2.6 * weave, ctx.v * 2.6 * weave, 0.5) * 0.006 + vnoise(ctx.u * 0.9, ctx.v * 3.5, 3.1) * 0.004;
    ctx.rough = 0.88 + m * 0.06;
    if (o.wrinkle) o.wrinkle(ctx);
    if (o.detail) o.detail(ctx);
    if (o.dust) { const d = dustAmount(ctx, o.dustTop ?? 18, o.dust); mix3(ctx, DUST, d * 0.55); }
    if (dark) mix3(ctx, dark, (1 - ctx.ao) * 0.3);
  };
}

/** Fabric creases in a band around a bending joint (d = signed distance from the band centre):
 *  sparse, irregular valleys that break up along the circumference, not regular rings. */
export function folds(ctx, d, width, amp, freq = 1.3, seed = 0) {
  if (Math.abs(d) > width) return;
  const env = 0.5 + 0.5 * Math.cos((d / width) * Math.PI);
  const wob = vnoise(ctx.u * 0.45 + seed, d * 0.25, seed) * 1.4 + (ctx.u * 0.35) % 1 * 0.0;
  const k = (d + wob) * freq * 0.75;
  const f = k - Math.floor(k);
  const crease = Math.exp(-(((f - 0.5) / 0.11) ** 2));
  const broken = sstep(-0.35, 0.25, vnoise(ctx.u * 0.8 + seed * 3, Math.floor(k) * 1.7, seed));
  ctx.h += (0.35 * Math.sin(f * Math.PI) - crease) * amp * env * broken;
}

/** Nylon webbing / cordura. */
export function nylon(o) {
  const base = hex(o.color);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 0.6, ctx.y * 0.6, ctx.z * 0.6, 2);
    const k = 1 + m * 0.1; ctx.r *= k; ctx.g *= k; ctx.b *= k;
    // cordura texture (band-limited)
    ctx.h += vnoise(ctx.u * 3.2, ctx.v * 3.2, 1.7) * 0.004;
    ctx.rough = 0.8 + m * 0.08;
    if (o.detail) o.detail(ctx);
    if (o.dust) mix3(ctx, DUST, dustAmount(ctx, 20, o.dust) * 0.45);
  };
}

/** Hard matte polymer / painted shell. */
export function polymer(o) {
  const base = hex(o.color), wearC = hex(o.wearColor ?? 0x8a8676);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 0.8, ctx.y * 0.8, ctx.z * 0.8, 3);
    const k = 1 + m * (o.mottle ?? 0.08); ctx.r *= k; ctx.g *= k; ctx.b *= k;
    ctx.h += vnoise(ctx.x * 6, ctx.y * 6, ctx.z * 6) * (o.grain ?? 0.004); // texture paint grain
    ctx.rough = (o.rough ?? 0.6) + m * 0.1;
    // edge wear: lighter scuffs where fbm peaks
    const s = fbm(ctx.x * 1.7 + 9, ctx.y * 1.7, ctx.z * 1.7, 3);
    if (s > 0.35) { const w = sstep(0.35, 0.55, s) * (o.wear ?? 0.25); mix3(ctx, wearC, w); ctx.rough -= w * 0.15; }
    if (o.detail) o.detail(ctx);
  };
}

/** Leather (boots, gloves). */
export function leather(o) {
  const base = hex(o.color);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 0.9, ctx.y * 0.9, ctx.z * 0.9, 3);
    const k = 1 + m * 0.18; ctx.r *= k; ctx.g *= k; ctx.b *= k;
    const g = vnoise(ctx.x * 9, ctx.y * 9, ctx.z * 9);
    ctx.h += g * 0.006;
    ctx.rough = (o.rough ?? 0.62) + m * 0.12 - Math.max(0, g) * 0.05;
    if (o.detail) o.detail(ctx);
    if (o.dust) mix3(ctx, DUST, dustAmount(ctx, 10, o.dust) * 0.5);
  };
}

export function skin(o) {
  const base = hex(o.color);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 1.2, ctx.y * 1.2, ctx.z * 1.2, 3);
    ctx.r *= 1 + m * 0.08; ctx.g *= 1 + m * 0.1; ctx.b *= 1 + m * 0.1;
    ctx.h += vnoise(ctx.x * 14, ctx.y * 14, ctx.z * 14) * 0.002;
    ctx.rough = 0.55 + m * 0.08;
    if (o.detail) o.detail(ctx);
  };
}

export function metal(o) {
  const base = hex(o.color);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 2, ctx.y * 2, ctx.z * 2, 2);
    ctx.rough = (o.rough ?? 0.45) + m * 0.1; ctx.metal = o.metal ?? 0.9;
    if (o.detail) o.detail(ctx);
  };
}

export function flat(color, rough = 0.8, metalness = 0) {
  const base = hex(color);
  return (ctx) => { set3(ctx, base); ctx.rough = rough; ctx.metal = metalness; };
}
