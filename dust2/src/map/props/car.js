// Old boxy 70s saloon (original design, Dust II B-site style: faded white paint, rust, flat tyre),
// plus loose tyres and tyre stacks.
import * as THREE from 'three';
import { PropBuilder, rect, slab, cbox, rod, lathe, relathe, dome, paint, tintBy, mat, lerp, smooth, clamp, DEG, boxUV, uvXform } from './core.js';
import { labelUV } from './tex.js';

// ---- tyres ------------------------------------------------------------------------------------------
const TYRE_R = 11.5, TYRE_W = 6.6, RIM_R = 7.2;
function tyreGeo(Ro = TYRE_R, Wt = TYRE_W, Ri = RIM_R, segs = 22) {
  const h = Wt / 2;
  const prof = [[Ri, -h * 0.82, true], [Ri + 1.8, -h], [Ro - 1.2, -h * 0.97], [Ro - 0.35, -h * 0.8], [Ro, -h * 0.55], [Ro, h * 0.55], [Ro - 0.35, h * 0.8], [Ro - 1.2, h * 0.97], [Ri + 1.8, h], [Ri, h * 0.82, true], [Ri - 0.2, 0, true], [Ri, -h * 0.82]];
  const g = lathe(prof, segs);
  const uv = g.attributes.uv, total = uv.getY(uv.count - 1) || 1;
  const circ = Math.PI * 2 * Ro;
  // rubber atlas: u around (1 repeat), v across profile with the tread band in the middle
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / circ, 0.5 + (uv.getY(i) - total * 0.43) / (total * 1.25));
  return g;
}
function wheelGeo(Ri = RIM_R) {
  return lathe([[Ri + 0.2, -2.6, true], [Ri, -0.4], [Ri - 0.6, 0.2, true], [5.6, 0.3], [4.2, 0.9, true], [3.4, 1.3], [2.3, 1.8], [0.01, 2.0]], 18);
}
/** tire(standing = false): loose car tyre, lying flat (default) or standing on its tread. */
export function tire(standing = false) {
  const pb = new PropBuilder('tire', String(standing));
  const g = tyreGeo();
  if (standing) { g.rotateX(Math.PI / 2); g.translate(0, TYRE_R, 0); } else g.translate(0, TYRE_W / 2, 0);
  pb.add('rubber', g);
  if (standing) pb.box([-TYRE_R, 0, -TYRE_W / 2], [TYRE_R, 2 * TYRE_R, TYRE_W / 2], 'rubber');
  else pb.box([-TYRE_R, 0, -TYRE_R], [TYRE_R, TYRE_W, TYRE_R], 'rubber');
  return pb.finish();
}
/** tyreStack(n = 4): pile of flat-lying tyres, slightly offset. */
export function tyreStack(n = 4) {
  const pb = new PropBuilder('tyreStack', String(n)), r = pb.rand;
  let y = 0, mx = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    const g = tyreGeo();
    const ox = r.f(-1.2, 1.2), oz = r.f(-1.2, 1.2), tilt = r.f(-2, 2) * DEG;
    g.applyMatrix4(mat(ox, y + TYRE_W / 2, oz, tilt, r.f(0, 6.28), r.f(-2, 2) * DEG));
    const k = r.f(0.85, 1.1);
    pb.add('rubber', g, null, [k, k, k]);
    y += TYRE_W - 0.25; mx = Math.max(mx, Math.abs(ox)); mz = Math.max(mz, Math.abs(oz));
  }
  const R = TYRE_R + Math.max(mx, mz), pts = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; pts.push([Math.cos(a) * R * 1.04, Math.sin(a) * R * 1.04]); }
  pb.prism(pts, 0, y, 'rubber');
  return pb.finish();
}

// ---- car ----------------------------------------------------------------------------------------------
const CAR_PAINT = ['white', 'sky', 'sand', 'red'];
/**
 * car(variant = 0): old boxy saloon, 160 × 64 × 55, front toward +x, centred, on the ground.
 * variant: 0 faded white, 1 pale blue, 2 sand, 3 red. Flat front-left tyre, rust, dust.
 */
export function car(variant = 0) {
  const P = `paint:${CAR_PAINT[((variant % 4) + 4) % 4]}:0.18`;
  const pb = new PropBuilder('car', 'car' + variant), r = pb.rand;
  const W = 64, WB = 95, wx = WB / 2, wy = TYRE_R - 0.4, AR = 14;
  // ---- lower body: side profile with wheel arches, extruded across the width with rounded edges
  const s = new THREE.Shape();
  const archX = (c) => Math.sqrt(AR * AR - (wy - 9) ** 2);
  s.moveTo(-77, 9);
  s.lineTo(-wx - archX(), 9);
  s.absarc(-wx, wy, AR, Math.PI + Math.asin((wy - 9) / AR), -Math.asin((wy - 9) / AR), true);
  s.lineTo(wx - archX(), 9);
  s.absarc(wx, wy, AR, Math.PI + Math.asin((wy - 9) / AR), -Math.asin((wy - 9) / AR), true);
  s.lineTo(77, 9); s.lineTo(79.4, 11); s.lineTo(80, 22); s.lineTo(79.6, 28.4); s.lineTo(77.5, 30.6);
  s.lineTo(50, 31.6); s.lineTo(28, 32.6); s.lineTo(-42, 33.2); s.lineTo(-74, 32.2); s.lineTo(-78.8, 30.2);
  s.lineTo(-80, 26); s.lineTo(-80, 12); s.lineTo(-77, 9);
  const bev = 2.4, depth = W - 2 * bev;
  let body = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: 1.6, bevelSegments: 3, curveSegments: 12, steps: 1 });
  body.translate(0, 0, -depth / 2);
  body = boxUV(body, 1 / 64);
  paint(body, (x, y, z, nx, ny) => {
    // underside + inner arch liners dark, lower body dusty
    if (ny < -0.6 && y < 12) return [0.18, 0.17, 0.16];
    const arch = (Math.hypot(x - wx, y - wy) < AR + 0.8 || Math.hypot(x + wx, y - wy) < AR + 0.8) && Math.abs(z) < W / 2 - 1.5;
    if (arch) return [0.14, 0.13, 0.12];
    // road grime / rust bloom creeping up from the sills and arches, dusty flat tops
    const d = smooth(20, 9, y) * 0.45 + (ny > 0.8 ? 0.08 : 0);
    return [1 - d * 0.3, 1 - d * 0.42, 1 - d * 0.6];
  });
  pb.add(P, body);
  // wheel-well tubs block the see-through between arches
  for (const cx of [-wx, wx]) pb.add('rubber', cbox([cx - 13, 9.5, -W / 2 + 7.5], [cx + 13, 24, W / 2 - 7.5], 0.5), null, [0.25, 0.25, 0.25]);
  // ---- cabin with tumblehome
  const cs = new THREE.Shape();
  const cab = [[28, 32.6], [4.5, 50.4], [-30.5, 50.6], [-44.5, 33.3]];
  cs.moveTo(...cab[0]); for (let i = 1; i < cab.length; i++) cs.lineTo(...cab[i]); cs.lineTo(...cab[0]);
  const cbv = 1.6, Wc = W - 5, cdep = Wc - 2 * cbv;
  let cabin = new THREE.ExtrudeGeometry(cs, { depth: cdep, bevelEnabled: true, bevelThickness: cbv, bevelSize: 1.4, bevelSegments: 3, curveSegments: 4 });
  cabin.translate(0, 0, -cdep / 2);
  const tumble = (g) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setZ(i, p.getZ(i) * lerp(1, 0.88, smooth(33, 51, y))); } g.computeVertexNormals(); return g; };
  cabin = boxUV(tumble(cabin), 1 / 64);
  paint(cabin, (x, y, z, nx, ny) => (ny > 0.9 ? [0.9, 0.88, 0.84] : [1, 1, 1]));
  pb.add(P, cabin);
  // ---- glass: side windows split by the B-pillar, windscreen, rear screen
  const glassPoly = (pts, zSide) => {
    const g = slab(pts, 0.25, 0.08, false);
    if (zSide < 0) { g.rotateY(Math.PI); }
    g.translate(0, 0, zSide * (cdep / 2 + cbv - 0.05));
    return tumble(boxUV(g, 1 / 40));
  };
  const lerp2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  for (const zs of [-1, 1]) {
    const fwd = (pts) => (zs < 0 ? pts.map(([x, y]) => [-x, y]) : pts);
    const front = [[24.2, 35], [-7.2, 35], [-7.2, 48.3], [5.2, 48.3]];
    const rear = [[-10.4, 35], [-40.5, 35], [-30.2, 48.3], [-10.4, 48.3]];
    for (const w of [front, rear]) pb.add('glass', glassPoly(fwd(w), zs), null, [1, 1, 1]);
  }
  // windscreen/rear screen as quads on the raked faces (offset along face normal)
  const screen = (a, b, inset) => {
    const d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(d[0], d[1]), n = [d[1] / L, -d[0] / L];
    const nn = n[0] * (a[0] > 0 ? 1 : -1) >= 0 ? n : [-n[0], -n[1]];
    const off = 1.4 + 0.12;
    const p0 = lerp2(a, b, 0.07), p1 = lerp2(a, b, 0.93);
    const zw = Wc / 2 - inset;
    const v = [];
    const P3 = (p, z) => [p[0] + nn[0] * off, p[1] + nn[1] * off, z];
    const q = [P3(p0, -zw), P3(p0, zw), P3(p1, zw), P3(p1, -zw)];
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) v.push(...q[i], ...q[j], ...q[k]);
    let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    // make sure it faces outward
    const nz = g.attributes.normal; if (nz.getX(0) * nn[0] + nz.getY(0) * nn[1] < 0) { const t = v.slice(); for (let i = 0; i < v.length; i += 9) { for (let c = 0; c < 3; c++) { t[i + 3 + c] = v[i + 6 + c]; t[i + 6 + c] = v[i + 3 + c]; } } g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(t, 3)); g.computeVertexNormals(); }
    return tumble(boxUV(g, 1 / 40));
  };
  pb.add('glass', screen(cab[0], cab[1], 3.2));
  pb.add('glass', screen(cab[3], cab[2], 3.6));
  // ---- chrome: bumpers with rubber-tipped ends, side trim, grille, lamps, handles, mirrors
  const CH = 'galv', chrome = [0.95, 0.95, 0.97];
  pb.add(CH, cbox([78.8, 11, -W / 2 - 0.8], [82.6, 16.2, W / 2 + 0.8], 1.1), null, chrome);
  pb.add(CH, cbox([-82.6, 11, -W / 2 - 0.8], [-78.8, 16.2, W / 2 + 0.8], 1.1), null, [0.8, 0.74, 0.66]);
  for (const zs of [-1, 1]) {
    pb.add(CH, cbox([-76, 21.6, zs * (W / 2 + bev * 0.1) - 0.3], [77, 22.8, zs * (W / 2 + bev * 0.1) + 0.3], 0.2), null, chrome);
    for (const hx of [-3.5, -35.5]) pb.add(CH, cbox([hx - 2.4, 29.2, zs * (W / 2) - 0.6], [hx + 2.4, 30.4, zs * (W / 2) + 0.6], 0.25), null, chrome);
  }
  // mirror on the driver side only
  pb.add(P, cbox([22, 35.5, W / 2 - 0.5], [26.5, 39.5, W / 2 + 4.2], 0.8), null, [0.95, 0.95, 0.95]);
  pb.add('rubber', rod([24, 34, W / 2 - 1], [24.2, 36, W / 2 + 1.5], 0.4, 5), null, [0.3, 0.3, 0.3]);
  // grille + four round headlamps
  pb.add('rubber', cbox([79.2, 17.6, -17], [80.6, 26.8, 17], 0.3), null, [0.2, 0.2, 0.2]);
  for (let y = 18.8; y < 26.4; y += 1.9) pb.add(CH, cbox([80.1, y - 0.3, -17], [80.9, y + 0.3, 17], 0.1), null, chrome);
  for (const hz of [-28.2, -21, 21, 28.2]) {
    const ring = lathe([[3.6, 0, true], [3.7, 0.8, true], [3.0, 1.1, true], [2.9, 0.4]], 14); ring.rotateZ(-Math.PI / 2); ring.translate(79.6, 22.3, hz);
    pb.add(CH, ring, null, chrome);
    const lens = lathe([[3.0, 0, true], [2.6, 0.6], [1.4, 1.0], [0.01, 1.1]], 14); lens.rotateZ(-Math.PI / 2); lens.translate(79.8, 22.3, hz);
    pb.add('glass', lens, null, [2.6, 2.6, 2.4]);
  }
  // tail lamps + reflectors
  for (const zs of [-1, 1]) {
    pb.add('plain:0.35', cbox([-80.8, 20.5, zs * (W / 2 - 16.5) - 6.5], [-79.6, 27.2, zs * (W / 2 - 16.5) + 6.5], 0.35), null, [0.55, 0.08, 0.05]);
    pb.add('plain:0.35', cbox([-80.8, 20.5, zs * (W / 2 - 7.5) - 2.2], [-79.6, 27.2, zs * (W / 2 - 7.5) + 2.2], 0.35), null, [0.75, 0.4, 0.08]);
  }
  // number plates
  const plate = (x, face) => {
    const u = labelUV('plate'), g = new THREE.PlaneGeometry(16, 8);
    const q = g.attributes.uv; for (let i = 0; i < q.count; i++) q.setXY(i, lerp(u.u0, u.u1, q.getX(i)), lerp(u.v0, u.v1, q.getY(i)));
    g.rotateY(face * Math.PI / 2); g.translate(x, face > 0 ? 13.6 : 24.4, 0);
    pb.add('label', g);
  };
  plate(82.7, 1); plate(-80.95, -1);
  // door seams: thin dark strips on the flanks
  for (const zs of [-1, 1]) {
    for (const [x, y0, y1] of [[29.5, 11.5, 32.2], [-8.8, 11.5, 33], [-42, 11.5, 32.6]]) {
      const g = new THREE.PlaneGeometry(0.35, y1 - y0); g.translate(x, (y0 + y1) / 2, 0);
      if (zs < 0) g.rotateY(Math.PI);
      g.translate(0, 0, zs * (W / 2 + 0.03));
      pb.add('seam', g, null, [0.12, 0.11, 0.1]);
    }
    const g = new THREE.PlaneGeometry(71.5, 0.35); g.translate(-6.2, 11.6, 0); if (zs < 0) g.rotateY(Math.PI); g.translate(0, 0, zs * (W / 2 + 0.03));
    pb.add('seam', g, null, [0.12, 0.11, 0.1]);
  }
  // hood + boot shut lines on top
  for (const [x0, x1, y] of [[29.5, 29.8, 32.75], [-72, -71.7, 32.4]]) {
    const g = new THREE.PlaneGeometry(0.35, W - 8); g.rotateX(-Math.PI / 2); g.rotateY(0); g.translate((x0 + x1) / 2, y + 0.06, 0);
    pb.add('seam', g, null, [0.15, 0.14, 0.13]);
  }
  // wipers
  for (const zc of [-12, 12]) pb.add('rubber', cbox([26.5, 33.5, zc - 9], [27.6, 34.2, zc + 9], 0.2), mat(0, 0, 0, 0, 0, 0), [0.15, 0.15, 0.15]);
  // ---- wheels (front-left tyre flat, car sagging on it)
  const flat = [1, 0, 0, 0];
  let k = 0;
  for (const cx of [wx, -wx]) for (const zs of [1, -1]) {
    const f = flat[k++];
    const ty = tyreGeo(); ty.rotateX(Math.PI / 2);
    const wh = wheelGeo(); wh.rotateX(Math.PI / 2);
    if (zs < 0) { ty.rotateY(Math.PI); wh.rotateY(Math.PI); }
    if (f) {
      const p = ty.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < -TYRE_R * 0.55) { const d = -TYRE_R * 0.55 - y; p.setY(i, -TYRE_R * 0.55 - d * 0.25); p.setZ(i, p.getZ(i) * (1 + d * 0.06)); } }
      relathe(ty);
    }
    const cy = f ? TYRE_R * 0.55 + 0.05 : TYRE_R;
    ty.translate(cx, cy, zs * (W / 2 - 4.6)); wh.translate(cx, cy, zs * (W / 2 - 4.6));
    pb.add('rubber', ty);
    uvXform(wh, 1 / 40, 1 / 40); pb.add(CH, wh, null, [0.72, 0.7, 0.66]);
    for (let n = 0; n < 4; n++) {
      const a = (n / 4) * Math.PI * 2 + 0.4, b = dome(0.45, 0.4, 5);
      if (zs < 0) b.rotateY(Math.PI);
      b.translate(cx + Math.cos(a) * 2.9, cy + Math.sin(a) * 2.9, zs * (W / 2 - 4.6 + 1.3));
      pb.add(CH, b, null, [0.6, 0.58, 0.55]);
    }
  }
  // body sags toward the flat tyre (front-left = +x, +z); wheels stay put
  pb.weather((x, y, z, nx, ny) => lerp(0.8, 1, smooth(4, 20, y)), ['label', 'glass', 'seam']);
  for (const [key, list] of pb.buckets) for (const g of list) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
      const inWheel = Math.abs(z) > W / 2 - 9.5 && Math.min(Math.hypot(x - wx, y - TYRE_R), Math.hypot(x + wx, y - TYRE_R)) < TYRE_R + 0.6;
      if (y > 6 && !inWheel) p.setY(i, y - clamp((x / 95 + 0.5) * 0.9 + (z / W + 0.5) * 0.8 - 0.4, 0, 2.2));
    }
  }
  pb.box([-83, 0, -W / 2 - 1], [83, 33, W / 2 + 1], 'metal');
  pb.box([-45, 33, -W / 2 + 3], [29, 51, W / 2 - 3], 'metal');
  return pb.finish();
}
