// Fallback bot entity, used only while src/player/player.js has no createPlayer().
// A compact Source PlayerMove (friction, accelerate, air-accelerate, step-up, duck, jump,
// slide) with the CONTRACT §11 fields, simple capsule hitboxes and a placeholder model.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { flatVectors } from '../core/mathx.js';
import { MASK_PLAYER } from '../player/collision.js';
import { IN_JUMP, IN_DUCK, IN_SPEED } from '../core/input.js';

const SV = { gravity: 800, friction: 5.2, stopspeed: 80, accelerate: 5.5, airaccelerate: 12, maxspeed: 250, jump: 301.993, step: 18 };
const MINS = new THREE.Vector3(-16, 0, -16);
const MAXS_STAND = new THREE.Vector3(16, 72, 16), MAXS_DUCK = new THREE.Vector3(16, 54, 16);
const f = new THREE.Vector3(), r = new THREE.Vector3(), wish = new THREE.Vector3();
const a = new THREE.Vector3(), b = new THREE.Vector3(), p0 = new THREE.Vector3(), v0 = new THREE.Vector3();
const pDown = new THREE.Vector3(), vDown = new THREE.Vector3();
let nextId = 1000;

export class BotPlayer {
  constructor(team, name) {
    this.id = nextId++;
    this.name = name; this.team = team; this.isBot = true; this.isLocal = false;
    this.alive = false; this.health = 100; this.armor = 0; this.helmet = false; this.money = 800; this.defuser = false;
    this.origin = new THREE.Vector3(); this.velocity = new THREE.Vector3();
    this.pitch = 0; this.yaw = 0; this.onGround = false; this.ducking = false; this.duckAmount = 0;
    this.eyeHeight = 64;
    this.viewPunch = { pitch: 0, yaw: 0 }; this.aimPunch = { pitch: 0, yaw: 0 };
    this.inventory = { primary: null, secondary: null, knife: 'knife', grenades: [], c4: null, taser: null };
    this.active = 'knife';
    this.lastCmd = null;
    this._jumpHeld = false;
    this.model = null;
    this._buildModel();
  }

  _buildModel() {
    if (!World.scene) return;
    const g = new THREE.Group();
    const col = this.team === 'T' ? 0xb08040 : 0x4060a0;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(13, 40, 4, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 }));
    body.position.y = 34;
    const head = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), new THREE.MeshStandardMaterial({ color: 0xd8b090, roughness: 0.7 }));
    head.position.y = 66;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(28, 4, 4), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    gun.position.set(16, 50, 6);
    g.add(body, head, gun);
    this.model = { root: g, head, body, update: () => {} };
    World.scene.add(g);
    g.visible = false;
  }

  eyePos(out = new THREE.Vector3()) { return out.set(this.origin.x, this.origin.y + this.eyeHeight, this.origin.z); }

  setPose(eye, pitch, yaw) { this.origin.set(eye.x, eye.y - this.eyeHeight, eye.z); this.pitch = pitch; this.yaw = yaw; this.velocity.set(0, 0, 0); }

  respawn(spawn) {
    this.origin.copy(spawn.pos); this.yaw = spawn.yaw ?? 0; this.pitch = 0; this.velocity.set(0, 0, 0);
    this.alive = true; this.health = 100; this.ducking = false; this.duckAmount = 0; this.eyeHeight = 64;
    if (this.model) this.model.root.visible = true;
    World.emit('spawn', { ent: this });
  }

  takeDamage(info) {
    if (!this.alive) return;
    let amt = info.amount;
    if (this.armor > 0 && info.hitgroup !== 6 && info.hitgroup !== 7 && (info.hitgroup !== 1 || this.helmet)) {
      const pen = info.armorPen ?? 0.5;
      const absorbed = amt * (1 - pen);
      this.armor = Math.max(0, this.armor - absorbed * 0.5);
      amt -= absorbed;
    }
    this.health -= amt;
    World.emit('damage', { victim: this, attacker: info.attacker, amount: amt, hitgroup: info.hitgroup, weapon: info.weapon, point: info.point });
    if (this.health <= 0) this.die(info);
  }

  die(info = {}) {
    if (!this.alive) return;
    this.alive = false; this.health = 0;
    if (this.model) this.model.root.visible = false;
    World.emit('death', { victim: this, attacker: info.attacker, weapon: info.weapon, headshot: info.hitgroup === 1 });
  }

  /** Cheap hitboxes: head sphere + two body boxes. */
  rayHit(start, dir, maxDist) {
    if (!this.alive) return null;
    const o = this.origin, eh = this.eyeHeight;
    let best = null;
    // head sphere
    const hx = o.x, hy = o.y + eh + 1, hz = o.z, R = 5.5;
    const ox = start.x - hx, oy = start.y - hy, oz = start.z - hz;
    const bq = ox * dir.x + oy * dir.y + oz * dir.z, c = ox * ox + oy * oy + oz * oz - R * R;
    const disc = bq * bq - c;
    if (disc >= 0) { const t = -bq - Math.sqrt(disc); if (t > 0 && t < maxDist) best = { t, hitgroup: 1 }; }
    // chest / legs boxes
    const top = o.y + eh - 7;
    const boxes = [[o.y + (eh - 64) + 34, top, 2], [o.y, o.y + (eh - 64) + 34, 6]];
    for (const [y0, y1, hg] of boxes) {
      const t = rayBox(start, dir, o.x - 11, y0, o.z - 11, o.x + 11, y1, o.z + 11);
      if (t !== null && t < maxDist && (!best || t < best.t)) best = { t, hitgroup: hg };
    }
    if (best) best.point = start.clone().addScaledVector(dir, best.t);
    return best;
  }

  runCommand(cmd, dt) {
    if (!this.alive) return;
    this.pitch = cmd.pitch; this.yaw = cmd.yaw;
    const cw = World.collision;
    if (!cw) return;
    // duck (instant-ish, with ground-unduck check)
    const wantDuck = !!(cmd.buttons & IN_DUCK);
    if (wantDuck && !this.ducking) {
      this.ducking = true;
      if (!this.onGround) this.origin.y += 18; // tuck legs in the air
    } else if (!wantDuck && this.ducking) {
      a.copy(this.origin);
      if (!this.onGround) a.y -= 18;
      const tr = cw.hullTrace(MINS, MAXS_STAND, a, a, MASK_PLAYER);
      if (!tr.startSolid) { this.ducking = false; this.origin.copy(a); }
    }
    this.duckAmount += ((this.ducking ? 1 : 0) - this.duckAmount) * Math.min(1, dt * 12);
    this.eyeHeight = 64 - 18 * this.duckAmount;
    const maxs = this.ducking ? MAXS_DUCK : MAXS_STAND;

    let maxspeed = SV.maxspeed * (this.maxSpeedScale ?? 1);
    if (this.ducking) maxspeed *= 0.34; else if (cmd.buttons & IN_SPEED) maxspeed *= 0.52;
    flatVectors(this.yaw, f, r);
    wish.copy(f).multiplyScalar(cmd.forwardmove).addScaledVector(r, cmd.sidemove);
    let wishspeed = wish.length();
    if (wishspeed > 0) wish.multiplyScalar(1 / wishspeed);
    wishspeed = Math.min(wishspeed, maxspeed);

    const jump = !!(cmd.buttons & IN_JUMP);
    if (this.onGround && jump && !this._jumpHeld) { this.velocity.y = SV.jump; this.onGround = false; }
    this._jumpHeld = jump;

    if (this.onGround) {
      // friction
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      if (sp > 0.1) {
        const drop = Math.max(sp, SV.stopspeed) * SV.friction * dt;
        const ns = Math.max(0, sp - drop) / sp;
        this.velocity.x *= ns; this.velocity.z *= ns;
      }
      accelerate(this.velocity, wish, wishspeed, SV.accelerate, dt);
      this.velocity.y = 0;
      this._walkMove(dt, maxs);
    } else {
      accelerate(this.velocity, wish, Math.min(wishspeed, 30), SV.airaccelerate, dt, wishspeed);
      this.velocity.y -= SV.gravity * dt * 0.5;
      slide(this.origin, this.velocity, dt, maxs);
      this.velocity.y -= SV.gravity * dt * 0.5;
    }
    // categorize
    a.copy(this.origin); b.copy(this.origin); b.y -= 2;
    const tr = cw.hullTrace(MINS, maxs, a, b, MASK_PLAYER);
    const wasAir = !this.onGround;
    this.onGround = tr.fraction < 1 && tr.normal.y >= 0.7 && this.velocity.y <= 140;
    if (this.onGround) { this.origin.copy(tr.endpos); if (wasAir && this.velocity.y < -580) this._fallDamage(); if (this.velocity.y < 0) this.velocity.y = 0; }
    // aim punch decay (the WeaponSystem writes it)
    const k = Math.exp(-dt * 8);
    this.aimPunch.pitch *= k; this.aimPunch.yaw *= k; this.viewPunch.pitch *= k; this.viewPunch.yaw *= k;
  }

  _fallDamage() {}

  _walkMove(dt, maxs) {
    // Source StepMove: plain slide vs. (up step, slide, down) — keep whichever went further
    p0.copy(this.origin); v0.copy(this.velocity);
    slide(this.origin, this.velocity, dt, maxs);
    pDown.copy(this.origin); vDown.copy(this.velocity);
    this.origin.copy(p0); this.velocity.copy(v0);
    const cw = World.collision;
    a.copy(this.origin); b.copy(this.origin); b.y += SV.step;
    let tr = cw.hullTrace(MINS, maxs, a, b, MASK_PLAYER);
    if (!tr.startSolid && !tr.allSolid) this.origin.copy(tr.endpos);
    slide(this.origin, this.velocity, dt, maxs);
    a.copy(this.origin); b.copy(this.origin); b.y -= SV.step + 1;
    tr = cw.hullTrace(MINS, maxs, a, b, MASK_PLAYER);
    if (!tr.startSolid && !tr.allSolid) this.origin.copy(tr.endpos);
    const upOk = tr.fraction < 1 && tr.normal.y >= 0.7;
    const dUp = (this.origin.x - p0.x) ** 2 + (this.origin.z - p0.z) ** 2;
    const dDn = (pDown.x - p0.x) ** 2 + (pDown.z - p0.z) ** 2;
    if (!upOk || dDn >= dUp) { this.origin.copy(pDown); this.velocity.copy(vDown); }
    else { this.velocity.y = vDown.y; }
    // stick to the ground going down slopes/stairs
    a.copy(this.origin); b.copy(this.origin); b.y -= SV.step;
    tr = cw.hullTrace(MINS, maxs, a, b, MASK_PLAYER);
    if (tr.fraction < 1 && tr.normal.y >= 0.7 && !tr.startSolid) this.origin.copy(tr.endpos);
  }

  _fallbackFrame(dt) {
    if (!this.model) return;
    const g = this.model.root;
    g.visible = this.alive;
    g.position.copy(this.origin);
    g.rotation.y = (this.yaw) * Math.PI / 180;
    this.model.head.position.y = this.eyeHeight + 2;
    this.model.body.scale.y = this.ducking ? 0.75 : 1;
  }
}

function accelerate(vel, dir, wishspeed, accel, dt, rawSpeed = wishspeed) {
  const cur = vel.x * dir.x + vel.z * dir.z;
  const add = wishspeed - cur;
  if (add <= 0) return;
  const acc = Math.min(add, accel * dt * rawSpeed);
  vel.x += acc * dir.x; vel.z += acc * dir.z;
}

const _pl = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _s = new THREE.Vector3(), _e = new THREE.Vector3();
const NUDGE = [[0, 0.125], [0, -0.125], [0.125, 0], [-0.125, 0], [0.09, 0.09], [-0.09, 0.09], [0.09, -0.09], [-0.09, -0.09]];
function slide(origin, vel, dt, maxs) {
  const cw = World.collision;
  let left = dt, np = 0;
  for (let bump = 0; bump < 4 && left > 0; bump++) {
    _s.copy(origin); _e.copy(origin).addScaledVector(vel, left);
    let tr = cw.hullTrace(MINS, maxs, _s, _e, MASK_PLAYER);
    if (tr.allSolid) {
      // flush against a face: nudge out along the axis that frees us and retry once
      let freed = false;
      for (const [nx, nz] of NUDGE) {
        _s.set(origin.x + nx, origin.y + 0.05, origin.z + nz);
        if (!cw.hullTrace(MINS, maxs, _s, _s, MASK_PLAYER).startSolid) { origin.copy(_s); freed = true; break; }
      }
      if (!freed) { vel.set(0, 0, 0); return; }
      _e.copy(origin).addScaledVector(vel, left);
      tr = cw.hullTrace(MINS, maxs, origin, _e, MASK_PLAYER);
      if (tr.allSolid) { vel.set(0, 0, 0); return; }
    }
    if (tr.fraction > 0) origin.copy(tr.endpos);
    if (tr.fraction >= 1) return;
    left -= left * tr.fraction;
    if (np < 5) _pl[np++].copy(tr.normal);
    // clip against every plane touched so far
    const n = tr.normal;
    const back = vel.dot(n);
    vel.addScaledVector(n, -back * 1.0);
    for (let i = 0; i < np - 1; i++) if (vel.dot(_pl[i]) < 0) {
      // crease: slide along the intersection line
      const dir = _s.crossVectors(_pl[i], n).normalize();
      const d = dir.dot(vel);
      vel.copy(dir).multiplyScalar(d);
      break;
    }
  }
}

function rayBox(o, d, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity;
  for (const [oo, dd, lo, hi] of [[o.x, d.x, x0, x1], [o.y, d.y, y0, y1], [o.z, d.z, z0, z1]]) {
    if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return null; continue; }
    let t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmax < 0 ? null : Math.max(0, tmin);
}

export function createBotPlayer({ team, name }) {
  const p = new BotPlayer(team, name);
  World.entities.push(p);
  return p;
}
