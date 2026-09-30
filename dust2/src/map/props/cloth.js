// Cloth + rope: tarps draped over boxes, tarp-covered crates, awnings, sandbags, ropes, cables.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PropBuilder, rect, cbox, rod, sweep, paint, mat, lerp, smooth, clamp, uvXform, DEG, Rand } from './core.js';
import { vn } from './tex.js';
import { buildCrate } from './crate.js';
import { buildPallet } from './wood.js';

/**
 * Analytic drape of a flat cloth over a box footprint [-hx,hx]×[-hz,hz] of height H.
 * Returns f(px, pz) -> Vector3 for a point of the flat cloth (cloth coords centred on the box).
 */
function drapeFn({ hx, hz, H, lift = 0.3, re = 1.6, ground = 0, wr = 0.6, seed = 1, bulge = 0.8 }) {
  const out = new THREE.Vector3();
  const so = (seed % 97) * 3.1;
  return (px, pz, wrinkle = true) => {
    const qx = clamp(px, -hx, hx), qz = clamp(pz, -hz, hz);
    const dx = px - qx, dz = pz - qz, o = Math.hypot(dx, dz);
    let y, ox = 0, oz = 0;
    if (o < 1e-6) {
      y = H + lift;
      if (wrinkle) y += (vn(px / 9 + so, pz / 9) - 0.5) * wr * 0.8 - 0.15 * Math.sin((px / hx) * Math.PI * 0.5 + 1) ** 2;
      out.set(px, y, pz);
      return out;
    }
    const dxn = dx / o, dzn = dz / o;
    let sOut, down;
    const arc = re * Math.PI / 2;
    if (o < arc) { const a = o / re; sOut = re * Math.sin(a); down = re * (1 - Math.cos(a)); }
    else { down = re + (o - arc); sOut = re + bulge * Math.sin(Math.min(1, down / (H * 0.5)) * Math.PI) * 0.6; }
    const floorDown = H + lift - ground - 0.25;
    if (down > floorDown) { sOut += (down - floorDown) * 0.9; down = floorDown; }
    y = H + lift - down;
    if (wrinkle) {
      // vertical folds along the hanging part, stronger near corners and the hem
      const edgeS = qx * Math.abs(dzn) + qz * Math.abs(dxn);
      const corner = Math.abs(dxn * dzn) * 2;
      const amp = wr * smooth(0, 8, o) * (0.6 + corner * 1.6);
      const fold = Math.sin(edgeS * 0.45 + vn(edgeS / 6 + so, down / 12) * 5) * amp + (vn(edgeS / 4, down / 5 + so) - 0.5) * amp;
      sOut += fold;
      y += (vn(edgeS / 7 + so, 3) - 0.5) * wr * smooth(0, 10, o);
    }
    out.set(qx + dxn * sOut, y, qz + dzn * sOut);
    return out;
  };
}

/** Build a draped cloth grid geometry from drape fn over flat half-extents fx, fz. */
function clothGrid(f, fx, fz, step = 3, hemNoise = 0, seed = 1) {
  const nx = Math.max(4, Math.round((2 * fx) / step)), nz = Math.max(4, Math.round((2 * fz) / step));
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    let px = -fx + (2 * fx * i) / nx, pz = -fz + (2 * fz * j) / nz;
    if (hemNoise && (i === 0 || j === 0 || i === nx || j === nz)) {
      const k = 1 - hemNoise * vn(i * 0.7 + seed, j * 0.7);
      px *= i === 0 || i === nx ? k : 1; pz *= j === 0 || j === nz ? k : 1;
    }
    const p = f(px, pz);
    pos.push(p.x, p.y, p.z); uv.push(px / 48, pz / 48);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rope lying on the drape along flat x at pz (or along z at px when alongZ), extended down to yEnd. */
function ropeOver(pb, f, fx, pz, H, yEnd, r = 0.4, alongZ = false) {
  const pts = [];
  const n = 36, ext = fx + H;
  for (let i = 0; i <= n; i++) {
    const t = -ext + (2 * ext * i) / n;
    const p = (alongZ ? f(pz, t, false) : f(t, pz, false)).clone();
    if (p.y < yEnd) continue;
    // push the rope a bit off the cloth along the local outward direction
    const o = alongZ ? new THREE.Vector3(0, 0, Math.sign(t)) : new THREE.Vector3(Math.sign(t), 0, 0);
    if (Math.abs(t) < fx - H * 0.2) o.set(0, 1, 0);
    p.addScaledVector(o, r * 1.2);
    pts.push(p);
  }
  if (pts.length < 4) return;
  const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const g = sweep(c, 48, 5, r);
  uvXform(g, 1 / 16, 1 / 3);
  pb.add('rope', g);
}

/**
 * tarpCrate(size = 64, color = 'teal', variant = 0): crate with a canvas tarp over its top,
 * hanging a third of the way down, tied with two ropes (Dust II A site).
 */
export function tarpCrate(size = 64, color = 'teal', variant = 0) {
  const [sx, sy, sz] = Array.isArray(size) ? size : [size, size, size];
  const pb = new PropBuilder('tarpCrate', `${sx}:${sy}:${color}:${variant}`);
  buildCrate(pb, [sx, sy, sz], variant, { noLabels: true });
  const hx = sx / 2 + 0.4, hz = sz / 2 + 0.4, hang = sy * 0.34;
  const f = drapeFn({ hx, hz, H: sy + 0.2, lift: 0.35, re: 1.8, wr: 0.7, seed: sx + variant, bulge: 0.5 });
  const g = clothGrid(f, hx + hang, hz + hang, 3, 0.05, sx);
  paint(g, (x, y) => { const k = lerp(0.85, 1, smooth(sy * 0.55, sy, y)); return [k, k, k]; });
  pb.add(`canvas:${color}`, g);
  for (const pz of [-sz * 0.25, sz * 0.25]) ropeOver(pb, f, hx, pz, sy, 1.5, 0.38);
  pb.colliders.length = 0;
  pb.box([-sx / 2 - 1, 0, -sz / 2 - 1], [sx / 2 + 1, sy + 1, sz / 2 + 1], 'crate');
  return pb.finish();
}

/**
 * tarp(w = 56, d = 48, h = 44, color = 'bluegrey'): tarp-covered pallet load (Dust II B site):
 * pallet, a stack of cargo underneath, canvas draped to the pallet and roped down.
 */
export function tarp(w = 56, d = 48, h = 44, color = 'bluegrey') {
  const pb = new PropBuilder('tarp', `${w}:${d}:${h}:${color}`);
  const ph = 5.5;
  buildPallet(pb, w, d);
  // cargo block (mostly hidden) — dark so gaps under the hem read as shadowed goods
  pb.add('wood:tan', cbox([-w / 2 + 1, ph, -d / 2 + 1], [w / 2 - 1, h - 0.5, d / 2 - 1], 0.6), null, [0.35, 0.33, 0.3]);
  const hx = w / 2 - 0.2, hz = d / 2 - 0.2, H = h - ph, hang = H - 2;
  const f = drapeFn({ hx, hz, H: h, lift: 0.3, re: 2.2, wr: 0.9, seed: w + d, ground: ph + 0.3, bulge: 1.2 });
  const g = clothGrid(f, hx + hang, hz + hang, 3.2, 0.06, w);
  paint(g, (x, y) => { const k = lerp(0.8, 1, smooth(ph, h, y)); return [k, k, k]; });
  pb.add(`canvas:${color}`, g);
  for (const pz of [-d * 0.28, d * 0.28]) ropeOver(pb, f, hx, pz, h, ph + 0.5, 0.4);
  ropeOver(pb, f, hz, 0, h, ph + 0.5, 0.4, true);
  pb.colliders.length = 0;
  pb.box([-w / 2, 0, -d / 2], [w / 2, h + 1, d / 2], 'cloth');
  return pb.finish();
}

/**
 * awning(w = 96, d = 40, opts): wall-mounted cloth awning. Origin = centre of the wall attach
 * line (awning hangs below y = 0 and projects to +z). opts: { color = 'teal', style = 'stripe'|'solid', drop }
 */
export function awning(w = 96, d = 40, opts = {}) {
  const pb = new PropBuilder('awning', `${w}:${d}:${JSON.stringify(opts)}`);
  // {color:'stripe'} or {style:'stripe'} → striped teal/cream; otherwise a solid canvas colour
  const striped = opts.style === 'stripe' || opts.color === 'stripe';
  const col = opts.color && opts.color !== 'stripe' ? opts.color : 'teal', drop = opts.drop ?? d * 0.42;
  const M = striped ? `awning:${opts.stripe || col}` : `canvas:${col}`;
  const FR = 'paint:grey';
  const nr = Math.max(2, Math.round(w / 40) + 1);
  const rx = []; for (let i = 0; i < nr; i++) rx.push(-w / 2 + 1.5 + ((w - 3) * i) / (nr - 1));
  // cloth: sags between rafters and between wall and front rail
  const nx = Math.round(w / 2.5), nt = 12, pos = [], uv = [], idx = [];
  const sagAt = (x, t) => {
    let k = 0; for (let i = 0; i < nr - 1; i++) if (x >= rx[i] - 0.01 && x <= rx[i + 1] + 0.01) k = (x - rx[i]) / (rx[i + 1] - rx[i]);
    return 1.4 * Math.sin(k * Math.PI) * Math.sin(t * Math.PI) + 0.5 * Math.sin(t * Math.PI);
  };
  let L = 0;
  const surf = (x, t) => new THREE.Vector3(x, -t * drop - sagAt(x, t) + 0.8, 1 + t * (d - 1) + 1);
  for (let j = 0; j <= nt; j++) {
    const t = j / nt;
    if (j) L += surf(0, t).distanceTo(surf(0, (j - 1) / nt));
    for (let i = 0; i <= nx; i++) { const x = -w / 2 + (w * i) / nx, p = surf(x, t); pos.push(p.x, p.y, p.z); uv.push(x / 64, L / 64); }
  }
  // valance with scalloped hem
  const vh = 7.5, scW = w / Math.max(3, Math.round(w / 14));
  const front = surf(0, 1);
  for (let j = 1; j <= 3; j++) {
    const k = j / 3;
    for (let i = 0; i <= nx; i++) {
      const x = -w / 2 + (w * i) / nx, ph = ((x + w / 2) / scW) % 1;
      const hem = vh - 2.6 * (1 - Math.sin(ph * Math.PI));
      const y = front.y - hem * k, z = d + 1 + Math.sin(x * 0.12) * 0.25 * k + 0.4 * k;
      pos.push(x, y, z); uv.push(x / 64, (L + hem * k) / 64);
    }
  }
  const rows = nt + 1 + 3;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1;
    idx.push(a, c, b, b, c, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  paint(g, (x, y, z) => { const k = lerp(0.8, 1, smooth(0, d * 0.5, z)); return [k, k, k]; });
  pb.add(M, g);
  // frame: wall rail, front rail, rafters, struts
  const pr = 0.7;
  pb.add(FR, paint(rod([-w / 2, 0.8, 1.2], [w / 2, 0.8, 1.2], pr, 6), [0.8, 0.8, 0.8]));
  pb.add(FR, paint(rod([-w / 2, front.y + 0.2, d + 1.4], [w / 2, front.y + 0.2, d + 1.4], pr, 6), [0.8, 0.8, 0.8]));
  for (const x of rx) {
    pb.add(FR, paint(rod([x, 0.3, 1.2], [x, front.y - 0.3, d + 1.4], pr * 0.9, 6), [0.8, 0.8, 0.8]));
    pb.add(FR, paint(rod([x, -drop - 16, 0.4], [x, -drop * 0.55 - 0.6, d * 0.55], pr * 0.8, 5), [0.8, 0.8, 0.8]));
    pb.add('iron', paint(cbox([x - 1.5, -drop - 18, 0], [x + 1.5, -drop - 14, 0.5], 0.15), [0.4, 0.4, 0.4]));
    pb.add('iron', paint(cbox([x - 1.5, -1.2, 0], [x + 1.5, 2.8, 0.5], 0.15), [0.4, 0.4, 0.4]));
  }
  return pb.finish();
}

// ---- sandbags --------------------------------------------------------------------------------------
let bagGeos = null;
function bagVariants() {
  if (bagGeos) return bagGeos;
  bagGeos = [];
  for (let v = 0; v < 3; v++) {
    const r = new Rand(77 + v);
    const hx = 11 + r.f(-0.6, 0.6), hy = 2.9, hz = 5.8 + r.f(-0.3, 0.3);
    let g = new THREE.BoxGeometry(2, 2, 2, 8, 3, 5);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const nx = p.getX(i), ny = p.getY(i), nz = p.getZ(i);
      const puff = (1 - 0.6 * nx ** 6) * (1 - 0.35 * nz ** 4);
      let x = nx * hx * (1 - 0.06 * ny * ny), y = ny * hy * puff, z = nz * hz * (1 - 0.12 * ny * ny) * (1 - 0.1 * nx ** 4);
      // tied ears at the ends
      if (Math.abs(nx) > 0.9) { z *= 0.75; y *= 0.7; x += Math.sign(nx) * 0.6; }
      const lump = (vn(x / 3 + v * 11, z / 3 + y / 2) - 0.5) * 0.9;
      y += (ny > 0 ? lump : lump * 0.3) + (ny > 0 ? -0.3 * nz * nz : 0);
      p.setXYZ(i, x, y + hy * 0.95, z);
    }
    g.computeVertexNormals();
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 24; uv[i * 2 + 1] = (p.getZ(i) + p.getY(i)) / 24; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    bagGeos.push(g);
  }
  return bagGeos;
}
/** sandbags(len = 96, rows = 3): running-bond sandbag wall along x, 12u deep, centred. */
export function sandbags(len = 96, rows = 3) {
  const pb = new PropBuilder('sandbags', `${len}:${rows}`), r = pb.rand;
  const B = bagVariants(), pitch = 21.5, rowH = 5.1;
  for (let k = 0; k < rows; k++) {
    const off = k % 2 ? pitch / 2 : 0;
    const n = Math.max(1, Math.floor((len - off - 2) / pitch + 0.25));
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + off + pitch / 2 + i * pitch + r.f(-0.8, 0.8);
      if (x > len / 2 - 8) continue;
      const g = r.pick(B).clone();
      const m = mat(x, k * rowH, r.f(-0.6, 0.6), r.f(-2, 2) * DEG, r.f(-5, 5) * DEG, r.f(-2.5, 2.5) * DEG, [1, 1 - k * 0.03, 1]);
      const tone = r.f(0.82, 1.05), warm = r.f(-0.04, 0.04);
      pb.add('burlap', g, m, [tone * (1 + warm), tone, tone * (1 - warm * 2)]);
    }
  }
  pb.weather((x, y) => lerp(0.75, 1, smooth(0, 6, y)));
  pb.box([-len / 2, 0, -6], [len / 2, rows * rowH + 1.5, 6], 'sand');
  return pb.finish();
}

/** hangingRope(len = 48): rope looped over an iron peg in the wall (origin on the wall, peg at y = 0), hanging to y ≈ -len. */
export function hangingRope(len = 48) {
  const pb = new PropBuilder('hangingRope', String(len));
  pb.add('iron', paint(rod([0, 0, 0], [0, 0.6, 4.5], 0.55, 6), [0.3, 0.3, 0.3]));
  pb.add('iron', paint(cbox([-1.5, -1.5, 0], [1.5, 1.5, 0.5], 0.15), [0.3, 0.3, 0.3]));
  const r = 0.55;
  for (const side of [-1, 1]) {
    const pts = [new THREE.Vector3(side * 0.2, 1.1, 2.6)];
    const n = 8;
    for (let i = 1; i <= n; i++) { const t = i / n; pts.push(new THREE.Vector3(side * (0.6 + t * 1.5) + Math.sin(t * 5 + side) * 0.5, -t * (len - (side > 0 ? 6 : 0)), 2.6 + side * 0.4 + t * 0.8)); }
    const g = sweep(new THREE.CatmullRomCurve3(pts), 30, 6, r, { twist: side * 12 });
    uvXform(g, 1 / 16, 1 / 3); pb.add('rope', g);
  }
  // knot + frayed tail
  const k = new THREE.SphereGeometry(1.1, 7, 5); k.translate(2.4, -len + 7.5, 3.6); uvXform(k, 1, 1); pb.add('rope', k);
  const tail = new THREE.ConeGeometry(0.9, 3, 6, 1, true); tail.rotateX(Math.PI); tail.translate(-2.4, -len - 1, 3.4); pb.add('rope', tail);
  return pb.finish();
}

/** wireSpan geometry between PARENT-space points (parabolic sag). */
export function wireSpan(a, b, sag = 24, radius = 0.35) {
  const A = a.isVector3 ? a : new THREE.Vector3(...a), B = b.isVector3 ? b : new THREE.Vector3(...b);
  const pb = new PropBuilder('wireSpan', 'w');
  const L = A.distanceTo(B), n = clamp(Math.round(L / 16), 8, 40);
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n; pts.push(A.clone().lerp(B, t).add(new THREE.Vector3(0, -4 * sag * t * (1 - t), 0))); }
  const g = sweep(new THREE.CatmullRomCurve3(pts), n * 2, 4, radius);
  pb.add('plain:0.55', g, null, [0.06, 0.06, 0.06]);
  return pb.finish();
}
