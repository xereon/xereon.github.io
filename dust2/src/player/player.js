// BASELINE STUB — movement agent replaces this with Source-accurate movement.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { applyViewAngles, flatVectors } from '../core/mathx.js';
import { MASK_PLAYER } from './collision.js';

const MINS = new THREE.Vector3(-16, 0, -16), MAXS = new THREE.Vector3(16, 72, 16);
const f = new THREE.Vector3(), r = new THREE.Vector3(), end = new THREE.Vector3();

export class Player {
  constructor(team) {
    this.team = team; this.alive = true; this.health = 100; this.armor = 0;
    this.origin = new THREE.Vector3(); this.velocity = new THREE.Vector3();
    this.pitch = 0; this.yaw = 0; this.eyeHeight = 64; this.onGround = false;
    this.isLocal = true;
  }
  setPose(eye, pitch, yaw) {
    this.origin.set(eye.x, eye.y - this.eyeHeight, eye.z); this.velocity.set(0, 0, 0);
    this.pitch = pitch; this.yaw = yaw;
  }
  runCommand(cmd, dt) {
    if (World.cameraOverride) return;
    this.pitch = cmd.pitch; this.yaw = cmd.yaw;
    flatVectors(this.yaw, f, r);
    const wish = f.multiplyScalar(cmd.forwardmove).add(r.multiplyScalar(cmd.sidemove));
    if (wish.lengthSq() > 0) wish.setLength(250);
    this.velocity.x = wish.x; this.velocity.z = wish.z;
    this.velocity.y -= 800 * dt;
    end.copy(this.origin).addScaledVector(this.velocity, dt);
    const tr = World.collision.hullTrace(MINS, MAXS, this.origin, end, MASK_PLAYER);
    this.origin.copy(tr.endpos);
    if (tr.fraction < 1 && tr.normal.y > 0.7) { this.velocity.y = 0; this.onGround = true; }
  }
  frame() {
    const cam = World.camera;
    if (World.cameraOverride) return;
    cam.position.set(this.origin.x, this.origin.y + this.eyeHeight, this.origin.z);
    applyViewAngles(cam, World.input.pitch, World.input.yaw, 0);
  }
}

export function createLocalPlayer(team = 'T') {
  const p = new Player(team);
  const s = World.map?.spawns?.[team]?.[0];
  if (s) { p.origin.copy(s.pos); p.yaw = s.yaw; World.input.yaw = s.yaw; }
  World.entities.push(p);
  return p;
}
