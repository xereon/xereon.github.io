// Player entity (CONTRACT §11). Local player and bots are the same class running the same
// Source movement (movement.js); bots only differ in where their usercmds come from.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { gameMovement, viewOffsetFor, VIEW_STAND, HULL_MAXS, DUCK_MAXS } from './movement.js';
import { FirstPersonCamera } from './camera.js';

defCvar('weapon_recoil_decay2_exp', 8, 0, 100, 'aim punch exponential decay');
defCvar('weapon_recoil_decay2_lin', 18, 0, 100, 'aim punch linear decay (deg/s)');
defCvar('weapon_recoil_vel_decay', 4.5, 0, 100, 'aim punch velocity decay');
defCvar('view_punch_decay', 18, 0, 100, 'view punch exponential decay');
defCvar('sv_damage_flinch', 1, 0, 4, 'aim punch when shot without armour (CS:GO)');
defCvar('noclip', 0, 0, 1, 'local player flies through walls (debug)');

const HG_HEAD = 1, HG_CHEST = 2, HG_STOMACH = 3, HG_LARM = 4, HG_RARM = 5, HG_LLEG = 6, HG_RLEG = 7;
const ARMOR_BONUS = 0.5; // CS: each point of armour absorbs two points of damage

let nextId = 1;

// ---- lazy character / hitbox modules (character agent, may not exist yet) -----------------
let charMod = null, hitMod = null, modPromise = null;
function loadCharacterModules() {
  if (!modPromise) {
    modPromise = Promise.all([
      import('./character.js').catch(() => null),
      import('./hitboxes.js').catch(() => null),
    ]).then(([c, h]) => { charMod = c; hitMod = h; return c; });
  }
  return modPromise;
}

const _tmp = new THREE.Vector3();

/** Ray vs sphere; returns t or -1. dir must be normalised. */
function raySphere(sx, sy, sz, dx, dy, dz, cx, cy, cz, r) {
  const ox = sx - cx, oy = sy - cy, oz = sz - cz;
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** Ray vs vertical capsule (axis x=cx,z=cz, y in [y0,y1], radius r); returns t or -1. */
function rayVCapsule(sx, sy, sz, dx, dy, dz, cx, y0, y1, cz, r) {
  let best = -1;
  // infinite cylinder, then clamp to segment
  const ox = sx - cx, oz = sz - cz;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b = ox * dx + oz * dz;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const yy = sy + dy * t;
      if (t >= 0 && yy >= y0 && yy <= y1) best = t;
      else if (c <= 0) { // start inside the infinite cylinder
        const yy0 = sy;
        if (yy0 >= y0 && yy0 <= y1) best = 0;
      }
    }
  }
  const t0 = raySphere(sx, sy, sz, dx, dy, dz, cx, y0, cz, r);
  if (t0 >= 0 && (best < 0 || t0 < best)) best = t0;
  const t1 = raySphere(sx, sy, sz, dx, dy, dz, cx, y1, cz, r);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  return best;
}

export class Player {
  constructor({ team = 'T', isBot = false, name = null, isLocal = false } = {}) {
    // identity
    this.id = nextId++;
    this.team = team;
    this.isBot = !!isBot;
    this.isLocal = !!isLocal;
    this.name = name || (isLocal ? 'Player' : `${isBot ? 'BOT ' : ''}${team}${this.id}`);

    // state
    this.alive = true;
    this.health = 100;
    this.armor = 0;
    this.helmet = false;
    this.money = 800;
    this.defuser = false;
    this.origin = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.pitch = 0;
    this.yaw = 0;
    this.buttons = 0;
    this.onGround = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'default';
    this.groundEntity = null;
    this.ducked = false;          // using the crouch hull (FL_DUCKING)
    this.ducking = false;         // in a duck/unduck transition
    this.duckAmount = 0;          // 0..1 (CS:GO m_flDuckAmount)
    this.duckSpeed = 8;           // CS:GO m_flDuckSpeed (spam penalty lowers it)
    this.lastDuckPress = -1e9;
    this.duckUntilOnGround = false;
    this.viewOffsetCorr = 0;      // absorbs the in-air duck hull shift so the eye stays put
    this.eyeHeight = VIEW_STAND;
    this.moveType = 'walk';       // 'walk' | 'ladder' | 'noclip'
    this.ladderNormal = new THREE.Vector3();
    this.oldButtons = 0;
    this.stamina = 0;
    this.fallVelocity = 0;
    this.surfaceFriction = 1;
    this.velocityModifier = 1;    // CS:GO tagging (being shot slows you)
    this.stepSoundTime = 0;
    this.stepSide = 0;
    this.stuckLast = 0;
    this.frozen = false;          // freeze time / planting: no movement, looking allowed
    this.solid = true;
    this.simTime = 0;
    this.landSpeed = 0; this.landSerial = 0; this.jumpSerial = 0;
    this.maxSpeedOverride = null; // rules/weapons may clamp speed (e.g. defusing)
    this.fov = null;              // desired horizontal FOV @4:3 (null = cvar fov); scopes set it
    this.fovRate = 40;

    // punch — WeaponSystem writes, we decay + the camera applies
    this.viewPunch = { pitch: 0, yaw: 0, roll: 0 };
    this.aimPunch = { pitch: 0, yaw: 0, roll: 0 };
    this.aimPunchVel = { pitch: 0, yaw: 0, roll: 0 };
    this.prevViewPunch = { pitch: 0, yaw: 0, roll: 0 };
    this.prevAimPunch = { pitch: 0, yaw: 0, roll: 0 };

    // interpolation (render-rate)
    this.prevOrigin = new THREE.Vector3();
    this.prevEyeHeight = VIEW_STAND;
    this.renderOrigin = new THREE.Vector3();
    this._cmdTime = -1;

    // weapons — WeaponSystem owns the contents
    this.inventory = { primary: null, secondary: null, knife: null, grenades: [], c4: null, taser: null };
    this.active = null;

    this.model = null;
    this.camera = this.isLocal ? new FirstPersonCamera() : null;
    this.lastDamage = null;
    this._hit = { t: 0, hitgroup: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
    this._frameStamp = -1;
  }

  /** Max speed from the active weapon (CS: knife 250, rifles 215-225, AWP 200/100 scoped). */
  weaponMaxSpeed() {
    if (this.maxSpeedOverride != null) return this.maxSpeedOverride;
    const w = this.active;
    if (w?.maxSpeed != null) return w.maxSpeed > 0 ? w.maxSpeed : 250; // instance value wins
    let s = w?.def?.maxSpeed ?? 250;
    if (w && (w.zoomLevel > 0 || w.scoped || w.alt)) s = w.def?.maxSpeedAlt ?? w.def?.maxSpeedZoom ?? s;
    return s > 0 ? s : 250;
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.origin.x, this.origin.y + this.eyeHeight, this.origin.z);
  }

  get hullHeight() { return this.ducked ? DUCK_MAXS.y : HULL_MAXS.y; }
  /** Horizontal speed in u/s (cl_showpos "vel"). */
  get speed2D() { return Math.hypot(this.velocity.x, this.velocity.z); }

  /** Teleport so the eye is at `eye` (harness poses, spectating). */
  setPose(eye, pitch = 0, yaw = 0) {
    this.origin.set(eye.x, eye.y - this.eyeHeight, eye.z);
    this.velocity.set(0, 0, 0);
    this.pitch = pitch; this.yaw = yaw;
    this.onGround = false;
    this.moveType = this.moveType === 'noclip' ? 'noclip' : 'walk';
    this._snapInterp();
    if (this.isLocal && World.input) { World.input.pitch = pitch; World.input.yaw = yaw; }
  }

  _snapInterp() {
    this.prevOrigin.copy(this.origin);
    this.prevEyeHeight = this.eyeHeight;
    this.renderOrigin.copy(this.origin);
    Object.assign(this.prevViewPunch, this.viewPunch);
    Object.assign(this.prevAimPunch, this.aimPunch);
    this.camera?.reset();
  }

  /** One simulation tick (Source PlayerMove). Called at World.tickInterval. */
  runCommand(cmd, dt) {
    this.prevOrigin.copy(this.origin);
    this.prevEyeHeight = this.eyeHeight;
    Object.assign(this.prevViewPunch, this.viewPunch);
    Object.assign(this.prevAimPunch, this.aimPunch);
    this._cmdTime = World.time;
    this.simTime += dt;

    if (World.cameraOverride && this.isLocal) {
      this.pitch = cmd.pitch; this.yaw = cmd.yaw;
      return;
    }
    this.pitch = cmd.pitch;
    this.yaw = cmd.yaw;
    this.buttons = cmd.buttons | 0;
    if (this.isLocal) {
      const nc = !!World.cvar.noclip;
      if (nc && this.moveType !== 'noclip') this.moveType = 'noclip';
      else if (!nc && this.moveType === 'noclip') this.moveType = 'walk';
    }

    if (this.alive) gameMovement.playerMove(this, cmd, dt);
    else this.velocity.set(0, 0, 0);

    this.eyeHeight = viewOffsetFor(this.duckAmount) + this.viewOffsetCorr;
    this.decayPunch(dt);
  }

  /** CS:GO DecayAimPunchAngle / view punch decay. */
  decayPunch(dt) {
    const cv = World.cvar;
    decayAngles(this.aimPunch, cv.weapon_recoil_decay2_exp, cv.weapon_recoil_decay2_lin, dt);
    const av = this.aimPunchVel;
    if (av.pitch || av.yaw || av.roll) {
      this.aimPunch.pitch += av.pitch * dt * 0.5;
      this.aimPunch.yaw += av.yaw * dt * 0.5;
      this.aimPunch.roll += av.roll * dt * 0.5;
      const k = Math.exp(-cv.weapon_recoil_vel_decay * dt);
      av.pitch *= k; av.yaw *= k; av.roll *= k;
      this.aimPunch.pitch += av.pitch * dt * 0.5;
      this.aimPunch.yaw += av.yaw * dt * 0.5;
      this.aimPunch.roll += av.roll * dt * 0.5;
      if (Math.abs(av.pitch) + Math.abs(av.yaw) + Math.abs(av.roll) < 1e-3) { av.pitch = 0; av.yaw = 0; av.roll = 0; }
    }
    decayAngles(this.viewPunch, cv.view_punch_decay, 0, dt);
  }

  /** Render-rate update. Local: first-person camera. Remote: character model. */
  frame(dt, alpha = World.alpha ?? 1) {
    if (this._frameStamp === World.frame) return; // already updated this render frame
    this._frameStamp = World.frame;
    // If no tick ran our command since the last one, don't interpolate stale deltas.
    if (this._cmdTime !== World.time) {
      this.prevOrigin.copy(this.origin);
      this.prevEyeHeight = this.eyeHeight;
      Object.assign(this.prevViewPunch, this.viewPunch);
      Object.assign(this.prevAimPunch, this.aimPunch);
    }
    const a = Math.min(1, Math.max(0, alpha));
    this.renderOrigin.lerpVectors(this.prevOrigin, this.origin, a);
    this.renderEyeHeight = this.prevEyeHeight + (this.eyeHeight - this.prevEyeHeight) * a;
    if (this.isLocal) {
      this.camera?.update(this, dt, a);
      // main.js only frames World.local and World.bots; make sure every other entity's
      // third-person model is posed once per render frame (stamp prevents double updates).
      const ents = World.entities;
      for (let i = 0; i < ents.length; i++) if (ents[i] !== this) ents[i].frame?.(dt, alpha);
    } else if (this.model) {
      if (this.model.root) this.model.root.position.copy(this.renderOrigin);
      try { this.model.update?.(this, dt); }
      catch (err) { console.error('[player] model.update threw', err); this.model.update = null; }
    }
  }

  // ---- damage -------------------------------------------------------------------------

  /** info = { amount, hitgroup, attacker, weapon, point, dir, armorPen, headshotMul? } */
  takeDamage(info = {}) {
    if (!this.alive) return 0;
    let dmg = +info.amount || 0;
    if (dmg <= 0) return 0;
    const hg = info.hitgroup | 0;
    const isFall = info.type === 'fall' || info.weapon === 'fall';
    const wdef = typeof info.weapon === 'object' ? (info.weapon?.def || info.weapon) : null;

    if (!isFall && !info.hitgroupApplied) {
      if (hg === HG_HEAD) dmg *= info.headshotMul ?? wdef?.headshotMul ?? 4;
      else if (hg === HG_STOMACH) dmg *= 1.25;
      else if (hg === HG_LLEG || hg === HG_RLEG) dmg *= 0.75;
    }

    // armour (CS): kevlar covers chest/stomach/arms/generic, helmet the head, nothing the legs
    let armorHit = false, armorTaken = 0;
    const covered = hg === 0 || hg === HG_CHEST || hg === HG_STOMACH || hg === HG_LARM || hg === HG_RARM ||
      (hg === HG_HEAD && this.helmet);
    if (!isFall && this.armor > 0 && covered) {
      const ratio = info.armorPen ?? wdef?.armorPen ?? 0.5;
      let toHealth = dmg * ratio;
      let toArmor = (dmg - toHealth) * ARMOR_BONUS;
      if (toArmor > this.armor) { toHealth = dmg - this.armor / ARMOR_BONUS; toArmor = this.armor; }
      armorTaken = Math.floor(toArmor);
      this.armor = Math.max(0, this.armor - armorTaken);
      if (this.armor <= 0) this.helmet = false;
      dmg = toHealth;
      armorHit = true;
    }

    const amount = Math.max(1, Math.floor(dmg));
    this.health -= amount;
    this.lastDamage = info;

    if (!isFall) {
      // CS:GO tagging: being hit slows you down
      const legs = hg === HG_LLEG || hg === HG_RLEG;
      const tag = legs ? (info.taggingSmall ?? wdef?.taggingSmall ?? 0.55) : (info.tagging ?? wdef?.tagging ?? 0.4);
      this.velocityModifier = Math.min(this.velocityModifier, tag);
      // CS:GO aim punch when shot without armour on the hit area
      const flinch = World.cvar.sv_damage_flinch;
      if (!armorHit && flinch > 0) {
        this.aimPunch.pitch -= Math.min(6, 0.6 + amount * 0.05) * flinch * (hg === HG_HEAD ? 1.6 : 1);
        this.aimPunch.yaw += ((this.id * 7919 + (this.health | 0)) % 3 - 1) * 0.4 * flinch;
      }
    }

    World.emit('damage', {
      victim: this, attacker: info.attacker ?? null, amount, hitgroup: hg, weapon: info.weapon ?? null,
      point: info.point ?? null, normal: info.normal ?? null, penetrated: info.penetrated ?? 0,
      armor: armorTaken, dir: info.dir ?? null,
    });
    if (this.health <= 0) { this.health = 0; this.die(info); }
    return amount;
  }

  die(info = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.armor = 0; this.helmet = false; this.defuser = false;
    this.ducking = false;
    const dir = info.dir || null;
    const force = Math.min(3, (+info.amount || 30) / 30) * (info.hitgroup === HG_HEAD ? 1.3 : 1);
    if (this.model?.ragdoll) {
      try { this.model.ragdoll(dir || _tmp.set(Math.cos(this.yaw * Math.PI / 180), 0.2, -Math.sin(this.yaw * Math.PI / 180)).negate(), force, info.hitgroup | 0); this._ragdolled = true; }
      catch (err) { console.error('[player] ragdoll threw', err); }
    }
    World.emit('death', {
      victim: this, attacker: info.attacker ?? null, weapon: info.weapon ?? null,
      headshot: (info.hitgroup | 0) === HG_HEAD,
    });
  }

  respawn(spawn) {
    this.alive = true;
    this.health = 100;
    if (spawn?.pos) this.origin.copy(spawn.pos);
    this.yaw = spawn?.yaw ?? this.yaw;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.ducked = false; this.ducking = false; this.duckAmount = 0; this.duckSpeed = 8;
    this.duckUntilOnGround = false; this.viewOffsetCorr = 0;
    this.eyeHeight = VIEW_STAND;
    this.moveType = 'walk';
    this.stamina = 0; this.fallVelocity = 0; this.velocityModifier = 1;
    this.onGround = false; this.groundEntity = null;
    this.viewPunch.pitch = this.viewPunch.yaw = this.viewPunch.roll = 0;
    this.aimPunch.pitch = this.aimPunch.yaw = this.aimPunch.roll = 0;
    this.aimPunchVel.pitch = this.aimPunchVel.yaw = this.aimPunchVel.roll = 0;
    this.frozen = false;
    this._snapInterp();
    if (this.isLocal && World.input) { World.input.yaw = this.yaw; World.input.pitch = 0; }
    if (this._ragdolled && this.model) {
      // the character model has no "un-ragdoll": rebuild it
      try { this.model.dispose?.(); } catch (err) { console.error(err); }
      this.model.root?.parent?.remove(this.model.root);
      this.model = null; this._ragdolled = false;
      this._attachModel();
    }
    World.emit('spawn', { ent: this });
  }

  _attachModel() {
    if (this.isLocal || this.model) return;
    loadCharacterModules().then((mod) => {
      if (!mod?.createCharacterModel || this.model || !World.entities.includes(this)) return;
      try {
        this.model = mod.createCharacterModel(this.team);
        if (this.model?.root && World.scene) World.scene.add(this.model.root);
      } catch (err) { console.error('[player] createCharacterModel threw', err); this.model = null; }
    });
  }

  /** Ray vs this player's hitboxes -> { t, hitgroup, point, normal } | null (pooled result). */
  rayHit(start, dir, maxDist) {
    if (!this.alive) return null;
    const o = this.origin;
    // broad phase: ray vs padded AABB
    if (!rayAabb(start, dir, maxDist, o.x - 24, o.y - 4, o.z - 24, o.x + 24, o.y + this.hullHeight + 8, o.z + 24)) return null;
    const ray = hitMod?.rayVsHitboxes || charMod?.rayVsHitboxes;
    if (this.model?.worldHitboxes && ray) {
      try {
        const boxes = this.model.worldHitboxes(this);
        if (boxes?.length) return ray(boxes, start, dir, maxDist);
      } catch (err) { console.error('[player] rayVsHitboxes threw', err); hitMod = null; charMod = { ...charMod, rayVsHitboxes: null }; }
    }
    return this._capsuleHit(start, dir, maxDist);
  }

  /** Fallback hitboxes: head sphere at the eye, body capsule; hitgroup from hit height. */
  _capsuleHit(start, dir, maxDist) {
    const o = this.origin, eye = this.eyeHeight;
    const sx = start.x, sy = start.y, sz = start.z, dx = dir.x, dy = dir.y, dz = dir.z;
    const hx = o.x, hy = o.y + eye + 1.5, hz = o.z, hr = 5.2;
    let best = -1, hg = 0;
    const th = raySphere(sx, sy, sz, dx, dy, dz, hx, hy, hz, hr);
    if (th >= 0 && th <= maxDist) { best = th; hg = HG_HEAD; }
    const top = o.y + eye - 13, bot = o.y + 9;
    const tb = rayVCapsule(sx, sy, sz, dx, dy, dz, o.x, bot, top, o.z, 9);
    if (tb >= 0 && tb <= maxDist && (best < 0 || tb < best)) {
      best = tb;
      const yy = sy + dy * tb - o.y, frac = yy / eye;
      hg = frac < 0.5 ? (((sx + dx * tb - o.x) * Math.sin(this.yaw * Math.PI / 180) + (sz + dz * tb - o.z) * Math.cos(this.yaw * Math.PI / 180)) > 0 ? HG_RLEG : HG_LLEG)
        : frac < 0.63 ? HG_STOMACH : HG_CHEST;
    }
    if (best < 0) return null;
    const h = this._hit;
    h.t = best; h.hitgroup = hg;
    h.point.set(sx + dx * best, sy + dy * best, sz + dz * best);
    if (hg === HG_HEAD) h.normal.set(h.point.x - hx, h.point.y - hy, h.point.z - hz).normalize();
    else h.normal.set(h.point.x - o.x, 0, h.point.z - o.z).normalize();
    return h;
  }
}

function rayAabb(s, d, maxDist, x0, y0, z0, x1, y1, z1) {
  let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    const so = i === 0 ? s.x : i === 1 ? s.y : s.z;
    const dd = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const lo = i === 0 ? x0 : i === 1 ? y0 : z0;
    const hi = i === 0 ? x1 : i === 1 ? y1 : z1;
    if (Math.abs(dd) < 1e-9) { if (so < lo || so > hi) return false; continue; }
    let t0 = (lo - so) / dd, t1 = (hi - so) / dd;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return true;
}

/** CS:GO DecayAngles: exponential then linear decay toward zero. */
function decayAngles(a, exp, lin, dt) {
  if (!a.pitch && !a.yaw && !a.roll) return;
  const k = Math.exp(-exp * dt);
  a.pitch *= k; a.yaw *= k; a.roll = (a.roll || 0) * k;
  const l = lin * dt;
  const mag = Math.hypot(a.pitch, a.yaw, a.roll);
  if (mag > l && mag > 1e-5) { const s = 1 - l / mag; a.pitch *= s; a.yaw *= s; a.roll *= s; }
  else { a.pitch = 0; a.yaw = 0; a.roll = 0; }
}

function register(p) {
  if (!World.entities.includes(p)) World.entities.push(p);
  return p;
}

function pickSpawn(team) {
  const list = World.map?.spawns?.[team];
  if (!list?.length) return null;
  const used = World.entities.filter((e) => e.team === team).length;
  return list[(used - 1 + list.length) % list.length];
}

/** Bots and other non-local players. Registers in World.entities and loads the 3P model. */
export function createPlayer({ team = 'T', isBot = true, name = null } = {}) {
  const p = register(new Player({ team, isBot, name, isLocal: false }));
  p.respawn(pickSpawn(team));
  p._attachModel();
  return p;
}

export function createLocalPlayer(team = 'T') {
  const p = register(new Player({ team, isBot: false, name: 'Player', isLocal: true }));
  const s = World.map?.spawns?.[team]?.[0] ?? null;
  p.respawn(s);
  return p;
}

/** Remove a player (bot kicked, disconnect). */
export function removePlayer(p) {
  const i = World.entities.indexOf(p);
  if (i >= 0) World.entities.splice(i, 1);
  if (p.model) {
    p.model.root?.parent?.remove(p.model.root);
    try { p.model.dispose?.(); } catch (err) { console.error(err); }
    p.model = null;
  }
}
