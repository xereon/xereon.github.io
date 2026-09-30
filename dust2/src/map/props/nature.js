// Palms, potted plants, dry shrubs, rubble, clay urns and cut stone.
import * as THREE from 'three';
import { PropBuilder, rect, slab, cbox, rod, lathe, disc, sweep, paint, tintBy, mat, lerp, smooth, clamp, DEG, boxUV, uvXform, Rand } from './core.js';
import { vn, WOOD } from './tex.js';
import { buildPallet } from './wood.js';

// ---- palm ------------------------------------------------------------------------------------------
/** Frond card: V-folded strip following an arching rachis (rises at `elev`, droops `droop` units by the tip). */
function frond(pb, matKey, base, az, elev, len, width, droop, fold = 0.8, segs = 12, tint = [1, 1, 1], roll = 0) {
  const dirH = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
  const up = new THREE.Vector3(0, 1, 0);
  const P = (s) => base.clone().addScaledVector(dirH, s * Math.cos(elev)).addScaledVector(up, s * Math.sin(elev) - droop * (s / len) ** 2);
  const pos = [], uv = [], idx = [];
  const q = new THREE.Quaternion();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, s = t * len, p = P(s);
    const T = P(Math.min(len, s + 0.5)).sub(P(Math.max(0, s - 0.5))).normalize();
    const S = new THREE.Vector3().crossVectors(T, up).normalize();
    const N = new THREE.Vector3().crossVectors(S, T).normalize();
    // leaflets twist toward vertical along the frond (like real date palm pinnae)
    q.setFromAxisAngle(T, roll + t * 0.35);
    S.applyQuaternion(q); N.applyQuaternion(q);
    const w = width * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.15 + 0.08) * Math.PI)) * 0.5;
    const f = fold * w;
    for (const k of [-1, 0, 1]) {
      const v = p.clone().addScaledVector(S, k * w * 0.8).addScaledVector(N, Math.abs(k) * f);
      pos.push(v.x, v.y, v.z); uv.push((k + 1) / 2, t);
    }
    if (i) { const a = (i - 1) * 3; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // lighten toward the tips, darker near the crown (self-shadowed)
  paint(g, (x, y, z, nx, ny, nz, i) => { const t = uv[i * 2 + 1] ?? 0; const k = lerp(0.62, 1.05, smooth(0, 0.5, t)); return [tint[0] * k, tint[1] * k, tint[2] * k]; });
  pb.add(matKey, g);
  return P;
}

/** palm(h = 260, variant): date palm with ringed, gently leaning trunk and a crown of fronds. */
export function palm(h = 260, variant = 0) {
  const pb = new PropBuilder('palm', `${h}:${variant}`), r = pb.rand;
  const lean = r.f(14, 30), la = r.f(0, Math.PI * 2);
  const L = (t) => new THREE.Vector3(Math.cos(la) * lean * t * t, h * t, Math.sin(la) * lean * t * t);
  const curve = new THREE.CatmullRomCurve3([L(0), L(0.25), L(0.5), L(0.75), L(1)]);
  const segs = Math.min(120, Math.round(h / 2.4));
  const ringU = 3.6;
  const trunk = sweep(curve, segs, 10, (t) => {
    const s = t * h, flare = 3.8 * Math.exp(-t * 22);
    const saw = (s / ringU) % 1;
    return (6.6 - t * 1.4 + flare) * (1 + 0.16 * saw * saw * smooth(0.02, 0.12, t));
  });
  const uv = trunk.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * WOOD.PX_PER_UNIT) / WOOD.W, (6 * 128 + 4 + (uv.getY(i) / (Math.PI * 2 * 7)) * 118) / WOOD.H);
  // leaf-scar bands: dark in the notch under each ring, grey-brown weathered faces
  paint(trunk, (x, y) => { const saw = (y / ringU) % 1, k = lerp(0.55, 0.9, smooth(0, 40, y)) * (0.62 + 0.38 * smooth(0, 0.35, saw)); return [k * 0.92, k * 0.84, k * 0.74]; });
  pb.add('wood:door', trunk);
  const top = L(1), T = L(1).sub(L(0.97)).normalize();
  // crownshaft of leaf bases
  const boot = lathe([[5.6, -10, true], [7.4, -5], [7.8, 0], [6.2, 4], [3, 7], [0.01, 8]], 10);
  boot.applyMatrix4(new THREE.Matrix4().makeTranslation(top.x, top.y, top.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), T))));
  uvXform(boot, 1 / 64, 1 / 64);
  pb.add('wood:door', boot, null, [0.55, 0.45, 0.34]);
  // dead fronds hanging down around the trunk
  const crown = top.clone().add(new THREE.Vector3(0, 4, 0));
  for (let k = 0; k < 7; k++) frond(pb, 'frond:dead', crown.clone().add(new THREE.Vector3(0, -4, 0)), r.f(0, Math.PI * 2), r.f(-80, -62) * DEG, r.f(45, 65), r.f(16, 22), 2, 0.5, 8, [0.95, 0.9, 0.85], r.f(-0.5, 0.5));
  // live fronds (golden-angle spiral)
  const nf = 22 + r.i(0, 5);
  for (let k = 0; k < nf; k++) {
    const az = k * 2.39996 + r.f(-0.2, 0.2);
    const tier = k / nf;
    const elev = lerp(72, 18, tier) * DEG + r.f(-6, 6) * DEG;
    const len = r.f(70, 96) * (0.8 + 0.2 * (1 - Math.abs(tier - 0.6) * 1.6));
    const g = r.f(0.85, 1.05);
    const droop = len * lerp(0.25, 0.95, tier) * r.f(0.85, 1.15);
    frond(pb, 'frond', crown.clone().add(new THREE.Vector3(0, r.f(-2.5, 2.5), 0)), az, elev, len, r.f(30, 40), droop, 0.85, 12, [g, g, g * 0.95], r.f(-0.35, 0.35));
  }
  // date clusters
  for (let k = 0; k < 4; k++) {
    const a = r.f(0, Math.PI * 2);
    for (let j = 0; j < 10; j++) {
      const s = new THREE.IcosahedronGeometry(r.f(0.9, 1.3), 0);
      s.translate(crown.x + Math.cos(a) * r.f(5, 9), crown.y - r.f(3, 12), crown.z + Math.sin(a) * r.f(5, 9));
      pb.add('plain:0.6', s, null, [0.72, 0.42, 0.14]);
    }
  }
  const pts = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push([Math.cos(a) * 9, Math.sin(a) * 9]); }
  pb.prism(pts, 0, Math.min(h, 140), 'wood');
  pb.userData.crown = crown.toArray();
  return pb.finish();
}

// ---- potted plants / shrubs ---------------------------------------------------------------------------
function terracottaPot(pb, R = 9, H = 12) {
  const prof = [[R * 0.62, 0, true], [R * 0.75, H * 0.08], [R * 0.9, H * 0.55], [R * 0.95, H * 0.84, true], [R * 1.08, H * 0.86, true], [R * 1.08, H, true], [R * 0.92, H, true], [R * 0.85, H * 0.9]];
  const g = lathe(prof, 16); uvXform(g, 1 / 40, 1 / 40);
  pb.add('stone:clay', g, null, [1, 0.95, 0.9]);
  const soil = disc(R * 0.86, H * 0.86, 14, 1); uvXform(soil, 1 / 40, 1 / 40); pb.add('stone:sand', soil, null, [0.42, 0.34, 0.26]);
  return H * 0.86;
}
function blade(pb, base, az, elev, len, w, curl, col) {
  const up = new THREE.Vector3(0, 1, 0), dirH = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
  const P = (t) => base.clone().addScaledVector(dirH, t * len * Math.cos(elev)).addScaledVector(up, t * len * Math.sin(elev) - curl * t * t * len);
  const pos = [], cols = [], idx = [], segs = 6;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, p = P(t), T = P(Math.min(1, t + 0.05)).sub(P(Math.max(0, t - 0.05))).normalize();
    const S = new THREE.Vector3().crossVectors(T, up).normalize(), N = new THREE.Vector3().crossVectors(S, T);
    const ww = w * (1 - t) * (0.6 + 0.4 * Math.sin(Math.min(1, t * 3) * Math.PI / 2));
    for (const k of [-1, 0, 1]) {
      const q = p.clone().addScaledVector(S, k * ww).addScaledVector(N, -Math.abs(k) * ww * 0.5);
      pos.push(q.x, q.y, q.z);
      const dry = smooth(0.7, 1, t);
      cols.push(lerp(col[0], 0.55, dry), lerp(col[1], 0.45, dry), lerp(col[2], 0.3, dry));
    }
    if (i) { const a = (i - 1) * 3; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx); g.computeVertexNormals();
  pb.add('foliage', g);
}

/** plant(variant): 0 potted agave, 1 dry desert shrub (no pot), 2 small potted palm. */
export function plant(variant = 0) {
  const pb = new PropBuilder('plant', 'p' + variant), r = pb.rand;
  if (variant === 1) {
    // dry twiggy shrub: recursive thin branches
    const grow = (p, dir, len, rad, depth) => {
      const end = p.clone().addScaledVector(dir, len);
      const mid = p.clone().lerp(end, 0.5).add(new THREE.Vector3(r.f(-1, 1), r.f(-0.5, 0.5), r.f(-1, 1)).multiplyScalar(len * 0.12));
      const g = sweep(new THREE.QuadraticBezierCurve3(p, mid, end), 3, 3, (t) => rad * (1 - t * 0.6));
      pb.add('foliage', g, null, [0.42, 0.36, 0.28]);
      if (depth > 0) for (let k = 0; k < (depth > 1 ? 3 : 2); k++) {
        const d2 = dir.clone().add(new THREE.Vector3(r.f(-0.8, 0.8), r.f(-0.1, 0.5), r.f(-0.8, 0.8))).normalize();
        grow(end, d2, len * r.f(0.55, 0.75), rad * 0.6, depth - 1);
      } else {
        for (let j = 0; j < 3; j++) {
          const t = new THREE.IcosahedronGeometry(r.f(0.5, 0.9), 0); t.scale(1, 0.55, 1);
          t.translate(end.x + r.f(-1, 1), end.y + r.f(-0.8, 0.4), end.z + r.f(-1, 1));
          const k = r.f(0.8, 1.1);
          pb.add('foliage', t, null, [0.36 * k, 0.38 * k, 0.26 * k]);
        }
      }
    };
    for (let k = 0; k < 6; k++) grow(new THREE.Vector3(r.f(-1.5, 1.5), 0, r.f(-1.5, 1.5)), new THREE.Vector3(r.f(-0.7, 0.7), 1, r.f(-0.7, 0.7)).normalize(), r.f(7, 11), 0.5, 2);
    return pb.finish();
  }
  const top = terracottaPot(pb, 9, 13);
  if (variant === 2) {
    for (let k = 0; k < 9; k++) frond(pb, 'frond', new THREE.Vector3(0, top + 2, 0), k * 2.4, r.f(40, 75) * DEG, r.f(22, 30), 12, r.f(8, 14), 0.8, 8, [1, 1, 1], r.f(-0.3, 0.3));
    pb.add('wood:door', rod([0, top - 1, 0], [0, top + 3, 0], 1.6, 8), null, [0.5, 0.42, 0.34]);
  } else {
    const base = new THREE.Vector3(0, top, 0);
    for (let k = 0; k < 22; k++) {
      const tier = k / 22;
      const g = r.f(0.9, 1.1);
      blade(pb, base, k * 2.39996, lerp(80, 18, tier) * DEG, r.f(12, 19) * lerp(0.75, 1, tier), r.f(1.4, 2), r.f(0.1, 0.35) * tier, [0.42 * g, 0.54 * g, 0.44 * g]);
    }
  }
  pb.weather((x, y) => lerp(0.8, 1, smooth(0, 3, y)), ['foliage', 'frond']);
  const pts = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push([Math.cos(a) * 9.5, Math.sin(a) * 9.5]); }
  pb.prism(pts, 0, 13, 'default');
  return pb.finish();
}

// ---- rubble -----------------------------------------------------------------------------------------
function rock(r, size, rough = 0.25) {
  const g = new THREE.IcosahedronGeometry(1, r.chance(0.5) ? 0 : 1);
  const p = g.attributes.position, s = [size * r.f(0.7, 1.3), size * r.f(0.35, 0.8), size * r.f(0.7, 1.3)], seed = r.f(0, 100);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (vn(x * 1.7 + seed, y * 1.7 + z * 1.3) - 0.5) * rough * 2;
    p.setXYZ(i, x * s[0] * k, y * s[1] * k, z * s[2] * k);
  }
  g.computeVertexNormals();
  return boxUV(g, 1 / 32, [r.f(0, 1), r.f(0, 1)]);
}
/** rubble(radius = 32): low debris mound of stones, broken bricks and plaster chunks (walkable, no colliders). */
export function rubble(radius = 32) {
  const pb = new PropBuilder('rubble', String(radius)), r = pb.rand;
  const H = radius * 0.3, rings = 7, sec = 20;
  const hAt = (x, z) => { const d = Math.hypot(x, z) / radius; return d >= 1 ? 0 : H * (1 - d * d) ** 1.6 * (0.8 + 0.4 * vn(x / 10 + 3, z / 10)); };
  const pos = [], idx = [];
  pos.push(0, hAt(0, 0), 0);
  for (let i = 1; i <= rings; i++) for (let j = 0; j < sec; j++) {
    const a = (j / sec) * Math.PI * 2, rr = (i / rings) * radius * (0.9 + 0.2 * vn(j * 0.9, i));
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    pos.push(x, i === rings ? -0.3 : hAt(x, z), z);
  }
  for (let j = 0; j < sec; j++) idx.push(0, 1 + ((j + 1) % sec), 1 + j);
  for (let i = 1; i < rings; i++) for (let j = 0; j < sec; j++) {
    const a = 1 + (i - 1) * sec + j, b = 1 + (i - 1) * sec + ((j + 1) % sec), c = a + sec, d = b + sec;
    idx.push(a, b, c, b, d, c);
  }
  let mound = new THREE.BufferGeometry();
  mound.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); mound.setIndex(idx);
  mound = boxUV(mound.toNonIndexed(), 1 / 48); mound.computeVertexNormals();
  pb.add('stone:sand', mound, null, [0.9, 0.84, 0.74]);
  const n = Math.round(16 + radius * 1.1);
  for (let k = 0; k < n; k++) {
    const a = r.f(0, Math.PI * 2), d = Math.sqrt(r.next()) * radius * 0.95, x = Math.cos(a) * d, z = Math.sin(a) * d;
    const kind = r.next();
    let g, col;
    if (kind < 0.6) { g = rock(r, r.f(1.5, 6) * (1 - d / radius * 0.45)); const k = r.f(0.85, 1.05); col = [k, k * r.f(0.9, 0.97), k * r.f(0.8, 0.9)]; }
    else if (kind < 0.75) { g = boxUV(cbox([-4, 0, -2], [4, 2.4, 2], 0.3), 1 / 32, [r.f(0, 1), 0]); col = [0.9, 0.7, 0.58]; }
    else { g = rock(r, r.f(2.5, 6), 0.12); g.scale(1, 0.4, 1); col = [1.06, 1.04, 1.0]; }
    g.applyMatrix4(mat(x, hAt(x, z) - 0.6, z, r.f(-0.6, 0.6), r.f(0, 6.3), r.f(-0.6, 0.6)));
    pb.add('stone:sand', g, null, col);
  }
  return pb.finish();
}

// ---- clay urns ----------------------------------------------------------------------------------------
/** urn(variant): 0 round-bellied jar, 1 tall two-handled amphora, 2 wide low pot. Terracotta, sun-bleached. */
export function urn(variant = 0) {
  const pb = new PropBuilder('urn', 'u' + variant);
  const profs = [
    [[4, 0, true], [6.5, 0.8], [9.2, 4.5], [10, 8.5], [9.2, 12.5], [6.6, 15.6], [4.4, 17.2], [4.1, 18.6, true], [5.2, 19, true], [5.2, 20, true], [4.3, 20.2, true], [3.5, 19], [3.3, 16.5], [0.01, 15]],
    [[3.2, 0, true], [4.4, 1], [8.4, 8], [9.6, 14], [8.8, 21], [5.4, 27.5], [3.8, 30], [3.8, 33, true], [5, 33.4, true], [5, 34.6, true], [3.2, 34.6, true], [2.9, 32], [0.01, 29]],
    [[6, 0, true], [8.6, 0.6], [11.6, 3.5], [12.8, 7], [12.4, 9.5, true], [13.4, 10, true], [13.4, 11, true], [11.8, 11, true], [11.2, 9], [0.01, 7.5]],
  ];
  const v = ((variant % 3) + 3) % 3, prof = profs[v];
  const g = lathe(prof, 18); uvXform(g, 1 / 40, 1 / 40);
  const topY = prof[prof.length - 1][1];
  paint(g, (x, y, z, nx, ny) => {
    const inside = Math.hypot(x, z) < prof[prof.length - 3][0] - 0.1 && y > topY - 0.5 && ny > -2 ? 1 : 0;
    const dust = smooth(4, 14, y) * 0.08;
    const k = inside && y < prof[prof.length - 4][1] ? 0.35 : 1;
    return [(1 + dust) * k, (0.96 + dust) * k, (0.9 + dust) * k];
  });
  pb.add('stone:clay', g);
  if (v === 1) {
    for (const s of [-1, 1]) {
      const c = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 4.2, 30.5, 0), new THREE.Vector3(s * 8.5, 31, 0), new THREE.Vector3(s * 9.2, 27, 0), new THREE.Vector3(s * 8.4, 23, 0)]);
      const h = sweep(c, 10, 6, 0.9); uvXform(h, 1 / 40, 1 / 40); pb.add('stone:clay', h, null, [0.97, 0.93, 0.88]);
    }
  }
  pb.weather((x, y) => lerp(0.75, 1, smooth(0, 4, y)));
  const R = Math.max(...prof.map((p) => p[0])) + 0.3, pts = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push([Math.cos(a) * R, Math.sin(a) * R]); }
  pb.prism(pts, 0, Math.max(...prof.map((p) => p[1])), 'default');
  return pb.finish();
}

// ---- cut stone ----------------------------------------------------------------------------------------
/** stoneBlocks(w = 48, d = 40, layers = 5): pallet of stacked sandstone blocks (Dust II B site). */
export function stoneBlocks(w = 48, d = 40, layers = 5) {
  const pb = new PropBuilder('stoneBlocks', `${w}:${d}:${layers}`), r = pb.rand;
  buildPallet(pb, w, d);
  const bx = w / 3, bz = d / 4, bh = 8.2;
  let y = 5.5;
  for (let L = 0; L < layers; L++) {
    const rot = L % 2 === 1;
    const nx = rot ? 4 : 3, nz = rot ? 3 : 4, sx = w / nx, sz = d / nz;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      if (L === layers - 1 && r.chance(0.25)) continue;
      const cx = -w / 2 + sx * (i + 0.5) + r.f(-0.4, 0.4), cz = -d / 2 + sz * (j + 0.5) + r.f(-0.4, 0.4);
      const ex = sx / 2 - r.f(0.25, 0.7), ez = sz / 2 - r.f(0.25, 0.7), hh = bh - r.f(0, 0.6);
      const g = boxUV(cbox([-ex, 0, -ez], [ex, hh, ez], r.f(0.5, 1.1)), 1 / 40, [r.f(0, 1), r.f(0, 1)]);
      g.applyMatrix4(mat(cx, y, cz, 0, r.f(-2, 2) * DEG, 0));
      const k = r.f(0.88, 1.06);
      pb.add('stone:sand', g, null, [k, k * r.f(0.95, 1.0), k * r.f(0.88, 0.98)]);
    }
    y += bh;
  }
  pb.weather((x, yy) => lerp(0.8, 1, smooth(0, 8, yy)));
  pb.box([-w / 2, 0, -d / 2], [w / 2, y, d / 2], 'rock');
  return pb.finish();
}

/** stoneBench(len = 48): limestone slab on two blocks, seat at ~16u. */
export function stoneBench(len = 48) {
  const pb = new PropBuilder('stoneBench', String(len)), r = pb.rand;
  for (const x of [-len / 2 + 8, len / 2 - 8]) pb.add('stone:white', boxUV(cbox([x - 4.5, 0, -6], [x + 4.5, 13, 6], 0.9), 1 / 40, [r.f(0, 1), 0]), null, [0.94, 0.92, 0.88]);
  pb.add('stone:white', boxUV(cbox([-len / 2, 13, -8], [len / 2, 16.5, 8], 1.0), 1 / 40), null, [1, 0.98, 0.95]);
  pb.weather((x, y, z, nx, ny) => lerp(0.72, 1, smooth(0, 6, y)) * (ny > 0.9 ? 1.04 : 1));
  pb.box([-len / 2, 0, -8], [len / 2, 16.5, 8], 'rock');
  return pb.finish();
}

/** archKeystone(w = 14, h = 16, depth = 18): tapered keystone, bottom-centre at origin, centred on z. */
export function archKeystone(w = 14, h = 16, depth = 18) {
  const pb = new PropBuilder('archKeystone', `${w}:${h}:${depth}`);
  const g = slab([[-w * 0.36, 0], [w * 0.36, 0], [w / 2, h], [-w / 2, h]], depth, 1.0, true);
  g.translate(0, 0, -depth / 2);
  pb.add('stone:white', boxUV(g, 1 / 40), null, [0.98, 0.95, 0.9]);
  // carved face panel
  const f = slab([[-w * 0.24, h * 0.18], [w * 0.24, h * 0.18], [w * 0.33, h * 0.84], [-w * 0.33, h * 0.84]], 0.7, 0.3, false);
  f.translate(0, 0, depth / 2);
  pb.add('stone:white', boxUV(f, 1 / 40), null, [0.92, 0.88, 0.82]);
  pb.box([-w / 2, 0, -depth / 2], [w / 2, h, depth / 2], 'rock');
  return pb.finish();
}
