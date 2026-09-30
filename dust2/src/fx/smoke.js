// Smoke grenades: voxel flood fill + lit, sorted billboard volume.
//
// 1. Flood fill: an any-angle Dijkstra (Theta*-style: each voxel remembers the farthest
//    ancestor it can see) over a 20u voxel grid, through open space only
//    (pointContents + short traces between voxel centres), until a volume budget is spent.
//    In the open this yields a ~150u-radius dome; in a corridor the same volume flows
//    along it; it rounds corners and never leaks through walls.
// 2. One billboard per 2x2x2 voxel block, flying out from its anchor as the front passes.
// 3. Lighting: per particle, optical depth to the sun through the voxel density
//    (self-shadow) plus a world shadow trace; per pixel, the puff's normal map.
// 4. smokeOcclusion(a, b) integrates the same voxel density along a segment.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { shared, sunDirW, ambientAvg } from './lighting.js';
import { SMOKE_VERT, SMOKE_FRAG, FOG_VERT, FOG_FRAG } from './shaders/smoke.js';
import { queueRange } from './util.js';

export const SMOKE = {
  CELL: 20, GX: 48, GY: 18, GZ: 48,
  BUDGET: 760,          // voxels (~ volume of a 150u-radius dome)
  MAXDIST: 330,         // path length cap (corridors)
  HEIGHT: 150,          // max height above the detonation ground
  HOLD: 15.2,           // seconds until dissipation starts
  LIFE: 18.2,
  PER: 160,             // max billboards per volume
  MAX: 5,               // simultaneous smokes
  POPS: 48,             // flood-fill expansions per update (deterministic)
  MFP: 30,              // mean free path (u) at full density, for occlusion
};
const { CELL, GX, GY, GZ } = SMOKE;
const NCELL = GX * GY * GZ;
const CX = GX >> 1, CY = GY >> 1, CZ = GZ >> 1;
const NCOARSE = CX * CY * CZ;
const MASK_VISIBLE = 1;
const DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];

function hash1(i) { let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n >= this.k.length) return;
    let i = this.n++;
    const k = this.k, v = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const n = --this.n;
    if (n > 0) {
      const key = k[n], val = v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = key; v[i] = val;
    }
    return top;
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export class SmokeVolume {
  constructor(sys, index) {
    this.sys = sys;
    this.index = index;
    this.state = new Uint8Array(NCELL);   // 0 unknown, 1 candidate, 2 filled, 3 blocked
    this.dist = new Float32Array(NCELL);
    this.anchor = new Int32Array(NCELL);
    this.coarse = new Uint8Array(NCOARSE);
    this.heap = new Heap(NCELL);
    this.filled = new Int32Array(SMOKE.BUDGET + 8);
    this.pslots = new Int32Array(SMOKE.PER);
    this.pcell = new Int32Array(SMOKE.PER);
    this.pos = new THREE.Vector3();
    this.origin = new THREE.Vector3();
    this.src = new THREE.Vector3();
    this.active = false;
    this.nfilled = 0; this.np = 0; this.maxD = 1; this.t0 = 0; this.groundY = 0;
    this.done = false; this.lit = false;
    this.radius = 0;
  }

  get alive() { return this.active; }
  get endTime() { return this.t0 + SMOKE.LIFE; }

  start(pos, now, rand) {
    this.active = true; this.done = false; this.lit = false;
    this.t0 = now; this.nfilled = 0; this.np = 0; this.maxD = 1; this.radius = CELL;
    this.rand = rand;
    this.state.fill(0); this.coarse.fill(0); this.heap.clear();
    this.pos.copy(pos);
    const col = World.collision;
    // ground under the grenade
    this.groundY = pos.y - 2;
    if (col) {
      _a.copy(pos).setY(pos.y + 4); _b.copy(pos).setY(pos.y - 160);
      const tr = col.rayTrace(_a, _b, MASK_VISIBLE);
      if (tr.fraction < 1) this.groundY = tr.endpos.y;
    }
    this.origin.set(pos.x - (GX / 2 + 0.5) * CELL, this.groundY - CELL, pos.z - (GZ / 2 + 0.5) * CELL);
    let si = GX >> 1, sj = 1, sk = GZ >> 1;
    sj = Math.max(1, Math.min(GY - 1, Math.floor((pos.y + 6 - this.origin.y) / CELL)));
    // source must be open: climb until it is
    let s = this.idx(si, sj, sk);
    for (let tries = 0; tries < 4 && col && this.blockedAt(s); tries++) { sj++; s = this.idx(si, sj, sk); }
    this.cellCenter(s, this.src);
    this.dist[s] = 0; this.anchor[s] = -1; this.state[s] = 1;
    this.heap.push(0, s);
  }

  idx(i, j, k) { return (j * GZ + k) * GX + i; }
  cellCenter(c, out) {
    const i = c % GX, k = ((c / GX) | 0) % GZ, j = (c / (GX * GZ)) | 0;
    return out.set(this.origin.x + (i + 0.5) * CELL, this.origin.y + (j + 0.5) * CELL, this.origin.z + (k + 0.5) * CELL);
  }
  blockedAt(c) {
    const col = World.collision;
    if (!col) return false;
    this.cellCenter(c, _d);
    return (col.pointContents(_d) & MASK_VISIBLE) !== 0;
  }
  metric(ax, ay, az, bx, by, bz) {
    const dx = ax - bx, dy = (ay - by) * 1.25, dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  revealT(d) { return this.t0 + 0.06 + 1.05 * Math.pow(d / 200, 1.15); }
  fadeT(d, c) { return this.t0 + SMOKE.HOLD + (1 - Math.min(1, d / this.maxD)) * 1.4 + hash1(c) * 0.7; }

  /** Run up to n flood-fill expansions. */
  expand(n) {
    if (this.done) return;
    const col = World.collision;
    const heap = this.heap, st = this.state, dist = this.dist, anc = this.anchor;
    for (let it = 0; it < n; it++) {
      if (heap.n === 0 || this.nfilled >= SMOKE.BUDGET) { this.finish(); return; }
      const c = heap.pop();
      if (st[c] === 2) continue;
      st[c] = 2;
      this.filled[this.nfilled++] = c;
      const dc = dist[c];
      if (dc > this.maxD) this.maxD = dc;
      this.onFilled(c, dc);
      const i = c % GX, k = ((c / GX) | 0) % GZ, j = (c / (GX * GZ)) | 0;
      this.cellCenter(c, _a);
      const an = anc[c];
      if (an >= 0) this.cellCenter(an, _c); else _c.copy(this.src);
      const ad = an >= 0 ? dist[an] : 0;
      for (let q = 0; q < 6; q++) {
        const ni = i + DIRS[q * 3], nj = j + DIRS[q * 3 + 1], nk = k + DIRS[q * 3 + 2];
        if (ni < 0 || nj < 0 || nk < 0 || ni >= GX || nj >= GY || nk >= GZ) continue;
        const nc = this.idx(ni, nj, nk);
        const s = st[nc];
        if (s === 2 || s === 3) continue;
        this.cellCenter(nc, _b);
        if (_b.y - this.groundY > SMOKE.HEIGHT) { st[nc] = 3; continue; }
        if (s === 0 && col && (col.pointContents(_b) & MASK_VISIBLE)) { st[nc] = 3; continue; }
        let nd, na;
        // any-angle: straight from our anchor if it can see the neighbour
        const los = !col || col.rayTrace(_c, _b, MASK_VISIBLE).fraction >= 1;
        if (los) { nd = ad + this.metric(_b.x, _b.y, _b.z, _c.x, _c.y, _c.z); na = an; }
        else {
          if (col && col.rayTrace(_a, _b, MASK_VISIBLE).fraction < 1) continue; // wall between voxels
          nd = dc + this.metric(_b.x, _b.y, _b.z, _a.x, _a.y, _a.z); na = c;
        }
        if (nd > SMOKE.MAXDIST) continue;
        if (s === 0 || nd < dist[nc]) {
          dist[nc] = nd; anc[nc] = na; st[nc] = 1;
          heap.push(nd, nc);
        }
      }
    }
  }

  onFilled(c, d) {
    const i = c % GX, k = ((c / GX) | 0) % GZ, j = (c / (GX * GZ)) | 0;
    const cc = ((j >> 1) * CZ + (k >> 1)) * CX + (i >> 1);
    if (this.coarse[cc] || this.np >= SMOKE.PER) return;
    this.coarse[cc] = 1;
    const r = this.rand;
    const p = this.np++;
    this.pcell[p] = c;
    const an = this.anchor[c];
    this.cellCenter(c, _a);
    _a.x += (r() - 0.5) * 14; _a.y += (r() - 0.5) * 10; _a.z += (r() - 0.5) * 14;
    if (an >= 0) this.cellCenter(an, _b); else _b.copy(this.src);
    const reveal = this.revealT(d) - 0.22;
    // provisional fade (refined in finish() once maxD is known)
    const fade = this.t0 + SMOKE.HOLD + hash1(c) * 0.7;
    const size = 46 + r() * 16;
    this.pslots[p] = this.sys.writeParticle(this.index * SMOKE.PER + p, _a, reveal, _b, fade,
      size, r() * 6.283, (r() - 0.5) * 0.08, r(), 0.8, 0.85, 0.82 + r() * 0.18, this.groundY);
    this.radius = Math.max(this.radius, _a.distanceTo(this.pos) + size);
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.relight();
    this.sys.onVolumeFilled?.(this);
  }

  /** Per-particle lighting: voxel self-shadow toward the sun + world shadow + ambient occlusion. */
  relight() {
    const col = World.collision;
    for (let p = 0; p < this.np; p++) {
      const c = this.pcell[p];
      this.cellCenter(c, _a);
      // optical depth toward the sun
      let tau = 0;
      for (let s = 1; s <= 10; s++) {
        _b.copy(_a).addScaledVector(sunDirW, s * CELL);
        if (this.filledAt(_b)) tau += 1;
      }
      let sun = Math.exp(-tau * 0.5);
      if (col) {
        _b.copy(_a).addScaledVector(sunDirW, 3000);
        if (col.rayTrace(_a, _b, MASK_VISIBLE).fraction < 1) sun *= 0.1;
      }
      // occupancy around (ambient occlusion)
      const i = c % GX, k = ((c / GX) | 0) % GZ, j = (c / (GX * GZ)) | 0;
      let occ = 0, tot = 0;
      for (let dj = -2; dj <= 2; dj += 1) for (let dk = -2; dk <= 2; dk += 2) for (let di = -2; di <= 2; di += 2) {
        const ni = i + di, nj = j + dj, nk = k + dk;
        tot++;
        if (ni < 0 || nj < 0 || nk < 0 || ni >= GX || nj >= GY || nk >= GZ) continue;
        if (this.state[this.idx(ni, nj, nk)] === 2) occ++;
      }
      // occupancy + ground occlusion: the underside of the cloud sees less sky
      const hf = Math.min(1, Math.max(0, (_a.y - this.groundY) / 120));
      const amb = (1 - 0.5 * Math.pow(occ / tot, 1.3)) * (0.62 + 0.38 * hf);
      const d = this.dist[c];
      this.sys.updateParticleLight(this.pslots[p], sun, amb, this.fadeT(d, c));
    }
    this.lit = true;
  }

  cellAt(p) {
    const i = Math.floor((p.x - this.origin.x) / CELL), j = Math.floor((p.y - this.origin.y) / CELL), k = Math.floor((p.z - this.origin.z) / CELL);
    if (i < 0 || j < 0 || k < 0 || i >= GX || j >= GY || k >= GZ) return -1;
    return this.idx(i, j, k);
  }
  filledAt(p) { const c = this.cellAt(p); return c >= 0 && this.state[c] === 2; }

  /** 0..1 density of one voxel at time t. */
  cellDensity(c, t) {
    if (c < 0 || this.state[c] !== 2) return 0;
    const d = this.dist[c];
    const r = this.revealT(d);
    const f = this.fadeT(d, c);
    return smooth(r, r + 0.45, t) * (1 - smooth(f, f + 1.8, t)) * this.sys.blastFactor(this.cellCenter(c, _d), t);
  }

  /** Trilinear density at a point. */
  density(p, t = this.sys.now) {
    if (!this.active) return 0;
    const fx = (p.x - this.origin.x) / CELL - 0.5, fy = (p.y - this.origin.y) / CELL - 0.5, fz = (p.z - this.origin.z) / CELL - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    let s = 0;
    for (let q = 0; q < 8; q++) {
      const i = i0 + (q & 1), j = j0 + ((q >> 1) & 1), k = k0 + ((q >> 2) & 1);
      if (i < 0 || j < 0 || k < 0 || i >= GX || j >= GY || k >= GZ) continue;
      const w = ((q & 1) ? tx : 1 - tx) * (((q >> 1) & 1) ? ty : 1 - ty) * (((q >> 2) & 1) ? tz : 1 - tz);
      if (w > 0) s += w * this.cellDensity(this.idx(i, j, k), t);
    }
    return s;
  }

  /** Optical depth along a segment (in mean free paths). */
  opticalDepth(a, b, t) {
    // segment vs bounding sphere
    const R = this.radius + CELL;
    _a.subVectors(b, a);
    const L = _a.length();
    if (L < 1e-3) return 0;
    _a.multiplyScalar(1 / L);
    _b.subVectors(this.pos, a);
    const tc = _b.dot(_a);
    const d2 = _b.lengthSq() - tc * tc;
    if (d2 > R * R) return 0;
    const h = Math.sqrt(R * R - d2);
    const s0 = Math.max(0, tc - h), s1 = Math.min(L, tc + h);
    if (s1 <= s0) return 0;
    const step = 10;
    let tau = 0;
    for (let s = s0 + step * 0.5; s < s1; s += step) {
      _c.copy(a).addScaledVector(_a, s);
      const c = this.cellAt(_c);
      if (c >= 0 && this.state[c] === 2) tau += this.cellDensity(c, t) * step;
    }
    return tau / SMOKE.MFP;
  }

  kill() {
    this.active = false;
    for (let p = 0; p < this.np; p++) this.sys.killParticle(this.pslots[p]);
    this.np = 0;
  }
}

export class SmokeSystem {
  constructor(scene, atlas) {
    this.now = 0;
    this.cap = SMOKE.MAX * SMOKE.PER;
    const V = this.cap * 4;
    this.s0 = new Float32Array(V * 4); this.s1 = new Float32Array(V * 4);
    this.s2 = new Float32Array(V * 4); this.s3 = new Float32Array(V * 4);
    const corner = new Float32Array(V * 2);
    const CRN = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < this.cap; i++) for (let v = 0; v < 8; v++) corner[i * 8 + v] = CRN[v];
    // park all particles in the future so they are culled
    for (let i = 0; i < V; i++) this.s0[i * 4 + 3] = 1e9;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    this.a = [this.s0, this.s1, this.s2, this.s3].map((arr, i) => {
      const at = new THREE.BufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('s' + i, at);
      return at;
    });
    this.index = new THREE.BufferAttribute(new Uint16Array(this.cap * 6), 1).setUsage(THREE.DynamicDrawUsage);
    g.setIndex(this.index);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = g;
    this.blasts = [new THREE.Vector4(0, 0, 0, -99), new THREE.Vector4(0, 0, 0, -99), new THREE.Vector4(0, 0, 0, -99), new THREE.Vector4(0, 0, 0, -99)];
    this.blastHead = 0;
    const size = atlas?.image?.width || 2048;
    this.uniforms = {
      uTime: shared.uTime,
      uAtlas: { value: atlas }, uAtlasTexel: { value: 1 / size },
      uBlast: { value: this.blasts },
      uCamWorld: { value: new THREE.Matrix4() },
      uSunDirV: { value: new THREE.Vector3() },
      uSunCol: shared.uSunCol, uSkyCol: shared.uSkyCol, uGroundCol: shared.uGroundCol,
      uAlbedo: { value: new THREE.Vector3(0.6, 0.6, 0.59) },
      uDepth: shared.uDepth, uHasDepth: shared.uHasDepth, uDepthRes: shared.uDepthRes, uNearFar: shared.uNearFar,
      uNearFade: { value: new THREE.Vector2(10, 70) },
      ...THREE.UniformsLib.fog,
    };
    this.material = new THREE.ShaderMaterial({
      name: 'fx-smoke', uniforms: this.uniforms, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-smoke';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.userData.fx = true;
    this.mesh.layers.enable(5);
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.uniforms.uSunDirV.value.copy(sunDirW).transformDirection(camera.matrixWorldInverse);
      this.uniforms.uCamWorld.value.copy(camera.matrixWorld);
      if (camera !== this._sortedFor) this.sort(camera);
    };
    scene?.add(this.mesh);

    // full-screen fog when the eye is inside a smoke
    this.fogUniforms = { uColor: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uTime: shared.uTime, uAspect: { value: 1.78 } };
    this.fog = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      name: 'fx-smoke-fog', uniforms: this.fogUniforms, vertexShader: FOG_VERT, fragmentShader: FOG_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.fog.frustumCulled = false;
    this.fog.renderOrder = 60;
    this.fog.visible = false;
    this.fog.userData.fx = true;
    scene?.add(this.fog);
    this.inside = 0;

    this.vols = [];
    for (let i = 0; i < SMOKE.MAX; i++) this.vols.push(new SmokeVolume(this, i));
    this.keys = new Float64Array(this.cap);
    this.vmin = Infinity; this.vmax = -1;
    this._sortedFor = null;
    this._camPos = new THREE.Vector3();
  }

  spawn(pos, now, rand) {
    let v = this.vols.find((x) => !x.active);
    if (!v) { v = this.vols.reduce((a, b) => (a.t0 < b.t0 ? a : b)); v.kill(); }
    v.start(pos, now, rand);
    return v;
  }

  writeParticle(slot, target, reveal, start, fade, size, rot, rotVel, seed, sun, amb, alpha, floorY) {
    for (let v = 0; v < 4; v++) {
      const o = (slot * 4 + v) * 4;
      this.s0[o] = target.x; this.s0[o + 1] = target.y; this.s0[o + 2] = target.z; this.s0[o + 3] = reveal;
      this.s1[o] = start.x; this.s1[o + 1] = start.y; this.s1[o + 2] = start.z; this.s1[o + 3] = fade;
      this.s2[o] = size; this.s2[o + 1] = rot; this.s2[o + 2] = rotVel; this.s2[o + 3] = seed;
      this.s3[o] = sun; this.s3[o + 1] = amb; this.s3[o + 2] = alpha; this.s3[o + 3] = floorY;
    }
    this.dirty(slot);
    return slot;
  }
  updateParticleLight(slot, sun, amb, fade) {
    for (let v = 0; v < 4; v++) {
      const o = (slot * 4 + v) * 4;
      this.s3[o] = sun; this.s3[o + 1] = amb; this.s1[o + 3] = fade;
    }
    this.dirty(slot);
  }
  killParticle(slot) {
    for (let v = 0; v < 4; v++) this.s0[(slot * 4 + v) * 4 + 3] = 1e9;
    this.dirty(slot);
  }
  dirty(slot) { if (slot < this.vmin) this.vmin = slot; if (slot > this.vmax) this.vmax = slot; }

  blast(pos, now) {
    const b = this.blasts[this.blastHead];
    this.blastHead = (this.blastHead + 1) % 4;
    b.set(pos.x, pos.y, pos.z, now);
  }
  blastFactor(p, t) {
    let f = 1;
    for (const b of this.blasts) {
      const bt = t - b.w;
      if (bt <= 0 || bt >= 5) continue;
      const dx = p.x - b.x, dy = p.y - b.y, dz = p.z - b.z;
      const infl = 1 - smooth(50, 230, Math.sqrt(dx * dx + dy * dy + dz * dz));
      f *= 1 - infl * 0.92 * (1 - smooth(1.2, 5, bt));
    }
    return f;
  }

  update(dt, now, camera) {
    this.now = now;
    for (const v of this.vols) {
      if (!v.active) continue;
      if (now > v.t0 + SMOKE.LIFE + 1) { v.kill(); continue; }
      if (!v.done) v.expand(SMOKE.POPS);
    }
    // eye inside smoke -> full-screen fog
    let dens = 0;
    if (camera) {
      this._camPos.setFromMatrixPosition(camera.matrixWorld);
      for (const v of this.vols) if (v.active) dens = 1 - (1 - dens) * (1 - Math.min(1, v.density(this._camPos, now)));
    }
    const target = smooth(0.12, 0.8, dens);
    this.inside += (target - this.inside) * Math.min(1, dt * 14);
    this.fog.visible = this.inside > 0.005;
    if (this.fog.visible) {
      const U = this.uniforms;
      ambientAvg(this.fogUniforms.uColor.value).addScaledVector(shared.uSunCol.value, 0.22).multiply(U.uAlbedo.value).multiplyScalar(1 / Math.PI);
      this.fogUniforms.uAlpha.value = this.inside;
      if (camera?.aspect) this.fogUniforms.uAspect.value = camera.aspect;
    }
    this._sortedFor = null;
  }

  /** Back-to-front sort of live billboards by distance to the eye; rewrites the index buffer. */
  sort(camera) {
    this._sortedFor = camera;
    const cp = _d.setFromMatrixPosition(camera.matrixWorld);
    const keys = this.keys;
    let n = 0;
    const now = this.now;
    for (const v of this.vols) {
      if (!v.active) continue;
      for (let p = 0; p < v.np; p++) {
        const slot = v.pslots[p];
        const o = slot * 16;
        if (this.s0[o + 3] > now + 0.05) continue;
        const dx = this.s0[o] - cp.x, dy = this.s0[o + 1] - cp.y, dz = this.s0[o + 2] - cp.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        keys[n++] = Math.floor(Math.min(d, 60000) * 8) * 1024 + slot;
      }
    }
    for (let i = n; i < keys.length; i++) keys[i] = Infinity;
    keys.sort();
    const idx = this.index.array;
    for (let i = 0; i < n; i++) {
      const slot = keys[n - 1 - i] % 1024;
      const b = slot * 4, o = i * 6;
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
    }
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, Math.max(6, n * 6));
    this.index.needsUpdate = true;
    this.geo.setDrawRange(0, n * 6);
  }

  flush() {
    if (this.vmax < 0) return;
    const a = this.vmin * 16, c = (this.vmax - this.vmin + 1) * 16;
    for (const at of this.a) queueRange(at, a, c);
    this.vmin = Infinity; this.vmax = -1;
  }

  opticalDepth(a, b, t = this.now) {
    let tau = 0;
    for (const v of this.vols) if (v.active) tau += v.opticalDepth(a, b, t);
    return tau;
  }
  densityAt(p, t = this.now) {
    let d = 0;
    for (const v of this.vols) if (v.active) d = Math.max(d, v.density(p, t));
    return d;
  }
  clear() { for (const v of this.vols) if (v.active) v.kill(); this.inside = 0; this.fog.visible = false; }
}
