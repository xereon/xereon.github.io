// Facade dressing: windows with frames/sills/shutters, street doors, lamps, meter boxes, AC
// units, awnings and the web of overhead wires Dust II is full of. Runs after the kit has
// resolved every wall, walks them deterministically and places detail on the street faces.
import { rng } from '../../core/mathx.js';

const SHUTTER = ['green', 'blue', 'green', 'brown', 'teal', 'red'];
const DOORPAINT = [null, 'teal', 'blue', null, 'green', 'red'];

export function decorate(K, walls) {
  const R = rng(0xd257);
  const wires = [];
  let nWin = 0, nDoor = 0, nLamp = 0;
  for (const w of walls) {
    if (w.header || !w.e || w.R.ceil != null || w.R.o.decor === false || w.R.o.stairOf) continue;
    if ((w.thick ?? 64) < 40) continue;                         // low/thin walls: ledges, rails, parapets
    const L = Math.hypot(w.B.x - w.A.x, w.B.y - w.A.y);
    const zf = Math.max(w.zfA, w.zfB);
    const H = w.top - zf;
    if (L < 90 || H < 120) continue;
    const ux = (w.B.x - w.A.x) / L, uy = (w.B.y - w.A.y) / L;
    const mx = -w.nx, my = -w.ny;                              // into the street
    const yaw = Math.atan2(-w.nx, w.ny) * 180 / Math.PI;       // prop local +Z -> into the street
    const at = (d, off = 0) => [w.A.x + ux * d + mx * off, w.A.y + uy * d + my * off];
    const floorAt = (d) => w.zfA + (w.zfB - w.zfA) * (d / L);
    const seed = Math.abs(Math.round(w.A.x * 7 + w.A.y * 13 + w.top));
    const r = rng(seed);
    const style = SHUTTER[seed % SHUTTER.length];
    const used = [];
    const free = (d, half) => used.every(([a, b]) => d + half < a || d - half > b);
    const take = (d, half) => used.push([d - half, d + half]);

    // ---- street door (one per longer wall, sometimes)
    if (L > 220 && H > 150 && r() < 0.42) {
      const d = 90 + r() * (L - 180);
      const wd = r() < 0.5 ? 64 : 80, hd = 104;
      const z = floorAt(d);
      if (Math.abs(w.zfB - w.zfA) / L < 0.08) {
        const [px, py] = at(d);
        K.prop('doubleDoor', [wd, hd, 0, { depth: 12, paint: DOORPAINT[seed % DOORPAINT.length], seed: seed % 7 }], [px, py, z], yaw);
        // worn stone doorstep
        K.slab(at(d - wd / 2 - 6, 9), at(d + wd / 2 + 6, 9), z - 2, z + 5, 18, 'stone_block', { col: false, color: 0.9 });
        take(d, wd / 2 + 24);
        nDoor++;
        if (r() < 0.45) { const [ax, ay] = at(d); K.prop('awning', [wd + 40, 36, { color: r() < 0.5 ? 'teal' : 'stripe' }], [ax, ay, z + hd + 16], yaw); }
      }
    }
    // ---- windows on upper storeys
    const storeys = [];
    if (H > 200) storeys.push(150);
    if (H > 320) storeys.push(270);
    if (H > 440) storeys.push(390);
    const arched = w.R.o.windows === 'arched';
    for (const zr of storeys) {
      const n = Math.floor((L - 80) / (arched ? 105 : 150));
      for (let k = 0; k < n; k++) {
        if (r() > (arched ? 0.95 : 0.62)) continue;
        const d = 60 + (k + 0.5) * ((L - 120) / n);
        if (!free(d, 30)) continue;
        const ww = 34 + Math.round(r() * 3) * 4, wh = 52 + Math.round(r() * 3) * 4;
        const z = zf + zr;
        if (z + wh > w.top - 24) continue;
        window_(K, w, at(d), ux, uy, mx, my, z, ww, wh, yaw, r() < 0.7 ? style : null, r, false, w.R.o.windows === 'arched');
        nWin++;
        if (zr > 200 || r() > 0.82) continue;
        // small balcony: stone slab on two corbels with an iron railing
        const bw = ww + 28, bd = 22;
        const a = at(d - bw / 2, 0), b = at(d + bw / 2, 0);
        K.slab(a, b, z - 12, z - 5, bd * 2, 'stone_block', { col: false, color: 0.92 });
        for (const f of [-0.35, 0.35]) K.slab(at(d + bw * f - 3, 0), at(d + bw * f + 3, 0), z - 26, z - 12, bd * 1.6, 'stone_block', { col: false, color: 0.85 });
        K.slab(at(d - bw / 2, bd - 1), at(d + bw / 2, bd - 1), z - 5, z + 26, 1.5, 'metal_grate', { col: false });
        for (const e of [-1, 1]) K.slab(at(d + e * bw / 2, 0.5), at(d + e * bw / 2, bd), z - 5, z + 26, 1.5, 'metal_grate', { col: false });
      }
    }
    // ---- ground-floor barred window, lamp, meter box, AC
    if (L > 160 && r() < 0.35) {
      const d = 50 + r() * (L - 100);
      if (free(d, 30)) { window_(K, w, at(d), ux, uy, mx, my, floorAt(d) + 56, 36, 48, yaw, null, r, true); take(d, 30); nWin++; }
    }
    if (L > 140 && H > 170 && r() < 0.3) {
      const d = 40 + r() * (L - 80);
      if (free(d, 16)) { const [px, py] = at(d); K.prop('lamp', [], [px, py, floorAt(d) + 150], yaw); take(d, 16); nLamp++; }
    }
    if (L > 120 && r() < 0.18) {
      const d = 40 + r() * (L - 80);
      if (free(d, 14)) {
        const [px, py] = at(d); const box = r() < 0.5 ? 'meterBox' : 'electricBox';
        K.prop(box, [], [px, py, floorAt(d) + (r() < 0.5 ? 40 : 56)], yaw); take(d, 14);
        if (box === 'electricBox') K.emitter('amb_powerbox', [px, py, floorAt(d) + 70], 500);
      }
    }
    if (L > 160 && H > 230 && r() < 0.16) {
      const d = 50 + r() * (L - 100);
      if (free(d, 24)) { const [px, py] = at(d); K.prop('acUnit', [], [px, py, zf + 190 + r() * 40], yaw); take(d, 24); }
    }
    // ---- timber roof beams (vigas) poking out under the coping
    if (H > 200 && L > 120 && r() < 0.22) {
      const zb = w.top - 26 - r() * 8;
      for (let d = 30; d < L - 30; d += 44 + r() * 6) {
        const [px, py] = at(d, 0);
        const bx = px + mx * 14, by = py + my * 14;
        K.slab([px - mx * 4, py - my * 4], [bx, by], zb, zb + 7, 7, 'wood_planks', { col: false, color: 0.75 });
      }
    }
    // ---- street clutter at the foot of the wall
    if (L > 180 && r() < 0.28) {
      const d = 60 + r() * (L - 120);
      if (free(d, 30)) {
        const k = r();
        const [px, py] = at(d, 18);
        const z = floorAt(d);
        if (k < 0.25) K.prop('urn', [Math.floor(r() * 3)], [px, py, z], r() * 360);
        else if (k < 0.45) K.prop('plant', [Math.floor(r() * 3)], [px, py, z], r() * 360);
        else if (k < 0.6) K.prop('tyreStack', [2 + Math.floor(r() * 3)], [px, py, z], r() * 360);
        else if (k < 0.75) K.prop('rubble', [18 + r() * 14], [px, py, z], r() * 360);
        else if (k < 0.87) K.prop('pallet', [48, 40], [px, py, z], yaw + (r() - 0.5) * 20);
        else K.prop('jerrycan', [Math.floor(r() * 2)], [px, py, z], r() * 360);
        take(d, 30);
      }
    }
    // wire anchor candidates
    if (H > 150 && L > 100) wires.push({ w, L, ux, uy, mx, my });
  }

  // ---- overhead wires across streets
  let nWire = 0;
  const segs = walls.filter((w) => !w.header && w.e);
  for (const c of wires) {
    if (nWire > 70) break;
    if (R() > 0.45) continue;
    const d = c.L * (0.25 + 0.5 * R());
    const px = c.w.A.x + c.ux * d, py = c.w.A.y + c.uy * d;
    let best = null;
    for (const s of segs) {
      if (s === c.w) continue;
      const t = raySeg(px + c.mx * 2, py + c.my * 2, c.mx, c.my, s.A.x, s.A.y, s.B.x, s.B.y);
      if (t && (!best || t.t < best.t)) best = { ...t, s };
    }
    if (!best || best.t < 160 || best.t > 1100) continue;
    const z = Math.min(c.w.top, best.s.top) - 22 - R() * 30;
    const qz = best.s.zfA + (best.s.zfB - best.s.zfA) * best.u;
    if (z - Math.max(c.w.zfA, c.w.zfB, qz) < 150) continue;
    const a = [px, z, -py], b = [px + c.mx * best.t, z - 6 + R() * 12, -(py + c.my * best.t)];
    K.prop('wireSpan', [a, b, 18 + best.t * 0.035], [0, 0, 0], 0);
    if (R() < 0.35) K.prop('wireSpan', [[a[0], a[1] - 9, a[2]], [b[0], b[1] - 11, b[2]], 22 + best.t * 0.04], [0, 0, 0], 0);
    nWire++;
  }
  K.decorStats = { windows: nWin, doors: nDoor, lamps: nLamp, wires: nWire };
}

/** Recessed dark window with a timber frame, stone sill and (optionally) shutters or bars. */
function window_(K, w, [px, py], ux, uy, mx, my, z, ww, wh, yaw, shutters, r, bars = false, arched = false) {
  const hw = ww / 2, o = 0.6;
  const P = (s, zz, off) => [px + ux * s + mx * off, py + uy * s + my * off, zz];
  if (arched) {
    // tall arched opening with a stone surround (Moorish hotel / CT buildings)
    const pane = [P(-hw, z, o), P(hw, z, o)];
    for (let i = 0; i <= 10; i++) { const a = Math.PI * i / 10; pane.push(P(hw * Math.cos(a), z + wh + hw * Math.sin(a), o)); }
    K.poly('window_frame', faceToward(pane, mx, my), { col: 0.1 });
    for (let i = 0; i < 10; i++) {
      const a0 = Math.PI * i / 10, a1 = Math.PI * (i + 1) / 10, R0 = hw + 1, R1 = hw + 7;
      const q = [P(R0 * Math.cos(a0), z + wh + R0 * Math.sin(a0), 1.5), P(R1 * Math.cos(a0), z + wh + R1 * Math.sin(a0), 1.5),
        P(R1 * Math.cos(a1), z + wh + R1 * Math.sin(a1), 1.5), P(R0 * Math.cos(a1), z + wh + R0 * Math.sin(a1), 1.5)];
      K.poly('arch_stone', faceToward(q, mx, my), { col: 0.95 });
    }
    for (const sgn of [-1, 1]) K.slab(P(sgn * (hw + 1), 0, 1.2).slice(0, 2), P(sgn * (hw + 7), 0, 1.2).slice(0, 2), z, z + wh, 2.4, 'arch_stone', { col: false });
    const sa = P(-hw - 8, 0, 4), sb = P(hw + 8, 0, 4);
    K.slab([sa[0], sa[1]], [sb[0], sb[1]], z - 6, z, 8, 'stone_block', { col: false, color: 0.95 });
    if (shutters) K.prop('windowGrate', [ww, wh], P(0, z, 0.8), yaw);
    return;
  }
  // dark pane just proud of the wall, facing the street
  const pane = [P(-hw, z, o), P(hw, z, o), P(hw, z + wh, o), P(-hw, z + wh, o)];
  K.poly('window_frame', faceToward(pane, mx, my), { col: 0.1 });
  // frame
  const fr = 3, fo = 2.2;
  K.slab(P(-hw - fr, z, fo / 2).slice(0, 2), P(hw + fr, z, fo / 2).slice(0, 2), z + wh, z + wh + fr, fo, 'window_frame', { col: false, color: 0.8 });
  for (const s of [-1, 1]) {
    const a = P(s * (hw + fr / 2) - fr / 2, 0, fo / 2), b = P(s * (hw + fr / 2) + fr / 2, 0, fo / 2);
    K.slab([a[0], a[1]], [b[0], b[1]], z, z + wh, fo, 'window_frame', { col: false, color: 0.8 });
  }
  // sill
  const sa = P(-hw - 6, 0, 3), sb = P(hw + 6, 0, 3);
  K.slab([sa[0], sa[1]], [sb[0], sb[1]], z - 5, z, 6, 'stone_block', { col: false, color: 0.95 });
  if (bars) K.prop('windowGrate', [ww, wh], P(0, z, 0.8), yaw);
  else if (shutters) K.prop('windowShutters', [ww, wh, r() < 0.8 ? 1 : 0.55, shutters], P(0, z, 0.3), yaw);
}

function faceToward(P, mx, my) {
  // Newell normal of P; reverse if it points into the wall
  let nx = 0, ny = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); }
  return nx * mx + ny * my < 0 ? P.slice().reverse() : P;
}

function raySeg(px, py, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((ax - px) * ey - (ay - py) * ex) / den;
  const u = ((ax - px) * dy - (ay - py) * dx) / den;
  if (u < 0 || u > 1 || t <= 0) return null;
  return { t, u };
}

/** Rooftop clutter on roofs that overlook the streets: dishes, AC units, water tanks, parapets. */
export function decorateRoofs(K, g) {
  if (!g) return;
  const { x0, y0, nx, ny, G, open, h } = g;
  const R = rng(0x2007);
  const isRoof = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && !open[j * nx + i] && !Number.isNaN(h[j * nx + i]);
  let n = 0;
  for (let j = 2; j < ny - 2; j += 3) for (let i = 2; i < nx - 2; i += 3) {
    if (!isRoof(i, j)) continue;
    // near a street edge (within 3 cells) but not on it
    let near = null;
    for (const [di, dj] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) if (i + di >= 0 && j + dj >= 0 && i + di < nx && j + dj < ny && open[(j + dj) * nx + i + di]) near = [di, dj];
    if (!near || !isRoof(i + Math.sign(near[0]), j + Math.sign(near[1]))) continue;
    const r = R();
    if (r > 0.1) continue;
    const z = h[j * nx + i];
    // all four neighbours at the same height (flat spot)
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => isRoof(i + a, j + b) && h[(j + b) * nx + i + a] === z)) continue;
    const px = x0 + (i + 0.5) * G, py = y0 + (j + 0.5) * G;
    const yaw = Math.atan2(near[1], near[0]) * 180 / Math.PI - 90;
    const k = R();
    if (k < 0.55) K.prop('satelliteDish', [{ roof: true }], [px, py, z], yaw + 180 + (R() - 0.5) * 60);
    else if (k < 0.8) K.prop('acUnit', [], [px, py, z + 2], yaw + 180);
    else K.obox([px, py, z], [40, 40, 44], R() * 90, 'metal_barrel', { col: false, color: 0.8 });
    n++;
  }
  K.decorStats = { ...(K.decorStats || {}), roofProps: n };
}
