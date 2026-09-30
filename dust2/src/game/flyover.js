// Main-menu cinematic: slow dolly shots through scenic poses from tools/poses.json, cut
// through black between shots. Each shot is traced against the collision world so the
// camera never drifts into a wall.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { applyViewAngles, angleVectors } from '../core/mathx.js';

const SHOT = 11;      // seconds per shot
const FADE = 0.9;     // fade in/out time
const _vec = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

const smooth = (t) => t * t * (3 - 2 * t);

export class Flyover {
  constructor(fadeEl) {
    this.fadeEl = fadeEl;
    this.shots = [];
    this.i = 0;
    this.t = 0;
    this.active = false;
    this.override = { eye: new THREE.Vector3(), pitch: 0, yaw: 0, fov: null, flyover: true };
    this._loading = null;
  }

  async _load() {
    let poses = World.harnessPoses || null;
    if (!poses) {
      try { poses = await (await fetch('./tools/poses.json', { cache: 'no-store' })).json(); }
      catch { poses = null; }
    }
    const shots = [];
    for (const [name, p] of Object.entries(poses || {})) {
      if (!p?.eye || /overview|placeholder/i.test(name + (p.desc || ''))) continue;
      if (Math.abs(p.pitch ?? 0) > 35) continue;
      shots.push(this._plan(new THREE.Vector3(...p.eye), p.pitch ?? 0, p.yaw ?? 0, shots.length));
    }
    if (!shots.length) {
      // No authored poses yet: orbit the bombsites / spawns.
      const m = World.map;
      const zs = [m?.bombsites?.A, m?.buyzones?.T, m?.bombsites?.B, m?.buyzones?.CT].filter(Boolean);
      zs.forEach((z, i) => {
        const c = new THREE.Vector3().addVectors(z.min, z.max).multiplyScalar(0.5);
        const eye = c.clone().add(new THREE.Vector3(-260, 150, 260));
        shots.push(this._plan(eye, 16, -45 + i * 20, i));
      });
    }
    // shuffle order but keep it stable per session
    for (let i = shots.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [shots[i], shots[j]] = [shots[j], shots[i]]; }
    this.shots = shots;
  }

  _plan(eye, pitch, yaw, i) {
    angleVectors(pitch, yaw, _vec);
    const dir = new THREE.Vector3(_vec.forward.x, 0, _vec.forward.z).normalize();
    // alternate dolly-in and lateral truck moves
    const lateral = i % 2 === 1;
    const move = lateral ? _vec.right.clone().setY(0).normalize() : dir.clone();
    let dist = lateral ? 140 : 180;
    const col = World.collision;
    if (col?.rayTrace) {
      for (const s of [1, -1]) {
        _a.copy(eye); _b.copy(eye).addScaledVector(move, s * (dist * 0.5 + 40));
        const tr = col.rayTrace(_a, _b, 1);
        if (tr.fraction < 1) dist = Math.min(dist, Math.max(0, (tr.fraction * (dist * 0.5 + 40) - 40) * 2));
      }
    }
    const from = eye.clone().addScaledVector(move, -dist * 0.5);
    const to = eye.clone().addScaledVector(move, dist * 0.5);
    return { from, to, pitch, yaw, yawDrift: lateral ? -4 : 3 };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    if (!this.shots.length && !this._loading) this._loading = this._load().then(() => { this._loading = null; });
    if (this.fadeEl) this.fadeEl.style.opacity = '1'; // black until the first shot is ready
    this._vm = World.cvar.r_drawviewmodel;
    World.cvar.r_drawviewmodel = 0;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (World.cameraOverride === this.override) World.cameraOverride = null;
    World.cvar.r_drawviewmodel = this._vm ?? 1;
    if (this.fadeEl) this.fadeEl.style.opacity = '0';
  }

  update(dt) {
    if (!this.active || !this.shots.length) return;
    this.t += dt;
    if (this.t >= SHOT) { this.t -= SHOT; this.i = (this.i + 1) % this.shots.length; }
    const s = this.shots[this.i];
    const u = smooth(Math.min(1, this.t / SHOT));
    const o = this.override;
    o.eye.lerpVectors(s.from, s.to, u);
    o.pitch = s.pitch;
    o.yaw = s.yaw + s.yawDrift * (u - 0.5);
    World.cameraOverride = o;
    const cam = World.camera;
    if (cam) { cam.position.copy(o.eye); applyViewAngles(cam, o.pitch, o.yaw, 0); }
    if (this.fadeEl) {
      const f = this.t < FADE ? 1 - this.t / FADE : this.t > SHOT - FADE ? (this.t - (SHOT - FADE)) / FADE : 0;
      this.fadeEl.style.opacity = f.toFixed(3);
    }
  }
}
