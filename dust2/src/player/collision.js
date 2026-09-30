// Source/Quake-style brush collision. See CONTRACT.md §3.
//
// A brush is a convex volume: point p is inside when dot(n, p) <= dist for every plane.
// Hull traces Minkowski-expand each plane by the box extents (Quake's ofs trick) and clip
// the swept segment against the expanded polytope (Cyrus-Beck). Axis-aligned bevel planes
// are added automatically so box-vs-slope traces don't snag on phantom corners.
import * as THREE from 'three';
import { World } from '../core/world.js';

export const CONTENTS_SOLID = 1;
export const CONTENTS_PLAYERCLIP = 2;
export const CONTENTS_GRATE = 4;
export const CONTENTS_WATER = 8;
export const CONTENTS_LADDER = 16;
export const CONTENTS_NOSHOT = 32; // invisible, blocks players but not bullets (== playerclip alias)

export const MASK_PLAYER = CONTENTS_SOLID | CONTENTS_PLAYERCLIP | CONTENTS_GRATE;
export const MASK_SHOT = CONTENTS_SOLID | CONTENTS_GRATE;
export const MASK_VISIBLE = CONTENTS_SOLID;
export const MASK_NPC = MASK_PLAYER;

const DIST_EPSILON = 0.03125;

class Plane {
  constructor(nx, ny, nz, dist) {
    this.n = new THREE.Vector3(nx, ny, nz);
    this.dist = dist;
    this.axial = (Math.abs(nx) === 1 || Math.abs(ny) === 1 || Math.abs(nz) === 1);
  }
  // CONTRACT uses n·p + d <= 0; expose d for consumers.
  get d() { return -this.dist; }
}

class Brush {
  constructor(id, planes, surface, contents) {
    this.id = id;
    this.planes = planes;
    this.surface = surface;
    this.contents = contents;
    this.min = new THREE.Vector3();
    this.max = new THREE.Vector3();
  }
}

export class Trace {
  constructor() {
    this.fraction = 1;
    this.endpos = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.plane = null;
    this.surface = 'default';
    this.brush = -1;
    this.entity = null;
    this.startSolid = false;
    this.allSolid = false;
    this.hitgroup = 0;
    this.contents = 0;
  }
  reset() {
    this.fraction = 1; this.normal.set(0, 0, 0); this.plane = null; this.surface = 'default';
    this.brush = -1; this.entity = null; this.startSolid = false; this.allSolid = false;
    this.hitgroup = 0; this.contents = 0;
    return this;
  }
  copy(o) {
    this.fraction = o.fraction; this.endpos.copy(o.endpos); this.normal.copy(o.normal);
    this.plane = o.plane; this.surface = o.surface; this.brush = o.brush; this.entity = o.entity;
    this.startSolid = o.startSolid; this.allSolid = o.allSolid; this.hitgroup = o.hitgroup;
    this.contents = o.contents;
    return this;
  }
  clone() { return new Trace().copy(this); }
  get hit() { return this.fraction < 1 || this.startSolid; }
}

// --- BVH over brush AABBs ---------------------------------------------------------------
class Node {
  constructor() {
    this.min = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    this.left = null; this.right = null; this.items = null;
  }
}

function buildNode(items, depth) {
  const node = new Node();
  for (const b of items) { node.min.min(b.min); node.max.max(b.max); }
  if (items.length <= 4 || depth > 24) { node.items = items; return node; }
  const ext = new THREE.Vector3().subVectors(node.max, node.min);
  const axis = ext.x > ext.y ? (ext.x > ext.z ? 'x' : 'z') : (ext.y > ext.z ? 'y' : 'z');
  items.sort((a, b) => (a.min[axis] + a.max[axis]) - (b.min[axis] + b.max[axis]));
  const mid = items.length >> 1;
  node.left = buildNode(items.slice(0, mid), depth + 1);
  node.right = buildNode(items.slice(mid), depth + 1);
  return node;
}

const _stack = [];

export class CollisionWorld {
  constructor() {
    this.brushes = [];
    this.root = null;
    this._trace = new Trace();
    this._entTrace = new Trace();
    this._qmin = new THREE.Vector3();
    this._qmax = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this.traceCount = 0;
  }

  // ---- construction ---------------------------------------------------------------------

  /** planes: Array<{n: Vector3, d: number}> with inside = n·p + d <= 0 */
  addBrush(planes, surface = 'default', flags = CONTENTS_SOLID) {
    const ps = planes.map((p) => {
      const n = p.n.clone().normalize();
      return new Plane(n.x, n.y, n.z, -p.d / p.n.length());
    });
    return this._addPlanes(ps, surface, flags || CONTENTS_SOLID);
  }

  addBox(min, max, surface = 'default', flags = CONTENTS_SOLID) {
    const mn = new THREE.Vector3().copy(min).min(max);
    const mx = new THREE.Vector3().copy(max).max(min);
    if (mx.x - mn.x < 0.01 || mx.y - mn.y < 0.01 || mx.z - mn.z < 0.01) return -1;
    return this._addPlanes([
      new Plane(1, 0, 0, mx.x), new Plane(-1, 0, 0, -mn.x),
      new Plane(0, 1, 0, mx.y), new Plane(0, -1, 0, -mn.y),
      new Plane(0, 0, 1, mx.z), new Plane(0, 0, -1, -mn.z),
    ], surface, flags || CONTENTS_SOLID, mn, mx);
  }

  /**
   * Ramp filling the box [min,max], rising along `axis` ('x'|'z') toward `dir` (+1|-1).
   * Low edge height = min.y, high edge height = max.y.
   */
  addWedge(min, max, axis = 'z', dir = 1, surface = 'default', flags = CONTENTS_SOLID) {
    const mn = new THREE.Vector3().copy(min).min(max);
    const mx = new THREE.Vector3().copy(max).max(min);
    const len = axis === 'x' ? mx.x - mn.x : mx.z - mn.z;
    const h = mx.y - mn.y;
    // slope plane normal: up and back against the rising direction
    const n = new THREE.Vector3(0, len, 0);
    if (axis === 'x') n.x = -h * dir; else n.z = -h * dir;
    n.normalize();
    // a point on the slope: the high edge top
    const p = new THREE.Vector3(0, mx.y, 0);
    if (axis === 'x') { p.x = dir > 0 ? mx.x : mn.x; p.z = mn.z; } else { p.z = dir > 0 ? mx.z : mn.z; p.x = mn.x; }
    const planes = [
      new Plane(1, 0, 0, mx.x), new Plane(-1, 0, 0, -mn.x),
      new Plane(0, -1, 0, -mn.y), new Plane(0, 1, 0, mx.y),
      new Plane(0, 0, 1, mx.z), new Plane(0, 0, -1, -mn.z),
      new Plane(n.x, n.y, n.z, n.dot(p)),
    ];
    return this._addPlanes(planes, surface, flags || CONTENTS_SOLID, mn, mx);
  }

  /**
   * Vertical prism: convex polygon in XZ (array of {x,z}, any winding) extruded y0..y1.
   * Use for the many diagonal walls in de_dust2.
   */
  addPrism(poly, y0, y1, surface = 'default', flags = CONTENTS_SOLID) {
    const pts = poly.map((p) => ({ x: p.x, z: p.z ?? p.y }));
    // ensure CCW when viewed from +Y (x right, z down on screen => use signed area)
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += a.x * b.z - b.x * a.z;
    }
    if (area > 0) pts.reverse();
    const planes = [new Plane(0, 1, 0, Math.max(y0, y1)), new Plane(0, -1, 0, -Math.min(y0, y1))];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ex = b.x - a.x, ez = b.z - a.z;
      // outward normal for CW-from-above (after reversal) polygon
      let nx = ez, nz = -ex;
      const l = Math.hypot(nx, nz);
      if (l < 1e-6) continue;
      nx /= l; nz /= l;
      planes.push(new Plane(nx, 0, nz, nx * a.x + nz * a.z));
    }
    // validate orientation: centroid must be inside every plane; flip if not
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    for (const pl of planes) {
      if (pl.n.y !== 0) continue;
      if (pl.n.x * cx + pl.n.z * cz > pl.dist) { pl.n.negate(); pl.dist = -pl.dist; }
    }
    return this._addPlanes(planes, surface, flags || CONTENTS_SOLID);
  }

  /** Oriented box: center, half-extents, yaw in degrees around +Y. */
  addOrientedBox(center, half, yawDeg, surface = 'default', flags = CONTENTS_SOLID) {
    const c = Math.cos(yawDeg * Math.PI / 180), s = Math.sin(yawDeg * Math.PI / 180);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
      const lx = sx * half.x, lz = sz * half.z;
      return { x: center.x + lx * c + lz * s, z: center.z - lx * s + lz * c };
    });
    return this.addPrism(corners, center.y - half.y, center.y + half.y, surface, flags);
  }

  _addPlanes(planes, surface, contents, mn, mx) {
    const b = new Brush(this.brushes.length, planes, surface, contents);
    if (mn && mx) { b.min.copy(mn); b.max.copy(mx); }
    else this._computeBounds(b);
    if (!isFinite(b.min.x) || !isFinite(b.max.x)) return -1;
    // Bevel planes: add any missing axial planes from the AABB so box traces are exact.
    const have = new Set(planes.filter((p) => p.axial).map((p) => `${p.n.x},${p.n.y},${p.n.z}`));
    const bevels = [
      [1, 0, 0, b.max.x], [-1, 0, 0, -b.min.x], [0, 1, 0, b.max.y],
      [0, -1, 0, -b.min.y], [0, 0, 1, b.max.z], [0, 0, -1, -b.min.z],
    ];
    for (const [x, y, z, d] of bevels) {
      if (!have.has(`${x},${y},${z}`)) { const p = new Plane(x, y, z, d); p.bevel = true; planes.push(p); }
    }
    this.brushes.push(b);
    this.root = null;
    return b.id;
  }

  /** Compute AABB of a convex brush by intersecting plane triples. */
  _computeBounds(b) {
    const P = b.planes, n = P.length;
    const m = new THREE.Matrix3(), v = new THREE.Vector3(), rhs = new THREE.Vector3();
    b.min.set(Infinity, Infinity, Infinity); b.max.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
      const a = P[i].n, bb = P[j].n, c = P[k].n;
      m.set(a.x, a.y, a.z, bb.x, bb.y, bb.z, c.x, c.y, c.z);
      if (Math.abs(m.determinant()) < 1e-8) continue;
      rhs.set(P[i].dist, P[j].dist, P[k].dist);
      v.copy(rhs).applyMatrix3(m.invert());
      let inside = true;
      for (let q = 0; q < n; q++) if (P[q].n.dot(v) > P[q].dist + 0.01) { inside = false; break; }
      if (inside) { b.min.min(v); b.max.max(v); }
    }
  }

  build() {
    this.root = this.brushes.length ? buildNode(this.brushes.slice(), 0) : null;
    return this;
  }

  // ---- queries --------------------------------------------------------------------------

  _query(min, max, fn) {
    if (!this.root) this.build();
    if (!this.root) return;
    _stack.length = 0;
    _stack.push(this.root);
    while (_stack.length) {
      const node = _stack.pop();
      if (node.max.x < min.x || node.min.x > max.x || node.max.y < min.y || node.min.y > max.y ||
          node.max.z < min.z || node.min.z > max.z) continue;
      if (node.items) {
        for (const b of node.items) {
          if (b.max.x < min.x || b.min.x > max.x || b.max.y < min.y || b.min.y > max.y ||
              b.max.z < min.z || b.min.z > max.z) continue;
          fn(b);
        }
      } else { _stack.push(node.left, node.right); }
    }
  }

  /**
   * Sweep an AABB (mins/maxs relative to origin) from start to end.
   * Returns a pooled Trace — copy what you need.
   */
  hullTrace(mins, maxs, start, end, mask = MASK_PLAYER) {
    this.traceCount++;
    const tr = this._trace.reset();
    this._qmin.set(Math.min(start.x, end.x) + mins.x - 1, Math.min(start.y, end.y) + mins.y - 1, Math.min(start.z, end.z) + mins.z - 1);
    this._qmax.set(Math.max(start.x, end.x) + maxs.x + 1, Math.max(start.y, end.y) + maxs.y + 1, Math.max(start.z, end.z) + maxs.z + 1);
    const isPoint = mins.x === 0 && mins.y === 0 && mins.z === 0 && maxs.x === 0 && maxs.y === 0 && maxs.z === 0;
    this._query(this._qmin, this._qmax, (b) => {
      if (!(b.contents & mask)) return;
      this._clipToBrush(b, mins, maxs, start, end, tr, isPoint);
    });
    if (tr.allSolid) tr.fraction = 0;
    tr.endpos.lerpVectors(start, end, tr.fraction);
    return tr;
  }

  _clipToBrush(b, mins, maxs, start, end, tr, isPoint) {
    let enterFrac = -1, leaveFrac = 1, clip = null, getout = false, startout = false;
    for (let i = 0, P = b.planes, n = P.length; i < n; i++) {
      const p = P[i];
      // point traces ignore bevels (they only matter for boxes)
      if (isPoint && p.bevel) continue;
      let dist = p.dist;
      if (!isPoint) {
        const nx = p.n.x, ny = p.n.y, nz = p.n.z;
        dist -= (nx < 0 ? maxs.x : mins.x) * nx + (ny < 0 ? maxs.y : mins.y) * ny + (nz < 0 ? maxs.z : mins.z) * nz;
      }
      const d1 = p.n.x * start.x + p.n.y * start.y + p.n.z * start.z - dist;
      const d2 = p.n.x * end.x + p.n.y * end.y + p.n.z * end.z - dist;
      if (d2 > 0) getout = true;
      if (d1 > 0) startout = true;
      if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;
      if (d1 <= 0 && d2 <= 0) continue;
      if (d1 > d2) {
        const f = Math.max(0, (d1 - DIST_EPSILON) / (d1 - d2));
        if (f > enterFrac) { enterFrac = f; clip = p; }
      } else {
        const f = Math.min(1, (d1 + DIST_EPSILON) / (d1 - d2));
        if (f < leaveFrac) leaveFrac = f;
      }
    }
    if (!startout) {
      tr.startSolid = true;
      if (!getout) tr.allSolid = true;
      tr.surface = b.surface; tr.brush = b.id; tr.contents = b.contents;
      return;
    }
    if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction) {
      tr.fraction = Math.max(0, enterFrac);
      tr.plane = clip;
      tr.normal.copy(clip.n);
      tr.surface = b.surface;
      tr.brush = b.id;
      tr.contents = b.contents;
    }
  }

  /**
   * Line trace. With MASK_SHOT also tests entity hitboxes via ent.rayHit(start, dir, maxDist)
   * which must return {t, hitgroup, point?, normal?} or null.
   */
  rayTrace(start, end, mask = MASK_SHOT, skipEnt = null) {
    const ZERO = CollisionWorld._zero;
    const world = this.hullTrace(ZERO, ZERO, start, end, mask);
    if (world.fraction >= 1 && !world.startSolid) world.normal.set(0, 0, 0);
    if (!(mask & CONTENTS_SOLID) || mask === MASK_VISIBLE) return world;
    const dir = this._dir.subVectors(end, start);
    const len = dir.length();
    if (len < 1e-6) return world;
    dir.multiplyScalar(1 / len);
    let best = world.fraction * len;
    let hitEnt = null, hg = 0, nrm = null;
    const ents = World.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e === skipEnt || !e.alive || !e.rayHit) continue;
      const h = e.rayHit(start, dir, best);
      if (h && h.t < best) { best = h.t; hitEnt = e; hg = h.hitgroup; nrm = h.normal || null; }
    }
    if (hitEnt) {
      world.fraction = best / len;
      world.entity = hitEnt;
      world.hitgroup = hg;
      world.surface = 'flesh';
      world.brush = -1;
      if (nrm) world.normal.copy(nrm); else world.normal.copy(dir).negate();
      world.endpos.copy(start).addScaledVector(dir, best);
    }
    return world;
  }

  pointContents(p) {
    let c = 0;
    this._qmin.copy(p); this._qmax.copy(p);
    this._query(this._qmin, this._qmax, (b) => {
      for (const pl of b.planes) if (pl.n.dot(p) > pl.dist) return;
      c |= b.contents;
    });
    return c;
  }

  /** Iterate brushes that intersect an AABB (for grenades, nav baking, etc.). */
  brushesIn(min, max, fn) { this._query(min, max, fn); }
}
CollisionWorld._zero = new THREE.Vector3();
