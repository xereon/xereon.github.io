// One bot: perception -> decision -> aim/fire/move -> usercmd -> ent.runCommand().
//
// Bots drive the exact same movement code as the local player by emitting usercmds, and the
// WeaponSystem reads their buttons from ent.lastCmd. Decisions (think) run at ~8 Hz on a
// stagger; aim, fire and steering run every tick. Team-level intent (which route, which site,
// hold or execute) comes from TeamBrain via `this.role` and the team's phase.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { IN_ATTACK, IN_ATTACK2, IN_JUMP, IN_DUCK, IN_USE, IN_RELOAD, IN_SPEED, newCmd } from '../core/input.js';
import { angleNormalize, clamp } from '../core/mathx.js';
import { MASK_VISIBLE, MASK_PLAYER } from '../player/collision.js';
import { Aim, anglesTo } from './aim.js';
import { LINK_JUMP, LINK_CJUMP } from './navmesh.js';
import * as WI from './weaponinfo.js';
import { planThrow } from './utility.js';

const EYE = 64;
const HULL_MIN = new THREE.Vector3(-16, 0, -16), HULL_MAX = new THREE.Vector3(16, 72, 16);
const AVOID = [35, -35, 70, -70, 100, -100];
const RUN = 450;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Vector3(), _t = new THREE.Vector3();
const _ang = { pitch: 0, yaw: 0 };

function eyeOf(ent, out) {
  if (ent.eyePos) return ent.eyePos(out);
  return out.set(ent.origin.x, ent.origin.y + (ent.eyeHeight ?? EYE), ent.origin.z);
}

class Memory {
  constructor() {
    this.visible = false;
    this.firstSeen = -99;
    this.lastSeen = -99;
    this.lastCheck = -99;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.part = 0;          // 0 head, 1 chest, 2 edge
    this.lastLatSign = 0;
  }
}

export class Bot {
  constructor(mgr, ent, profile, rnd) {
    this.mgr = mgr;
    this.ent = ent;
    this.p = profile;
    this.rnd = rnd;
    this.aim = new Aim(profile, rnd);
    this.cmd = newCmd();
    this.prevButtons = 0;
    this.id = mgr.bots.length;

    // navigation
    this.path = null; this.pathIdx = 0;
    this.pathPending = false; this.pathNodes = null;
    this.goalPos = new THREE.Vector3(); this.pathGoal = new THREE.Vector3();
    this.goalKind = 'none'; this.goalRadius = 24; this.goalWalk = false; this.goalCrouch = false;
    this.goalHold = false; this.goalLook = new THREE.Vector3(); this.goalHasLook = false;
    this.goalRoute = null; this.goalRouteIdx = -1;
    this.arrived = false; this.arrivedAt = 0;
    this.moveDir = new THREE.Vector3(); this.moveSpeed = 0; this.moveWalk = false;

    // stuck handling
    this.stuckPos = new THREE.Vector3(); this.stuckCheck = 0; this.stuckTime = 0; this.stuckLevel = 0;
    this.unstickUntil = 0; this.unstickSide = 1; this.nextPathCheck = 0;
    this.avoidDir = new THREE.Vector3(); this.avoidUntil = 0; this.blockedTicks = 0;

    // perception
    this.known = new Map();
    this.target = null; this.targetMem = null;
    this.reactAt = 0; this.aimPart = 1; this.engaged = false; this.lostAt = -99;
    this.noisePos = new THREE.Vector3(); this.noiseTime = -99; this.noiseLevel = 0;
    this.threatPos = new THREE.Vector3(); this.threatTime = -99;
    this.eye = new THREE.Vector3();

    // combat
    this.nextShot = 0; this.burstLeft = 0; this.burstPauseUntil = 0; this.shooting = false;
    this.strafeDir = 1; this.strafeUntil = 0; this.crouchSpray = false; this.combatMove = 'stop';
    this.moveOverride = false;
    this.wantPitch = 0; this.wantYaw = 0; this.aimMode = 'look';
    this.wantReload = false; this.wantScope = false; this.useHeld = false; this.attackHeld = false;
    this.lastHurt = -99;

    // looking around
    this.lookPt = new THREE.Vector3(); this.lookUntil = 0;
    this.preaimPt = new THREE.Vector3(); this.preaimOk = false; this.jumpPending = false;
    this.coverPt = new THREE.Vector3(); this.coverAt = -99; this.coverOk = false;
    this.cornerL = 0; this.cornerR = 0; this.nextCorner = 0; this.idleYaw = 0; this.nextIdle = 0;

    // role / objectives
    this.role = null;
    this.task = 'idle';
    this.nextThink = 0;
    this.spawnedAt = 0;
    this.plantStart = -1; this.defuseStart = -1;
    this.nade = null; this.nextNade = 0; this.nadeRequest = null; this.flashedEntry = false;
    this.stats = { stuck: 0, kills: 0, shots: 0, nades: 0 };
    this.debug = '';
  }

  get team() { return this.ent.team; }
  get alive() { return !!this.ent.alive; }

  resetRound(now) {
    this.path = null; this.pathPending = false; this.pathNodes = null;
    this.goalKind = 'none'; this.arrived = false; this.goalRoute = null;
    this.known.clear(); this.target = null; this.targetMem = null; this.engaged = false;
    this.noiseTime = -99; this.threatTime = -99; this.lookUntil = 0;
    this.stuckTime = 0; this.stuckLevel = 0; this.unstickUntil = 0;
    this.plantStart = -1; this.defuseStart = -1; this.task = 'idle';
    this.nade = null; this.nextNade = now + 2; this.nadeRequest = null; this.flashedEntry = false; this.firedEntry = false;
    this.spawnedAt = now; this.nextThink = now + this.rnd() * 0.2;
    this.aim.reset(this.ent.pitch || 0, this.ent.yaw || 0);
    this.stuckPos.copy(this.ent.origin); this.stuckCheck = now;
  }

  // ---- perception ------------------------------------------------------------------------

  memOf(e) {
    let m = this.known.get(e);
    if (!m) { m = new Memory(); this.known.set(e, m); }
    return m;
  }

  /** LOS test against one enemy (called by the manager's budgeted scheduler). */
  checkVisibility(e, now) {
    const m = this.memOf(e);
    m.lastCheck = now;
    const eye = eyeOf(this.ent, this.eye);
    const tEye = eyeOf(e, _e);
    const dx = tEye.x - eye.x, dy = tEye.y - eye.y, dz = tEye.z - eye.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    let vis = false, part = 0;
    const tracking = e === this.target && now - m.lastSeen < 1.0;
    if (d2 < 4200 * 4200) {
      // vision cone (~110° horizontal) unless we're already tracking this enemy
      anglesTo(eye.x, eye.y, eye.z, tEye.x, tEye.y, tEye.z, _ang);
      const dyaw = Math.abs(angleNormalize(_ang.yaw - this.aim.yaw));
      const dpit = Math.abs(_ang.pitch - this.aim.pitch);
      const blind = World.fx?.blindAmount?.(this.ent) ?? 0;
      if ((tracking || (dyaw < 56 && dpit < 50)) && blind < 0.55) {
        const cw = World.collision;
        const smoke = World.fx?.smokeOcclusion;
        // head, then chest, then a shoulder edge (half-peeking players)
        _t.copy(tEye); _t.y += 2;
        if (cw.rayTrace(eye, _t, MASK_VISIBLE).fraction >= 1) { vis = true; part = 0; }
        else {
          _t.set(e.origin.x, e.origin.y + (e.eyeHeight ?? EYE) * 0.72, e.origin.z);
          if (cw.rayTrace(eye, _t, MASK_VISIBLE).fraction >= 1) { vis = true; part = 1; }
          else if (d2 < 2000 * 2000) {
            const h = Math.sqrt(dx * dx + dz * dz) || 1;
            _t.x += (-dz / h) * 13 * (this.rnd() < 0.5 ? 1 : -1); _t.z += (dx / h) * 13;
            if (cw.rayTrace(eye, _t, MASK_VISIBLE).fraction >= 1) { vis = true; part = 2; }
          }
        }
        if (vis && smoke) { const s = smoke.call(World.fx, eye, _t.copy(tEye)); if (s > 0.6) vis = false; }
      }
    }
    if (vis) {
      if (!m.visible || now - m.lastSeen > 0.6) m.firstSeen = now;
      m.visible = true; m.lastSeen = now; m.part = part;
      m.pos.copy(e.origin); if (e.velocity) m.vel.copy(e.velocity);
      this.mgr.teamOf(this.team)?.report(e, m.pos, now, this);
    } else m.visible = false;
    return vis;
  }

  hear(pos, level, now, ent = null) {
    // louder / newer noises replace older ones
    if (now - this.noiseTime > 2.5 || level >= this.noiseLevel) {
      this.noisePos.copy(pos);
      // positional uncertainty grows with distance
      const d = pos.distanceTo(this.ent.origin);
      const err = Math.min(220, d * 0.08);
      this.noisePos.x += (this.rnd() * 2 - 1) * err; this.noisePos.z += (this.rnd() * 2 - 1) * err;
      this.noiseTime = now; this.noiseLevel = level;
    }
    if (ent && level >= 2) { const m = this.memOf(ent); if (!m.visible) m.pos.copy(ent.origin); }
  }

  hurtBy(attacker, now) {
    this.lastHurt = now;
    if (!attacker || attacker.team === this.team) return;
    this.threatPos.copy(attacker.origin); this.threatTime = now;
    this.hear(attacker.origin, 3, now, attacker);
  }

  selectTarget(now) {
    let best = null, bs = -Infinity, bm = null;
    const eye = this.eye;
    for (const [e, m] of this.known) {
      if (!e.alive || e.team === this.team) continue;
      if (!m.visible || now - m.lastSeen > 0.3) continue;
      const d = Math.hypot(m.pos.x - eye.x, m.pos.z - eye.z);
      anglesTo(eye.x, eye.y, eye.z, m.pos.x, m.pos.y + EYE, m.pos.z, _ang);
      const off = Math.abs(angleNormalize(_ang.yaw - this.aim.yaw));
      let s = -d / 400 - off / 30;
      if (e === this.target) s += 1.5;                 // stick with the current fight
      if (m.pos.distanceTo(this.threatPos) < 150 && now - this.threatTime < 2) s += 1; // who's shooting me
      if (s > bs) { bs = s; best = e; bm = m; }
    }
    if (best !== this.target) {
      if (best) {
        // reaction time: slower at the edge of view, faster on an angle we're already holding
        anglesTo(eye.x, eye.y, eye.z, bm.pos.x, bm.pos.y + EYE, bm.pos.z, _ang);
        const off = Math.abs(angleNormalize(_ang.yaw - this.aim.yaw));
        const [r0, r1] = this.p.reaction;
        let react = r0 + (r1 - r0) * this.rnd();
        react *= 1 + clamp(off / 60, 0, 1) * 0.5;
        if (off < 8) react *= 0.65;                         // pre-aimed angle
        if (this.target && now - this.lostAt < 1.5) react *= 0.6; // re-acquire
        if (now - this.noiseTime < 1.5 && bm.pos.distanceTo(this.noisePos) < 400) react *= 0.8;
        const blind = World.fx?.blindAmount?.(this.ent) ?? 0;
        react *= 1 + blind * 2;
        this.reactAt = now + react;
        const lat = Math.hypot(bm.vel.x, bm.vel.z) / 250;
        this.aim.acquire(clamp(lat, 0, 1), this.engaged ? 0 : 0.5);
        this.aimPart = this.rnd() < this.p.headRatio ? 0 : 1;
        if (!this.engaged) this.mgr.radio(this, 'contact', bm.pos);
        this.engaged = true;
        this.burstLeft = 0;
      } else {
        this.lostAt = now;
      }
      this.target = best; this.targetMem = bm;
    }
    return best;
  }

  // ---- main per-tick ---------------------------------------------------------------------

  update(dt, now) {
    const ent = this.ent, cmd = this.cmd;
    cmd.forwardmove = 0; cmd.sidemove = 0; cmd.upmove = 0; cmd.buttons = 0;
    if (!ent.alive) { ent.lastCmd = cmd; return; }
    eyeOf(ent, this.eye);
    const frozen = this.mgr.frozen || this.mgr.freezeTime();
    if (frozen) {
      this.aim.update(dt, this.aim.pitch * 0.9, this.aim.yaw, 'look');
      this.issue(dt);
      return;
    }
    this.selectTarget(now);
    if (now >= this.nextThink) {
      this.nextThink = now + 0.1 + this.rnd() * 0.06;
      this.think(now);
    }
    this.moveOverride = false;
    this.aimMode = 'look';
    this.inFire = this.fireAt(ent.origin, 20);
    const throwing = this.nade && this.runNade(now);
    if (!throwing) this.combat(dt, now);
    if (!this.moveOverride) this.followPath(dt, now);
    if (this.inFire && this.task !== 'defuse' && this.task !== 'plant') {
      // burning: get out the shortest way
      const f = this.inFire;
      this.moveDir.set(ent.origin.x - f.pos.x, 0, ent.origin.z - f.pos.z).normalize();
      this.moveSpeed = 1; this.moveWalk = false; this.moveOverride = true;
    } else if (this.moveSpeed > 0 && !this.moveOverride && this.path && this.pathIdx < this.path.length &&
               this.task !== 'flee' && this.task !== 'defuse' && this.fireAt(this.path[this.pathIdx], 40)) {
      this.moveSpeed = 0;                     // wait for the molly to burn out
    }
    if (this.aimMode === 'look' && !throwing) this.chooseLook(now);
    this.aim.update(dt, this.wantPitch, this.wantYaw, this.aimMode === 'nade' ? 'look' : this.aimMode);
    this.steer(now);
    this.objectiveButtons(now);
    this.issue(dt);
    this.checkStuck(now);
  }

  issue(dt) {
    const cmd = this.cmd, ent = this.ent;
    cmd.pitch = this.aim.pitch; cmd.yaw = (this.aim.yaw + 360) % 360;
    ent.lastCmd = cmd;
    ent.runCommand?.(cmd, dt);
    this.prevButtons = cmd.buttons;
  }

  // ---- decisions -------------------------------------------------------------------------

  think(now) {
    const team = this.mgr.teamOf(this.team);
    if (!team) return;
    // trading: a teammate just died near us — go where the shots came from
    if (!this.target && now - this.threatTime < 3 && this.task !== 'plant' && this.task !== 'defuse' &&
        this.task !== 'save' && this.p.aggression > 0.45 && this.ent.origin.distanceTo(this.threatPos) < 1400 &&
        !this.mgr.bomb.planted) {
      this.task = 'trade';
      this.setGoal('trade', this.threatPos, { radius: 120, look: this.threatPos });
      return;
    }
    // no rifle? grab one lying nearby once the area is quiet (walk-over pickup fills the slot)
    if (!this.target && now - this.lostAt > 2 && this.task !== 'plant' && this.task !== 'defuse' && this.task !== 'flee' &&
        !WI.slotItem(this.ent, 'primary') && this.lookForGun(now)) return;
    team.decide(this, now);
    this.updatePreaim();
    if (!this.nade && now >= this.nextNade) this.considerUtility(now);
    // pick cover once per reload/retreat need
    if (this.target && this.needCover && now - this.coverAt > 1.5) {
      this.coverAt = now;
      const m = this.targetMem;
      _e.set(m.pos.x, m.pos.y + EYE, m.pos.z);
      const spots = World.nav?.hidingSpots?.(_e, this.ent.origin, 360, 1, 24);
      this.coverOk = !!spots?.length;
      if (this.coverOk) World.nav.pos(spots[0], this.coverPt);
    }
  }

  lookForGun(now) {
    const items = World.weapons?.items;
    if (!items?.length) return false;
    const o = this.ent.origin;
    let best = null, bd = 650 * 650;
    for (const it of items) {
      const d = it.inst?.def;
      if (!d || d.slot !== 'primary' || !it.pos) continue;
      const dy = it.pos.y - o.y;
      if (dy < -80 || dy > 80) continue;
      const d2 = (it.pos.x - o.x) ** 2 + (it.pos.z - o.z) ** 2;
      if (d2 < bd) { bd = d2; best = it; }
    }
    if (!best) return false;
    this.task = 'pickup';
    this.setGoal('pickup', best.pos, { radius: 10 });
    return true;
  }

  /** Point the bot at a destination. Repaths only when it actually changed. */
  setGoal(kind, pos, o = {}) {
    const changed = kind !== this.goalKind || this.goalPos.distanceToSquared(pos) > 48 * 48 ||
      (o.route || null) !== this.goalRoute || (o.routeIdx ?? -1) !== this.goalRouteIdx;
    this.goalKind = kind;
    this.goalRadius = o.radius ?? 28;
    this.goalWalk = !!o.walk;
    this.goalCrouch = !!o.crouch;
    this.goalHold = !!o.hold;
    if (o.look) { this.goalLook.copy(o.look); this.goalHasLook = true; } else this.goalHasLook = false;
    if (!changed) return;
    this.goalPos.copy(pos);
    this.goalRoute = o.route || null; this.goalRouteIdx = o.routeIdx ?? -1;
    this.arrived = false;
    this.requestPath();
  }

  requestPath() {
    if (!this.pathPending) { this.pathPending = true; this.mgr.queuePath(this); }
  }

  /** Called by the manager when this bot's path request comes up. */
  computePath() {
    this.pathPending = false;
    const nav = World.nav;
    if (!nav?.count) { this.path = null; return; }
    let nodes = null;
    if (this.goalRoute && this.mgr.intel?.ready) nodes = this.mgr.intel.routeNodes(this.goalRoute, this.ent.origin, this.goalRouteIdx);
    if (!nodes) nodes = nav.astar(nav.nearestReachable(this.ent.origin), nav.nearest(this.goalPos, 60), { maxExpand: 40000 });
    if (!nodes) { this.path = null; this.pathFail = (this.pathFail || 0) + 1; return; }
    this.pathFail = 0;
    this.pathNodes = nodes;
    this.path = nav.smooth(nodes, this.goalRoute ? null : this.goalPos);
    this.pathIdx = 0;
    // skip a first waypoint that's behind us
    if (this.path.length > 1) {
      const a = this.path[0], b = this.path[1], o = this.ent.origin;
      if ((b.x - a.x) * (o.x - a.x) + (b.z - a.z) * (o.z - a.z) > 0 && !this.blockedAhead(b, Math.hypot(b.x - o.x, b.z - o.z) || 1)) this.pathIdx = 1;
    }
    // shortcuts were validated from the start node, not from where we stand: if we can't sweep
    // straight to the first waypoint (we're off to the side of a doorway), go via the node
    const w = this.path[this.pathIdx], o = this.ent.origin;
    if (w && nodes.length > 1) {
      const d = Math.hypot(w.x - o.x, w.z - o.z);
      if (d > 30 && this.blockedAhead(w, d)) {
        const v = nav.pos(nodes[0]); v.n = nodes[0]; v.t = 0;
        this.path.splice(this.pathIdx, 0, v);
      }
    }
    this.pathGoal.copy(this.goalPos);
  }

  // ---- movement --------------------------------------------------------------------------

  followPath(dt, now) {
    const o = this.ent.origin;
    this.moveSpeed = 0;
    if (!this.path || this.pathIdx >= this.path.length) {
      if (this.path && !this.arrived) { this.arrived = true; this.arrivedAt = now; }
      // final approach when the path ended short of the goal
      if (this.goalKind !== 'none' && !this.pathPending && this.arrived) {
        const d = Math.hypot(this.goalPos.x - o.x, this.goalPos.z - o.z);
        if (d > this.goalRadius && d < 96 && !(this.goalHold && this.mgr.spotTaken(this, this.goalPos))) { this.moveDir.set(this.goalPos.x - o.x, 0, this.goalPos.z - o.z).normalize(); this.moveSpeed = 1; this.moveWalk = true; }
      }
      return;
    }
    let w = this.path[this.pathIdx];
    let dx = w.x - o.x, dz = w.z - o.z;
    let d = Math.hypot(dx, dz);
    const last = this.pathIdx === this.path.length - 1;
    let r = last ? this.goalRadius : 22;
    if (last && this.goalHold && d < 110 && this.mgr.spotTaken(this, w)) r = 110;
    // passed it (projected past the waypoint along the next segment) or a friend is standing on it
    let passed = false;
    if (!last && d < 90 && Math.abs(w.y - o.y) < 40) {
      const n = this.path[this.pathIdx + 1];
      const sx = n.x - w.x, sz = n.z - w.z;
      if ((o.x - w.x) * sx + (o.z - w.z) * sz > 0 && n.t !== LINK_JUMP && n.t !== LINK_CJUMP) passed = true;
      else if (d < 70 && this.mgr.spotTaken(this, w)) passed = true;
    }
    if (passed || (d < r && Math.abs(w.y - o.y) < 52)) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) { this.arrived = true; this.arrivedAt = now; return; }
      w = this.path[this.pathIdx]; dx = w.x - o.x; dz = w.z - o.z; d = Math.hypot(dx, dz);
    }
    this.arrived = false;
    // displaced off the path (fight, teammate, knock-back)? repath if a wall now blocks the way
    if (now >= this.nextPathCheck) {
      this.nextPathCheck = now + 0.3 + this.rnd() * 0.1;
      if (d > 40 && !this.pathPending && this.blockedAhead(w, d)) this.requestPath();
    }
    this.moveDir.set(dx, 0, dz).multiplyScalar(1 / (d || 1));
    this.moveSpeed = 1;
    this.moveWalk = this.goalWalk;
    // jump links: hop when close to the ledge; crouch-jump tucks legs in the air
    if ((w.t === LINK_JUMP || w.t === LINK_CJUMP) && d < 60 && w.y - o.y > 12) {
      if (this.ent.onGround !== false && !(this.prevButtons & IN_JUMP)) this.cmd.buttons |= IN_JUMP;
      if (w.t === LINK_CJUMP || this.ent.onGround === false) this.cmd.buttons |= IN_DUCK;
    }
    // slow down for the last stretch so we don't overshoot a hold spot
    if (last && d < 90 && this.goalHold) this.moveWalk = true;
  }

  /**
   * Corner snag handling: if we push but barely move, probe rotated directions with short hull
   * sweeps and take the first free one that still makes progress (slides us round the corner).
   */
  avoidObstacles(now) {
    const v = this.ent.velocity;
    const sp = v ? Math.hypot(v.x, v.z) : 0;
    const want = this.moveWalk ? 110 : 200;
    if (now < this.avoidUntil) { this.moveDir.copy(this.avoidDir); return; }
    if (sp < want * 0.3 && this.ent.onGround !== false) this.blockedTicks = (this.blockedTicks || 0) + 1;
    else this.blockedTicks = 0;
    if (this.blockedTicks < 10) return;
    this.blockedTicks = 0;
    const o = this.ent.origin, cw = World.collision;
    const base = Math.atan2(this.moveDir.z, this.moveDir.x);
    for (const deg of AVOID) {
      const a = base + deg * Math.PI / 180;
      const dx = Math.cos(a), dz = Math.sin(a);
      _t.set(o.x, o.y + 2, o.z); _v.set(o.x + dx * 24, o.y + 2, o.z + dz * 24);
      let tr = cw.hullTrace(HULL_MIN, HULL_MAX, _t, _v, MASK_PLAYER);
      if (tr.startSolid || tr.fraction < 0.9) {
        _t.y += 18; _v.y += 18;
        tr = cw.hullTrace(HULL_MIN, HULL_MAX, _t, _v, MASK_PLAYER);
        if (tr.startSolid || tr.fraction < 0.9) continue;
      }
      this.avoidDir.set(dx, 0, dz);
      this.avoidUntil = now + 0.18;
      this.moveDir.copy(this.avoidDir);
      return;
    }
  }

  /** Hull sweep (lifted by step height) from us toward waypoint w: true when a wall is in the way. */
  blockedAhead(w, d) {
    const o = this.ent.origin, cw = World.collision;
    const len = Math.min(d, 160);
    _t.set(o.x, o.y + 18, o.z);
    _v.set(o.x + (w.x - o.x) / d * len, Math.max(o.y, Math.min(w.y, o.y + 18 * len / 24)) + 18, o.z + (w.z - o.z) / d * len);
    const tr = cw.hullTrace(HULL_MIN, HULL_MAX, _t, _v, MASK_PLAYER);
    return !tr.startSolid && tr.fraction < 0.95;
  }

  steer(now) {
    const cmd = this.cmd;
    if (now < this.unstickUntil) {
      // wiggle free: strafe + jump + use (doors)
      cmd.sidemove = RUN * this.unstickSide; cmd.forwardmove = RUN * 0.6;
      if (this.stuckLevel <= 2) cmd.buttons |= IN_USE;
      if (this.jumpPending && !(this.prevButtons & IN_JUMP)) { cmd.buttons |= IN_JUMP; this.jumpPending = false; }
      return;
    }
    if (this.moveSpeed <= 0) { this.blockedTicks = 0; return; }
    this.avoidObstacles(now);
    const y = this.aim.yaw * Math.PI / 180;
    const fx = Math.cos(y), fz = -Math.sin(y), rx = Math.sin(y), rz = Math.cos(y);
    const mx = this.moveDir.x, mz = this.moveDir.z;
    let spd = RUN * this.moveSpeed;
    // teammate separation: sidestep a friend right in front of us
    const sep = this.mgr.separation(this, _v);
    const ax = mx + sep.x, az = mz + sep.z, al = Math.hypot(ax, az) || 1;
    cmd.forwardmove = (ax * fx + az * fz) / al * spd;
    cmd.sidemove = (ax * rx + az * rz) / al * spd;
    if (this.moveWalk) { cmd.buttons |= IN_SPEED; }
    if (this.goalCrouch && this.arrived) cmd.buttons |= IN_DUCK;
  }

  checkStuck(now) {
    if (now - this.stuckCheck < 0.5) return;
    const o = this.ent.origin;
    const moved = Math.hypot(o.x - this.stuckPos.x, o.z - this.stuckPos.z);
    this.stuckPos.copy(o); this.stuckCheck = now;
    const trying = ((this.moveSpeed > 0 && !this.moveOverride && !this.arrived) || now < this.unstickUntil);
    if (!trying || moved > (this.moveWalk ? 10 : 18)) { this.stuckTime = 0; if (moved > 40) this.stuckLevel = 0; return; }
    this.stuckTime += 0.5;
    if (this.stuckTime < 1) return;
    this.stuckTime = 0;
    // blocked by a teammate (players are solid): that's traffic, not bad nav — sidestep
    if (this.mgr.friendAhead(this, 56)) {
      this.unstickUntil = now + 0.4; this.unstickSide = this.id % 2 ? 1 : -1;
      this.mgr.stats.blocked = (this.mgr.stats.blocked || 0) + 1;
      return;
    }
    // embedded in geometry (bad spawn / pushed into a prop): pop to the nearest nav spot
    if (this.mgr.embedded(this.ent)) { this.mgr.rescue(this); this.stuckLevel = 0; return; }
    this.stuckLevel++;
    this.stats.stuck++;
    this.mgr.stats.stuck++;
    this.mgr.logEvent('stuck', { bot: this.ent.name, level: this.stuckLevel, pos: o.toArray().map(Math.round), area: World.nav?.areaOf?.(o) || '',
      task: this.task, goal: this.goalKind, arrived: this.arrived, wp: this.path ? `${this.pathIdx}/${this.path.length}` : '-', gd: Math.round(Math.hypot(this.goalPos.x - o.x, this.goalPos.z - o.z)), tgt: !!this.target, ov: this.moveOverride });
    const nav = World.nav;
    if (this.stuckLevel === 1) {
      this.unstickUntil = now + 0.45; this.unstickSide = this.rnd() < 0.5 ? -1 : 1;
      this.jumpPending = true;
      this.mgr.defer(() => this.requestPath());
    } else if (this.stuckLevel === 2) {
      // the link ahead is bad for players: teach the nav and repath
      const w = this.path?.[this.pathIdx];
      if (w?.n >= 0) nav?.penalize(w.n, 600);
      this.unstickUntil = now + 0.3; this.unstickSide = -this.unstickSide;
      this.requestPath();
    } else if (this.stuckLevel === 3) {
      // re-centre on the nearest node, then repath
      const k = nav?.nearest(o);
      if (k >= 0) { this.path = [nav.pos(k)]; this.path[0].t = 0; this.path[0].n = k; this.pathIdx = 0; }
      setTimeout0(() => this.requestPath(), this);
    } else {
      this.unstickUntil = now + 0.6; this.unstickSide = this.rnd() < 0.5 ? -1 : 1;
      this.jumpPending = true;
      this.stuckLevel = 1;
      this.goalKind = 'none';
    }
  }

  // ---- looking ---------------------------------------------------------------------------

  chooseLook(now) {
    const eye = this.eye;
    let tx, ty, tz;
    const noiseFresh = now - this.noiseTime < 2.2 && this.noiseLevel >= 1;
    if (now - this.threatTime < 2.5) { tx = this.threatPos.x; ty = this.threatPos.y + 56; tz = this.threatPos.z; }
    else if (this.targetMem && now - this.lostAt < 2.0 && this.lostAt > 0) {
      // pre-aim where the enemy disappeared
      const m = this.targetMem; tx = m.pos.x; ty = m.pos.y + 60; tz = m.pos.z;
    } else if (noiseFresh) { tx = this.noisePos.x; ty = this.noisePos.y + 56; tz = this.noisePos.z; }
    else if (this.arrived && this.goalHasLook) {
      tx = this.goalLook.x; ty = this.goalLook.y; tz = this.goalLook.z;
      // idle scan around the held angle
      if (now > this.nextIdle) { this.nextIdle = now + 1.5 + this.rnd() * 2.5; this.idleYaw = (this.rnd() * 2 - 1) * 14; }
      anglesTo(eye.x, eye.y, eye.z, tx, ty, tz, _ang);
      this.wantPitch = _ang.pitch; this.wantYaw = _ang.yaw + this.idleYaw * 0.5;
      return;
    } else if (now < this.lookUntil) { tx = this.lookPt.x; ty = this.lookPt.y; tz = this.lookPt.z; }
    else if (this.preaimOk) { tx = this.preaimPt.x; ty = this.preaimPt.y; tz = this.preaimPt.z; }
    else if (this.moveSpeed > 0) {
      this.cornerCheck(now);
      if (now < this.lookUntil) { tx = this.lookPt.x; ty = this.lookPt.y; tz = this.lookPt.z; }
      else { const p = this.lookAhead(_w, 320); tx = p.x; ty = p.y + EYE - 4; tz = p.z; }
    } else {
      if (now > this.nextIdle) { this.nextIdle = now + 1.2 + this.rnd() * 2; this.idleYaw = this.aim.yaw + (this.rnd() * 2 - 1) * 70; }
      this.wantPitch = 2; this.wantYaw = this.idleYaw;
      return;
    }
    anglesTo(eye.x, eye.y, eye.z, tx, ty, tz, _ang);
    this.wantPitch = _ang.pitch; this.wantYaw = _ang.yaw;
  }

  /** Point on the path ~dist ahead of us (for natural head direction while running). */
  lookAhead(out, dist) {
    const o = this.ent.origin;
    if (!this.path || this.pathIdx >= this.path.length) return out.copy(o).addScaledVector(this.moveDir, dist);
    let px = o.x, py = o.y, pz = o.z, left = dist;
    for (let i = this.pathIdx; i < this.path.length; i++) {
      const w = this.path[i];
      const seg = Math.hypot(w.x - px, w.z - pz);
      if (seg >= left) { const t = left / seg; return out.set(px + (w.x - px) * t, py + (w.y - py) * t, pz + (w.z - pz) * t); }
      left -= seg; px = w.x; py = w.y; pz = w.z;
    }
    return out.set(px, py, pz);
  }

  /** Pre-aim common angles (CT holds / plant spots). Runs at think rate, ≤ 3 rays. */
  updatePreaim() {
    this.preaimOk = false;
    const list = this.mgr.teamOf(this.team)?.preaimSpots(this);
    if (!list?.length || this.target) return;
    const eye = this.eye;
    const my = Math.atan2(-this.moveDir.z, this.moveDir.x) * 180 / Math.PI;
    const cand = this._pa || (this._pa = []);
    cand.length = 0;
    for (const p of list) {
      const d = Math.hypot(p.x - eye.x, p.z - eye.z);
      if (d > 1500 || d < 120) continue;
      anglesTo(eye.x, eye.y, eye.z, p.x, p.y, p.z, _ang);
      const off = Math.abs(angleNormalize(_ang.yaw - my));
      if (this.moveSpeed > 0 && off > 100) continue;
      cand.push({ p, s: d + off * 4 });
    }
    cand.sort((a, b) => a.s - b.s);
    for (let i = 0; i < cand.length && i < 3; i++) {
      if (World.collision.rayTrace(eye, cand[i].p, MASK_VISIBLE).fraction < 0.97) continue;
      this.preaimPt.copy(cand[i].p); this.preaimOk = true; return;
    }
  }

  // Check openings to the sides as we pass them (how people clear corners).
  cornerCheck(now) {
    if (now < this.nextCorner) return;
    this.nextCorner = now + 0.35 + this.rnd() * 0.15;
    const eye = this.eye, cw = World.collision;
    const my = Math.atan2(-this.moveDir.z, this.moveDir.x);
    let bestSide = 0, bestD = 0, bestYaw = 0;
    for (const side of [-1, 1]) {
      const a = my + side * (55 + this.rnd() * 30) * Math.PI / 180;
      _t.set(eye.x + Math.cos(a) * 1400, eye.y, eye.z - Math.sin(a) * 1400);
      const d = cw.rayTrace(eye, _t, MASK_VISIBLE).fraction * 1400;
      const prev = side < 0 ? this.cornerL : this.cornerR;
      if (side < 0) this.cornerL = d; else this.cornerR = d;
      if (prev < 260 && d > 600 && d - prev > bestD) { bestD = d - prev; bestSide = side; bestYaw = a; }
    }
    if (bestSide) {
      const d = Math.min(900, bestD);
      this.lookPt.set(eye.x + Math.cos(bestYaw) * d, eye.y, eye.z - Math.sin(bestYaw) * d);
      this.lookUntil = now + 0.5 + this.rnd() * 0.5;
    }
  }

  // ---- combat ----------------------------------------------------------------------------

  combat(dt, now) {
    const ent = this.ent, cmd = this.cmd;
    const tgt = this.target;
    const key = WI.activeKey(ent);
    const item = WI.activeItem(ent);
    const clip = WI.clipOf(item);
    const cls = WI.weaponClass(key);

    // weapon housekeeping out of combat
    if (!tgt) {
      this.shooting = false; this.crouchSpray = false;
      const best = WI.bestGunKey(ent);
      if (this.goalKind !== 'plant' && key !== best && (cls === 'knife' || cls === 'grenade' || cls === 'c4' || now - this.lostAt > 1.5)) {
        if (!(cls === 'c4' && this.task === 'plant')) WI.switchTo(ent, best);
      }
      const mag = WI.magSize(key, item);
      if (clip !== null && clip < mag * 0.45 && now - this.lostAt > 2.5 && !WI.isReloading(ent) && cls !== 'knife') cmd.buttons |= IN_RELOAD;
      if (clip === 0) cmd.buttons |= IN_RELOAD;
      // snipers keep the scope up while holding an angle
      if (cls === 'sniper' && this.arrived && this.goalHold && !this.isScoped() && this.rnd() < 0.02) this.pressAttack2();
      return;
    }
    if (now < this.reactAt) return;

    const m = this.targetMem;
    const visible = m.visible && now - m.lastSeen < 0.25;
    const blind = World.fx?.blindAmount?.(ent) ?? 0;
    if (blind > 0.3 && this.rnd() < 0.04) this.aim.disturb(blind * 2.5);
    if (!visible) {
      // lost sight: keep the crosshair where they were; flashed bots spray at the last spot
      this.aimMode = 'combat';
      if (blind > 0.6 && now - m.lastSeen < 1.2 && clip !== 0 && !WI.isSemi(key) && cls !== 'knife') cmd.buttons |= IN_ATTACK;
      const lag = now - m.lastSeen;
      anglesTo(this.eye.x, this.eye.y, this.eye.z, m.pos.x + m.vel.x * lag * 0.5, m.pos.y + (m.part === 0 ? 62 : 46), m.pos.z + m.vel.z * lag * 0.5, _ang);
      this.wantPitch = _ang.pitch; this.wantYaw = _ang.yaw;
      if (now - m.lastSeen > 1.0) { this.target = null; this.lostAt = now; }
      this.moveOverride = this.p.aggression < 0.55 || this.goalHold;
      if (this.moveOverride) this.counterStrafe();
      return;
    }

    // --- aim point: head or upper chest, where the enemy was trackLag seconds ago
    const lag = this.p.trackLag;
    const tE = eyeOf(tgt, _e);
    const vx = tgt.velocity?.x || 0, vz = tgt.velocity?.z || 0;
    const d = Math.hypot(tE.x - this.eye.x, tE.z - this.eye.z);
    let part = this.aimPart;
    if (m.part === 1) part = 1;
    if (cls === 'sniper' && key === 'awp') part = 1;
    const eh = tgt.eyeHeight ?? EYE;
    const ax = tE.x - vx * lag, az = tE.z - vz * lag;
    const ay = part === 0 ? tE.y + 1 : tgt.origin.y + eh * 0.68;
    // strafe reversals throw aim off
    const lat = (vx * (tE.z - this.eye.z) - vz * (tE.x - this.eye.x)) / (d || 1);
    const sgn = Math.sign(Math.round(lat / 60));
    if (sgn && m.lastLatSign && sgn !== m.lastLatSign) this.aim.disturb(Math.min(1, d / 1500 + 0.3));
    if (sgn) m.lastLatSign = sgn;

    anglesTo(this.eye.x, this.eye.y, this.eye.z, ax, ay, az, _ang);
    // recoil control: pull against aim punch
    const punch = ent.aimPunch;
    const scale = World.cvar.weapon_recoil_scale ?? 2;
    let pp = 0, py = 0;
    if (punch) { pp = (punch.pitch || 0) * scale; py = (punch.yaw || 0) * scale; }
    const comp = this.p.recoilComp;
    this.wantPitch = _ang.pitch - pp * comp;
    this.wantYaw = _ang.yaw - py * comp;
    this.aimMode = 'combat';

    // --- weapon state
    if (clip === 0 || cls === 'grenade' || cls === 'c4') {
      const sec = WI.keyOf(WI.slotItem(ent, 'secondary'));
      const secClip = WI.clipOf(WI.slotItem(ent, 'secondary'));
      if (cls !== 'pistol' && cls !== 'deagle' && sec && secClip !== 0 && d < 900) WI.switchTo(ent, sec);
      else if (cls === 'grenade' || cls === 'c4') WI.switchTo(ent, WI.bestGunKey(ent));
      else { cmd.buttons |= IN_RELOAD; this.retreat(now); }
      return;
    }
    if (WI.isReloading(ent)) { this.retreat(now); return; }
    this.needCover = false;

    // --- movement style
    const speed = Math.hypot(ent.velocity?.x || 0, ent.velocity?.z || 0);
    const bulletErr = this.aim.onTarget + Math.hypot(pp, py) * (1 - comp);
    const radius = part === 0 ? 4.5 : 8;
    const tol = Math.max(0.35, Math.atan2(radius, d) * 180 / Math.PI) * this.p.fireTolerance;
    const close = d < 420;
    this.moveOverride = true;
    let accurateEnough = true;
    if (cls === 'knife') {
      this.moveDir.set(tE.x - this.eye.x, 0, tE.z - this.eye.z).normalize(); this.moveSpeed = 1; this.moveWalk = false;
      if (d < 70) this.tapAttack(now, 0.4);
      return;
    }
    const strafer = cls === 'pistol' || cls === 'smg' || cls === 'shotgun' || cls === 'taser';
    if (strafer && (close || cls === 'smg' && d < 700) && this.p.skill > 0.3) {
      // ADAD: switch direction every few hundred ms; SMGs fire on the move up close
      if (now > this.strafeUntil) { this.strafeDir = -this.strafeDir; this.strafeUntil = now + 0.22 + this.rnd() * 0.4; }
      const y = _ang.yaw * Math.PI / 180;
      this.moveDir.set(Math.sin(y) * this.strafeDir, 0, Math.cos(y) * this.strafeDir);
      this.moveSpeed = 1; this.moveWalk = false;
      if (cls === 'pistol' || cls === 'shotgun') accurateEnough = speed < 110 || d < 200;
    } else {
      // rifles/snipers/MGs: stop to shoot — counter-strafe hard when skilled
      const wantStop = bulletErr < tol * 4 || this.shooting;
      if (wantStop) {
        if (this.rnd() < this.p.counterStrafe || speed < 60) this.counterStrafe(); else { this.moveSpeed = 0; }
        accurateEnough = speed < (cls === 'sniper' ? 40 : 85);
      } else {
        // still flicking: keep drifting where we were going
        this.moveOverride = false;
      }
      if (this.shooting && this.crouchSpray) cmd.buttons |= IN_DUCK;
    }

    // --- firing (never through a teammate)
    if (this.friendInLine(tE, d)) { this.shooting = false; return; }
    if (cls === 'sniper' && !this.isScoped() && d > 250) { this.pressAttack2(); return; }
    const semi = WI.isSemi(key);
    if (!accurateEnough) { this.shooting = false; return; }
    if (now < this.burstPauseUntil) return;
    const sprayTol = tol * (this.shooting ? 2.6 - this.p.burstDiscipline : 1);
    if (bulletErr > sprayTol) {
      if (this.shooting) { this.shooting = false; this.burstPauseUntil = now + 0.08 + this.rnd() * 0.12; }
      return;
    }
    if (semi) {
      let cad;
      if (cls === 'sniper') cad = key === 'awp' ? 1.45 : 1.25;
      else if (cls === 'deagle') cad = 0.32 + d / 5000;
      else if (cls === 'shotgun') cad = 0.85;
      else cad = 0.14 + d / 4500 + (1 - this.p.skill) * 0.08;
      this.tapAttack(now, cad);
      return;
    }
    // automatic: spray up close, bursts mid, taps long
    if (!this.shooting) {
      this.shooting = true;
      if (d < 550) this.burstLeft = 30;
      else if (d < 1300) this.burstLeft = 3 + ((this.rnd() * 4) | 0);
      else this.burstLeft = 1 + ((this.rnd() * 2) | 0);
      this.crouchSpray = d > 500 && this.rnd() < this.p.crouchSpray && cls !== 'smg';
      this.burstShots = 0;
    }
    cmd.buttons |= IN_ATTACK;
    this.attackHeld = true;
    // count shots from the clip so bursts end on time
    if (clip !== null) {
      if (this._lastClip !== undefined && clip < this._lastClip) { this.burstLeft -= this._lastClip - clip; this.stats.shots += this._lastClip - clip; }
      this._lastClip = clip;
    } else if (now >= this.nextShot) { this.burstLeft--; this.nextShot = now + 0.1; }
    if (this.burstLeft <= 0) {
      this.shooting = false;
      this.burstPauseUntil = now + (d < 1300 ? 0.22 : 0.34) + this.rnd() * 0.15 * (1 + (1 - this.p.burstDiscipline));
      this._lastClip = undefined;
    }
  }

  /** Active fire (molotov / incendiary) covering point p, or null. */
  fireAt(p, pad = 0) {
    const fires = World.weapons?.grenades?.fires;
    if (!fires?.length) return null;
    for (const f of fires) {
      const r = (f.radius || 150) + pad;
      if ((p.x - f.pos.x) ** 2 + (p.z - f.pos.z) ** 2 < r * r && Math.abs(p.y - f.pos.y) < 80) return f;
    }
    return null;
  }

  /** Is a teammate standing in our line of fire to a point `d` away? */
  friendInLine(p, d) {
    const e = this.eye, dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
    const L2 = dx * dx + dy * dy + dz * dz;
    for (const b of this.mgr.bots) {
      const f = b.ent;
      if (f === this.ent || !f.alive || f.team !== this.team) continue;
      const cx = f.origin.x - e.x, cy = f.origin.y + 40 - e.y, cz = f.origin.z - e.z;
      const t = (cx * dx + cy * dy + cz * dz) / L2;
      if (t <= 0 || t >= 1) continue;
      const qx = cx - dx * t, qz = cz - dz * t, qy = cy - dy * t;
      if (qx * qx + qz * qz < 22 * 22 && Math.abs(qy) < 44) return true;
    }
    const loc = World.local;
    if (loc && loc.alive && loc.team === this.team && !loc.spectator) {
      const cx = loc.origin.x - e.x, cz = loc.origin.z - e.z, cy = loc.origin.y + 40 - e.y;
      const t = (cx * dx + cy * dy + cz * dz) / L2;
      if (t > 0 && t < 1) { const qx = cx - dx * t, qz = cz - dz * t; if (qx * qx + qz * qz < 22 * 22) return true; }
    }
    return false;
  }

  tapAttack(now, cadence) {
    if (now < this.nextShot) return;
    if (this.prevButtons & IN_ATTACK) return;       // release a tick between semi shots
    this.cmd.buttons |= IN_ATTACK;
    this.nextShot = now + cadence * (0.9 + this.rnd() * 0.25);
    this.stats.shots++;
  }

  pressAttack2() {
    if (this.prevButtons & IN_ATTACK2) return;
    this.cmd.buttons |= IN_ATTACK2;
  }

  isScoped() {
    const e = this.ent, it = WI.activeItem(e);
    return !!(e.scoped || e.zoomed || (e.zoom && e.zoom > 0) || e.zoomLevel > 0 || (it && typeof it === 'object' && (it.zoomLevel > 0 || it.scoped)));
  }

  counterStrafe() {
    const v = this.ent.velocity;
    const sp = v ? Math.hypot(v.x, v.z) : 0;
    if (sp > 34) { this.moveDir.set(-v.x / sp, 0, -v.z / sp); this.moveSpeed = 1; this.moveWalk = false; }
    else this.moveSpeed = 0;
  }

  retreat(now) {
    // reload behind cover when we know some, else back off sideways
    const m = this.targetMem;
    if (!m) return;
    this.needCover = true;
    const o = this.ent.origin;
    if (this.coverOk && now - this.coverAt < 3) {
      const dx = this.coverPt.x - o.x, dz = this.coverPt.z - o.z, d = Math.hypot(dx, dz);
      if (d > 20) { this.moveDir.set(dx / d, 0, dz / d); this.moveSpeed = 1; this.moveWalk = false; }
      else this.moveSpeed = 0;
      this.moveOverride = true;
      return;
    }
    this.moveDir.set(o.x - m.pos.x, 0, o.z - m.pos.z).normalize();
    // bias sideways so we break line of sight rather than backpedal down a corridor
    const s = this.id % 2 ? 1 : -1;
    this.moveDir.x += -this.moveDir.z * 0.6 * s; this.moveDir.z += this.moveDir.x * 0.6 * s;
    this.moveDir.normalize();
    this.moveSpeed = 1; this.moveWalk = false; this.moveOverride = true;
  }

  // ---- grenades ---------------------------------------------------------------------------

  /** Line up and throw `key` so it lands near `target`. Returns true when committed. */
  tryNade(key, target, now, tol = 150, airburst = false, why = '') {
    if (this.nade || !WI.hasGrenade(this.ent, key) || !World.weapons?.switchTo) return false;
    // never burn / frag our own people
    if (key === 'molotov' || key === 'incgrenade' || key === 'hegrenade') {
      for (const b of this.mgr.bots) if (b !== this && b.ent.alive && b.team === this.team && b.ent.origin.distanceTo(target) < 260) return false;
    }
    const s = planThrow(this.ent, this.eye, target, tol, airburst);
    if (!s) { this.nextNade = now + 0.8; return false; }
    this.nade = { key, pitch: s.pitch, yaw: s.yaw, phase: 'switch', t0: now, pinAt: 0, relAt: 0, target: target.clone() };
    this.nextNade = now + 5 + this.rnd() * 4;
    this.stats.nades++;
    this.mgr.logEvent('nade', { bot: this.ent.name, team: this.team, key, why, area: World.nav?.areaOf?.(target) || '' });
    return true;
  }

  /** Per tick while a throw is in progress. Returns true while it owns aim + movement. */
  runNade(now) {
    const n = this.nade, ent = this.ent;
    // a close visible enemy beats finishing the line-up
    const m = this.targetMem;
    if ((n.phase === 'switch' || n.phase === 'aim') && this.target && m?.visible && now >= this.reactAt && m.pos.distanceTo(ent.origin) < 700) {
      this.nade = null; WI.switchTo(ent, WI.bestGunKey(ent)); return false;
    }
    if (now - n.t0 > 4) { this.nade = null; if (WI.activeKey(ent) === n.key) WI.switchTo(ent, WI.bestGunKey(ent)); return false; }
    const inst = WI.activeItem(ent);
    const key = WI.keyOf(inst);
    this.wantPitch = n.pitch; this.wantYaw = n.yaw;
    this.aimMode = 'nade';
    this.moveOverride = true; this.counterStrafe();
    const cmd = this.cmd;
    switch (n.phase) {
      case 'switch':
        if (key !== n.key) WI.switchTo(ent, n.key);
        else n.phase = 'aim';
        break;
      case 'aim': {
        const err = Math.hypot(angleNormalize(this.aim.yaw - n.yaw), this.aim.pitch - n.pitch);
        const v = ent.velocity, sp = v ? Math.hypot(v.x, v.z) : 0;
        if (err < 0.8 && sp < 15) { n.phase = 'pin'; n.pinAt = now; }
        break;
      }
      case 'pin':
        cmd.buttons |= IN_ATTACK;
        if (now - n.pinAt > 0.42 && (!inst || typeof inst !== 'object' || inst.state === 'pin' || now - n.pinAt > 1.2)) { n.phase = 'release'; n.relAt = now; }
        break;
      case 'release':
        // hold the line-up through the throw delay, then let the WeaponSystem switch back
        if (now - n.relAt > 0.6 || key !== n.key) { this.nade = null; return false; }
        break;
    }
    return true;
  }

  /** Decide whether a grenade would help right now (think rate). */
  considerUtility(now) {
    const ent = this.ent, g = ent.inventory?.grenades;
    if (!Array.isArray(g) || !g.length || this.task === 'plant' || this.task === 'defuse') return;
    const team = this.mgr.teamOf(this.team);
    // 1) molotov / HE onto a bomb being defused
    if (this.nadeRequest && now - this.nadeRequest.t < 4) {
      const r = this.nadeRequest; this.nadeRequest = null;
      for (const k of ['molotov', 'incgrenade', 'hegrenade']) if (this.tryNade(k, r.target, now, 110, false, 'defuser')) return;
    }
    // 2) T execute: smoke the choke on the site side, pop-flash over it
    const route = this.role?.route;
    if (this.team === 'T' && route?.entry && (this.task === 'execute' || this.task === 'stage') && team?.phase === 'execute') {
      const site = this.mgr.intel?.sites?.[route.site];
      const d = ent.origin.distanceTo(route.entry);
      if (site && d > 250 && d < 1100) {
        const tag = `${route.site}${route.idx}`;
        _t.copy(site.center).sub(route.entry).setY(0);
        const L = _t.length() || 1;
        if (!team.smoked.has(tag) && WI.hasGrenade(ent, 'smokegrenade')) {
          _v.copy(route.entry).addScaledVector(_t, Math.min(0.35, 260 / L));
          if (this.tryNade('smokegrenade', _v, now, 190, false, 'execute smoke')) { team.smoked.add(tag); return; }
        }
        if (!this.flashedEntry && d < 750 && WI.hasGrenade(ent, 'flashbang')) {
          _v.copy(route.entry).addScaledVector(_t, Math.min(0.5, 320 / L)); _v.y += 110;
          if (this.tryNade('flashbang', _v, now, 260, true, 'execute flash')) { this.flashedEntry = true; return; }
        }
      }
    }
    // 3) CT holding a choke that's heating up: fire / HE onto the entry to stall the hit
    if (this.team === 'CT' && this.task === 'hold' && this.arrived && !this.firedEntry) {
      const h = this.role?.hold, s = h && this.mgr.intel?.sites?.[h.site];
      const r = s?.tRoutes?.[h.route];
      if (r?.entry && (team?.heat?.[h.site] || 0) > 0.8) {
        const d = ent.origin.distanceTo(r.entry);
        if (d > 300 && d < 1300) for (const k of ['incgrenade', 'molotov', 'hegrenade']) {
          if (this.tryNade(k, r.entry, now, 160, false, 'hold the choke')) { this.firedEntry = true; return; }
        }
      }
    }
    // 4) enemy just ducked out of sight: nade the spot
    const m = this.targetMem;
    if (!this.target && m && now - this.lostAt > 0.4 && now - this.lostAt < 3 && now - m.lastSeen < 3.5) {
      const d = m.pos.distanceTo(ent.origin);
      if (d > 280 && d < 1300) {
        for (const k of ['molotov', 'incgrenade', 'hegrenade', 'flashbang']) {
          if (!WI.hasGrenade(ent, k)) continue;
          _v.copy(m.pos); if (k === 'flashbang') _v.y += 90;
          if (this.tryNade(k, _v, now, k === 'flashbang' ? 220 : 130, k === 'flashbang', 'lost target')) return;
        }
      }
    }
  }

  // ---- objectives ------------------------------------------------------------------------

  objectiveButtons(now) {
    const cmd = this.cmd, match = World.match;
    if (this.task === 'plant' && this.arrived && !this.target && WI.hasC4(this.ent)) {
      WI.switchTo(this.ent, 'c4');
      // rules.js plants for a carrier holding USE on a site (CS bots hold attack with C4 out)
      cmd.buttons |= IN_USE;
      match?.use?.(this.ent, true);
      if (this.plantStart < 0) this.plantStart = now;
      this.moveSpeed = 0; cmd.forwardmove = 0; cmd.sidemove = 0;
      this.wantPitch = 55;
      this.mgr.planting(this, now);
    } else if (this.task === 'defuse' && this.arrived && this.mgr.bomb.planted) {
      // stop defusing to fight unless it's now-or-never
      if (this.target && this.mgr.bomb.timeLeft(now) > (this.ent.defuser ? 6 : 11)) { this.defuseStart = -1; return; }
      cmd.buttons |= IN_USE;
      match?.use?.(this.ent, true);
      if (this.defuseStart < 0) this.defuseStart = now;
      cmd.forwardmove = 0; cmd.sidemove = 0;
      if (this.id % 2) cmd.buttons |= IN_DUCK;
      this.mgr.defusing(this, now);
    } else { this.plantStart = -1; this.defuseStart = -1; }
  }
}

// deferred call helper (next manager tick) without allocating closures every tick
function setTimeout0(fn, bot) { bot.mgr.defer(fn); }
