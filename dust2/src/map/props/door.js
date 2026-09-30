// Doors, gates, shutters and grates. All openings use the same local layout:
//   opening x ∈ [-w/2, w/2], y ∈ [0, h]; wall centre plane z = 0 (doors) or wall face z = 0
//   (surface-mounted shutters/grates, prop extends to +z).
import * as THREE from 'three';
import { PropBuilder, rect, bandPoly, slab, cbox, dome, rod, paint, mat, lerp, smooth, clamp, transformColliders, lathe } from './core.js';
import { board, beamBox } from './woodkit.js';

const IRON_DARK = [0.46, 0.44, 0.42];

function ironSlab(pb, pts, z0, t, M, tint = IRON_DARK, c = 0.08) {
  const g = slab(pts, t, c, false); g.translate(0, 0, z0); paint(g, tint); pb.add('iron', g, M); return g;
}
function bolt(pb, x, y, z, M, r = 0.5, tint = IRON_DARK) {
  const d = dome(r, r * 0.7, 6); d.translate(x, y, z); paint(d, tint); pb.add('iron', d, M);
}
const leafMatrix = (hx, hz, ang) => new THREE.Matrix4().makeTranslation(hx, 0, hz).multiply(new THREE.Matrix4().makeRotationY(ang));

/**
 * One ledged-and-braced plank leaf. s = +1: hinge at local x=0, leaf extends to +x; s = -1 mirrored.
 * Local z: knuckle axis at 0, plank front at -0.9, planks to -2.9, ledges to -4.5.
 */
function plankLeaf(pb, M, lw, lh, s, o) {
  const r = pb.rand, W = o.woodMat;
  const X = (u) => s * u;
  const R = (u0, y0, u1, y1) => rect(Math.min(X(u0), X(u1)), y0, Math.max(X(u0), X(u1)), y1);
  const zf = -0.9, pt = 2.0;
  const n = Math.max(3, Math.round(lw / 8.5));
  const ws = []; let tot = 0;
  for (let i = 0; i < n; i++) { const k = r.f(0.85, 1.15); ws.push(k); tot += k; }
  let u = 0;
  for (let i = 0; i < n; i++) {
    const w = (ws[i] / tot) * lw;
    const rot = r.chance(0.5) ? r.f(0.2, 1.4) : 0;
    board(pb, W, R(u, rot, u + w, lh), zf - pt, pt, M, { angle: Math.PI / 2, tint: o.tint, chamfer: 0.5, vary: 0.1 });
    u += w;
  }
  // back: ledges + braces
  const ledgeH = clamp(lh * 0.07, 5, 8), lz = zf - pt - 1.6;
  const ys = [lh * 0.1, lh * 0.52, lh * 0.9];
  for (const y of ys) board(pb, W, R(1.2, y - ledgeH / 2, lw - 1.2, y + ledgeH / 2), lz, 1.6, M, { tint: o.tint, chamfer: 0.4 });
  for (let k = 0; k < 2; k++) {
    const yA = ys[k] + ledgeH / 2, yB = ys[k + 1] - ledgeH / 2;
    const clip = R(1.8, yA, lw - 1.8, yB);
    const p0 = [X(2.5), yA + 0.5], p1 = [X(lw - 2.5), yB - 0.5];
    const band = bandPoly(p0, p1, ledgeH * 0.85, clip);
    if (band.length >= 3) board(pb, W, band, lz, 1.6, M, { angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), tint: o.tint, chamfer: 0.4 });
  }
  // front: strap hinges with spear ends, bolted through the ledges
  const L = lw * 0.74, sh = clamp(lh * 0.022, 2, 3);
  for (const y of ys) {
    const pts = [[-1.3, y - sh / 2], [L - 3.5, y - sh / 2], [L - 2.2, y - sh * 0.9], [L, y], [L - 2.2, y + sh * 0.9], [L - 3.5, y + sh / 2], [-1.3, y + sh / 2]]
      .map(([uu, yy]) => [X(uu), yy]);
    ironSlab(pb, pts.slice(0, 2).concat(pts.slice(5)), zf, 0.35, M);
    ironSlab(pb, pts.slice(1, 6), zf, 0.35, M);
    for (let b = 3.5; b < L - 3; b += 6.5) bolt(pb, X(b), y, zf + 0.35, M, 0.55);
    // knuckle around the pin
    const k = rod([0, y - sh * 1.4, 0], [0, y + sh * 1.4, 0], 1.05, 8);
    paint(k, IRON_DARK); pb.add('iron', k, M);
    // clench nails where the ledge crosses the remaining planks
    for (let b = L + 2; b < lw - 1.5; b += 4.5) { bolt(pb, X(b), y - ledgeH * 0.25, zf, M, 0.4); bolt(pb, X(b), y + ledgeH * 0.25, zf, M, 0.4); }
  }
  // ring pull on a rosette
  const ry = lh * 0.46, ru = lw - 7;
  const ros = lathe([[1.8, 0, true], [1.6, 0.3], [0.5, 0.5]], 10); ros.rotateX(Math.PI / 2); ros.translate(X(ru), ry, zf);
  paint(ros, IRON_DARK); pb.add('iron', ros, M);
  const ring = new THREE.TorusGeometry(2.4, 0.33, 6, 14); ring.translate(X(ru), ry - 2.1, zf + 0.6);
  paint(ring, IRON_DARK); pb.add('iron', ring, M);
  return ys;
}

/**
 * doubleDoor(width, height, openAmount, opts): weathered planked double doors with iron strap
 * hinges in a timber frame (jambs, proud lintel, stone sill). The wall hole is width × height.
 * openAmount: 0..1 (or [left, right]) swings the leaves out toward +z up to ~100°.
 * opts: { depth = 16 (wall thickness), gap = 1.4 (crack between the leaves), paint: null|'teal'|'blue'|'green'|'red' }
 */
export function doubleDoor(width = 112, height = 108, openAmount = 0, opts = {}) {
  const pb = new PropBuilder('doubleDoor', `${width}:${height}:${opts.seed ?? 0}`);
  const D = opts.depth ?? 16, gap = opts.gap ?? 1.4;
  const jw = clamp(width * 0.06, 5, 9), lhd = clamp(height * 0.085, 7, 12);
  const cw = width - 2 * jw, ch = height - lhd;
  const woodMat = opts.paint ? `woodpaint:${opts.paint}` : 'wood:door';
  const frameTint = [0.78, 0.72, 0.66];
  // frame
  beamBox(pb, 'wood:door', [-width / 2, 0, -D / 2 - 1], [-width / 2 + jw, ch, D / 2 + 1], { tint: frameTint, thickAxis: 0, chamfer: 0.6 });
  beamBox(pb, 'wood:door', [width / 2 - jw, 0, -D / 2 - 1], [width / 2, ch, D / 2 + 1], { tint: frameTint, thickAxis: 0, chamfer: 0.6 });
  beamBox(pb, 'wood:door', [-width / 2 - 12, ch, -D / 2 - 1.8], [width / 2 + 12, height, D / 2 + 1.8], { tint: [0.7, 0.64, 0.58], thickAxis: 1, chamfer: 0.9, angle: 0 });
  const sill = cbox([-width / 2 - 2, -D / 2 - 2, 0], [width / 2 + 2, D / 2 + 2, 1.4], 0.5); sill.rotateX(-Math.PI / 2);
  pb.add('stone:white', sill, null, [0.9, 0.87, 0.82]);
  // leaves
  const [oL, oR] = Array.isArray(openAmount) ? openAmount : [openAmount, openAmount];
  const lw = (cw - gap) / 2 - 0.5, lh = ch - 2.2, y0 = 1.8;
  const hz = D / 2 - 5.5; // hinge axis a little behind the outer face
  // door stops behind the leaves (no light leaking round the frame)
  beamBox(pb, 'wood:door', [-cw / 2, ch - 2.2, hz - 7.5], [cw / 2, ch, hz - 5], { tint: frameTint, thickAxis: 1, chamfer: 0.3, angle: 0 });
  for (const sx of [-1, 1]) beamBox(pb, 'wood:door', [sx > 0 ? cw / 2 - 1.6 : -cw / 2, 0, hz - 7.5], [sx > 0 ? cw / 2 : -cw / 2 + 1.6, ch, hz - 5], { tint: frameTint, thickAxis: 0, chamfer: 0.3 });
  const tint = opts.paint ? [1, 1, 1] : [0.95, 0.93, 0.9];
  for (const side of [-1, 1]) {
    const s = -side; // left leaf (side -1) extends +x from its hinge
    const hx = side * (cw / 2 - 0.4);
    const ang = side < 0 ? -oL * 1.75 : oR * 1.75;
    const M = leafMatrix(hx, hz, ang).multiply(new THREE.Matrix4().makeTranslation(0, y0, 0));
    const ys = plankLeaf(pb, M, lw, lh, s, { woodMat, tint });
    // pintle plates on the jamb (static)
    for (const y of ys) {
      const g = cbox([hx + side * 0.8 - (side > 0 ? 0 : 2.6), y0 + y - 1.6, hz - 0.8], [hx + side * 0.8 + (side > 0 ? 2.6 : 0), y0 + y + 1.6, hz + 0.8], 0.2);
      paint(g, IRON_DARK); pb.add('iron', g);
    }
    // leaf collider (footprint box in leaf space → prism when swung)
    const u0 = Math.min(0, s * lw), u1 = Math.max(0, s * lw);
    pb.colliders.push(...transformColliders([{ min: [u0, 0, -4.5], max: [u1, lh, 1.1], surface: 'wood' }], M));
  }
  // hasp + padlock across the crack when both leaves are shut
  if (!oL && !oR) {
    const y = y0 + lh * 0.56;
    const M = new THREE.Matrix4().makeTranslation(0, 0, hz);
    ironSlab(pb, rect(-9, y - 0.9, 3.5, y + 0.9), -0.9, 0.3, M);
    bolt(pb, -7.5, y, -0.6, M, 0.45); bolt(pb, -4, y, -0.6, M, 0.45);
    const st = new THREE.TorusGeometry(0.9, 0.22, 5, 10, Math.PI); st.rotateY(Math.PI / 2); st.translate(2.4, y, -0.4);
    paint(st, IRON_DARK); pb.add('iron', st, M);
    const lock = cbox([1.3, y - 4.2, -0.2], [3.5, y - 1.4, 0.9], 0.3); paint(lock, [0.62, 0.55, 0.4]); pb.add('iron', lock, M);
    const sh = new THREE.TorusGeometry(0.75, 0.2, 5, 10, Math.PI); sh.translate(2.4, y - 1.4, 0.35); paint(sh, [0.7, 0.7, 0.7]); pb.add('iron', sh, M);
  }
  pb.weather((x, y, z, nx, ny) => lerp(0.66, 1, smooth(0, 16, y)) * (ny < -0.9 ? 0.7 : 1));
  pb.box([-width / 2, 0, -D / 2 - 1], [-width / 2 + jw, ch, D / 2 + 1], 'wood');
  pb.box([width / 2 - jw, 0, -D / 2 - 1], [width / 2, ch, D / 2 + 1], 'wood');
  pb.box([-width / 2, ch, -D / 2 - 1.8], [width / 2, height, D / 2 + 1.8], 'wood');
  pb.userData.opening = { clearWidth: cw, clearHeight: ch, jamb: jw, lintel: lhd };
  return pb.finish();
}

/**
 * bigDoorMetal(w, h, openAmount, opts): steel-framed double gate (Dust II B doors): painted steel
 * frame/braces with weathered grey planks, barrel hinges, drop rod, optional fanlight arch.
 * opts: { depth = 24, paint = 'teal', sheet = false (ribbed steel sheet instead of planks), arch = false }
 */
export function bigDoorMetal(w = 128, h = 128, openAmount = 0, opts = {}) {
  const pb = new PropBuilder('bigDoorMetal', `${w}:${h}:${opts.seed ?? 0}`);
  const D = opts.depth ?? 24, P = `paint:${opts.paint || 'teal'}`, tube = 3.2;
  const archH = opts.arch ? w * 0.28 : 0;
  const ch = h - archH;
  // outer steel frame (channel) lining the opening
  const fz0 = D / 2 - 7, fz1 = D / 2 - 1;
  const add = (min, max, c = 0.4) => { const g = cbox(min, max, c); pb.add(P, g); };
  add([-w / 2, 0, fz0], [-w / 2 + 3, ch, fz1]);
  add([w / 2 - 3, 0, fz0], [w / 2, ch, fz1]);
  add([-w / 2, ch - 3, fz0], [w / 2, ch, fz1]);
  if (opts.arch) {
    // semicircular fanlight: bent rim + radial bars + planks behind
    const R = w / 2 - 1.5, cy = ch;
    const rim = new THREE.TorusGeometry(R, 1.4, 5, 24, Math.PI); rim.scale(1, archH / R, 1); rim.translate(0, cy, (fz0 + fz1) / 2);
    pb.add(P, rim);
    for (let k = 1; k < 6; k++) {
      const a = (k / 6) * Math.PI;
      pb.add(P, rod([0, cy, (fz0 + fz1) / 2], [Math.cos(a) * R, cy + Math.sin(a) * archH, (fz0 + fz1) / 2], 0.7, 5));
    }
    // vertical boards filling the arch, each clipped to the curve (convex: arch is concave-down)
    const top = (x) => cy + archH * Math.sqrt(Math.max(0, 1 - (x / R) ** 2));
    const n = Math.max(6, Math.round((2 * R) / 7));
    for (let i = 0; i < n; i++) {
      const x0 = -R + (2 * R * i) / n, x1 = x0 + (2 * R) / n, xm = (x0 + x1) / 2;
      const pts = [[x0, cy - 1], [x1, cy - 1], [x1, top(x1) - 0.2], [xm, top(xm) - 0.2], [x0, top(x0) - 0.2]];
      board(pb, 'wood:door', pts, fz0 + 0.4, 1.6, null, { angle: Math.PI / 2, tint: [0.86, 0.86, 0.85], chamfer: 0.4, vary: 0.12 });
    }
  }
  const [oL, oR] = Array.isArray(openAmount) ? openAmount : [openAmount, openAmount];
  const cw = w - 6, lw = cw / 2 - 0.6, lh = ch - 4.5, y0 = 1.2;
  const hz = (fz0 + fz1) / 2;
  for (const side of [-1, 1]) {
    const s = -side, hx = side * (cw / 2 - 0.3);
    const ang = side < 0 ? -oL * 1.7 : oR * 1.7;
    const M = leafMatrix(hx, hz, ang).multiply(new THREE.Matrix4().makeTranslation(0, y0, 0));
    const X = (u) => s * u;
    const B = (u0, yA, u1, yB, z0, z1, c = 0.35) => cbox([Math.min(X(u0), X(u1)), yA, z0], [Math.max(X(u0), X(u1)), yB, z1], c);
    // steel leaf frame
    for (const g of [B(0, 0, tube, lh, -tube / 2, tube / 2), B(lw - tube, 0, lw, lh, -tube / 2, tube / 2), B(tube, 0, lw - tube, tube, -tube / 2, tube / 2),
      B(tube, lh - tube, lw - tube, lh, -tube / 2, tube / 2), B(tube, lh * 0.5 - tube / 2, lw - tube, lh * 0.5 + tube / 2, -tube / 2, tube / 2)]) pb.add(P, g, M);
    // diagonal brace in the lower panel
    const clip = rect(Math.min(X(tube), X(lw - tube)), tube, Math.max(X(tube), X(lw - tube)), lh * 0.5 - tube / 2);
    const p0 = [X(tube), tube], p1 = [X(lw - tube), lh * 0.5 - tube / 2];
    const bd = slab(bandPoly(p0, p1, tube * 0.9, clip), tube * 0.8, 0.3, true); bd.translate(0, 0, -tube * 0.4); pb.add(P, bd, M);
    // infill
    if (opts.sheet) {
      const sheet = cbox([Math.min(X(tube), X(lw - tube)), tube, -0.4], [Math.max(X(tube), X(lw - tube)), lh - tube, 0.2], 0.05);
      pb.add(P, sheet, M);
      for (let y = tube + 6; y < lh - tube - 2; y += 8) pb.add(P, B(tube + 1, y - 0.8, lw - tube - 1, y + 0.8, 0.2, 0.9, 0.3), M);
    } else {
      const n = Math.max(4, Math.round((lw - 2 * tube) / 7));
      const pw = (lw - 2 * tube) / n;
      for (let i = 0; i < n; i++) {
        const u0 = tube + i * pw, u1 = u0 + pw;
        board(pb, 'wood:door', rect(Math.min(X(u0), X(u1)), tube - 0.5, Math.max(X(u0), X(u1)), lh - tube + 0.5), -1.2, 1.8, M, { angle: Math.PI / 2, tint: [0.88, 0.88, 0.87], chamfer: 0.45, vary: 0.12 });
      }
    }
    // barrel hinges
    for (const y of [lh * 0.12, lh * 0.5, lh * 0.88]) {
      const k = rod([0, y - 3, 0], [0, y + 3, 0], 1.5, 8); paint(k, [0.8, 0.8, 0.8]); pb.add(P, k, M);
      const c = rod([0, y + 3, 0], [0, y + 3.8, 0], 0.9, 6); paint(c, [0.8, 0.8, 0.8]); pb.add(P, c, M);
    }
    // drop rod on the left leaf, D-handle on both
    if (side < 0) {
      const rx = X(lw - 6);
      pb.add('iron', paint(rod([rx, -1.5, tube / 2 + 1], [rx, lh * 0.45, tube / 2 + 1], 0.6, 6), IRON_DARK), M);
      for (const y of [4, lh * 0.3]) pb.add('iron', paint(cbox([rx - 1.3, y - 0.8, tube / 2 - 0.2], [rx + 1.3, y + 0.8, tube / 2 + 1.8], 0.2), IRON_DARK), M);
    }
    const hy = lh * 0.55, hxu = X(lw - 3.5);
    const handle = new THREE.TorusGeometry(2.8, 0.45, 5, 10, Math.PI); handle.rotateZ(-Math.PI / 2); handle.rotateY(Math.PI / 2 * 0); handle.translate(hxu, hy, tube / 2 + 0.3);
    paint(handle, IRON_DARK); pb.add('iron', handle, M);
    const u0 = Math.min(0, s * lw), u1 = Math.max(0, s * lw);
    pb.colliders.push(...transformColliders([{ min: [u0, 0, -tube / 2], max: [u1, lh, tube / 2], surface: 'metaldoor' }], M));
  }
  pb.weather((x, y) => lerp(0.7, 1, smooth(0, 14, y)));
  pb.box([-w / 2, 0, fz0], [-w / 2 + 3, ch, fz1], 'metal');
  pb.box([w / 2 - 3, 0, fz0], [w / 2, ch, fz1], 'metal');
  return pb.finish();
}

/**
 * windowShutters(w, h, open, color): pair of louvred wooden shutters for a w × h window whose
 * bottom-centre is the origin; wall face at z = 0. open: 0 closed .. 1 folded flat against the wall.
 */
export function windowShutters(w = 40, h = 60, open = 1, color = 'green') {
  const pb = new PropBuilder('windowShutters', `${w}:${h}:${color}`);
  const W = `woodpaint:${color}:0.85`, T = 1.3, sw = w / 2 - 0.3;
  for (const side of [-1, 1]) {
    const s = -side, hx = side * w / 2;
    const ang = (side < 0 ? 1 : -1) * open * Math.PI * 0.97;
    const M = new THREE.Matrix4().makeTranslation(hx, 0, T).multiply(new THREE.Matrix4().makeRotationY(ang)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -T));
    const R = (u0, y0, u1, y1) => rect(Math.min(s * u0, s * u1), y0, Math.max(s * u0, s * u1), y1);
    const st = 2.4, rl = 3;
    board(pb, W, R(0, 0, st, h), 0, T, M, { angle: Math.PI / 2, chamfer: 0.3 });
    board(pb, W, R(sw - st, 0, sw, h), 0, T, M, { angle: Math.PI / 2, chamfer: 0.3 });
    for (const [a, b] of [[0, rl], [h * 0.5 - rl / 2, h * 0.5 + rl / 2], [h - rl, h]]) board(pb, W, R(st, a, sw - st, b), 0, T, M, { chamfer: 0.3 });
    // louvres: thin slats tilted 45° between the rails
    for (const [a, b] of [[rl, h * 0.5 - rl / 2], [h * 0.5 + rl / 2, h - rl]]) {
      const n = Math.floor((b - a) / 1.7);
      for (let i = 0; i < n; i++) {
        const y = a + (i + 0.5) * ((b - a) / n);
        const Ms = M.clone().multiply(mat(0, y, T / 2, -0.75, 0, 0));
        board(pb, W, R(st - 0.2, -1.2, sw - st + 0.2, 1.2), -0.15, 0.3, Ms, { chamfer: 0.08, vary: 0.04 });
      }
    }
    // pintle hinges
    for (const y of [h * 0.15, h * 0.85]) pb.add('iron', paint(rod([hx, y - 1.5, T], [hx, y + 1.5, T], 0.45, 6), IRON_DARK));
  }
  pb.weather((x, y) => lerp(0.85, 1, smooth(0, 10, y)));
  return pb.finish();
}

/**
 * shopShutter(w, h, openAmount, paint): roller shutter for a shop front; opening w × h,
 * wall face z = 0, curtain in front of the wall, roll box above the opening.
 */
export function shopShutter(w = 96, h = 100, openAmount = 0, color = 'grey') {
  const pb = new PropBuilder('shopShutter', `${w}:${h}:${color}`);
  const P = color === 'galv' ? 'galv' : `paint:${color}:0.3`;
  const bottom = lerp(0, h - 6, clamp(openAmount, 0, 1));
  // corrugated curtain: repeating rounded slat profile in (y, z), swept across x
  const pitch = 2.6, prof = [];
  for (let y = h; y > bottom + 1; y -= pitch) {
    for (let k = 0; k < 6; k++) {
      const t = k / 6, yy = y - t * pitch;
      prof.push([yy, 1.2 + Math.sin(t * Math.PI) * 0.7 - (k === 0 ? 0.25 : 0)]);
    }
  }
  prof.push([bottom + 1, 1.2]);
  const pos = [], uv = [], idx = [];
  let L = 0;
  for (let i = 0; i < prof.length; i++) {
    if (i) L += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]);
    for (const x of [-w / 2 + 1, w / 2 - 1]) { pos.push(x, prof[i][0], prof[i][1]); uv.push(x / 64, L / 64); }
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g = g.toNonIndexed(); g.computeVertexNormals();
  pb.add(P, g, null, [0.95, 0.95, 0.95]);
  // bottom bar, guides, roll box, lock
  pb.add(P, cbox([-w / 2 + 1, bottom, 0.4], [w / 2 - 1, bottom + 2.2, 2.6], 0.4), null, [0.8, 0.8, 0.8]);
  for (const sx of [-1, 1]) pb.add(P, cbox([sx * w / 2 - 2.2, 0, 0], [sx * w / 2 + 2.2, h, 3.2], 0.3), null, [0.85, 0.85, 0.85]);
  pb.add(P, cbox([-w / 2 - 3, h, 0], [w / 2 + 3, h + 11, 10], 1.2), null, [0.9, 0.9, 0.9]);
  for (const sx of [-0.3, 0.3]) {
    pb.add('iron', paint(cbox([sx * w - 2, bottom + 0.5, 2.6], [sx * w + 2, bottom + 1.8, 3.6], 0.2), IRON_DARK));
    pb.add('iron', paint(cbox([sx * w - 1.2, bottom - 2.2, 2.9], [sx * w + 1.2, bottom + 0.4, 4.1], 0.25), [0.6, 0.52, 0.36]));
  }
  pb.weather((x, y) => lerp(0.72, 1, smooth(0, 18, y)));
  pb.box([-w / 2, bottom, 0], [w / 2, h, 3], 'metal');
  return pb.finish();
}

/** windowGrate(w, h): wrought-iron window bars; origin bottom-centre, plane z = 0..1.5. */
export function windowGrate(w = 40, h = 56) {
  const pb = new PropBuilder('windowGrate', `${w}:${h}`);
  const t = IRON_DARK, fb = 1.4;
  const flat = (x0, y0, x1, y1, z0 = 0.8, z1 = 1.3) => pb.add('iron', paint(cbox([x0, y0, z0], [x1, y1, z1], 0.12), t));
  flat(-w / 2, 0, -w / 2 + fb, h); flat(w / 2 - fb, 0, w / 2, h); flat(-w / 2, 0, w / 2, fb); flat(-w / 2, h - fb, w / 2, h);
  const nb = Math.max(3, Math.round(w / 5));
  const rails = [h * 0.33, h * 0.66];
  for (const y of rails) flat(-w / 2, y - fb / 2, w / 2, y + fb / 2, 1.3, 1.8);
  for (let i = 1; i < nb; i++) {
    const x = -w / 2 + (i * w) / nb;
    pb.add('iron', paint(rod([x, fb, 1.05], [x, h - fb, 1.05], 0.45, 6), t));
    for (const y of rails) bolt(pb, x, y, 1.8, null, 0.4, t);
    // little finials on top: spear tips through the top bar
    const tip = new THREE.ConeGeometry(0.7, 2.2, 5); tip.translate(x, h + 1.1, 1.05); paint(tip, t); pb.add('iron', tip);
  }
  // wall anchors
  for (const [x, y] of [[-w / 2 - 1.5, h * 0.25], [w / 2 + 1.5, h * 0.25], [-w / 2 - 1.5, h * 0.75], [w / 2 + 1.5, h * 0.75]]) flat(x - 1.5, y - 0.6, x + 1.5, y + 0.6, 0, 1.3);
  pb.box([-w / 2, 0, 0], [w / 2, h, 1.8], 'metalgrate');
  pb.colliders[0].grate = true;
  return pb.finish();
}
