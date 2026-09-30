// Molotov / incendiary fire: spreads over the ground (~120u) following the floor (traces
// down per cell, blocked by walls), flame flipbook billboards, embers, a smoke column,
// a flickering heat light, burn decals. Extinguished by smoke.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { PF } from './particles.js';
import { SPR } from './atlas.js';
import { sunVisibility } from './util.js';

export const FIRE = { SPACING: 26, RADIUS: 125, MAXCELLS: 72, SPREAD_SPEED: 230, LIFE: 7.0, MAX: 4 };
const MASK = 1;
const NDX = [1, -1, 0, 0, 1, 1, -1, -1], NDZ = [0, 0, 1, -1, 1, -1, 1, -1];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();

export class FireVolume {
  constructor(sys) {
    this.sys = sys;
    this.cells = new Float32Array(FIRE.MAXCELLS * 4);   // x, y, z, ignite time
    this.acc = new Float32Array(FIRE.MAXCELLS);
    this.n = 0;
    this.active = false;
    this.pos = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.t0 = 0; this.tEnd = 0; this.extT = -1;
    this.radius = FIRE.RADIUS;
    this.smokeAcc = 0; this.emberAcc = 0;
    this.light = null;
    this.qx = new Int16Array(FIRE.MAXCELLS * 4); this.qz = new Int16Array(FIRE.MAXCELLS * 4);
  }
  get alive() { return this.active && this.extT < 0; }
  get endTime() { return this.tEnd; }

  /** Is p standing in the fire (xz within a burning cell, y close)? */
  contains(p, now = this.sys.fx.now) {
    if (!this.active) return false;
    const r = FIRE.SPACING * 0.75;
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      if (this.cells[o + 3] > now || !this.cellBurning(i, now)) continue;
      const dx = p.x - this.cells[o], dz = p.z - this.cells[o + 2], dy = p.y - this.cells[o + 1];
      if (dx * dx + dz * dz < r * r && dy > -20 && dy < 80) return true;
    }
    return false;
  }
  cellBurning(i, now) {
    if (this.extT >= 0) return now < this.extT + 0.25;
    const end = this.tEnd - (i * 0.37 % 1) * 1.1;
    return now >= this.cells[i * 4 + 3] && now < end;
  }

  start(pos, now, rand) {
    this.active = true; this.extT = -1;
    this.t0 = now; this.tEnd = now + FIRE.LIFE;
    this.pos.copy(pos);
    this.rand = rand;
    this.n = 0;
    const col = World.collision;
    // ground at the impact
    let gy = pos.y;
    if (col) {
      _a.copy(pos).setY(pos.y + 24); _b.copy(pos).setY(pos.y - 200);
      const tr = col.rayTrace(_a, _b, MASK);
      if (tr.fraction < 1) gy = tr.endpos.y;
    }
    // BFS over a square lattice following the ground
    const S = FIRE.SPACING;
    const vis = new Set();
    let qh = 0, qt = 0;
    const qy = [gy], qd = [0];
    this.qx[qt] = 0; this.qz[qt] = 0; qt++;
    vis.add(0);
    while (qh < qt && this.n < FIRE.MAXCELLS) {
      const ix = this.qx[qh], iz = this.qz[qh], y = qy[qh], d = qd[qh]; qh++;
      const x = pos.x + ix * S + (rand() - 0.5) * S * 0.5, z = pos.z + iz * S + (rand() - 0.5) * S * 0.5;
      const o = this.n * 4;
      this.cells[o] = x; this.cells[o + 1] = y; this.cells[o + 2] = z;
      this.cells[o + 3] = now + d / FIRE.SPREAD_SPEED + rand() * 0.08;
      this.acc[this.n] = rand() * 0.1;
      this.n++;
      for (let q = 0; q < 8; q++) {
        const dx = NDX[q], dz = NDZ[q];
        const nx = ix + dx, nz = iz + dz;
        const key = (nx + 64) * 256 + (nz + 64);
        if (vis.has(key)) continue;
        const step = q < 4 ? S : S * 1.414;
        const nd = d + step * (0.85 + rand() * 0.3);
        if (nd > FIRE.RADIUS || qt >= this.qx.length) continue;
        const cx = pos.x + nx * S, cz = pos.z + nz * S;
        let ny = y;
        if (col) {
          // wall between?
          _a.set(pos.x + ix * S, y + 12, pos.z + iz * S); _b.set(cx, y + 12, cz);
          if (col.rayTrace(_a, _b, MASK).fraction < 1) continue;
          // ground under the neighbour (allow small steps up/down)
          _a.set(cx, y + 30, cz); _b.set(cx, y - 60, cz);
          const tr = col.rayTrace(_a, _b, MASK);
          if (tr.fraction >= 1 || tr.normal.y < 0.6 || tr.startSolid) continue;
          ny = tr.endpos.y;
        }
        vis.add(key);
        this.qx[qt] = nx; this.qz[qt] = nz; qy.push(ny); qd.push(nd); qt++;
      }
    }
    // centroid
    this.center.set(0, 0, 0);
    for (let i = 0; i < this.n; i++) this.center.x += this.cells[i * 4], this.center.y += this.cells[i * 4 + 1], this.center.z += this.cells[i * 4 + 2];
    this.center.multiplyScalar(1 / Math.max(1, this.n));
    this.sun = sunVisibility(_p.copy(this.center).setY(this.center.y + 40));
    // burn marks
    const fx = this.sys.fx;
    const up = _a.set(0, 1, 0);
    for (let i = 0; i < Math.min(this.n, 5); i++) {
      const j = i === 0 ? 0 : (rand() * this.n) | 0;
      _p.set(this.cells[j * 4], this.cells[j * 4 + 1], this.cells[j * 4 + 2]);
      fx.decals.add(_p, up, 'burn', 70 + rand() * 40, rand() * 6.283, 'sand', 0.8, 0);
    }
    _p.copy(this.center).setY(this.center.y + 40);
    this.light = fx.lights.spawn(now, _p, 0xff8a3a, 2.4e5, 700, FIRE.LIFE + 0.5, { prio: 2, flicker: 0.45, attack: 0.25, hold: FIRE.LIFE - 1.2, owner: this });
    return this;
  }

  extinguish(now) {
    if (!this.active || this.extT >= 0) return;
    this.extT = now;
    this.tEnd = now + 0.6;
    const fx = this.sys.fx;
    fx.lights.release(this);
    // steam / white smoke burst
    const S = fx.pool.spec, R = this.rand;
    for (let i = 0; i < Math.min(this.n, 14); i++) {
      const j = (R() * this.n) | 0;
      S.reset();
      S.pos.set(this.cells[j * 4], this.cells[j * 4 + 1] + 8, this.cells[j * 4 + 2]);
      S.vel.set((R() - 0.5) * 40, 50 + R() * 50, (R() - 0.5) * 40);
      S.drag = 1.5; S.gravity = -0.05;
      S.life = 1.2 + R();
      S.size0 = 8; S.size1 = 34;
      S.rot = R() * 6.283;
      S.c0.set(0.7, 0.7, 0.7, 0.45); S.c1.set(0.7, 0.7, 0.7, 0);
      S.sprite = SPR.SMOKE0 + 4; S.frames = 12;
      S.flags = PF.LIT | PF.SOFT | PF.TURB;
      S.sun = this.sun; S.floorY = this.cells[j * 4 + 1];
      fx.pool.emit(S, fx.now);
    }
  }

  update(dt, now) {
    if (!this.active) return;
    if (now > this.tEnd + 0.1) { this.active = false; this.sys.fx.lights.release(this); return; }
    const fx = this.sys.fx, S = fx.pool.spec, R = this.rand, pool = fx.pool;
    const rate = 0.085 / Math.max(0.35, fx.scale);
    for (let i = 0; i < this.n; i++) {
      if (!this.cellBurning(i, now)) continue;
      this.acc[i] += dt;
      const o = i * 4;
      const age = now - this.cells[o + 3];
      const intensity = Math.min(1, age * 3) * (this.extT >= 0 ? 0.4 : 1);
      while (this.acc[i] > rate) {
        this.acc[i] -= rate;
        S.reset();
        const sz = (9 + R() * 8) * (0.7 + 0.3 * intensity);
        S.pos.set(this.cells[o] + (R() - 0.5) * 18, this.cells[o + 1] + sz * 0.72, this.cells[o + 2] + (R() - 0.5) * 18);
        S.vel.set((R() - 0.5) * 10, 18 + R() * 30, (R() - 0.5) * 10);
        S.gravity = -0.06; S.drag = 0.6;
        S.life = 0.5 + R() * 0.45;
        S.size0 = sz; S.size1 = sz * (1.15 + R() * 0.3);
        S.rot = (R() - 0.5) * 0.35;
        S.c0.set(0.85 + R() * 0.25, 2.6 * intensity, 0, 1); S.c1.set(0.75, 1.8 * intensity, 0, 1);
        S.sprite = SPR.FIRE0; S.frames = 16;
        S.flags = PF.FIRE | PF.ADD | PF.SOFT;
        S.fadeIn = 0.06; S.fadeOut = 0.6; S.floorY = this.cells[o + 1] - 2;
        pool.emit(S, now);
      }
    }
    if (this.extT >= 0) return;
    // smoke column
    this.smokeAcc += dt;
    while (this.smokeAcc > 0.1) {
      this.smokeAcc -= 0.1;
      const j = (R() * this.n) | 0;
      if (!this.cellBurning(j, now)) continue;
      S.reset();
      S.pos.set(this.cells[j * 4] + (R() - 0.5) * 20, this.cells[j * 4 + 1] + 34 + R() * 20, this.cells[j * 4 + 2] + (R() - 0.5) * 20);
      S.vel.set((R() - 0.5) * 20, 70 + R() * 50, (R() - 0.5) * 20);
      S.drag = 0.7; S.gravity = -0.08;
      S.life = 2.8 + R() * 1.8;
      S.size0 = 12; S.size1 = 55 + R() * 30;
      S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 0.5;
      const g = 0.1 + R() * 0.06;
      S.c0.set(g, g * 0.95, g * 0.9, 0.42); S.c1.set(g * 1.6, g * 1.6, g * 1.55, 0.18);
      S.sprite = SPR.SMOKE0; S.frames = 16;
      S.flags = PF.LIT | PF.SOFT | PF.TURB | PF.NEARFADE;
      S.fadeIn = 0.1; S.fadeOut = 0.5; S.sun = this.sun; S.floorY = this.cells[j * 4 + 1]; S.seed = R();
      pool.emit(S, now);
    }
    // embers
    this.emberAcc += dt;
    while (this.emberAcc > 0.06) {
      this.emberAcc -= 0.06;
      const j = (R() * this.n) | 0;
      S.reset();
      S.pos.set(this.cells[j * 4] + (R() - 0.5) * 20, this.cells[j * 4 + 1] + 10, this.cells[j * 4 + 2] + (R() - 0.5) * 20);
      S.vel.set((R() - 0.5) * 50, 90 + R() * 120, (R() - 0.5) * 50);
      S.drag = 1.2; S.gravity = -0.05;
      S.life = 0.8 + R() * 1.0;
      S.size0 = 0.35; S.size1 = 0.2;
      S.c0.set(8, 3.5, 0.8, 1); S.c1.set(3, 0.6, 0.1, 0.6);
      S.sprite = SPR.EMBER; S.flags = PF.ADD | PF.TURB | PF.MINPX;
      S.seed = R(); S.fadeIn = 0; S.fadeOut = 0.6;
      pool.emit(S, now);
    }
  }
}

export class FireSystem {
  constructor(fx) {
    this.fx = fx;
    this.fires = [];
    for (let i = 0; i < FIRE.MAX; i++) this.fires.push(new FireVolume(this));
  }
  spawn(pos, now, rand) {
    let f = this.fires.find((x) => !x.active);
    if (!f) { f = this.fires.reduce((a, b) => (a.t0 < b.t0 ? a : b)); f.active = false; this.fx.lights.release(f); }
    return f.start(pos, now, rand);
  }
  update(dt, now) { for (const f of this.fires) f.update(dt, now); }
  clear() { for (const f of this.fires) { f.active = false; this.fx.lights.release(f); } }
}
