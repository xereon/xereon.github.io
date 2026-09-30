// WeaponSystem (CONTRACT §7): per-entity weapon state machines for the local player AND bots.
//
//   tick(dt)   fixed 128 Hz: accuracy, recoil, reloads, firing, grenades, C4, pickups
//   frame(dt)  render rate: viewmodel, zoom FOV / sensitivity, projectile + dropped-item meshes
//
// Input: held buttons come from the entity's usercmd (ent.lastCmd for bots, World.input for
// the local player), plus attack(ent, down) for scripted callers. Local impulses (slot1-5,
// lastinv, invnext/invprev, drop) arrive via World.on('impulse').
//
// Inventory lives on the entity: ent.inventory = { primary, secondary, knife, grenades[], c4,
// taser } holding WeaponInstance objects; ent.active is the instance in hand (has .key,
// .clip, .reserve, .state, .zoomLevel, .maxSpeed ...). ent.scoped mirrors zoomLevel > 0.
//
// Events emitted besides the canonical fire/impact (names match what audio/HUD listen for):
//   deploy, reload {empty,time,count}, weapon_reload_end, weapon_shell_in, dryfire,
//   zoom {level}, silencer {on,time} (at the start of the animation), weapon_mode {burst},
//   knife {heavy,hit,backstab} (+ 'fire' with weapon 'knife' and heavy for the swing sound),
//   grenade_pin, grenade_throw, grenade_bounce, grenade_detonate + <key>_detonate,
//   smoke_expire / inferno_expire {id}, decoy_start, decoy_fire, weapon_drop, weapon_pickup.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { Dbg } from '../core/debug.js';
import { IN_ATTACK, IN_ATTACK2, IN_RELOAD, IN_INSPECT, IN_USE, IN_SPEED } from '../core/input.js';
import { angleVectors } from '../core/mathx.js';
import { WEAPONS, GRENADE, MAX_GRENADES, DEFAULT_LOADOUT } from './registry.js';
import { recoilTable, sampleTable, solveKick, stepPunch, indexForMagnitude, Rand, hashKey } from './recoil.js';
import { fireBullet, knifeTrace, isBackstab, dealDamage } from './ballistics.js';
import { GrenadeSystem, buildGrenadeMesh } from './grenades.js';
import { C4Logic, rulesManageBomb } from './c4.js';
import { MASK_SHOT } from '../player/collision.js';

defCvar('weapon_accuracy_nospread', 0, 0, 1, 'no spread / inaccuracy (debug)');
defCvar('weapon_move_inaccuracy_power', 0.25, 0.05, 2, 'CS:GO movement inaccuracy curve (running)');
defCvar('weapon_air_spread_scale', 1, 0, 3, 'airborne inaccuracy scale');
defCvar('sv_infinite_ammo', 0, 0, 2, '1 = bottomless clip, 2 = infinite reserve');
defCvar('mp_weapons_allow_drop_knife', 0, 0, 1, 'allow dropping the knife');
defCvar('view_punch_decay', 18, 0, 100, 'view punch exponential decay');

const LN10 = Math.log(10);
const SQRT_JUMP = Math.sqrt(301.993378);
const DEG = Math.PI / 180;
const SLOT_ORDER = ['primary', 'secondary', 'knife', 'taser', 'grenade', 'c4'];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _mz = new THREE.Vector3(), _ej = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _av = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const _t = { pitch: 0, yaw: 0 }, _dv = { pitch: 0, yaw: 0 };
const _rand = new Rand(1);
const keyOf = (v) => (v == null ? null : typeof v === 'string' ? v : v.key);

// ---- instance ----------------------------------------------------------------------------------
export class WeaponInstance {
  constructor(key, def) {
    this.key = key; this.def = def; this.name = def.name; this.slot = def.slot;
    this.magSize = def.mag || 0;
    this.clip = def.mag || 0;
    this.reserve = def.reserve || 0;
    this.silenced = !!def.silencer;
    this.burstMode = false; this.burstLeft = 0; this.nextBurst = 0;
    this.zoomLevel = 0; this.zoomStart = -9; this.resumeZoom = 0;
    this.state = 'idle'; this.stateEnd = 0; this.reloading = false; this.reloadPhase = null; this.reloadEmpty = false;
    this.nextAttack = 0; this.nextAttack2 = 0;
    this.accuracyPenalty = 0; this.recoilIndex = 0; this.lastShotTime = -9; this.shotsFired = 0;
    this.maxSpeed = def.maxSpeed ?? 250;
    this.throwStrength = 1; this.pinReady = 0; this.throwAt = 0;
    this.pendingShellAt = -1; this.removeAt = -1; this.knifeChainUntil = 0;
  }
  /** Secondary mode active? scoped / silencer OFF / burst. */
  get alt() {
    const d = this.def;
    if (d.zoom) return this.zoomLevel > 0;
    if (d.silencer) return !this.silenced;
    if (d.burst) return this.burstMode;
    return false;
  }
  stat(name) { const a = this.def.alt; return this.alt && a && a[name] !== undefined ? a[name] : this.def[name]; }
  get zoom() { return this.zoomLevel; }
  get ammo() { return this.clip; }
}

// ---- system ------------------------------------------------------------------------------------
export class WeaponSystem {
  constructor() {
    this.WEAPONS = WEAPONS; this.registry = WEAPONS; this.defs = WEAPONS;
    this.now = 0;
    this.viewmodel = null;
    this._vmKey = null; this._vmOk = true; this._vmVisible = true;
    this._buildWorldModel = null; this._vmCfg = null;
    this.grenades = new GrenadeSystem();
    this.c4 = new C4Logic(this);
    this.items = [];                 // dropped weapons lying in the world
    this._baseSens = 1;

    this._initViewmodel();
    World.on('impulse', (name) => this._impulse(name));
    World.on('death', (e) => this._onDeath(e));
    World.on('spawn', (e) => { if (e?.ent) this._onSpawn(e.ent); });
    World.on('round_start', () => this._onRoundStart());
  }

  async _initViewmodel() {
    try {
      const m = await import('./viewmodel.js');
      this._buildWorldModel = m.buildWorldModel || null;
      try { const mi = await import('./models/index.js'); this._vmCfg = mi.VM_CFG || null; } catch { this._vmCfg = null; }
      if (m.Viewmodel && World.viewScene) {
        this.viewmodel = new m.Viewmodel(World.viewScene, World.viewCamera);
        this._vmKey = null;
      }
    } catch (err) {
      Dbg.warn('[weapons] viewmodel unavailable:', err?.message || err);
      this.viewmodel = null;
    }
  }

  // ======================================================================= per-entity state
  _state(ent) {
    let w = ent._wpn;
    if (!w) {
      w = ent._wpn = {
        prev: 0, api: 0, lastInv: null, seed: hashKey(`${ent.id ?? ''}:${ent.name ?? ''}:${Math.random()}`),
        pp: 0, py: 0, vp: 0, vy: 0, landSerial: ent.landSerial ?? 0, wasOnGround: !!ent.onGround, lastVy: 0,
        shots: 0,
      };
      ent.aimPunch ||= { pitch: 0, yaw: 0, roll: 0 };
      ent.aimPunchVel ||= { pitch: 0, yaw: 0, roll: 0 };
      ent.viewPunch ||= { pitch: 0, yaw: 0, roll: 0 };
      if (!ent.inventory) ent.inventory = { primary: null, secondary: null, knife: null, grenades: [], c4: null, taser: null };
      if (!Array.isArray(ent.inventory.grenades)) ent.inventory.grenades = [];
      // keys handed out before we existed (rules fallback) become real instances
      for (const s of ['primary', 'secondary', 'knife', 'taser', 'c4']) {
        const v = ent.inventory[s];
        if (typeof v === 'string') { ent.inventory[s] = null; this.give(ent, v); }
      }
      const gs = ent.inventory.grenades.slice(); ent.inventory.grenades.length = 0;
      for (const g of gs) if (typeof g === 'string') this.give(ent, g); else if (g) ent.inventory.grenades.push(g);
      if (typeof ent.active === 'string') { const k = ent.active; ent.active = null; this.switchTo(ent, k, true); }
    }
    return w;
  }

  buttonsOf(ent) {
    const w = ent._wpn;
    const api = w ? w.api : 0;
    if (ent === World.local) {
      if (World.paused || World.hud?.captureInput) return api;
      return ((World.input?.buttons | 0) | api);
    }
    const c = ent.lastCmd;
    return ((c ? c.buttons : ent.buttons) | 0) | api;
  }

  // ================================================================================ tick
  update(dt) { this.tick(dt); }

  tick(dt) {
    this.now += dt;
    const ents = World.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e || !e.origin) continue;
      try { this._stepEntity(e, dt); }
      catch (err) { console.error('[weapons] entity step threw', err); }
    }
    this.grenades.tick(dt);
    this.c4.tick(dt);
    this._tickItems(dt);
  }

  _stepEntity(ent, dt) {
    const w = this._state(ent);
    if (!ent.alive) { w.prev = 0; if (ent.scoped) this._setZoom(ent, ent.active, 0); return; }
    this._punchFallback(ent, w, dt);
    if (!ent.active && this._hasAnything(ent)) this._switchBest(ent);
    const inst = ent.active;

    // landing penalty (CS:GO OnLand)
    let landed = 0;
    if (ent.landSerial !== undefined) {
      if (ent.landSerial !== w.landSerial) { w.landSerial = ent.landSerial; landed = ent.landSpeed || 0; }
    } else if (!w.wasOnGround && ent.onGround) landed = Math.abs(w.lastVy);
    w.wasOnGround = !!ent.onGround; w.lastVy = ent.velocity?.y || 0;

    const btn = this.buttonsOf(ent);
    const pressed = btn & ~w.prev;
    const released = w.prev & ~btn;
    w.prev = btn;
    if (!inst) return;
    const def = inst.def;

    this._updateAccuracy(ent, inst, dt, landed);
    this._timers(ent, inst, btn);
    if (ent.active !== inst) return; // a timer switched weapons

    const frozenRound = World.match?.freezeTime === true;
    if (pressed & IN_RELOAD) this.reload(ent);
    if ((pressed & IN_INSPECT) && inst.state === 'idle') this._inspect(ent, inst);
    if (pressed & IN_USE) this._usePickup(ent);

    const cat = def.slot;
    if (cat === 'grenade') { if (!frozenRound) this._grenadeInput(ent, inst, btn, pressed, released); }
    else if (cat === 'knife') {
      if (!frozenRound) {
        if (btn & IN_ATTACK) this._knife(ent, inst, false);
        else if (btn & IN_ATTACK2) this._knife(ent, inst, true);
      }
    } else if (cat === 'c4') {
      /* handled below */
    } else {
      if ((pressed & IN_ATTACK2) && def.slot !== 'c4') this.secondary(ent);
      if (!frozenRound) this._gunInput(ent, inst, btn, pressed);
    }
    if (ent.inventory.c4) {
      this.c4.tickCarrier(ent, ent.inventory.c4, btn, dt);
      this._plantAnimSync(ent);
    }
  }

  _hasAnything(ent) {
    const inv = ent.inventory;
    return !!(inv && (inv.primary || inv.secondary || inv.knife || inv.taser || inv.c4 || inv.grenades?.length));
  }

  /** If nobody integrated/decayed the punch since our last tick, do it here (harness, stub players). */
  _punchFallback(ent, w, dt) {
    const ap = ent.aimPunch, av = ent.aimPunchVel, vp = ent.viewPunch;
    const moving = ap.pitch || ap.yaw || av.pitch || av.yaw;
    if (moving && ap.pitch === w.pp && ap.yaw === w.py && av.pitch === w.vp && av.yaw === w.vy) {
      stepPunch(ap, av, dt);
      if (vp && (vp.pitch || vp.yaw)) {
        const k = Math.exp(-(World.cvar.view_punch_decay ?? 18) * dt);
        vp.pitch *= k; vp.yaw *= k; if (Math.abs(vp.pitch) + Math.abs(vp.yaw) < 1e-4) { vp.pitch = 0; vp.yaw = 0; }
      }
    }
    // (recorded again after this tick's kicks, in _recordPunch)
    this._recordPunch(ent, w);
  }
  _recordPunch(ent, w = ent._wpn) {
    w.pp = ent.aimPunch.pitch; w.py = ent.aimPunch.yaw; w.vp = ent.aimPunchVel.pitch; w.vy = ent.aimPunchVel.yaw;
  }

  // ======================================================================== accuracy (CS:GO)
  /** Harness poses freeze movement with onGround=false; treat the posed local player as standing. */
  _grounded(ent) {
    if (ent === World.local && World.cameraOverride) return true;
    return ent.onGround !== false;
  }

  _recoveryTime(ent, inst) {
    const d = inst.def;
    const [s, e] = d.recoveryTransition || [0, 0];
    const t = e > s ? Math.min(1, Math.max(0, (inst.recoilIndex - s) / (e - s))) : 0;
    const crouch = !!(ent.ducked ?? ent.ducking);
    const a = crouch ? d.recoveryTimeCrouch : d.recoveryTimeStand;
    const b = crouch ? d.recoveryTimeCrouchFinal : d.recoveryTimeStandFinal;
    return Math.max(0.01, (a ?? 0.3) + ((b ?? a ?? 0.3) - (a ?? 0.3)) * t);
  }

  /** CS:GO UpdateAccuracyPenalty + recoil index decay, once per tick. */
  _updateAccuracy(ent, inst, dt, landed) {
    const d = inst.def;
    if (d.inaccuracyStand === undefined) return;
    const air = World.cvar.weapon_air_spread_scale ?? 1;
    let np;
    if (ent.moveType === 'ladder') np = inst.stat('inaccuracyLadder') ?? inst.stat('inaccuracyStand');
    else if (!this._grounded(ent)) np = inst.stat('inaccuracyStand') + (inst.stat('inaccuracyJump') ?? 0) * air;
    else if (ent.ducked ?? ent.ducking) np = inst.stat('inaccuracyCrouch');
    else np = inst.stat('inaccuracyStand');
    np *= 0.001;
    const rt = this._recoveryTime(ent, inst);
    if (np > inst.accuracyPenalty) inst.accuracyPenalty = np;
    else inst.accuracyPenalty = np + (inst.accuracyPenalty - np) * Math.exp(-dt * LN10 / rt);
    if (landed > 0) inst.accuracyPenalty += (inst.stat('inaccuracyLand') ?? 0) * 0.001 * landed;

    // recoil index decays once we stop firing, and never runs ahead of the decayed punch
    if (inst.recoilIndex > 0 && this.now > inst.lastShotTime + (inst.stat('cycleTime') || 0.1) * 1.1) {
      inst.recoilIndex = Math.max(0, inst.recoilIndex * Math.exp(-dt * LN10 / rt) - dt * 2);
      const tab = recoilTable(inst.key);
      const mag = Math.hypot(ent.aimPunch.pitch, ent.aimPunch.yaw);
      const r = indexForMagnitude(tab, mag + 0.05);
      if (r < inst.recoilIndex) inst.recoilIndex = r;
    }
  }

  /** Inaccuracy in radians (without the fixed spread term). CS:GO GetInaccuracy. */
  inaccuracy(ent, inst = ent?.active) {
    if (!inst || inst.def.inaccuracyStand === undefined) return 0;
    if (World.cvar.weapon_accuracy_nospread) return 0;
    const d = inst.def;
    let acc = inst.accuracyPenalty;
    const v = ent.velocity;
    const maxSpeed = inst.maxSpeed || 250;
    if (v) {
      const sp = Math.hypot(v.x, v.z);
      let s = (sp - maxSpeed * 0.34) / (maxSpeed * 0.95 - maxSpeed * 0.34);
      if (s > 0) {
        if (s > 1) s = 1;
        const walking = (this.buttonsOf(ent) & IN_SPEED) !== 0;
        if (!walking) s = Math.pow(s, World.cvar.weapon_move_inaccuracy_power ?? 0.25);
        acc += s * (inst.stat('inaccuracyMove') ?? 0) * 0.001;
      }
      if (!this._grounded(ent) && ent.moveType !== 'ladder') {
        const ji = (inst.stat('inaccuracyJumpInitial') ?? 0) * 0.001 * (World.cvar.weapon_air_spread_scale ?? 1);
        const sv = Math.sqrt(Math.abs(v.y));
        let a = ji * (sv - SQRT_JUMP * 0.25) / (SQRT_JUMP - SQRT_JUMP * 0.25);
        if (a < 0) a = 0; else if (a > 2 * ji) a = 2 * ji;
        acc += a;
      }
    }
    // scope settling: accuracy blends in over the zoom time (quick-scope window)
    if (d.zoom && inst.zoomLevel > 0 && d.zoomTime > 0) {
      const t = (this.now - inst.zoomStart) / d.zoomTime;
      if (t < 1) acc += (1 - Math.max(0, t)) * Math.max(0, (d.inaccuracyStand - (d.alt?.inaccuracyStand ?? d.inaccuracyStand))) * 0.001;
    }
    // CS:GO 2020 Negev: wild first shots, laser once the barrel spins up
    const wb = d.wildBeast;
    if (wb) {
      const t = Math.min(1, inst.recoilIndex / wb.settleShots);
      acc *= wb.first + (wb.settled - wb.first) * t;
    }
    return Math.min(1, acc);
  }

  /** Degrees of cone half-angle (inaccuracy + spread) for the dynamic crosshair / bots. */
  currentInaccuracy(ent) {
    const inst = ent?.active;
    if (!inst || inst.def.inaccuracyStand === undefined || !ent.alive) return 0;
    if (World.cvar.weapon_accuracy_nospread) return 0;
    const r = this.inaccuracy(ent, inst) + (inst.stat('spread') ?? 0) * 0.001;
    return Math.atan(r) / DEG;
  }

  maxSpeed(ent) { return ent?.active?.maxSpeed ?? 250; }

  // ======================================================================== timers / states
  _timers(ent, inst, btn) {
    const now = this.now, d = inst.def;
    switch (inst.state) {
      case 'deploy':
        if (now >= inst.stateEnd) inst.state = 'idle';
        break;
      case 'reload':
        if (d.reloadType === 'shell') this._shellReload(ent, inst, btn);
        else if (now >= inst.stateEnd) {
          const take = Math.min(inst.magSize - inst.clip, World.cvar.sv_infinite_ammo === 2 ? Infinity : inst.reserve);
          inst.clip += take;
          if (World.cvar.sv_infinite_ammo !== 2) inst.reserve -= take;
          inst.state = 'idle'; inst.reloading = false; inst.reloadPhase = null;
          World.emit('weapon_reload_end', { ent, weapon: inst.key });
        }
        break;
      case 'silencer':
        if (now >= inst.stateEnd) {
          inst.silenced = !inst.silenced; inst.state = 'idle';
        }
        break;
      case 'inspect':
        if (now >= inst.stateEnd) inst.state = 'idle';
        break;
    }
    // bolt / pump brass comes out after the shot
    if (inst.pendingShellAt > 0 && now >= inst.pendingShellAt) { inst.pendingShellAt = -1; this._ejectShell(ent, inst); }
    // burst continuation (Glock / FAMAS)
    if (inst.burstLeft > 0 && now >= inst.nextBurst) {
      if (inst.clip > 0 && inst.state === 'idle') {
        inst.burstLeft--;
        this._fire(ent, inst, true);
        inst.nextBurst = now + d.burst.interval;
      } else inst.burstLeft = 0;
    }
    // snipers re-scope after the bolt
    if (inst.resumeZoom > 0 && now >= inst.nextAttack && inst.state === 'idle') {
      const z = inst.resumeZoom; inst.resumeZoom = 0;
      if (ent.active === inst && inst.clip > 0) this._setZoom(ent, inst, z);
    }
    // Zeus: gone once its single charge has been spent
    if (inst.removeAt > 0 && now >= inst.removeAt) { inst.removeAt = -1; this.remove(ent, inst.key); }
  }

  _shellReload(ent, inst, btn) {
    const now = this.now, d = inst.def;
    // firing interrupts a shotgun reload once a shell is in
    if ((btn & IN_ATTACK) && inst.clip > 0 && inst.reloadPhase !== 'start') { this._endReload(ent, inst); return; }
    if (now < inst.stateEnd) return;
    if (inst.reloadPhase === 'start' || inst.reloadPhase === 'shell') {
      if (inst.reloadPhase === 'shell') {
        inst.clip++;
        if (World.cvar.sv_infinite_ammo !== 2) inst.reserve--;
        World.emit('weapon_shell_in', { ent, weapon: inst.key });
      }
      if (inst.clip < inst.magSize && (inst.reserve > 0 || World.cvar.sv_infinite_ammo === 2)) {
        inst.reloadPhase = 'shell'; inst.stateEnd = now + d.shellTime;
      } else {
        inst.reloadPhase = 'end'; inst.stateEnd = now + (inst.reloadEmpty ? d.reloadEnd : d.reloadEnd * 0.6);
      }
      inst.nextAttack = Math.max(inst.nextAttack, now);
      return;
    }
    this._endReload(ent, inst);
  }

  _endReload(ent, inst) {
    inst.state = 'idle'; inst.reloading = false; inst.reloadPhase = null;
    inst.nextAttack = Math.max(inst.nextAttack, this.now);
    World.emit('weapon_reload_end', { ent, weapon: inst.key });
    if (ent === World.local) this._vmPlay('idle');
  }

  // ============================================================================ firing
  _gunInput(ent, inst, btn, pressed) {
    const d = inst.def;
    if (!(btn & IN_ATTACK)) { inst.dryHeld = false; return; }
    const now = this.now;
    if (inst.state === 'reload' && !(d.reloadType === 'shell' && inst.clip > 0)) return;
    if (inst.state === 'deploy' || inst.state === 'silencer') return;
    if (now < inst.nextAttack) return;
    if (inst.state === 'inspect') inst.state = 'idle';
    const semi = d.fireMode !== 'auto' || (d.burst && inst.burstMode);
    if (semi && !(pressed & IN_ATTACK)) return;
    if (inst.clip <= 0 && !World.cvar.sv_infinite_ammo) {
      if ((pressed & IN_ATTACK) || !inst.dryHeld) {
        inst.dryHeld = true;
        World.emit('dryfire', { ent, weapon: inst.key });
        if (!(inst.reserve > 0 && this.reload(ent))) inst.nextAttack = now + 0.2;
      }
      return;
    }
    if (inst.state === 'reload') this._endReload(ent, inst);
    const burst = !!(d.burst && inst.burstMode);
    if (burst) inst.burstLeft = d.burst.count - 1;
    this._fire(ent, inst, false);
    if (burst) {
      inst.nextBurst = now + d.burst.interval;
      inst.nextAttack = now + d.burst.cycle;
    }
  }

  /** One trigger pull: bullets, recoil, accuracy penalty, effects, events. */
  _fire(ent, inst, burstShot) {
    const now = this.now, d = inst.def, w = ent._wpn;
    const isLocal = ent === World.local;
    const inacc = this.inaccuracy(ent, inst);
    const spread = World.cvar.weapon_accuracy_nospread ? 0 : (inst.stat('spread') ?? 0) * 0.001;
    const shotIndex = inst.shotsFired;
    const seed = (w.seed + Math.imul(++w.shots, 0x9E3779B1)) >>> 0;
    const tf = inst.stat('tracerFreq') | 0;
    const tracer = tf > 0 && shotIndex % tf === 0;

    // muzzle / eject points for tracers + brass
    const muzzle = this._muzzle(ent, _mz);
    angleVectors((ent.pitch || 0) + ent.aimPunch.pitch * (World.cvar.weapon_recoil_scale ?? 2),
      (ent.yaw || 0) + ent.aimPunch.yaw * (World.cvar.weapon_recoil_scale ?? 2), _av);

    World.emit('fire', {
      ent, weapon: inst.key, seed, silenced: !!(inst.silenced || d.suppressed), local: isLocal,
      muzzle: muzzle.clone(), muzzleSpace: this._fpGun(ent) ? 'view' : 'world',
      dir: _av.forward.clone(), shot: shotIndex, clip: inst.clip - 1, scoped: inst.zoomLevel > 0,
    });
    const fp = this._fpGun(ent);
    fireBullet(ent, inst, seed, shotIndex, { inaccuracy: inacc, spread, muzzle, tracer, recoilIndex: inst.recoilIndex,
      tracerOpts: fp ? { viewmodel: true } : undefined });

    const fx = World.fx;
    if (fx?.muzzleFlash) {
      try { fx.muzzleFlash(muzzle.clone(), _av.forward.clone(), inst.key, { viewmodel: fp, silenced: !!(inst.silenced || d.suppressed), ent }); }
      catch (err) { console.error('[weapons] fx.muzzleFlash threw', err); }
    }
    if (d.shellEject === 'auto') this._ejectShell(ent, inst);
    else if (d.shellEject === 'pump' || d.shellEject === 'bolt') inst.pendingShellAt = now + (d.shellEject === 'bolt' ? 0.55 : 0.42);

    if (!World.cvar.sv_infinite_ammo) inst.clip--;
    inst.shotsFired++;
    // exact cyclic rate: schedule from the previous due time when firing continuously
    const cyc = inst.stat('cycleTime') || 0.1;
    if (!burstShot) inst.nextAttack = (now - inst.nextAttack < World.tickInterval * 1.5 && now - inst.lastShotTime < cyc * 2) ? inst.nextAttack + cyc : now + cyc;
    inst.lastShotTime = now;

    this._kick(ent, inst, seed);
    inst.accuracyPenalty += (inst.stat('inaccuracyFire') ?? 0) * 0.001;
    inst.recoilIndex += 1;
    this._recordPunch(ent);

    if (isLocal) this._vmPlay(inst.clip <= 0 ? 'fire_last' : 'fire');
    // bolt-action: the shot knocks you out of the scope, it comes back after the bolt
    if (d.resumeZoom && inst.zoomLevel > 0) { const z = inst.zoomLevel; this._setZoom(ent, inst, 0); inst.resumeZoom = z; }
    if (d.singleUse) inst.removeAt = now + 0.35;
  }

  /** Recoil: velocity impulse that lands the punch on the next pattern point (see recoil.js). */
  _kick(ent, inst, seed) {
    const d = inst.def;
    const mag = inst.stat('recoilMagnitude') ?? 0;
    if (!(mag > 0)) return;
    const tab = recoilTable(inst.key);
    const scale = d.recoilMagnitude > 0 ? mag / d.recoilMagnitude : 1;
    const r = inst.recoilIndex;
    _rand.seed(seed ^ 0x5bd1e995);
    const jit = (_rand.next() * 2 - 1) * ((d.recoilAngleVariance ?? 0) / 70) * 0.12 * (World.cvar.weapon_recoil_variance ?? 1);
    let kp, ky;
    if (tab.kicks) {
      // CS:GO Recoil(): aimPunchVel += -(cos a, sin a) * magnitude, from the seeded table
      const k = tab.kicks[Math.min(tab.kicks.length - 1, Math.floor(r))];
      const a = (k[0] + jit * 40) * DEG, m = k[1] * scale * (World.cvar.weapon_recoil_pattern_scale ?? 1);
      kp = -Math.cos(a) * m; ky = -Math.sin(a) * m;
    } else {
      sampleTable(tab, r + 1, _t);
      const t1p = _t.pitch * scale, t1y = _t.yaw * scale;
      sampleTable(tab, r, _t);
      // seeded per-shot jitter across the pattern step (recoilAngleVariance)
      const sp = t1p - _t.pitch * scale, sy = t1y - _t.yaw * scale;
      let tp = t1p - sy * jit, ty = t1y + sp * jit;
      if (Math.hypot(sp, sy) < 1e-4) tp -= 0.02 * mag / 30;
      // ticks until the next shot can go off
      const ti = World.tickInterval || 1 / 128;
      const cyc = inst.stat('cycleTime') || 0.1;
      const due = (d.burst && inst.burstMode && inst.burstLeft > 0) ? d.burst.interval : Math.max(ti, inst.nextAttack - this.now);
      const k = Math.max(1, Math.min(256, Math.ceil(Math.min(due, cyc * 1.5) / ti - 1e-6)));
      solveKick(ent.aimPunch, ent.aimPunchVel, tp, ty, k, ti, _dv);
      kp = _dv.pitch; ky = _dv.yaw;
      // sanity: CS kicks are always within ~85deg of straight up and never absurdly large
      const lim = mag * 3;
      const len = Math.hypot(kp, ky);
      if (len > lim) { kp *= lim / len; ky *= lim / len; }
      if (kp > 0) kp = -Math.abs(ky) * 0.09;
    }
    ent.aimPunchVel.pitch += kp;
    ent.aimPunchVel.yaw += ky;
    // CS:GO weapon_recoil_view_punch_extra: a sharp camera kick along the recoil direction
    const vx = World.cvar.weapon_recoil_view_punch_extra ?? 0.055;
    const vl = Math.hypot(kp, ky) || 1;
    const vpScale = Math.max(vl, mag * 0.6);
    ent.viewPunch.pitch += (kp / vl) * vpScale * vx;
    ent.viewPunch.yaw += (ky / vl) * vpScale * vx;
  }

  /** Local first-person gun drawn by the viewmodel (FX then takes viewScene-space points). */
  _fpGun(ent) { return ent === World.local && !!this.viewmodel && this._vmOk && !ent.scoped && !!this._vmKey; }

  // FX (tracer / shell / muzzleFlash{viewmodel}) wants viewScene-space points for the
  // first-person gun and re-projects them itself, so hand it muzzleView, not muzzleWorld.
  _muzzle(ent, out) {
    if (this._fpGun(ent)) {
      const vm = this.viewmodel;
      try { return vm.muzzleView ? vm.muzzleView(out) : vm.muzzleWorld(out); } catch (err) { this._vmFail(err); }
    }
    const m = ent.model;
    if (m?.muzzleWorld) { try { return m.muzzleWorld(out); } catch { /* fall through */ } }
    // third-person held gun (character agent): userData.muzzle in the held item's frame
    const held = m?.held, hm = held?.userData?.muzzle;
    if (hm && held.matrixWorld) return out.copy(hm).applyMatrix4(held.matrixWorld);
    if (ent.eyePos) ent.eyePos(out); else out.set(ent.origin.x, ent.origin.y + 64, ent.origin.z);
    angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
    const third = ent !== World.local;
    return out.addScaledVector(_av.forward, third ? 28 : 18).addScaledVector(_av.right, third ? 7 : 5).addScaledVector(_av.up, third ? -9 : -6);
  }

  /** Inverse of Viewmodel._toWorld: screen-matched world point -> viewScene point. */
  _matchedToView(p) {
    const wc = World.camera, vc = World.viewCamera;
    if (!wc || !vc) return p;
    wc.updateMatrixWorld();
    _m4.copy(wc.matrixWorld).invert();
    p.applyMatrix4(_m4);
    const k = Math.tan(vc.fov * DEG / 2) / Math.tan(wc.fov * DEG / 2);
    p.x *= k * (vc.aspect / wc.aspect); p.y *= k;
    return p.applyMatrix4(vc.matrixWorld);
  }

  _ejectShell(ent, inst) {
    const fx = World.fx;
    if (!fx?.shell || !ent.alive) return;
    let pos = null;
    if (this._fpGun(ent)) {
      try { pos = this._matchedToView(this.viewmodel.ejectWorld(_ej)); } catch (err) { this._vmFail(err); }
    }
    angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
    if (!pos) pos = this._muzzle(ent, _ej).addScaledVector(_av.forward, -10);
    const vel = new THREE.Vector3().copy(_av.right).multiplyScalar(110 + Math.random() * 40)
      .addScaledVector(_av.up, 70 + Math.random() * 30).addScaledVector(_av.forward, -15 + Math.random() * 20);
    if (ent.velocity) vel.add(ent.velocity);
    try { fx.shell(pos.clone(), vel, inst.key); } catch (err) { console.error('[weapons] fx.shell threw', err); }
  }

  // ============================================================================ knife
  _knife(ent, inst, heavy) {
    const now = this.now, d = inst.def;
    if (inst.state === 'deploy' || now < inst.nextAttack) return;
    if (inst.state === 'inspect') inst.state = 'idle';
    const hit = knifeTrace(ent, heavy ? d.rangeStab : d.range);
    let next, result = null;
    if (hit && hit.entity) {
      const v = hit.entity;
      const back = isBackstab(ent, v);
      const first = now > inst.knifeChainUntil;
      const dmg = heavy ? (back ? d.damageStabBackstab : d.damageStab) : (back ? d.damageBackstab : (first ? d.damage : d.damageChained));
      angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
      World.emit('impact', { point: hit.point.clone(), normal: hit.normal.clone(), surface: 'flesh', entity: v, weapon: 'knife',
        dir: _av.forward.clone(), exit: false, attacker: ent });
      const friendly = !World.cvar.mp_friendlyfire && v.team && v.team === ent.team;
      if (!friendly) {
        dealDamage(v, { amount: dmg, hitgroup: 2, attacker: ent, weapon: 'knife', point: hit.point.clone(), dir: _av.forward.clone(),
          normal: hit.normal.clone(), armorPen: d.armorPen, headshotMul: 1, hitgroupApplied: true, backstab: back,
          tagging: d.tagging, taggingSmall: d.taggingSmall });
      }
      next = heavy ? d.cycleTimeStabHit : d.cycleTimeHit;
      result = 'flesh';
      World.emit('knife', { ent, heavy, hit: 'flesh', backstab: back, victim: v, point: hit.point.clone() });
    } else if (hit) {
      angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
      World.emit('impact', { point: hit.point.clone(), normal: hit.normal.clone(), surface: hit.surface, entity: null, weapon: 'knife',
        dir: _av.forward.clone(), exit: false, attacker: ent, knife: true });
      next = heavy ? d.cycleTimeStabHit : d.cycleTimeHit;
      result = 'wall';
      World.emit('knife', { ent, heavy, hit: 'wall', surface: hit.surface, point: hit.point.clone() });
    } else {
      next = heavy ? d.cycleTimeStab : d.cycleTime;
      World.emit('knife', { ent, heavy, hit: null });
    }
    World.emit('fire', { ent, weapon: 'knife', seed: 0, heavy, local: ent === World.local, hit: result });
    inst.nextAttack = inst.nextAttack2 = now + next;
    inst.knifeChainUntil = now + next + 0.4;
    inst.lastShotTime = now;
    if (ent === World.local) this._vmPlay(heavy ? 'melee_heavy' : 'melee');
    return result;
  }

  // ============================================================================ grenades
  _grenadeInput(ent, inst, btn, pressed, released) {
    const now = this.now;
    const a1 = (btn & IN_ATTACK) !== 0, a2 = (btn & IN_ATTACK2) !== 0;
    switch (inst.state) {
      case 'idle': case 'inspect':
        if ((a1 || a2) && now >= inst.nextAttack) {
          inst.state = 'pin'; inst.pinReady = now + GRENADE.pinTime;
          inst.throwStrength = a1 && a2 ? 0.5 : a1 ? 1 : 0;
          World.emit('grenade_pin', { ent, weapon: inst.key });
          if (ent === World.local) this._vmPlay('pin');
        }
        break;
      case 'pin':
        if (a1 || a2) inst.throwStrength = a1 && a2 ? 0.5 : a1 ? 1 : 0;
        if (!a1 && !a2 && now >= inst.pinReady) {
          inst.state = 'throw'; inst.throwAt = now + GRENADE.throwDelay; inst.stateEnd = now + GRENADE.throwAnim;
          if (ent === World.local) this._vmPlay('throw');
        }
        break;
      case 'throw':
        if (inst.throwAt > 0 && now >= inst.throwAt) {
          inst.throwAt = 0;
          this.grenades.throw(ent, inst.key, inst.throwStrength);
          const g = ent.inventory.grenades, i = g.indexOf(inst);
          if (i >= 0) g.splice(i, 1);
        }
        if (now >= inst.stateEnd && inst.throwAt === 0) {
          inst.state = 'done';
          const same = ent.inventory.grenades.find((x) => x.key === inst.key);
          if (same) this.switchTo(ent, same, true);
          else if (!this._switchLast(ent)) this._switchBest(ent);
        }
        break;
    }
  }

  // ============================================================================ public API
  /** Hold/release the trigger for scripted callers (bots may also just set IN_ATTACK). */
  attack(ent, down = true) {
    const w = this._state(ent);
    if (down) w.api |= IN_ATTACK; else w.api &= ~IN_ATTACK;
  }

  /** Right-click action: scope, silencer, burst toggle (knife/grenade handle ATTACK2 as a button). */
  secondary(ent) {
    const inst = ent?.active;
    if (!inst || !ent.alive) return;
    const d = inst.def, now = this.now;
    if (now < inst.nextAttack2) return;
    if (d.zoom) {
      if (inst.state === 'reload' || inst.state === 'deploy') return;
      const n = (inst.zoomLevel + 1) % (d.zoom.length + 1);
      inst.resumeZoom = 0;
      this._setZoom(ent, inst, n);
      inst.nextAttack2 = now + 0.3;
      if (inst.nextAttack < now + 0.1 && n > 0) inst.nextAttack = Math.max(inst.nextAttack, now);
    } else if (d.silencer) {
      if (inst.state !== 'idle' && inst.state !== 'inspect') return;
      if (now < inst.nextAttack) return;
      const t = inst.silenced ? (d.silencerOffTime ?? 2.2) : (d.silencerTime ?? 2.7);
      inst.state = 'silencer'; inst.stateEnd = now + t;
      World.emit('silencer', { ent, weapon: inst.key, on: !inst.silenced, time: t });
      inst.nextAttack = inst.nextAttack2 = now + t;
      if (ent === World.local) this._vmPlay(inst.silenced ? 'silencer_off' : 'silencer_on');
    } else if (d.burst) {
      inst.burstMode = !inst.burstMode;
      inst.nextAttack2 = now + 0.3;
      World.emit('weapon_mode', { ent, weapon: inst.key, burst: inst.burstMode });
    }
  }

  reload(ent) {
    const inst = ent?.active;
    if (!inst || !ent.alive) return false;
    const d = inst.def, now = this.now;
    if (!(d.mag > 0) || inst.state === 'reload' || inst.state === 'deploy' || inst.state === 'silencer') return false;
    if (inst.clip >= inst.magSize || (inst.reserve <= 0 && World.cvar.sv_infinite_ammo !== 2)) return false;
    if (now < inst.nextAttack - 1e-6 && inst.burstLeft <= 0) return false;
    inst.burstLeft = 0;
    if (inst.zoomLevel > 0) this._setZoom(ent, inst, 0);
    inst.resumeZoom = 0;
    inst.state = 'reload'; inst.reloading = true; inst.reloadEmpty = inst.clip === 0;
    if (d.reloadType === 'shell') {
      inst.reloadPhase = 'start'; inst.stateEnd = now + d.reloadStart;
    } else {
      const t = inst.reloadEmpty && d.reloadEmpty ? d.reloadEmpty : d.reloadTime;
      inst.reloadPhase = 'mag'; inst.stateEnd = now + t;
      inst.nextAttack = inst.stateEnd;
    }
    World.emit('reload', { ent, weapon: inst.key, empty: inst.reloadEmpty, time: d.reloadType === 'shell' ? d.shellTime : (inst.stateEnd - now),
      count: d.reloadType === 'shell' ? Math.min(inst.magSize - inst.clip, inst.reserve) : 0 });
    if (ent === World.local) this._vmPlay(inst.reloadEmpty ? 'reload_empty' : 'reload');
    return true;
  }

  _inspect(ent, inst) {
    if (ent !== World.local && !ent.isBot) return;
    inst.state = 'inspect'; inst.stateEnd = this.now + 5;
    if (ent === World.local) this._vmPlay('inspect');
  }

  /** Switch to an item by key (or instance). */
  switchTo(ent, keyOrInst, force = false) {
    if (!ent) return false;
    this._state(ent);
    const inv = ent.inventory;
    let inst = keyOrInst;
    if (typeof keyOrInst === 'string') {
      const k = keyOrInst === 'zeus' ? 'taser' : keyOrInst;
      inst = null;
      for (const s of ['primary', 'secondary', 'knife', 'taser', 'c4']) if (inv[s]?.key === k) inst = inv[s];
      if (!inst) inst = inv.grenades.find((g) => g.key === k) || null;
    }
    if (!inst) return false;
    const cur = ent.active;
    if (cur === inst && !force) return false;
    if (cur && cur !== inst) {
      this._holster(ent, cur);
      ent._wpn.lastInv = cur;
    }
    ent.active = inst;
    const d = inst.def, now = this.now;
    inst.state = 'deploy';
    const dt = d.deployTime ?? 1;
    inst.stateEnd = now + dt;
    inst.nextAttack = Math.max(inst.nextAttack, now + dt);
    inst.nextAttack2 = Math.max(inst.nextAttack2, now + Math.min(dt, 0.3));
    inst.maxSpeed = d.maxSpeed ?? 250;
    inst.burstLeft = 0;
    if (d.slot === 'grenade') { inst.throwAt = 0; }
    World.emit('deploy', { ent, weapon: inst.key });
    if (ent === World.local) this._vmSet(inst.key, true);
    return true;
  }

  _holster(ent, inst) {
    if (inst.zoomLevel > 0) this._setZoom(ent, inst, 0);
    inst.resumeZoom = 0; inst.burstLeft = 0;
    if (inst.state === 'reload') { inst.state = 'idle'; inst.reloading = false; inst.reloadPhase = null; }
    if (inst.state === 'silencer' || inst.state === 'inspect' || inst.state === 'deploy') inst.state = 'idle';
    if (inst.state === 'pin') inst.state = 'idle'; // pin goes back in
    if (inst.state === 'throw' && inst.throwAt > 0) inst.state = 'idle';
  }

  _switchLast(ent) {
    const last = ent._wpn?.lastInv;
    if (!last || !this._owns(ent, last)) return false;
    return this.switchTo(ent, last, true);
  }

  _switchBest(ent) {
    const inv = ent.inventory;
    const pick = inv.primary || inv.secondary || inv.knife || inv.taser || inv.grenades[0] || inv.c4;
    if (pick) this.switchTo(ent, pick, true);
    else ent.active = null;
  }

  _owns(ent, inst) {
    const inv = ent.inventory;
    return inv.primary === inst || inv.secondary === inst || inv.knife === inst || inv.taser === inst || inv.c4 === inst || inv.grenades.includes(inst);
  }

  /** Buy menu / spawn loadout. Handles slots, replacing (old gun is dropped), gear. */
  give(ent, key) {
    if (!ent) return false;
    if (key === 'zeus') key = 'taser';
    const def = WEAPONS[key];
    if (!def) return false;
    this._state(ent);
    const inv = ent.inventory;
    switch (def.slot) {
      case 'gear':
        if (key === 'kevlar') { ent.armor = 100; }
        else if (key === 'kevlarhelmet') { ent.armor = 100; ent.helmet = true; }
        else if (key === 'defusekit') { ent.defuser = true; }
        World.emit('weapon_pickup', { ent, weapon: key });
        return true;
      case 'grenade': {
        const n = inv.grenades.length;
        const same = inv.grenades.filter((g) => g.key === key).length;
        const fireNade = key === 'molotov' || key === 'incgrenade';
        const fireCount = fireNade ? inv.grenades.filter((g) => g.key === 'molotov' || g.key === 'incgrenade').length : 0;
        if (n >= MAX_GRENADES || same >= (def.max || 1) || fireCount >= 1) return false;
        const inst = new WeaponInstance(key, def);
        inv.grenades.push(inst);
        if (!ent.active) this.switchTo(ent, inst, true);
        World.emit('weapon_pickup', { ent, weapon: key });
        return true;
      }
      case 'primary': case 'secondary': case 'knife': case 'taser': case 'c4': {
        const slot = def.slot;
        const old = inv[slot];
        if (old && old.key === key) { // re-buying the same gun refills it (CS)
          old.clip = old.magSize; old.reserve = def.reserve || 0;
          return true;
        }
        const inst = new WeaponInstance(key, def);
        const wasActive = old && ent.active === old;
        if (old) { this._removeInst(ent, old); if (slot !== 'knife' && slot !== 'c4') this._dropInst(ent, old, true); }
        inv[slot] = inst;
        const act = ent.active;
        if (!act || wasActive || slot === 'primary' || (slot === 'secondary' && (!inv.primary && act?.def?.slot !== 'primary'))) this.switchTo(ent, inst, true);
        World.emit('weapon_pickup', { ent, weapon: key });
        return true;
      }
    }
    return false;
  }

  /** Remove an item from the inventory without dropping it (C4 planted, Zeus spent...). */
  remove(ent, key) {
    if (!ent?.inventory) return false;
    this._state(ent);
    const inv = ent.inventory;
    let inst = null;
    for (const s of ['primary', 'secondary', 'knife', 'taser', 'c4']) if (inv[s] && (inv[s].key === key || inv[s] === key)) inst = inv[s];
    if (!inst) inst = inv.grenades.find((g) => g.key === key || g === key) || null;
    if (!inst) return false;
    this._removeInst(ent, inst);
    if (ent.active == null && ent.alive !== false) { if (!this._switchLast(ent)) this._switchBest(ent); }
    return true;
  }

  _removeInst(ent, inst) {
    const inv = ent.inventory;
    for (const s of ['primary', 'secondary', 'knife', 'taser', 'c4']) if (inv[s] === inst) inv[s] = null;
    const i = inv.grenades.indexOf(inst);
    if (i >= 0) inv.grenades.splice(i, 1);
    if (ent.active === inst) { this._holster(ent, inst); ent.active = null; }
    if (ent._wpn?.lastInv === inst) ent._wpn.lastInv = null;
  }

  /** Strip everything (round start for the dead, match start). */
  strip(ent) {
    if (!ent) return;
    this._state(ent);
    const inv = ent.inventory;
    if (ent.active) this._holster(ent, ent.active);
    inv.primary = inv.secondary = inv.knife = inv.taser = inv.c4 = null;
    inv.grenades.length = 0;
    ent.active = null; ent.scoped = false; ent.fov = null;
    ent._wpn.lastInv = null;
    if (ent === World.local && World.input) World.input.sensScale = 1;
  }
  clearInventory(ent) { this.strip(ent); }

  /** Drop the active item (G). Knife can't be dropped (mp_weapons_allow_drop_knife 0). */
  drop(ent) {
    const inst = ent?.active;
    if (!inst || !ent.alive) return false;
    if (inst.def.slot === 'knife' && !World.cvar.mp_weapons_allow_drop_knife) return false;
    if (inst.state === 'pin' || inst.state === 'throw') return false;
    if (inst.def.slot === 'c4' && rulesManageBomb()) {
      // the rules module owns the bomb: tell it where the C4 went
      const b = World.match.bomb;
      this._removeInst(ent, inst);
      if (b && b.carrier === ent) {
        b.state = 'dropped'; b.carrier = null; b.pos.copy(ent.origin);
        try { World.match.bombModel?.show?.(b.pos, ent.yaw || 0); } catch (err) { console.error(err); }
        World.emit('bomb_dropped', { ent, pos: b.pos.clone() });
      }
    } else {
      this._removeInst(ent, inst);
      this._dropInst(ent, inst, false);
    }
    if (!this._switchLast(ent)) this._switchBest(ent);
    return true;
  }

  // ============================================================================ zoom
  _setZoom(ent, inst, level) {
    if (!inst) { ent.scoped = false; ent.fov = null; return; }
    const d = inst.def;
    const was = inst.zoomLevel;
    // scoping in: keep only the penalty *above* the unscoped base (firing, moving, landing);
    // the zoom-settle blend in inaccuracy() is what punishes an instant scope-and-click
    if (was === 0 && level > 0 && d.alt && d.alt.inaccuracyStand !== undefined) {
      const crouch = !!(ent.ducked ?? ent.ducking);
      const base = (crouch ? d.inaccuracyCrouch : d.inaccuracyStand) * 0.001;
      const alt = (crouch ? (d.alt.inaccuracyCrouch ?? d.alt.inaccuracyStand) : d.alt.inaccuracyStand) * 0.001;
      inst.accuracyPenalty = Math.max(alt, inst.accuracyPenalty - (base - alt));
    }
    inst.zoomLevel = level;
    inst.zoomStart = this.now;
    inst.maxSpeed = level > 0 && d.maxSpeedAlt != null ? d.maxSpeedAlt : (d.maxSpeed ?? 250);
    ent.scoped = level > 0 && !!d.zoom;
    ent.zoomLevel = level;
    ent.fov = level > 0 ? d.zoom[level - 1] : null;
    ent.fovRate = level > 0 ? 3 / Math.max(0.03, d.zoomTime || 0.1) : 40;
    if (was !== level) World.emit('zoom', { ent, weapon: inst.key, level });
    if (ent === World.local) {
      if (was === 0 && level > 0) this._vmPlay('zoom_in');
      else if (was > 0 && level === 0) this._vmPlay('zoom_out');
    }
  }

  // ============================================================================ items in the world
  _dropInst(ent, inst, gentle) {
    if (!World.scene && !World.collision) return;
    angleVectors(Math.min(ent.pitch || 0, 45), ent.yaw || 0, _av);
    const pos = new THREE.Vector3();
    if (ent.eyePos) ent.eyePos(pos); else pos.set(ent.origin.x, ent.origin.y + 64, ent.origin.z);
    pos.y -= 14;
    const vel = new THREE.Vector3().copy(_av.forward).multiplyScalar(gentle ? 80 : 260);
    vel.y += gentle ? 20 : 70;
    if (ent.velocity) vel.add(ent.velocity);
    inst.state = 'idle'; inst.zoomLevel = 0; inst.reloading = false; inst.burstLeft = 0; inst.resumeZoom = 0;
    const it = { inst, key: inst.key, pos, prev: pos.clone(), vel, rest: false, dropper: ent, t0: this.now,
      mesh: this._worldMesh(inst.key), spin: (Math.random() - 0.5) * 8, yaw: (ent.yaw || 0) * DEG + Math.PI / 2 };
    this.items.push(it);
    if (it.mesh && World.scene) World.scene.add(it.mesh);
    World.emit('weapon_drop', { ent, weapon: inst.key, pos: pos.clone() });
    // CS keeps at most a few dozen weapons on the ground
    if (this.items.length > 40) this._removeItem(0);
  }

  _worldMesh(key) {
    if (!World.scene) return null;
    const def = WEAPONS[key];
    try {
      if (def?.slot === 'grenade') return buildGrenadeMesh(key);
      if (this._buildWorldModel && this._vmCfg && this._vmCfg[key]) {
        const g = this._buildWorldModel(key);
        const wrap = new THREE.Group(); wrap.add(g);
        g.rotation.z = Math.PI / 2; // lie on its side
        return wrap;
      }
    } catch (err) { Dbg.warn('[weapons] world model failed', key, err); }
    // placeholder silhouette sized by class
    const cat = def?.slot === 'secondary' ? 'pistol' : def?.slot === 'knife' ? 'knife' : def?.slot === 'c4' ? 'c4' : 'long';
    const size = { pistol: [1.2, 5, 8], knife: [0.4, 1.2, 11], c4: [7, 3, 11], long: [1.6, 3.5, 32] }[cat];
    this._placeholderMat ||= new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.55, metalness: 0.6 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), this._placeholderMat);
    m.castShadow = true;
    const g = new THREE.Group(); m.rotation.z = Math.PI / 2; g.add(m);
    return g;
  }

  _tickItems(dt) {
    const col = World.collision;
    const MN = _v.set(-3, -1, -3), MX = _v2.set(3, 3, 3);
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      it.prev.copy(it.pos);
      if (!it.rest && col) {
        it.vel.y -= (World.cvar.sv_gravity ?? 800) * dt;
        const end = _mz.copy(it.pos).addScaledVector(it.vel, dt);
        const tr = col.hullTrace(MN, MX, it.pos, end, MASK_SHOT);
        it.pos.copy(tr.endpos);
        if (tr.fraction < 1) {
          const n = tr.normal;
          const vn = it.vel.dot(n);
          it.vel.addScaledVector(n, -1.4 * vn).multiplyScalar(0.45);
          if (n.y > 0.7 && it.vel.lengthSq() < 400) { it.vel.set(0, 0, 0); it.rest = true; }
        }
        it.yaw += it.spin * dt; it.spin *= 0.98;
      }
    }
    // walk-over pickup (only into an empty slot, like CS)
    if (!this.items.length) return;
    for (const e of World.entities) {
      if (!e.alive || !e.origin || !e.inventory) continue;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (it.dropper === e && this.now - it.t0 < 1.0) continue;
        const dx = it.pos.x - e.origin.x, dz = it.pos.z - e.origin.z, dy = it.pos.y - e.origin.y;
        if (dx * dx + dz * dz > 30 * 30 || dy < -12 || dy > 72) continue;
        if (this._canTake(e, it.inst)) { this._takeItem(e, i); }
      }
    }
  }

  _canTake(ent, inst) {
    const d = inst.def, inv = ent.inventory;
    if (d.slot === 'c4') return ent.team === 'T' && !inv.c4;
    if (d.slot === 'grenade') {
      const same = inv.grenades.filter((g) => g.key === inst.key).length;
      return inv.grenades.length < MAX_GRENADES && same < (d.max || 1);
    }
    return !inv[d.slot];
  }

  _takeItem(ent, i) {
    const it = this.items[i];
    const inst = it.inst, inv = ent.inventory;
    this._removeItem(i);
    if (inst.def.slot === 'grenade') inv.grenades.push(inst);
    else inv[inst.def.slot] = inst;
    inst.state = 'idle';
    World.emit('weapon_pickup', { ent, weapon: inst.key, dropped: true });
    if (!ent.active || (inst.def.slot === 'primary' && ent.active?.def?.slot !== 'primary')) this.switchTo(ent, inst, true);
  }

  _removeItem(i) {
    const it = this.items[i];
    if (it?.mesh) it.mesh.parent?.remove(it.mesh);
    this.items.splice(i, 1);
  }

  /** E: swap for the weapon under the crosshair (within 96u). */
  _usePickup(ent) {
    if (!this.items.length) return;
    if (ent.eyePos) ent.eyePos(_v); else _v.set(ent.origin.x, ent.origin.y + 64, ent.origin.z);
    angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
    let best = -1, bd = 1e9;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      _v2.subVectors(it.pos, _v);
      const t = _v2.dot(_av.forward);
      if (t < 0 || t > 110) continue;
      const off = _v2.addScaledVector(_av.forward, -t).length();
      if (off < 18 && t < bd) { bd = t; best = i; }
    }
    if (best < 0) return;
    const it = this.items[best];
    const d = it.inst.def;
    if (d.slot === 'c4' && ent.team !== 'T') return;
    const old = d.slot === 'grenade' ? null : ent.inventory[d.slot];
    if (old) { this._removeInst(ent, old); this._dropInst(ent, old, true); }
    if (!this._canTake(ent, it.inst)) return;
    this._takeItem(ent, this.items.indexOf(it));
    this.switchTo(ent, it.inst, true);
  }

  // ============================================================================ events
  _impulse(name) {
    const ent = World.local;
    if (!ent || !ent.alive || World.hud?.captureInput || World.paused) return;
    this._state(ent);
    const inv = ent.inventory;
    switch (name) {
      case 'slot1': if (inv.primary) this.switchTo(ent, inv.primary); break;
      case 'slot2': if (inv.secondary) this.switchTo(ent, inv.secondary); break;
      case 'slot3': {
        // knife <-> zeus share slot 3
        const a = ent.active;
        if (a === inv.knife && inv.taser) this.switchTo(ent, inv.taser);
        else if (inv.knife) this.switchTo(ent, inv.knife);
        else if (inv.taser) this.switchTo(ent, inv.taser);
        break;
      }
      case 'slot4': {
        const g = inv.grenades;
        if (!g.length) break;
        // cycle through grenade types, CS order
        const order = ['hegrenade', 'flashbang', 'smokegrenade', 'decoy', 'molotov', 'incgrenade'];
        const sorted = g.slice().sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
        const types = [...new Set(sorted.map((x) => x.key))];
        const cur = ent.active?.def?.slot === 'grenade' ? types.indexOf(ent.active.key) : -1;
        const nextKey = types[(cur + 1) % types.length];
        this.switchTo(ent, sorted.find((x) => x.key === nextKey));
        break;
      }
      case 'slot5': if (inv.c4) this.switchTo(ent, inv.c4); break;
      case 'lastinv': this._switchLast(ent); break;
      case 'invnext': case 'invprev': {
        const list = this._cycleList(ent);
        if (!list.length) break;
        const i = list.indexOf(ent.active);
        const n = name === 'invnext' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        this.switchTo(ent, list[n]);
        break;
      }
      case 'drop': this.drop(ent); break;
    }
  }

  _cycleList(ent) {
    const inv = ent.inventory, out = [];
    for (const s of SLOT_ORDER) {
      if (s === 'grenade') { const seen = new Set(); for (const g of inv.grenades) if (!seen.has(g.key)) { seen.add(g.key); out.push(g); } }
      else if (inv[s]) out.push(inv[s]);
    }
    return out;
  }

  _onDeath(e) {
    const v = e?.victim;
    if (!v || !v.inventory) return;
    this._state(v);
    const inv = v.inventory;
    // CS: the best gun hits the floor (and a grenade that was in hand); the rest is lost
    const gun = inv.primary || inv.secondary;
    const act = v.active;
    if (gun) { this._removeInst(v, gun); this._dropInst(v, gun, true); }
    if (act && act.def.slot === 'grenade' && inv.grenades.includes(act)) { this._removeInst(v, act); this._dropInst(v, act, true); }
    if (inv.c4 && !rulesManageBomb()) { const c = inv.c4; this._removeInst(v, c); this._dropInst(v, c, true); }
    if (v.active) this._holster(v, v.active);
    // everything else goes with the body (rules re-kit dead players at round start)
    const keepC4 = rulesManageBomb() ? inv.c4 : null;
    inv.primary = inv.secondary = inv.taser = null; inv.grenades.length = 0; inv.knife = null;
    inv.c4 = keepC4;
    v.active = null; v.scoped = false; v.fov = null;
    if (v === World.local) {
      if (World.input) World.input.sensScale = 1;
      this._vmHide(true);
    }
  }

  _onSpawn(ent) {
    this._state(ent);
    if (ent === World.local) this._vmHide(false);
    if (!this._hasAnything(ent)) {
      for (const k of DEFAULT_LOADOUT[ent.team] || DEFAULT_LOADOUT.T) this.give(ent, k);
    }
  }

  _onRoundStart() {
    this.grenades.clear();
    while (this.items.length) this._removeItem(this.items.length - 1);
    this.c4.reset();
  }

  _plantAnimSync(ent) {
    if (ent !== World.local || !rulesManageBomb()) return;
    const b = World.match.bomb;
    const planting = b.carrier === ent && b.plantProgress > 0;
    const w = ent._wpn;
    if (planting && !w.planting) { w.planting = true; if (ent.active?.key !== 'c4') this.switchTo(ent, 'c4'); this._vmPlay('plant'); }
    else if (!planting && w.planting) { w.planting = false; if (ent.active?.key === 'c4') this._vmPlay('draw'); }
  }

  // ============================================================================ viewmodel
  _vmSet(key, draw) {
    const vm = this.viewmodel;
    if (!vm || !this._vmOk) return;
    try {
      if (this._vmKey !== key) { vm.setWeapon(key, WEAPONS[key]); this._vmKey = key; }
      else if (draw) vm.play('draw');
    } catch (err) { this._vmFail(err); }
  }
  _vmPlay(anim) {
    const vm = this.viewmodel;
    if (!vm || !this._vmOk || !this._vmKey) return;
    try { vm.play(anim); } catch (err) { this._vmFail(err); }
  }
  _vmHide(hide) {
    this._vmVisible = !hide;
    if (this.viewmodel?.root) this.viewmodel.root.visible = !hide;
  }
  _vmFail(err) {
    this._vmOk = false;
    Dbg.warn('[weapons] viewmodel disabled after error:', err?.message || err);
  }

  // ============================================================================ frame
  frame(dt) {
    const ent = World.local;
    const alpha = World.alpha ?? 1;
    if (ent) {
      this._state(ent);
      const inst = ent.active;
      // viewmodel follows the active item
      if (this.viewmodel && this._vmOk) {
        const show = !!(ent.alive && inst);
        if (show && this._vmKey !== inst.key) this._vmSet(inst.key, true);
        if (this.viewmodel.root) this.viewmodel.root.visible = show && this._vmVisible;
        if (show) {
          try {
            const vm = this.viewmodel;
            // keep the suppressor on the model in sync (e.g. after a drop / pick-up)
            if (inst.def.silencer && inst.state !== 'silencer' && vm.setSilencer && vm.silenced &&
              (vm.silenced[inst.key] ?? 1) !== (inst.silenced ? 1 : 0)) vm.setSilencer(inst.silenced);
            vm.update(dt, ent);
          } catch (err) { this._vmFail(err); }
        }
      }
      // zoom sensitivity (zoom_sensitivity_ratio * fov ratio, CS:GO)
      if (World.input) {
        const lvl = inst?.zoomLevel || 0;
        const z = lvl > 0 && inst.def.zoom ? inst.def.zoom[lvl - 1] : 0;
        World.input.sensScale = z ? (World.cvar.zoom_sensitivity_ratio ?? 1) * z / (World.cvar.fov_desired ?? 90) : 1;
      }
    }
    this.grenades.frame(dt, alpha);
    for (const it of this.items) {
      if (!it.mesh) continue;
      it.mesh.position.lerpVectors(it.prev, it.pos, alpha);
      it.mesh.rotation.set(0, it.yaw, 0);
    }
  }

  // ============================================================================ HUD helpers
  /** { key, name, clip, reserve, mag, state, zoom, silenced, burst } for the active item. */
  ammo(ent = World.local) {
    const a = ent?.active;
    if (!a) return null;
    return { key: a.key, name: a.name, clip: a.clip, reserve: a.reserve, mag: a.magSize, state: a.state,
      zoom: a.zoomLevel, silenced: a.silenced, burst: a.burstMode, grenades: ent.inventory.grenades.length };
  }
}
