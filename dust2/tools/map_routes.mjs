// Route walker for the map: drops a player hull and walks the classic de_dust2 routes with
// Quake-style slide + 18u step-up movement, proving every route is traversable and that the
// floor never leaks to the void.
//
//   node --import ./tools/three-resolve.mjs tools/map_routes.mjs [--verbose] [--route name]
import * as THREE from 'three';
import { buildDust2 } from '../src/map/dust2.js';
import { MASK_PLAYER } from '../src/player/collision.js';

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const ONLY = args.includes('--route') ? args[args.indexOf('--route') + 1] : null;

const V = (x, y, z) => new THREE.Vector3(x, z, -y);            // Source -> Three
const src = (v) => [Math.round(v.x), Math.round(-v.z), Math.round(v.y)];
const MINS = new THREE.Vector3(-16, 0, -16), MAXS = new THREE.Vector3(16, 72, 16);
const STEP = 18, SPEED = 250, DT = 1 / 64;

let props = null;
try { props = await import('../src/map/props.js'); } catch { props = null; }
const map = await buildDust2({ textures: null, props });
const col = map.collision;
const trace = (a, b) => col.hullTrace(MINS, MAXS, a, b, MASK_PLAYER);

function slide(pos, vel, dt) {
  let time = dt;
  const planes = [];
  for (let bump = 0; bump < 4; bump++) {
    const end = pos.clone().addScaledVector(vel, time);
    const tr = trace(pos, end);
    if (tr.allSolid) return { stuck: true };
    if (tr.fraction > 0) pos.copy(tr.endpos);
    if (tr.fraction === 1) break;
    time -= time * tr.fraction;
    const n = tr.normal.clone();
    planes.push(n);
    // clip against all planes hit so far (crease handling)
    for (const p of planes) {
      const back = vel.dot(p);
      if (back < 0) vel.addScaledVector(p, -back * 1.001);
    }
    if (vel.lengthSq() < 1) break;
  }
  return { stuck: false };
}

function groundTrace(pos, dist) {
  const tr = trace(pos, pos.clone().add(new THREE.Vector3(0, -dist, 0)));
  return { hit: tr.fraction < 1 && !tr.startSolid, end: tr.endpos.clone(), n: tr.normal.clone(), start: tr.startSolid };
}

function move(pos, wish) {
  // plain slide
  const p1 = pos.clone(), v1 = wish.clone();
  slide(p1, v1, DT);
  // step: up, slide, down
  const p2 = pos.clone();
  const up = trace(p2, p2.clone().add(new THREE.Vector3(0, STEP, 0)));
  p2.copy(up.endpos);
  const v2 = wish.clone();
  slide(p2, v2, DT);
  const dn = groundTrace(p2, STEP + 1);
  let stepOk = dn.hit && dn.n.y >= 0.7;
  if (stepOk) p2.copy(dn.end);
  const d1 = Math.hypot(p1.x - pos.x, p1.z - pos.z), d2 = Math.hypot(p2.x - pos.x, p2.z - pos.z);
  pos.copy(stepOk && d2 > d1 + 0.01 ? p2 : p1);
  // stick to ground / fall
  const g = groundTrace(pos, STEP + 2);
  if (g.hit && g.n.y >= 0.7) { pos.copy(g.end); return { ground: true, n: g.n }; }
  const f = groundTrace(pos, 2000);
  if (!f.hit) return { void: true };
  pos.copy(f.end);
  return { ground: true, fell: true, n: f.n };
}

function walk(name, pts) {
  const pos = V(...pts[0]);
  // settle onto the floor
  pos.y += 4;
  const st = groundTrace(pos, 400);
  if (!st.hit) return { name, ok: false, why: `start ${pts[0]} not above floor` };
  pos.copy(st.end);
  const startTr = trace(pos, pos);
  if (startTr.startSolid) return { name, ok: false, why: `start ${pts[0]} inside solid` };
  let dist = 0, ticks = 0, falls = 0, steep = 0;
  for (let i = 1; i < pts.length; i++) {
    const tgt = V(...pts[i]);
    let best = Infinity, since = 0;
    for (;;) {
      const dx = tgt.x - pos.x, dz = tgt.z - pos.z, d = Math.hypot(dx, dz);
      if (d < 12) break;
      const wish = new THREE.Vector3(dx / d * SPEED, 0, dz / d * SPEED);
      const before = pos.clone();
      const r = move(pos, wish);
      ticks++;
      if (r.void) return { name, ok: false, why: `fell into the VOID near ${src(before)}`, at: src(before) };
      if (r.fell && before.y - pos.y > 40) falls++;
      if (r.n && r.n.y < 0.7) steep++;
      dist += Math.hypot(pos.x - before.x, pos.z - before.z);
      if (d < best - 0.5) { best = d; since = 0; } else if (++since > 96) {
        return { name, ok: false, why: `stuck at ${src(pos)} heading to waypoint ${i} ${JSON.stringify(pts[i])} (${Math.round(d)}u away)`, at: src(pos) };
      }
      if (ticks > 64 * 120) return { name, ok: false, why: 'timeout' };
    }
    if (VERBOSE) console.log(`  ${name}: reached wp${i} ${JSON.stringify(pts[i])} at ${src(pos)}`);
  }
  return { name, ok: true, dist: Math.round(dist), secs: +(ticks * DT).toFixed(1), falls, steep, end: src(pos) };
}

// Waypoints in Source coords [x, y, z-ish] (z only seeds the start drop).
export const ROUTES = {
  't_long_a': [[-800, -850, 140], [-400, -850, 0], [-40, -820, 0], [250, -560, 0], [420, -250, 0], [600, 150, 0],
    [636, 290, 0], [636, 520, 0], [630, 765, 0], [640, 900, 0], [1300, 960, 0], [1420, 1300, 0], [1420, 1900, 0],
    [1440, 2330, 0], [1440, 2760, 0], [1420, 2930, 0], [1150, 2930, 0], [1120, 2860, 0], [1120, 2740, 0], [1120, 2500, 0]],
  't_mid_cat_a': [[-800, -850, 140], [-400, -850, 0], [-40, -760, 0], [-60, -540, 0], [-450, -520, 0], [-405, -300, 0], [-405, 150, 0],
    [-400, 400, 0], [-160, 520, 0], [-170, 700, 0], [-190, 1250, 0], [0, 1450, 0], [310, 1470, 0], [320, 1630, 0], [320, 1840, 0],
    [380, 2300, 0], [420, 2600, 0], [470, 2680, 0], [900, 2640, 0], [1100, 2600, 0]],
  't_upper_b': [[-1400, -800, 140], [-1940, -700, 0], [-1940, -150, 0], [-1700, 200, 0], [-1705, 500, 0], [-1705, 620, 0],
    [-1662, 760, 0], [-1662, 1100, 0], [-1980, 1250, 0], [-1980, 1600, 0], [-1980, 1880, 0], [-1800, 2100, 0], [-1560, 2600, 0]],
  'ct_bdoors_b': [[150, 2250, -110], [-200, 2150, 0], [-500, 2200, 0], [-900, 2250, 0], [-1230, 2210, 0], [-1320, 2209, 0],
    [-1450, 2250, 0], [-1560, 2620, 0]],
  'ct_mid_doors': [[150, 2250, -110], [-300, 2150, 0], [-460, 2100, 0], [-460, 1800, 0], [-420, 1680, 0], [-420, 1600, 0], [-420, 1400, 0], [-400, 700, 0]],
  'mid_lower_upper': [[-420, 1300, -100], [-530, 1430, 0], [-900, 1430, 0], [-1075, 1400, 0], [-1075, 1250, 0],
    [-1060, 1180, 0], [-1110, 1090, 0], [-1200, 1060, 0], [-1260, 1090, 0], [-1400, 1100, 0], [-1700, 1100, 0]],
  'ct_under_long': [[150, 2250, -110], [380, 2250, 0], [700, 2200, 0], [1100, 2150, 0], [1450, 2100, 0], [1420, 1300, 0], [1400, 900, 0]],
  'long_pit_side': [[1400, 900, 0], [1420, 700, 0], [1420, 300, 0], [1420, 700, 0], [1420, 840, 0], [1700, 900, 0], [1700, 700, 0], [1700, 400, 0]],
  'ct_short_a': [[150, 2250, -110], [380, 2250, 0], [700, 2200, 0], [1100, 2150, 0], [1440, 2330, 0], [1440, 2760, 0], [1420, 2930, 0], [1150, 2930, 0], [1120, 2860, 0], [1120, 2700, 0], [700, 2600, 0], [400, 2500, 0], [320, 2000, 0], [320, 1700, 0], [300, 1450, 0]],
  'bwindow': [[-900, 2300, 0], [-1120, 2500, 0], [-1130, 2610, 0], [-1150, 2715, 0], [-1215, 2715, 0], [-1280, 2690, 0], [-1320, 2670, 0], [-1380, 2670, 0], [-1450, 2670, 0]],
};

let fails = 0;
console.log(`map: ${map.stats.brushes} brushes, ${map.walkable.length / 9} walkable tris`);
for (const [name, pts] of Object.entries(ROUTES)) {
  if (ONLY && name !== ONLY) continue;
  const r = walk(name, pts);
  if (!r.ok) fails++;
  console.log(r.ok ? `PASS ${name.padEnd(16)} ${r.dist}u in ${r.secs}s  drops:${r.falls} steep:${r.steep}` : `FAIL ${name.padEnd(16)} ${r.why}`);
}

// Spawns: every spawn must be clear for a standing hull and sit on the floor.
let badSpawns = 0;
for (const [team, list] of Object.entries(map.spawns)) for (const sp of list) {
  const p = sp.pos.clone(); p.y += 2;
  const tr = trace(p, p);
  const g = groundTrace(p, 40);
  if (tr.startSolid || !g.hit) { badSpawns++; console.log(`BAD SPAWN ${team} ${src(sp.pos)} ${tr.startSolid ? 'in solid' : 'no floor'}`); }
}
console.log(`spawns: ${map.spawns.T.length} T, ${map.spawns.CT.length} CT, bad ${badSpawns}`);
if (badSpawns) fails++;

// Void probe: sample points on walkable triangles and make sure a hull dropped there lands.
let probes = 0, leaks = 0;
const W = map.walkable;
for (let i = 0; i < W.length; i += 9 * 3) {
  const cx = (W[i] + W[i + 3] + W[i + 6]) / 3, cy = (W[i + 1] + W[i + 4] + W[i + 7]) / 3, cz = (W[i + 2] + W[i + 5] + W[i + 8]) / 3;
  const p = new THREE.Vector3(cx, cy + 40, cz);
  const tr = col.rayTrace(p, new THREE.Vector3(cx, cy - 2000, cz), 1);
  probes++;
  if (tr.fraction >= 1) { leaks++; if (VERBOSE) console.log('  leak at', src(p)); }
}
console.log(`void probes: ${probes}, leaks: ${leaks}`);
process.exit(fails || leaks ? 1 : 0);
