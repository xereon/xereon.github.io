// HE grenade: fireball (emissive smoke flipbook cooling into soot), flame burst, sparks,
// debris, ground shockwave dust ring, rising smoke column, scorch decal, light, view punch.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { SURFACES } from '../core/surfaces.js';
import { PF } from './particles.js';
import { SPR } from './atlas.js';
import { sparks } from './impacts.js';
import { randCone, floorBelow, sunVisibility } from './util.js';

const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3(), _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

export function explosionFx(fx, pos, opts = {}) {
  const R = fx.rand, S = fx.pool.spec, pool = fx.pool, now = fx.now;
  const k = fx.scale;
  const sc = opts.scale ?? 1;
  const floorY = floorBelow(pos, 200);
  const ground = floorY > -1e5 && pos.y - floorY < 90;
  const sun = sunVisibility(_p.copy(pos).setY(pos.y + 30));
  // dust colour from what's under the grenade
  let dust = 0xc8b28a;
  if (ground && World.collision) {
    _p.copy(pos); _e.copy(pos).setY(floorY - 4);
    const tr = World.collision.rayTrace(_p.setY(pos.y + 2), _e, 1);
    dust = (SURFACES[tr.surface] || SURFACES.sand).dustColor;
  }
  _c.setHex(dust);

  // blinding core
  S.reset(); S.pos.copy(pos).setY(pos.y + 10 * sc);
  S.life = 0.16; S.size0 = 60 * sc; S.size1 = 110 * sc;
  S.c0.set(14, 9, 4.5, 1); S.c1.set(6, 2.5, 0.6, 0);
  S.sprite = SPR.GLOW; S.flags = PF.ADD; S.fadeIn = 0; S.fadeOut = 0.2;
  pool.emit(S, now);
  S.reset(); S.pos.copy(pos).setY(pos.y + 10 * sc);
  S.life = 0.09; S.size0 = 45 * sc; S.size1 = 70 * sc; S.rot = R() * 6.283;
  S.c0.set(18, 14, 8, 1); S.c1.set(10, 6, 2, 0);
  S.sprite = SPR.FLARE; S.flags = PF.ADD; S.fadeIn = 0; S.fadeOut = 0.3;
  pool.emit(S, now);

  // fireball puffs: emissive smoke frames cooling into soot
  const nFire = Math.round(12 * k * sc);
  for (let i = 0; i < nFire; i++) {
    S.reset();
    randCone(_up, 1.4, R, _d);
    if (ground && _d.y < 0.1) _d.y = 0.1 + R() * 0.3;
    S.pos.copy(pos).addScaledVector(_d, 8 + R() * 18);
    S.pos.y += 14 * sc;
    S.vel.copy(_d).multiplyScalar((220 + R() * 260) * sc);
    S.drag = 5.5; S.gravity = -0.1;
    S.life = 1.8 + R() * 1.2;
    S.size0 = (10 + R() * 8) * sc; S.size1 = (48 + R() * 26) * sc;
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 0.8;
    S.c0.set(1.3, 1.0, 0.85, 0.95); S.c1.set(0.075, 0.07, 0.065, 0.5);
    S.restitution = 0.16 + R() * 0.08; // heat fraction of life
    S.sprite = SPR.SMOKE0; S.frames = 16;
    S.flags = PF.FIREBALL | PF.SOFT | PF.TURB;
    S.fadeIn = 0.0; S.fadeOut = 0.55; S.sun = sun; S.floorY = floorY; S.seed = R();
    pool.emit(S, now);
  }
  // licking flames
  for (let i = 0; i < Math.round(7 * k * sc); i++) {
    S.reset();
    randCone(_up, 1.1, R, _d);
    S.pos.copy(pos).addScaledVector(_d, 10 + R() * 25); S.pos.y += 12;
    S.vel.copy(_d).multiplyScalar(150 + R() * 200); S.vel.y += 60;
    S.drag = 4; S.gravity = -0.15;
    S.life = 0.35 + R() * 0.25;
    S.size0 = (18 + R() * 12) * sc; S.size1 = (40 + R() * 20) * sc;
    S.rot = (R() - 0.5) * 0.6;
    S.c0.set(1.0, 5.0, 0, 1); S.c1.set(0.7, 3.0, 0, 1);
    S.sprite = SPR.FIRE0; S.frames = 16;
    S.flags = PF.FIRE | PF.ADD | PF.SOFT;
    S.fadeIn = 0; S.fadeOut = 0.5; S.floorY = floorY;
    pool.emit(S, now);
  }
  // sparks and debris
  sparks(fx, pos, _up, Math.round(40 * k * sc), 1100 * sc, floorY, { life: 1.0, size: 0.35, hot: 1.3, spread: 1.6 });
  for (let i = 0; i < Math.round(26 * k * sc); i++) {
    S.reset();
    randCone(_up, 0.9, R, _d);
    S.pos.copy(pos).addScaledVector(_d, 4); S.pos.y += 4;
    S.vel.copy(_d).multiplyScalar((260 + R() * 520) * sc);
    S.gravity = 1; S.drag = 0.3;
    S.flags = PF.LIT | PF.BOUNCE;
    S.floorY = floorY; S.restitution = 0.3;
    S.life = 1.6 + R() * 1.4;
    S.size0 = S.size1 = 0.6 + R() * 1.4;
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 20;
    const sh = 0.35 + R() * 0.4;
    S.c0.set(_c.r * sh, _c.g * sh, _c.b * sh, 1); S.c1.copy(S.c0);
    S.sprite = SPR.CHIP0 + ((R() * 4) | 0);
    S.fadeIn = 0; S.fadeOut = 0.85; S.sun = sun;
    pool.emit(S, now);
  }
  if (ground) {
    // shockwave: ground-hugging dust ring racing outward
    const n = Math.round(26 * k * sc);
    for (let i = 0; i < n; i++) {
      S.reset();
      const a = (i / n) * 6.283 + R() * 0.2;
      _d.set(Math.cos(a), 0, Math.sin(a));
      S.pos.set(pos.x + _d.x * 16, floorY + 6 + R() * 6, pos.z + _d.z * 16);
      S.vel.copy(_d).multiplyScalar((520 + R() * 380) * sc);
      S.vel.y = 20 + R() * 40;
      S.drag = 3.4; S.gravity = -0.02;
      S.life = 2.2 + R() * 1.4;
      S.size0 = 8 * sc; S.size1 = (36 + R() * 22) * sc;
      S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 0.8;
      S.c0.set(_c.r, _c.g, _c.b, 0.6); S.c1.set(_c.r, _c.g, _c.b, 0.25);
      S.sprite = SPR.SMOKE0 + 2; S.frames = 14;
      S.flags = PF.LIT | PF.SOFT | PF.TURB;
      S.fadeIn = 0.02; S.fadeOut = 0.35; S.sun = sun; S.floorY = floorY; S.seed = R();
      pool.emit(S, now);
    }
    // flat blast ring on the ground
    S.reset();
    S.pos.set(pos.x, floorY + 1.5, pos.z);
    S.vel.set(0, 1, 0);
    S.life = 0.4; S.size0 = 20 * sc; S.size1 = 230 * sc; S.rot = R() * 6.283;
    S.c0.set(_c.r, _c.g, _c.b, 0.55); S.c1.set(_c.r, _c.g, _c.b, 0);
    S.sprite = SPR.RING; S.flags = PF.LIT | PF.FLAT; S.sun = sun;
    S.fadeIn = 0; S.fadeOut = 0.2;
    pool.emit(S, now);
    _p.set(pos.x, floorY, pos.z);
    fx.decals.add(_p, _up, 'scorch', (130 + R() * 40) * sc, R() * 6.283, 'sand', 0.95, 0);
  }
  // smoke column
  for (let i = 0; i < Math.round(9 * k * sc); i++) {
    S.reset();
    S.pos.set(pos.x + (R() - 0.5) * 40, pos.y + 20 + R() * 30, pos.z + (R() - 0.5) * 40);
    S.vel.set((R() - 0.5) * 60, 80 + R() * 90, (R() - 0.5) * 60);
    S.delay = 0.12 + R() * 0.25;
    S.drag = 1.1; S.gravity = -0.06;
    S.life = 3.5 + R() * 2.5;
    S.size0 = 22 * sc; S.size1 = (70 + R() * 40) * sc;
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 0.4;
    const g = 0.16 + R() * 0.08;
    S.c0.set(g, g * 0.97, g * 0.93, 0.55); S.c1.set(g * 1.4, g * 1.4, g * 1.35, 0.3);
    S.sprite = SPR.SMOKE0; S.frames = 16;
    S.flags = PF.LIT | PF.SOFT | PF.TURB | PF.NEARFADE;
    S.fadeIn = 0.08; S.fadeOut = 0.45; S.sun = sun; S.floorY = floorY; S.seed = R();
    pool.emit(S, now);
  }
  // light + smoke punch-through + view punch
  _p.copy(pos).setY(pos.y + 30);
  fx.lights.spawn(now, _p, 0xffa24a, 3.2e6 * sc, 1400 * sc, 0.42, { prio: 3, hold: 0.03 });
  fx.smokes.blast(pos, now);
  const L = World.local;
  if (L?.viewPunch) {
    const eye = L.eyePos ? L.eyePos(_e) : _e.copy(L.origin || pos).setY((L.origin?.y || 0) + 64);
    const d = eye.distanceTo(pos);
    const kk = Math.max(0, 1 - d / (1000 * sc));
    if (kk > 0) {
      const a = kk * kk * 6 * fx.cvar('fx_shake', 1);
      L.viewPunch.pitch = (L.viewPunch.pitch || 0) - a * (0.6 + R() * 0.4);
      L.viewPunch.yaw = (L.viewPunch.yaw || 0) + (R() - 0.5) * a;
      fx.shake = Math.max(fx.shake, kk);
    }
  }
}
