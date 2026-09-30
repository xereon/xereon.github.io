// Projected decals that hug the brush face they hit.
//
// The impact point + normal identify a face of a convex collision brush. The decal quad is
// laid in that face plane and clipped (Sutherland-Hodgman) against the brush's other planes,
// so it can never overhang an edge or float past a corner. Before clipping by an edge we
// probe whether the surface continues past it (a coplanar neighbour brush): if so, we don't
// clip, so decals aren't cut in half at invisible brush seams.
// All decals share one dynamic mesh (ring buffer) -> one draw call.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { SURFACES } from '../core/surfaces.js';
import { queueRange } from './util.js';

const MAXD = 256;
const MAXV = 12;           // vertices per decal (quad clipped by up to 8 planes)
const MAXI = (MAXV - 2) * 3;
const ATTR_K = [3, 3, 2, 4];
const SOLID = 1;

export const DECAL_TYPES = {
  bullet_concrete: { cells: [0, 1, 15], size: 6.5, tint: 1.05 },
  bullet_plaster: { cells: [2, 3], size: 8, tint: 1.08 },
  bullet_wood: { cells: [4, 5], size: 6.5, tint: 1.45, grain: true },
  bullet_metal: { cells: [6, 7], size: 4.5, tint: -1 },
  bullet_glass: { cells: [8], size: 11, tint: -1 },
  bullet_sand: { cells: [9], size: 7, tint: 0.9 },
  blood: { cells: [10, 11], size: 34, tint: -1 },
  blood_drip: { cells: [12], size: 18, tint: -1 },
  scorch: { cells: [13], size: 150, tint: -1, big: true },
  burn: { cells: [14], size: 70, tint: -1, big: true },
};

const QU = [-1, 1, 1, -1], QV = [-1, -1, 1, 1];
const _t = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Vector3(), _m = new THREE.Vector3();
const _min = new THREE.Vector3(), _max = new THREE.Vector3(), _c = new THREE.Color();
// polygon scratch (double-buffered)
const PA = new Float32Array(MAXV * 3 * 2), PB = new Float32Array(MAXV * 3 * 2);

export class Decals {
  constructor(scene, textures) {
    this.pos = new Float32Array(MAXD * MAXV * 3);
    this.nrm = new Float32Array(MAXD * MAXV * 3);
    this.uv = new Float32Array(MAXD * MAXV * 2);
    this.col = new Float32Array(MAXD * MAXV * 4);
    const idx = new Uint16Array(MAXD * MAXI);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aNrm = new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aIdx = new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('normal', this.aNrm);
    g.setAttribute('uv', this.aUv);
    g.setAttribute('color', this.aCol);
    g.setIndex(this.aIdx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = g;
    this.material = new THREE.MeshStandardMaterial({
      name: 'fx-decals',
      map: textures.decalAlbedo, normalMap: textures.decalNormal,
      roughnessMap: textures.decalOrm, metalnessMap: textures.decalOrm,
      roughness: 1, metalness: 1, vertexColors: true,
      transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.userData.fx = true;
    scene?.add(this.mesh);
    this.head = 0;
    this.count = 0;
    this.dmin = Infinity; this.dmax = -1;
    this._hit = null; this._hitD = 0;
    this._N = new THREE.Vector3();
    this._P = new THREE.Vector3();
    this._findFn = (b) => this._testBrush(b);
    this.lastClipped = 0;
    this._attrs = [this.aPos, this.aNrm, this.aUv, this.aCol];
  }

  _testBrush(b) {
    if (!(b.contents & SOLID)) return;
    const P = this._P, N = this._N;
    let face = null, best = 1.5;
    for (const pl of b.planes) {
      if (pl.bevel) continue;
      if (pl.n.x * N.x + pl.n.y * N.y + pl.n.z * N.z < 0.9) continue;
      const d = Math.abs(pl.n.dot(P) - pl.dist);
      if (d < best) { best = d; face = pl; }
    }
    if (!face) return;
    // P must lie within the face (inside every other plane, with tolerance)
    for (const pl of b.planes) {
      if (pl === face || pl.bevel) continue;
      if (pl.n.dot(P) - pl.dist > 0.75) return;
    }
    if (!this._hit || best < this._hitD) { this._hit = b; this._hitFace = face; this._hitD = best; }
  }

  /** Surface continues at q (solid just behind, open just in front)? */
  _continues(q, N) {
    const col = World.collision;
    _m.copy(q).addScaledVector(N, -0.75);
    if (!(col.pointContents(_m) & SOLID)) return false;
    _m.copy(q).addScaledVector(N, 0.75);
    return !(col.pointContents(_m) & SOLID);
  }

  /**
   * Add a decal. type: DECAL_TYPES key. size: world units (edge). rot: radians.
   * surface: surface key (tints bullet holes). alpha: 0..1. Returns true if placed.
   */
  add(point, normal, type, size, rot, surface, alpha = 1, variant = 0) {
    const T = DECAL_TYPES[type] || DECAL_TYPES.bullet_concrete;
    size = size || T.size;
    const N = this._N.copy(normal).normalize();
    const P = this._P.copy(point);
    const col = World.collision;
    this._hit = null; this._hitFace = null;
    if (col?.brushesIn) {
      _min.set(P.x - 2, P.y - 2, P.z - 2); _max.set(P.x + 2, P.y + 2, P.z + 2);
      col.brushesIn(_min, _max, this._findFn);
    }
    const brush = this._hit, face = this._hitFace;
    if (face) {
      // snap to the exact face plane
      N.copy(face.n);
      P.addScaledVector(N, face.dist - N.dot(P));
    }
    // tangent frame
    if (Math.abs(N.y) < 0.9) _t.set(0, 1, 0).cross(N).normalize(); else _t.set(1, 0, 0).cross(N).normalize();
    _b.crossVectors(N, _t);
    if (!T.grain) {
      const c = Math.cos(rot), s = Math.sin(rot);
      _q.copy(_t).multiplyScalar(c).addScaledVector(_b, s);
      _b.multiplyScalar(c).addScaledVector(_t, -s);
      _t.copy(_q);
    } else if (Math.abs(N.y) < 0.9 && rot > Math.PI) {
      _t.negate(); _b.negate();
    }
    const eps = T.big ? 0.12 : 0.06;
    let tries = T.big ? 3 : 1;
    let n = 0, poly = PA;
    while (tries-- > 0) {
      const h = size * 0.5;
      // quad (CCW seen from the front)
      poly = PA;
      for (let i = 0; i < 4; i++) {
        const o = i * 3, u = QU[i] * h, v = QV[i] * h;
        poly[o] = P.x + _t.x * u + _b.x * v;
        poly[o + 1] = P.y + _t.y * u + _b.y * v;
        poly[o + 2] = P.z + _t.z * u + _b.z * v;
      }
      n = 4;
      let clipped = 0;
      if (brush && col) {
        for (const pl of brush.planes) {
          if (pl === face || pl.bevel) continue;
          const nd = pl.n.x * N.x + pl.n.y * N.y + pl.n.z * N.z;
          if (nd > 0.98 || nd < -0.98) continue;
          // any vertex outside?
          let out = false;
          for (let i = 0; i < n; i++) {
            const o = i * 3;
            if (pl.n.x * poly[o] + pl.n.y * poly[o + 1] + pl.n.z * poly[o + 2] - pl.dist > 0.01) { out = true; break; }
          }
          if (!out) continue;
          // does the surface continue past this edge?
          _m.copy(pl.n).addScaledVector(N, -nd);
          const ml = _m.length();
          if (ml > 1e-3) {
            _m.multiplyScalar(1 / ml);
            const k = (pl.dist - pl.n.dot(P)) / Math.max(pl.n.dot(_m), 1e-3) + 1.5;
            _q.copy(P).addScaledVector(_m, k);
            if (this._continues(_q, N)) continue;
          }
          const dst = poly === PA ? PB : PA;
          n = clipPoly(poly, n, pl.n, pl.dist, dst);
          poly = dst;
          clipped++;
          if (n < 3) break;
        }
      }
      this.lastClipped = clipped;
      if (n < 3) return false;
      if (!T.big || !col) break;
      // big decals: if a corner hangs over empty space (a ledge), shrink and retry
      let bad = 0;
      for (let i = 0; i < n; i++) {
        _q.set(poly[i * 3], poly[i * 3 + 1], poly[i * 3 + 2]);
        if (!this._continues(_q, N)) bad++;
      }
      if (bad <= 1) break;
      size *= 0.7;
    }
    if (n > MAXV) n = MAXV;

    // write slot
    const slot = this.head;
    this.head = (slot + 1) % MAXD;
    if (this.count < MAXD) this.count++;
    const cells = T.cells;
    const cell = cells[variant % cells.length];
    const cu = (cell % 4) * 0.25, cv = Math.floor(cell / 4) * 0.25;
    const inset = 0.002;
    // tint
    let r = 1, g = 1, bl = 1;
    if (T.tint > 0) {
      _c.setHex(SURFACES[surface]?.dustColor ?? 0xbdb3a3);
      r = Math.min(1, _c.r * T.tint); g = Math.min(1, _c.g * T.tint); bl = Math.min(1, _c.b * T.tint);
    }
    const inv = 1 / size;
    const vb = slot * MAXV;
    for (let i = 0; i < MAXV; i++) {
      const j = Math.min(i, n - 1);
      const px = poly[j * 3] + N.x * eps, py = poly[j * 3 + 1] + N.y * eps, pz = poly[j * 3 + 2] + N.z * eps;
      const o3 = (vb + i) * 3, o2 = (vb + i) * 2, o4 = (vb + i) * 4;
      this.pos[o3] = px; this.pos[o3 + 1] = py; this.pos[o3 + 2] = pz;
      this.nrm[o3] = N.x; this.nrm[o3 + 1] = N.y; this.nrm[o3 + 2] = N.z;
      const dx = poly[j * 3] - P.x, dy = poly[j * 3 + 1] - P.y, dz = poly[j * 3 + 2] - P.z;
      const u = (dx * _t.x + dy * _t.y + dz * _t.z) * inv + 0.5;
      const v = (dx * _b.x + dy * _b.y + dz * _b.z) * inv + 0.5;
      this.uv[o2] = cu + inset + u * (0.25 - 2 * inset);
      this.uv[o2 + 1] = cv + inset + v * (0.25 - 2 * inset);
      this.col[o4] = r; this.col[o4 + 1] = g; this.col[o4 + 2] = bl; this.col[o4 + 3] = alpha;
    }
    const ib = slot * MAXI;
    const idx = this.aIdx.array;
    for (let k = 0; k < MAXV - 2; k++) {
      const o = ib + k * 3;
      if (k < n - 2) { idx[o] = vb; idx[o + 1] = vb + k + 1; idx[o + 2] = vb + k + 2; }
      else { idx[o] = vb; idx[o + 1] = vb; idx[o + 2] = vb; }
    }
    if (slot < this.dmin) this.dmin = slot;
    if (slot > this.dmax) this.dmax = slot;
    return true;
  }

  flush() {
    if (this.dmax < 0) return;
    const a = this.dmin, c = this.dmax - this.dmin + 1;
    for (let q = 0; q < 4; q++) {
      const attr = this._attrs[q], k = ATTR_K[q];
      queueRange(attr, a * MAXV * k, c * MAXV * k);
    }
    queueRange(this.aIdx, a * MAXI, c * MAXI);
    this.geo.setDrawRange(0, this.count * MAXI);
    this.dmin = Infinity; this.dmax = -1;
  }

  clear() {
    this.aIdx.array.fill(0);
    this.count = 0; this.head = 0;
    this.dmin = 0; this.dmax = MAXD - 1;
  }
}

/** Clip polygon (flat xyz array, n verts) to the half-space n·p <= d. Returns new count. */
function clipPoly(src, n, pn, d, dst) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = src[i * 3], ay = src[i * 3 + 1], az = src[i * 3 + 2];
    const bx = src[j * 3], by = src[j * 3 + 1], bz = src[j * 3 + 2];
    const da = pn.x * ax + pn.y * ay + pn.z * az - d;
    const db = pn.x * bx + pn.y * by + pn.z * bz - d;
    if (da <= 0) { if (m < MAXV * 2) { dst[m * 3] = ax; dst[m * 3 + 1] = ay; dst[m * 3 + 2] = az; m++; } }
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      if (m < MAXV * 2) {
        dst[m * 3] = ax + (bx - ax) * t; dst[m * 3 + 1] = ay + (by - ay) * t; dst[m * 3 + 2] = az + (bz - az) * t; m++;
      }
    }
  }
  return m;
}
