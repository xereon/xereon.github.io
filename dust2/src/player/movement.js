// Source-engine player movement: a line-by-line port of CGameMovement (Source SDK 2013
// game/shared/gamemovement.cpp) plus the CS:GO overrides (cs_gamemovement.cpp): stamina,
// walk/duck speed modifiers, duck amount with spam penalty, CS ladder dampening.
//
// Axes: Three.js Y-up, Source units. Everything Source does on `z` happens on `y` here.
// The same code runs for the local player and for bots (like Source). All state lives on
// the Player; this module owns only scratch memory, so nothing allocates per tick.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { angleVectors, flatVectors, approach } from '../core/mathx.js';
import { MASK_PLAYER, CONTENTS_LADDER, CONTENTS_SOLID } from './collision.js';
import { IN_JUMP, IN_DUCK, IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED } from '../core/input.js';

// ---- tunables (CS:GO defaults) -------------------------------------------------------------
defCvar('sv_accelerate', 5.5, 0, 100, 'ground acceleration (CS:GO 5.5, CS:S 5)');
defCvar('sv_friction', 5.2, 0, 100, 'ground friction');
defCvar('sv_accelerate_use_weapon_speed', 1, 0, 1, 'CS:GO: accel scale follows weapon speed, not walk/duck');
defCvar('sv_stopspeed', 80, 0, 1000, 'friction floor speed');
defCvar('sv_airaccelerate', 12, 0, 1000, 'air acceleration');
defCvar('sv_air_max_wishspeed', 30, 0, 1000, 'air wishspeed cap (enables air strafing)');
defCvar('sv_gravity', 800, 0, 4000, 'world gravity');
defCvar('sv_maxspeed', 320, 0, 2000, 'absolute max player speed');
defCvar('sv_maxvelocity', 3500, 0, 10000, 'per-axis velocity clamp');
defCvar('sv_jump_impulse', 301.993378, 0, 2000, 'jump velocity = sqrt(2*800*57)');
defCvar('sv_stepsize', 18, 0, 64, 'max step-up height');
defCvar('sv_bounce', 0, 0, 2, 'wall bounce in air');
defCvar('sv_staminamax', 80, 0, 100, 'maximum stamina penalty');
defCvar('sv_staminajumpcost', 0.08, 0, 1, 'stamina per u/s of jump velocity');
defCvar('sv_staminalandcost', 0.05, 0, 1, 'stamina per u/s of landing velocity');
defCvar('sv_staminarecoveryrate', 60, 0, 1000, 'stamina recovered per second');
defCvar('sv_enablebunnyhopping', 0, 0, 1, '0 = crop speed to 1.1x max on jump');
defCvar('sv_autobunnyhopping', 0, 0, 1, 'jump while holding space');
defCvar('sv_walk_modifier', 0.52, 0.05, 1, 'shift-walk speed fraction');
defCvar('sv_duck_modifier', 0.34, 0.05, 1, 'crouch speed fraction');
defCvar('sv_duck_time', 0.2, 0.02, 2, 'seconds for a full duck at ideal duck speed');
defCvar('sv_duckspeed_ideal', 8, 1, 20, 'CS:GO m_flDuckSpeed rest value');
defCvar('sv_duckspam_penalty', 2, 0, 8, 'duck speed lost per rapid re-press');
defCvar('sv_duckspam_window', 0.4, 0, 2, 're-press within this many seconds is spam');
defCvar('sv_duckspeed_recover', 3, 0, 50, 'duck speed regained per second');
defCvar('sv_airduck_lift', 9, 0, 18, 'feet raised by an in-air duck (CS:GO crouch-jump = 57+9)');
defCvar('sv_ladder_speed', 200, 0, 1000, 'ladder climb speed');
defCvar('sv_ladder_dampen', 0.2, 0, 1, 'dampen sideways movement on ladders');
defCvar('sv_ladder_angle', -0.707, -1, 1, 'cos of incidence angle for ladder dampening');
defCvar('sv_falldamage_scale', 1, 0, 10, 'fall damage multiplier');
defCvar('sv_footsteps', 1, 0, 1, 'emit footstep events');
defCvar('sv_footstep_speed', 135, 0, 400, 'min speed for audible footsteps (walk/crouch silent)');
defCvar('sv_land_sound_speed', 260, 0, 1000, 'min fall speed for an audible landing (fits CS:GO silent-landing heights at 64 and 128 tick)');
defCvar('sv_tagging_recover', 0.6, 0.01, 10, 'tagging slowdown recovered per second');
defCvar('cl_land_punch', 1, 0, 4, 'scale of the Source rough-landing view roll');
defCvar('mp_solid_players', 1, 0, 1, 'players collide with each other');

// ---- constants ------------------------------------------------------------------------------
export const HULL_MINS = new THREE.Vector3(-16, 0, -16);
export const HULL_MAXS = new THREE.Vector3(16, 72, 16);
export const DUCK_MINS = new THREE.Vector3(-16, 0, -16);
export const DUCK_MAXS = new THREE.Vector3(16, 54, 16);
export const VIEW_STAND = 64;
export const VIEW_DUCK = 46;

const DIST_EPSILON = 0.03125;
const COORD_RESOLUTION = 1 / 32;
const NON_JUMP_VELOCITY = 140;
const MAX_CLIP_PLANES = 5;
const PLAYER_FATAL_FALL_SPEED = 1024;
const PLAYER_MAX_SAFE_FALL_SPEED = 580;
const PLAYER_MIN_BOUNCE_SPEED = 200;
const PLAYER_FALL_PUNCH_THRESHOLD = 350;
const DAMAGE_FOR_FALL_SPEED = 100 / (PLAYER_FATAL_FALL_SPEED - PLAYER_MAX_SAFE_FALL_SPEED);
const BUNNYJUMP_MAX_SPEED_FACTOR = 1.1;
const LADDER_DISTANCE = 2;
const MASK_LADDER = MASK_PLAYER | CONTENTS_LADDER;
const GOLDSRC_FRAMETIME = 1 / 70; // CS:GO stamina slowdown reference frame time
const CLIP_BIAS = 1e-3;

/** SimpleSpline: ease in/out, used by Source for duck eye offsets. */
export const simpleSpline = (v) => { const s = v * v; return 3 * s - 2 * s * v; };

/** Eye height above origin for a duck amount, before the in-air correction. */
export const viewOffsetFor = (duckAmount) => VIEW_STAND + (VIEW_DUCK - VIEW_STAND) * simpleSpline(duckAmount);

// Source's 54-entry unstick table (CreateStuckTable), with its z mapped to our y.
const STUCK_TABLE = (() => {
  const t = [];
  for (let z = -0.125; z <= 0.125; z += 0.125) t.push([0, z, 0]);
  for (let y = -0.125; y <= 0.125; y += 0.125) t.push([0, 0, y]);
  for (let x = -0.125; x <= 0.125; x += 0.125) t.push([x, 0, 0]);
  for (let x = -0.125; x <= 0.125; x += 0.25)
    for (let y = -0.125; y <= 0.125; y += 0.25)
      for (let z = -0.125; z <= 0.125; z += 0.25) t.push([x, z, y]);
  const zi = [0, 1, 6];
  for (const z of zi) t.push([0, z, 0]);
  for (let y = -2; y <= 2; y += 2) t.push([0, 0, y]);
  for (let x = -2; x <= 2; x += 2) t.push([x, 0, 0]);
  for (const z of zi) for (let x = -2; x <= 2; x += 2) for (let y = -2; y <= 2; y += 2) t.push([x, z, y]);
  return t.map(([x, y, z]) => new THREE.Vector3(x, y, z));
})();

/** Our own trace record (collision.js hands out a pooled one we must copy from). */
class MoveTrace {
  constructor() {
    this.fraction = 1; this.endpos = new THREE.Vector3(); this.normal = new THREE.Vector3();
    this.surface = 'default'; this.startSolid = false; this.allSolid = false; this.contents = 0;
    this.entity = null;
  }
  get hit() { return this.fraction < 1; }
}

export class GameMovement {
  constructor() {
    this.p = null; this.dt = 1 / 128;
    this.buttons = 0; this.fmove = 0; this.smove = 0; this.umove = 0;
    this.maxSpeed = 250;   // mv->m_flMaxSpeed after modifiers
    this.walking = false;
    this.av = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
    this.flatF = new THREE.Vector3(); this.flatR = new THREE.Vector3();
    // traces
    this._trA = new MoveTrace(); this._trB = new MoveTrace(); this._trC = new MoveTrace();
    this._trD = new MoveTrace(); this._trQ = new MoveTrace();
    // scratch
    this._v = Array.from({ length: 16 }, () => new THREE.Vector3());
    this._planes = Array.from({ length: MAX_CLIP_PLANES }, () => new THREE.Vector3());
    this._qmin = new THREE.Vector3(); this._qmax = new THREE.Vector3();
    this._ladderWorld = null; this._hasLadders = false;
  }

  // ---- hull helpers ---------------------------------------------------------------------
  mins(ducked = this.p.ducked) { return ducked ? DUCK_MINS : HULL_MINS; }
  maxs(ducked = this.p.ducked) { return ducked ? DUCK_MAXS : HULL_MAXS; }

  /**
   * TracePlayerBBox: world brushes + other players' boxes (players are solid to each other
   * as in CS). Players we already overlap are ignored so stacked spawns can separate.
   */
  trace(start, end, out, mins = this.mins(), maxs = this.maxs(), mask = MASK_PLAYER) {
    const cw = World.collision;
    const tr = cw.hullTrace(mins, maxs, start, end, mask);
    out.fraction = tr.fraction; out.endpos.copy(tr.endpos); out.normal.copy(tr.normal);
    out.surface = tr.surface; out.startSolid = tr.startSolid; out.allSolid = tr.allSolid;
    out.contents = tr.contents || 0; out.entity = null;
    if (mask & CONTENTS_SOLID) this._tracePlayers(start, end, mins, maxs, out);
    return out;
  }

  _tracePlayers(start, end, mins, maxs, out) {
    if (!World.cvar.mp_solid_players) return;
    const ents = World.entities, self = this.p;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e === self || !e.alive || !e.origin || e.solid === false) continue;
      const h = e.ducked ? DUCK_MAXS.y : HULL_MAXS.y;
      // Minkowski-expanded box of the other player
      const lox = e.origin.x - 16 - maxs.x, hix = e.origin.x + 16 - mins.x;
      const loy = e.origin.y - maxs.y, hiy = e.origin.y + h - mins.y;
      const loz = e.origin.z - 16 - maxs.z, hiz = e.origin.z + 16 - mins.z;
      let enter = -1, leave = 1, axis = -1, sign = 0, startout = false;
      let miss = false;
      for (let a = 0; a < 6 && !miss; a++) {
        let d1, d2;
        switch (a) {
          case 0: d1 = start.x - hix; d2 = end.x - hix; break;
          case 1: d1 = lox - start.x; d2 = lox - end.x; break;
          case 2: d1 = start.y - hiy; d2 = end.y - hiy; break;
          case 3: d1 = loy - start.y; d2 = loy - end.y; break;
          case 4: d1 = start.z - hiz; d2 = end.z - hiz; break;
          default: d1 = loz - start.z; d2 = loz - end.z;
        }
        if (d1 > 0) startout = true;
        if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) { miss = true; break; }
        if (d1 <= 0 && d2 <= 0) continue;
        if (d1 > d2) {
          const f = Math.max(0, (d1 - DIST_EPSILON) / (d1 - d2));
          if (f > enter) { enter = f; axis = a >> 1; sign = (a & 1) ? -1 : 1; }
        } else {
          const f = Math.min(1, (d1 + DIST_EPSILON) / (d1 - d2));
          if (f < leave) leave = f;
        }
      }
      if (miss || !startout) continue; // no hit, or already overlapping: ignore
      if (enter < leave && enter > -1 && enter < out.fraction) {
        out.fraction = Math.max(0, enter);
        out.normal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
        out.endpos.lerpVectors(start, end, out.fraction);
        out.surface = 'default'; out.entity = e; out.contents = CONTENTS_SOLID;
      }
    }
  }

  /** TestPlayerPosition: true if the hull at pos is embedded in world geometry. */
  stuckAt(pos, ducked = this.p.ducked) {
    const tr = World.collision.hullTrace(this.mins(ducked), this.maxs(ducked), pos, pos, MASK_PLAYER);
    return tr.startSolid || tr.allSolid;
  }

  // ---- entry point ----------------------------------------------------------------------

  /** CGameMovement::ProcessMovement / PlayerMove for one usercmd. */
  playerMove(p, cmd, dt) {
    if (!World.collision) return;
    this.p = p; this.dt = dt;
    this.buttons = cmd.buttons | 0;
    this.fmove = cmd.forwardmove || 0;
    this.smove = cmd.sidemove || 0;
    this.umove = cmd.upmove || 0;
    angleVectors(p.pitch, p.yaw, this.av);
    flatVectors(p.yaw, this.flatF, this.flatR);

    this.checkParameters();
    this.reduceTimers();

    if (p.moveType !== 'noclip' && p.alive) {
      if (this.checkStuck()) { p.oldButtons = this.buttons; return; }
    }

    // sv_optimizedmovement: walkers keep last tick's ground state
    if (p.moveType !== 'walk') this.categorizePosition();
    else if (p.velocity.y > 250) this.setGround(null);

    if (!p.onGround) p.fallVelocity = -p.velocity.y;

    this.updateStepSound();
    this.duck();

    if (p.alive && p.moveType !== 'noclip') {
      if (!this.ladderMove() && p.moveType === 'ladder') p.moveType = 'walk';
    }

    switch (p.moveType) {
      case 'noclip': this.fullNoClipMove(); break;
      case 'ladder': this.fullLadderMove(); break;
      default: this.fullWalkMove();
    }

    p.oldButtons = this.buttons; // FinishMove
    if (!Number.isFinite(p.origin.x + p.origin.y + p.origin.z)) p.origin.set(0, 0, 0);
  }

  checkParameters() {
    const p = this.p, cv = World.cvar;
    let max = Math.min(cv.sv_maxspeed, p.weaponMaxSpeed());
    max *= p.velocityModifier;                      // CS:GO tagging
    this.walking = !!(this.buttons & IN_SPEED) && p.moveType !== 'ladder';
    if (this.walking) max *= cv.sv_walk_modifier;   // CS:GO m_bIsWalking
    this.baseMaxSpeed = Math.min(cv.sv_maxspeed, p.weaponMaxSpeed());
    this.maxSpeed = max;
    const spd = this.fmove * this.fmove + this.smove * this.smove + this.umove * this.umove;
    if (spd !== 0 && spd > max * max) {
      const r = max / Math.sqrt(spd);
      this.fmove *= r; this.smove *= r; this.umove *= r;
    }
    if (p.frozen || !p.alive) { this.fmove = 0; this.smove = 0; this.umove = 0; }
  }

  reduceTimers() {
    const p = this.p, cv = World.cvar, dt = this.dt;
    if (p.stamina > 0) p.stamina = Math.max(0, p.stamina - dt * cv.sv_staminarecoveryrate);
    p.duckSpeed = approach(p.duckSpeed, cv.sv_duckspeed_ideal, dt * cv.sv_duckspeed_recover);
    if (p.velocityModifier < 1) p.velocityModifier = Math.min(1, p.velocityModifier + dt * cv.sv_tagging_recover);
    if (p.stepSoundTime > 0) p.stepSoundTime = Math.max(0, p.stepSoundTime - 1000 * dt);
  }

  checkVelocity() {
    const v = this.p.velocity, m = World.cvar.sv_maxvelocity;
    if (!Number.isFinite(v.x)) v.x = 0; if (!Number.isFinite(v.y)) v.y = 0; if (!Number.isFinite(v.z)) v.z = 0;
    if (v.x > m) v.x = m; else if (v.x < -m) v.x = -m;
    if (v.y > m) v.y = m; else if (v.y < -m) v.y = -m;
    if (v.z > m) v.z = m; else if (v.z < -m) v.z = -m;
  }

  // ---- stuck ----------------------------------------------------------------------------

  /** CheckStuck (client flavour: try the whole nudge table at once), plus a wider search. */
  checkStuck() {
    const p = this.p;
    if (!this.stuckAt(p.origin)) { p.stuckLast = 0; return false; }
    const base = this._v[0].copy(p.origin), test = this._v[1];
    for (let i = 0; i < STUCK_TABLE.length; i++) {
      test.copy(base).add(STUCK_TABLE[i]);
      if (!this.stuckAt(test)) { p.origin.copy(test); p.stuckLast = 0; return false; }
    }
    // Deviation: Source would keep nudging by the table over many ticks; we search outward
    // so a player dropped inside a brush (spawn, harness pose) always recovers.
    p.stuckLast++;
    for (let r = 1; r <= 40; r += (r < 8 ? 1 : 4)) {
      for (let k = 0; k < 10; k++) {
        const ang = k * Math.PI / 4;
        if (k < 8) test.set(base.x + Math.cos(ang) * r, base.y, base.z + Math.sin(ang) * r);
        else test.set(base.x, base.y + (k === 8 ? r : -r), base.z);
        if (!this.stuckAt(test)) { p.origin.copy(test); p.stuckLast = 0; return false; }
      }
    }
    return true;
  }

  // ---- ground ---------------------------------------------------------------------------

  setGround(tr) {
    const p = this.p;
    if (tr) {
      p.onGround = true;
      p.groundNormal.copy(tr.normal);
      p.groundSurface = tr.surface;
      p.groundEntity = tr.entity;
      p.velocity.y = 0;
    } else {
      p.onGround = false;
      p.groundEntity = null;
    }
  }

  tryTouchGroundInQuadrants(start, end, pm) {
    const mn = this.mins(), mx = this.maxs();
    const qmin = this._qmin, qmax = this._qmax, q = this._trQ;
    for (let i = 0; i < 4; i++) {
      // -x-z, +x+z, -x+z, +x-z
      const px = i === 1 || i === 3, pz = i === 1 || i === 2;
      qmin.set(px ? Math.max(0, mn.x) : mn.x, mn.y, pz ? Math.max(0, mn.z) : mn.z);
      qmax.set(px ? mx.x : Math.min(0, mx.x), mx.y, pz ? mx.z : Math.min(0, mx.z));
      this.trace(start, end, q, qmin, qmax);
      if (q.fraction < 1 && q.normal.y >= 0.7) {
        // keep the original fraction/endpos (don't move onto the quadrant floor)
        pm.normal.copy(q.normal); pm.surface = q.surface; pm.entity = q.entity;
        return true;
      }
    }
    return false;
  }

  categorizePosition() {
    const p = this.p;
    p.surfaceFriction = 1;
    if (p.moveType === 'noclip') { this.setGround(null); return; }
    const zvel = p.velocity.y;
    const movingUp = zvel > 0, movingUpRapidly = zvel > NON_JUMP_VELOCITY;
    if (movingUpRapidly || (movingUp && p.moveType === 'ladder')) { this.setGround(null); return; }
    const point = this._v[2].copy(p.origin); point.y -= 2;
    const pm = this.trace(p.origin, point, this._trA);
    if (!(pm.fraction < 1) || pm.normal.y < 0.7) {
      if (this.tryTouchGroundInQuadrants(p.origin, point, pm)) this.setGround(pm);
      else {
        this.setGround(null);
        if (p.velocity.y > 0 && p.moveType !== 'noclip') p.surfaceFriction = 0.25;
      }
    } else this.setGround(pm);
    // Quake/GoldSrc: drop onto the ground we found so we never hover up to 2u after landing
    if (p.onGround && p.moveType === 'walk' && !pm.startSolid && !pm.allSolid && pm.fraction > 0 && pm.fraction < 1) {
      p.origin.copy(pm.endpos);
    }
  }

  // ---- gravity / friction / accel -------------------------------------------------------

  startGravity() {
    this.p.velocity.y -= World.cvar.sv_gravity * 0.5 * this.dt;
    this.checkVelocity();
  }

  finishGravity() {
    this.p.velocity.y -= World.cvar.sv_gravity * 0.5 * this.dt;
    this.checkVelocity();
  }

  friction() {
    const p = this.p, v = p.velocity, cv = World.cvar;
    const speed = v.length();
    if (speed < 0.1) return;
    let drop = 0;
    if (p.onGround) {
      const friction = cv.sv_friction * p.surfaceFriction;
      const control = speed < cv.sv_stopspeed ? cv.sv_stopspeed : speed;
      drop += control * friction * this.dt;
    }
    let newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    if (newspeed !== speed) v.multiplyScalar(newspeed / speed);
  }

  /**
   * CCSGameMovement::Accelerate. CS:GO scales acceleration by max(250, wishspeed) capped to
   * the weapon's speed (sv_accelerate_use_weapon_speed), NOT by the walk/duck-reduced
   * wishspeed — otherwise crouch-walking (5.5*85) would barely beat stopspeed friction.
   */
  accelerate(wishdir, wishspeed, accel) {
    const p = this.p, v = p.velocity;
    if (!p.alive) return;
    const currentspeed = v.dot(wishdir);
    const addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) return;
    let goal = Math.max(250, wishspeed);
    if (World.cvar.sv_accelerate_use_weapon_speed) goal *= Math.min(1, this.baseMaxSpeed / 250);
    let accelspeed = accel * this.dt * goal * p.surfaceFriction;
    if (accelspeed > addspeed) accelspeed = addspeed;
    v.addScaledVector(wishdir, accelspeed);
  }

  airAccelerate(wishdir, wishspeed, accel) {
    const p = this.p, v = p.velocity;
    if (!p.alive) return;
    let wishspd = wishspeed;
    const cap = World.cvar.sv_air_max_wishspeed;
    if (wishspd > cap) wishspd = cap;
    const currentspeed = v.dot(wishdir);
    const addspeed = wishspd - currentspeed;
    if (addspeed <= 0) return;
    let accelspeed = accel * wishspeed * this.dt * p.surfaceFriction;
    if (accelspeed > addspeed) accelspeed = addspeed;
    v.addScaledVector(wishdir, accelspeed);
  }

  /** wishvel from flat view vectors; returns wishspeed, fills wishdir. */
  _wish(wishdir) {
    const f = this.flatF, r = this.flatR;
    wishdir.set(f.x * this.fmove + r.x * this.smove, 0, f.z * this.fmove + r.z * this.smove);
    let wishspeed = wishdir.length();
    if (wishspeed > 0) wishdir.multiplyScalar(1 / wishspeed);
    if (wishspeed !== 0 && wishspeed > this.maxSpeed) wishspeed = this.maxSpeed;
    return wishspeed;
  }

  // ---- walking --------------------------------------------------------------------------

  fullWalkMove() {
    const p = this.p;
    this.startGravity();
    if (this.buttons & IN_JUMP) this.checkJumpButton();
    else p.oldButtons &= ~IN_JUMP;

    if (p.onGround) { p.velocity.y = 0; this.friction(); }
    this.checkVelocity();
    if (p.onGround) this.walkMove();
    else this.airMove();

    this.categorizePosition();
    this.checkVelocity();
    this.finishGravity();
    if (p.onGround) p.velocity.y = 0;
    this.checkFalling();
  }

  walkMove() {
    const p = this.p, v = p.velocity, org = p.origin, cv = World.cvar;
    // CS:GO: stamina penalty bleeds horizontal speed (frame-rate independent GoldSrc emulation)
    if (p.stamina > 0) {
      let ratio = (cv.sv_staminamax - p.stamina) / cv.sv_staminamax;
      ratio = Math.pow(Math.max(0, ratio), this.dt / GOLDSRC_FRAMETIME);
      v.x *= ratio; v.z *= ratio;
    }
    const oldground = p.onGround;
    const wishdir = this._v[3];
    const wishspeed = this._wish(wishdir);

    v.y = 0;
    this.accelerate(wishdir, wishspeed, cv.sv_accelerate);
    v.y = 0;

    const spd = v.length();
    if (spd < 1) { v.set(0, 0, 0); return; }

    const dest = this._v[4].set(org.x + v.x * this.dt, org.y, org.z + v.z * this.dt);
    const pm = this.trace(org, dest, this._trB);
    if (pm.fraction === 1) {
      org.copy(pm.endpos);
      this.stayOnGround();
      return;
    }
    if (!oldground) return;
    this.stepMove(dest, pm);
    this.stayOnGround();
  }

  stepMove(dest, trace) {
    const p = this.p, org = p.origin, v = p.velocity, cv = World.cvar;
    const endPos = this._v[5].copy(dest);
    const pos = this._v[6].copy(org), vel = this._v[7].copy(v);

    // slide move down
    this.tryPlayerMove(endPos, trace);
    const downPos = this._v[8].copy(org), downVel = this._v[9].copy(v);

    // reset, move up a stair height
    org.copy(pos); v.copy(vel);
    endPos.copy(org); endPos.y += cv.sv_stepsize + DIST_EPSILON;
    let tr = this.trace(org, endPos, this._trC);
    if (!tr.startSolid && !tr.allSolid) org.copy(tr.endpos);

    // slide move up
    this.tryPlayerMove();

    // move down a stair
    endPos.copy(org); endPos.y -= cv.sv_stepsize + DIST_EPSILON;
    tr = this.trace(org, endPos, this._trC);
    if (tr.normal.y < 0.7) {
      org.copy(downPos); v.copy(downVel);
      return;
    }
    if (!tr.startSolid && !tr.allSolid) org.copy(tr.endpos);
    const upPos = this._v[10].copy(org);

    const downDist = (downPos.x - pos.x) ** 2 + (downPos.z - pos.z) ** 2;
    const upDist = (upPos.x - pos.x) ** 2 + (upPos.z - pos.z) ** 2;
    if (downDist > upDist) { org.copy(downPos); v.copy(downVel); }
    else v.y = downVel.y;
  }

  stayOnGround() {
    const p = this.p, org = p.origin;
    const start = this._v[11].copy(org); start.y += 2;
    const end = this._v[12].copy(org); end.y -= World.cvar.sv_stepsize;
    let tr = this.trace(org, start, this._trC);
    start.copy(tr.endpos);
    tr = this.trace(start, end, this._trC);
    if (tr.fraction > 0 && tr.fraction < 1 && !tr.startSolid && tr.normal.y >= 0.7) {
      if (Math.abs(org.y - tr.endpos.y) > 0.5 * COORD_RESOLUTION) org.copy(tr.endpos);
    }
  }

  airMove() {
    const wishdir = this._v[3];
    const wishspeed = this._wish(wishdir);
    this.airAccelerate(wishdir, wishspeed, World.cvar.sv_airaccelerate);
    this.tryPlayerMove();
  }

  clipVelocity(inV, n, out, overbounce) {
    const backoff = inV.dot(n) * overbounce;
    out.set(inV.x - n.x * backoff, inV.y - n.y * backoff, inV.z - n.z * backoff);
    const adjust = out.dot(n);
    if (adjust < 0) out.addScaledVector(n, -adjust);
    // Deviation: a 0.001 u/s outward bias. collision.js uses Quake's `d2 >= d1` early-out, so
    // an exactly parallel slide that rounds a hair inward reports fraction 0 and glues the
    // player to slopes/diagonal walls. Source's cmodel (`d1 > 0 && d2 > 0`) never hits this.
    out.addScaledVector(n, CLIP_BIAS);
  }

  /** The Quake/Source slide move: up to 4 bumps, clip planes, crease handling. */
  tryPlayerMove(firstDest = null, firstTrace = null) {
    const p = this.p, v = p.velocity, org = p.origin, cv = World.cvar;
    const planes = this._planes;
    const original = this._v[13].copy(v), primal = this._v[14].copy(v);
    const newVel = this._v[15].set(0, 0, 0);
    const end = this._v[2];
    let blocked = 0, numplanes = 0, allFraction = 0, timeLeft = this.dt;

    for (let bump = 0; bump < 4; bump++) {
      if (v.x === 0 && v.y === 0 && v.z === 0) break;
      end.copy(org).addScaledVector(v, timeLeft);
      const pm = (firstDest && end.equals(firstDest)) ? firstTrace : this.trace(org, end, this._trD);
      allFraction += pm.fraction;
      if (pm.allSolid) { v.set(0, 0, 0); return 4; }
      if (pm.fraction > 0) {
        org.copy(pm.endpos);
        original.copy(v);
        numplanes = 0;
      }
      if (pm.fraction === 1) break;

      if (pm.normal.y > 0.7) blocked |= 1;
      if (pm.normal.y === 0) blocked |= 2;
      timeLeft -= timeLeft * pm.fraction;

      if (numplanes >= MAX_CLIP_PLANES) { v.set(0, 0, 0); break; }
      planes[numplanes++].copy(pm.normal);

      if (numplanes === 1 && p.moveType === 'walk' && !p.onGround) {
        const n0 = planes[0];
        if (n0.y > 0.7) this.clipVelocity(original, n0, newVel, 1);
        else this.clipVelocity(original, n0, newVel, 1 + cv.sv_bounce * (1 - p.surfaceFriction));
        v.copy(newVel);
        original.copy(newVel);
      } else {
        let i = 0;
        for (; i < numplanes; i++) {
          this.clipVelocity(original, planes[i], v, 1);
          let j = 0;
          for (; j < numplanes; j++) if (j !== i && v.dot(planes[j]) < 0) break;
          if (j === numplanes) break;
        }
        if (i === numplanes) {
          // go along the crease
          if (numplanes !== 2) { v.set(0, 0, 0); break; }
          const dir = this._v[3].crossVectors(planes[0], planes[1]).normalize();
          const d = dir.dot(v);
          v.copy(dir).multiplyScalar(d);
          v.addScaledVector(planes[0], CLIP_BIAS).addScaledVector(planes[1], CLIP_BIAS);
        }
        if (v.dot(primal) <= 0) { v.set(0, 0, 0); break; }
      }
      firstDest = null;
    }
    if (allFraction === 0) v.set(0, 0, 0);
    return blocked;
  }

  // ---- jumping / landing ----------------------------------------------------------------

  preventBunnyJumping() {
    const p = this.p;
    const maxscaled = BUNNYJUMP_MAX_SPEED_FACTOR * this.baseMaxSpeed;
    if (maxscaled <= 0) return;
    const spd = p.velocity.length();
    if (spd <= maxscaled) return;
    p.velocity.multiplyScalar(maxscaled / spd);
  }

  checkJumpButton() {
    const p = this.p, cv = World.cvar;
    if (!p.alive) { p.oldButtons |= IN_JUMP; return false; }
    if (!p.onGround) { p.oldButtons |= IN_JUMP; return false; }
    if ((p.oldButtons & IN_JUMP) && !cv.sv_autobunnyhopping) return false; // don't pogo stick
    if (p.frozen) return false;
    if (!cv.sv_enablebunnyhopping) this.preventBunnyJumping();

    this.setGround(null);
    this._emitStep(1.0, 'step', 'jump');
    World.emit('jump', { ent: p, surface: p.groundSurface, volume: 1, fallSpeed: 0 });

    // bots always crouch-jump (CCSGameMovement::CheckJumpButton)
    if (p.isBot && !(this.buttons & IN_DUCK)) { p.duckUntilOnGround = true; this.finishDuck(); }

    const impulse = cv.sv_jump_impulse;
    if (p.ducked || p.duckAmount > 0) p.velocity.y = impulse;
    else p.velocity.y += impulse;

    // CS:GO stamina: chained jumps are lower
    if (p.stamina > 0) p.velocity.y *= Math.max(0, (cv.sv_staminamax - p.stamina) / cv.sv_staminamax);
    p.stamina = Math.min(cv.sv_staminamax, p.stamina + cv.sv_staminajumpcost * p.velocity.y);

    this.finishGravity();
    p.jumpSerial++;
    p.oldButtons |= IN_JUMP;
    return true;
  }

  checkFalling() {
    const p = this.p, cv = World.cvar;
    if (!p.onGround || p.fallVelocity <= 0) return;
    const fv = p.fallVelocity;
    let fvol = 0;
    if (p.alive && fv >= PLAYER_FALL_PUNCH_THRESHOLD) {
      fvol = 0.5;
      if (fv > PLAYER_MAX_SAFE_FALL_SPEED) {
        const dmg = (fv - PLAYER_MAX_SAFE_FALL_SPEED) * DAMAGE_FOR_FALL_SPEED * 1.25 * cv.sv_falldamage_scale;
        if (dmg > 0) p.takeDamage?.({ amount: dmg, hitgroup: 0, attacker: null, weapon: 'fall', type: 'fall' });
        fvol = 1.0;
      } else if (fv > PLAYER_MAX_SAFE_FALL_SPEED / 2) fvol = 0.85;
      else if (fv < PLAYER_MIN_BOUNCE_SPEED) fvol = 0;
      // PlayerRoughLandingEffects: roll the view a little
      if (fvol > 0) {
        p.stepSoundTime = 400;
        p.viewPunch.roll = fv * 0.013 * cv.cl_land_punch;
      }
    }
    // OnLand (CS:GO): stamina penalty, landing sound, events
    p.stamina = Math.min(cv.sv_staminamax, p.stamina + cv.sv_staminalandcost * fv);
    const audible = fv >= cv.sv_land_sound_speed;
    const vol = audible ? Math.max(fvol, 0.5) * (p.ducked ? 0.65 : 1) : 0;
    if (audible) this._emitStep(vol, 'step', 'land');
    p.landSpeed = fv;
    p.landSerial++;
    World.emit('land', { ent: p, fallSpeed: fv, surface: p.groundSurface, volume: vol });
    p.fallVelocity = 0;
  }

  // ---- ducking (CS:GO duck amount model on top of Source's hull logic) -----------------

  duck() {
    const p = this.p, cv = World.cvar, dt = this.dt;
    const pressed = (p.oldButtons ^ this.buttons) & this.buttons;
    const inAir = !p.onGround;
    if (!p.alive) return;

    if (p.duckUntilOnGround && (p.onGround || p.moveType === 'ladder')) p.duckUntilOnGround = false;

    // CS:GO duck-spam penalty: rapid re-presses slow the transition
    if (pressed & IN_DUCK) {
      const now = p.simTime;
      if (now - p.lastDuckPress < cv.sv_duckspam_window) p.duckSpeed = Math.max(1.5, p.duckSpeed - cv.sv_duckspam_penalty);
      p.lastDuckPress = now;
    }
    const rate = (p.duckSpeed / cv.sv_duckspeed_ideal) / cv.sv_duck_time; // duck amount per second
    const wantDuck = !!(this.buttons & IN_DUCK) || p.duckUntilOnGround;

    if (wantDuck && p.moveType !== 'noclip') {
      if (inAir && !p.ducked) this.finishDuck();            // in air: hull shrinks at once
      p.duckAmount = approach(p.duckAmount, 1, dt * rate);
      if (!p.ducked && p.duckAmount >= 1) this.finishDuck(); // on ground: when fully down
      p.ducking = p.duckAmount < 1;
    } else if (p.ducked || p.duckAmount > 0) {
      if (!p.ducked || this.canUnduck()) {
        if (inAir && p.ducked) this.finishUnDuck();
        p.duckAmount = approach(p.duckAmount, 0, dt * rate);
        if (p.ducked && p.duckAmount <= 0) this.finishUnDuck();
        p.ducking = p.duckAmount > 0;
      } else {
        // under something: stay ducked until we can stand
        p.duckAmount = approach(p.duckAmount, 1, dt * rate);
        p.ducking = false;
      }
    }
    // the in-air lift correction fades out with the duck transition
    if (p.viewOffsetCorr !== 0) p.viewOffsetCorr = approach(p.viewOffsetCorr, 0, dt * rate * cv.sv_airduck_lift);

    this.handleDuckingSpeedCrop();
  }

  /** CS:GO: ducked players on the ground move at 34% (lerped by duck amount). */
  handleDuckingSpeedCrop() {
    const p = this.p, cv = World.cvar;
    if (!p.onGround || p.duckAmount <= 0) return;
    const duckFrac = 1 + (cv.sv_duck_modifier - 1) * p.duckAmount;
    const cur = this.walking ? cv.sv_walk_modifier : 1;
    if (duckFrac >= cur) return;
    const crop = duckFrac / cur;
    this.fmove *= crop; this.smove *= crop; this.umove *= crop;
  }

  finishDuck() {
    const p = this.p;
    if (p.ducked) return;
    p.ducked = true;
    if (!p.onGround) {
      const lift = World.cvar.sv_airduck_lift;
      p.origin.y += lift;
      p.viewOffsetCorr -= lift;
    }
    this.fixPlayerCrouchStuck(true);
    this.categorizePosition();
  }

  canUnduck() {
    const p = this.p;
    const newOrigin = this._v[11].copy(p.origin);
    if (!p.onGround) newOrigin.y -= World.cvar.sv_airduck_lift;
    const tr = this.trace(p.origin, newOrigin, this._trC, HULL_MINS, HULL_MAXS);
    return !(tr.startSolid || tr.fraction !== 1);
  }

  finishUnDuck() {
    const p = this.p;
    if (!p.onGround) {
      const lift = World.cvar.sv_airduck_lift;
      p.origin.y -= lift;
      p.viewOffsetCorr += lift;
    }
    p.ducked = false;
    this.categorizePosition();
  }

  fixPlayerCrouchStuck(upward) {
    const p = this.p;
    if (!this.stuckAt(p.origin)) return;
    const test = this._v[12].copy(p.origin);
    for (let i = 0; i < 36; i++) {
      p.origin.y += upward ? 1 : -1;
      if (!this.stuckAt(p.origin)) return;
    }
    p.origin.copy(test);
  }

  // ---- ladders --------------------------------------------------------------------------

  _mapHasLadders() {
    const cw = World.collision;
    if (this._ladderWorld !== cw) {
      this._ladderWorld = cw;
      this._hasLadders = !!cw?.brushes?.some((b) => b.contents & CONTENTS_LADDER);
    }
    return this._hasLadders;
  }

  ladderMove() {
    const p = this.p, cv = World.cvar;
    if (p.moveType === 'noclip' || !this._mapHasLadders()) return false;
    const wishdir = this._v[3];
    const f = this.av.forward, r = this.av.right;
    if (p.moveType === 'ladder') wishdir.copy(p.ladderNormal).negate();
    else if (this.fmove || this.smove) {
      wishdir.set(0, 0, 0).addScaledVector(f, this.fmove).addScaledVector(r, this.smove).normalize();
    } else return false;

    const end = this._v[4].copy(p.origin).addScaledVector(wishdir, LADDER_DISTANCE);
    const pm = this.trace(p.origin, end, this._trB, this.mins(), this.maxs(), MASK_LADDER);
    if (pm.fraction === 1 || !(pm.contents & CONTENTS_LADDER)) return false;

    p.moveType = 'ladder';
    p.ladderNormal.copy(pm.normal);
    p.groundSurface = pm.surface;

    const floor = this._v[5].copy(p.origin); floor.y += this.mins().y - 1;
    const onFloor = !!(World.collision.pointContents(floor) & CONTENTS_SOLID) || p.onGround;

    let climb = cv.sv_ladder_speed * (this.buttons & IN_SPEED ? cv.sv_walk_modifier : 1);
    if (p.frozen) climb = 0;
    const fwd = (this.buttons & (IN_FORWARD | IN_BACK)) ? ((this.buttons & IN_FORWARD ? 1 : 0) - (this.buttons & IN_BACK ? 1 : 0)) : Math.sign(this.fmove);
    const side = (this.buttons & (IN_MOVELEFT | IN_MOVERIGHT)) ? ((this.buttons & IN_MOVERIGHT ? 1 : 0) - (this.buttons & IN_MOVELEFT ? 1 : 0)) : Math.sign(this.smove);
    const forwardSpeed = fwd * climb, rightSpeed = side * climb;
    const v = p.velocity, n = pm.normal;

    if (this.buttons & IN_JUMP) {
      p.moveType = 'walk';
      v.copy(n).multiplyScalar(270);
    } else if (forwardSpeed !== 0 || rightSpeed !== 0) {
      const velocity = this._v[6].copy(f).multiplyScalar(forwardSpeed).addScaledVector(r, rightSpeed);
      const perp = this._v[7].set(0, 1, 0).cross(n).normalize();
      const normal = velocity.dot(n);
      const cross = this._v[8].copy(n).multiplyScalar(normal);
      const lateral = this._v[9].subVectors(velocity, cross);
      const tmp = this._v[10].crossVectors(n, perp);
      // CS: make ladders easier to climb
      const tmpDist = tmp.dot(lateral), perpDist = perp.dot(lateral);
      const angleVec = this._v[12].copy(perp).multiplyScalar(perpDist).add(cross).normalize();
      if (angleVec.dot(n) < cv.sv_ladder_angle) {
        lateral.copy(tmp).multiplyScalar(tmpDist).addScaledVector(perp, cv.sv_ladder_dampen * perpDist);
      }
      v.copy(lateral).addScaledVector(tmp, -normal);
      if (onFloor && normal > 0) v.addScaledVector(n, cv.sv_ladder_speed);
    } else v.set(0, 0, 0);
    return true;
  }

  fullLadderMove() {
    const p = this.p;
    if (this.buttons & IN_JUMP) this.checkJumpButton();
    else p.oldButtons &= ~IN_JUMP;
    this.tryPlayerMove();
  }

  // ---- noclip (debug / spectating) ------------------------------------------------------

  fullNoClipMove() {
    const p = this.p, v = p.velocity, dt = this.dt;
    const f = this.av.forward, r = this.av.right;
    const factor = (this.buttons & IN_SPEED) ? 1 : 3;
    const wish = this._v[3].set(0, 0, 0).addScaledVector(f, this.fmove).addScaledVector(r, this.smove);
    if (this.buttons & IN_JUMP) wish.y += 250;
    if (this.buttons & IN_DUCK) wish.y -= 250;
    const target = this._v[4].copy(wish).multiplyScalar(factor);
    const k = 1 - Math.exp(-10 * dt);
    v.lerp(target, k);
    p.origin.addScaledVector(v, dt);
    p.onGround = false;
  }

  // ---- footsteps ------------------------------------------------------------------------

  /** CBasePlayer::UpdateStepSound with CS thresholds (walking / crouch-walking are silent). */
  updateStepSound() {
    const p = this.p, cv = World.cvar;
    if (p.stepSoundTime > 0) return;
    if (!cv.sv_footsteps || p.frozen || p.moveType === 'noclip' || !p.alive) return;
    const v = p.velocity;
    const speed = v.length();
    const groundspeed = Math.hypot(v.x, v.z);
    const ladder = p.moveType === 'ladder';
    const velwalk = ladder ? cv.sv_footstep_speed * 0.5 : cv.sv_footstep_speed;
    if (speed < velwalk || !(ladder || (p.onGround && groundspeed > 0.0001))) return;
    const walking = speed < 190;
    let vol;
    if (ladder) { vol = 0.5; p.stepSoundTime = 350; }
    else { vol = walking ? 0.2 : 0.5; p.stepSoundTime = walking ? 400 : 300; }
    if (p.ducked) { vol *= 0.65; p.stepSoundTime += 100; }
    this._emitStep(vol, ladder ? 'ladder' : 'step');
  }

  /** footstep payload: CONTRACT §2 {ent, surface, volume, kind} + foot/pos/speed, and a
   *  `cause` of 'jump' | 'land' for the step sounds Source plays on takeoff and touchdown. */
  _emitStep(volume, kind, cause = null) {
    const p = this.p;
    if (!World.cvar.sv_footsteps) return;
    p.stepSide ^= 1;
    World.emit('footstep', {
      ent: p, surface: p.groundSurface || 'default', volume, kind, foot: p.stepSide, cause,
      pos: p.origin, speed: Math.hypot(p.velocity.x, p.velocity.z),
    });
  }
}

export const gameMovement = new GameMovement();
