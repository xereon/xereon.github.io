// BASELINE STUB — map agent replaces this. See CONTRACT.md §6.
import * as THREE from 'three';
import { CollisionWorld } from '../player/collision.js';
import { TextureLib } from '../art/textures.js';

export async function buildDust2() {
  const root = new THREE.Group();
  const collision = new CollisionWorld();
  const box = (min, max, mat, surf) => {
    const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const m = new THREE.Mesh(g, TextureLib.material(mat));
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    root.add(m);
    collision.addBox(new THREE.Vector3(...min), new THREE.Vector3(...max), surf);
  };
  box([-2000, -16, -2000], [2000, 0, 2000], 'sand_floor', 'sand');
  box([300, 0, -400], [340, 200, 400], 'plaster_wall', 'plaster');
  box([-200, 0, -300], [-136, 64, -236], 'wood_crate', 'crate');
  collision.build();
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const zone = (a, b, name) => ({ min: v(...a), max: v(...b), name });
  return {
    root, collision,
    spawns: { T: [{ pos: v(0, 0, 0), yaw: 0 }], CT: [{ pos: v(0, 0, -800), yaw: 180 }] },
    bombsites: { A: zone([200, 0, -900], [600, 200, -500], 'A'), B: zone([-600, 0, -900], [-200, 200, -500], 'B') },
    buyzones: { T: zone([-300, 0, -300], [300, 200, 300], 'T'), CT: zone([-300, 0, -1100], [300, 200, -500], 'CT') },
    sun: { dir: v(-0.5, -0.8, -0.3).normalize(), color: new THREE.Color(0xfff0d0), intensity: 3 },
    ambient: { sky: new THREE.Color(0xbfd6ff), ground: new THREE.Color(0x8a6a45), intensity: 1 },
    fog: { color: new THREE.Color(0xd8c8a8), density: 0.00005 },
    walkable: new Float32Array(),
    callouts: {},
  };
}
