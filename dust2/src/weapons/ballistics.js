// Hitscan ballistics (CONTRACT §7): CS:GO FireBullet + HandleBulletPenetration + TraceToExit.
//
//   fireBullet(ent, weapon, seed, shotIndex, opts)  one trigger pull: every pellet, damage,
//                                                   'impact' per entry AND exit, 'fire', tracer
//   damageFalloff(dmg, dist, rangeModifier)         dmg * rm^(dist/500)
//   armorAbsorb(dmg, armorPen, armorValue)          CS kevlar formula -> { health, armor }
//
// Bullets leave the EYE (not the muzzle) along view + aimPunch * weapon_recoil_scale, then
// get CS:GO's two-term spread: inaccuracy * r1 at angle θ1 plus spread * r2 at angle θ2.
// Hitgroup multipliers and armour are applied by Player.takeDamage (it owns health/armour);
// we pass the post-falloff, post-penetration damage plus armorPen / headshotMul.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { SURFACES } from '../core/surfaces.js';
import { angleVectors } from '../core/mathx.js';
import { MASK_SHOT, CONTENTS_GRATE } from '../player/collision.js';
import { WEAPONS } from './registry.js';
import { Rand } from './recoil.js';

defCvar('mp_friendlyfire', 0, 0, 1, 'bullets damage teammates (0 = pass through them)');
defCvar('sv_penetration_max_dist', 90, 0, 400, 'thickest wall a bullet can exit (CS:GO 90u)');
defCvar('sv_showimpacts', 0, 0, 1, 'log bullet impacts to the console (debug)');

export const HG_GENERIC = 0, HG_HEAD = 1, HG_CHEST = 2, HG_STOMACH = 3, HG_LARM = 4, HG_RARM = 5, HG_LLEG = 6, HG_RLEG = 7;
export const HITGROUP_MUL = [1, 4, 1, 1.25, 1, 1, 0.75, 0.75];
const ARMOR_BONUS = 0.5;
const MAX_HITS = 4;          // CS:GO: 4 penetrations
const EXIT_STEP = 4;         // TraceToExit step
const ZERO = new THREE.Vector3();
const WOOD = new Set(['wood', 'crate']);

// ---- pure damage helpers (unit-tested) -----------------------------------------------------
export const damageFalloff = (dmg, dist, rangeModifier) => dmg * Math.pow(rangeModifier, dist / 500);

/** CS armour: armorPen of the damage reaches health, each armour point absorbs 2 points. */
export function armorAbsorb(dmg, armorPen, armorValue) {
  if (!(armorValue > 0)) return { health: dmg, armor: 0 };
  let toHealth = dmg * armorPen;
  let toArmor = (dmg - toHealth) * ARMOR_BONUS;
  if (toArmor > armorValue) { toHealth = dmg - armorValue / ARMOR_BONUS; toArmor = armorValue; }
  return { health: toHealth, armor: toArmor };
}

/** Full CS damage for one hit on a victim with given armour (for tests / bot estimates). */
export function hitDamage(def, dist, hitgroup, armor = 0, helmet = false) {
  let d = damageFalloff(def.damage, dist, def.rangeModifier ?? 1);
  d *= hitgroup === HG_HEAD ? (def.headshotMul ?? 4) : (HITGROUP_MUL[hitgroup] ?? 1);
  const covered = hitgroup === HG_GENERIC || hitgroup === HG_CHEST || hitgroup === HG_STOMACH ||
    hitgroup === HG_LARM || hitgroup === HG_RARM || (hitgroup === HG_HEAD && helmet);
  if (armor > 0 && covered) d = armorAbsorb(d, def.armorPen ?? 0.5, armor).health;
  return Math.max(1, Math.floor(d));
}

// ---- scratch ---------------------------------------------------------------------------------
const _eye = new THREE.Vector3(), _src = new THREE.Vector3(), _end = new THREE.Vector3(), _dir = new THREE.Vector3();
const _p = new THREE.Vector3(), _muzzle = new THREE.Vector3();
const _av = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const _rand = new Rand(1);
const _spr = { x: 0, y: 0 };

class ShotTrace {
  constructor() {
    this.hit = false; this.fraction = 1; this.dist = 0;
    this.endpos = new THREE.Vector3(); this.normal = new THREE.Vector3();
    this.surface = 'default'; this.contents = 0; this.entity = null; this.hitgroup = 0;
  }
}
const _tr = new ShotTrace();
const _exit = new ShotTrace();

/** World (incl. grates) + hitboxes, skipping up to two entities. Result is a pooled ShotTrace. */
export function traceShot(start, end, skipA = null, skipB = null, out = _tr) {
  const col = World.collision;
  out.hit = false; out.entity = null; out.hitgroup = 0; out.contents = 0; out.surface = 'default';
  out.endpos.copy(end); out.normal.set(0, 0, 0); out.fraction = 1;
  _dir.subVectors(end, start);
  const len = _dir.length();
  out.dist = len;
  if (len < 1e-6 || !col) return out;
  _dir.multiplyScalar(1 / len);
  const w = col.hullTrace(ZERO, ZERO, start, end, MASK_SHOT);
  let best = len;
  if (w.fraction < 1 && !w.startSolid) {
    best = w.fraction * len;
    out.hit = true; out.fraction = w.fraction; out.endpos.copy(w.endpos); out.normal.copy(w.normal);
    out.surface = w.surface || 'default'; out.contents = w.contents | 0; out.dist = best;
  } else if (w.startSolid) {
    out.hit = true; out.fraction = 0; out.endpos.copy(start); out.normal.copy(_dir).negate();
    out.surface = w.surface || 'default'; out.contents = w.contents | 0; out.dist = 0;
    return out;
  }
  const ff = World.cvar.mp_friendlyfire;
  const shooter = skipA;
  const ents = World.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e === skipA || e === skipB || !e.alive || !e.rayHit) continue;
    if (!ff && shooter && shooter.team && e.team === shooter.team) continue;
    let h = null;
    try { h = e.rayHit(start, _dir, best); } catch (err) { h = null; }
    if (h && h.t >= 0 && h.t < best) {
      best = h.t;
      out.hit = true; out.entity = e; out.hitgroup = h.hitgroup | 0; out.surface = 'flesh'; out.contents = 0;
      out.fraction = best / len; out.dist = best;
      if (h.point) out.endpos.copy(h.point); else out.endpos.copy(start).addScaledVector(_dir, best);
      if (h.normal) out.normal.copy(h.normal); else out.normal.copy(_dir).negate();
    }
  }
  return out;
}

/**
 * CS:GO TraceToExit: march through the solid in 4u steps (max sv_penetration_max_dist), then
 * trace back to find the exit face. Returns the pooled exit trace or null (too thick).
 */
export function traceToExit(enter, dir, maxDist = World.cvar.sv_penetration_max_dist ?? 90) {
  const col = World.collision;
  if (!col) return null;
  for (let d = EXIT_STEP; d <= maxDist + 1e-3; d += EXIT_STEP) {
    _p.copy(enter).addScaledVector(dir, d);
    if (col.pointContents(_p) & MASK_SHOT) continue;
    // outside again: the first face hit tracing back toward the entry is the exit face
    const tr = col.hullTrace(ZERO, ZERO, _p, enter, MASK_SHOT);
    _exit.hit = true; _exit.entity = null;
    if (tr.fraction < 1 && !tr.startSolid) {
      _exit.endpos.copy(tr.endpos); _exit.normal.copy(tr.normal);
      _exit.surface = tr.surface || 'default'; _exit.contents = tr.contents | 0;
    } else {
      _exit.endpos.copy(_p); _exit.normal.copy(dir);
      _exit.surface = 'default'; _exit.contents = 0;
    }
    _exit.dist = _exit.endpos.distanceTo(enter);
    return _exit;
  }
  return null;
}

// ---- spread ----------------------------------------------------------------------------------
/**
 * CS:GO FX_FireBullets spread for one bullet. inacc/spread are radians (script value * 0.001).
 * The inaccuracy term (θ0, r0) is shared by all pellets of a shot; shotguns use a fixed
 * pellet pattern for the spread term (weapon_accuracy_shotgun_spread_patterns 1).
 */
export function spreadOffset(rand, inacc, spread, def, recoilIndex, pellet, shared, out = _spr) {
  if (pellet === 0) {
    const t0 = rand.next() * Math.PI * 2;
    let r0 = rand.next();
    const wb = def.wildBeast;
    if (wb && recoilIndex < wb.edgeShots) { // Negev: first shots pushed to the edge of the cone
      for (let j = wb.edgeShots; j > recoilIndex; j--) r0 *= r0;
      r0 = 1 - r0;
    }
    shared.x = Math.cos(t0) * r0 * inacc;
    shared.y = Math.sin(t0) * r0 * inacc;
  }
  let t1, r1;
  const n = def.bullets || 1;
  if (n > 1) {
    // fixed ring pattern, rotated per shot; pellet 0 near the centre
    if (pellet === 0) { shared.rot = rand.next() * Math.PI * 2; }
    if (pellet === 0) { t1 = shared.rot; r1 = 0.12; }
    else {
      const ring = pellet % 2 === 1 ? 1 : 0.55;
      t1 = shared.rot + (pellet - 1) / (n - 1) * Math.PI * 2 + (rand.next() - 0.5) * 0.35;
      r1 = ring * (0.85 + rand.next() * 0.15);
    }
  } else {
    t1 = rand.next() * Math.PI * 2;
    r1 = rand.next();
  }
  out.x = shared.x + Math.cos(t1) * r1 * spread;
  out.y = shared.y + Math.sin(t1) * r1 * spread;
  return out;
}

// ---- damage dispatch ---------------------------------------------------------------------
export function dealDamage(victim, info) {
  if (!victim || victim.alive === false) return 0;
  if (typeof victim.takeDamage === 'function') {
    try { return victim.takeDamage(info) || 0; }
    catch (err) { console.error('[weapons] takeDamage threw', err); return 0; }
  }
  // Fallback for entities without the Player API: CS maths inline.
  const def = WEAPONS[info.weapon] || {};
  let d = info.amount;
  if (!info.hitgroupApplied) d *= info.hitgroup === HG_HEAD ? (info.headshotMul ?? 4) : (HITGROUP_MUL[info.hitgroup] ?? 1);
  const covered = info.hitgroup !== HG_LLEG && info.hitgroup !== HG_RLEG && (info.hitgroup !== HG_HEAD || victim.helmet);
  if ((victim.armor || 0) > 0 && covered) {
    const r = armorAbsorb(d, info.armorPen ?? def.armorPen ?? 0.5, victim.armor);
    victim.armor = Math.max(0, victim.armor - Math.floor(r.armor)); d = r.health;
  }
  const amount = Math.max(1, Math.floor(d));
  victim.health = (victim.health ?? 100) - amount;
  World.emit('damage', { victim, attacker: info.attacker, amount, hitgroup: info.hitgroup, weapon: info.weapon,
    point: info.point, normal: info.normal, penetrated: info.penetrated });
  if (victim.health <= 0 && victim.alive !== false) {
    victim.health = 0;
    if (victim.die) victim.die(info);
    else { victim.alive = false; World.emit('death', { victim, attacker: info.attacker, weapon: info.weapon, headshot: info.hitgroup === HG_HEAD }); }
  }
  return amount;
}

function emitImpact(point, normal, surface, entity, key, dir, exit, attacker) {
  World.emit('impact', {
    point: point.clone(), normal: normal.clone(), surface, entity: entity || null, weapon: key,
    dir: dir.clone(), exit: !!exit, attacker,
  });
}

// ---- one shot -------------------------------------------------------------------------------
const _shared = { x: 0, y: 0, rot: 0 };
export const lastShot = {           // debug / tests: what the most recent fireBullet did
  pellets: 0, ends: [], hits: [], impacts: 0, dir: new THREE.Vector3(),
};

/**
 * Fire one trigger pull of `weapon` (key | instance | def) for `ent`.
 * opts: { inaccuracy, spread (radians), punchScale, muzzle (Vector3), tracer (bool),
 *         silenced (bool), recoilIndex }
 * Returns lastShot (pooled).
 */
export function fireBullet(ent, weapon, seed = 0, shotIndex = 0, opts = {}) {
  const key = typeof weapon === 'string' ? weapon : (weapon?.key || weapon?.def?.key || null);
  const def = typeof weapon === 'string' ? WEAPONS[weapon] : (weapon?.def || weapon);
  if (!def) return lastShot;
  const col = World.collision;
  const cv = World.cvar;

  if (ent.eyePos) ent.eyePos(_eye);
  else _eye.set(ent.origin.x, ent.origin.y + (ent.eyeHeight ?? 64), ent.origin.z);

  const ps = opts.punchScale ?? cv.weapon_recoil_scale ?? 2;
  const ap = ent.aimPunch;
  const pitch = (ent.pitch || 0) + (ap ? ap.pitch * ps : 0);
  const yaw = (ent.yaw || 0) + (ap ? ap.yaw * ps : 0);
  angleVectors(pitch, yaw, _av);
  const fw = _av.forward, rt = _av.right, up = _av.up;
  lastShot.dir.copy(fw);

  const inacc = opts.inaccuracy ?? 0, spread = opts.spread ?? 0;
  _rand.seed(seed);
  const pellets = def.bullets || 1;
  lastShot.pellets = pellets;
  lastShot.ends.length = 0; lastShot.hits.length = 0; lastShot.impacts = 0;

  // muzzle for tracers
  let muzzle = opts.muzzle || null;
  if (!muzzle) {
    muzzle = _muzzle.copy(_eye).addScaledVector(fw, 20).addScaledVector(rt, 6).addScaledVector(up, -5);
  }
  const wantTracer = opts.tracer ?? false;
  const tracerPellets = pellets > 1 ? 3 : 1;

  for (let b = 0; b < pellets; b++) {
    const o = spreadOffset(_rand, inacc, spread, def, opts.recoilIndex ?? shotIndex, b, _shared);
    _dir.copy(fw).addScaledVector(rt, o.x).addScaledVector(up, o.y).normalize();
    const dir = _dir.clone(); // traceShot reuses _dir internally
    const endPoint = traceBulletPath(ent, key, def, _eye, dir, opts);
    lastShot.ends.push(endPoint);
    if (wantTracer && b < tracerPellets && col) {
      try { World.fx?.tracer?.(muzzle.clone(), endPoint.clone(), key, opts.tracerOpts); } catch (err) { console.error('[weapons] fx.tracer threw', err); }
    }
  }
  return lastShot;
}

/** Trace one bullet through the world with penetration. Returns the final end point (new Vector3). */
function traceBulletPath(ent, key, def, eye, dir, opts) {
  const cv = World.cvar;
  let dmg = def.damage || 0;
  const pen = def.penetration ?? 1;
  const rm = def.rangeModifier ?? 1;
  const range = def.range || 8192;
  let traveled = 0, hitsLeft = MAX_HITS, penetrated = 0;
  let lastEnt = null;
  _src.copy(eye);
  const finalEnd = new THREE.Vector3().copy(eye).addScaledVector(dir, range);

  for (let guard = 0; guard < 12 && dmg > 0; guard++) {
    const remaining = range - traveled;
    if (remaining <= 1) { finalEnd.copy(_src); break; }
    _end.copy(_src).addScaledVector(dir, remaining);
    const tr = traceShot(_src, _end, ent, lastEnt);
    if (!tr.hit) { finalEnd.copy(_end); break; }
    const seg = tr.dist;
    traveled += seg;
    dmg = damageFalloff(dmg, seg, rm);
    lastShot.impacts++;

    if (tr.entity) {
      const victim = tr.entity;
      const hg = tr.hitgroup;
      const point = tr.endpos.clone(), normal = tr.normal.clone();
      lastShot.hits.push({ ent: victim, hitgroup: hg, damage: dmg, dist: traveled, penetrated });
      emitImpact(point, normal, 'flesh', victim, key, dir, false, ent);
      dealDamage(victim, {
        amount: dmg, hitgroup: hg, attacker: ent, weapon: key, point, dir: dir.clone(), normal,
        armorPen: def.armorPen, headshotMul: def.headshotMul ?? 4, penetrated,
        tagging: def.tagging, taggingSmall: def.taggingSmall, distance: traveled,
      });
      if (World.cvar.sv_showimpacts) console.log('[impact] hit', victim.name, 'hg', hg, 'dmg', dmg.toFixed(1), 'dist', traveled.toFixed(0));
      // carry on through the body (collateral): flesh, ~12u thick (head ~7u)
      if (hitsLeft <= 0 || pen <= 0) { finalEnd.copy(tr.endpos); break; }
      const thick = hg === HG_HEAD ? 7 : 12;
      const lost = dmg * 0.16 + Math.max(0, (3 / pen) * 1.25) * 3 + (thick * thick) / 24;
      dmg -= lost;
      if (dmg < 1) { finalEnd.copy(tr.endpos); break; }
      lastEnt = victim;
      _src.copy(tr.endpos);
      hitsLeft--; penetrated++;
      continue;
    }

    // ---- world surface ----
    const enterSurf = tr.surface || 'default';
    const grate = (tr.contents & CONTENTS_GRATE) !== 0;
    emitImpact(tr.endpos, tr.normal, enterSurf, null, key, dir, false, ent);
    if (cv.sv_showimpacts) console.log('[impact] world', enterSurf, tr.endpos.toArray().map((v) => v.toFixed(1)).join(','), 'dmg', dmg.toFixed(1));
    const enterPt = _p.copy(tr.endpos);
    const glassLike = grate || enterSurf === 'glass' || enterSurf === 'metalgrate';
    if (pen <= 0 || (hitsLeft <= 0 && !glassLike)) { finalEnd.copy(tr.endpos); break; }

    const enterCopy = new THREE.Vector3().copy(enterPt);
    const ex = traceToExit(enterCopy, dir);
    if (!ex) { finalEnd.copy(enterCopy); break; }
    const exitSurf = ex.surface || enterSurf;
    // CS:GO sv_penetration_type 1
    let penMod, dmgLost = 0.16;
    if (glassLike) { penMod = 3; dmgLost = 0.05; }
    else {
      penMod = ((SURFACES[enterSurf]?.penetrationModifier ?? 1) + (SURFACES[exitSurf]?.penetrationModifier ?? 1)) / 2;
      if (WOOD.has(enterSurf) && WOOD.has(exitSurf)) penMod = 3; // hollow crate / door bonus
    }
    const thick = ex.dist;
    const inv = penMod > 0 ? 1 / penMod : 1e9;
    const lost = dmg * dmgLost + Math.max(0, (3 / pen) * 1.25) * (inv * 3) + (inv * thick * thick) / 24;
    dmg -= lost;
    if (dmg < 1) { finalEnd.copy(enterCopy); break; }
    penetrated++;
    emitImpact(ex.endpos, ex.normal, exitSurf, null, key, dir, true, ent);
    lastShot.impacts++;
    traveled += thick;
    _src.copy(ex.endpos).addScaledVector(dir, 0.1);
    hitsLeft--;
  }
  return finalEnd;
}

// ---- knife -------------------------------------------------------------------------------
const _kOff = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [12, 6], [-12, 6], [0, -14]];
const _kTr = new ShotTrace();
/**
 * Knife reach test (CS:GO: line trace, then a head-hull sweep when it whiffs).
 * Returns { entity, hitgroup, point, normal, surface, dist } or null. `out` is pooled.
 */
export function knifeTrace(ent, range, out = {}) {
  if (ent.eyePos) ent.eyePos(_eye); else _eye.set(ent.origin.x, ent.origin.y + (ent.eyeHeight ?? 64), ent.origin.z);
  angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
  const fw = _av.forward, rt = _av.right, up = _av.up;
  let best = null;
  for (let i = 0; i < _kOff.length; i++) {
    const [ox, oy] = _kOff[i];
    _src.copy(_eye);
    _end.copy(_eye).addScaledVector(fw, range).addScaledVector(rt, ox).addScaledVector(up, oy);
    const tr = traceShot(_src, _end, ent, null, _kTr);
    if (!tr.hit) continue;
    if (tr.entity) { if (!best || !best.entity || tr.dist < best.dist) best = copyHit(out, tr); if (i === 0) break; }
    else if (i === 0) best = copyHit(out, tr);   // centre ray hit a wall first
  }
  return best;
}
function copyHit(out, tr) {
  out.entity = tr.entity; out.hitgroup = tr.hitgroup; out.surface = tr.surface; out.dist = tr.dist;
  (out.point ||= new THREE.Vector3()).copy(tr.endpos);
  (out.normal ||= new THREE.Vector3()).copy(tr.normal);
  return out;
}

/** CS:GO backstab test: attacker behind the victim's facing (dot > 0.475, 2D). */
export function isBackstab(attacker, victim) {
  const dx = victim.origin.x - attacker.origin.x, dz = victim.origin.z - attacker.origin.z;
  const l = Math.hypot(dx, dz) || 1;
  const y = (victim.yaw || 0) * Math.PI / 180;
  const fx = Math.cos(y), fz = -Math.sin(y);
  return (dx / l) * fx + (dz / l) * fz > 0.475;
}
