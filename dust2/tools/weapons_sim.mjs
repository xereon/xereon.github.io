// Headless weapons sandbox for node tests: real CollisionWorld, real Player (movement +
// punch decay), real WeaponSystem, ticked at 128 Hz exactly like src/main.js.
//   node --import ./tools/three-resolve.mjs tools/weapons_test.mjs
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { newCmd } from '../src/core/input.js';
import { CollisionWorld } from '../src/player/collision.js';

export const V = (x, y, z) => new THREE.Vector3(x, y, z);

let mods = null;
async function load() {
  if (mods) return mods;
  const P = await import('../src/player/player.js');
  const S = await import('../src/weapons/system.js');
  const R = await import('../src/weapons/registry.js');
  const C = await import('../src/weapons/recoil.js');
  const B = await import('../src/weapons/ballistics.js');
  mods = { P, S, R, C, B };
  return mods;
}

/**
 * boxes: [{ min:[x,y,z], max:[x,y,z], surface }]  (a big sand floor at y=0 is always added)
 */
export async function setupWorld({ boxes = [], floor = true } = {}) {
  const m = await load();
  const col = new CollisionWorld();
  if (floor) col.addBox(V(-8000, -32, -8000), V(8000, 0, 8000), 'sand');
  for (const b of boxes) col.addBox(V(...b.min), V(...b.max), b.surface || 'default', b.flags || 1);
  col.build();
  World.collision = col;
  World.map = {
    bombsites: { A: { min: V(-200, -10, -200), max: V(200, 200, 200), name: 'A' } },
    spawns: { T: [{ pos: V(0, 0, 0), yaw: 0 }], CT: [{ pos: V(500, 0, 0), yaw: 180 }] },
  };
  World.entities.length = 0;
  World.local = null;
  World.time = 0;
  World.tickInterval = 1 / 128;
  World.match = null;
  World.fx = null;
  World.hud = null;
  World.input = { buttons: 0, sensScale: 1, pitch: 0, yaw: 0 };
  World.weapons = new m.S.WeaponSystem();
  return { col, ...m, W: World.weapons };
}

export function makePlayer(team, pos, { yaw = 0, pitch = 0, name } = {}) {
  const p = new mods.P.Player({ team, isBot: true, name: name || `${team}${World.entities.length}` });
  World.entities.push(p);
  p.respawn({ pos: pos.clone ? pos.clone() : V(...pos), yaw });
  p.lastCmd = newCmd();
  p.lastCmd.yaw = yaw; p.lastCmd.pitch = pitch;
  p.pitch = pitch; p.yaw = yaw;
  p.onGround = true;
  return p;
}

/** Advance n ticks: every live player runs its usercmd (movement + punch decay), then weapons. */
export function step(n = 1, dt = World.tickInterval) {
  for (let i = 0; i < n; i++) {
    World.time += dt;
    for (const e of World.entities) if (e.alive && e.lastCmd) e.runCommand(e.lastCmd, dt);
    World.weapons.tick(dt);
  }
}

export function stepSeconds(s) { step(Math.round(s / World.tickInterval)); }

/** Collect events of a type while fn runs. */
export function collect(name, fn) {
  const out = [];
  const off = World.on(name, (e) => out.push(e));
  try { fn(); } finally { off(); }
  return out;
}

export { World };
