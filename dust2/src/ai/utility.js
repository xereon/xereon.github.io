// Grenade throws for bots: ballistic aim that matches the WeaponSystem's CS:GO throw physics,
// verified by stepping the actual trajectory through the collision world before committing.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { MASK_SHOT } from '../player/collision.js';

// CS:GO CBaseCSGrenade::ThrowGrenade (mirrors weapons/registry.js GRENADE)
const SPEED = 750, GRAV_SCALE = 0.4;
const HMIN = new THREE.Vector3(-2, -2, -2), HMAX = new THREE.Vector3(2, 2, 2);
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _v = new THREE.Vector3();

/** View pitch that produces a throw elevation of `elevDeg` (the engine raises throws 10°). */
const viewPitchFor = (elevDeg) => (-elevDeg + 10) * 90 / 80;

/**
 * Aim solution from eye to target: { pitch, yaw, lob } candidates (direct first), or [].
 */
export function solve(eye, target) {
  const g = (World.cvar.sv_gravity ?? 800) * GRAV_SCALE;
  const dx = target.x - eye.x, dz = target.z - eye.z, h = target.y - eye.y;
  const d = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dz, dx) * 180 / Math.PI;
  const k = g * d * d / (2 * SPEED * SPEED);
  const disc = d * d - 4 * k * (h + k);
  if (disc < 0 || d < 1) return [];
  const out = [];
  for (const sgn of [-1, 1]) {
    const t = (d + sgn * Math.sqrt(disc)) / (2 * k);
    const elev = Math.atan(t) * 180 / Math.PI;
    const pitch = viewPitchFor(elev);
    if (pitch < -89 || pitch > 89) continue;
    out.push({ pitch, yaw, lob: sgn > 0 });
  }
  return out;
}

/**
 * Step the throw through the world (no bounces) and return the first impact point, or null
 * if nothing is hit within `maxT` seconds. Uses the thrower's current velocity like the engine.
 */
export function firstImpact(ent, eye, pitch, yaw, out = new THREE.Vector3(), maxT = 3) {
  const cw = World.collision;
  if (!cw) return null;
  const p = (-10 + pitch * 80 / 90) * Math.PI / 180, y = yaw * Math.PI / 180;
  _v.set(Math.cos(y) * Math.cos(p), -Math.sin(p), -Math.sin(y) * Math.cos(p)).multiplyScalar(SPEED);
  if (ent?.velocity) _v.addScaledVector(ent.velocity, 1.25);
  const g = (World.cvar.sv_gravity ?? 800) * GRAV_SCALE;
  _p.copy(eye);
  const dt = 1 / 48;
  for (let t = 0; t < maxT; t += dt) {
    _v.y -= g * dt * 0.5;
    _q.copy(_p).addScaledVector(_v, dt);
    _v.y -= g * dt * 0.5;
    const tr = cw.hullTrace(HMIN, HMAX, _p, _q, MASK_SHOT);
    if (tr.startSolid && t === 0) return null;
    if (tr.fraction < 1) { out.copy(tr.endpos); out.t = t; return out; }
    _p.copy(_q);
  }
  return null;
}

/**
 * Best throw from `eye` that first lands within `tol` of `target` (or, for air-burst flashes,
 * passes within tol before hitting anything). Returns { pitch, yaw } or null.
 */
export function planThrow(ent, eye, target, tol = 140, airburst = false) {
  const hit = new THREE.Vector3();
  for (const s of solve(eye, target)) {
    const imp = firstImpact(ent, eye, s.pitch, s.yaw, hit);
    if (!imp) { if (airburst) return s; continue; }
    if (imp.distanceTo(target) <= tol) return s;
    // a flash that pops (1.5 s fuse) before hitting the wall behind the target is fine too
    if (airburst && imp.t > 1.4 && Math.hypot(imp.x - eye.x, imp.z - eye.z) > Math.hypot(target.x - eye.x, target.z - eye.z)) return s;
  }
  return null;
}
