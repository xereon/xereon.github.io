// Bot navigation graph baked from the collision world.
//
// A layered 2.5D grid: every NAV_CELL×NAV_CELL column is ray-scanned top-down to find each
// floor, a standing player hull is dropped onto it, and the spot is kept when a player fits
// (offsets inside the cell are tried so narrow doors are not missed). Neighbouring spots are
// linked only when the same hull traces PlayerMove uses can walk / step / jump / drop between
// them, so a path never asks for a move the movement code can't make. `map.walkable` is only
// used as a coverage check — the collision world is the ground truth for where a player fits.
//
// API (World.nav):
//   findPath(from, to, opts?) -> Vector3[] | null   A* + string pulling. Each point has
//                                                  .n (node) and .t (LINK_* used to reach it)
//   nearest(pos, maxUp?) -> node index | -1         pos(node, out) -> Vector3
//   randomPointIn(zone | calloutName, out?) -> Vector3 | null
//   areaOf(pos) -> callout name ('' if none)
//   visibleFrom(eye, radius?, max?) -> node[]       nodes whose standing eye is visible
//   hidingSpots(threatEye, near, radius?, max?) -> node[]   cover from a threat
//   debugDraw(scene)                                toggled by cvar nav_draw
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { MASK_PLAYER, MASK_VISIBLE } from '../player/collision.js';

defCvar('nav_draw', 0, 0, 1, 'draw the bot navigation graph');

export const NAV_CELL = 24;
export const LINK_WALK = 0, LINK_JUMP = 1, LINK_DROP = 2, LINK_CJUMP = 3;
const STEP = 18;
const JUMP_UP = 50;        // standing jump apex is 57u; leave margin
const CJUMP_UP = 62;       // crouch-jump tucks the legs 18u higher
const DROP_MAX = 240;      // CS fall damage starts around 210u
const EYE = 64;
const HULL_MIN = new THREE.Vector3(-16, 0, -16);
const HULL_MAX = new THREE.Vector3(16, 72, 16);
const ZERO = new THREE.Vector3();
// sub-cell sample offsets tried when the cell centre can't hold a standing hull
const OFFS = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [8, 8], [-8, 8], [8, -8], [-8, -8]];
// forward half of the 8-neighbourhood (each pair is tested once)
const NBR = [[1, 0], [0, 1], [1, 1], [1, -1]];
// ledges: the top spot may overhang the edge by 16u while the floor spot keeps 16u off the wall,
// so jump/drop partners can sit two columns apart
const NBR2 = [[2, 0], [0, 2], [2, 1], [1, 2], [2, -1], [1, -2], [2, 2], [2, -2]];
const AXIS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CLEAR_COST = [1.9, 1.3, 1.08, 1, 1];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Vector3(), _r = new THREE.Vector3();

const cache = new WeakMap();

/** Bake (or fetch the cached) navigation graph for a map. Resolves in < 2 s on Dust II. */
export async function buildNavMesh(map) {
  if (!map?.collision) return new NavMesh(null);
  if (cache.has(map)) return cache.get(map);
  const t0 = now();
  const nav = new NavMesh(map);
  await bake(nav, map);
  nav.bakeMs = now() - t0;
  cache.set(map, nav);
  if (typeof window !== 'undefined') window.__nav = nav;
  return nav;
}

/** Synchronous bake for node tests / tools. */
export function buildNavMeshSync(map) {
  const nav = new NavMesh(map);
  const it = bakeSteps(nav, map);
  while (!it.next().done);
  return nav;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

async function bake(nav, map) {
  const it = bakeSteps(nav, map);
  let t = now();
  for (;;) {
    const r = it.next();
    if (r.done) break;
    // yield to the browser every ~60 ms so the boot screen stays alive
    if (typeof window !== 'undefined' && now() - t > 60) {
      await new Promise((res) => setTimeout(res, 0));
      t = now();
    }
  }
}

// ---- baking --------------------------------------------------------------------------------

function* bakeSteps(nav, map) {
  const cw = map.collision;
  if (!cw.root) cw.build();
  const hull = (a, b) => cw.hullTrace(HULL_MIN, HULL_MAX, a, b, MASK_PLAYER);
  const ray = (a, b) => cw.hullTrace(ZERO, ZERO, a, b, MASK_PLAYER);

  // --- bounds: brush extents, trimmed to the playable region when the map tells us where it is
  const bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const b of cw.brushes) if (b.contents & MASK_PLAYER) { bmin.min(b.min); bmax.max(b.max); }
  if (!isFinite(bmin.x)) { nav._finish([], [], [], [], 1, 1, 0, 0); return; }
  const pmin = new THREE.Vector3(Infinity, 0, Infinity), pmax = new THREE.Vector3(-Infinity, 0, -Infinity);
  const addPt = (v) => { if (v) { pmin.x = Math.min(pmin.x, v.x); pmin.z = Math.min(pmin.z, v.z); pmax.x = Math.max(pmax.x, v.x); pmax.z = Math.max(pmax.z, v.z); } };
  for (const t of ['T', 'CT']) for (const s of map.spawns?.[t] || []) addPt(s.pos);
  for (const z of Object.values(map.bombsites || {})) { addPt(z.min); addPt(z.max); }
  for (const z of Object.values(map.callouts || {})) { addPt(z.min); addPt(z.max); }
  const PAD = 1500;
  let x0 = bmin.x, x1 = bmax.x, z0 = bmin.z, z1 = bmax.z;
  if (isFinite(pmin.x)) {
    x0 = Math.max(x0, pmin.x - PAD); x1 = Math.min(x1, pmax.x + PAD);
    z0 = Math.max(z0, pmin.z - PAD); z1 = Math.min(z1, pmax.z + PAD);
  }
  const LIM = 7000; // hard cap so a stray skybox brush can't blow the grid up
  x0 = Math.max(x0, -LIM); z0 = Math.max(z0, -LIM); x1 = Math.min(x1, LIM); z1 = Math.min(z1, LIM);
  const C = NAV_CELL;
  const nx = Math.max(1, Math.ceil((x1 - x0) / C)), nz = Math.max(1, Math.ceil((z1 - z0) / C));
  const yTop = bmax.y + 8, yBot = bmin.y - 8;

  // --- 1. column scan -> standable spots
  // Per column: every floor the downward ray finds, then (pass 2) the heights of neighbouring
  // columns too, which catches hulls bridging narrow gaps and standing on ledge overhangs.
  const cols = new Array(nx * nz);
  const tryPlace = (list, cx, cz, hy) => {
    for (const [ox, oz] of OFFS) {
      const x = cx + ox, z = cz + oz;
      for (let lift = 2; lift <= STEP + 2; lift += STEP) {
        _a.set(x, hy + lift, z); _b.set(x, hy - 22, z);
        const tr = hull(_a, _b);
        if (tr.startSolid) continue;
        if (tr.fraction >= 1 || tr.normal.y < 0.7) break;
        const ly = tr.endpos.y;
        for (let k = 0; k < list.length; k += 4) if (Math.abs(list[k + 1] - ly) < 8) return;
        // overhang: the hull stands on an edge, nothing under its centre (ledge lips, wall tops)
        _a.set(x, ly + 1, z); _b.set(x, ly - 20, z);
        const oh = ray(_a, _b).fraction >= 1 ? 1 : 0;
        list.push(x, ly, z, oh);
        return;
      }
    }
  };
  const heights = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const cx = x0 + (ix + 0.5) * C + 0.0137, cz = z0 + (iz + 0.5) * C + 0.0091;
      let y = yTop;
      heights.length = 0;
      for (let guard = 0; guard < 24 && y > yBot; guard++) {
        _a.set(cx, y, cz); _b.set(cx, yBot, cz);
        const tr = ray(_a, _b);
        if (tr.fraction >= 1) break;
        const hy = tr.endpos.y;
        if (tr.normal.y >= 0.7) heights.push(hy);
        y = hy - 1;
      }
      const list = [];
      for (const hy of heights) tryPlace(list, cx, cz, hy);
      cols[ix + iz * nx] = list;
    }
    if ((iz & 7) === 7) yield;
  }
  const base = cols.map((l) => l.length);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const list = cols[ix + iz * nx];
      const cx = x0 + (ix + 0.5) * C + 0.0137, cz = z0 + (iz + 0.5) * C + 0.0091;
      for (const [ox, oz] of AXIS4) {
        const jx = ix + ox, jz = iz + oz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const c2 = jx + jz * nx, other = cols[c2];
        for (let k = 0; k < base[c2]; k += 4) {
          const hy = other[k + 1];
          let have = false;
          for (let m = 0; m < list.length; m += 4) if (Math.abs(list[m + 1] - hy) < 8) { have = true; break; }
          if (!have) tryPlace(list, cx, cz, hy);
        }
      }
    }
    if ((iz & 7) === 7) yield;
  }
  const PX = [], PY = [], PZ = [], PC = [], PO = [];
  const colStart = new Int32Array(nx * nz + 1);
  for (let c = 0; c < nx * nz; c++) {
    colStart[c] = PX.length;
    const l = cols[c];
    for (let k = 0; k < l.length; k += 4) { PX.push(l[k]); PY.push(l[k + 1]); PZ.push(l[k + 2]); PO.push(l[k + 3]); PC.push(c); }
  }
  colStart[nx * nz] = PX.length;
  const N = PX.length;
  nav.stats.spots = N;
  yield;

  // --- 2. links
  const LA = [], LB = [], LT = [], LD = [];
  const addLink = (a, b, type) => {
    const d = Math.hypot(PX[b] - PX[a], PY[b] - PY[a], PZ[b] - PZ[a]);
    LA.push(a); LB.push(b); LT.push(type);
    // jumps are slow and fail sometimes: real players only take them when it saves real time
    LD.push(type === LINK_WALK ? d : type === LINK_DROP ? d + 40 + Math.max(0, PY[a] - PY[b] - 150) * 4 : type === LINK_JUMP ? d + 160 : d + 320);
  };

  const straight = (a, b) => {
    const ay = PY[a], by = PY[b];
    _a.set(PX[a], ay + 1.5, PZ[a]); _b.set(PX[b], by + 1.5, PZ[b]);
    const tr = hull(_a, _b);
    if (tr.startSolid || tr.fraction < 1) return false;
    // hole check under the midpoint (a gap wider than the hull would swallow the player)
    _a.set((PX[a] + PX[b]) * 0.5, Math.max(ay, by) + 1.5, (PZ[a] + PZ[b]) * 0.5);
    _b.set(_a.x, Math.min(ay, by) - STEP - 2, _a.z);
    const t2 = hull(_a, _b);
    return !t2.startSolid && t2.fraction < 1 && t2.normal.y >= 0.7;
  };

  // Mini PlayerMove: walk from a to b in 8u sub-steps with step-up and ground snapping.
  const simWalk = (a, b) => {
    const tx0 = PX[a], tz0 = PZ[a], dx = PX[b] - tx0, dz = PZ[b] - tz0;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 8));
    _p.set(tx0, PY[a], tz0);
    for (let i = 1; i <= n; i++) {
      const tx = tx0 + dx * i / n, tz = tz0 + dz * i / n;
      _a.set(_p.x, _p.y + 0.5, _p.z); _b.set(tx, _p.y + 0.5, tz);
      let tr = hull(_a, _b);
      if (tr.startSolid) return false;
      if (tr.fraction < 1) {
        _b.set(_p.x, _p.y + STEP + 0.5, _p.z);
        tr = hull(_a, _b);
        const top = tr.endpos.y;
        _a.set(_p.x, top, _p.z); _b.set(tx, top, tz);
        tr = hull(_a, _b);
        if (tr.startSolid || tr.fraction < 1) return false;
        _q.set(tx, top, tz);
      } else _q.set(tx, _p.y + 0.5, tz);
      _b.set(_q.x, _p.y - STEP - 10, _q.z);
      tr = hull(_q, _b);
      if (tr.startSolid || tr.fraction >= 1 || tr.normal.y < 0.7) return false;
      _p.copy(tr.endpos);
    }
    return Math.abs(_p.y - PY[b]) < 6;
  };

  // upper -> lower: step off the ledge at the upper height, then fall straight down
  const dropTest = (u, l) => {
    _a.set(PX[u], PY[u] + 1, PZ[u]); _b.set(PX[l], PY[u] + 1, PZ[l]);
    let tr = hull(_a, _b);
    if (tr.startSolid || tr.fraction < 1) return false;
    _a.copy(_b); _b.set(PX[l], PY[l] - 4, PZ[l]);
    tr = hull(_a, _b);
    if (tr.startSolid || tr.fraction >= 1) return false;
    return Math.abs(tr.endpos.y - PY[l]) < 4;
  };
  let hasDropRef = null;
  const tryDrop = (a, b, dy, ady, ring = 0) => {
    const up = dy < 0 ? a : b, lo = dy < 0 ? b : a;
    if (!dropTest(up, lo)) return;
    addLink(up, lo, LINK_DROP);
    if (ady <= JUMP_UP) addLink(lo, up, LINK_JUMP);
    else if (ady <= CJUMP_UP) addLink(lo, up, LINK_CJUMP);
    if (hasDropRef) hasDropRef[up] = ring ? 2 : 1;
  };

  const hasDrop = new Uint8Array(N);
  hasDropRef = hasDrop;
  for (let a = 0; a < N; a++) {
    const c = PC[a], ix = c % nx, iz = (c / nx) | 0;
    for (const [ox, oz] of NBR) {
      const jx = ix + ox, jz = iz + oz;
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      const c2 = jx + jz * nx;
      for (let b = colStart[c2], e = colStart[c2 + 1]; b < e; b++) {
        const dy = PY[b] - PY[a], ady = Math.abs(dy);
        const h = Math.hypot(PX[b] - PX[a], PZ[b] - PZ[a]);
        let walked = false;
        if (ady <= Math.max(STEP + 1, h * 1.05 + 1)) {
          // a clean straight sweep is symmetric; stepped moves are not (down 25u is fine, up isn't)
          if (straight(a, b)) { addLink(a, b, LINK_WALK); addLink(b, a, LINK_WALK); walked = true; }
          else {
            const ab = simWalk(a, b), ba = simWalk(b, a);
            if (ab) addLink(a, b, LINK_WALK);
            if (ba) addLink(b, a, LINK_WALK);
            walked = ab && ba;
            // one-way walk down a lip: the way back up may still be a jump
            if (ab !== ba && ady > STEP && ady <= JUMP_UP) addLink(ab ? b : a, ab ? a : b, LINK_JUMP);
          }
        }
        if (!walked && ady > 8 && ady <= DROP_MAX) tryDrop(a, b, dy, ady);
      }
    }
    if ((a & 1023) === 1023) yield;
  }
  // second ring: only ledge pairs that found no drop/jump partner in the first ring
  for (let a = 0; a < N; a++) {
    const c = PC[a], ix = c % nx, iz = (c / nx) | 0;
    for (const [ox, oz] of NBR2) {
      const jx = ix + ox, jz = iz + oz;
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      const c2 = jx + jz * nx;
      for (let b = colStart[c2], e = colStart[c2 + 1]; b < e; b++) {
        const dy = PY[b] - PY[a], ady = Math.abs(dy);
        if (ady <= STEP + 1 || ady > DROP_MAX) continue;
        const up = dy < 0 ? a : b;
        if (hasDrop[up] >= 2) continue;
        tryDrop(a, b, dy, ady, 1);
      }
    }
    if ((a & 1023) === 1023) yield;
  }
  nav.stats.links = LA.length;
  yield;

  // --- 3. keep only what a player can reach from a spawn (drops skybox tops, roofs, voids)
  const out = new Int32Array(N + 1);
  for (let i = 0; i < LA.length; i++) out[LA[i] + 1]++;
  for (let i = 0; i < N; i++) out[i + 1] += out[i];
  const adj = new Int32Array(LA.length), fill = out.slice(0, N);
  for (let i = 0; i < LA.length; i++) adj[fill[LA[i]]++] = LB[i];
  const keep = new Uint8Array(N);
  const seeds = [];
  const nearestRaw = (p) => {
    const ix = Math.floor((p.x - x0) / C), iz = Math.floor((p.z - z0) / C);
    let best = -1, bd = Infinity;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      const c2 = jx + jz * nx;
      for (let k = colStart[c2]; k < colStart[c2 + 1]; k++) {
        const d = (PX[k] - p.x) ** 2 + (PZ[k] - p.z) ** 2 + ((PY[k] - p.y) * 3) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    }
    return best;
  };
  for (const t of ['T', 'CT']) for (const s of map.spawns?.[t] || []) { const k = nearestRaw(s.pos); if (k >= 0) seeds.push(k); }
  if (!seeds.length) keep.fill(1);
  else {
    const stack = seeds.slice();
    for (const s of seeds) keep[s] = 1;
    while (stack.length) {
      const a = stack.pop();
      for (let i = out[a]; i < out[a + 1]; i++) { const b = adj[i]; if (!keep[b]) { keep[b] = 1; stack.push(b); } }
    }
  }
  const remap = new Int32Array(N).fill(-1);
  const X = [], Y = [], Z = [], COL = [], OH = [];
  for (let i = 0; i < N; i++) if (keep[i]) { remap[i] = X.length; X.push(PX[i]); Y.push(PY[i]); Z.push(PZ[i]); COL.push(PC[i]); OH.push(PO[i]); }
  const links = [];
  for (let i = 0; i < LA.length; i++) {
    const a = remap[LA[i]], b = remap[LB[i]];
    if (a >= 0 && b >= 0) links.push([a, b, LT[i], LD[i]]);
  }
  nav.stats.pruned = N - X.length;
  yield;
  nav._finish(X, Y, Z, COL, nx, nz, x0, z0, links, OH);
  yield;
  nav._walkReach(map);
  nav._assignAreas(map);
  nav._coverage(map);
  // warm the A* up so the first in-game path doesn't pay the JIT (≈30 ms) mid-round
  for (let i = 0; i < 6 && nav.count > 1; i++) nav.astar((i * 7919) % nav.count, (i * 104729 + 13) % nav.count);
}

// ---- runtime ------------------------------------------------------------------------------

class NavMesh {
  constructor(map) {
    this.map = map;
    this.count = 0;
    this.stats = { spots: 0, links: 0, pruned: 0 };
    this.areaNames = [];
    this.areaNodes = {};
    this.bakeMs = 0;
    this._debug = null;
    this._gen = 1;
    this.lastPathNodes = [];
    this.failCost = null;   // Float32Array per node: learned penalty from failed traversals
  }

  _finish(X, Y, Z, COL, nx, nz, x0, z0, links = [], OH = null) {
    const n = X.length;
    this.count = n; this.nx = nx; this.nz = nz; this.x0 = x0; this.z0 = z0;
    this.px = Float32Array.from(X); this.py = Float32Array.from(Y); this.pz = Float32Array.from(Z);
    this.col = Int32Array.from(COL);
    // per-column node lists (nodes are already column-ordered)
    const cs = new Int32Array(nx * nz + 1);
    for (let i = 0; i < n; i++) cs[this.col[i] + 1]++;
    for (let i = 0; i < nx * nz; i++) cs[i + 1] += cs[i];
    this.colStart = cs;
    // CSR links
    const ls = new Int32Array(n + 1);
    for (const l of links) ls[l[0] + 1]++;
    for (let i = 0; i < n; i++) ls[i + 1] += ls[i];
    const L = links.length;
    this.linkStart = ls;
    this.linkTo = new Int32Array(L);
    this.linkType = new Uint8Array(L);
    this.linkCost = new Float32Array(L);
    const fill = ls.slice(0, n);
    for (const [a, b, t, d] of links) { const k = fill[a]++; this.linkTo[k] = b; this.linkType[k] = t; this.linkCost[k] = d; }
    // clearance: hops to the nearest node missing a walkable neighbour (walls, ledges)
    const clear = new Uint8Array(n).fill(255);
    const q = new Int32Array(n);
    let qh = 0, qt = 0;
    const deg = new Uint8Array(n), ridge = new Uint8Array(n);
    const oh = this.overhang = OH ? Uint8Array.from(OH) : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let k = ls[i]; k < ls[i + 1]; k++) if (this.linkType[k] === LINK_WALK) w++;
      deg[i] = Math.min(255, w);
      if (w < 8) { clear[i] = 0; q[qt++] = i; }
    }
    // ridge: a centre-supported spot with no supported same-level floor on both sides of an axis
    // (the top of a thin wall or crate edge — walkable in theory, a tightrope in practice)
    const supported = (i, dx, dz) => {
      const c = this.col[i], ix = c % nx + dx, iz = ((c / nx) | 0) + dz;
      if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return false;
      const c2 = ix + iz * nx;
      for (let k = ls[i]; k < ls[i + 1]; k++) {
        const b = this.linkTo[k];
        if (this.linkType[k] === LINK_WALK && this.col[b] === c2 && !oh[b]) return true;
      }
      return false;
    };
    for (let i = 0; i < n; i++) {
      if (oh[i]) continue;
      if ((!supported(i, 1, 0) && !supported(i, -1, 0)) || (!supported(i, 0, 1) && !supported(i, 0, -1))) ridge[i] = 1;
    }
    this.walkDeg = deg;
    this.ridge = ridge;
    while (qh < qt) {
      const a = q[qh++];
      if (clear[a] >= 4) continue;
      for (let k = ls[a]; k < ls[a + 1]; k++) {
        const b = this.linkTo[k];
        if (this.linkType[k] === LINK_WALK && clear[b] > clear[a] + 1) { clear[b] = clear[a] + 1; q[qt++] = b; }
      }
    }
    for (let i = 0; i < n; i++) if (clear[i] > 4) clear[i] = 4;
    this.clear = clear;
    // bake entry cost multipliers into links; hopping onto thin wall tops / crate edges is
    // parkour, not how people move around — only when there's no other way
    for (let a = 0; a < n; a++) for (let k = ls[a]; k < ls[a + 1]; k++) {
      const b = this.linkTo[k], t = this.linkType[k];
      this.linkCost[k] *= CLEAR_COST[clear[b]];
      if ((t === LINK_JUMP || t === LINK_CJUMP) && deg[b] < 5) this.linkCost[k] += 2500;
      if (ridge[b]) this.linkCost[k] += 600;
      else if (oh[b]) this.linkCost[k] += 120;
    }
    // walk-reachable set: spawn-connected without any jump (tactical spots must be in it)
    this.walkReach = new Uint8Array(n);
    this.failCost = new Float32Array(n);
    // A* scratch
    this._g = new Float32Array(n);
    this._from = new Int32Array(n);
    this._seen = new Uint32Array(n);
    this._closed = new Uint32Array(n);
    this._heapN = new Int32Array(Math.max(16, n));
    this._heapF = new Float32Array(Math.max(16, n));
    this.area = new Uint16Array(n).fill(0xffff);
  }

  _walkReach(map) {
    const wr = this.walkReach, n = this.count;
    const q = [];
    for (const t of ['T', 'CT']) for (const sp of map?.spawns?.[t] || []) { const k = this.nearest(sp.pos); if (k >= 0 && !wr[k]) { wr[k] = 1; q.push(k); } }
    if (!q.length) { wr.fill(1); return; }
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (let k = this.linkStart[a]; k < this.linkStart[a + 1]; k++) {
        const t = this.linkType[k], b = this.linkTo[k];
        if ((t === LINK_WALK || t === LINK_DROP) && !wr[b]) { wr[b] = 1; q.push(b); }
      }
    }
    let c = 0; for (let i = 0; i < n; i++) c += wr[i];
    this.stats.walkReach = c;
  }

  _assignAreas(map) {
    const zones = Object.entries(map?.callouts || {});
    this.areaNames = zones.map(([k]) => k);
    const n = this.count;
    if (!zones.length || !n) return;
    const vol = zones.map(([, z]) => Math.max(1, (z.max.x - z.min.x) * (z.max.z - z.min.z)));
    const area = this.area;
    const exact = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      let best = -1, bv = Infinity;
      for (let j = 0; j < zones.length; j++) {
        const Z = zones[j][1];
        if (x < Z.min.x || x > Z.max.x || z < Z.min.z || z > Z.max.z) continue;
        if (y < Z.min.y - 40 || y > Z.max.y + 24) continue;
        if (vol[j] < bv) { bv = vol[j]; best = j; }
      }
      if (best >= 0) { area[i] = best; exact[i] = 1; }
    }
    // flood unassigned nodes from their nearest assigned neighbour so areaOf never draws blank
    const q = [];
    for (let i = 0; i < n; i++) if (exact[i]) q.push(i);
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (let k = this.linkStart[a]; k < this.linkStart[a + 1]; k++) {
        const b = this.linkTo[k];
        if (area[b] === 0xffff) { area[b] = area[a]; q.push(b); }
      }
    }
    this.areaExact = exact;
    const lists = {};
    for (let i = 0; i < n; i++) if (exact[i]) (lists[this.areaNames[area[i]]] ||= []).push(i);
    for (const k of Object.keys(lists)) this.areaNodes[k] = Int32Array.from(lists[k]);
  }

  // How much of the map's declared walkable surface did the grid cover? (bake diagnostics)
  _coverage(map) {
    const w = map?.walkable;
    if (!w || w.length < 9 || !this.count) return;
    let tested = 0, hit = 0;
    for (let i = 0; i + 8 < w.length && tested < 4000; i += 9 * Math.max(1, Math.floor(w.length / 9 / 4000))) {
      const x = (w[i] + w[i + 3] + w[i + 6]) / 3, y = (w[i + 1] + w[i + 4] + w[i + 7]) / 3, z = (w[i + 2] + w[i + 5] + w[i + 8]) / 3;
      tested++;
      const k = this.nearest(_a.set(x, y, z));
      if (k >= 0 && Math.abs(this.py[k] - y) < 32 && Math.hypot(this.px[k] - x, this.pz[k] - z) < 48) hit++;
    }
    this.stats.walkableCoverage = tested ? hit / tested : 0;
  }

  // ---- queries -------------------------------------------------------------------------

  pos(i, out = new THREE.Vector3()) { return out.set(this.px[i], this.py[i], this.pz[i]); }

  /** A spot a player would actually stand on (not a thin wall top / ledge lip). */
  solidSpot(i) { return this.walkDeg[i] >= 5 && this.walkReach[i] === 1 && !this.ridge[i] && !this.overhang[i]; }

  colOf(x, z) {
    const ix = Math.floor((x - this.x0) / NAV_CELL), iz = Math.floor((z - this.z0) / NAV_CELL);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return ix + iz * this.nx;
  }

  /** Nearest node to a feet position. Prefers floors at or just below the feet. */
  nearest(p, maxUp = 40) {
    if (!this.count) return -1;
    const ix = Math.floor((p.x - this.x0) / NAV_CELL), iz = Math.floor((p.z - this.z0) / NAV_CELL);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 8 && best < 0; r += 3) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const c = jx + jz * this.nx;
        for (let k = this.colStart[c], e = this.colStart[c + 1]; k < e; k++) {
          const dy = this.py[k] - p.y;
          const d = (this.px[k] - p.x) ** 2 + (this.pz[k] - p.z) ** 2 + (dy > maxUp ? (dy * 6) ** 2 : (dy * 2.5) ** 2);
          if (d < bd) { bd = d; best = k; }
        }
      }
    }
    return best;
  }

  /** Like nearest(), but the node must be reachable in a straight hull sweep (not across a wall). */
  nearestReachable(p, maxUp = 40) {
    if (!this.count) return -1;
    const cw = World.collision || this.map?.collision;
    const ix = Math.floor((p.x - this.x0) / NAV_CELL), iz = Math.floor((p.z - this.z0) / NAV_CELL);
    const cand = this._nr || (this._nr = []);
    cand.length = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
      const c = jx + jz * this.nx;
      for (let k = this.colStart[c], e = this.colStart[c + 1]; k < e; k++) {
        const dy = this.py[k] - p.y;
        cand.push(k, (this.px[k] - p.x) ** 2 + (this.pz[k] - p.z) ** 2 + (dy > maxUp ? (dy * 6) ** 2 : (dy * 2.5) ** 2));
      }
    }
    if (!cand.length || !cw) return this.nearest(p, maxUp);
    // selection of the best few by score
    for (let t = 0; t < 6; t++) {
      let bi = -1, bs = Infinity;
      for (let i = 0; i < cand.length; i += 2) if (cand[i + 1] < bs) { bs = cand[i + 1]; bi = i; }
      if (bi < 0) break;
      const k = cand[bi];
      cand[bi + 1] = Infinity;
      _a.set(p.x, p.y + STEP, p.z); _b.set(this.px[k], this.py[k] + STEP, this.pz[k]);
      const tr = cw.hullTrace(HULL_MIN, HULL_MAX, _a, _b, MASK_PLAYER);
      if (tr.startSolid || tr.fraction >= 1) return k;
    }
    return this.nearest(p, maxUp);
  }

  areaOf(p) {
    const k = typeof p === 'number' ? p : this.nearest(p);
    if (k < 0) return '';
    const a = this.area[k];
    return a === 0xffff ? '' : this.areaNames[a];
  }

  randomPointIn(zone, out = new THREE.Vector3(), rnd = Math.random) {
    if (!this.count) return null;
    if (typeof zone === 'string') {
      const list = this.areaNodes[zone];
      if (list?.length) return this.pos(list[(rnd() * list.length) | 0], out);
      zone = this.map?.callouts?.[zone] || this.map?.bombsites?.[zone];
      if (!zone) return null;
    }
    const x0 = Math.floor((zone.min.x - this.x0) / NAV_CELL), x1 = Math.floor((zone.max.x - this.x0) / NAV_CELL);
    const z0 = Math.floor((zone.min.z - this.z0) / NAV_CELL), z1 = Math.floor((zone.max.z - this.z0) / NAV_CELL);
    for (let tries = 0; tries < 48; tries++) {
      const ix = x0 + Math.floor(rnd() * (x1 - x0 + 1)), iz = z0 + Math.floor(rnd() * (z1 - z0 + 1));
      if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
      const c = ix + iz * this.nx, s = this.colStart[c], e = this.colStart[c + 1];
      for (let k = s; k < e; k++) {
        const y = this.py[k];
        if (y >= zone.min.y - 40 && y <= zone.max.y + 24) return this.pos(k, out);
      }
    }
    return null;
  }

  /** Nodes (subsampled) whose standing eye is visible from `eye`. */
  visibleFrom(eye, radius = 1500, max = 64) {
    const res = [];
    if (!this.count) return res;
    const cw = World.collision || this.map?.collision;
    const stride = Math.max(1, Math.round(radius / NAV_CELL / 12));
    const ix0 = Math.floor((eye.x - this.x0) / NAV_CELL), iz0 = Math.floor((eye.z - this.z0) / NAV_CELL);
    const R = Math.ceil(radius / NAV_CELL);
    for (let dz = -R; dz <= R && res.length < max; dz += stride) for (let dx = -R; dx <= R && res.length < max; dx += stride) {
      const jx = ix0 + dx, jz = iz0 + dz;
      if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
      const c = jx + jz * this.nx;
      for (let k = this.colStart[c]; k < this.colStart[c + 1]; k++) {
        _b.set(this.px[k], this.py[k] + EYE, this.pz[k]);
        if (_b.distanceToSquared(eye) > radius * radius) continue;
        if (cw.rayTrace(eye, _b, MASK_VISIBLE).fraction >= 1) res.push(k);
      }
    }
    return res;
  }

  /** Nodes near `near` that a threat at `threatEye` cannot see (standing), closest first. */
  hidingSpots(threatEye, near, radius = 400, max = 6, maxChecks = 200) {
    const res = [];
    if (!this.count) return res;
    const cw = World.collision || this.map?.collision;
    const start = this.nearest(near);
    if (start < 0) return res;
    // BFS outward over walk links so spots are actually reachable quickly
    const gen = ++this._gen;
    const q = [start];
    this._seen[start] = gen;
    for (let h = 0; h < q.length && q.length < 600 && res.length < max && maxChecks > 0; h++) {
      const a = q[h];
      if (h % 2 === 0 && maxChecks-- > 0) {
        _b.set(this.px[a], this.py[a] + EYE, this.pz[a]);
        if (cw.rayTrace(threatEye, _b, MASK_VISIBLE).fraction < 1) {
          _b.y = this.py[a] + 46; // crouched eye too
          if (cw.rayTrace(threatEye, _b, MASK_VISIBLE).fraction < 1) res.push(a);
        }
      }
      for (let k = this.linkStart[a]; k < this.linkStart[a + 1]; k++) {
        const b = this.linkTo[k];
        if (this._seen[b] === gen || this.linkType[k] !== LINK_WALK) continue;
        if ((this.px[b] - near.x) ** 2 + (this.pz[b] - near.z) ** 2 > radius * radius) continue;
        this._seen[b] = gen; q.push(b);
      }
    }
    return res;
  }

  /** Straight walkable along the grid from node a to node b (no jump/drop, keeps clearance). */
  lineWalk(a, b, minClear = 1) {
    const ax = this.px[a], az = this.pz[a], dx = this.px[b] - ax, dz = this.pz[b] - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / (NAV_CELL * 0.5));
    let cur = a;
    this._lwTight = this.clear[a] === 0 || this.clear[b] === 0;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const c = this.colOf(ax + dx * t, az + dz * t);
      if (c < 0) return false;
      if (c === this.col[cur]) continue;
      let nxt = -1, bdy = Infinity;
      for (let k = this.linkStart[cur]; k < this.linkStart[cur + 1]; k++) {
        const to = this.linkTo[k];
        if (this.linkType[k] !== LINK_WALK || this.col[to] !== c) continue;
        const dy = Math.abs(this.py[to] - this.py[cur]);
        if (dy < bdy) { bdy = dy; nxt = to; }
      }
      if (nxt < 0) return false;
      if (nxt !== b && this.clear[nxt] < minClear) return false;
      if (this.failCost[nxt] > 0) return false;
      if (this.clear[nxt] === 0) this._lwTight = true;
      cur = nxt;
    }
    return cur === b;
  }

  /** Real hull sweep between two nodes, lifted by step height so stairs don't count. */
  sweepClear(a, b) {
    const cw = World.collision || this.map?.collision;
    if (!cw) return true;
    _a.set(this.px[a], this.py[a] + STEP, this.pz[a]);
    _b.set(this.px[b], this.py[b] + STEP, this.pz[b]);
    const tr = cw.hullTrace(HULL_MIN, HULL_MAX, _a, _b, MASK_PLAYER);
    return !tr.startSolid && tr.fraction >= 1;
  }

  linkBetween(a, b) {
    for (let k = this.linkStart[a]; k < this.linkStart[a + 1]; k++) if (this.linkTo[k] === b) return k;
    return -1;
  }

  /**
   * A* over the graph. opts.nodeCost: Float32Array extra cost per node (route shaping / danger),
   * opts.maxExpand: node budget. Returns node index array or null.
   */
  astar(s, g, opts = {}) {
    if (s < 0 || g < 0) return null;
    if (s === g) return [s];
    const extra = opts.nodeCost || null, fail = this.failCost;
    const maxExpand = opts.maxExpand || 60000;
    const W = opts.weight ?? 1.5;
    const gen = ++this._gen;
    const G = this._g, F = this._from, seen = this._seen, closed = this._closed;
    const hn = this._heapN, hf = this._heapF;
    const gx = this.px[g], gy = this.py[g], gz = this.pz[g];
    const px = this.px, py = this.py, pz = this.pz, ls = this.linkStart, lt = this.linkTo, lc = this.linkCost;
    let size = 0;
    const push = (n, f) => {
      let i = size++;
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; hn[i] = hn[p]; hf[i] = hf[p]; i = p; }
      hn[i] = n; hf[i] = f;
    };
    const pop = () => {
      const top = hn[0];
      const ln = hn[--size], lf = hf[size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= lf) break;
        hn[i] = hn[c]; hf[i] = hf[c]; i = c;
      }
      hn[i] = ln; hf[i] = lf;
      return top;
    };
    G[s] = 0; F[s] = -1; seen[s] = gen;
    push(s, 0);
    let expanded = 0;
    while (size > 0) {
      const a = pop();
      if (closed[a] === gen) continue;
      closed[a] = gen;
      if (a === g) break;
      if (++expanded > maxExpand || size >= hn.length - 16) return null;
      const ga = G[a];
      for (let k = ls[a], e = ls[a + 1]; k < e; k++) {
        const b = lt[k];
        if (closed[b] === gen) continue;
        let c = ga + lc[k] + fail[b];
        if (extra) c += extra[b];
        if (seen[b] !== gen || c < G[b]) {
          seen[b] = gen; G[b] = c; F[b] = a;
          const h = Math.sqrt((px[b] - gx) ** 2 + (py[b] - gy) ** 2 + (pz[b] - gz) ** 2);
          push(b, c + h * W);
        }
      }
    }
    if (closed[g] !== gen) return null;
    const path = [];
    for (let n = g; n !== -1; n = F[n]) path.push(n);
    path.reverse();
    this.lastExpanded = expanded;
    return path;
  }

  /** Path cost (for route comparison) of a node list. */
  pathLength(nodes) {
    let d = 0;
    for (let i = 1; i < nodes.length; i++) d += Math.hypot(this.px[nodes[i]] - this.px[nodes[i - 1]], this.pz[nodes[i]] - this.pz[nodes[i - 1]]);
    return d;
  }

  /** String-pull a node path into waypoints. Jumps and drops are always kept as corners. */
  smooth(nodes, to = null) {
    const out = [];
    const n = nodes.length;
    if (!n) return out;
    let i = 0;
    const typeOf = (x, y) => { const k = this.linkBetween(x, y); return k < 0 ? LINK_WALK : this.linkType[k]; };
    while (i < n - 1) {
      let j = i + 1;
      if (typeOf(nodes[i], nodes[j]) === LINK_WALK) {
        const minC = Math.min(1, this.clear[nodes[i]]);
        while (j + 1 < n && j + 1 - i < 40 && typeOf(nodes[j], nodes[j + 1]) === LINK_WALK &&
               this.lineWalk(nodes[i], nodes[j + 1], Math.min(minC, this.clear[nodes[j + 1]] < 1 ? 0 : 1)) &&
               (!this._lwTight || this.sweepClear(nodes[i], nodes[j + 1]))) j++;
      }
      const v = this.pos(nodes[j]);
      v.n = nodes[j]; v.t = typeOf(nodes[j - 1], nodes[j]);
      out.push(v);
      i = j;
    }
    if (n === 1) { const v = this.pos(nodes[0]); v.n = nodes[0]; v.t = LINK_WALK; out.push(v); }
    if (to && out.length) {
      const last = out[out.length - 1];
      if (Math.hypot(to.x - last.x, to.z - last.z) < NAV_CELL * 1.5 && Math.abs(to.y - last.y) < 20) {
        const v = to.clone(); v.n = last.n; v.t = LINK_WALK; out[out.length - 1] = v;
      }
    }
    return out;
  }

  findPath(from, to, opts = {}) {
    const s = this.nearest(from), g = typeof to === 'number' ? to : this.nearest(to);
    const nodes = this.astar(s, g, opts);
    if (!nodes) return null;
    this.lastPathNodes = nodes;
    return this.smooth(nodes, typeof to === 'number' ? null : to);
  }

  /** Learn from a failed traversal: make the node expensive for everyone for a while. */
  penalize(node, amount = 400) {
    if (node >= 0 && node < this.count) this.failCost[node] = Math.min(4000, this.failCost[node] + amount);
  }

  /** Can a standing eye at `a` see `b`? (world only, MASK_VISIBLE) */
  los(a, b) {
    const cw = World.collision || this.map?.collision;
    return cw.rayTrace(a, b, MASK_VISIBLE).fraction >= 1;
  }

  // ---- debug ---------------------------------------------------------------------------

  debugDraw(scene) {
    if (!this.count || !scene) return null;
    if (this._debug) { if (this._debug.parent !== scene) scene.add(this._debug); return this._debug; }
    const g = new THREE.Group();
    g.name = 'nav_debug';
    const n = this.count;
    const col = new THREE.Color();
    // nodes: small quads so they read from any height; colour by area, darker near walls
    const pos = new Float32Array(n * 3), cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = this.px[i]; pos[i * 3 + 1] = this.py[i] + 3; pos[i * 3 + 2] = this.pz[i];
      const a = this.area[i];
      if (a === 0xffff) col.setRGB(0.9, 0.9, 0.9); else col.setHSL(((a * 0.618034) % 1), 0.75, 0.55);
      col.multiplyScalar(0.55 + 0.45 * Math.min(1, this.clear[i] / 2));
      cols[i * 3] = col.r; cols[i * 3 + 1] = col.g; cols[i * 3 + 2] = col.b;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 5, sizeAttenuation: true, vertexColors: true, depthTest: true }));
    pts.frustumCulled = false;
    g.add(pts);
    // links: walk green, jump blue, drop orange (drawn once per pair for walk)
    const L = this.linkTo.length;
    const lp = [], lc = [];
    for (let a = 0; a < n; a++) {
      for (let k = this.linkStart[a]; k < this.linkStart[a + 1]; k++) {
        const b = this.linkTo[k], t = this.linkType[k];
        if (t === LINK_WALK && b < a) continue;
        lp.push(this.px[a], this.py[a] + 3, this.pz[a], this.px[b], this.py[b] + 3, this.pz[b]);
        if (t === LINK_WALK) { lc.push(0.2, 0.85, 0.3, 0.2, 0.85, 0.3); }
        else if (t === LINK_DROP) { lc.push(1, 0.55, 0.1, 1, 0.2, 0.0); }
        else { lc.push(0.2, 0.5, 1, 0.6, 0.8, 1); }
      }
    }
    void L;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthTest: true }));
    lines.frustumCulled = false;
    g.add(lines);
    this._debug = g;
    scene.add(g);
    return g;
  }

  setDebugVisible(on) {
    if (on && !this._debug) this.debugDraw(World.scene);
    if (this._debug) this._debug.visible = !!on;
  }
}

export { NavMesh };

// Toggle the debug draw from the console / harness: `cv.nav_draw = 1`
World.on?.('cvar', (e) => { if (e?.name === 'nav_draw') World.nav?.setDebugVisible?.(!!e.value); });
