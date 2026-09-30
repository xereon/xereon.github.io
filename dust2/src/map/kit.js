// Map build kit. Hammer-style authoring in SOURCE coordinates (x east, y north, z up) that
// emits both merged render geometry (one mesh per material, world-space UVs, vertex-colour
// grime) and matching brush collision. See CONTRACT.md §1/§3/§6.
//
// The main primitive is a floor REGION: a polygon of walkable floor with per-vertex heights.
// After every region is declared, finish() works out which region edges are shared with a
// neighbouring region (open passage / ledge / step) and which are bare (wall). Walls, ledge
// faces, lintels over low-ceilinged passages, arches, trims and wall-end caps are generated
// from that, so the walkable space defines the map exactly like the radar does.
import * as THREE from 'three';
import { CollisionWorld, CONTENTS_SOLID, CONTENTS_PLAYERCLIP, CONTENTS_GRATE } from '../player/collision.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- deterministic value noise (for large-scale colour variation) -------------------------
function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}
export const noise = (x, y, z) => vnoise(x, y, z) * 0.65 + vnoise(x * 2.3 + 17, y * 2.3 + 5, z * 2.3 + 9) * 0.35;

// Painted variants of base materials: 'plaster_wall#ochre' etc.
export const PAINT = {
  ochre: 0xd9b26e, teal: 0x86aca4, white: 0xfbf6ec, warm: 0xf6e3c4, cream: 0xf3e6cc,
  sand: 0xe9cf9f, pink: 0xf0d6c8, grey: 0xd8d4cc, dark: 0xb8ab94, blue: 0x8fb0c2,
  green: 0x93ad95, red: 0xb5584a, rust: 0xa5703f, cool: 0xe6e6e2,
};
// Fallback world units per texture repeat (TextureLib.info(key).world wins when present).
const TEX_WORLD = {
  sand_floor: 256, sand_blend: 256, gravel: 192, concrete_wall: 256, concrete_floor: 256,
  plaster_wall: 256, plaster_trim: 128, brick_tan: 128, brick_red: 128, stone_block: 128,
  stone_wall: 192, rubble: 128, wood_planks: 128, wood_crate: 64, wood_door: 128,
  metal_door: 128, metal_grate: 64, metal_beam: 64, metal_barrel: 64, tile_floor: 128,
  tile_wall: 128, cloth_awning: 128, cloth_tarp: 128, rope: 32, sandbag: 64, arch_stone: 128,
  roof_tile: 128, window_frame: 64, glass: 128, poster: 128, crate_label: 64,
};
const SURF_OF = {
  sand_floor: 'sand', sand_blend: 'sand', gravel: 'gravel', concrete_wall: 'concrete',
  concrete_floor: 'concrete', plaster_wall: 'plaster', plaster_trim: 'plaster', brick_tan: 'brick',
  brick_red: 'brick', stone_block: 'rock', stone_wall: 'rock', rubble: 'rock', wood_planks: 'wood',
  wood_crate: 'crate', wood_door: 'wood', metal_door: 'metaldoor', metal_grate: 'metalgrate',
  metal_beam: 'metal', metal_barrel: 'metal', tile_floor: 'tile', tile_wall: 'tile',
  cloth_awning: 'cloth', cloth_tarp: 'cloth', sandbag: 'sand', arch_stone: 'rock', roof_tile: 'tile',
  window_frame: 'wood', glass: 'glass', poster: 'plaster', crate_label: 'crate',
};
const FALLBACK_COL = {
  sand_floor: 0xcbb285, sand_blend: 0xc4a97a, gravel: 0xa99a82, concrete_floor: 0xa89c88, plaster_wall: 0xe2d6bf,
  plaster_trim: 0xd8c9ad, stone_block: 0xc2ad86, stone_wall: 0xc9a979, wood_planks: 0x8a6440, wood_crate: 0x9b7447,
  wood_door: 0x7a5534, metal_door: 0x5b6f78, tile_floor: 0xbfae92, arch_stone: 0xcab790, cloth_tarp: 0x5f8f8a,
  metal_barrel: 0x3f5a6a, glass: 0x88a0a8,
};
export const surfOf = (mat) => SURF_OF[String(mat).split('#')[0]] || 'default';

// ---- geometry buckets (one per material spec) ----------------------------------------------
class Bucket {
  constructor(spec) { this.spec = spec; this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.idx = []; this.n = 0; }
  // Source-space vertex in, Three-space out.
  v(x, y, z, nx, ny, nz, u, v, c) {
    this.pos.push(x, z, -y); this.nrm.push(nx, nz, -ny); this.uv.push(u, v);
    if (typeof c === 'number') this.col.push(c, c, c); else this.col.push(c[0], c[1], c[2]);
    return this.n++;
  }
}

function newell(P) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
const area2 = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };

export class Kit {
  constructor({ textures = null, props = null, bottom = -512 } = {}) {
    this.T = textures;
    this.P = props;
    this.bottom = bottom;
    this.col = new CollisionWorld();
    this.buckets = new Map();
    this.regions = [];
    this.byId = new Map();
    this.walkTris = [];            // Source-space triangles [x,y,z]*3 for nav
    this.walls = [];               // wall records for end caps / debug
    this.propRoot = new THREE.Group();
    this.propRoot.name = 'props';
    this.stats = { brushes: 0, regions: 0, props: 0, propFallbacks: 0 };
    this.decorators = [];
    this.roofDecorators = [];
  }

  // ---------------------------------------------------------------------------- materials
  texWorld(spec) {
    const key = String(spec).split('#')[0];
    return this.T?.info?.(key)?.world || TEX_WORLD[key] || 256;
  }
  bucket(spec) {
    let b = this.buckets.get(spec);
    if (!b) { b = new Bucket(spec); this.buckets.set(spec, b); }
    return b;
  }
  material(spec) {
    // Own instance per spec (a near-white tint makes TextureLib hand back a separate cached
    // material) so vertexColors can be enabled without touching materials other modules share.
    const [key, variant] = String(spec).split('#');
    const T = this.T;
    const tint = variant && PAINT[variant] != null ? PAINT[variant] : 0xfffffe;
    let m = null;
    try { m = T?.material?.(key, { tint }) || null; } catch { m = null; }
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: FALLBACK_COL[key] ?? 0xc8b48a, roughness: 0.9 });
      if (variant && PAINT[variant] != null) m.color.multiply(new THREE.Color(PAINT[variant]));
    }
    m.vertexColors = true;
    m.needsUpdate = true;
    return m;
  }

  // ---------------------------------------------------------------------------- emission
  /** Convex planar polygon. P = [[x,y,z]...] CCW seen from the front. */
  poly(mat, P, { uv = null, col = 1, normal = null } = {}) {
    if (P.length < 3) return;
    const n = normal || newell(P);
    const B = this.bucket(mat);
    const S = this.texWorld(mat);
    const base = B.n;
    for (const p of P) {
      const t = uv ? uv(p, n, S) : boxUV(p, n, S);
      const c = typeof col === 'function' ? col(p, n) : col;
      B.v(p[0], p[1], p[2], n[0], n[1], n[2], t[0], t[1], c);
    }
    for (let i = 1; i < P.length - 1; i++) B.idx.push(base, base + i, base + i + 1);
  }
  /** Quad a,b,c,d CCW from the front with explicit uvs/colours. */
  quad(mat, a, b, c, d, ua, ub, uc, ud, ca = 1, cb = ca, cc = ca, cd = ca, normal = null) {
    const nw = newell([a, b, c, d]);
    const n = normal || nw;
    if (normal && nw[0] * n[0] + nw[1] * n[1] + nw[2] * n[2] < 0) {
      // winding disagrees with the intended facing: flip so the face is front-facing along `normal`
      [b, d] = [d, b]; [ub, ud] = [ud, ub]; [cb, cd] = [cd, cb];
    }
    const B = this.bucket(mat);
    const i0 = B.v(a[0], a[1], a[2], n[0], n[1], n[2], ua[0], ua[1], ca);
    const i1 = B.v(b[0], b[1], b[2], n[0], n[1], n[2], ub[0], ub[1], cb);
    const i2 = B.v(c[0], c[1], c[2], n[0], n[1], n[2], uc[0], uc[1], cc);
    const i3 = B.v(d[0], d[1], d[2], n[0], n[1], n[2], ud[0], ud[1], cd);
    B.idx.push(i0, i1, i2, i0, i2, i3);
  }
  tri(mat, a, b, c, { uv = null, col = 1 } = {}) { this.poly(mat, [a, b, c], { uv, col }); }

  // ---------------------------------------------------------------------------- collision
  /** planes: [{n:[x,y,z], d}] Source space, inside when n·p <= d. */
  brush(planes, surf = 'default', flags = CONTENTS_SOLID) {
    const ps = planes.map(({ n, d }) => ({ n: new THREE.Vector3(n[0], n[2], -n[1]), d: -d }));
    const id = this.col.addBrush(ps, surf, flags);
    if (id >= 0) this.stats.brushes++;
    return id;
  }
  colBox(min, max, surf = 'default', flags = CONTENTS_SOLID) {
    const id = this.col.addBox(new THREE.Vector3(min[0], min[2], -max[1]), new THREE.Vector3(max[0], max[2], -min[1]), surf, flags);
    if (id >= 0) this.stats.brushes++;
    return id;
  }
  /** Convex 2D polygon [[x,y]...] extruded z0..z1. */
  colPrism(poly, z0, z1, surf = 'default', flags = CONTENTS_SOLID) {
    if (z1 - z0 < 0.05 || poly.length < 3) return -1;
    const id = this.col.addPrism(poly.map((p) => ({ x: p[0], z: -p[1] })), z0, z1, surf, flags);
    if (id >= 0) this.stats.brushes++;
    return id;
  }
  /** Brush under a (possibly sloped) convex floor polygon P=[[x,y,z]...] down to `bottom`. */
  colFloor(P, bottom, surf) {
    const n = newell(P);
    if (n[2] < 0) { P = P.slice().reverse(); n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
    if (n[2] < 0.05) return -1;
    const planes = [{ n, d: n[0] * P[0][0] + n[1] * P[0][1] + n[2] * P[0][2] }, { n: [0, 0, -1], d: -bottom }];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      let ex = b[0] - a[0], ey = b[1] - a[1];
      const l = Math.hypot(ex, ey); if (l < 1e-4) continue;
      ex /= l; ey /= l;
      const on = [ey, -ex, 0];   // outward for CCW
      planes.push({ n: on, d: on[0] * a[0] + on[1] * a[1] });
    }
    return this.brush(planes, surf);
  }

  // ---------------------------------------------------------------------------- solids
  /** Axis-aligned solid box (Source min/max). Renders all faces except the bottom. */
  box(min, max, mat = 'wood_crate', { surf = null, col = true, color = 1, bottomFace = false, flags = CONTENTS_SOLID, uvScale = null } = {}) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const c = (p) => color * (0.78 + 0.22 * smooth(z0, z0 + 24, p[2]));
    const uv = uvScale ? (p, n) => boxUV(p, n, uvScale) : null;
    this.poly(mat, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], { col: color * 1.02, uv });
    this.poly(mat, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], { col: c, uv });
    this.poly(mat, [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], { col: c, uv });
    this.poly(mat, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], { col: c, uv });
    this.poly(mat, [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], { col: c, uv });
    if (bottomFace) this.poly(mat, [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], { col: color * 0.6, uv });
    if (col) this.colBox(min, max, surf || surfOf(mat), flags);
  }
  /** Oriented box: base centre [x,y,z], size [sx,sy,h], yaw degrees (Source, CCW from east). */
  obox(c, size, yaw, mat = 'wood_crate', { surf = null, col = true, color = 1, flags = CONTENTS_SOLID, faces = null } = {}) {
    const [cx, cy, z0] = c, [sx, sy, h] = size, z1 = z0 + h;
    const a = yaw * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const P = [[-sx / 2, -sy / 2], [sx / 2, -sy / 2], [sx / 2, sy / 2], [-sx / 2, sy / 2]]
      .map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    this.prismSolid(P, z0, z1, mat, { surf, col, color, flags, faces });
  }
  /** Convex prism solid P=[[x,y]...] from z0 to z1 (all side faces + top). */
  prismSolid(P, z0, z1, mat, { surf = null, col = true, color = 1, flags = CONTENTS_SOLID, faces = null, topMat = null, bottomFace = false } = {}) {
    if (area2(P.map(([x, y]) => ({ x, y }))) < 0) P = P.slice().reverse();
    const cz = (p) => color * (0.8 + 0.2 * smooth(z0, z0 + 24, p[2]));
    if (!faces || faces.top !== false) this.poly(topMat || mat, P.map(([x, y]) => [x, y, z1]), { col: color });
    if (bottomFace) this.poly(mat, P.slice().reverse().map(([x, y]) => [x, y, z0]), { col: color * 0.6 });
    for (let i = 0; i < P.length; i++) {
      if (faces?.sides && !faces.sides[i]) continue;
      const a = P[i], b = P[(i + 1) % P.length];
      this.poly(mat, [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], { col: cz });
    }
    if (col) this.colPrism(P, z0, z1, surf || surfOf(mat), flags);
  }
  /** Free-standing wall slab from a to b (2D), thickness t centred on the line unless `side`. */
  slab(a, b, z0, z1, t, mat, opts = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const nx = dy / l, ny = -dx / l;   // right of a->b
    const s0 = opts.side === 'left' ? -t : opts.side === 'right' ? 0 : -t / 2;
    const s1 = s0 + t;
    const P = [[a[0] + nx * s0, a[1] + ny * s0], [b[0] + nx * s0, b[1] + ny * s0], [b[0] + nx * s1, b[1] + ny * s1], [a[0] + nx * s1, a[1] + ny * s1]];
    this.prismSolid(P, z0, z1, mat, opts);
  }
  /** Invisible player clip box (Source min/max). */
  clip(min, max) { this.colBox(min, max, 'default', CONTENTS_PLAYERCLIP); }

  // ---------------------------------------------------------------------------- regions
  /**
   * Walkable floor region. pts: [[x,y,z?]...] (z defaults to o.z). Options:
   *  mat, surf, z, top (absolute wall top), tops {edgeIdx|'n'|'s'|'e'|'w'|...: z},
   *  walls {edgeIdx|side: false}, wallMat, wallMats {edge|side: mat}, ceil, ceilTop, ceilMat,
   *  roof (render top of ceiling mass), arch {spring, crown}, bottom, riserMat, nav,
   *  paint {h, mat}, cap (bool), base {h,out,mat}|false, dark (0..1 extra occlusion), tint.
   */
  region(id, pts, o = {}) {
    const z0 = o.z ?? 0;
    let P = pts.map((p) => ({ x: p[0], y: p[1], z: p[2] ?? z0 }));
    // drop duplicate consecutive points
    P = P.filter((p, i) => { const q = P[(i + 1) % P.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 0.01; });
    const n = P.length;
    let reversed = false;
    if (area2(P) < 0) { P.reverse(); reversed = true; }
    const R = {
      id, pts: P, o, n, reversed,
      zmin: Math.min(...P.map((p) => p.z)), zmax: Math.max(...P.map((p) => p.z)),
      ceil: o.arch ? o.arch.crown : (o.ceil ?? null),
      bottom: o.bottom ?? this.bottom,
      minx: Math.min(...P.map((p) => p.x)), maxx: Math.max(...P.map((p) => p.x)),
      miny: Math.min(...P.map((p) => p.y)), maxy: Math.max(...P.map((p) => p.y)),
    };
    R.top = o.top ?? (R.ceil != null ? R.ceil : R.zmax + 256);
    if (this.byId.has(id)) throw new Error(`duplicate region id ${id}`);
    this.byId.set(id, R);
    this.regions.push(R);
    return R;
  }

  /** Straight stairs over quad [p0,p1,p2,p3] (p0p1 = bottom edge at z0, p3p2 = top edge at z1). */
  stairs(id, quad, z0, z1, steps, o = {}) {
    const [p0, p1, p2, p3] = quad;
    const rise = (z1 - z0) / steps;
    const treads = steps - 1;
    const L = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
    for (let k = 0; k < treads; k++) {
      const ta = k / treads, tb = (k + 1) / treads;
      const z = z0 + rise * (k + 1);
      this.region(`${id}_${k}`, [[...L(p0, p3, ta), z], [...L(p1, p2, ta), z], [...L(p1, p2, tb), z], [...L(p0, p3, tb), z]],
        { mat: 'stone_block', riserMat: 'stone_block', base: false, ...o, nav: false, stairOf: id });
    }
    // smooth ramp for nav + a player-clip ramp so movement glides over the steps
    const A = [...p0, z0], Bp = [...p1, z0], C = [...p2, z1], D = [...p3, z1];
    this.walkTris.push([A, Bp, C], [A, C, D]);
    if (o.clipRamp !== false) {
      const P = [A, Bp, C, D];
      const n = newell(P);
      if (n[2] < 0) P.reverse();
      this.colFloorClip(P, Math.min(z0, z1) - 2);
    }
  }
  colFloorClip(P, bottom) {
    const n = newell(P);
    const planes = [{ n, d: n[0] * P[0][0] + n[1] * P[0][1] + n[2] * P[0][2] }, { n: [0, 0, -1], d: -bottom }];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      let ex = b[0] - a[0], ey = b[1] - a[1]; const l = Math.hypot(ex, ey); if (l < 1e-4) continue;
      ex /= l; ey /= l; const on = [ey, -ex, 0];
      planes.push({ n: on, d: on[0] * a[0] + on[1] * a[1] });
    }
    return this.brush(planes, 'default', CONTENTS_PLAYERCLIP);
  }

  /** Curved stairs: annular sector around c from angle a0 to a1 (deg, Source), radii r0..r1. */
  curvedStairs(id, c, r0, r1, a0, a1, z0, z1, steps, o = {}) {
    const rise = (z1 - z0) / steps, treads = steps - 1;
    // radii may be [rx, ry] for elliptical wells
    const P = (r, a) => {
      const rx = Array.isArray(r) ? r[0] : r, ry = Array.isArray(r) ? r[1] : r;
      return [c[0] + rx * Math.cos(a * Math.PI / 180), c[1] + ry * Math.sin(a * Math.PI / 180)];
    };
    for (let k = 0; k < treads; k++) {
      const aa = lerp(a0, a1, k / treads), ab = lerp(a0, a1, (k + 1) / treads);
      const z = z0 + rise * (k + 1);
      const am = (aa + ab) / 2;
      const pts = [[...P(r0, aa), z], [...P(r1, aa), z], [...P(r1, am), z], [...P(r1, ab), z], [...P(r0, ab), z]];
      this.region(`${id}_${k}`, pts, { mat: 'stone_block', riserMat: 'stone_block', base: false, ...o, nav: false, stairOf: id });
      const za = z0 + rise * k, zb = z0 + rise * (k + 1);
      // nav + clip ramp per tread (smooth helix)
      const Q = [[...P(r0, aa), za], [...P(r1, aa), za], [...P(r1, ab), zb], [...P(r0, ab), zb]];
      const nq = newell(Q); if (nq[2] < 0) Q.reverse();
      this.walkTris.push([Q[0], Q[1], Q[2]], [Q[0], Q[2], Q[3]]);
      if (o.clipRamp !== false) this.colFloorClip(Q, Math.min(za, zb) - 2);
    }
  }

  // ---------------------------------------------------------------------------- finish
  finish() {
    this._edges();
    this._adjacency();
    for (const R of this.regions) this._autoCeilTop(R);
    for (const R of this.regions) this._emitRegion(R);
    this._endCaps();
    for (const fn of this.decorators) {
      try { fn(this, this.walls); } catch (err) { console.warn('[map] decorator failed:', err); }
    }
    if (this.roofs !== false) {
      this._roofs();
      for (const fn of this.roofDecorators) {
        try { fn(this, this.roofGrid); } catch (err) { console.warn('[map] roof decorator failed:', err); }
      }
    }
    return this._build();
  }

  _edgeKey(R, e) {
    const pick = (map) => {
      if (!map) return undefined;
      if (map[e.ai] !== undefined) return map[e.ai];
      if (map[e.side] !== undefined) return map[e.side];
      if (e.side.length === 2) { if (map[e.side[0]] !== undefined) return map[e.side[0]]; }
      return undefined;
    };
    return pick;
  }
  _edges() {
    for (const R of this.regions) {
      const P = R.pts, n = P.length;
      R.edges = [];
      let perim = 0;
      for (let k = 0; k < n; k++) {
        const a = P[k], b = P[(k + 1) % n];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        const ux = dx / len, uy = dy / len;
        const nx = uy, ny = -ux;          // outward (right of CCW edge)
        let side = '';
        if (ny > 0.38) side += 'n'; else if (ny < -0.38) side += 's';
        if (nx > 0.38) side += 'e'; else if (nx < -0.38) side += 'w';
        const ai = R.reversed ? ((n - 2 - k) % n + n) % n : k;
        R.edges.push({ R, k, a, b, len, ux, uy, nx, ny, side, ai, s0: perim, segs: [] });
        perim += len;
      }
      for (const e of R.edges) {
        const pick = this._edgeKey(R, e);
        e.top = pick(R.o.tops) ?? R.top;
        e.noWall = pick(R.o.walls) === false;
        e.wallMat = pick(R.o.wallMats) ?? R.o.wallMat ?? 'plaster_wall';
        e.paint = pick(R.o.paints) ?? R.o.paint ?? null;
        e.riserMat = pick(R.o.riserMats) ?? R.o.riserMat ?? null;
      }
    }
  }

  _adjacency() {
    const regs = this.regions;
    for (const R of regs) {
      for (const e of R.edges) {
        const cands = [];
        const exmin = Math.min(e.a.x, e.b.x) - 1, exmax = Math.max(e.a.x, e.b.x) + 1;
        const eymin = Math.min(e.a.y, e.b.y) - 1, eymax = Math.max(e.a.y, e.b.y) + 1;
        for (const N of regs) {
          if (N === R) continue;
          if (N.maxx < exmin || N.minx > exmax || N.maxy < eymin || N.miny > eymax) continue;
          const Rhi = R.ceil ?? Infinity, Nhi = N.ceil ?? Infinity;
          if (!(R.zmin < Nhi - 1 && N.zmin < Rhi - 1)) continue;
          for (const f of N.edges) {
            if (e.ux * f.ux + e.uy * f.uy > -0.999) continue;
            const d1 = e.ux * (f.a.y - e.a.y) - e.uy * (f.a.x - e.a.x);
            const d2 = e.ux * (f.b.y - e.a.y) - e.uy * (f.b.x - e.a.x);
            if (Math.abs(d1) > 0.75 || Math.abs(d2) > 0.75) continue;
            const ta = ((f.a.x - e.a.x) * e.ux + (f.a.y - e.a.y) * e.uy) / e.len;
            const tb = ((f.b.x - e.a.x) * e.ux + (f.b.y - e.a.y) * e.uy) / e.len;
            const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(1, Math.max(ta, tb));
            if ((t1 - t0) * e.len < 1) continue;
            cands.push({ t0, t1, N, f });
          }
        }
        const bps = [0, 1];
        for (const c of cands) bps.push(c.t0, c.t1);
        bps.sort((a, b) => a - b);
        const segs = [];
        for (let i = 0; i < bps.length - 1; i++) {
          const u0 = bps[i], u1 = bps[i + 1];
          if ((u1 - u0) * e.len < 0.5) continue;
          const um = (u0 + u1) / 2;
          const P = this._ptOn(e, um);
          let best = null, bestD = Infinity;
          for (const c of cands) {
            if (um < c.t0 || um > c.t1) continue;
            const zn = this._zOn(c.f, P.x, P.y);
            const d = Math.abs(zn - P.z);
            if (d < bestD) { bestD = d; best = c; }
          }
          const last = segs[segs.length - 1];
          if (last && last.N === (best?.N ?? null) && last.f === (best?.f ?? null)) last.u1 = u1;
          else segs.push({ u0, u1, N: best?.N ?? null, f: best?.f ?? null });
        }
        e.segs = segs;
      }
    }
  }
  _ptOn(e, u) { return { x: lerp(e.a.x, e.b.x, u), y: lerp(e.a.y, e.b.y, u), z: lerp(e.a.z, e.b.z, u) }; }
  _zOn(f, x, y) {
    const s = clamp(((x - f.a.x) * f.ux + (y - f.a.y) * f.uy) / f.len, 0, 1);
    return lerp(f.a.z, f.b.z, s);
  }

  _autoCeilTop(R) {
    if (R.ceil == null) return;
    if (R.o.ceilTop != null) { R.ceilTop = R.o.ceilTop; return; }
    let t = R.ceil + 24;
    for (const e of R.edges) for (const s of e.segs) {
      if (!s.N) continue;
      const N = s.N;
      if (N.ceil == null) t = Math.max(t, s.f.top);
      else if (N.ceil > R.ceil) t = Math.max(t, Math.min(N.ceil, R.ceil + 64));
    }
    R.ceilTop = t;
  }

  // wall colour: grime at the base, sun-bleach at the top, low-frequency mottling
  _wallCol(R, x, y, z, zf, top) {
    const h = z - zf, t = top - z;
    let c = 0.66 + 0.16 * smooth(0, 10, h) + 0.12 * smooth(8, 40, h) + 0.06 * smooth(36, 110, h);
    c *= 1 + 0.05 * (1 - smooth(0, 48, t));
    c *= 0.93 + 0.14 * noise(x / 260, y / 260, z / 190);
    if (R.ceil != null) c *= 0.82 * (1 - 0.25 * (1 - smooth(0, 40, R.ceil - z)));
    if (R.o.dark) c *= 1 - R.o.dark;
    const tint = R.o.tint;
    return tint ? [c * tint[0], c * tint[1], c * tint[2]] : c;
  }

  _emitRegion(R) {
    const o = R.o;
    const mat = o.mat ?? 'sand_floor';
    const surf = o.surf ?? surfOf(mat);
    // ---- floor
    const P = R.pts;
    const contour = P.map((p) => new THREE.Vector2(p.x, p.y));
    let tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const planar = isPlanar(P);
    const convex = isConvex(P);
    const fcol = (p) => {
      let c = 0.9 + 0.16 * noise(p[0] / 300, p[1] / 300, 3.7);
      if (R.ceil != null) c *= 0.85;
      if (o.dark) c *= 1 - o.dark;
      if (o.floorTint) return [c * o.floorTint[0], c * o.floorTint[1], c * o.floorTint[2]];
      return c;
    };
    const S = this.texWorld(mat);
    const fuv = (p) => [p[0] / S, p[1] / S];
    for (const t of tris) {
      let A = P[t[0]], B = P[t[1]], C = P[t[2]];
      if ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) < 0) { const tmp = B; B = C; C = tmp; }
      const tri = [[A.x, A.y, A.z], [B.x, B.y, B.z], [C.x, C.y, C.z]];
      if (!o.noFloor) this.poly(mat, tri, { uv: fuv, col: fcol });
      if (o.nav !== false) this.walkTris.push(tri);
      if (!(planar && convex)) this.colFloor(tri, R.bottom, surf);
    }
    if (planar && convex) this.colFloor(P.map((p) => [p.x, p.y, p.z]), R.bottom, surf);

    // ---- ceiling mass
    if (R.ceil != null && !o.arch) {
      const cmat = o.ceilMat ?? 'plaster_wall';
      const cS = this.texWorld(cmat);
      const cc = (p) => 0.55 * (0.9 + 0.2 * noise(p[0] / 200, p[1] / 200, 1.3)) * (1 - (o.dark || 0));
      for (const t of tris) {
        let A = P[t[0]], B = P[t[1]], C = P[t[2]];
        if ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0) { const tmp = B; B = C; C = tmp; }
        this.poly(cmat, [[A.x, A.y, R.ceil], [B.x, B.y, R.ceil], [C.x, C.y, R.ceil]], { uv: (p) => [p[0] / cS, -p[1] / cS], col: cc });
        if (o.roof !== false) {
          this.poly(o.roofMat ?? 'plaster_wall', [[C.x, C.y, R.ceilTop], [B.x, B.y, R.ceilTop], [A.x, A.y, R.ceilTop]], { col: 0.95 });
        }
        if (!convex) this.colPrism([[A.x, A.y], [B.x, B.y], [C.x, C.y]], R.ceil, R.ceilTop, surfOf(cmat));
      }
      if (convex) this.colPrism(P.map((p) => [p.x, p.y]), R.ceil, R.ceilTop, surfOf(cmat));
      if (o.beams) this._beams(R, o.beams);
    }
    if (o.arch) this._arch(R);

    // ---- edges
    for (const e of R.edges) {
      for (const s of e.segs) {
        if (!s.N) { if (!e.noWall) this._buildingWalls(R, e, s.u0, s.u1); continue; }
        const N = s.N;
        // ledge / riser face where the neighbour floor is higher
        this._riser(R, e, s, N);
        // lintel over a low-ceilinged passage opening into a taller space
        if (R.ceil != null && !o.arch && (N.ceil ?? Infinity) > R.ceil + 0.5) {
          const hTop = Math.min(R.ceilTop, N.ceil ?? Infinity);
          if (hTop > R.ceil + 0.5) this._header(R, e, s.u0, s.u1, R.ceil, hTop);
        }
      }
    }
  }

  _riser(R, e, s, N) {
    const A = this._ptOn(e, s.u0), B = this._ptOn(e, s.u1);
    const za = this._zOn(s.f, A.x, A.y), zb = this._zOn(s.f, B.x, B.y);
    if (za <= A.z + 0.5 && zb <= B.z + 0.5) return;
    const ta = Math.max(za, A.z), tb = Math.max(zb, B.z);
    const mat = e.riserMat ?? N.o.edgeMat ?? (N.o.stairOf ? 'stone_block' : 'stone_wall');
    const S = this.texWorld(mat);
    const u0 = -(e.s0 + s.u0 * e.len) / S, u1 = -(e.s0 + s.u1 * e.len) / S;
    const cA = (z) => this._wallCol(R, A.x, A.y, z, A.z, ta + 40), cB = (z) => this._wallCol(R, B.x, B.y, z, B.z, tb + 40);
    // inward normal
    const n = [-e.nx, -e.ny, 0];
    this.quad(mat, [A.x, A.y, A.z], [B.x, B.y, B.z], [B.x, B.y, tb], [A.x, A.y, ta],
      [u0, A.z / S], [u1, B.z / S], [u1, tb / S], [u0, ta / S], cA(A.z), cB(B.z), cB(tb) * 1.03, cA(ta) * 1.03, n);
  }

  _header(R, e, u0, u1, z0, z1) {
    const A = this._ptOn(e, u0), B = this._ptOn(e, u1);
    const mat = R.o.headerMat ?? e.wallMat;
    const S = this.texWorld(mat);
    const s0 = -(e.s0 + u0 * e.len) / S, s1 = -(e.s0 + u1 * e.len) / S;
    const n = [e.nx, e.ny, 0];
    const c0 = 0.8, c1 = 1;
    // faces outward (toward the taller neighbour): winding B->A seen from outside
    this.quad(mat, [B.x, B.y, z0], [A.x, A.y, z0], [A.x, A.y, z1], [B.x, B.y, z1],
      [s1, z0 / S], [s0, z0 / S], [s0, z1 / S], [s1, z1 / S], c0, c0, c1, c1, n);
    this.walls.push({ R, A: { x: A.x, y: A.y }, B: { x: B.x, y: B.y }, top: z1, zfA: z0, zfB: z0, nx: e.nx, ny: e.ny, cap: 0, header: true });
  }

  _clearance(R, A, B, e, maxT) {
    // distance along the outward normal before hitting another region's floor footprint
    let best = maxT;
    const samples = [0.02, 0.5, 0.98];
    for (const t of samples) {
      const px = lerp(A.x, B.x, t), py = lerp(A.y, B.y, t);
      for (const N of this.regions) {
        if (N === R) continue;
        if (N.maxx < Math.min(px, px + e.nx * maxT) - 1 || N.minx > Math.max(px, px + e.nx * maxT) + 1) continue;
        if (N.maxy < Math.min(py, py + e.ny * maxT) - 1 || N.miny > Math.max(py, py + e.ny * maxT) + 1) continue;
        for (const f of N.edges) {
          const d = raySeg(px, py, e.nx, e.ny, f.a.x, f.a.y, f.b.x, f.b.y);
          if (d > 0.3 && d < best) best = d;
        }
      }
    }
    return best;
  }

  /** Split long open-air walls into 'buildings' of different heights for a broken skyline. */
  _buildingWalls(R, e, u0, u1) {
    const len = e.len * (u1 - u0);
    const tall = e.top - Math.max(e.a.z, e.b.z);
    const vary = R.o.vary !== false && R.ceil == null && e.top === R.top && tall > 170 && len > 200;
    if (!vary) { this._wall(R, e, u0, u1); return; }
    const n = Math.max(1, Math.round(len / 250));
    const cuts = [u0];
    for (let i = 1; i < n; i++) cuts.push(u0 + (u1 - u0) * (i + (noise(e.a.x / 97 + i, e.a.y / 97, 5) - 0.5) * 0.5) / n);
    cuts.push(u1);
    const steps = [-32, 0, 0, 32, 64, 96];
    const tops = [];
    for (let i = 0; i < n; i++) {
      const P = this._ptOn(e, (cuts[i] + cuts[i + 1]) / 2);
      const k = Math.floor(noise(P.x / 173, P.y / 173, 11) * 6.999);
      tops.push(e.top + steps[Math.max(0, Math.min(5, k))]);
      this._wall(R, e, cuts[i], cuts[i + 1], tops[i]);
    }
    // shallow pilaster where one building meets the next
    const mat = e.wallMat;
    for (let i = 1; i < n; i++) {
      const P = this._ptOn(e, cuts[i]);
      const w = 12, d = 4;
      const a = [P.x - e.ux * w - e.nx * d, P.y - e.uy * w - e.ny * d], b = [P.x + e.ux * w - e.nx * d, P.y + e.uy * w - e.ny * d];
      this.slab(a, b, P.z - 2, Math.max(tops[i - 1], tops[i]) + 6, d * 2, mat, { col: false, color: 0.96 });
    }
  }

  _wall(R, e, u0, u1, topOverride = null) {
    const A = this._ptOn(e, u0), B = this._ptOn(e, u1);
    const eTop = topOverride ?? e.top;
    const wallTop = R.o.arch ? R.o.arch.spring : (R.ceil != null ? Math.min(eTop, R.ceil) : eTop);
    if (wallTop <= Math.min(A.z, B.z) + 0.5) return;
    const mat = e.wallMat;
    const S = this.texWorld(mat);
    const len = e.len * (u1 - u0);
    const cols = Math.max(1, Math.ceil(len / 128));
    const paint = e.paint;
    const cz = (p, zf) => this._wallCol(R, p.x, p.y, 0, zf, wallTop);
    for (let c = 0; c < cols; c++) {
      const ua = lerp(u0, u1, c / cols), ub = lerp(u0, u1, (c + 1) / cols);
      const a = this._ptOn(e, ua), b = this._ptOn(e, ub);
      const sa = -(e.s0 + ua * e.len) / S, sb = -(e.s0 + ub * e.len) / S;
      // band levels (relative to each end's floor, same count at both ends)
      const hmin = Math.min(wallTop - a.z, wallTop - b.z);
      const rel = [0, 8, 30, 80];
      const lv = [];
      for (const r of rel) if (r < hmin - 12) lv.push({ r, top: false });
      if (paint && paint.h < hmin - 4 && !rel.includes(paint.h)) lv.push({ r: paint.h, top: false });
      lv.sort((p, q) => p.r - q.r);
      const topRel = [-36, 0];
      for (const t of topRel) if (hmin + t > (lv.length ? lv[lv.length - 1].r + 6 : 0) || t === 0) lv.push({ r: t, top: true });
      const zA = (L) => (L.top ? wallTop + L.r : Math.min(a.z + L.r, wallTop));
      const zB = (L) => (L.top ? wallTop + L.r : Math.min(b.z + L.r, wallTop));
      for (let i = 0; i < lv.length - 1; i++) {
        const za0 = zA(lv[i]), za1 = zA(lv[i + 1]), zb0 = zB(lv[i]), zb1 = zB(lv[i + 1]);
        if (za1 - za0 < 0.1 && zb1 - zb0 < 0.1) continue;
        const inPaint = paint && !lv[i].top && lv[i].r < paint.h;
        const m = inPaint ? paint.mat : mat;
        const Sm = inPaint ? this.texWorld(m) : S;
        const k = Sm / S;
        const n = [-e.nx, -e.ny, 0];
        this.quad(m, [b.x, b.y, zb0], [a.x, a.y, za0], [a.x, a.y, za1], [b.x, b.y, zb1],
          [sb / k, zb0 / Sm], [sa / k, za0 / Sm], [sa / k, za1 / Sm], [sb / k, zb1 / Sm],
          this._wallCol(R, b.x, b.y, zb0, b.z, wallTop), this._wallCol(R, a.x, a.y, za0, a.z, wallTop),
          this._wallCol(R, a.x, a.y, za1, a.z, wallTop), this._wallCol(R, b.x, b.y, zb1, b.z, wallTop), n);
      }
    }
    // coping on top of open walls
    const capW = R.o.capW ?? 26;
    const T = this._clearance(R, A, B, e, R.o.thick ?? 64);
    const cw = Math.min(capW, T);
    if (R.ceil == null && R.o.cap !== false) {
      const cmat = R.o.capMat ?? mat;
      this.poly(cmat, [[A.x, A.y, wallTop], [A.x + e.nx * cw, A.y + e.ny * cw, wallTop], [B.x + e.nx * cw, B.y + e.ny * cw, wallTop], [B.x, B.y, wallTop]], { col: 0.97 });
    }
    // base trim (plinth) and top cornice
    const base = R.o.base === undefined ? (R.ceil == null ? { h: 10, out: 2.5, mat: 'stone_block' } : false) : R.o.base;
    if (base) this._trim(R, e, u0, u1, 'base', base);
    if (R.o.cornice && R.ceil == null) this._trim(R, e, u0, u1, 'cornice', { h: 8, out: 4, mat: 'plaster_trim', ...R.o.cornice }, wallTop);
    // collision
    const zc = R.ceil != null ? R.ceilTop : wallTop;
    const Tc = Math.max(2, T - 0.5);
    this.colPrism([[A.x, A.y], [B.x, B.y], [B.x + e.nx * Tc, B.y + e.ny * Tc], [A.x + e.nx * Tc, A.y + e.ny * Tc]], R.bottom, zc, surfOf(mat));
    if (R.o.merlons && R.ceil == null && wallTop - Math.max(A.z, B.z) > 120) this._merlons(R, e, A, B, wallTop, R.o.merlons);
    this.walls.push({ R, e, A: { x: A.x, y: A.y }, B: { x: B.x, y: B.y }, top: wallTop, seedTop: R.ceil != null ? R.ceilTop : wallTop, zfA: A.z, zfB: B.z, nx: e.nx, ny: e.ny, cap: cw, thick: T, mat });
  }

  _merlons(R, e, A, B, top, m) {
    // crenellation blocks along the coping (B site stone walls)
    const { w = 22, gap = 26, h = 18, mat = 'stone_block', d = 20 } = m === true ? {} : m;
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    const n = Math.floor((L - gap) / (w + gap));
    if (n < 1) return;
    const off = (L - (n * w + (n - 1) * gap)) / 2;
    for (let i = 0; i < n; i++) {
      const s0 = off + i * (w + gap), s1 = s0 + w;
      const p0 = [A.x + e.ux * s0, A.y + e.uy * s0], p1 = [A.x + e.ux * s1, A.y + e.uy * s1];
      this.slab(p0, p1, top, top + h * (0.8 + 0.4 * noise(p0[0] / 50, p0[1] / 50, 2)), d, mat, { col: false, color: 0.92, side: 'right' });
    }
  }

  _trim(R, e, u0, u1, kind, t, wallTop = 0) {
    if (t.alt && kind === 'base') {
      // alternating painted kerb (red / white) in fixed-length pieces
      const L = e.len * (u1 - u0);
      const n = Math.max(1, Math.round(L / t.alt.len));
      for (let i = 0; i < n; i++) {
        const a = u0 + (u1 - u0) * i / n, b = u0 + (u1 - u0) * (i + 1) / n;
        this._trim(R, e, a, b, kind, { ...t, alt: null, mat: t.alt.mats[i % t.alt.mats.length], _inner: [i > 0, i < n - 1] }, wallTop);
      }
      return;
    }
    // offset strip hugging the wall; mitred against neighbouring wall edges of the same region
    const prev = R.edges[(e.k - 1 + R.n) % R.n], next = R.edges[(e.k + 1) % R.n];
    const wallAt = (edge, atStart) => {
      const s = atStart ? edge.segs[0] : edge.segs[edge.segs.length - 1];
      return s && !s.N && !edge.noWall;
    };
    const miter = (ea, eb, P) => {
      // inward normals
      const m1x = -ea.nx, m1y = -ea.ny, m2x = -eb.nx, m2y = -eb.ny;
      const d = 1 + m1x * m2x + m1y * m2y;
      if (d < 0.2) return null;
      return [P.x + t.out * (m1x + m2x) / d, P.y + t.out * (m1y + m2y) / d];
    };
    const A = this._ptOn(e, u0), B = this._ptOn(e, u1);
    const ix = -e.nx * t.out, iy = -e.ny * t.out;
    let a2 = [A.x + ix, A.y + iy], b2 = [B.x + ix, B.y + iy];
    let capA = !(t._inner && t._inner[0]), capB = !(t._inner && t._inner[1]);
    if (u0 < 1e-6 && wallAt(prev, false)) { const m = miter(prev, e, e.a); if (m) { a2 = m; capA = false; } }
    if (u1 > 1 - 1e-6 && wallAt(next, true)) { const m = miter(e, next, e.b); if (m) { b2 = m; capB = false; } }
    const mat = t.mat;
    const S = this.texWorld(mat);
    const s0 = -(e.s0 + u0 * e.len) / S, s1 = -(e.s0 + u1 * e.len) / S;
    let zA0, zA1, zB0, zB1;
    if (kind === 'base') { zA0 = A.z; zB0 = B.z; zA1 = A.z + t.h; zB1 = B.z + t.h; }
    else { zA0 = zB0 = wallTop - t.h - 6; zA1 = zB1 = wallTop - 6; }
    const n = [-e.nx, -e.ny, 0];
    const c0 = kind === 'base' ? 0.72 : 0.9, c1 = kind === 'base' ? 0.9 : 1.02;
    // front
    this.quad(mat, [b2[0], b2[1], zB0], [a2[0], a2[1], zA0], [a2[0], a2[1], zA1], [b2[0], b2[1], zB1],
      [s1, zB0 / S], [s0, zA0 / S], [s0, zA1 / S], [s1, zB1 / S], c0, c0, c1, c1, n);
    // top ledge
    this.quad(mat, [A.x, A.y, zA1], [B.x, B.y, zB1], [b2[0], b2[1], zB1], [a2[0], a2[1], zA1],
      [s0, 0], [s1, 0], [s1, t.out / S], [s0, t.out / S], c1, c1, c1, c1, [0, 0, 1]);
    if (kind === 'cornice') {
      this.quad(mat, [B.x, B.y, zB0], [A.x, A.y, zA0], [a2[0], a2[1], zA0], [b2[0], b2[1], zB0],
        [s1, 0], [s0, 0], [s0, t.out / S], [s1, t.out / S], 0.7, 0.7, 0.7, 0.7, [0, 0, -1]);
    }
    // end caps where the strip stops at an opening
    if (capA) this.quad(mat, [A.x, A.y, zA0], [a2[0], a2[1], zA0], [a2[0], a2[1], zA1], [A.x, A.y, zA1], [0, zA0 / S], [t.out / S, zA0 / S], [t.out / S, zA1 / S], [0, zA1 / S], c0, c0, c1, c1, [-e.ux, -e.uy, 0]);
    if (capB) this.quad(mat, [b2[0], b2[1], zB0], [B.x, B.y, zB0], [B.x, B.y, zB1], [b2[0], b2[1], zB1], [0, zB0 / S], [t.out / S, zB0 / S], [t.out / S, zB1 / S], [0, zB1 / S], c0, c0, c1, c1, [e.ux, e.uy, 0]);
  }

  _beams(R, b) {
    // timber beams across a tunnel ceiling, spanning the short axis
    const { dir = 'x', step = 96, w = 10, h = 10, mat = 'wood_planks' } = b;
    const z1 = R.ceil, z0 = R.ceil - h;
    if (dir === 'x') {
      for (let y = Math.ceil((R.miny + step / 2) / step) * step; y < R.maxy - step / 4; y += step) {
        const xs = spanAt(R.pts, y, 'y'); if (!xs) continue;
        this.box([xs[0], y - w / 2, z0], [xs[1], y + w / 2, z1], mat, { col: false, color: 0.7 });
      }
    } else {
      for (let x = Math.ceil((R.minx + step / 2) / step) * step; x < R.maxx - step / 4; x += step) {
        const ys = spanAt(R.pts, x, 'x'); if (!ys) continue;
        this.box([x - w / 2, ys[0], z0], [x + w / 2, ys[1], z1], mat, { col: false, color: 0.7 });
      }
    }
  }

  /** Barrel-vaulted passage region (quad). Jamb edges = the bare edges; openings get arched faces. */
  _arch(R) {
    const o = R.o, { spring, crown } = o.arch;
    const jambs = R.edges.filter((e) => e.segs.every((s) => !s.N));
    const opens = R.edges.filter((e) => e.segs.some((s) => s.N));
    if (R.n !== 4 || jambs.length !== 2) {
      // degenerate: fall back to a flat ceiling at the crown
      o.arch = null; R.ceil = crown; R.ceilTop = R.ceilTop ?? crown + 64;
      return;
    }
    const topZ = R.ceilTop;
    const j0 = jambs[0], j1 = jambs[1];
    // cross-section runs from jamb j0 line to j1 line; depth runs along j0 (a->b)
    const W = Math.abs((j1.a.x - j0.a.x) * j0.nx + (j1.a.y - j0.a.y) * j0.ny);
    const rise = crown - spring;
    const K = 12;
    const mat = o.archMat ?? o.wallMat ?? 'plaster_wall';
    const S = this.texWorld(mat);
    // points on the vault: param i across the width, at the two ends of j0 (depth ends)
    const inw = [-j0.nx, -j0.ny];
    const prof = [];
    for (let i = 0; i <= K; i++) {
      const th = Math.PI * i / K;
      prof.push({ w: (1 - Math.cos(th)) / 2 * W, z: spring + rise * Math.sin(th), th });
    }
    const Pt = (end, i) => { const base = end ? j0.b : j0.a; return [base.x + inw[0] * prof[i].w, base.y + inw[1] * prof[i].w, prof[i].z]; };
    // vault (intrados), facing down/in
    let arc = 0;
    const cc = (z) => 0.5 + 0.25 * smooth(spring, crown, z);
    for (let i = 0; i < K; i++) {
      const a0 = Pt(0, i), a1 = Pt(0, i + 1), b0 = Pt(1, i), b1 = Pt(1, i + 1);
      const segL = Math.hypot(prof[i + 1].w - prof[i].w, prof[i + 1].z - prof[i].z);
      const ua = arc / S, ub = (arc + segL) / S; arc += segL;
      const wm = (prof[i].w + prof[i + 1].w) / 2 - W / 2, zm = (prof[i].z + prof[i + 1].z) / 2 - spring;
      const nl = Math.hypot(wm, zm) || 1;
      const vn = [-inw[0] * wm / nl, -inw[1] * wm / nl, -zm / nl];   // toward the arch axis
      this.quad(mat, a0, a1, b1, b0, [ua, 0], [ub, 0], [ub, j0.len / S], [ua, j0.len / S], cc(a0[2]), cc(a1[2]), cc(b1[2]), cc(b0[2]), vn);
    }
    // end faces with the arch cut out (at j0.a end and j0.b end)
    for (const end of [0, 1]) {
      const base = end ? j0.b : j0.a;
      const outDir = end ? [j0.ux, j0.uy] : [-j0.ux, -j0.uy];
      const shape = [];
      shape.push(new THREE.Vector2(0, spring));
      for (let i = 1; i < K; i++) shape.push(new THREE.Vector2(prof[i].w, prof[i].z));
      shape.push(new THREE.Vector2(W, spring), new THREE.Vector2(W, topZ), new THREE.Vector2(0, topZ));
      const tr = THREE.ShapeUtils.triangulateShape(shape, []);
      const to3 = (v) => [base.x + inw[0] * v.x, base.y + inw[1] * v.x, v.y];
      for (const t of tr) {
        let p = [to3(shape[t[0]]), to3(shape[t[1]]), to3(shape[t[2]])];
        const n = newell(p);
        if (n[0] * outDir[0] + n[1] * outDir[1] < 0) p = [p[0], p[2], p[1]];
        this.poly(mat, p, { col: (q) => 0.85 + 0.15 * smooth(spring, topZ, q[2]), uv: (q) => [((q[0] - base.x) * inw[0] + (q[1] - base.y) * inw[1]) / S * (end ? 1 : -1), q[2] / S] });
      }
      // voussoir ring
      if (o.ring !== false) this._archRing(base, inw, outDir, prof, W, spring, rise, o.ringMat ?? 'arch_stone');
      this.walls.push({ R, A: { x: base.x, y: base.y }, B: { x: base.x + inw[0] * W, y: base.y + inw[1] * W }, top: topZ, zfA: spring, zfB: spring, nx: outDir[0], ny: outDir[1], cap: 0, header: true });
    }
    // roof of the mass
    if (o.roof !== false) {
      let roof = [[j0.a.x, j0.a.y, topZ], [j0.b.x, j0.b.y, topZ], [j0.b.x + inw[0] * W, j0.b.y + inw[1] * W, topZ], [j0.a.x + inw[0] * W, j0.a.y + inw[1] * W, topZ]];
      if (newell(roof)[2] < 0) roof = roof.reverse();
      this.poly(o.roofMat ?? 'plaster_wall', roof, { col: 0.95 });
    }
    // collision: columns across the width following the curve
    const NC = 8;
    for (let i = 0; i < NC; i++) {
      const w0 = W * i / NC, w1 = W * (i + 1) / NC;
      const z = (w) => { const c = clamp(1 - 2 * w / W, -1, 1); return spring + rise * Math.sqrt(Math.max(0, 1 - c * c)); };
      const lo = Math.min(z(w0), z(w1));
      const q = (end, w) => { const base = end ? j0.b : j0.a; return [base.x + inw[0] * w, base.y + inw[1] * w]; };
      this.colPrism([q(0, w0), q(0, w1), q(1, w1), q(1, w0)], lo, topZ, 'plaster');
    }
  }

  _archRing(base, inw, outDir, prof, W, spring, rise, mat) {
    const rw = 10, pr = 2.5;   // ring width and projection
    const S = this.texWorld(mat);
    const K = prof.length - 1;
    const cx = W / 2;
    const a = W / 2;
    const at = (i, r) => ({ w: cx - (a + r) * Math.cos(prof[i].th), z: spring + (rise + r) * Math.sin(prof[i].th) });
    const P3 = (w, z, d) => [base.x + inw[0] * w + outDir[0] * d, base.y + inw[1] * w + outDir[1] * d, z];
    for (let i = 0; i < K; i++) {
      const a0 = prof[i], a1 = prof[i + 1];
      const b0 = at(i, rw), b1 = at(i + 1, rw);
      const c = 0.92;
      // front face of the ring
      const f = [P3(a0.w, a0.z, pr), P3(a1.w, a1.z, pr), P3(b1.w, b1.z, pr), P3(b0.w, b0.z, pr)];
      const n = newell(f);
      const ff = n[0] * outDir[0] + n[1] * outDir[1] < 0 ? f.slice().reverse() : f;
      this.poly(mat, ff, { col: c, uv: (p) => [((p[0] - base.x) * inw[0] + (p[1] - base.y) * inw[1]) / S, p[2] / S] });
      // intrados strip of the projection
      const g = [P3(a0.w, a0.z, 0), P3(a1.w, a1.z, 0), P3(a1.w, a1.z, pr), P3(a0.w, a0.z, pr)];
      const gn = newell(g);
      const gg = gn[2] > 0 ? g.slice().reverse() : g;
      this.poly(mat, gg, { col: 0.7 });
      // outer edge of projection
      const h = [P3(b0.w, b0.z, 0), P3(b0.w, b0.z, pr), P3(b1.w, b1.z, pr), P3(b1.w, b1.z, 0)];
      const hn = newell(h);
      this.poly(mat, hn[2] < 0 ? h.slice().reverse() : h, { col: 0.95 });
    }
  }

  _endCaps() {
    // Where a wall stops next to a lower wall (or nothing), close off the slab end above it.
    const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const map = new Map();
    const add = (x, y, w) => {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = key(x + dx, y + dy);
        let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(w);
      }
    };
    for (const w of this.walls) { add(w.A.x, w.A.y, w); add(w.B.x, w.B.y, w); }
    for (const R of this.regions) if (R.ceil != null) for (const p of R.pts) add(p.x, p.y, { R, top: R.ceilTop, A: p, B: p, header: true, ceilPt: true });
    for (const w of this.walls) {
      if (w.header || !w.cap) continue;
      for (const end of [0, 1]) {
        const P = end ? w.B : w.A;
        const zf = end ? w.zfB : w.zfA;
        const others = (map.get(key(P.x, P.y)) || []).filter((q) => q !== w && Math.hypot((q.A.x - P.x), (q.A.y - P.y)) < 1.5 || (q !== w && Math.hypot(q.B.x - P.x, q.B.y - P.y) < 1.5));
        let adj = zf;
        for (const q of others) adj = Math.max(adj, q.top);
        if (adj >= w.top - 0.5) continue;
        const dx = w.B.x - w.A.x, dy = w.B.y - w.A.y, l = Math.hypot(dx, dy) || 1;
        const d = end ? [dx / l, dy / l] : [-dx / l, -dy / l];
        const Q = [P.x + w.nx * w.cap, P.y + w.ny * w.cap];
        const mat = w.mat || 'plaster_wall';
        const S = this.texWorld(mat);
        let face = [[P.x, P.y, adj], [Q[0], Q[1], adj], [Q[0], Q[1], w.top], [P.x, P.y, w.top]];
        const n = newell(face);
        if (n[0] * d[0] + n[1] * d[1] < 0) face = face.reverse();
        this.poly(mat, face, { col: (p) => this._wallCol(w.R, p[0], p[1], p[2], zf, w.top), uv: (p) => [((p[0] - P.x) * w.nx + (p[1] - P.y) * w.ny) / S, p[2] / S] });
      }
    }
  }

  // Fill the building masses between the walkable regions with flat roofs at the height of the
  // nearest wall, so elevated views and the overview read as a town rather than a maze.
  _roofs() {
    const G = 16, PAD = 480;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const R of this.regions) { x0 = Math.min(x0, R.minx); y0 = Math.min(y0, R.miny); x1 = Math.max(x1, R.maxx); y1 = Math.max(y1, R.maxy); }
    x0 = Math.floor((x0 - PAD) / G) * G; y0 = Math.floor((y0 - PAD) / G) * G;
    const nx = Math.ceil((x1 + PAD - x0) / G), ny = Math.ceil((y1 + PAD - y0) / G);
    const open = new Uint8Array(nx * ny);
    const cxOf = (i) => x0 + (i + 0.5) * G, cyOf = (j) => y0 + (j + 0.5) * G;
    // 1. region footprints (dilated a little so roofs start behind the wall copings)
    const DIL = 8;
    for (const R of this.regions) {
      const P = R.pts;
      const j0 = Math.max(0, Math.floor((R.miny - DIL - y0) / G)), j1 = Math.min(ny - 1, Math.ceil((R.maxy + DIL - y0) / G));
      const i0 = Math.max(0, Math.floor((R.minx - DIL - x0) / G)), i1 = Math.min(nx - 1, Math.ceil((R.maxx + DIL - x0) / G));
      for (let j = j0; j <= j1; j++) {
        const y = cyOf(j);
        for (let i = i0; i <= i1; i++) {
          if (open[j * nx + i]) continue;
          const x = cxOf(i);
          let inside = false;
          for (let k = 0, m = P.length - 1; k < P.length; m = k++) {
            const a = P[k], b = P[m];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
          }
          if (!inside) {
            for (let k = 0, m = P.length - 1; k < P.length && !inside; m = k++) if (segDist(x, y, P[m].x, P[m].y, P[k].x, P[k].y) < DIL) inside = true;
          }
          if (inside) open[j * nx + i] = 1;
        }
      }
    }
    // 2. seeds from walls (just behind each wall face), then BFS nearest-wall height
    const h = new Float32Array(nx * ny).fill(NaN);
    const q = [];
    for (const w of this.walls) {
      const L = Math.hypot(w.B.x - w.A.x, w.B.y - w.A.y);
      const top = w.seedTop ?? w.top;
      for (let t = 0; t <= L; t += 6) {
        const f = L > 0 ? t / L : 0;
        for (const off of [14, 26]) {
          const px = w.A.x + (w.B.x - w.A.x) * f + w.nx * off, py = w.A.y + (w.B.y - w.A.y) * f + w.ny * off;
          const i = Math.floor((px - x0) / G), j = Math.floor((py - y0) / G);
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
          const c = j * nx + i;
          if (open[c]) continue;
          if (Number.isNaN(h[c])) { h[c] = top; q.push(c); } else h[c] = Math.max(h[c], top);
        }
      }
    }
    const dist = new Uint16Array(nx * ny);
    const FAR = 14, CITY = 320;          // beyond ~220u from any wall: generic town roofline
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi], i = c % nx, j = (c / nx) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const d = jj * nx + ii;
        if (open[d] || !Number.isNaN(h[d])) continue;
        dist[d] = dist[c] + 1;
        h[d] = dist[d] > FAR ? CITY : h[c]; q.push(d);
      }
    }
    // 3. greedy rectangles of equal height -> roof quads
    const done = new Uint8Array(nx * ny);
    const mat = 'plaster_wall';
    const S = this.texWorld(mat);
    const rc = (x, y) => 0.8 + 0.12 * noise(x / 400, y / 400, 9.1);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (open[c] || done[c] || Number.isNaN(h[c])) continue;
      const z = h[c];
      let w = 1;
      while (i + w < nx) { const d = j * nx + i + w; if (open[d] || done[d] || h[d] !== z) break; w++; }
      let hh = 1;
      outer: while (j + hh < ny) {
        for (let k = 0; k < w; k++) { const d = (j + hh) * nx + i + k; if (open[d] || done[d] || h[d] !== z) break outer; }
        hh++;
      }
      for (let jj = j; jj < j + hh; jj++) for (let ii = i; ii < i + w; ii++) done[jj * nx + ii] = 1;
      const ax = x0 + i * G, ay = y0 + j * G, bx = ax + w * G, by = ay + hh * G;
      this.poly(mat, [[ax, ay, z], [bx, ay, z], [bx, by, z], [ax, by, z]], { col: (p) => rc(p[0], p[1]), uv: (p) => [p[0] / S, p[1] / S] });
    }
    // 4. vertical steps between roof cells of different height (face the lower side)
    const face = (xa, ya, xb, yb, zl, zh, nxv, nyv) => {
      let P = [[xa, ya, zl], [xb, yb, zl], [xb, yb, zh], [xa, ya, zh]];
      const n = newell(P);
      if (n[0] * nxv + n[1] * nyv < 0) P = P.reverse();
      this.poly(mat, P, { col: (p) => 0.85 + 0.1 * smooth(zl, zh, p[2]) });
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (open[c] || Number.isNaN(h[c])) continue;
      if (i + 1 < nx) {
        const d = c + 1;
        if (!open[d] && !Number.isNaN(h[d]) && h[d] !== h[c]) {
          const x = x0 + (i + 1) * G, ya = y0 + j * G, yb = ya + G;
          if (h[d] > h[c]) face(x, ya, x, yb, h[c], h[d], -1, 0); else face(x, ya, x, yb, h[d], h[c], 1, 0);
        }
      }
      if (j + 1 < ny) {
        const d = c + nx;
        if (!open[d] && !Number.isNaN(h[d]) && h[d] !== h[c]) {
          const y = y0 + (j + 1) * G, xa = x0 + i * G, xb = xa + G;
          if (h[d] > h[c]) face(xa, y, xb, y, h[c], h[d], 0, -1); else face(xa, y, xb, y, h[d], h[c], 0, 1);
        }
      }
    }
    this.roofGrid = { x0, y0, nx, ny, G, open, h };
  }

  // ---------------------------------------------------------------------------- props
  /** Place a props.js builder if available, else a fallback. pos Source [x,y,z], yaw deg. */
  prop(name, args, pos, yaw = 0, fallback = null) {
    const fn = this.P?.[name];
    if (typeof fn === 'function') {
      try {
        const r = fn(...(args || []));
        if (r?.object) {
          const obj = r.object;
          obj.position.set(pos[0], pos[2], -pos[1]);
          obj.rotation.y = yaw * Math.PI / 180;
          obj.updateMatrixWorld(true);
          this.propRoot.add(obj);
          this.stats.props++;
          for (const c of r.colliders || []) this._propCollider(c, pos, yaw, r.surface || 'crate');
          return r;
        }
      } catch (err) { console.warn(`[map] prop ${name} failed:`, err.message); }
    }
    this.stats.propFallbacks++;
    if (fallback) fallback();
    return null;
  }
  _propCollider(c, pos, yaw, surf) {
    const a = yaw * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    // local Three (x, y up, z) -> Source local (x, -z, y) then rotate by yaw about z
    const L2S = (x, z) => { const sx = x, sy = -z; return [pos[0] + sx * ca - sy * sa, pos[1] + sx * sa + sy * ca]; };
    const flags = c.flags ?? (c.grate ? CONTENTS_GRATE : c.ladder ? 16 : c.noShot ? CONTENTS_PLAYERCLIP : CONTENTS_SOLID);
    const s = c.surface || surf;
    if (c.min && c.max) {
      const mn = c.min, mx = c.max;
      const P = [L2S(mn.x ?? mn[0], mn.z ?? mn[2]), L2S(mx.x ?? mx[0], mn.z ?? mn[2]), L2S(mx.x ?? mx[0], mx.z ?? mx[2]), L2S(mn.x ?? mn[0], mx.z ?? mx[2])];
      this.colPrism(P, pos[2] + (mn.y ?? mn[1]), pos[2] + (mx.y ?? mx[1]), s, flags);
    } else if (c.prism) {
      this.colPrism(c.prism.map((p) => L2S(p.x, p.z ?? p.y)), pos[2] + c.y0, pos[2] + c.y1, s, flags);
    }
  }

  // ---------------------------------------------------------------------------- output
  _build() {
    const root = new THREE.Group();
    root.name = 'dust2';
    const meshes = [];
    for (const [spec, B] of this.buckets) {
      if (!B.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.setAttribute('uv1', new THREE.Float32BufferAttribute(B.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
      g.setIndex(B.n > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.material(spec));
      m.name = `map_${spec}`;
      m.castShadow = true; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.userData.static = true;
      root.add(m); meshes.push(m);
    }
    const props = mergeStatic(this.propRoot);
    root.add(props);
    this.col.build();
    const walk = new Float32Array(this.walkTris.length * 9);
    let i = 0;
    for (const t of this.walkTris) for (const p of t) { walk[i++] = p[0]; walk[i++] = p[2]; walk[i++] = -p[1]; }
    return { root, collision: this.col, walkable: walk, meshes };
  }
}

// ---- helpers ------------------------------------------------------------------------------
function boxUV(p, n, S) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return [p[0] / S, (n[2] >= 0 ? p[1] : -p[1]) / S];
  if (ax >= ay) return [(n[0] >= 0 ? p[1] : -p[1]) / S, p[2] / S];
  return [(n[1] >= 0 ? -p[0] : p[0]) / S, p[2] / S];
}
function isPlanar(P) {
  if (P.length <= 3) return true;
  const Q = P.map((p) => [p.x, p.y, p.z]);
  const n = newell(Q);
  const d = n[0] * Q[0][0] + n[1] * Q[0][1] + n[2] * Q[0][2];
  return Q.every((q) => Math.abs(n[0] * q[0] + n[1] * q[1] + n[2] * q[2] - d) < 0.25);
}
function isConvex(P) {
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], c = P[(i + 2) % n];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-6) return false;
  }
  return true;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
function raySeg(px, py, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return Infinity;
  const t = ((ax - px) * ey - (ay - py) * ex) / den;
  const s = ((ax - px) * dy - (ay - py) * dx) / den;
  if (s < 0 || s > 1 || t < 0) return Infinity;
  return t;
}
function spanAt(pts, v, axis) {
  // intersection span of a horizontal (axis 'y') or vertical line with polygon
  const xs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const [a1, a2, b1, b2] = axis === 'y' ? [a.y, a.x, b.y, b.x] : [a.x, a.y, b.x, b.y];
    if ((a1 <= v && b1 > v) || (b1 <= v && a1 > v)) xs.push(a2 + (v - a1) / (b1 - a1) * (b2 - a2));
  }
  if (xs.length < 2) return null;
  xs.sort((p, q) => p - q);
  return [xs[0], xs[xs.length - 1]];
}

/** Bake a prop hierarchy into one mesh per material (static props never move). */
export function mergeStatic(group) {
  const out = new THREE.Group();
  out.name = 'props';
  group.updateMatrixWorld(true);
  const bins = new Map();
  const keep = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || o.userData.dynamic) { keep.push(o); return; }
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    const sig = o.material.uuid + '|' + Object.keys(g.attributes).sort().join(',') + '|' + (g.index ? 'i' : 'n');
    let b = bins.get(sig); if (!b) bins.set(sig, (b = { mat: o.material, list: [], cast: o.castShadow, recv: o.receiveShadow }));
    const gg = g.clone(); gg.applyMatrix4(o.matrixWorld);
    b.list.push(gg);
  });
  for (const b of bins.values()) {
    let g = null;
    try { g = b.list.length === 1 ? b.list[0] : mergeList(b.list); } catch { g = null; }
    if (!g) { for (const x of b.list) { const m = new THREE.Mesh(x, b.mat); m.castShadow = true; m.receiveShadow = true; out.add(m); } continue; }
    const m = new THREE.Mesh(g, b.mat);
    m.castShadow = true; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    out.add(m);
  }
  for (const o of keep) {
    o.updateMatrixWorld(true);
    const m = o.clone();
    o.matrixWorld.decompose(m.position, m.quaternion, m.scale);
    out.add(m);
  }
  return out;
}
function mergeList(list) {
  // minimal mergeGeometries (same attribute set guaranteed by the bin signature)
  const names = Object.keys(list[0].attributes);
  const indexed = !!list[0].index;
  const g = new THREE.BufferGeometry();
  let total = 0;
  for (const x of list) total += x.attributes.position.count;
  for (const nm of names) {
    const a0 = list[0].attributes[nm];
    const arr = new Float32Array(total * a0.itemSize);
    let off = 0;
    for (const x of list) {
      const a = x.attributes[nm];
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a0.itemSize; k++) arr[(off + i) * a0.itemSize + k] = a.getComponent(i, k);
      off += a.count;
    }
    g.setAttribute(nm, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
  }
  if (indexed) {
    const idx = [];
    let off = 0;
    for (const x of list) { const ix = x.index.array; for (let i = 0; i < ix.length; i++) idx.push(ix[i] + off); off += x.attributes.position.count; }
    g.setIndex(total > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  }
  g.computeBoundingSphere();
  return g;
}
