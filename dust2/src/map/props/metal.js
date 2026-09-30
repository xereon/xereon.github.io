// Metal props: drums, jerrycans, steel containers, wall boxes, AC units, dishes, lamps, pipes.
import * as THREE from 'three';
import { PropBuilder, rect, bandPoly, slab, cbox, dome, rod, lathe, relathe, disc, sweep, paint, tintBy, mat, lerp, smooth, clamp, boxUV, uvXform, DEG } from './core.js';
import { labelUV } from './tex.js';

const IRON = [0.42, 0.41, 0.4];
const U = (g, s) => uvXform(g, s, s); // lathe/sweep UVs are in inches → tile scale

/** Octagon prism collider approximating a cylinder. */
function cylCollider(pb, r, y0, y1, surface = 'metal', cx = 0, cz = 0) {
  const pts = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; pts.push([cx + Math.cos(a) * r / Math.cos(Math.PI / 8), cz + Math.sin(a) * r / Math.cos(Math.PI / 8)]); }
  pb.prism(pts, y0, y1, surface);
}

// ---- barrel ------------------------------------------------------------------------------------
const BARRELS = [
  { mat: 'galv', tint: [0.92, 0.95, 0.98] },               // galvanised grey (B site)
  { mat: 'paint:bluegrey', tint: [1, 1, 1] },              // faded blue-grey (A site)
  { mat: 'paint:white', tint: [1, 1, 1], two: [0.3, 0.46, 0.72] }, // blue bottom / white top
  { mat: 'paint:blue', tint: [1, 1, 1] },
  { mat: 'paint:red', tint: [1, 1, 1] },
  { mat: 'paint:olive', tint: [1, 1, 1] },
];
/** barrel(variant): 55-gal steel drum Ø22.5 × 34.5 with rolling hoops, chimes, bungs, dents. */
export function barrel(variant = 0) {
  const V = BARRELS[((variant % BARRELS.length) + BARRELS.length) % BARRELS.length];
  const pb = new PropBuilder('barrel', 'b' + variant), r = pb.rand;
  const R = 11.25, H = 34.5;
  const hoop = (y) => [[R, y - 1.3], [R + 0.35, y - 0.6], [R + 0.5, y], [R + 0.35, y + 0.6], [R, y + 1.3]];
  const prof = [[R - 0.6, 0, true], [R + 0.2, 0.35], [R + 0.35, 1.0], [R + 0.1, 1.7], [R, 2.1, true],
    ...hoop(H * 0.335), ...hoop(H * 0.665),
    [R, H - 2.1, true], [R + 0.1, H - 1.7], [R + 0.35, H - 1.0], [R + 0.2, H - 0.35], [R - 0.3, H, true], [R - 0.55, H - 0.35, true], [R - 0.75, H - 1.1, true], [0.01, H - 1.1]];
  const g = lathe(prof, 22);
  // dents: push a couple of patches inward, then re-smooth
  const dents = [];
  for (let k = 0; k < r.i(1, 3); k++) dents.push({ a: r.f(0, Math.PI * 2), y: r.f(4, H - 5), d: r.f(0.4, 1.1), s: r.f(3, 6) });
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), rr = Math.hypot(x, z);
    if (rr < R - 1 || y > H - 1.5) continue;
    const a = Math.atan2(x, z);
    let d = 0;
    for (const t of dents) { let da = a - t.a; da = Math.atan2(Math.sin(da), Math.cos(da)); const ds = da * R, dy = y - t.y; d += t.d * Math.exp(-(ds * ds + dy * dy) / (t.s * t.s)); }
    if (d > 0.01) { const k = (rr - d) / rr; p.setXYZ(i, x * k, y, z * k); }
  }
  relathe(g);
  U(g, 1 / 72);
  paint(g, (x, y) => {
    let c = V.tint;
    if (V.two) c = y < H * 0.52 ? V.two : [1, 1, 1];
    const lid = y > H - 1.2 ? 0.82 : 1;
    return [c[0] * lid, c[1] * lid, c[2] * lid];
  });
  pb.add(V.mat, g);
  // bungs on the lid
  for (const [bx, bz, br] of [[R * 0.6, 0, 1.3], [-R * 0.62, 1.2, 0.8]]) {
    const b = lathe([[br + 0.5, 0, true], [br + 0.4, 0.3, true], [br, 0.35, true], [br, 0.7, true], [br * 0.5, 0.75], [0.01, 0.75]], 8);
    b.translate(bx, H - 1.1, bz); U(b, 1 / 72); pb.add(V.mat, b, null, [0.75, 0.74, 0.72]);
  }
  pb.weather((x, y, z, nx, ny) => lerp(0.62, 1, smooth(0, 9, y)) * (ny > 0.9 ? 0.9 : 1));
  cylCollider(pb, R + 0.3, 0, H);
  return pb.finish();
}

// ---- jerrycan ------------------------------------------------------------------------------------
const CAN_COL = ['olive', 'red', 'sand', 'grey'];
/** jerrycan(variant): 20 L can, 13.8 × 18.5 × 6.5, embossed X, triple handle, spout. */
export function jerrycan(variant = 0) {
  const P = `paint:${CAN_COL[((variant % 4) + 4) % 4]}:0.3`;
  const pb = new PropBuilder('jerrycan', 'j' + variant);
  const Wd = 13.8, Hb = 16.8, D = 6.5, bev = 0.9;
  const sh = new THREE.Shape();
  const rr = 1.4, cut = 3.2;
  sh.moveTo(-Wd / 2 + rr, 0); sh.lineTo(Wd / 2 - rr, 0); sh.quadraticCurveTo(Wd / 2, 0, Wd / 2, rr);
  sh.lineTo(Wd / 2, Hb - cut); sh.lineTo(Wd / 2 - cut, Hb); sh.lineTo(-Wd / 2 + rr, Hb); sh.quadraticCurveTo(-Wd / 2, Hb, -Wd / 2, Hb - rr);
  sh.lineTo(-Wd / 2, rr); sh.quadraticCurveTo(-Wd / 2, 0, -Wd / 2 + rr, 0);
  let body = new THREE.ExtrudeGeometry(sh, { depth: D - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.8, bevelSegments: 2, curveSegments: 3 });
  body.translate(0, bev * 0.8, -(D - 2 * bev) / 2);
  body = boxUV(body, 1 / 48);
  pb.add(P, body);
  // embossed X on both faces
  const inset = rect(-Wd / 2 + 1.8, 2.2, Wd / 2 - 1.8, Hb - 2.2);
  for (const side of [1, -1]) {
    const M = new THREE.Matrix4().makeRotationY(side > 0 ? 0 : Math.PI).multiply(new THREE.Matrix4().makeTranslation(0, 0, D / 2 - 0.05));
    for (const [a, b] of [[[inset[0][0], inset[0][1]], [inset[2][0], inset[2][1]]], [[inset[1][0], inset[1][1]], [inset[3][0], inset[3][1]]]]) {
      const g = slab(bandPoly(a, b, 1.6, inset), 0.4, 0.18, false); pb.add(P, boxUV(g, 1 / 48), M);
    }
    const rim = slab(rect(-Wd / 2 + 1.2, 1.6, Wd / 2 - 1.2, 2.2), 0.3, 0.1, false); pb.add(P, boxUV(rim, 1 / 48), M);
  }
  // triple handle across the thickness
  const hy = Hb + bev * 0.8;
  for (const hx of [-3.6, -1.2, 1.2]) {
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(hx, hy - 0.3, -D / 2 + 1), new THREE.Vector3(hx, hy + 1.8, -D / 2 + 1.4), new THREE.Vector3(hx, hy + 2.1, 0), new THREE.Vector3(hx, hy + 1.8, D / 2 - 1.4), new THREE.Vector3(hx, hy - 0.3, D / 2 - 1)]);
    pb.add(P, U(sweep(c, 10, 5, 0.5), 1 / 48));
  }
  // spout on the chamfer
  const sp = lathe([[1.4, 0, true], [1.4, 1.4, true], [1.8, 1.5, true], [1.8, 2.6, true], [0.01, 2.7]], 10);
  sp.applyMatrix4(mat(Wd / 2 - cut / 2 + 0.2, Hb - cut / 2 + 0.4, 0, 0, 0, -45 * DEG));
  pb.add(P, U(sp, 1 / 48), null, [0.9, 0.9, 0.9]);
  const lever = cbox([-0.6, 0, -0.5], [0.6, 3.2, 0.5], 0.2); lever.applyMatrix4(mat(Wd / 2 - cut - 0.3, Hb + 0.9, 0, 0, 0, 30 * DEG));
  pb.add('iron', paint(lever, IRON));
  pb.weather((x, y) => lerp(0.7, 1, smooth(0, 5, y)));
  pb.box([-Wd / 2, 0, -D / 2], [Wd / 2, hy + 2.3, D / 2], 'metal');
  return pb.finish();
}

// ---- metal crate (steel box container) --------------------------------------------------------------
/**
 * metalCrate(size = [80, 56, 56], variant): corrugated steel storage box with corner posts,
 * rails, end doors with locking bars and a stencil. variant 0 blue, 1 green, 2 teal, 3 grey.
 */
export function metalCrate(size = [80, 56, 56], variant = 0) {
  const [L0, H, D0] = Array.isArray(size) ? size : [size * 1.4, size, size];
  // doors always go on a short end: build long-along-x, then turn if the caller wants it along z
  const turn = D0 > L0, L = turn ? D0 : L0, D = turn ? L0 : D0;
  const col = ['blue', 'green', 'teal', 'grey'][((variant % 4) + 4) % 4];
  const P = `paint:${col}:0.35`;
  const pb = new PropBuilder('metalCrate', `${L}:${H}:${D}:${variant}`);
  const t = 3, hx = L / 2, hz = D / 2;
  // posts + rails
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pb.add(P, boxUV(cbox([sx * hx - (sx > 0 ? t : 0), 0, sz * hz - (sz > 0 ? t : 0)], [sx * hx + (sx < 0 ? t : 0), H, sz * hz + (sz < 0 ? t : 0)], 0.35), 1 / 64), null, [0.85, 0.85, 0.85]);
  for (const y of [0, H - t]) {
    for (const sz of [-1, 1]) pb.add(P, boxUV(cbox([-hx + t, y, sz > 0 ? hz - t : -hz], [hx - t, y + t, sz > 0 ? hz : -hz + t], 0.35), 1 / 64));
    for (const sx of [-1, 1]) pb.add(P, boxUV(cbox([sx > 0 ? hx - t : -hx, y, -hz + t], [sx > 0 ? hx : -hx + t, y + t, hz - t], 0.35), 1 / 64));
  }
  // corrugated walls (long sides + back end)
  const corr = (len, h, M) => {
    const pitch = 7, dep = 1.1, pos = [], uv = [];
    const prof = [];
    for (let x = 0; x < len - 0.01; x += pitch) {
      const q = [[0, 0], [2.4, 0], [3.4, dep], [5.9, dep], [6.9, 0]];
      for (const [a, z] of q) if (x + a <= len) prof.push([x + a, z]);
    }
    prof.push([len, 0]);
    for (let i = 0; i < prof.length - 1; i++) {
      const [x0, z0] = prof[i], [x1, z1] = prof[i + 1];
      pos.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, 0, z0, x1, h, z1, x0, h, z0);
      uv.push(x0 / 64, 0, x1 / 64, 0, x1 / 64, h / 64, x0 / 64, 0, x1 / 64, h / 64, x0 / 64, h / 64);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    pb.add(P, g, M);
  };
  const ch = H - 2 * t;
  corr(L - 2 * t, ch, mat(-hx + t, t, hz - t - 1.2));                    // +z side
  corr(L - 2 * t, ch, mat(hx - t, t, -hz + t + 1.2, 0, Math.PI));        // -z side
  corr(D - 2 * t, ch, mat(-hx + t + 1.2, t, -hz + t, 0, -Math.PI / 2));  // -x end
  // roof
  pb.add(P, boxUV(cbox([-hx + t, H - t - 0.2, -hz + t], [hx - t, H - 0.6, hz - t], 0.1), 1 / 64));
  for (let x = -hx + 10; x < hx - 6; x += 10) pb.add(P, boxUV(cbox([x - 1.2, H - 0.6, -hz + t], [x + 1.2, H - 0.2, hz - t], 0.3), 1 / 64));
  // doors on the +x end
  const dw = (D - 2 * t) / 2;
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -hz + t : 0, z1 = s < 0 ? 0 : hz - t;
    const leaf = cbox([hx - t - 0.4, t, z0 + 0.2], [hx - t + 0.8, H - t, z1 - 0.2], 0.25);
    leaf.rotateY(0); pb.add(P, boxUV(leaf, 1 / 64), null, [0.95, 0.95, 0.95]);
    for (const y of [H * 0.3, H * 0.7]) pb.add(P, boxUV(cbox([hx - t + 0.8, y - 1.5, z0 + 1.5], [hx - t + 1.3, y + 1.5, z1 - 1.5], 0.2), 1 / 64));
    // locking bars with cams + handle
    const bz = (z0 + z1) / 2 + s * dw * 0.15;
    pb.add('iron', paint(rod([hx - t + 2, t - 1, bz], [hx - t + 2, H - t + 1, bz], 0.55, 6), IRON));
    for (const y of [t + 2, H * 0.5, H - t - 2]) pb.add('iron', paint(cbox([hx - t + 0.8, y - 1, bz - 1.4], [hx - t + 2.6, y + 1, bz + 1.4], 0.2), IRON));
    const hd = cbox([hx - t + 2, H * 0.42 - 0.5, bz], [hx - t + 2.8, H * 0.42 + 0.5, bz - s * 8], 0.2); pb.add('iron', paint(hd, IRON));
  }
  // stencil on the +z side
  const uvL = labelUV('num07');
  const lw = Math.min(L * 0.4, 36), lh = lw / 2;
  const lg = new THREE.PlaneGeometry(lw, lh); lg.translate(-hx * 0.3, H * 0.55, hz - t - 1.2 + 1.2 + 0.08);
  const luv = lg.attributes.uv; for (let i = 0; i < luv.count; i++) luv.setXY(i, lerp(uvL.u0, uvL.u1, luv.getX(i)), lerp(uvL.v0, uvL.v1, luv.getY(i)));
  pb.add('label', lg, null, [0.95, 0.95, 0.95]);
  pb.weather((x, y) => lerp(0.62, 1, smooth(0, 12, y)), ['label']);
  pb.box([-hx, 0, -hz], [hx, H, hz], 'metal');
  if (turn) {
    const R = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    for (const list of pb.buckets.values()) for (const g of list) g.applyMatrix4(R);
    pb.colliders = [{ min: [-hz, 0, -hx], max: [hz, H, hx], surface: 'metal' }];
  }
  return pb.finish();
}

// ---- wall boxes ------------------------------------------------------------------------------------
/** electricBox(): wall-mounted steel electrical cabinet, back on the wall (z = 0), bottom at y = 0; conduits rise to y ≈ 60. */
export function electricBox(color = 'grey') {
  const pb = new PropBuilder('electricBox', color);
  const P = `paint:${color}`, w = 18, h = 26, d = 8;
  pb.add(P, boxUV(cbox([-w / 2, 0, 0], [w / 2, h, d], 0.7), 1 / 48));
  // door panel + hinge knuckles + handle
  pb.add(P, boxUV(cbox([-w / 2 + 1, 1, d - 0.2], [w / 2 - 1, h - 1, d + 0.35], 0.25), 1 / 48), null, [1.02, 1.02, 1.02]);
  for (const y of [5, h - 5]) pb.add(P, paint(rod([-w / 2 + 0.6, y - 1.5, d + 0.2], [-w / 2 + 0.6, y + 1.5, d + 0.2], 0.45, 6), [0.8, 0.8, 0.8]));
  pb.add('iron', paint(cbox([w / 2 - 3.2, h * 0.5 - 2.5, d + 0.35], [w / 2 - 2, h * 0.5 + 2.5, d + 1.3], 0.2), IRON));
  // rain hood
  const hood = cbox([-w / 2 - 1, 0, -0.5], [w / 2 + 1, 0.6, d + 2], 0.2); hood.applyMatrix4(mat(0, h + 0.2, 0, -8 * DEG, 0, 0)); pb.add(P, boxUV(hood, 1 / 48));
  // hazard sticker
  const uvL = labelUV('hazard'), lg = new THREE.PlaneGeometry(9, 4.5); lg.translate(0, h * 0.68, d + 0.38);
  const luv = lg.attributes.uv; for (let i = 0; i < luv.count; i++) luv.setXY(i, lerp(uvL.u0, uvL.u1, luv.getX(i)), lerp(uvL.v0, uvL.v1, luv.getY(i)));
  pb.add('label', lg);
  // conduits rising and bending into the wall, with saddle clamps
  for (const x of [-4.5, 4.5]) {
    const top = x < 0 ? 62 : 54;
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(x, h - 1, 3), new THREE.Vector3(x, h + 4, 3), new THREE.Vector3(x, top - 6, 2.2), new THREE.Vector3(x, top - 1.5, 1.6), new THREE.Vector3(x, top, 0.2)]);
    pb.add('galv', U(sweep(c, 16, 6, 0.8), 1 / 64), null, [0.85, 0.85, 0.85]);
    for (const y of [h + 10, top - 12]) pb.add('iron', paint(cbox([x - 1.4, y - 0.6, 0], [x + 1.4, y + 0.6, 3.3], 0.2), IRON));
  }
  pb.weather((x, y) => lerp(0.8, 1, smooth(0, 10, y)), ['label']);
  pb.box([-w / 2, 0, 0], [w / 2, h, d + 1], 'metal');
  return pb.finish();
}

/** meterBox(): cream plastic electricity meter housing with a window; wall at z = 0, bottom at y = 0. */
export function meterBox() {
  const pb = new PropBuilder('meterBox', 'm');
  const P = 'paint:cream', w = 11, h = 19, d = 5.5;
  const sh = new THREE.Shape(), rr = 2.2;
  sh.moveTo(-w / 2 + rr, 0); sh.lineTo(w / 2 - rr, 0); sh.quadraticCurveTo(w / 2, 0, w / 2, rr); sh.lineTo(w / 2, h - rr); sh.quadraticCurveTo(w / 2, h, w / 2 - rr, h);
  sh.lineTo(-w / 2 + rr, h); sh.quadraticCurveTo(-w / 2, h, -w / 2, h - rr); sh.lineTo(-w / 2, rr); sh.quadraticCurveTo(-w / 2, 0, -w / 2 + rr, 0);
  const body = new THREE.ExtrudeGeometry(sh, { depth: d - 1.2, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 2, curveSegments: 4 });
  body.translate(0, 0, 0.6);
  pb.add(P, boxUV(body, 1 / 32));
  // window frame + glass + dial
  pb.add(P, boxUV(cbox([-w / 2 + 1.5, h - 8.5, d], [w / 2 - 1.5, h - 1.8, d + 0.5], 0.25), 1 / 32), null, [0.8, 0.8, 0.78]);
  pb.add('glass', boxUV(cbox([-w / 2 + 2.1, h - 7.9, d + 0.3], [w / 2 - 2.1, h - 2.4, d + 0.62], 0.1), 1 / 16));
  pb.add(P, boxUV(cbox([-w / 2 + 2, 3, d], [w / 2 - 2, 7, d + 0.3], 0.15), 1 / 32), null, [0.7, 0.7, 0.68]);
  // cable dropping to the ground
  const c = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.5, 2.5), new THREE.Vector3(0, -6, 2.4), new THREE.Vector3(0.5, -30, 1.6)]);
  pb.add('plain:0.6', sweep(c, 8, 5, 0.5), null, [0.1, 0.1, 0.1]);
  pb.box([-w / 2, 0, 0], [w / 2, h, d], 'metal');
  return pb.finish();
}

/** acUnit(): split AC outdoor unit on wall brackets. Wall at z = 0, unit bottom at y = 0 (brackets go below). */
export function acUnit() {
  const pb = new PropBuilder('acUnit', 'ac');
  const P = 'paint:white:0.04', w = 32, h = 22, d = 12, z0 = 2;
  pb.add(P, boxUV(cbox([-w / 2, 0, z0], [w / 2, h, z0 + d], 0.8), 1 / 48));
  // fan grille: dark recess + concentric rings + spokes
  const fx = -w / 2 + 11.5, fy = h / 2, fr = 8.4, fz = z0 + d;
  const well = disc(fr, 0, 20, 1); well.rotateX(Math.PI / 2); well.translate(fx, fy, fz - 1.2); pb.add(P, well, null, [0.12, 0.12, 0.12]);
  const blade = lathe([[2, 0, true], [1.5, 1.2], [0.01, 1.4]], 10); blade.rotateX(Math.PI / 2); blade.translate(fx, fy, fz - 1.4); pb.add(P, blade, null, [0.25, 0.25, 0.25]);
  for (let k = 1; k <= 5; k++) { const t = new THREE.TorusGeometry((fr * k) / 5.2, 0.18, 4, 28); t.translate(fx, fy, fz + 0.15); pb.add('iron', paint(t, [0.3, 0.3, 0.3])); }
  for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 4; pb.add('iron', paint(rod([fx - Math.cos(a) * fr, fy - Math.sin(a) * fr, fz + 0.1], [fx + Math.cos(a) * fr, fy + Math.sin(a) * fr, fz + 0.1], 0.18, 4), [0.3, 0.3, 0.3])); }
  const bez = new THREE.TorusGeometry(fr + 0.4, 0.5, 5, 28); bez.translate(fx, fy, fz); pb.add(P, bez, null, [0.9, 0.9, 0.88]);
  // side louvres on the right third
  for (let y = 3; y < h - 3; y += 2.2) pb.add(P, boxUV(cbox([w / 2 - 9, y, fz - 0.2], [w / 2 - 2, y + 0.9, fz + 0.4], 0.2), 1 / 48), null, [0.8, 0.8, 0.8]);
  // brackets
  for (const x of [-w / 2 + 4, w / 2 - 4]) {
    pb.add('iron', paint(cbox([x - 0.8, -0.4, 0], [x + 0.8, 0, z0 + d + 1], 0.1), IRON));
    pb.add('iron', paint(cbox([x - 0.8, -12, 0], [x + 0.8, 0, 0.6], 0.1), IRON));
    const br = cbox([-0.7, 0, -0.3], [0.7, Math.hypot(12, d) - 1, 0.3], 0.1); br.applyMatrix4(mat(x, -11, 0.6, Math.atan2(d, 12), 0, 0)); pb.add('iron', paint(br, IRON));
  }
  // refrigerant lines into the wall
  for (const [dy, r] of [[4, 0.9], [7, 0.6]]) {
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(w / 2 - 1, dy, z0 + d - 3), new THREE.Vector3(w / 2 + 3, dy, z0 + d - 4), new THREE.Vector3(w / 2 + 4, dy + 2, 3), new THREE.Vector3(w / 2 + 4, dy + 8, 0.2)]);
    pb.add(P, U(sweep(c, 10, 6, r), 1 / 48), null, r > 0.8 ? [0.2, 0.2, 0.2] : [0.85, 0.65, 0.45]);
  }
  pb.weather((x, y, z, nx, ny) => (ny > 0.9 ? 0.85 : 1) * lerp(0.85, 1, smooth(0, 8, y)));
  pb.box([-w / 2, 0, z0], [w / 2, h, z0 + d], 'metal');
  return pb.finish();
}

/** satelliteDish(opts): offset dish on a wall bracket (wall at z = 0), or on a roof tripod ({roof:true}). */
export function satelliteDish(opts = {}) {
  const pb = new PropBuilder('satelliteDish', opts.roof ? 'roof' : 'wall');
  const P = 'plain:0.45', R = 16, f = 14; // clean white pressed steel
  const rim = (R * R) / (4 * f);
  const prof = [[0.01, -0.5], [R * 0.5, (R * R) / (16 * f) - 0.5], [R, rim - 0.5], [R + 0.5, rim - 0.2, true], [R + 0.4, rim + 0.2, true], [R, rim, true], [R * 0.5, (R * R) / (16 * f)], [0.01, 0]];
  const dish = lathe(prof, 24);
  U(dish, 1 / 48);
  dish.scale(1, 1, 0.92);
  // dish faces +y in lathe space; aim it out (+z) and up
  const aim = mat(0, 0, 0, -58 * DEG, 0, 0);
  const base = opts.roof ? new THREE.Vector3(0, 30, 6) : new THREE.Vector3(0, 0, 20);
  const M = new THREE.Matrix4().makeTranslation(base.x, base.y, base.z).multiply(aim);
  pb.add(P, dish, M, [0.86, 0.86, 0.84]);
  // LNB arm from the lower rim to the focus + LNB
  const lo = new THREE.Vector3(0, rim, -R * 0.92).applyMatrix4(M), foc = new THREE.Vector3(0, f, 0).applyMatrix4(M);
  pb.add('iron', paint(rod(lo.toArray(), foc.toArray(), 0.4, 5), [0.7, 0.7, 0.7]));
  const lnb = cbox([-1.2, -1.2, -2.5], [1.2, 1.2, 2.5], 0.4);
  lnb.applyMatrix4(new THREE.Matrix4().makeTranslation(foc.x, foc.y, foc.z).multiply(mat(0, 0, 0, -58 * DEG + Math.PI / 2, 0, 0)));
  pb.add(P, boxUV(lnb, 1 / 32), null, [0.85, 0.85, 0.85]);
  // mount: back plate on the dish + mast
  const back = new THREE.Vector3(0, -2, 0).applyMatrix4(M);
  if (opts.roof) {
    pb.add('iron', paint(rod([back.x, back.y, back.z], [0, 0, 6], 0.9, 6), IRON));
    for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2; pb.add('iron', paint(rod([0, 18, 6], [Math.cos(a) * 14, 0, 6 + Math.sin(a) * 14], 0.5, 5), IRON)); }
  } else {
    pb.add('iron', paint(rod([back.x, back.y, back.z], [0, back.y - 1, 0.5], 0.9, 6), IRON));
    pb.add('iron', paint(cbox([-3, back.y - 6, 0], [3, back.y + 4, 0.6], 0.15), IRON));
    pb.add('iron', paint(rod([0, back.y - 5, 0.5], [back.x, back.y - 0.5, back.z * 0.7], 0.4, 5), IRON));
    for (const [x, y] of [[-2, back.y - 5], [2, back.y - 5], [-2, back.y + 3], [2, back.y + 3]]) { const b = dome(0.5, 0.4, 5); b.translate(x, y, 0.6); pb.add('iron', paint(b, IRON)); }
  }
  pb.weather((x, y, z, nx, ny) => (ny > 0.6 ? 0.9 : 1));
  return pb.finish();
}

/** lamp(): wall lantern on a scrolled wrought-iron bracket. Wall at z = 0; lantern centre ~20u out. userData.lightPos. */
export function lamp() {
  const pb = new PropBuilder('lamp', 'lamp');
  const K = [0.2, 0.2, 0.2], zL = 20, yArm = 0;
  // wall plate
  pb.add('iron', paint(cbox([-1.4, -12, 0], [1.4, 4, 0.6], 0.2), K));
  for (const y of [-10, 2]) { const b = dome(0.5, 0.4, 5); b.translate(0, y, 0.6); pb.add('iron', paint(b, K)); }
  // arm + lower stay
  pb.add('iron', paint(cbox([-0.5, yArm - 0.5, 0.5], [0.5, yArm + 0.5, zL + 2], 0.15), K));
  const st = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -11, 0.5), new THREE.Vector3(0, -7, 6), new THREE.Vector3(0, -2.5, 13), new THREE.Vector3(0, -0.4, zL - 3)]);
  pb.add('iron', U(paint(sweep(st, 14, 5, 0.32), K), 1 / 32));
  // scrolls: two spirals filling the triangle
  const spiral = (cx, cy, r0, turns, dir) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40, a = dir * t * turns * Math.PI * 2, r = r0 * (1 - t * 0.8); pts.push(new THREE.Vector3(0, cy + Math.sin(a) * r, cx + Math.cos(a) * r)); }
    return new THREE.CatmullRomCurve3(pts);
  };
  pb.add('iron', paint(sweep(spiral(5.2, -4.6, 3.8, 1.3, 1), 40, 4, 0.22), K));
  pb.add('iron', paint(sweep(spiral(12, -2.4, 2.1, 1.2, -1), 30, 4, 0.2), K));
  // lantern: base, tapered glazed body, pyramid roof, finial
  const yb = yArm + 0.5;
  pb.add('iron', paint(cbox([-3, yb, zL - 3], [3, yb + 1, zL + 3], 0.2), K));
  const bot = 3.2, top = 5, hL = 10, y0 = yb + 1;
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    const post = rod([bot, y0, bot], [top, y0 + hL, top], 0.28, 4); post.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, zL).multiply(new THREE.Matrix4().makeRotationY(ry)));
    pb.add('iron', paint(post, K));
    // glass pane (trapezoid)
    const pane = new THREE.BufferGeometry();
    const v = [-bot, y0, bot, bot, y0, bot, top, y0 + hL, top, -bot, y0, bot, top, y0 + hL, top, -top, y0 + hL, top];
    pane.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    pane.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    pane.computeVertexNormals();
    pane.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, zL).multiply(new THREE.Matrix4().makeRotationY(ry)));
    pb.add('plain:0.25', pane, null, [0.86, 0.84, 0.74]); // frosted panes
  }
  const ring = (y, r) => { const g = cbox([-r, y - 0.35, -r], [r, y + 0.35, r], 0.15); g.translate(0, 0, zL); pb.add('iron', paint(g, K)); };
  ring(y0 + 0.2, bot + 0.3); ring(y0 + hL, top + 0.4);
  const roof = new THREE.ConeGeometry((top + 1.4) * Math.SQRT2, 6, 4, 1); roof.rotateY(Math.PI / 4); roof.translate(0, y0 + hL + 3.3, zL); pb.add('iron', paint(roof, K));
  const fin = new THREE.SphereGeometry(0.9, 8, 6); fin.translate(0, y0 + hL + 7, zL); pb.add('iron', paint(fin, K));
  const bulb = new THREE.SphereGeometry(1.6, 10, 8); bulb.scale(1, 1.3, 1); bulb.translate(0, y0 + 4.5, zL); pb.add('bulb', bulb);
  pb.userData.lightPos = [0, y0 + 4.5, zL];
  return pb.finish();
}

/** pipe(a, b, r): straight pipe between two PARENT-space points with end flanges and couplings. */
export function pipe(a, b, r = 2) {
  const A = a.isVector3 ? a : new THREE.Vector3(...a), B = b.isVector3 ? b : new THREE.Vector3(...b);
  const pb = new PropBuilder('pipe', `${A.toArray()}${B.toArray()}${r}`);
  const L = A.distanceTo(B), dir = B.clone().sub(A).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const M = new THREE.Matrix4().compose(A, q, new THREE.Vector3(1, 1, 1));
  const body = lathe([[r, 0], [r, L]], 12); U(body, 1 / 64); pb.add('galv', body, M, [0.8, 0.78, 0.75]);
  const collar = (y, rr, h) => { const g = lathe([[r, y - h / 2, true], [rr, y - h / 2, true], [rr, y + h / 2, true], [r, y + h / 2]], 12); U(g, 1 / 64); pb.add('galv', g, M, [0.7, 0.68, 0.65]); };
  collar(0.6, r * 1.6, 1.2); collar(L - 0.6, r * 1.6, 1.2);
  for (let y = 96; y < L - 24; y += 96) collar(y, r * 1.25, 2.2);
  pb.weather((x, y) => lerp(0.75, 1, smooth(0, 10, y)));
  return pb.finish();
}
