// Procedural skinned-mesh builder. Everything is authored in the bind pose (see skeleton.js).
// Parts are made of UV "islands" measured in world units; paint.js packs the islands into a
// texture atlas and bakes each part's paint function into albedo / normal / ORM maps, so a
// whole character is ONE geometry + ONE material (a single draw call).
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export class MeshBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.skin = []; this.idx = [];
    this.islands = [];   // { part, u0, v0, u1, v1, vStart, vEnd, iStart, iEnd }
    this.parts = [];     // { name, paint, group, data }
    this.cur = null;
  }

  /** Start a new part; subsequent geometry is painted with `paint` (a function or key). */
  part(name, paint, opts = {}) {
    this.cur = { name, paint, group: opts.group || 'core', data: opts.data || {}, id: this.parts.length };
    this.parts.push(this.cur);
    return this.cur;
  }

  _beginIsland() { return { part: this.cur, vStart: this.pos.length / 3, iStart: this.idx.length }; }
  _endIsland(isl) {
    isl.vEnd = this.pos.length / 3; isl.iEnd = this.idx.length;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (let k = isl.vStart; k < isl.vEnd; k++) {
      const u = this.uv[k * 2], w = this.uv[k * 2 + 1];
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < v0) v0 = w; if (w > v1) v1 = w;
    }
    Object.assign(isl, { u0, v0, u1, v1 });
    if (isl.vEnd > isl.vStart) this.islands.push(isl);
    return isl;
  }

  _vert(p, n, u, v, skin) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.uv.push(u, v);
    this.skin.push(normSkin(typeof skin === 'function' ? skin(p) : skin));
    return this.pos.length / 3 - 1;
  }

  /**
   * Parametric grid surface. fn(i, j, outPos) fills the point for column i (0..nu, around) and
   * row j (0..nv, along). Normals come from central differences (wrapping in u when `wrap`),
   * UVs from arc length (world units). Triangles wind so the normal points "outward" when
   * du x dv does; pass flip:true to reverse.
   */
  surface(nu, nv, fn, skin, o = {}) {
    const wrap = !!o.wrap;
    const cols = nu + 1, rows = nv + 1;
    const P = new Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const p = new THREE.Vector3();
      fn(wrap && i === nu ? 0 : i, j, p);
      P[j * cols + i] = p;
    }
    const at = (i, j) => P[j * cols + i];
    // arc-length UVs
    const U = new Float32Array(cols * rows), V = new Float32Array(cols * rows);
    let maxLen = 0;
    const rowLen = new Float32Array(rows);
    for (let j = 0; j < rows; j++) {
      let s = 0;
      for (let i = 1; i < cols; i++) s += at(i, j).distanceTo(at(i - 1, j));
      rowLen[j] = s; if (s > maxLen) maxLen = s;
    }
    for (let j = 0; j < rows; j++) {
      let s = 0;
      const sc = rowLen[j] > 1e-6 ? maxLen / rowLen[j] : 0;
      for (let i = 0; i < cols; i++) {
        if (i > 0) s += at(i, j).distanceTo(at(i - 1, j));
        U[j * cols + i] = rowLen[j] > 1e-6 ? s * sc : (i / nu) * maxLen;
      }
    }
    // v: average arc length along columns
    let vacc = 0;
    for (let j = 0; j < rows; j++) {
      if (j > 0) {
        let s = 0;
        for (let i = 0; i < cols; i++) s += at(i, j).distanceTo(at(i, j - 1));
        vacc += s / cols;
      }
      for (let i = 0; i < cols; i++) V[j * cols + i] = vacc;
    }
    if (o.uScale) for (let k = 0; k < U.length; k++) U[k] *= o.uScale;
    // normals
    const N = new Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      let il = i - 1, ir = i + 1;
      if (wrap) { if (il < 0) il = nu - 1; if (ir > nu) ir = 1; }
      else { il = Math.max(0, il); ir = Math.min(nu, ir); }
      const jd = Math.max(0, j - 1), ju = Math.min(nv, j + 1);
      _a.subVectors(at(ir, j), at(il, j));
      _b.subVectors(at(i, ju), at(i, jd));
      const n = new THREE.Vector3().crossVectors(_a, _b);
      if (n.lengthSq() < 1e-10) {
        // pole: point away from the neighbouring ring's centroid
        const jn = j === 0 ? 1 : j === nv ? nv - 1 : j;
        _c.set(0, 0, 0);
        for (let k = 0; k < nu; k++) _c.add(at(k, jn));
        _c.multiplyScalar(1 / nu);
        n.subVectors(at(i, j), _c);
        if (n.lengthSq() < 1e-10) n.copy(_b).negate();
      }
      n.normalize();
      if (o.flip) n.negate();
      N[j * cols + i] = n;
    }
    const isl = this._beginIsland();
    const base = this.pos.length / 3;
    for (let k = 0; k < P.length; k++) {
      const i = k % cols, j = (k / cols) | 0;
      const sk = typeof skin === 'function' ? skin(P[k], i / nu, j / nv, i, j) : skin;
      this.pos.push(P[k].x, P[k].y, P[k].z); this.nrm.push(N[k].x, N[k].y, N[k].z);
      this.uv.push(U[k], V[k]); this.skin.push(normSkin(sk));
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      if (o.flip) this.idx.push(a, c, b, b, c, d);
      else this.idx.push(a, b, c, b, d, c);
    }
    this._endIsland(isl);
    return isl;
  }

  /**
   * Loft along a list of rings. Ring: { c: Vector3 centre, t: axis dir, f: 'front' dir,
   * rf, rb, rl, rr: quadrant radii (front/back/left/right), n: superellipse exponent,
   * bump?(theta, ring) -> extra radius }. theta 0 = front, 90° = left of (t x f).
   * Left here means t x f; with t = +Y and f = +X that's -Z (the character's left).
   */
  loft(rings, nu, skin, o = {}) {
    const seam = o.seam ?? Math.PI;          // seam angle (hidden side)
    const frames = rings.map((r) => {
      const t = r.t.clone().normalize();
      const f = r.f.clone().addScaledVector(t, -r.f.dot(t)).normalize();
      const l = new THREE.Vector3().crossVectors(t, f);
      return { t, f, l };
    });
    // optional resampling: `sub` extra rings between each pair (Catmull-Rom on params)
    const R = o.sub ? resampleRings(rings, frames, o.sub) : rings.map((r, k) => ({ r, fr: frames[k] }));
    const fn = (i, j, out) => {
      const { r, fr } = R[j];
      const th = seam + (i / nu) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const ex = 2 / (r.n || 2);
      const ax = c >= 0 ? r.rf : r.rb, ay = s >= 0 ? r.rl : r.rr;
      let x = Math.sign(c) * Math.pow(Math.abs(c), ex) * ax;
      let y = Math.sign(s) * Math.pow(Math.abs(s), ex) * ay;
      if (r.bump) {
        const k = r.bump(th, r, x, y);
        const len = Math.hypot(x, y) || 1;
        x += (x / len) * k; y += (y / len) * k;
      }
      out.copy(r.c).addScaledVector(fr.f, x).addScaledVector(fr.l, y);
    };
    return this.surface(nu, R.length - 1, fn, skin, { wrap: true, ...o });
  }

  /** Rounded box. c: centre, h: half extents, r: corner radius, q: quaternion, bend: curvature
   *  around local Y (positive curls the +/-Z ends toward -X). One UV island per face. */
  rbox(c, h, r, q, skin, o = {}) {
    const seg = o.seg ?? 2;
    const inner = new THREE.Vector3(Math.max(1e-4, h.x - r), Math.max(1e-4, h.y - r), Math.max(1e-4, h.z - r));
    const bend = o.bend || 0, taper = o.taper || 0;
    const axisVals = (hh, ii) => {
      const out = [-hh];
      for (let k = 1; k <= seg; k++) out.push(-ii - r * Math.tan((Math.PI / 4) * (1 - k / seg)));
      const mid = o.mid ?? 1;
      for (let k = 1; k < mid; k++) out.push(-ii + (2 * ii * k) / mid);
      for (let k = seg; k >= 1; k--) out.push(ii + r * Math.tan((Math.PI / 4) * (1 - k / seg)));
      out.push(hh);
      return out;
    };
    const faces = [
      [0, 1, 2, 1], [0, 2, 1, -1], [1, 2, 0, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 1, 0, -1],
    ]; // [normal axis, u axis, v axis, sign]
    const hv = [h.x, h.y, h.z], iv = [inner.x, inner.y, inner.z];
    const skipFaces = o.skip || [];
    for (let fi = 0; fi < 6; fi++) {
      if (skipFaces.includes(fi)) continue;
      const [na, ua, va, sg] = faces[fi];
      const us = axisVals(hv[ua], iv[ua]), vs = axisVals(hv[va], iv[va]);
      const nu = us.length - 1, nv = vs.length - 1;
      const isl = this._beginIsland();
      const base = this.pos.length / 3;
      const p = new THREE.Vector3(), cl = new THREE.Vector3(), n = new THREE.Vector3(), w = new THREE.Vector3();
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const a = [0, 0, 0];
        a[na] = hv[na] * sg; a[ua] = us[i]; a[va] = vs[j];
        p.set(a[0], a[1], a[2]);
        // taper: shrink x/z extents toward +Y
        cl.set(clamp(p.x, -inner.x, inner.x), clamp(p.y, -inner.y, inner.y), clamp(p.z, -inner.z, inner.z));
        n.subVectors(p, cl);
        if (n.lengthSq() < 1e-12) { n.set(0, 0, 0); n.setComponent(na, sg); }
        n.normalize();
        p.copy(cl).addScaledVector(n, r);
        if (taper) { const k = 1 - taper * (p.y / h.y) * 0.5; p.x *= k; p.z *= k; }
        if (bend) {
          const dz = p.z; p.x -= bend * dz * dz;
          n.z += 2 * bend * dz * n.x; n.normalize();
        }
        w.copy(p).applyQuaternion(q || IDQ).add(c);
        n.applyQuaternion(q || IDQ);
        this.pos.push(w.x, w.y, w.z); this.nrm.push(n.x, n.y, n.z);
        this.uv.push(us[i] + hv[ua], vs[j] + hv[va]);
        this.skin.push(normSkin(typeof skin === 'function' ? skin(w) : skin));
      }
      const cols = nu + 1;
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a0 = base + j * cols + i, b0 = a0 + 1, c0 = a0 + cols, d0 = c0 + 1;
        // orientation: ensure CCW when viewed from outside
        this.idx.push(a0, b0, c0, b0, d0, c0);
      }
      // fix winding per face by checking the first triangle against its normal
      const t0 = this.idx.length - nu * nv * 6;
      fixWinding(this, t0, this.idx.length);
      const res = this._endIsland(isl);
      res.face = fi;
    }
  }

  /** Tube (round or rectangular section) swept along a polyline with parallel transport. */
  tube(path, radius, nu, skin, o = {}) {
    const pts = o.smooth ? catmull(path, o.smooth, o.closed) : path;
    const n = pts.length;
    const T = [], Nn = [], Bn = [];
    for (let k = 0; k < n; k++) {
      const a = pts[o.closed ? (k - 1 + n) % n : Math.max(0, k - 1)];
      const b = pts[o.closed ? (k + 1) % n : Math.min(n - 1, k + 1)];
      T.push(new THREE.Vector3().subVectors(b, a).normalize());
    }
    const up = o.up ? o.up.clone() : new THREE.Vector3(0, 1, 0);
    if (Math.abs(up.dot(T[0])) > 0.95) up.set(1, 0, 0);
    Nn.push(new THREE.Vector3().crossVectors(T[0], up).normalize());
    for (let k = 1; k < n; k++) {
      const prev = Nn[k - 1];
      const nn = prev.clone().addScaledVector(T[k], -prev.dot(T[k])).normalize();
      Nn.push(nn);
    }
    for (let k = 0; k < n; k++) Bn.push(new THREE.Vector3().crossVectors(T[k], Nn[k]).normalize());
    const rect = o.rect; // [halfW (along N), halfH (along B)]
    const rows = o.closed ? n : n - 1;
    const fn = (i, j, out) => {
      const k = j % n;
      const th = (i / nu) * Math.PI * 2;
      const rr = typeof radius === 'function' ? radius(j / rows) : radius;
      let x, y;
      if (rect) {
        const c = Math.cos(th), s = Math.sin(th), e = 2 / (o.n || 8);
        x = Math.sign(c) * Math.pow(Math.abs(c), e) * rect[0];
        y = Math.sign(s) * Math.pow(Math.abs(s), e) * rect[1];
      } else { x = Math.cos(th) * rr; y = Math.sin(th) * rr; }
      out.copy(pts[k]).addScaledVector(Nn[k], x).addScaledVector(Bn[k], y);
    };
    return this.surface(nu, rows, fn, skin, { wrap: true, ...o });
  }

  /** Ellipsoid (optionally partial in latitude). c centre, r radii (Vector3), q rotation. */
  ellipsoid(c, r, q, nu, nv, skin, o = {}) {
    const lat0 = o.lat0 ?? -Math.PI / 2, lat1 = o.lat1 ?? Math.PI / 2;
    const fn = (i, j, out) => {
      const th = (i / nu) * Math.PI * 2 + (o.seam ?? Math.PI);
      const la = lat0 + (lat1 - lat0) * (j / nv);
      out.set(Math.cos(la) * Math.cos(th) * r.x, Math.sin(la) * r.y, -Math.cos(la) * Math.sin(th) * r.z);
      if (o.warp) o.warp(out, th, la);
      if (q) out.applyQuaternion(q);
      out.add(c);
    };
    return this.surface(nu, nv, fn, skin, { wrap: true, ...o });
  }

  /** Finished geometry. uv is still in island-local world units until paint.js remaps it. */
  build() {
    const nv = this.pos.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
    for (let k = 0; k < nv; k++) {
      const s = this.skin[k];
      for (let m = 0; m < 4; m++) { si[k * 4 + m] = s[m * 2]; sw[k * 4 + m] = s[m * 2 + 1]; }
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(this.idx);
    return g;
  }
}

const IDQ = new THREE.Quaternion();
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function fixWinding(mb, i0, i1) {
  // Flip every triangle in [i0,i1) whose geometric normal opposes its vertex normals.
  const P = mb.pos, N = mb.nrm, I = mb.idx;
  for (let t = i0; t < i1; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    _a.set(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
    _b.set(P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]);
    _c.crossVectors(_a, _b);
    _d.set(N[a * 3] + N[b * 3] + N[c * 3], N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]);
    if (_c.dot(_d) < 0) { I[t + 1] = c; I[t + 2] = b; }
  }
}

/** Normalise [[bone, w], ...] into a flat [b0,w0,b1,w1,b2,w2,b3,w3] keeping the top 4. */
export function normSkin(sk) {
  if (!sk) return [0, 1, 0, 0, 0, 0, 0, 0];
  if (typeof sk === 'number') return [sk, 1, 0, 0, 0, 0, 0, 0];
  const m = new Map();
  for (const [b, w] of sk) if (w > 1e-4) m.set(b, (m.get(b) || 0) + w);
  const arr = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  const tot = arr.reduce((s, x) => s + x[1], 0) || 1;
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  arr.forEach(([b, w], k) => { out[k * 2] = b; out[k * 2 + 1] = w / tot; });
  if (!arr.length) out[1] = 1;
  return out;
}

function catmull(pts, sub, closed) {
  const out = [];
  const n = pts.length;
  const get = (k) => closed ? pts[(k + n) % n] : pts[Math.max(0, Math.min(n - 1, k))];
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p0 = get(k - 1), p1 = get(k), p2 = get(k + 1), p3 = get(k + 2);
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      out.push(new THREE.Vector3(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)));
    }
  }
  if (!closed) out.push(pts[n - 1].clone());
  return out;
}

function resampleRings(rings, frames, sub) {
  // Smoothly interpolate ring parameters (Catmull-Rom on centre, linear-smooth on radii).
  const out = [];
  const n = rings.length;
  const keys = ['rf', 'rb', 'rl', 'rr', 'n'];
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  for (let k = 0; k < n - 1; k++) {
    const r0 = rings[Math.max(0, k - 1)], r1 = rings[k], r2 = rings[k + 1], r3 = rings[Math.min(n - 1, k + 2)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const r = { bump: r1.bump || r2.bump, n: 2 };
      for (const key of keys) r[key] = Math.max(0, cr(r0[key] ?? 2, r1[key] ?? 2, r2[key] ?? 2, r3[key] ?? 2, t));
      r.c = new THREE.Vector3(cr(r0.c.x, r1.c.x, r2.c.x, r3.c.x, t), cr(r0.c.y, r1.c.y, r2.c.y, r3.c.y, t), cr(r0.c.z, r1.c.z, r2.c.z, r3.c.z, t));
      r.param = (r1.param ?? k) + ((r2.param ?? k + 1) - (r1.param ?? k)) * t;
      const f0 = frames[k], f1 = frames[k + 1];
      const tt = f0.t.clone().lerp(f1.t, t).normalize();
      const ff = f0.f.clone().lerp(f1.f, t);
      ff.addScaledVector(tt, -ff.dot(tt)).normalize();
      out.push({ r, fr: { t: tt, f: ff, l: new THREE.Vector3().crossVectors(tt, ff) } });
    }
  }
  const last = rings[n - 1];
  out.push({ r: { ...last, param: last.param ?? n - 1 }, fr: frames[n - 1] });
  return out;
}

// ---- skin weight helpers -------------------------------------------------------------------

/** Weights along a chain of joints: bones[k] spans joints[k] -> joints[k+1]. Blends across each
 *  interior joint over +/- `blend` units using the bisector plane at that joint. */
export function chainWeights(joints, bones, blend = 2) {
  const dirs = [];
  for (let k = 0; k < joints.length - 1; k++) dirs.push(joints[k + 1].clone().sub(joints[k]).normalize());
  const bis = [];
  for (let k = 1; k < joints.length - 1; k++) bis.push(dirs[k - 1].clone().add(dirs[k]).normalize());
  const tmp = new THREE.Vector3();
  const bl = Array.isArray(blend) ? blend : bones.map(() => blend);
  return (p) => {
    // walk joints: find signed distance to each interior joint's bisector plane
    let w = [[bones[0], 1]];
    for (let k = 0; k < bis.length; k++) {
      const d = tmp.subVectors(p, joints[k + 1]).dot(bis[k]);
      const t = smooth(-bl[k], bl[k], d);
      if (t <= 0) break;
      w = w.map(([b, x]) => [b, x * (1 - t)]);
      w.push([bones[k + 1], t]);
      if (t < 1) break;
    }
    return w;
  };
}

export function smooth(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
