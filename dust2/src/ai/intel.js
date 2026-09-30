// Map intelligence derived from the nav graph: attack routes, chokes, staging spots, CT holds.
//
// Nothing here is hand-placed. For each bombsite we find several genuinely different T
// approaches (A* again and again with the previous corridors penalised — on Dust II this falls
// out as long / short(cat) for A and tunnels / mid-to-B for B), then derive:
//   entry   — where the route comes into view of the site (the choke CTs watch)
//   staging — a spot back along the route, hidden from the site, where Ts gather before a hit
//   holds   — CT positions with cover that see the entry (these are also the "common angles"
//             attacking Ts pre-aim)
// plus CT routes from CT spawn (retakes, rotations) and a mid hold where A/B routes split.
// Work is a generator so the manager can spread it over ticks during freeze time.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { MASK_VISIBLE } from '../player/collision.js';
import { rng } from '../core/mathx.js';

const EYE = 64;
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class MapIntel {
  constructor(nav, map) {
    this.nav = nav;
    this.map = map;
    this.ready = false;
    this.sites = {};
    this.mid = null;
    this.tSpawn = avgSpawn(map?.spawns?.T);
    this.ctSpawn = avgSpawn(map?.spawns?.CT);
    this._it = null;
    this.rnd = rng(1337);
    this.bakeMs = 0;
  }

  get cw() { return World.collision || this.map?.collision; }

  /** Run up to `budgetMs` of baking. Returns true when done. */
  step(budgetMs = 2) {
    if (this.ready) return true;
    if (!this.nav?.count) { this.ready = true; return true; }
    if (!this._it) this._it = this._bake();
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (this._it.next().done) { this.ready = true; this.bakeMs += performance.now() - t0; return true; }
    }
    this.bakeMs += performance.now() - t0;
    return false;
  }

  ensure() { while (!this.step(50)); return this; }

  los(a, b) { return this.cw.rayTrace(a, b, MASK_VISIBLE).fraction >= 1; }

  *_bake() {
    const nav = this.nav;
    const sites = this.map?.bombsites || {};
    const tNode = this.tSpawn ? nav.nearest(this.tSpawn) : -1;
    const ctNode = this.ctSpawn ? nav.nearest(this.ctSpawn) : -1;
    for (const [name, zone] of Object.entries(sites)) {
      const center = new THREE.Vector3().addVectors(zone.min, zone.max).multiplyScalar(0.5);
      center.y = zone.min.y;
      const s = { name, zone, center, node: siteNode(nav, zone, center), radius: 0.5 * Math.hypot(zone.max.x - zone.min.x, zone.max.z - zone.min.z) };
      if (s.node >= 0) nav.pos(s.node, s.center);
      s.eye = s.center.clone(); s.eye.y += EYE;
      s.plant = plantSpots(nav, zone, this.rnd);
      s.tRoutes = tNode >= 0 && s.node >= 0 ? yield* this._routes(tNode, s, 2, 'T') : [];
      s.ctRoutes = ctNode >= 0 && s.node >= 0 ? yield* this._routes(ctNode, s, 2, 'CT') : [];
      this.sites[name] = s;
      yield;
    }
    // entries / staging / holds for every T route
    for (const s of Object.values(this.sites)) {
      for (const r of s.tRoutes) {
        this._entryAndStaging(s, r);
        yield;
        r.holds = yield* this._holds(s, r);
      }
      for (const r of s.ctRoutes) this._entryAndStaging(s, r);
      yield;
    }
    this.mid = yield* this._midHold();
  }

  /** Several different routes from `from` node to site s. */
  *_routes(from, s, k, team) {
    const nav = this.nav, n = nav.count;
    const cost = new Float32Array(n);
    const near = new Uint8Array(n);
    const out = [];
    let len0 = 0;
    for (let i = 0; i < k + 2 && out.length < k; i++) {
      const nodes = nav.astar(from, s.node, { nodeCost: i ? cost : null, weight: 1.0 });
      yield;
      if (!nodes) break;
      const len = nav.pathLength(nodes);
      if (!out.length) len0 = len;
      else {
        if (len > len0 * 1.6 + 300) break;
        // overlap in the middle/late part of the route
        let ov = 0, cnt = 0;
        for (let j = Math.floor(nodes.length * 0.3); j < Math.floor(nodes.length * 0.92); j++) { cnt++; if (near[nodes[j]]) ov++; }
        if (cnt && ov / cnt > 0.4) { penalise(nav, nodes, cost, near, 0.2, 0.95, 90); continue; }
      }
      const r = { site: s.name, team, nodes: Int32Array.from(nodes), length: len, areas: routeAreas(nav, nodes), idx: out.length };
      r.name = r.areas.filter((a) => a && !/spawn/i.test(a)).slice(0, 3).join('>') || `${team}${s.name}${out.length}`;
      out.push(r);
      penalise(nav, nodes, cost, near, 0.2, 0.95, 90);
    }
    return out;
  }

  // entry: first route node (walking outward from the site) beyond site radius that is still
  // in view of the site. staging: further back, out of view.
  _entryAndStaging(s, r) {
    const nav = this.nav, nodes = r.nodes, cw = this.cw;
    const dist = new Float32Array(nodes.length);          // route distance to the site end
    for (let i = nodes.length - 2; i >= 0; i--) dist[i] = dist[i + 1] + Math.hypot(nav.px[nodes[i]] - nav.px[nodes[i + 1]], nav.pz[nodes[i]] - nav.pz[nodes[i + 1]]);
    r.dist = dist;
    let entry = nodes.length - 1;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (dist[i] > s.radius + 1800) break;
      const k = nodes[i];
      _b.set(nav.px[k], nav.py[k] + EYE, nav.pz[k]);
      if (dist[i] >= s.radius * 0.6 && cw.rayTrace(s.eye, _b, MASK_VISIBLE).fraction >= 1) entry = i;
      else if (dist[i] > s.radius + 300 && entry !== nodes.length - 1) break;
    }
    // walk the entry forward until it's actually a choke: fall back to a fixed distance when
    // the site is visible from a long way (e.g. long A)
    r.entryIdx = entry;
    r.entry = nav.pos(nodes[entry]);
    r.entryEye = r.entry.clone(); r.entryEye.y += EYE;
    // stage on our own half of the map (Ts don't camp in CT mid waiting for a mid-to-B hit)
    const own = r.team === 'CT' ? this.ctSpawn : this.tSpawn, other = r.team === 'CT' ? this.tSpawn : this.ctSpawn;
    const ownSide = (k) => !own || !other || Math.hypot(nav.px[k] - own.x, nav.pz[k] - own.z) < Math.hypot(nav.px[k] - other.x, nav.pz[k] - other.z) * 1.05;
    let stage = -1, firstOwn = -1;
    for (let i = entry; i >= 0; i--) {
      if (dist[i] < dist[entry] + 250) continue;
      if (dist[i] > dist[entry] + 2600) break;
      const k = nodes[i];
      if (!ownSide(k)) continue;
      if (firstOwn < 0) firstOwn = i;
      _b.set(nav.px[k], nav.py[k] + EYE, nav.pz[k]);
      if (cw.rayTrace(s.eye, _b, MASK_VISIBLE).fraction < 1 && cw.rayTrace(r.entryEye, _b, MASK_VISIBLE).fraction < 1) { stage = i; break; }
    }
    if (stage < 0) stage = firstOwn;
    if (stage < 0) { stage = entry; while (stage > 0 && dist[stage] < dist[entry] + 500) stage--; }
    r.stageIdx = stage;
    r.stage = nav.pos(nodes[stage]);
  }

  /** CT spots with cover that watch route r's entry from the site side. */
  *_holds(s, r) {
    const nav = this.nav, cw = this.cw;
    // sample the approach: a few route points around the entry, on the attacker side
    const probes = [];
    for (let i = r.entryIdx; i >= 0 && probes.length < 4; i -= 3) {
      if (r.dist[i] > r.dist[r.entryIdx] + 400) break;
      const k = r.nodes[i];
      probes.push(new THREE.Vector3(nav.px[k], nav.py[k] + EYE, nav.pz[k]));
    }
    if (!probes.length) return [];
    const onRoute = new Uint8Array(nav.count);
    for (const k of r.nodes) onRoute[k] = 1;
    // candidates: nodes around the site and between it and the entry
    const cand = [];
    const R = s.radius + 700;
    const c0 = nav.colOf(s.center.x, s.center.z);
    if (c0 < 0) return [];
    const cx = c0 % nav.nx, cz = (c0 / nav.nx) | 0, CR = Math.ceil(R / 24);
    for (let dz = -CR; dz <= CR; dz += 2) for (let dx = -CR; dx <= CR; dx += 2) {
      const jx = cx + dx, jz = cz + dz;
      if (jx < 0 || jz < 0 || jx >= nav.nx || jz >= nav.nz) continue;
      const c = jx + jz * nav.nx;
      for (let k = nav.colStart[c]; k < nav.colStart[c + 1]; k++) {
        if (onRoute[k] || !nav.solidSpot(k)) continue;
        const d = Math.hypot(nav.px[k] - s.center.x, nav.pz[k] - s.center.z);
        if (d > R) continue;
        const de = Math.hypot(nav.px[k] - r.entry.x, nav.pz[k] - r.entry.z);
        if (de < 350 || de > 1700) continue;
        cand.push(k);
      }
    }
    // random subsample to bound the ray budget
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(this.rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    cand.length = Math.min(cand.length, 90);
    yield;
    const scored = [];
    for (let ci = 0; ci < cand.length; ci++) {
      const k = cand[ci];
      _a.set(nav.px[k], nav.py[k] + EYE, nav.pz[k]);
      let vis = 0;
      for (const p of probes) if (cw.rayTrace(_a, p, MASK_VISIBLE).fraction >= 1) vis++;
      if (!vis || cw.rayTrace(_a, probes[0], MASK_VISIBLE).fraction < 1) continue;
      const de = Math.hypot(nav.px[k] - r.entry.x, nav.pz[k] - r.entry.z);
      let score = vis / probes.length;
      score += nav.clear[k] === 0 ? 0.6 : nav.clear[k] === 1 ? 0.3 : 0;   // near cover
      score += de > 450 && de < 1300 ? 0.4 : 0;
      score += Math.hypot(nav.px[k] - s.center.x, nav.pz[k] - s.center.z) < s.radius + 150 ? 0.3 : 0; // on site
      score += this.rnd() * 0.25;
      scored.push({ k, score });
      if ((ci & 15) === 15) yield;
    }
    scored.sort((a, b) => b.score - a.score);
    const holds = [];
    for (const { k, score } of scored) {
      if (holds.some((h) => Math.hypot(h.pos.x - nav.px[k], h.pos.z - nav.pz[k]) < 160)) continue;
      const pos = nav.pos(k);
      holds.push({ pos, node: k, look: r.entryEye.clone(), site: s.name, route: r.idx, score, eye: new THREE.Vector3(pos.x, pos.y + EYE, pos.z) });
      if (holds.length >= 4) break;
    }
    return holds;
  }

  /** Where the first A route and first B route that share a prefix split — the mid fight. */
  *_midHold() {
    const nav = this.nav, cw = this.cw;
    const names = Object.keys(this.sites);
    if (names.length < 2) return null;
    let best = null;
    for (const ra of this.sites[names[0]].tRoutes) for (const rb of this.sites[names[1]].tRoutes) {
      let i = 0;
      const setB = new Set(rb.nodes);
      for (let j = 0; j < ra.nodes.length; j++) if (setB.has(ra.nodes[j])) i = j;
      const frac = i / ra.nodes.length;
      if (frac < 0.25 || frac > 0.85) continue;
      if (!best || frac > best.frac) best = { frac, node: ra.nodes[i] };
    }
    yield;
    if (!best) return null;
    const split = nav.pos(best.node); const splitEye = split.clone(); splitEye.y += EYE;
    // CT-side spot watching the split: closer to CT spawn than the split, with LOS and cover
    const cand = [];
    for (let t = 0; t < 400 && cand.length < 60; t++) {
      const k = (this.rnd() * nav.count) | 0;
      const d = Math.hypot(nav.px[k] - split.x, nav.pz[k] - split.z);
      if (d < 400 || d > 1500) continue;
      if (this.ctSpawn && this.tSpawn) {
        const dct = Math.hypot(nav.px[k] - this.ctSpawn.x, nav.pz[k] - this.ctSpawn.z);
        const dt = Math.hypot(nav.px[k] - this.tSpawn.x, nav.pz[k] - this.tSpawn.z);
        if (dct > dt) continue;
      }
      cand.push(k);
    }
    let bk = -1, bs = -1;
    for (const k of cand) {
      if (!nav.solidSpot(k)) continue;
      _a.set(nav.px[k], nav.py[k] + EYE, nav.pz[k]);
      if (cw.rayTrace(_a, splitEye, MASK_VISIBLE).fraction < 1) continue;
      const sc = (nav.clear[k] === 0 ? 1 : 0.5) + this.rnd() * 0.3;
      if (sc > bs) { bs = sc; bk = k; }
    }
    yield;
    if (bk < 0) return { split, splitEye, hold: null };
    const pos = nav.pos(bk);
    return { split, splitEye, hold: { pos, node: bk, look: splitEye.clone(), site: 'mid', eye: new THREE.Vector3(pos.x, pos.y + EYE, pos.z) } };
  }

  /** Debug overlay: T routes (A orange / B cyan), CT routes (blue), holds (+), staging (o). */
  debugObject() {
    const nav = this.nav, g = new THREE.Group();
    g.name = 'intel_debug';
    const lines = (pts, color, width = 1) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95, linewidth: width }));
      l.renderOrder = 10; l.frustumCulled = false;
      g.add(l);
    };
    const mark = (p, color, size = 40) => {
      const pts = [new THREE.Vector3(p.x - size, p.y + 8, p.z), new THREE.Vector3(p.x + size, p.y + 8, p.z),
        new THREE.Vector3(p.x, p.y + 8, p.z - size), new THREE.Vector3(p.x, p.y + 8, p.z + size)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 11; l.frustumCulled = false;
      g.add(l);
    };
    const siteCol = { A: 0xff9a2a, B: 0x2ae0ff };
    for (const s of Object.values(this.sites)) {
      for (const r of s.tRoutes) {
        const pts = [];
        for (let i = 0; i < r.nodes.length; i += 2) pts.push(new THREE.Vector3(nav.px[r.nodes[i]], nav.py[r.nodes[i]] + 10 + r.idx * 4, nav.pz[r.nodes[i]]));
        lines(pts, siteCol[s.name] ?? 0xffffff);
        if (r.stage) mark(r.stage, 0xffff00, 30);
        if (r.entry) mark(r.entry, 0xff2020, 24);
        for (const h of r.holds || []) mark(h.pos, 0x3070ff, 36);
      }
      for (const r of s.ctRoutes) {
        const pts = [];
        for (let i = 0; i < r.nodes.length; i += 2) pts.push(new THREE.Vector3(nav.px[r.nodes[i]], nav.py[r.nodes[i]] + 12, nav.pz[r.nodes[i]]));
        lines(pts, 0x4060ff);
      }
      for (const p of s.plant) mark(p, 0xff40ff, 18);
    }
    if (this.mid?.hold) mark(this.mid.hold.pos, 0x3070ff, 36);
    return g;
  }

  // ---- runtime helpers ----------------------------------------------------------------

  siteAt(pos, pad = 0) {
    for (const s of Object.values(this.sites)) {
      const z = s.zone;
      if (pos.x >= z.min.x - pad && pos.x <= z.max.x + pad && pos.z >= z.min.z - pad && pos.z <= z.max.z + pad &&
          pos.y >= z.min.y - 64 && pos.y <= z.max.y + 64) return s;
    }
    return null;
  }

  /** Nearest site by straight distance. */
  nearestSite(pos) {
    let best = null, bd = Infinity;
    for (const s of Object.values(this.sites)) { const d = s.center.distanceToSquared(pos); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  /** Index along route r nearest to pos (optionally only at/after `minIdx`). */
  routeIndexNear(r, pos, minIdx = 0) {
    const nav = this.nav;
    let bi = minIdx, bd = Infinity;
    for (let i = minIdx; i < r.nodes.length; i += 2) {
      const k = r.nodes[i];
      const d = (nav.px[k] - pos.x) ** 2 + (nav.pz[k] - pos.z) ** 2 + ((nav.py[k] - pos.y) * 2) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  /** Path that joins route r near `pos` and follows it up to toIdx. Node list or null. */
  routeNodes(r, pos, toIdx) {
    const nav = this.nav;
    toIdx = Math.min(toIdx ?? r.nodes.length - 1, r.nodes.length - 1);
    const start = nav.nearestReachable(pos);
    if (start < 0) return null;
    // join the route at the nearest index not past the target, a bit ahead so we don't backtrack
    let j = this.routeIndexNear(r, pos, 0);
    j = Math.min(toIdx, j + 3);
    const lead = nav.astar(start, r.nodes[j], { maxExpand: 20000 });
    if (!lead) return null;
    const out = lead;
    for (let i = j + 1; i <= toIdx; i++) out.push(r.nodes[i]);
    return out;
  }

  /** Cover spots near `near` that still see `watch` (post-plant / retake angles). */
  watchSpots(watchEye, near, rMin = 250, rMax = 900, max = 5) {
    const nav = this.nav, cw = this.cw, res = [];
    for (let t = 0; t < 160 && res.length < max; t++) {
      const ang = this.rnd() * Math.PI * 2, rad = rMin + this.rnd() * (rMax - rMin);
      const k = nav.nearest(_a.set(near.x + Math.cos(ang) * rad, near.y, near.z + Math.sin(ang) * rad), 80);
      if (k < 0 || Math.abs(nav.py[k] - near.y) > 200 || !nav.solidSpot(k)) continue;
      if (nav.clear[k] > 1 && this.rnd() < 0.7) continue;
      _a.set(nav.px[k], nav.py[k] + EYE, nav.pz[k]);
      if (cw.rayTrace(_a, watchEye, MASK_VISIBLE).fraction < 1) continue;
      if (res.some((p) => Math.hypot(p.x - _a.x, p.z - _a.z) < 150)) continue;
      const v = nav.pos(k); v.n = k;
      res.push(v);
    }
    return res;
  }
}

// ---- helpers ------------------------------------------------------------------------------

function avgSpawn(list) {
  if (!list?.length) return null;
  const v = new THREE.Vector3();
  for (const s of list) v.add(s.pos);
  return v.multiplyScalar(1 / list.length);
}

function siteNode(nav, zone, center) {
  // prefer an open node inside the zone near its centre
  let best = -1, bs = -Infinity;
  const c0 = nav.colOf(center.x, center.z);
  const R = Math.ceil(Math.max(zone.max.x - zone.min.x, zone.max.z - zone.min.z) / 48) + 2;
  if (c0 < 0) return nav.nearest(center);
  const cx = c0 % nav.nx, cz = (c0 / nav.nx) | 0;
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const jx = cx + dx, jz = cz + dz;
    if (jx < 0 || jz < 0 || jx >= nav.nx || jz >= nav.nz) continue;
    const c = jx + jz * nav.nx;
    for (let k = nav.colStart[c]; k < nav.colStart[c + 1]; k++) {
      const x = nav.px[k], y = nav.py[k], z = nav.pz[k];
      if (x < zone.min.x || x > zone.max.x || z < zone.min.z || z > zone.max.z || y < zone.min.y - 48 || y > zone.max.y + 48) continue;
      const s = nav.clear[k] * 40 - Math.hypot(x - center.x, z - center.z);
      if (s > bs) { bs = s; best = k; }
    }
  }
  return best >= 0 ? best : nav.nearest(center);
}

function plantSpots(nav, zone, rnd) {
  const res = [];
  for (let t = 0; t < 200 && res.length < 8; t++) {
    const p = nav.randomPointIn(zone, new THREE.Vector3(), rnd);
    if (!p) continue;
    const k = nav.nearest(p);
    if (k < 0 || !nav.solidSpot(k) || (nav.clear[k] > 1 && rnd() < 0.8)) continue;
    // stay 32u inside the zone so the plant always registers
    if (p.x < zone.min.x + 32 || p.x > zone.max.x - 32 || p.z < zone.min.z + 32 || p.z > zone.max.z - 32) continue;
    if (res.some((q) => q.distanceTo(p) < 64)) continue;
    p.n = k;
    res.push(p);
  }
  if (!res.length) { const p = nav.randomPointIn(zone); if (p) res.push(p); }
  return res;
}

function penalise(nav, nodes, cost, near, f0, f1, amount) {
  const a = Math.floor(nodes.length * f0), b = Math.floor(nodes.length * f1);
  const gen = ++nav._gen;
  let frontier = [];
  for (let i = a; i < b; i++) { const k = nodes[i]; if (nav._seen[k] !== gen) { nav._seen[k] = gen; frontier.push(k); } }
  // spread the penalty ~200u out along walk links (never through walls) so the next route
  // takes a different corridor, not the lane next to this one
  for (let ring = 0; ring < 10; ring++) {
    const next = [];
    for (const k of frontier) {
      if (ring < 8) cost[k] += amount * (ring < 4 ? 1 : 0.5);
      near[k] = 1;
      for (let l = nav.linkStart[k]; l < nav.linkStart[k + 1]; l++) {
        const m = nav.linkTo[l];
        if (nav._seen[m] !== gen) { nav._seen[m] = gen; next.push(m); }
      }
    }
    frontier = next;
  }
}

function routeAreas(nav, nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i += 4) {
    const a = nav.areaOf(nodes[i]);
    if (a && out[out.length - 1] !== a) out.push(a);
  }
  return out;
}
