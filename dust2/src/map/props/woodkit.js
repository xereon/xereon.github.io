// Timber helpers: bevelled boards with grain-aligned atlas UVs and per-board weathering.
import * as THREE from 'three';
import { slab } from './core.js';
import { WOOD } from './tex.js';

/**
 * Assign wood-atlas UVs (grain along `angle` in the board's XY plane) and vertex colours.
 * Face (±z) and long-edge faces sample one atlas strip; end grain samples it too but darker;
 * chamfers get a lighter "worn edge" tint.
 */
export function woodify(g, { angle = 0, row = 0, uoff = 0, tint = [1, 1, 1], edge = 1.12, end = 0.6 } = {}) {
  const p = g.attributes.position, n = p.count, kinds = g.userData.kinds;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < n; i++) { const gy = -p.getX(i) * sa + p.getY(i) * ca; vmin = Math.min(vmin, gy); vmax = Math.max(vmax, gy); }
  const span = vmax - vmin, vs = Math.min(1, 14 / Math.max(span, 1e-3));
  const px = WOOD.PX_PER_UNIT, W = WOOD.W, H = WOOD.H, rowPx = (row % WOOD.STRIPS) * WOOD.STRIP_PX;
  const uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3(), e1 = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    fn.subVectors(b, a).cross(e1.subVectors(c, a)).normalize();
    const nx = fn.x * ca + fn.y * sa, ny = -fn.x * sa + fn.y * ca, nz = fn.z;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const endGrain = ax > 0.7;
    for (let k = 0; k < 3; k++) {
      const j = i + k, x = p.getX(j), y = p.getY(j), z = p.getZ(j);
      const gx = x * ca + y * sa, gy = -x * sa + y * ca;
      let u, v;
      if (az >= ax && az >= ay) { u = gx; v = (gy - vmin) * vs; }
      else if (ay >= ax) { u = gx; v = 0.5 + Math.abs(z) * 0.8; }
      else { u = z * 3 + gy * 0.5; v = (gy - vmin) * vs; }
      uv[j * 2] = (u * px + uoff) / W;
      uv[j * 2 + 1] = (rowPx + 4 + Math.min(v * px, WOOD.STRIP_PX - 8)) / H;
      const kind = kinds ? kinds[j] : 0;
      const m = endGrain ? end : kind === 1 ? edge : 1;
      col[j * 3] = tint[0] * m; col[j * 3 + 1] = tint[1] * m; col[j * 3 + 2] = tint[2] * m;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Add a bevelled board. pts: convex polygon in the local XY plane (board face), occupying
 * z = z0..z0+t, then transformed by matrix M into prop space.
 */
export function board(pb, matKey, pts, z0, t, M, o = {}) {
  const r = pb.rand;
  const g = slab(pts, t, o.chamfer ?? Math.min(0.45, t * 0.3), o.back ?? true, o.cap ?? true);
  if (z0) g.translate(0, 0, z0);
  const base = o.tint || [1, 1, 1], v = o.vary ?? 0.07;
  const k = 1 + r.f(-v, v), warm = r.f(-0.035, 0.035), grey = r.f(0, v * 2.5);
  const t0 = base[0] * k * (1 + warm), t1 = base[1] * k, t2 = base[2] * k * (1 - warm * 1.5), L = (t0 + t1 + t2) / 3;
  woodify(g, {
    angle: o.angle || 0, row: o.row ?? r.i(0, 7), uoff: o.uoff ?? r.f(0, 1024),
    tint: [t0 + (L - t0) * grey, t1 + (L - t1) * grey, t2 + (L - t2) * grey], edge: o.edge ?? 1.12, end: o.end ?? 0.62,
  });
  pb.add(matKey, g, M);
  return g;
}

/** Axis-aligned board in prop space: min/max box, grain along the longest horizontal/vertical axis. */
export function beamBox(pb, matKey, min, max, o = {}) {
  const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
  // build in a local frame where the board face is XY, thickness along Z
  // choose thickness axis = smallest dimension
  const dims = [dx, dy, dz];
  const ti = o.thickAxis ?? dims.indexOf(Math.min(...dims));
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  let M, w, h, t;
  if (ti === 2) { w = dx; h = dy; t = dz; M = new THREE.Matrix4().makeTranslation(cx, cy, min[2]); }
  else if (ti === 0) { w = dz; h = dy; t = dx; M = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).setPosition(min[0], cy, cz); }
  else { w = dx; h = dz; t = dy; M = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)).setPosition(cx, min[1], cz); }
  const angle = o.angle ?? (h > w ? Math.PI / 2 : 0);
  return board(pb, matKey, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], 0, t, M, { ...o, angle });
}
