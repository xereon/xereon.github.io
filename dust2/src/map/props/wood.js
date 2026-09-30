// Timber props: pallets, benches, ladders, beams, slatted crates, plank fences, utility poles.
import * as THREE from 'three';
import { PropBuilder, rect, slab, cbox, rod, lathe, dome, paint, mat, lerp, smooth, clamp, DEG, boxUV, uvXform } from './core.js';
import { board, beamBox } from './woodkit.js';
import { buildCrate } from './crate.js';
import { WOOD } from './tex.js';

const TAN = 'wood:tan', GREY = 'wood:door';

/** Pallet boards into pb, occupying x ∈ [-w/2, w/2], z ∈ [-d/2, d/2], y ∈ [0, 5.5]. */
export function buildPallet(pb, w = 48, d = 40, mk = TAN) {
  const r = pb.rand, t = [1, 0.96, 0.92];
  for (const z of [-d / 2 + 2.2, 0, d / 2 - 2.2]) beamBox(pb, mk, [-w / 2, 0, z - 2.2], [w / 2, 0.8, z + 2.2], { tint: t, chamfer: 0.25, thickAxis: 1, angle: 0 });
  for (const x of [-w / 2 + 2.2, 0, w / 2 - 2.2]) for (const z of [-d / 2 + 2.2, 0, d / 2 - 2.2]) {
    beamBox(pb, mk, [x - 2.2, 0.8, z - 2.2], [x + 2.2, 3.9, z + 2.2], { tint: [0.85, 0.8, 0.74], chamfer: 0.3, thickAxis: 0 });
  }
  for (const x of [-w / 2 + 2.2, 0, w / 2 - 2.2]) beamBox(pb, mk, [x - 2.2, 3.9, -d / 2], [x + 2.2, 4.7, d / 2], { tint: t, chamfer: 0.25, thickAxis: 1, angle: Math.PI / 2 });
  const n = 7, bw = 4.6, gap = (d - n * bw) / (n - 1);
  for (let i = 0; i < n; i++) {
    const z = -d / 2 + i * (bw + gap);
    beamBox(pb, mk, [-w / 2, 4.7, z], [w / 2, 5.5, z + bw], { tint: t, chamfer: 0.25, thickAxis: 1, angle: 0, vary: 0.12 });
    // nail heads
    for (const x of [-w / 2 + 2.2, 0, w / 2 - 2.2]) { const dm = dome(0.3, 0.12, 4); dm.rotateX(-Math.PI / 2); dm.translate(x + r.f(-0.5, 0.5), 5.5, z + bw / 2); pb.add('iron', paint(dm, [0.35, 0.33, 0.3])); }
  }
}

/** pallet(w = 48, d = 40): wooden shipping pallet. */
export function pallet(w = 48, d = 40) {
  const pb = new PropBuilder('pallet', `${w}:${d}`);
  buildPallet(pb, w, d);
  pb.weather((x, y) => lerp(0.75, 1, smooth(0, 4, y)));
  pb.box([-w / 2, 0, -d / 2], [w / 2, 5.5, d / 2], 'wood');
  return pb.finish();
}

/** bench(len = 56): weathered plank bench on trestle legs, seat at 17u. */
export function bench(len = 56) {
  const pb = new PropBuilder('bench', String(len));
  const sy = 16.5, st = 1.6;
  for (const z of [-5.6, -0.8, 4]) beamBox(pb, GREY, [-len / 2, sy, z], [len / 2, sy + st, z + 4.4], { tint: [0.95, 0.92, 0.88], thickAxis: 1, angle: 0, chamfer: 0.45 });
  for (const x of [-len / 2 + 7, len / 2 - 7]) {
    beamBox(pb, GREY, [x - 1.2, sy - 3, -6.5], [x + 1.2, sy, 6.5], { thickAxis: 0, chamfer: 0.35, tint: [0.8, 0.76, 0.7] });
    for (const z of [-5, 5]) {
      board(pb, GREY, rect(-1.2, 0, 1.2, sy - 2.6), -1.2, 2.4, mat(x, 0, z, Math.sign(z) * 7 * DEG, 0, 0), { angle: Math.PI / 2, tint: [0.82, 0.78, 0.72] });
    }
  }
  beamBox(pb, GREY, [-len / 2 + 7, 5, -0.9], [len / 2 - 7, 7.4, 0.9], { thickAxis: 2, chamfer: 0.35, tint: [0.82, 0.78, 0.72] });
  pb.weather((x, y) => lerp(0.72, 1, smooth(0, 6, y)));
  pb.box([-len / 2, 0, -6.5], [len / 2, sy + st, 6.5], 'wood');
  return pb.finish();
}

/** ladder(h = 120): wooden ladder standing against a wall at z = 0 (occupies z ∈ [0.5, 4]). Collider flagged ladder. */
export function ladder(h = 120) {
  const pb = new PropBuilder('ladder', String(h));
  const hw = 8.5;
  for (const x of [-hw, hw]) beamBox(pb, TAN, [x - 0.9, 0, 0.6], [x + 0.9, h, 4], { thickAxis: 0, chamfer: 0.3, angle: Math.PI / 2 });
  for (let y = 10; y < h - 4; y += 12) {
    const g = rod([-hw - 1.1, y, 2.3], [hw + 1.1, y, 2.3], 0.75, 7);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) * WOOD.PX_PER_UNIT + 300) / WOOD.W, (2 * 128 + 10 + uv.getX(i) * 12) / WOOD.H);
    pb.add(TAN, g, null, [0.85, 0.78, 0.68]);
    // rope lashing where each rung meets a rail
    for (const x of [-hw, hw]) { const t = new THREE.TorusGeometry(1.25, 0.28, 4, 8); t.rotateY(Math.PI / 2); t.translate(x + Math.sign(x) * -1.2, y, 2.3); uvXform(t, 1, 1); pb.add('rope', t); }
  }
  pb.weather((x, y) => lerp(0.7, 1, smooth(0, 8, y)));
  pb.box([-hw - 1, 0, 0.5], [hw + 1, h, 4], 'wood');
  pb.colliders[0].ladder = true;
  return pb.finish();
}

/** woodenBeam(len = 96, size = 8): rough-hewn timber along x (centred), bottom at y = 0; iron spikes. */
export function woodenBeam(len = 96, size = 8) {
  const pb = new PropBuilder('woodenBeam', `${len}:${size}`), r = pb.rand;
  const segs = Math.max(1, Math.round(len / 40));
  // split into segments with tiny offsets so the beam isn't CG-straight
  for (let i = 0; i < segs; i++) {
    const x0 = -len / 2 + (len * i) / segs, x1 = -len / 2 + (len * (i + 1)) / segs;
    const dy = r.f(-0.15, 0.15), dz = r.f(-0.15, 0.15);
    beamBox(pb, GREY, [x0, dy, -size / 2 + dz], [x1, size + dy, size / 2 + dz], { thickAxis: 2, chamfer: Math.min(1.2, size * 0.14), angle: 0, tint: [0.78, 0.72, 0.66], row: 3 + i });
  }
  for (let x = -len / 2 + 10; x < len / 2 - 6; x += r.f(18, 30)) {
    const s = dome(0.55, 0.3, 5); s.rotateX(-Math.PI / 2); s.translate(x, size + 0.1, r.f(-1.5, 1.5)); pb.add('iron', paint(s, [0.3, 0.28, 0.26]));
  }
  pb.box([-len / 2, 0, -size / 2], [len / 2, size, size / 2], 'wood');
  return pb.finish();
}

/** slatCrate(w = 56, h = 96, d = 56): tall slatted timber crate (B-site tower). */
export function slatCrate(w = 56, h = 96, d = 56) {
  const pb = new PropBuilder('slatCrate', `${w}:${h}:${d}`);
  buildCrate(pb, [w, h, d], 0, { panel: 'mid', planks: 'h', caps: false, bands: false, tint: [1.0, 0.86, 0.66], noLabels: true, gap: 2.2, plankW: 5.5, mat: TAN, innerInset: 6 });
  return pb.finish();
}

/** plankFence(len = 128, h = 40): posts every ~48u with horizontal weathered planks on the +z side. */
export function plankFence(len = 128, h = 40) {
  const pb = new PropBuilder('plankFence', `${len}:${h}`), r = pb.rand;
  const np = Math.max(2, Math.round(len / 48) + 1);
  for (let i = 0; i < np; i++) {
    const x = -len / 2 + 2 + ((len - 4) * i) / (np - 1);
    beamBox(pb, GREY, [x - 2, 0, -2], [x + 2, h + 3 + r.f(-1, 1), 2], { thickAxis: 0, chamfer: 0.5, tint: [0.72, 0.68, 0.62] });
  }
  const pw = 7.5, gap = 0.9, n = Math.floor(h / (pw + gap));
  for (let k = 0; k < n; k++) {
    const y = 2 + k * (pw + gap);
    let x = -len / 2;
    while (x < len / 2 - 1) {
      const L = Math.min(len / 2 - x, r.f(40, 90));
      if (!r.chance(0.06)) {
        const sag = r.f(-0.4, 0.4);
        board(pb, GREY, [[x, y + sag * 0.3], [x + L, y - sag * 0.3], [x + L, y + pw - sag * 0.3], [x, y + pw + sag * 0.3]], 2, 1.2, null, { tint: [0.9, 0.86, 0.8], vary: 0.14, chamfer: 0.35 });
        for (const xx of [x + 1.5, x + L - 1.5]) { const nd = dome(0.3, 0.15, 4); nd.translate(xx, y + pw / 2, 3.2); pb.add('iron', paint(nd, [0.3, 0.28, 0.26])); }
      }
      x += L;
    }
  }
  beamBox(pb, GREY, [-len / 2, h, 2], [len / 2, h + 3, 4.2], { thickAxis: 2, chamfer: 0.4, tint: [0.78, 0.74, 0.68] });
  pb.weather((x, y) => lerp(0.7, 1, smooth(0, 10, y)));
  pb.box([-len / 2, 0, -2], [len / 2, h + 3, 4.2], 'wood');
  return pb.finish();
}

/**
 * utilityPole(h = 300): tapered timber pole with a crossarm, insulators, pole steps and a
 * small transformer. userData.wireAttach = insulator tops (local) for wireSpan().
 */
export function utilityPole(h = 300) {
  const pb = new PropBuilder('utilityPole', String(h)), r = pb.rand;
  const prof = [[6.2, 0, true], [6.0, h * 0.3], [5.2, h * 0.7], [4.4, h - 1.2], [3.8, h, true], [0.01, h + 0.6]];
  const pole = lathe(prof, 12);
  // grain runs up the pole: remap lathe UVs (u around, v along) into one atlas strip
  const uv = pole.attributes.uv;
  for (let i = 0; i < uv.count; i++) { const around = uv.getX(i) / (Math.PI * 2 * 6.2); uv.setXY(i, (uv.getY(i) * WOOD.PX_PER_UNIT) / WOOD.W, (5 * 128 + 4 + around * 118) / WOOD.H); }
  pb.add(GREY, pole, null, [0.72, 0.64, 0.56]);
  // crossarm + braces
  const ya = h - 14;
  beamBox(pb, GREY, [-34, ya - 2.5, 5.2], [34, ya + 2.5, 9.6], { thickAxis: 2, chamfer: 0.5, angle: 0, tint: [0.75, 0.7, 0.64] });
  for (const s of [-1, 1]) pb.add('iron', paint(rod([0, ya - 22, 6], [s * 18, ya - 2.5, 7.4], 0.5, 5), [0.35, 0.33, 0.3]));
  const attach = [];
  for (const x of [-30, -12, 12, 30]) {
    const ins = lathe([[0.4, 0, true], [1.3, 0.4], [1.3, 1.2], [0.8, 1.6], [1.5, 2.1], [1.5, 2.8], [0.9, 3.2], [0.5, 3.9], [0.01, 4.1]], 8);
    ins.translate(x, ya + 2.5, 7.4); pb.add('plain:0.3', ins, null, [0.82, 0.86, 0.8]);
    attach.push([x, ya + 6.2, 7.4]);
  }
  // pole steps
  for (let y = 70; y < h - 30; y += 16) { const s = (y / 16) % 2 ? 1 : -1; pb.add('iron', paint(rod([s * 4, y, 0], [s * 11, y + 0.6, 0], 0.45, 4), [0.35, 0.33, 0.3])); }
  // pole-top transformer can
  const tr = lathe([[7, 0, true], [7, 20, true], [7.4, 20.5, true], [6.8, 22.5], [0.01, 23]], 14);
  tr.translate(0, h - 52, -12); uvXform(tr, 1 / 48, 1 / 48); pb.add('paint:grey', tr);
  pb.add('iron', paint(cbox([-2, h - 46, -6], [2, h - 34, 0], 0.3), [0.35, 0.33, 0.3]));
  pb.weather((x, y) => lerp(0.62, 1, smooth(0, 20, y)));
  pb.userData.wireAttach = attach;
  const pts = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push([Math.cos(a) * 6.6, Math.sin(a) * 6.6]); }
  pb.prism(pts, 0, h, 'wood');
  return pb.finish();
}
