// C4 item logic: plant (3.2 s in a bombsite, holding attack with the C4 out or holding use),
// 40 s fuse, defuse 10 s / 5 s with a kit, detonation.
//
// The rules module (game/rules.js) also runs a full bomb lifecycle. When it does
// (World.match.bomb exists), this module steps aside and only handles the *item* side:
// the plant animation on the viewmodel and switching away from the C4 once it is gone.
// Standalone (no rules module, labs, tests) it runs the whole thing and emits the
// canonical events: bomb_planted / bomb_defused / bomb_exploded { site, ent, pos }.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { IN_ATTACK, IN_USE } from '../core/input.js';
import { WEAPONS } from './registry.js';
import { dealDamage } from './ballistics.js';
import { MASK_VISIBLE } from '../player/collision.js';

const _v = new THREE.Vector3(), _e = new THREE.Vector3();
const DEFUSE_RANGE = 72;

export const rulesManageBomb = () => !!(World.match && World.match.bomb && typeof World.match.siteAt === 'function');

export function siteAt(p) {
  const s = World.map?.bombsites;
  if (!s || !p) return null;
  for (const k of Object.keys(s)) {
    const z = s[k];
    if (!z?.min || !z?.max) continue;
    if (p.x >= z.min.x - 8 && p.x <= z.max.x + 8 && p.y >= z.min.y - 8 && p.y <= z.max.y + 8 && p.z >= z.min.z - 8 && p.z <= z.max.z + 8) return k;
  }
  return null;
}

export class C4Logic {
  constructor(sys) {
    this.sys = sys;
    this.reset();
  }

  reset() {
    this.state = 'none';        // none | planted | defused | exploded
    this.site = null; this.pos = new THREE.Vector3(); this.planter = null;
    this.blowAt = 0; this.nextBeep = 0;
    this.planting = null; this.plantT = 0;
    this.defuser = null; this.defuseEnd = 0; this.defuseStart = 0;
    if (this.mesh) { this.mesh.parent?.remove(this.mesh); this.mesh = null; }
  }

  get timeLeft() { return this.state === 'planted' ? Math.max(0, this.blowAt - this.sys.now) : 0; }

  /** Per tick, for every entity carrying the C4 (called by WeaponSystem). */
  tickCarrier(ent, inst, buttons, dt) {
    if (rulesManageBomb()) return;
    const holding = (buttons & IN_USE) || ((buttons & IN_ATTACK) && ent.active === inst);
    const site = siteAt(ent.origin);
    if (holding && site && ent.onGround !== false && this.state === 'none') {
      if (this.planting !== ent) {
        this.planting = ent; this.plantT = 0; this._frozeBefore = !!ent.frozen;
        if (ent.active !== inst) this.sys.switchTo(ent, 'c4');
        World.emit('bomb_beginplant', { ent, site }); World.emit('bomb_plant_start', { ent, site });
        if (ent === World.local) this.sys._vmPlay('plant');
      }
      this.plantT += dt;
      ent.frozen = true;
      if (this.plantT >= (WEAPONS.c4.plantTime ?? 3.2)) this._plant(ent, site);
    } else if (this.planting === ent) {
      this.planting = null; this.plantT = 0; ent.frozen = this._frozeBefore;
      World.emit('bomb_abortplant', { ent }); World.emit('bomb_plant_abort', { ent });
      if (ent === World.local) this.sys._vmPlay('draw');
    }
  }

  _plant(ent, site) {
    ent.frozen = this._frozeBefore;
    this.planting = null;
    this.state = 'planted'; this.site = site; this.planter = ent;
    this.pos.copy(ent.origin);
    const col = World.collision;
    if (col) {
      _v.set(this.pos.x, this.pos.y + 16, this.pos.z); _e.set(this.pos.x, this.pos.y - 64, this.pos.z);
      const tr = col.rayTrace(_v, _e, MASK_VISIBLE);
      if (tr.fraction < 1) this.pos.y = tr.endpos.y;
    }
    this.blowAt = this.sys.now + (World.cvar.mp_c4timer ?? WEAPONS.c4.timer ?? 40);
    this.nextBeep = this.sys.now;
    this.sys.remove(ent, 'c4');
    this._showMesh();
    World.emit('bomb_planted', { site, ent, pos: this.pos.clone() });
  }

  _showMesh() {
    if (!World.scene) return;
    if (!this.mesh) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(11, 3.2, 7), new THREE.MeshStandardMaterial({ color: 0x3b3f2e, roughness: 0.75 }));
      body.position.y = 1.6; body.castShadow = true; g.add(body);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 3), new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.5 }));
      pad.position.set(2, 3.4, 0); g.add(pad);
      this.led = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff1a0a, emissiveIntensity: 0 }));
      this.led.position.set(-3.5, 3.5, 1.5); g.add(this.led);
      this.mesh = g;
    }
    this.mesh.position.copy(this.pos);
    World.scene.add(this.mesh);
  }

  /** Per tick, once (planted bomb timer + defusing). */
  tick(dt) {
    if (rulesManageBomb() || this.state !== 'planted') return;
    const now = this.sys.now;
    const left = this.blowAt - now;
    if (now >= this.nextBeep) {
      const frac = Math.max(0, left / (WEAPONS.c4.timer || 40));
      this.nextBeep = now + (left < 1 ? 0.08 : 0.12 + 0.88 * frac * frac);
      this.ledT = now;
      World.emit('bomb_beep', { pos: this.pos.clone(), timeLeft: left }); World.emit('sound', { name: left < 1 ? 'bomb_final' : 'bomb_beep', pos: this.pos.clone() });
    }
    if (this.led) this.led.material.emissiveIntensity = now - (this.ledT ?? -9) < 0.08 ? 6 : 0;
    this._defuseTick(now);
    if (this.state === 'planted' && left <= 0) this._explode();
  }

  _defuseTick(now) {
    if (this.defuser) {
      const d = this.defuser;
      const btn = this.sys.buttonsOf(d);
      if (!d.alive || !(btn & IN_USE) || d.origin.distanceTo(this.pos) > DEFUSE_RANGE + 12) {
        d.frozen = false; this.defuser = null;
        World.emit('bomb_abortdefuse', { ent: d }); World.emit('bomb_defuse_abort', { ent: d });
        return;
      }
      d.frozen = true;
      if (now >= this.defuseEnd) {
        d.frozen = false; this.defuser = null;
        this.state = 'defused';
        World.emit('bomb_defused', { site: this.site, ent: d, pos: this.pos.clone() });
      }
      return;
    }
    for (const e of World.entities) {
      if (!e.alive || e.team !== 'CT' || !e.origin) continue;
      if (!(this.sys.buttonsOf(e) & IN_USE)) continue;
      if (e.origin.distanceTo(this.pos) > DEFUSE_RANGE) continue;
      this.defuser = e; this.defuseStart = now;
      this.defuseEnd = now + (e.defuser ? WEAPONS.c4.defuseTimeKit : WEAPONS.c4.defuseTime);
      World.emit('bomb_begindefuse', { ent: e, kit: !!e.defuser }); World.emit('bomb_defuse_start', { ent: e, kit: !!e.defuser, pos: this.pos.clone() });
      break;
    }
  }

  _explode() {
    this.state = 'exploded';
    if (this.defuser) { this.defuser.frozen = false; this.defuser = null; }
    const pos = this.pos;
    try { World.fx?.explosion?.(_v.copy(pos).setY(pos.y + 16).clone(), { scale: 3.5, bomb: true }); } catch (err) { console.error(err); }
    // CS: 500 damage, 1750u radius, gaussian falloff (sigma = r/3)
    const R = WEAPONS.c4.radius || 1750, sigma = R / 3, D = WEAPONS.c4.damage || 500;
    for (const e of World.entities) {
      if (!e.alive || !e.origin) continue;
      const d = e.origin.distanceTo(pos);
      if (d > R) continue;
      const amount = D * Math.exp(-(d * d) / (2 * sigma * sigma));
      if (amount < 1) continue;
      dealDamage(e, { amount, hitgroup: 0, attacker: this.planter, weapon: 'c4', point: e.origin.clone(),
        dir: new THREE.Vector3().subVectors(e.origin, pos).normalize(), armorPen: 0.5, headshotMul: 1, hitgroupApplied: true });
    }
    if (this.mesh) { this.mesh.parent?.remove(this.mesh); }
    World.emit('bomb_exploded', { site: this.site, ent: this.planter, pos: pos.clone() });
  }
}
