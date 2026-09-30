// FX — CONTRACT.md §14. Procedural, GPU-driven effects for DUST II.
//
//   particles.js  one instanced ring-buffer pool (world) + a small one for the viewmodel scene
//   decals.js     brush-clipped decals, one mesh
//   smoke.js      voxel flood-fill smoke grenades, sorted lit volume + inside fog
//   tracers.js    GPU tracers, shells.js brass, lights.js point-light pool
//   impacts.js / muzzle.js / explosion.js / fire.js / flash.js  effect recipes
//   atlas.js      all textures, generated on the GPU at init
//
// Draw calls: particles 1, view particles 1, smoke 1 (+1 fog when inside), decals 1,
// tracers 1, shells 1, flash overlay (only while flashed). No per-shot allocation.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { rng } from '../core/mathx.js';
import { buildAtlases } from './atlas.js';
import { shared, scanLights } from './lighting.js';
import { ParticlePool, PF } from './particles.js';
import { DepthCapture } from './depth.js';
import { Decals, DECAL_TYPES } from './decals.js';
import { Tracers } from './tracers.js';
import { Shells } from './shells.js';
import { LightPool } from './lights.js';
import { SmokeSystem } from './smoke.js';
import { FireSystem } from './fire.js';
import { Flash } from './flash.js';
import { impactFx, bloodFx, feetDust } from './impacts.js';
import { muzzleFx } from './muzzle.js';
import { explosionFx } from './explosion.js';
import { viewmodelToWorldMatched } from './util.js';

defCvar('fx_particles', 1, 0.25, 2, 'particle count multiplier');
defCvar('fx_muzzle_light', 1, 0, 1, 'dynamic light from muzzle flashes');
defCvar('fx_muzzle_bright', 1, 0.2, 3, 'muzzle flash HDR brightness');
defCvar('fx_muzzle_view_scale', 1, 0.3, 2, 'viewmodel muzzle flash size');
defCvar('fx_tracer_speed', 9000, 2000, 20000, 'tracer visual speed (u/s)');
defCvar('fx_tracer_width', 0.9, 0.2, 4, 'tracer width (u)');
defCvar('fx_tracer_bright', 7, 0, 30, 'tracer HDR brightness');
defCvar('fx_emissive', 1, 0.1, 4, 'fire / flash emissive multiplier');
defCvar('fx_softparticles', 1, 0, 1, 'depth-softened particles');
defCvar('fx_shake', 1, 0, 3, 'explosion view punch scale');
defCvar('fx_flash_whiteout', 0, 0, 1, 'FX draws the flash white-out itself (HUD normally does)');
defCvar('fx_decals', 1, 0, 1, 'impact decals');

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class FX {
  constructor() {
    this.now = 0;
    this.seed = 1337;
    this.rand = rng(this.seed);
    this.scale = 1;
    this.shake = 0;
    this.flashAfterimage = null;
    this.drawsFlashAfterimage = true;

    const r = World.renderer?.renderer || World.renderer?.gl || null;
    this.textures = buildAtlases(r, { size: World.quality === 'low' ? 1024 : 2048, decalSize: World.quality === 'low' ? 512 : 1024 });
    const scene = World.scene, vscene = World.viewScene;

    this.depth = new DepthCapture();
    scene?.add(this.depth.hook);
    this.pool = new ParticlePool(this.textures.particles, { capacity: 6144, renderOrder: 10, name: 'fx-particles' });
    scene?.add(this.pool.mesh);
    this.vpool = vscene ? new ParticlePool(this.textures.particles, { capacity: 384, renderOrder: 900, name: 'fx-view-particles' }) : null;
    if (this.vpool) vscene.add(this.vpool.mesh);
    this.decals = new Decals(scene, this.textures);
    this.tracers = new Tracers(scene);
    this.shells = new Shells(scene);
    this.lights = new LightPool(scene, 3);
    this.smokes = new SmokeSystem(scene, this.textures.particles);
    this.smokes.onVolumeFilled = (v) => this._smokeVsFires(v);
    this.fires = new FireSystem(this);
    this.flashes = new Flash(this);

    // viewmodel muzzle light (lights the gun and hands)
    this.viewLight = null;
    if (vscene) {
      this.viewLight = new THREE.PointLight(0xffb060, 0, 80, 2);
      this.viewLight.userData.fx = true;
      vscene.add(this.viewLight);
      this.viewLightT = -1;
      this.viewLightPeak = 0;
    }

    this._unsub = [
      World.on('impact', (e) => this._onImpact(e)),
      World.on('damage', (e) => this._onDamage(e)),
      World.on('footstep', (e) => this._onFootstep(e)),
      World.on('land', (e) => this._onLand(e)),
      World.on('round_start', () => this.reset(false)),
      World.on('bomb_exploded', (e) => { const p = e?.pos || e?.position; if (p) this.explosion(p, { scale: 2.2 }); }),
    ];
    scanLights(true);
  }

  cvar(name, def) { const v = World.cvar[name]; return v === undefined ? def : v; }

  // ---- contract API -------------------------------------------------------------------

  update(dt) {
    if (World.paused) dt = 0;
    this.now += dt;
    shared.uTime.value = this.now;
    shared.uEmissive.value = this.cvar('fx_emissive', 1);
    this.depth.enabled = this.cvar('fx_softparticles', 1) > 0;
    this.scale = this.cvar('fx_particles', 1) * (World.quality === 'low' ? 0.5 : World.quality === 'medium' ? 0.75 : 1);
    this.shake = Math.max(0, this.shake - dt * 2);
    scanLights();
    this.lights.update(this.now);
    if (this.viewLight) {
      const t = this.now - this.viewLightT;
      this.viewLight.intensity = t >= 0 && t < 0.06 ? this.viewLightPeak * (1 - t / 0.06) : 0;
    }
    this.smokes.update(dt, this.now, World.camera);
    this.fires.update(dt, this.now);
    this.shells.update(dt, this.now);
    this.flashes.update(dt);
    this.pool.flush();
    this.vpool?.flush();
    this.decals.flush();
    this.tracers.flush();
    this.smokes.flush();
  }

  muzzleFlash(worldPos, dir, key, opts = {}) {
    if (!worldPos || !dir) return;
    muzzleFx(this, worldPos, dir, key, opts);
  }

  tracer(from, to, key, opts) {
    if (!from || !to) return;
    // the local player's muzzle sits in viewmodel space: start where it appears on screen
    let a = from;
    const cam = World.camera;
    if (cam && (opts?.viewmodel || (cam.position.distanceToSquared(from) < 70 * 70))) a = viewmodelToWorldMatched(from, _v);
    this.tracers.spawn(this.now, a, to, {
      speed: this.cvar('fx_tracer_speed', 9000),
      width: this.cvar('fx_tracer_width', 0.9) * (/awp|ssg08|g3sg1|scar20|deagle/.test(key || '') ? 1.3 : 1),
      bright: this.cvar('fx_tracer_bright', 7),
      length: 180 + this.rand() * 140,
    });
  }

  impact(point, normal, surface = 'default', opts) {
    if (!point) return;
    if (surface === 'flesh' || opts?.entity) {
      _n.copy(normal || _up).negate();
      this.blood(point, _n, 1);
      return;
    }
    impactFx(this, point, normal || _up, surface);
  }

  blood(point, dir, amount = 1) {
    if (!point) return;
    bloodFx(this, point, dir || _up, amount);
  }

  shell(pos, vel, key, opts) {
    if (!pos) return;
    const cam = World.camera;
    const vm = opts?.viewmodel ?? (cam && cam.position.distanceToSquared(pos) < 48 * 48);
    const p = vm ? viewmodelToWorldMatched(pos, _v) : _v.copy(pos);
    this.shells.spawn(this.now, p, vel || _w.set(0, 120, 0), key, this.rand);
  }

  decal(point, normal, type = 'bullet_concrete', size = 0) {
    if (!point) return false;
    return this.decals.add(point, normal || _up, DECAL_TYPES[type] ? type : 'bullet_concrete', size, this.rand() * Math.PI * 2, 'concrete', 1, (this.rand() * 3) | 0);
  }

  smoke(pos) {
    const v = this.smokes.spawn(pos, this.now, this.rand);
    // a molotov already burning where the smoke lands goes out as the smoke reaches it
    return v;
  }

  flash(pos) { if (pos) this.flashes.detonate(pos); }

  explosion(pos, opts) { if (pos) explosionFx(this, pos, opts); }

  fire(pos, normal) {
    const f = this.fires.spawn(pos, this.now, this.rand);
    // landing in an existing smoke: fizzles out immediately
    if (this.smokes.densityAt(_v.copy(pos).setY(pos.y + 16)) > 0.25) f.extinguish(this.now);
    return f;
  }

  blindAmount(ent) { return this.flashes.blindAmount(ent); }

  /** 0 = clear line of sight, 1 = fully blocked by smoke. */
  smokeOcclusion(from, to) {
    const tau = this.smokes.opticalDepth(from, to, this.now);
    return tau <= 0 ? 0 : 1 - Math.exp(-tau);
  }

  // ---- extras -------------------------------------------------------------------------

  /** Is a point inside burning molotov fire (for damage)? */
  fireAt(p) { for (const f of this.fires.fires) if (f.contains(p, this.now)) return f; return null; }

  flashViewLight(pos, dir, k) {
    if (!this.viewLight) return;
    this.viewLight.position.copy(pos).addScaledVector(dir, 3);
    this.viewLightT = this.now;
    this.viewLightPeak = 900 * k;
  }

  reset(decalsToo = true) {
    this.pool.clear(); this.vpool?.clear();
    this.tracers.clear(); this.shells.clear();
    this.smokes.clear(); this.fires.clear(); this.lights.clear();
    this.flashes.clear();
    if (decalsToo) this.decals.clear();
  }

  /** Deterministic RNG restart (lab / replays). */
  reseed(seed = 1337) { this.seed = seed; this.rand = rng(seed); }

  _smokeVsFires(vol) {
    for (const f of this.fires.fires) {
      if (!f.alive) continue;
      for (let i = 0; i < f.n; i++) {
        _v.set(f.cells[i * 4], f.cells[i * 4 + 1] + 20, f.cells[i * 4 + 2]);
        if (vol.filledAt(_v)) { f.extinguish(this.now); break; }
      }
    }
  }

  _onImpact(e) {
    if (!e?.point) return;
    this.impact(e.point, e.normal, e.surface, e.entity ? e : null);
  }
  _onDamage(e) {
    // extra spray on headshots (the bullet impact itself already bled)
    if (e?.hitgroup === 1 && e.point) this.blood(e.point, e.normal ? _n.copy(e.normal).negate() : _up, 1.6);
  }
  _onFootstep(e) {
    const ent = e?.ent;
    if (!ent || ent === World.local || !ent.origin) return;
    if ((e.volume ?? 1) < 0.3) return;
    feetDust(this, ent.origin, e.surface, 0.2);
  }
  _onLand(e) {
    const ent = e?.ent;
    const pos = e?.pos || ent?.origin;
    if (!pos || ent === World.local) return;
    const speed = Math.abs(e.speed ?? e.velocity ?? 300);
    feetDust(this, pos, e.surface || 'sand', Math.min(1, speed / 500));
  }

  dispose() {
    for (const u of this._unsub) u?.();
    this.reset(true);
  }
}

export { PF };
