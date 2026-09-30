// Grenade projectiles (CS:GO CBaseCSGrenadeProjectile): throw, bounce, detonate.
//
// Physics follows Source's MOVETYPE_FLYGRAVITY toss with CS:GO's ResolveFlyCollisionCustom:
// gravity 0.4 * sv_gravity, ±2u hull, reflect (backoff 2) then scale by elasticity 0.45
// (0.3 off players), stop when slower than 30 u/s on a floor (normal.y > 0.7).
// Fuses: HE / flash 1.5 s, smoke + decoy pop once at rest (after 1.5 s), molotov /
// incendiary burst on floor contact or after 2 s in the air.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { WEAPONS, GRENADE } from './registry.js';
import { MASK_SHOT, MASK_VISIBLE } from '../player/collision.js';
import { dealDamage } from './ballistics.js';

defCvar('sv_grenade_trajectory', 0, 0, 1, 'debug: log grenade detonation points');
defCvar('inferno_damage', 40, 0, 200, 'molotov / incendiary damage per second');
defCvar('inferno_radius', 150, 20, 400, 'burning area radius');

const MINS = new THREE.Vector3(-GRENADE.hull, -GRENADE.hull, -GRENADE.hull);
const MAXS = new THREE.Vector3(GRENADE.hull, GRENADE.hull, GRENADE.hull);
const _end = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _n = new THREE.Vector3();

// ---- meshes (shared geometry + material per type) ------------------------------------------
let meshKit = null;
function kit() {
  if (meshKit) return meshKit;
  const std = (color, rough = 0.55, metal = 0.35) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const can = new THREE.CylinderGeometry(1.25, 1.25, 4.2, 12); can.rotateX(Math.PI / 2);
  const cap = new THREE.CylinderGeometry(0.7, 0.8, 1.2, 10); cap.rotateX(Math.PI / 2); cap.translate(0, 0, -2.6);
  const ball = new THREE.SphereGeometry(1.55, 14, 10); ball.scale(1, 1, 1.15);
  const bottle = new THREE.CylinderGeometry(1.35, 1.45, 4.6, 12); bottle.rotateX(Math.PI / 2);
  const neck = new THREE.CylinderGeometry(0.45, 0.8, 2.2, 10); neck.rotateX(Math.PI / 2); neck.translate(0, 0, -3.3);
  const rag = new THREE.BoxGeometry(0.9, 0.9, 1.2); rag.translate(0, 0, -4.6);
  const M = {
    hegrenade: std(0x3d4a2c, 0.62, 0.2), flashbang: std(0x9a9ea2, 0.35, 0.8), smokegrenade: std(0x5c646b, 0.5, 0.5),
    decoy: std(0x4c5a3a, 0.6, 0.25), incgrenade: std(0x7d7f79, 0.45, 0.6), molotov: new THREE.MeshStandardMaterial({ color: 0x6b3d12, roughness: 0.12, metalness: 0.0 }),
    fuze: std(0x8b8b86, 0.4, 0.9), rag: std(0xd8cdb8, 0.9, 0), c4: std(0x3a3f2c, 0.7, 0.1),
  };
  meshKit = { can, cap, ball, bottle, neck, rag, M };
  return meshKit;
}

export function buildGrenadeMesh(key) {
  const k = kit();
  const g = new THREE.Group();
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; g.add(m); return m; };
  if (key === 'hegrenade') { add(k.ball, k.M.hegrenade); add(k.cap, k.M.fuze); }
  else if (key === 'molotov') { add(k.bottle, k.M.molotov); add(k.neck, k.M.molotov); add(k.rag, k.M.rag); }
  else { add(k.can, k.M[key] || k.M.smokegrenade); add(k.cap, k.M.fuze); }
  g.name = `nade_${key}`;
  return g;
}

// ---- system ----------------------------------------------------------------------------------
export class GrenadeSystem {
  constructor() {
    this.list = [];        // live projectiles
    this.fires = [];       // burning molotovs
    this.smokes = [];      // active smoke volumes
    this.decoys = [];      // active decoys
    this.time = 0;
    this.serial = 0;
  }

  /** Spawn a thrown grenade. strength: 1 overhand, 0.5 both buttons, 0 underhand. */
  throw(ent, key, strength = 1) {
    const def = WEAPONS[key];
    if (!def) return null;
    const col = World.collision;
    // CS:GO ThrowGrenade: raise the throw 10 degrees, scale by strength, add 1.25x player velocity
    let pitch = ent.pitch || 0;
    pitch = -10 + pitch * ((90 - 10) / 90);
    const y = (ent.yaw || 0) * Math.PI / 180, p = pitch * Math.PI / 180;
    const fwd = _a.set(Math.cos(y) * Math.cos(p), -Math.sin(p), -Math.sin(y) * Math.cos(p));
    const speed = GRENADE.throwSpeed * (GRENADE.underhandFrac + (1 - GRENADE.underhandFrac) * strength);
    const src = new THREE.Vector3();
    if (ent.eyePos) ent.eyePos(src); else src.set(ent.origin.x, ent.origin.y + 64, ent.origin.z);
    src.y += strength * 12 - 12;
    if (col) {
      _end.copy(src).addScaledVector(fwd, 22);
      const tr = col.hullTrace(MINS, MAXS, src, _end, MASK_SHOT);
      src.copy(tr.endpos);
    }
    const vel = new THREE.Vector3().copy(fwd).multiplyScalar(speed);
    if (ent.velocity) vel.addScaledVector(ent.velocity, GRENADE.playerVelScale);
    const g = {
      key, def, owner: ent, pos: src, prev: src.clone(), vel, age: 0, stopped: false, done: false,
      restCheck: 0, bounces: 0, lastBounceT: -1, mesh: null,
      spin: new THREE.Vector3(600, (Math.random() * 2 - 1) * 1200, 0).multiplyScalar(Math.PI / 180),
      rot: new THREE.Euler(Math.random() * 6, (ent.yaw || 0) * Math.PI / 180, 0),
    };
    if (World.scene) {
      g.mesh = buildGrenadeMesh(key);
      g.mesh.position.copy(src);
      World.scene.add(g.mesh);
    }
    this.list.push(g);
    World.emit('grenade_throw', { ent, weapon: key, pos: src.clone(), vel: vel.clone(), strength });
    return g;
  }

  tick(dt) {
    this.time += dt;
    const col = World.collision;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.prev.copy(g.pos);
      g.age += dt;
      if (!g.stopped && col) this._move(g, dt, col);
      this._fuse(g, dt);
      if (g.done) { this._remove(g); this.list.splice(i, 1); }
    }
    this._tickFires(dt);
    this._tickDecoys(dt);
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const sm = this.smokes[i];
      if (this.time - sm.t0 > sm.duration) { World.emit('smoke_expire', { pos: sm.pos.clone(), id: sm.id }); this.smokes.splice(i, 1); }
    }
  }

  _move(g, dt, col) {
    const grav = (World.cvar.sv_gravity ?? 800) * GRENADE.gravityScale;
    g.vel.y -= grav * dt * 0.5;
    let left = dt;
    for (let it = 0; it < 3 && left > 1e-6; it++) {
      _end.copy(g.pos).addScaledVector(g.vel, left);
      const tr = col.hullTrace(MINS, MAXS, g.pos, _end, MASK_SHOT);
      if (tr.startSolid && tr.allSolid) { g.vel.set(0, 0, 0); g.stopped = true; break; }
      // players deflect grenades too (CS: elasticity 0.3 off a body)
      const hitEnt = this._entityHit(g, g.pos, tr.endpos);
      if (hitEnt) {
        g.pos.copy(_b);
        this._bounce(g, _n, 0.3, 'flesh');
        left *= 0.5;
        continue;
      }
      g.pos.copy(tr.endpos);
      if (tr.fraction >= 1) break;
      left *= 1 - tr.fraction;
      _n.copy(tr.normal);
      if ((g.key === 'molotov' || g.key === 'incgrenade') && _n.y > 0.7) { this._detonate(g, _n); return; }
      this._bounce(g, _n, 1, tr.surface);
      if (g.stopped) break;
    }
    if (!g.stopped) g.vel.y -= grav * dt * 0.5;
  }

  _bounce(g, n, surfaceElasticity, surface) {
    const e = Math.min(0.9, GRENADE.elasticity * surfaceElasticity);
    const vn = g.vel.dot(n);
    const speedIn = g.vel.length();
    g.vel.addScaledVector(n, -2 * vn).multiplyScalar(e);
    const sp2 = g.vel.lengthSq();
    if (sp2 < GRENADE.stopSpeed * GRENADE.stopSpeed) {
      g.vel.set(0, 0, 0);
      if (n.y > 0.7) g.stopped = true;
    }
    g.bounces++;
    g.spin.multiplyScalar(0.6);
    if (speedIn > 60 && this.time - g.lastBounceT > 0.08) {
      g.lastBounceT = this.time;
      World.emit('grenade_bounce', { weapon: g.key, pos: g.pos.clone(), surface: surface || 'default', speed: speedIn, ent: g.owner });
    }
  }

  // swept point vs player capsule (radius 16 + hull) — sets _b (contact point) and _n
  _entityHit(g, a, b) {
    const ents = World.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive || !e.origin || (e === g.owner && g.age < 0.25)) continue;
      const o = e.origin;
      const top = o.y + (e.hullHeight ?? 72);
      if (Math.max(a.y, b.y) < o.y || Math.min(a.y, b.y) > top) continue;
      const r = 16 + GRENADE.hull;
      const dx = b.x - a.x, dz = b.z - a.z;
      const fx = a.x - o.x, fz = a.z - o.z;
      const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - r * r;
      if (C < 0) continue; // already inside (spawned in a body): ignore
      if (A < 1e-9) continue;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t < 0 || t > 1) continue;
      _b.lerpVectors(a, b, t);
      _n.set(_b.x - o.x, 0, _b.z - o.z).normalize();
      return e;
    }
    return null;
  }

  _fuse(g, dt) {
    const d = g.def;
    if (g.done) return;
    if (d.detonate === 'timer') { if (g.age >= d.fuse) this._detonate(g, null); return; }
    if (d.detonate === 'rest') {
      g.restCheck -= dt;
      if (g.age >= d.fuse && g.restCheck <= 0) {
        g.restCheck = 0.2;
        if (g.stopped || g.vel.lengthSq() < 0.01) this._detonate(g, null);
      }
      return;
    }
    if (d.detonate === 'impact' && g.age >= d.fuse) this._detonate(g, null, true);
  }

  _detonate(g, normal, air = false) {
    if (g.done) return;
    g.done = true;
    const pos = g.pos, key = g.key, fx = World.fx;
    if (World.cvar.sv_grenade_trajectory) console.log(`[grenade] ${key} detonated at`, pos.toArray().map((v) => v.toFixed(1)).join(' '), `after ${g.age.toFixed(2)}s`);
    const ev = { weapon: key, pos: pos.clone(), ent: g.owner, air, id: `${key}_${++this.serial}`, duration: g.def.duration };
    World.emit('grenade_detonate', ev);
    if (key !== 'molotov' && key !== 'incgrenade' && key !== 'decoy') World.emit(`${key}_detonate`, ev);
    try {
      switch (key) {
        case 'hegrenade':
          fx?.explosion?.(pos.clone());
          this._heDamage(g);
          break;
        case 'flashbang':
          fx?.flash?.(pos.clone(), g.owner);
          break;
        case 'smokegrenade': {
          const handle = fx?.smoke?.(pos.clone()) ?? null;
          this.smokes.push({ pos: pos.clone(), t0: this.time, duration: g.def.duration ?? 18, handle, owner: g.owner, id: ev.id });
          this._extinguishNear(pos, (g.def.radius ?? 144) + 60);
          break;
        }
        case 'molotov': case 'incgrenade':
          this._ignite(g, normal, air, ev.id);
          break;
        case 'decoy':
          this.decoys.push({ pos: pos.clone(), owner: g.owner, t0: this.time, next: this.time + 0.8, burst: 0,
            weapon: bestGunKey(g.owner), mesh: g.mesh });
          World.emit('decoy_start', { pos: pos.clone(), ent: g.owner, weapon: bestGunKey(g.owner), duration: g.def.duration ?? 15, id: ev.id });
          g.mesh = null; // the decoy keeps its mesh until it pops
          break;
      }
    } catch (err) { console.error('[weapons] grenade detonate threw', err); }
  }

  _heDamage(g) {
    const d = g.def, R = d.radius ?? 350, dmgMax = d.damage ?? 98;
    const col = World.collision;
    for (const e of World.entities) {
      if (!e.alive || !e.origin) continue;
      // CS RadiusDamage: linear falloff to the body centre, blocked by world geometry
      _a.set(e.origin.x, e.origin.y + 36, e.origin.z);
      const dist = _a.distanceTo(g.pos);
      if (dist > R) continue;
      let visible = true;
      if (col) {
        const t1 = col.rayTrace(g.pos, _a, MASK_VISIBLE);
        visible = t1.fraction >= 1;
        if (!visible) {
          _a.set(e.origin.x, e.origin.y + (e.eyeHeight ?? 64), e.origin.z);
          visible = col.rayTrace(g.pos, _a, MASK_VISIBLE).fraction >= 1;
        }
      }
      if (!visible) continue;
      const amount = dmgMax * (1 - dist / R);
      if (amount < 1) continue;
      const dir = new THREE.Vector3().subVectors(e.origin, g.pos).setY(0.3).normalize();
      dealDamage(e, { amount, hitgroup: 0, attacker: g.owner, weapon: 'hegrenade', point: _a.clone(), dir,
        armorPen: d.armorPen ?? 0.58, headshotMul: 1, hitgroupApplied: true, penetrated: 0 });
    }
  }

  _ignite(g, normal, air, id) {
    const col = World.collision;
    const pos = g.pos.clone();
    const n = normal ? normal.clone() : new THREE.Vector3(0, 1, 0);
    if (air || !normal) {
      // airburst: fire drops onto whatever is below within 128u, else nothing burns
      if (!col) return;
      _end.copy(pos); _end.y -= 128;
      const tr = col.rayTrace(pos, _end, MASK_VISIBLE);
      if (tr.fraction >= 1 || tr.normal.y < 0.7) { World.fx?.explosion?.(pos, { scale: 0.3, fire: true }); return; }
      pos.copy(tr.endpos); n.copy(tr.normal);
    }
    // a molotov landing in smoke fizzles (CS)
    for (const s of this.smokes) {
      if (s.pos.distanceTo(pos) < 144 + 40) { World.emit('grenade_fizzle', { weapon: g.key, pos }); World.emit('sound', { name: 'fire_out', pos }); return; }
    }
    const handle = World.fx?.fire?.(pos.clone(), n.clone()) ?? null;
    const R = World.cvar.inferno_radius ?? g.def.radius ?? 150;
    this.fires.push({ pos, normal: n, t0: this.time, duration: g.def.duration ?? 7, radius: R, handle, owner: g.owner,
      key: g.key, nextHurt: this.time, id });
    World.emit(`${g.key}_detonate`, { weapon: g.key, pos: pos.clone(), normal: n.clone(), ent: g.owner, id, duration: g.def.duration ?? 7 });
  }

  _extinguishNear(pos, r) {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (f.pos.distanceTo(pos) > r + f.radius * 0.5) continue;
      try { f.handle?.extinguish?.(); f.handle?.stop?.(); } catch (err) { console.error(err); }
      World.emit('inferno_expire', { pos: f.pos.clone(), weapon: f.key, id: f.id, extinguished: true });
      this.fires.splice(i, 1);
    }
  }

  _tickFires(dt) {
    if (!this.fires.length) return;
    const col = World.collision;
    const dps = World.cvar.inferno_damage ?? 40;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (this.time - f.t0 > f.duration) {
        try { f.handle?.stop?.(); } catch (err) { console.error(err); }
        World.emit('inferno_expire', { pos: f.pos.clone(), weapon: f.key, id: f.id });
        this.fires.splice(i, 1); continue;
      }
      if (this.time < f.nextHurt) continue;
      f.nextHurt = this.time + 0.25;
      for (const e of World.entities) {
        if (!e.alive || !e.origin) continue;
        const dx = e.origin.x - f.pos.x, dz = e.origin.z - f.pos.z;
        if (dx * dx + dz * dz > f.radius * f.radius) continue;
        const dy = e.origin.y - f.pos.y;
        if (dy < -40 || dy > 48) continue;
        if (col) {
          _a.set(f.pos.x, f.pos.y + 12, f.pos.z); _b.set(e.origin.x, e.origin.y + 12, e.origin.z);
          if (col.rayTrace(_a, _b, MASK_VISIBLE).fraction < 1) continue;
        }
        dealDamage(e, { amount: dps * 0.25, hitgroup: 0, attacker: f.owner, weapon: f.key, point: e.origin.clone(),
          dir: new THREE.Vector3(0, 1, 0), armorPen: 1, headshotMul: 1, hitgroupApplied: true, type: 'burn' });
      }
    }
  }

  _tickDecoys(dt) {
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      const age = this.time - d.t0;
      if (age > (WEAPONS.decoy.duration ?? 15)) {
        World.fx?.explosion?.(d.pos.clone(), { scale: 0.25 });
        World.emit('grenade_detonate', { weapon: 'decoy', pos: d.pos.clone(), ent: d.owner, final: true });
        World.emit('sound', { name: 'decoy_pop', pos: d.pos.clone() });
        if (d.mesh) { d.mesh.parent?.remove(d.mesh); }
        this.decoys.splice(i, 1);
        continue;
      }
      if (this.time >= d.next) {
        // fake gunfire: bursts of 1-4 shots at the owner's gun rate, random gaps
        const def = WEAPONS[d.weapon] || WEAPONS.glock;
        World.emit('decoy_fire', { pos: d.pos.clone(), weapon: d.weapon, ent: d.owner });
        if (d.burst > 0) { d.burst--; d.next = this.time + Math.max(0.1, def.cycleTime || 0.15); }
        else { d.burst = (Math.random() * 4) | 0; d.next = this.time + 0.6 + Math.random() * 1.6; }
      }
    }
  }

  frame(dt, alpha = 1) {
    for (const g of this.list) {
      if (!g.mesh) continue;
      g.mesh.position.lerpVectors(g.prev, g.pos, alpha);
      if (!g.stopped) {
        g.rot.x += g.spin.x * dt; g.rot.y += g.spin.y * dt * 0.2;
      } else {
        // settle on its side
        g.rot.x += (Math.PI / 2 - (g.rot.x % Math.PI)) * Math.min(1, dt * 10);
      }
      g.mesh.rotation.copy(g.rot);
    }
  }

  _remove(g) {
    if (g.mesh) { g.mesh.parent?.remove(g.mesh); g.mesh = null; }
  }

  /** Round reset: drop every projectile, fire and smoke record. */
  clear() {
    for (const g of this.list) this._remove(g);
    for (const d of this.decoys) d.mesh?.parent?.remove(d.mesh);
    for (const f of this.fires) { try { f.handle?.stop?.(); } catch (err) { console.error(err); } }
    this.list.length = 0; this.fires.length = 0; this.smokes.length = 0; this.decoys.length = 0;
  }

  /** Is `p` inside an active smoke volume? (bots / audio helpers) */
  inSmoke(p) {
    for (const s of this.smokes) if (s.pos.distanceTo(p) < 144) return true;
    return false;
  }
}

function bestGunKey(ent) {
  const inv = ent?.inventory;
  const k = (v) => (v == null ? null : typeof v === 'string' ? v : v.key);
  return k(inv?.primary) || k(inv?.secondary) || 'glock';
}
