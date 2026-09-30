// Procedural modelling toolkit for weapons: profile shapes with fillets, bevelled extrusions,
// lathes, tubes, deformers, and a ModelBuilder that merges parts per material.
//
// Gun space (all weapon models): units = inches, +Y up, +X to the gun's right, muzzle toward
// -Z. Profiles use (u, v) = (distance toward the muzzle, height), mapped to (x, y, z) = (·, v, -u).
import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { getMaterial } from './materials.js';

const DEG = Math.PI / 180;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();

// ---- shapes ----------------------------------------------------------------------------------
/**
 * Polygon with per-corner fillets. pts: [[x, y, r?], ...] (closed). r = fillet radius (default
 * `rad`). Returns THREE.Shape. Fillets are quadratic curves, tessellated by curveSegments.
 */
export function shape(pts, rad = 0, holes = []) {
  const s = new THREE.Shape();
  roundedPath(s, pts, rad);
  for (const h of holes) { const p = new THREE.Path(); roundedPath(p, h, rad); s.holes.push(p); }
  return s;
}
function roundedPath(p, pts, rad) {
  const n = pts.length;
  const P = pts.map((q) => new THREE.Vector2(q[0], q[1]));
  const R = pts.map((q) => (q[2] != null ? q[2] : rad));
  const starts = [], ends = [];
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const r = R[i];
    if (!r) { starts.push(b.clone()); ends.push(b.clone()); continue; }
    const d1 = a.clone().sub(b), d2 = c.clone().sub(b);
    const l1 = d1.length(), l2 = d2.length();
    d1.normalize(); d2.normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1));
    let t = r / Math.tan(ang / 2);
    t = Math.min(t, l1 * 0.49, l2 * 0.49);
    starts.push(b.clone().addScaledVector(d1, t));
    ends.push(b.clone().addScaledVector(d2, t));
  }
  p.moveTo(ends[0].x, ends[0].y);
  for (let k = 1; k <= n; k++) {
    const i = k % n;
    p.lineTo(starts[i].x, starts[i].y);
    if (R[i]) p.quadraticCurveTo(P[i].x, P[i].y, ends[i].x, ends[i].y);
  }
}
/** Smooth closed spline shape through points (Catmull-Rom). */
export function splineShape(pts) {
  const s = new THREE.Shape();
  const v = pts.map((q) => new THREE.Vector2(q[0], q[1]));
  s.moveTo(v[0].x, v[0].y);
  s.splineThru([...v.slice(1), v[0]]);
  return s;
}
export const circlePts = (r, n = 16, cx = 0, cy = 0, a0 = 0) =>
  Array.from({ length: n }, (_, i) => { const a = a0 + (i / n) * Math.PI * 2; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
export const rectPts = (x0, y0, x1, y1, r = 0) => [[x0, y0, r], [x1, y0, r], [x1, y1, r], [x0, y1, r]];

// ---- raw geometry ------------------------------------------------------------------------------
function extrudeRaw(shp, width, o = {}) {
  const bev = o.bevel ?? Math.min(0.06, width * 0.2);
  const bs = o.bevelSize ?? bev;
  const geo = new THREE.ExtrudeGeometry(shp, {
    depth: Math.max(0.001, width - 2 * bev), bevelEnabled: bev > 0, bevelThickness: bev, bevelSize: bs,
    bevelOffset: -bs, bevelSegments: o.bseg ?? 2, curveSegments: o.cseg ?? 5, steps: o.steps ?? 1,
  });
  geo.translate(0, 0, -(width - 2 * bev) / 2);
  return geo;
}

/** Side profile [(u, v)] extruded across X (width), centered on x = xc. */
export function side(pts, width, o = {}) {
  const shp = pts instanceof THREE.Shape ? pts : shape(pts, o.r ?? 0, o.holes);
  const g = extrudeRaw(shp, width, o);
  // shape (x=u, y=v, z=ext) -> gun (x=z, y=v, z=-u)
  g.applyMatrix4(_m.set(0, 0, 1, o.x ?? 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1));
  return prep(g, o);
}
/** Cross-section [(x, y)] extruded along the bore from u0 to u0 + len. */
export function cross(pts, len, o = {}) {
  // the placement below is a 180° turn about Y (x -> -x), so pre-mirror the profile in x
  const mx = (a) => a.map((q) => [-q[0], q[1], q[2]]);
  const shp = pts instanceof THREE.Shape ? pts : shape(mx(pts), o.r ?? 0, (o.holes || []).map(mx));
  const g = extrudeRaw(shp, len, o);
  g.applyMatrix4(_m.set(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -((o.u0 ?? 0) + len / 2), 0, 0, 0, 1));
  return prep(g, o);
}
/** Top-view outline [(x, u)] extruded vertically (height), centered on y = yc. */
export function top(pts, height, o = {}) {
  const shp = pts instanceof THREE.Shape ? pts : shape(pts, o.r ?? 0, o.holes);
  const g = extrudeRaw(shp, height, o);
  // shape (x, y=u, z=ext) -> gun (x, y=ext, z=-u)
  g.applyMatrix4(_m.set(1, 0, 0, 0, 0, 0, 1, o.y ?? 0, 0, -1, 0, 0, 0, 0, 0, 1));
  return prep(g, o);
}
/** Lathe around the bore axis. prof: [[r, u], ...]. */
export function lathe(prof, segs = 24, o = {}) {
  const g = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(Math.max(0.0001, p[0]), p[1])), segs, o.phi0 ?? 0, o.phiLen ?? Math.PI * 2);
  g.applyMatrix4(_m.makeRotationX(-Math.PI / 2)); // y(u) -> -z
  return prep(g, o);
}
/** Cylinder along the bore (u from u0 to u0+len) or along 'x' / 'y'. */
export function cyl(r0, r1, len, segs = 20, o = {}) {
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, o.hseg ?? 1, !!o.open);
  const ax = o.axis || 'z';
  if (ax === 'z') { g.rotateX(-Math.PI / 2); g.translate(0, 0, -(o.u0 ?? 0) - len / 2); }
  else if (ax === 'x') { g.rotateZ(-Math.PI / 2); }
  return prep(g, o);
}
export function box(w, h, d, o = {}) {
  const r = Math.min(o.r ?? 0.04, w / 2 - 0.001, h / 2 - 0.001);
  // rounded rect in XY (w x h) extruded along z (d), with bevel = r on the caps
  const g = cross(rectPts(-w / 2, -h / 2, w / 2, h / 2, r), d, { bevel: Math.min(r, d * 0.3), bseg: o.bseg ?? 2, cseg: o.cseg ?? 3, u0: -d / 2, crease: o.crease });
  return g;
}
export function sphere(r, ws = 16, hs = 12, o = {}) {
  return prep(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, o.t0 ?? 0, o.tLen ?? Math.PI), o);
}
export function capsule(r, len, o = {}) {
  const g = new THREE.CapsuleGeometry(r, len, o.cap ?? 4, o.rad ?? 10);
  if ((o.axis || 'z') === 'z') g.rotateX(-Math.PI / 2);
  return prep(g, o);
}
export function torus(R, r, o = {}) {
  return prep(new THREE.TorusGeometry(R, r, o.rs ?? 8, o.ts ?? 24, o.arc ?? Math.PI * 2), o);
}
/** Tube through 3D points [[x,y,z]...]. */
export function tube(pts, radius, o = {}) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), !!o.closed, 'catmullrom', o.tension ?? 0.5);
  const g = new THREE.TubeGeometry(curve, o.seg ?? Math.max(8, pts.length * 6), radius, o.rs ?? 8, !!o.closed);
  return prep(g, { ...o, crease: o.crease ?? 70 });
}

// ---- deformers ---------------------------------------------------------------------------------
/** Arbitrary vertex deformer: fn(v: Vector3) mutates in place. Recomputes normals after. */
export function deform(geo, fn, crease = 40) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i); fn(_v); p.setXYZ(i, _v.x, _v.y, _v.z); }
  geo.deleteAttribute('normal');
  return prep(geo, { crease });
}
/** Scale X/Y as a function of u (= -z): f(u) -> [sx, sy]. */
export function taper(geo, f) {
  return deform(geo, (v) => { const s = f(-v.z); v.x *= s[0]; if (s[1] != null) v.y *= s[1]; });
}

// Normalises a raw geometry: non-indexed, creased normals (caps of extrusions kept flat).
function prep(g, o = {}, flip = false) {
  let geo = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
  if (flip) flipWinding(geo);
  const crease = (o.crease ?? 38) * DEG;
  if (o.flat) geo.computeVertexNormals();
  else if (g.groups && g.groups.length > 1 && g.type === 'ExtrudeGeometry' && o.smoothCaps !== true) {
    // separate caps (group 0) from sides (group 1): smooth sides only
    const parts = [];
    for (const grp of g.groups) {
      const sub = sliceTris(geo, grp.start, grp.count);
      parts.push(grp.materialIndex === 0 ? faceNormals(sub) : toCreasedNormals(sub, crease));
    }
    geo = mergeGeometries(parts, false);
  } else geo = toCreasedNormals(geo, crease);
  geo.clearGroups();
  return geo;
}
function sliceTris(geo, start, count) {
  const out = new THREE.BufferGeometry();
  const p = geo.attributes.position;
  out.setAttribute('position', new THREE.BufferAttribute(p.array.slice(start * 3, (start + count) * 3), 3));
  return out;
}
function faceNormals(geo) { geo.computeVertexNormals(); return geo; }
function flipWinding(geo) {
  for (const k of Object.keys(geo.attributes)) {
    const a = geo.attributes[k], s = a.itemSize, arr = a.array;
    for (let i = 0; i < a.count; i += 3) for (let j = 0; j < s; j++) {
      const t = arr[(i + 1) * s + j]; arr[(i + 1) * s + j] = arr[(i + 2) * s + j]; arr[(i + 2) * s + j] = t;
    }
  }
}

// Box-projected UVs (inches), per triangle, from the face normal in model space.
function boxUV(geo, rotUV = 0) {
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i); _b.fromBufferAttribute(p, i + 1); _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_c, _b).cross(_v.subVectors(_a, _b));
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    for (let k = 0; k < 3; k++) {
      const q = k === 0 ? _a : k === 1 ? _b : _c;
      let u, v;
      if (ax >= ay && ax >= az) { u = -q.z; v = q.y; }
      else if (ay >= az) { u = -q.z; v = q.x; }
      else { u = q.x; v = q.y; }
      if (rotUV) { const t = u; u = v; v = -t; }
      uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---- builder -----------------------------------------------------------------------------------
const tmpColor = new THREE.Color();
/**
 * Collects geometry per (part, material). Parts are separately animated sub-objects with a
 * pivot in gun space. Usage:
 *   const b = new ModelBuilder();  b.add('steel', G.cyl(...), { p, r, s, c });
 *   b.part('mag', [0, -1, -8]);  ...  b.part('body');
 *   b.anchor('muzzle', [0, 0, -28]);  const m = b.build();
 */
export class ModelBuilder {
  constructor(o = {}) {
    this.lod = o.lod || 0;
    this.parts = new Map();
    this.anchors = {};
    this.stack = [new THREE.Matrix4()];
    this.part('body');
  }
  get detail() { return this.lod === 0; }
  part(name, pivot = null, parent = null) {
    let p = this.parts.get(name);
    if (!p) {
      p = { name, pivot: new THREE.Vector3(...(pivot || [0, 0, 0])), parent: parent || (name === 'body' ? null : 'body'), items: new Map() };
      this.parts.set(name, p);
    }
    this.cur = p;
    return this;
  }
  /** Push a local transform for a sub-assembly. */
  push(p = [0, 0, 0], r = [0, 0, 0], s = 1) {
    const m = new THREE.Matrix4().compose(_v.set(...p), _q.setFromEuler(_e.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ')),
      typeof s === 'number' ? _s.set(s, s, s) : _s.set(...s));
    this.stack.push(this.stack[this.stack.length - 1].clone().multiply(m));
    return this;
  }
  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }
  /** Add geometry with optional transform {p, r (deg XYZ), s, c (hex|[r,g,b] tint), mirror}. */
  add(mat, geo, o = {}) {
    if (!geo) return this;
    const g = geo.clone();
    const m = new THREE.Matrix4().compose(_v.set(...(o.p || [0, 0, 0])),
      _q.setFromEuler(_e.set(...(o.r || [0, 0, 0]).map((a) => a * DEG), o.ro || 'XYZ')),
      typeof o.s === 'number' ? _s.set(o.s, o.s, o.s) : o.s ? _s.set(...o.s) : _s.set(1, 1, 1));
    m.premultiply(this.stack[this.stack.length - 1]);
    g.applyMatrix4(m);
    if (m.determinant() < 0) flipWinding(g);
    boxUV(g, o.uvRot);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    if (o.c != null) { if (Array.isArray(o.c)) tmpColor.setRGB(...o.c); else tmpColor.set(o.c); } else tmpColor.setRGB(1, 1, 1);
    for (let i = 0; i < n; i++) { col[i * 3] = tmpColor.r; col[i * 3 + 1] = tmpColor.g; col[i * 3 + 2] = tmpColor.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.cur.items.get(mat);
    if (!list) this.cur.items.set(mat, (list = []));
    list.push(g);
    if (o.mirror) this.add(mat, geo, { ...o, mirror: false, s: mirrorScale(o.s), p: o.p ? [-o.p[0], o.p[1], o.p[2]] : o.p, r: o.r ? [o.r[0], -o.r[1], -o.r[2]] : o.r });
    return this;
  }
  anchor(name, p, r = [0, 0, 0], partName = null) {
    const m = this.stack[this.stack.length - 1];
    const pos = new THREE.Vector3(...p).applyMatrix4(m);
    const q = new THREE.Quaternion().setFromEuler(_e.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ'));
    q.premultiply(new THREE.Quaternion().setFromRotationMatrix(m));
    this.anchors[name] = { p: pos, q, part: partName || null };
    return this;
  }
  /** Returns { root, parts: {name: Object3D}, anchors, tris } */
  build() {
    const root = new THREE.Group();
    const parts = {};
    let tris = 0;
    for (const p of this.parts.values()) {
      const obj = new THREE.Group();
      obj.name = p.name;
      obj.userData.pivot = p.pivot.clone();
      for (const [mk, list] of p.items) {
        let geo = mergeGeometries(list, false);
        if (!geo) continue;
        geo.translate(-p.pivot.x, -p.pivot.y, -p.pivot.z);
        geo = mergeVertices(geo, 1e-4);
        geo.computeBoundingSphere();
        tris += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
        const mesh = new THREE.Mesh(geo, getMaterial(mk));
        mesh.name = `${p.name}:${mk}`;
        mesh.castShadow = mesh.receiveShadow = true;
        obj.add(mesh);
      }
      parts[p.name] = obj;
    }
    for (const p of this.parts.values()) {
      const obj = parts[p.name];
      const par = p.parent ? parts[p.parent] : null;
      if (par) {
        const pp = this.parts.get(p.parent).pivot;
        obj.position.copy(p.pivot).sub(pp);
        par.add(obj);
      } else { obj.position.copy(p.pivot); root.add(obj); }
      obj.userData.rest = obj.position.clone();
    }
    for (const a of Object.values(this.anchors)) a.part = a.part || null;
    return { root, parts, anchors: this.anchors, tris };
  }
}
function mirrorScale(s) {
  if (s == null) return [-1, 1, 1];
  if (typeof s === 'number') return [-s, s, s];
  return [-s[0], s[1], s[2]];
}

// ---- small reusable parts -------------------------------------------------------------------------
/** Picatinny rail along u from u0, length len, on top at height y (slots every 0.394"). */
export function picatinny(b, mat, u0, len, y, o = {}) {
  const w = o.w ?? 0.835, x = o.x ?? 0, rot = o.rot ?? 0;
  b.push([x, y, 0], [0, 0, rot]);
  // base + dovetail profile (cross-section) as one extrusion
  const prof = [[-w / 2 + 0.06, 0], [w / 2 - 0.06, 0], [w / 2 - 0.06, 0.08], [w / 2, 0.14], [w / 2 - 0.1, 0.24], [-w / 2 + 0.1, 0.24], [-w / 2, 0.14], [-w / 2 + 0.06, 0.08]];
  b.add(mat, cross(prof.map((p) => [p[0], p[1], 0.02]), len, { u0, bevel: 0.02, cseg: 1 }));
  // raised teeth (the rail's top crenellations): n slats with gaps
  if (b.detail) {
    const pitch = 0.394, tooth = 0.21;
    const n = Math.floor((len - 0.1) / pitch);
    const tg = cross([[-w / 2 + 0.03, 0], [w / 2 - 0.03, 0], [w / 2 - 0.08, 0.13], [-w / 2 + 0.08, 0.13]].map((p) => [p[0], p[1], 0.015]), tooth, { bevel: 0.02, cseg: 1 });
    for (let i = 0; i < n; i++) b.add(mat, tg, { p: [0, 0.2, -(u0 + 0.12 + i * pitch)] });
  }
  b.pop();
}
/** Hex/slot screw head facing +X (or dir). */
export function screw(b, mat, p, r = 0.09, dir = 'x', o = {}) {
  const rot = dir === 'x' ? [0, 0, -90] : dir === '-x' ? [0, 0, 90] : dir === 'y' ? [0, 0, 0] : [90, 0, 0];
  b.push(p, rot);
  b.add(mat, lathe([[r, -0.04], [r, 0.0], [r * 0.85, 0.035], [0.001, 0.04]], 12, { crease: 60 }), { r: [90, 0, 0] });
  if (b.detail && o.slot !== false) b.add('dark', box(r * 1.6, 0.03, r * 0.3, { r: 0.005 }), { p: [0, 0.03, 0] });
  b.pop();
}
/** Dome rivet head facing +X by default. */
export function rivet(b, mat, p, r = 0.1, dir = 1) {
  b.add(mat, sphere(r, 10, 5, { tLen: Math.PI / 2 }), { p, r: [0, 0, -90 * dir], s: [1, 0.35, 1] });
}
/** Sling swivel loop at p, loop plane rotation r. */
export function slingLoop(b, mat, p, r = [0, 0, 0], size = 0.35) {
  b.add(mat, torus(size, 0.05, { rs: 6, ts: 16 }), { p, r });
}
export { DEG };
