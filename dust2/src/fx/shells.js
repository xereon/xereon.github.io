// Brass ejection: instanced casings with CPU rigid-ish physics against the brush world
// (few dozen live shells at most). Emits 'shell_land' {pos, key, speed} for the audio tink.
import * as THREE from 'three';
import { World } from '../core/world.js';

const MAX = 96;
const LIFE = 14;          // seconds a settled shell stays before shrinking away
const HULL_MIN = new THREE.Vector3(-0.35, -0.35, -0.35);
const HULL_MAX = new THREE.Vector3(0.35, 0.35, 0.35);
const MASK_SHELL = 1 | 4; // solid + grate

// shell classes: [length, radius, bottleneck, colour, emissive]
const CLASS = {
  rifle: { len: 1.55, rad: 0.22, neck: 0.72, color: 0xc9a045 },
  pistol: { len: 0.78, rad: 0.2, neck: 1.0, color: 0xcfa84e },
  sniper: { len: 2.3, rad: 0.25, neck: 0.62, color: 0xc49a3e },
  smg: { len: 0.8, rad: 0.2, neck: 1.0, color: 0xc49a45 },
  shotgun: { len: 2.6, rad: 0.36, neck: 1.0, color: 0xa3261c },
};

export function shellClass(key) {
  if (!key) return 'rifle';
  if (/nova|xm1014|mag7|sawed/.test(key)) return 'shotgun';
  if (/awp|ssg08|g3sg1|scar20/.test(key)) return 'sniper';
  if (/glock|usp|p250|deagle|tec9|fiveseven|dualberettas|cz75|p2000|r8|elite/.test(key)) return 'pistol';
  if (/mp9|mac10|mp5|ump|p90|mp7|bizon/.test(key)) return 'smg';
  return 'rifle';
}

function casingGeometry() {
  // Unit-length casing along +Z (base at z=0), radius 1: lathe profile with a bottleneck.
  const pts = [
    new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.95, 0.0), new THREE.Vector2(1.0, 0.03),
    new THREE.Vector2(1.0, 0.07), new THREE.Vector2(0.86, 0.09), new THREE.Vector2(0.86, 0.12),
    new THREE.Vector2(1.0, 0.14), new THREE.Vector2(0.98, 0.7), new THREE.Vector2(0.72, 0.8),
    new THREE.Vector2(0.72, 1.0), new THREE.Vector2(0.6, 1.0),
  ];
  const g = new THREE.LatheGeometry(pts, 10);
  g.rotateX(Math.PI / 2); // lathe is around Y -> casing along Z
  return g;
}

const _p = new THREE.Vector3(), _e = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4(), _ax = new THREE.Vector3(), _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3(0, 0, 1);

export class Shells {
  constructor(scene) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.75, roughness: 0.32 });
    this.mesh = new THREE.InstancedMesh(casingGeometry(), mat, MAX);
    this.mesh.name = 'fx-shells';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData.fx = true;
    for (let i = 0; i < MAX; i++) this.mesh.setColorAt(i, _c.set(0xffffff));
    scene?.add(this.mesh);
    this.s = [];
    for (let i = 0; i < MAX; i++) {
      this.s.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(),
        w: new THREE.Vector3(), t0: 0, rest: false, bounces: 0, key: '', cls: CLASS.rifle, restT: 0,
      });
    }
    this.head = 0;
  }

  spawn(now, pos, vel, key, rand) {
    const i = this.head; this.head = (i + 1) % MAX;
    const s = this.s[i];
    s.alive = true; s.rest = false; s.bounces = 0; s.t0 = now; s.key = key || '';
    s.cls = CLASS[shellClass(key)];
    s.pos.copy(pos); s.vel.copy(vel);
    // random initial orientation roughly across the velocity, fast tumble
    _ax.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    s.q.setFromAxisAngle(_ax, rand() * Math.PI * 2);
    s.w.set((rand() - 0.5) * 40, (rand() - 0.5) * 40, (rand() - 0.5) * 40);
    this.mesh.setColorAt(i, _c.set(s.cls.color));
    this.mesh.instanceColor.needsUpdate = true;
    if (this.mesh.count < MAX) this.mesh.count = Math.max(this.mesh.count, i + 1);
  }

  update(dt, now) {
    const col = World.collision;
    let dirty = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const s = this.s[i];
      if (!s.alive) continue;
      const age = now - s.t0;
      let scale = 1;
      if (s.rest) {
        const ra = now - s.restT;
        if (ra > LIFE) { s.alive = false; scale = 0; }
        else if (ra > LIFE - 1) scale = LIFE - ra;
        else continue; // static, matrix already written
      } else if (age > 6) {
        s.rest = true; s.restT = now;
      } else {
        // integrate with substeps (shells are fast and tiny)
        const steps = dt > 1 / 90 ? 2 : 1;
        const h = dt / steps;
        for (let k = 0; k < steps && !s.rest; k++) {
          s.vel.y -= 800 * h;
          s.vel.multiplyScalar(1 - 0.35 * h);
          _e.copy(s.pos).addScaledVector(s.vel, h);
          if (col) {
            const tr = col.hullTrace(HULL_MIN, HULL_MAX, s.pos, _e, MASK_SHELL);
            if (tr.fraction < 1 && !tr.startSolid) {
              s.pos.copy(tr.endpos).addScaledVector(tr.normal, 0.05);
              const vn = s.vel.dot(tr.normal);
              const speed = -vn;
              s.vel.addScaledVector(tr.normal, -(1 + 0.38) * vn);
              // tangential friction
              _p.copy(tr.normal).multiplyScalar(s.vel.dot(tr.normal));
              s.vel.sub(_p).multiplyScalar(0.62).add(_p);
              s.w.multiplyScalar(0.55).addScaledVector(_ax.set(Math.sin(now * 13 + i), 0, Math.cos(now * 11 + i)), speed * 0.08);
              if (s.bounces < 3 && speed > 35) {
                World.emit('shell_land', { pos: s.pos, key: s.key, speed, bounce: s.bounces });
              }
              s.bounces++;
              if (tr.normal.y > 0.7 && (s.vel.lengthSq() < 30 * 30 || s.bounces > 5)) {
                s.rest = true; s.restT = now;
                // lie flat: casing axis horizontal, random yaw
                const yaw = (i * 2.399 + now) % (Math.PI * 2);
                _ax.set(Math.cos(yaw), 0, Math.sin(yaw));
                s.q.setFromUnitVectors(_z, _ax);
                s.pos.y = tr.endpos.y + s.cls.rad * 0.95;
              }
            } else if (tr.startSolid) {
              s.pos.addScaledVector(s.vel, h); // escape
            } else s.pos.copy(_e);
          } else {
            s.pos.copy(_e);
            if (s.pos.y < 0) { s.pos.y = 0; s.vel.y = Math.abs(s.vel.y) * 0.3; }
          }
        }
        if (!s.rest) {
          const wl = s.w.length();
          if (wl > 1e-3) { _q.setFromAxisAngle(_ax.copy(s.w).multiplyScalar(1 / wl), wl * dt); s.q.premultiply(_q); }
        }
      }
      _s.set(s.cls.rad * scale, s.cls.rad * scale, s.cls.len * scale);
      // centre the casing on its position
      _p.set(0, 0, -0.5 * s.cls.len * scale).applyQuaternion(s.q).add(s.pos);
      _m.compose(_p, s.q, _s);
      this.mesh.setMatrixAt(i, _m);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() { for (const s of this.s) s.alive = false; this.mesh.count = 0; }
}
