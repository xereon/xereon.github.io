// Shared modelling kit for props: seeded RNG, chamfered boards, lathes, sweeps, UV
// projection, vertex-colour weathering, per-material geometry buckets and collider maths.
// Everything here is pure geometry (no textures) so it also runs under node.
import * as THREE from 'three';

// ---- random -------------------------------------------------------------------------------
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export class Rand {
  constructor(seed = 1) { this.s = (typeof seed === 'string' ? hashStr(seed) : seed) >>> 0 || 1; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  f(a = 0, b = 1) { return a + (b - a) * this.next(); }
  i(a, b) { return Math.floor(this.f(a, b + 1 - 1e-9)); }
  pick(a) { return a[Math.floor(this.next() * a.length) % a.length]; }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const DEG = Math.PI / 180;

// ---- 2D polygon helpers (arrays of [x, y]) ------------------------------------------------
export function rect(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
export function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return a / 2;
}
export function ccw(p) { return polyArea(p) < 0 ? p.slice().reverse() : p; }
/** Inset a convex CCW polygon by d (negative d grows it). */
export function offsetPoly(p, d) {
  const n = p.length, lines = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const nx = -dy, ny = dx; // inward normal for CCW
    lines.push([a[0] + nx * d, a[1] + ny * d, dx, dy]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L0 = lines[(i + n - 1) % n], L1 = lines[i];
    const den = L0[2] * L1[3] - L0[3] * L1[2];
    if (Math.abs(den) < 1e-9) { out.push([L1[0], L1[1]]); continue; }
    const t = ((L1[0] - L0[0]) * L1[3] - (L1[1] - L0[1]) * L1[2]) / den;
    out.push([L0[0] + L0[2] * t, L0[1] + L0[3] * t]);
  }
  return out;
}
/** Sutherland–Hodgman: keep the part where a*x + b*y + c <= 0. */
export function clipHalf(p, a, b, c) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const P = p[i], Q = p[(i + 1) % p.length];
    const dp = a * P[0] + b * P[1] + c, dq = a * Q[0] + b * Q[1] + c;
    if (dp <= 0) out.push(P);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
    }
  }
  return out;
}
/** Band of width w along p0->p1 (infinite), clipped to polygon `clip`. side: -1/0/1 restricts to one side of another band. */
export function bandPoly(p0, p1, w, clip) {
  let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const l = Math.hypot(dx, dy); dx /= l; dy /= l;
  const nx = -dy, ny = dx, c0 = nx * p0[0] + ny * p0[1];
  let p = clip.slice();
  p = clipHalf(p, nx, ny, -(c0 + w / 2));
  p = clipHalf(p, -nx, -ny, c0 - w / 2);
  return p;
}
/** Half-plane helpers for splitting a polygon by the band along p0->p1 (keep outside band on side s). */
export function clipOutsideBand(p, p0, p1, w, s) {
  let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const l = Math.hypot(dx, dy); dx /= l; dy /= l;
  const nx = -dy, ny = dx, c0 = nx * p0[0] + ny * p0[1];
  // s = +1 keep n·x >= c0 + w/2 ; s = -1 keep n·x <= c0 - w/2
  return s > 0 ? clipHalf(p, -nx, -ny, c0 + w / 2) : clipHalf(p, nx, ny, -(c0 - w / 2));
}

// ---- geometry builders ----------------------------------------------------------------------
/**
 * Chamfered slab from a convex polygon in XY, occupying z = 0..t. Flat-shaded, non-indexed.
 * c = chamfer size. back=false leaves the back edges sharp (board lying on a surface).
 * Each vertex gets a `kind` tag in geo.userData.kinds: 0 face, 1 chamfer, 2 side.
 */
export function slab(pts, t, c = 0.3, back = true, cap = true) {
  const P = ccw(pts);
  c = Math.max(0, Math.min(c, t * (back ? 0.45 : 0.9)));
  const I = c > 0 ? offsetPoly(P, c) : P;
  const pos = [], kinds = [];
  const tri = (a, b, d, k) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]); kinds.push(k, k, k); };
  const quad = (a, b, d, e, k) => { tri(a, b, d, k); tri(a, d, e, k); };
  const n = P.length;
  const z0 = back ? c : 0, z1 = t - c;
  // front cap (z = t), CCW seen from +z
  for (let i = 1; i < n - 1; i++) tri([I[0][0], I[0][1], t], [I[i][0], I[i][1], t], [I[i + 1][0], I[i + 1][1], t], 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = P[i], b = P[j], ia = I[i], ib = I[j];
    if (c > 0) quad([a[0], a[1], z1], [b[0], b[1], z1], [ib[0], ib[1], t], [ia[0], ia[1], t], 1);
    quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], 2);
    if (back && c > 0) quad([ia[0], ia[1], 0], [ib[0], ib[1], 0], [b[0], b[1], c], [a[0], a[1], c], 1);
  }
  if (cap) {
    const B = back && c > 0 ? I : P;
    for (let i = 1; i < n - 1; i++) tri([B[0][0], B[0][1], 0], [B[i + 1][0], B[i + 1][1], 0], [B[i][0], B[i][1], 0], 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.userData.kinds = kinds;
  return g;
}

/** Axis-aligned chamfered box from min/max corners. */
export function cbox(min, max, c = 0.3) {
  const g = slab(rect(min[0], min[1], max[0], max[1]), max[2] - min[2], c, true);
  g.translate(0, 0, min[2]);
  return g;
}

/**
 * Lathe around +Y. profile: [[r, y, sharp?], ...] bottom to top. Rings are shared between
 * segments except at sharp points (hard edge). v = profile arc length (units), u = rRef * angle.
 */
export function lathe(profile, segs = 16, { phi0 = 0, phi = Math.PI * 2, uRef = null } = {}) {
  const n = profile.length;
  const L = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const rRef = uRef ?? Math.max(...profile.map((p) => p[0]));
  const sn = [];
  for (let i = 0; i < n - 1; i++) {
    const dr = profile[i + 1][0] - profile[i][0], dy = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dr, dy) || 1; sn.push([dy / l, -dr / l]);
  }
  const pos = [], nrm = [], uv = [], idx = [];
  const ring = (pi, nr, ny) => {
    const [r, y] = profile[pi], base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const a = phi0 + (s / segs) * phi, ca = Math.cos(a), sa = Math.sin(a);
      pos.push(r * sa, y, r * ca); nrm.push(nr * sa, ny, nr * ca); uv.push((s / segs) * phi * rRef, L[pi]);
    }
    return base;
  };
  const avg = (a, b) => { const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  let prevEnd = -1;
  for (let i = 0; i < n - 1; i++) {
    let start;
    if (i === 0) start = ring(0, sn[0][0], sn[0][1]);
    else if (profile[i][2]) start = ring(i, sn[i][0], sn[i][1]);
    else start = prevEnd;
    let end;
    if (i + 1 === n - 1 || profile[i + 1][2]) end = ring(i + 1, sn[i][0], sn[i][1]);
    else { const m = avg(sn[i], sn[i + 1]); end = ring(i + 1, m[0], m[1]); }
    for (let s = 0; s < segs; s++) { const a = start + s, b = a + 1, c = end + s, d = c + 1; idx.push(a, b, c, b, d, c); }
    prevEnd = end;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.userData.latheSegs = segs;
  return g;
}
/** Recompute smooth normals of a (displaced) full lathe, welding the u seam. */
export function relathe(g) {
  const segs = g.userData.latheSegs;
  g.computeVertexNormals();
  const nr = g.attributes.normal, rings = nr.count / (segs + 1);
  for (let r = 0; r < rings; r++) {
    const a = r * (segs + 1), b = a + segs;
    const x = nr.getX(a) + nr.getX(b), y = nr.getY(a) + nr.getY(b), z = nr.getZ(a) + nr.getZ(b), l = Math.hypot(x, y, z) || 1;
    nr.setXYZ(a, x / l, y / l, z / l); nr.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Flat disc (cap) at height y facing up (dir=1) or down (dir=-1). */
export function disc(r, y, segs = 16, dir = 1) {
  const g = new THREE.CircleGeometry(r, segs);
  g.rotateX(dir > 0 ? -Math.PI / 2 : Math.PI / 2);
  g.translate(0, y, 0);
  const uv = g.attributes.uv, p = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i), p.getZ(i));
  return g;
}

/**
 * Sweep a circle (or n-gon) along a curve with variable radius. Parallel-transport frames.
 * rad: number | (t) => number. u along length (units), v around (units).
 */
export function sweep(curve, segs = 16, radial = 6, rad = 1, { caps = false, twist = 0 } = {}) {
  const frames = curve.computeFrenetFrames(segs, false);
  const pos = [], nrm = [], uv = [], idx = [];
  const p = new THREE.Vector3();
  let len = 0; const prev = curve.getPointAt(0);
  const rf = typeof rad === 'function' ? rad : () => rad;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, p);
    len += p.distanceTo(prev); prev.copy(p);
    const N = frames.normals[i], B = frames.binormals[i], r = rf(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2 + twist * t;
      const cx = Math.cos(a), sx = Math.sin(a);
      const nx = cx * N.x + sx * B.x, ny = cx * N.y + sx * B.y, nz = cx * N.z + sx * B.z;
      pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r);
      nrm.push(nx, ny, nz);
      uv.push(len, (j / radial) * Math.PI * 2 * r);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  if (!caps) return g;
  const parts = [g];
  for (const end of [0, 1]) {
    const c = curve.getPointAt(end), T = curve.getTangentAt(end), r = rf(end);
    const d = new THREE.CircleGeometry(r, radial);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), end ? T : T.clone().negate());
    d.applyQuaternion(q); d.translate(c.x, c.y, c.z);
    parts.push(d);
  }
  return merge(parts);
}

/** Straight cylinder between two points. */
export function rod(a, b, r, radial = 8, caps = true) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, L, radial, 1, !caps);
  const uv = g.attributes.uv, p = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, p.getY(i) + L / 2);
  g.translate(0, L / 2, 0);
  const dir = B.clone().sub(A).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate(A.x, A.y, A.z);
  return g;
}

/** Low-poly dome (rivet / bolt head) sitting on z=0 facing +z. */
export function dome(r, h, radial = 6) {
  const prof = [[r, 0, true], [r * 0.78, h * 0.7], [0.001, h]];
  const g = lathe(prof, radial);
  g.rotateX(Math.PI / 2);
  return g;
}
/** Hex bolt head facing +z. */
export function hexBolt(r, h) {
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return slab(pts, h, h * 0.3, false);
}

// ---- attribute helpers ----------------------------------------------------------------------
export function nonIndexed(g) { return g.index ? g.toNonIndexed() : g; }

/**
 * Box-projected UVs in local units * scale, chosen per triangle by dominant face normal.
 * Works on non-indexed geometry (converted if needed). `up` faces use (x, z).
 */
export function boxUV(g, scale = 1 / 64, off = [0, 0]) {
  g = nonIndexed(g);
  const p = g.attributes.position, n = p.count, uv = new Float32Array(n * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    fn.subVectors(c, b).cross(b.clone().sub(a));
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      const x = p.getX(i + k), y = p.getY(i + k), z = p.getZ(i + k);
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
      uv[(i + k) * 2] = u * scale + off[0]; uv[(i + k) * 2 + 1] = v * scale + off[1];
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Scale/offset an existing uv attribute. */
export function uvXform(g, su, sv, ou = 0, ov = 0) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  return g;
}

/** Set a constant or computed vertex colour. fn(x,y,z,nx,ny,nz,i) -> [r,g,b] */
export function paint(g, col) {
  const p = g.attributes.position, nr = g.attributes.normal, n = p.count;
  const arr = new Float32Array(n * 3);
  if (typeof col === 'function') {
    for (let i = 0; i < n; i++) {
      const c = col(p.getX(i), p.getY(i), p.getZ(i), nr ? nr.getX(i) : 0, nr ? nr.getY(i) : 1, nr ? nr.getZ(i) : 0, i);
      arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2];
    }
  } else for (let i = 0; i < n; i++) { arr[i * 3] = col[0]; arr[i * 3 + 1] = col[1]; arr[i * 3 + 2] = col[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
/** Multiply existing colours by fn(x,y,z,nx,ny,nz) -> scalar or [r,g,b]. */
export function tintBy(g, fn) {
  const p = g.attributes.position, nr = g.attributes.normal, c = g.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const m = fn(p.getX(i), p.getY(i), p.getZ(i), nr.getX(i), nr.getY(i), nr.getZ(i));
    if (typeof m === 'number') c.setXYZ(i, c.getX(i) * m, c.getY(i) * m, c.getZ(i) * m);
    else c.setXYZ(i, c.getX(i) * m[0], c.getY(i) * m[1], c.getZ(i) * m[2]);
  }
  return g;
}

/** Merge geometries (position/normal/uv/color), mixing indexed and non-indexed inputs. */
export function merge(list) {
  list = list.filter(Boolean);
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const hasColor = list.some((g) => g.attributes.color);
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2);
  const C = hasColor ? new Float32Array(nv * 3) : null;
  const I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = p.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    P.set(p.array.subarray ? p.array.subarray(0, n * 3) : p.array, vo * 3);
    N.set(g.attributes.normal.array.subarray(0, n * 3), vo * 3);
    if (g.attributes.uv) U.set(g.attributes.uv.array.subarray(0, n * 2), vo * 2);
    if (C) { if (g.attributes.color) C.set(g.attributes.color.array.subarray(0, n * 3), vo * 3); else C.fill(1, vo * 3, (vo + n) * 3); }
    if (g.index) { const ix = g.index.array; for (let k = 0; k < ix.length; k++) I[io++] = ix[k] + vo; }
    else for (let k = 0; k < n; k++) I[io++] = vo + k;
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (C) out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.setIndex(new THREE.BufferAttribute(I, 1));
  return out;
}

// ---- builder -----------------------------------------------------------------------------------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
/** Matrix from position + euler (radians) + optional uniform/vec scale. */
export function mat(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s);
}
/** Matrix mapping a face frame (right, up, out axes + origin) into prop space. */
export function frame(origin, right, up, out) {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...right), new THREE.Vector3(...up), new THREE.Vector3(...out));
  m.setPosition(origin[0], origin[1], origin[2]);
  return m;
}

export class PropBuilder {
  constructor(name, seed = 1) {
    this.name = name;
    this.rand = new Rand(typeof seed === 'string' ? hashStr(seed) : hashStr(name + ':' + seed));
    this.buckets = new Map();
    this.colliders = [];
    this.userData = {};
  }
  /** Add geometry (in prop space, or transformed by m) to a material bucket. col = rgb | fn */
  add(matKey, g, m = null, col = null) {
    if (!g) return g;
    if (m) g.applyMatrix4(m);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g = boxUV(g);
    if (col || !g.attributes.color) paint(g, col || [1, 1, 1]);
    let b = this.buckets.get(matKey);
    if (!b) this.buckets.set(matKey, (b = []));
    b.push(g);
    return g;
  }
  box(min, max, surface) { this.colliders.push(surface ? { min, max, surface } : { min, max }); }
  prism(pts, y0, y1, surface) { this.colliders.push({ prism: pts.map(([x, z]) => ({ x, z })), y0, y1, ...(surface ? { surface } : {}) }); }
  /** Final pass over every bucket: fn(x,y,z,nx,ny,nz) -> multiplier. */
  weather(fn, skip = []) {
    for (const [k, list] of this.buckets) if (!skip.includes(k)) for (const g of list) tintBy(g, fn);
  }
  finish() {
    const parts = [];
    for (const [k, list] of this.buckets) {
      const g = merge(list);
      g.computeBoundingBox(); g.computeBoundingSphere();
      parts.push([k, g]);
    }
    return { parts, colliders: this.colliders, userData: this.userData };
  }
}

// ---- colliders -----------------------------------------------------------------------------
const _p = new THREE.Vector3();
/**
 * Transform local colliders by a matrix (rotation about Y, translation, uniform scale).
 * Boxes stay boxes when the yaw is a multiple of 90°, otherwise become prisms.
 */
export function transformColliders(cols, m) {
  const e = m.elements;
  const yaw = Math.atan2(e[8], e[0]); // rotation of local X axis around Y
  const axial = Math.abs(Math.sin(2 * yaw)) < 1e-4 && Math.abs(e[4]) < 1e-6 && Math.abs(e[6]) < 1e-6;
  const out = [];
  for (const c of cols) {
    const extra = {};
    for (const k of Object.keys(c)) if (!['min', 'max', 'prism', 'y0', 'y1'].includes(k)) extra[k] = c[k];
    if (c.min) {
      if (axial) {
        const a = _p.set(...c.min).applyMatrix4(m).toArray(), b = _p.set(...c.max).applyMatrix4(m).toArray();
        out.push({ min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])], ...extra });
      } else {
        const pts = [[c.min[0], c.min[2]], [c.max[0], c.min[2]], [c.max[0], c.max[2]], [c.min[0], c.max[2]]];
        const y0 = _p.set(0, c.min[1], 0).applyMatrix4(m).y, y1 = _p.set(0, c.max[1], 0).applyMatrix4(m).y;
        out.push({ prism: pts.map(([x, z]) => { _p.set(x, 0, z).applyMatrix4(m); return { x: _p.x, z: _p.z }; }), y0: Math.min(y0, y1), y1: Math.max(y0, y1), ...extra });
      }
    } else {
      const y0 = _p.set(0, c.y0, 0).applyMatrix4(m).y, y1 = _p.set(0, c.y1, 0).applyMatrix4(m).y;
      out.push({ prism: c.prism.map((q) => { _p.set(q.x, 0, q.z).applyMatrix4(m); return { x: _p.x, z: _p.z }; }), y0: Math.min(y0, y1), y1: Math.max(y0, y1), ...extra });
    }
  }
  return out;
}

/** Brush planes ({n, d}, inside when n·p + d <= 0) for a convex prism collider. */
export function prismPlanes(c) {
  const pts = c.prism.map((q) => [q.x, q.z]);
  const P = ccw(pts); // CCW in (x, z)
  const planes = [
    { n: new THREE.Vector3(0, 1, 0), d: -c.y1 },
    { n: new THREE.Vector3(0, -1, 0), d: c.y0 },
  ];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    // CCW in (x,z) → outward normal is (dz, -dx)
    const n = new THREE.Vector3(dz / l, 0, -dx / l);
    planes.push({ n, d: -(n.x * a[0] + n.z * a[1]) });
  }
  return planes;
}
