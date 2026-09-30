// Bullet impacts by surface, blood, footstep / landing dust. Recipes only: they fill the
// shared PSpec and push particles into the GPU pool. No allocation.
import * as THREE from 'three';
import { SURFACES } from '../core/surfaces.js';
import { PF } from './particles.js';
import { SPR } from './atlas.js';
import { randCone, floorBelow, sunVisibility, traceWorld } from './util.js';

const _c = new THREE.Color(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _r = new THREE.Vector3();

const HARD = { concrete: 1, brick: 1, rock: 1, tile: 1, default: 1, plaster: 1 };
const SANDY = { sand: 1, dirt: 1, gravel: 1 };
const METAL = { metal: 1, metalgrate: 1, metaldoor: 1 };
const WOOD = { wood: 1, crate: 1 };

/** Soft lit dust in the surface colour: a powdery cloud + a fast jet plume. */
function dustPuffs(fx, P, N, col, count, big, floorY, sun) {
  const S = fx.pool.spec, R = fx.rand, pool = fx.pool, now = fx.now;
  for (let i = 0; i < count; i++) {
    S.reset();
    S.pos.copy(P).addScaledVector(N, 2);
    randCone(N, 0.6, R, _d);
    const sp = (30 + R() * 110) * (0.6 + 0.4 * big);
    S.vel.copy(_d).multiplyScalar(sp);
    S.vel.y += 6 + R() * 18;
    S.drag = 2.4 + R() * 1.2;
    S.gravity = -0.01 + R() * 0.035;
    S.life = 1.4 + R() * 1.6 * big;
    S.size0 = 3 + R() * 3;
    S.size1 = (14 + R() * 14) * (0.7 + 0.5 * big);
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 0.8;
    S.c0.set(col.r, col.g, col.b, 0.55 + R() * 0.2);
    S.c1.set(col.r, col.g, col.b, 0.25);
    S.sprite = SPR.SMOKE0 + 5; S.frames = 11;
    S.flags = PF.LIT | PF.SOFT | PF.TURB;
    S.fadeIn = 0.03; S.fadeOut = 0.2;
    S.floorY = floorY; S.sun = sun; S.seed = R();
    pool.emit(S, now);
  }
  // fast jet plume along the normal
  for (let i = 0; i < 2; i++) {
    S.reset();
    S.pos.copy(P).addScaledVector(N, 1);
    randCone(N, 0.08, R, _d);
    S.vel.copy(_d).multiplyScalar(300 + R() * 250);
    S.drag = 7 + R() * 2;
    S.life = 0.45 + R() * 0.35;
    S.size0 = 1.2; S.size1 = 6 + 5 * big;
    S.rot = R() * 6.283;
    S.c0.set(col.r, col.g, col.b, 0.75); S.c1.set(col.r, col.g, col.b, 0.05);
    S.sprite = SPR.PUFF; S.frames = 1;
    S.flags = PF.LIT | PF.SOFT;
    S.fadeIn = 0.0; S.fadeOut = 0.25;
    S.floorY = floorY; S.sun = sun; S.seed = R();
    pool.emit(S, now);
  }
}

function chips(fx, P, N, col, count, floorY, sun, sprite0, nSprites, sizeMin, sizeMax, speed) {
  const S = fx.pool.spec, R = fx.rand, pool = fx.pool, now = fx.now;
  for (let i = 0; i < count; i++) {
    S.reset();
    S.pos.copy(P).addScaledVector(N, 0.8);
    randCone(N, 0.75, R, _d);
    S.vel.copy(_d).multiplyScalar(speed * (0.4 + R() * 0.8));
    S.vel.y += 40;
    S.gravity = 1; S.drag = 0.3;
    S.flags = PF.LIT | PF.BOUNCE;
    S.floorY = floorY; S.restitution = 0.28;
    S.life = 1.2 + R() * 1.2;
    S.size0 = S.size1 = sizeMin + R() * (sizeMax - sizeMin);
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 30;
    const shade = 0.55 + R() * 0.45;
    S.c0.set(col.r * shade, col.g * shade, col.b * shade, 1);
    S.c1.set(col.r * shade, col.g * shade, col.b * shade, 1);
    S.sprite = sprite0 + ((R() * nSprites) | 0);
    S.fadeIn = 0; S.fadeOut = 0.85;
    S.sun = sun; S.seed = R();
    pool.emit(S, now);
  }
}

export function sparks(fx, P, N, count, speed, floorY, { life = 0.45, size = 0.22, hot = 1, spread = 0.9, pool = fx.pool } = {}) {
  const S = pool.spec, R = fx.rand, now = fx.now;
  for (let i = 0; i < count; i++) {
    S.reset();
    S.pos.copy(P).addScaledVector(N, 0.5);
    randCone(N, spread, R, _d);
    S.vel.copy(_d).multiplyScalar(speed * (0.35 + R() * 0.9));
    S.gravity = 1; S.drag = 1.2;
    S.flags = PF.ADD | PF.STRETCH | PF.BOUNCE | PF.MINPX;
    S.floorY = floorY; S.restitution = 0.45;
    S.stretch = 0.018 + R() * 0.012;
    S.life = life * (0.4 + R() * 0.9);
    S.size0 = size * (0.8 + R() * 0.5); S.size1 = S.size0 * 0.6;
    S.c0.set(9 * hot, 6 * hot, 2.8 * hot, 1);
    S.c1.set(3.5 * hot, 0.9 * hot, 0.12 * hot, 0.8);
    S.sprite = SPR.SPARK;
    S.fadeIn = 0; S.fadeOut = 0.55;
    S.seed = R();
    pool.emit(S, now);
  }
}

function glint(fx, P, N, size, r, g, b, life = 0.06) {
  const S = fx.pool.spec;
  S.reset();
  S.pos.copy(P).addScaledVector(N, 1);
  S.life = life;
  S.size0 = size; S.size1 = size * 1.3;
  S.rot = fx.rand() * 6.283;
  S.c0.set(r, g, b, 1); S.c1.set(r, g, b, 0);
  S.sprite = SPR.GLOW; S.flags = PF.ADD;
  S.fadeIn = 0; S.fadeOut = 0.2;
  fx.pool.emit(S, fx.now);
}

/** Bullet impact on a world surface. */
export function impactFx(fx, point, normal, surface) {
  const R = fx.rand;
  const sd = SURFACES[surface] || SURFACES.default;
  const N = _n.copy(normal);
  if (N.lengthSq() < 1e-6) N.set(0, 1, 0); else N.normalize();
  const P = _p.copy(point);
  _c.setHex(sd.dustColor);
  const k = fx.scale;
  const floorY = floorBelow(_r.copy(P).addScaledVector(N, 2));
  const sun = sunVisibility(_r.copy(P).addScaledVector(N, 6));
  const amt = sd.dustAmount;

  if (SANDY[surface]) {
    dustPuffs(fx, P, N, _c, Math.round((2 + 2 * amt) * k), 1.3, floorY, sun);
    // sand spray: streaks thrown up that fall back
    const S = fx.pool.spec;
    for (let i = 0; i < Math.round(8 * k); i++) {
      S.reset();
      S.pos.copy(P).addScaledVector(N, 1);
      randCone(N, 0.35, R, _d);
      S.vel.copy(_d).multiplyScalar(180 + R() * 220);
      S.gravity = 0.9; S.drag = 1.6;
      S.life = 0.6 + R() * 0.5;
      S.size0 = 2.5; S.size1 = 10 + R() * 6;
      S.c0.set(_c.r * 0.9, _c.g * 0.9, _c.b * 0.9, 0.9); S.c1.set(_c.r, _c.g, _c.b, 0);
      S.sprite = R() < 0.5 ? SPR.STREAK : SPR.GRAINS;
      S.flags = PF.LIT | PF.STRETCH | PF.SOFT;
      S.stretch = 0.02;
      S.floorY = floorY; S.sun = sun; S.fadeIn = 0; S.fadeOut = 0.4;
      fx.pool.emit(S, fx.now);
    }
    chips(fx, P, N, _c, Math.round(4 * k), floorY, sun, SPR.CHIP0 + 3, 1, 0.15, 0.3, 260);
  } else if (METAL[surface]) {
    sparks(fx, P, N, Math.round((16 + R() * 10) * k), 650, floorY, { size: 0.4 });
    glint(fx, P, N, 3.5 + R() * 1.5, 7, 5, 2.4, 0.05);
    dustPuffs(fx, P, N, _c.setRGB(0.35, 0.35, 0.35), Math.round(2 * k), 0.5, floorY, sun);
  } else if (WOOD[surface]) {
    dustPuffs(fx, P, N, _c, Math.round((1 + 2 * amt) * k), 0.7, floorY, sun);
    _c.setHex(sd.dustColor).multiplyScalar(1.5);
    chips(fx, P, N, _c, Math.round((5 + R() * 4) * k), floorY, sun, SPR.SPLINTER, 1, 0.45, 1.1, 320);
  } else if (surface === 'glass') {
    const S = fx.pool.spec;
    for (let i = 0; i < Math.round(9 * k); i++) {
      S.reset();
      S.pos.copy(P);
      randCone(N, 1.0, R, _d);
      if (R() < 0.5) _d.negate(); // shards fly out both sides
      S.vel.copy(_d).multiplyScalar(80 + R() * 220);
      S.gravity = 1; S.drag = 0.2;
      S.flags = PF.LIT | PF.BOUNCE;
      S.floorY = floorY; S.restitution = 0.2;
      S.life = 1 + R() * 1.2;
      S.size0 = S.size1 = 0.35 + R() * 0.7;
      S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 25;
      S.c0.set(0.85, 0.95, 0.95, 0.7); S.c1.set(0.85, 0.95, 0.95, 0.6);
      S.sprite = SPR.SHARD0 + ((R() * 2) | 0);
      S.fadeIn = 0; S.fadeOut = 0.8; S.sun = sun;
      fx.pool.emit(S, fx.now);
    }
    glint(fx, P, N, 2.5, 3, 3.2, 3.4, 0.05);
    dustPuffs(fx, P, N, _c, 1, 0.3, floorY, sun);
  } else if (surface === 'water') {
    const S = fx.pool.spec;
    for (let i = 0; i < Math.round(10 * k); i++) {
      S.reset();
      S.pos.copy(P);
      randCone(_up, 0.25, R, _d);
      S.vel.copy(_d).multiplyScalar(120 + R() * 200);
      S.gravity = 1; S.drag = 0.5;
      S.life = 0.5 + R() * 0.4;
      S.size0 = 0.4; S.size1 = 1.2;
      S.c0.set(0.6, 0.7, 0.75, 0.7); S.c1.set(0.6, 0.7, 0.75, 0);
      S.sprite = SPR.DROP; S.flags = PF.LIT | PF.STRETCH; S.stretch = 0.02;
      S.sun = sun;
      fx.pool.emit(S, fx.now);
    }
  } else {
    // mineral: concrete / plaster / brick / tile / rock / default
    const big = surface === 'plaster' ? 1.1 : surface === 'tile' ? 0.6 : 0.85;
    dustPuffs(fx, P, N, _c, Math.round((1.5 + 2 * amt) * k), big, floorY, sun);
    chips(fx, P, N, _c, Math.round((6 + R() * 6) * k), floorY, sun, SPR.CHIP0, 3, 0.25, 0.65, 380);
    if (surface === 'concrete' || surface === 'rock' || surface === 'brick' || surface === 'default') {
      // hard stone throws a couple of dull sparks
      if (R() < 0.35) sparks(fx, P, N, 2, 350, floorY, { life: 0.2, size: 0.15, hot: 0.6 });
    }
  }
  // decal
  if (sd.decal && fx.cvar('fx_decals', 1) > 0) {
    const T = fx.decals;
    T.add(point, N, sd.decal, 0, R() * Math.PI * 2, surface, 1, (R() * 3) | 0);
  }
}

/** Blood from a character hit: mist, droplets, splatter decals behind and below. */
export function bloodFx(fx, point, dir, amount = 1) {
  const R = fx.rand, S = fx.pool.spec, k = fx.scale;
  const D = _d.copy(dir);
  if (D.lengthSq() < 1e-6) D.set(0, 0, 1); else D.normalize();
  const floorY = floorBelow(point, 300);
  const sun = sunVisibility(point);
  // mist
  for (let i = 0; i < Math.round((3 + 2 * amount) * k); i++) {
    S.reset();
    S.pos.copy(point);
    randCone(D, 0.6, R, _r);
    if (i === 0) _r.negate(); // puff back toward the shooter too
    S.vel.copy(_r).multiplyScalar(40 + R() * 90);
    S.drag = 5; S.gravity = 0.06;
    S.life = 0.4 + R() * 0.45;
    S.size0 = 2.5 + R(); S.size1 = (9 + R() * 8) * (0.7 + 0.3 * amount); S.sizePow = 4;
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5) * 2;
    S.c0.set(0.3, 0.012, 0.01, 0.95); S.c1.set(0.2, 0.008, 0.006, 0.3);
    S.sprite = SPR.MIST0 + ((R() * 2) | 0);
    S.flags = PF.LIT | PF.SOFT;
    S.fadeIn = 0; S.fadeOut = 0.35; S.sun = sun; S.floorY = floorY;
    fx.pool.emit(S, fx.now);
  }
  // droplets
  for (let i = 0; i < Math.round((8 + 6 * amount) * k); i++) {
    S.reset();
    S.pos.copy(point);
    randCone(D, 0.35, R, _r);
    S.vel.copy(_r).multiplyScalar(120 + R() * 260);
    S.gravity = 1; S.drag = 0.6;
    S.flags = PF.LIT | PF.STRETCH | PF.BOUNCE;
    S.floorY = floorY; S.restitution = 0;
    S.stretch = 0.022;
    S.life = 0.5 + R() * 0.6;
    S.size0 = S.size1 = 0.22 + R() * 0.3;
    S.c0.set(0.28, 0.01, 0.01, 1); S.c1.set(0.2, 0.005, 0.005, 1);
    S.sprite = SPR.DROP;
    S.fadeIn = 0; S.fadeOut = 0.8; S.sun = sun;
    fx.pool.emit(S, fx.now);
  }
  // wall splat behind the victim
  if (traceWorld(point, D, 120, _p, _n) < 1) {
    const dist = _p.distanceTo(point);
    fx.decals.add(_p, _n, 'blood', (18 + R() * 14) * (0.6 + dist / 160) * (0.7 + 0.3 * amount), R() * 6.283, 'flesh', 0.92, (R() * 2) | 0);
  }
  // drips on the floor
  if (floorY > -1e5 && point.y - floorY < 90 && R() < 0.7) {
    _p.set(point.x + D.x * 12 * R(), floorY, point.z + D.z * 12 * R());
    fx.decals.add(_p, _up, 'blood_drip', 12 + R() * 10, R() * 6.283, 'flesh', 0.9, 0);
  }
}

/** Little dust kick at a character's feet (footsteps on sand, landings). */
export function feetDust(fx, pos, surface, strength) {
  const sd = SURFACES[surface];
  if (!sd || sd.dustAmount < 0.6) return;
  const R = fx.rand, S = fx.pool.spec;
  _c.setHex(sd.dustColor);
  const sun = strength > 0.5 ? sunVisibility(_r.copy(pos).setY(pos.y + 8)) : 1;
  const n = Math.max(1, Math.round((strength > 0.5 ? 7 : 2) * fx.scale));
  for (let i = 0; i < n; i++) {
    S.reset();
    const a = (i / n) * 6.283 + R();
    S.pos.set(pos.x + Math.cos(a) * 6, pos.y + 2, pos.z + Math.sin(a) * 6);
    S.vel.set(Math.cos(a) * (40 + 120 * strength), 12 + R() * 15, Math.sin(a) * (40 + 120 * strength));
    S.drag = 3.5; S.gravity = 0.02;
    S.life = 0.9 + R() * 0.9 * strength;
    S.size0 = 3; S.size1 = 8 + 14 * strength;
    S.rot = R() * 6.283; S.rotVel = (R() - 0.5);
    S.c0.set(_c.r, _c.g, _c.b, 0.22 + 0.3 * strength); S.c1.set(_c.r, _c.g, _c.b, 0.1);
    S.sprite = SPR.SMOKE0 + 4; S.frames = 12;
    S.flags = PF.LIT | PF.SOFT | PF.TURB;
    S.floorY = pos.y; S.sun = sun; S.fadeIn = 0.05; S.fadeOut = 0.3;
    fx.pool.emit(S, fx.now);
  }
}
