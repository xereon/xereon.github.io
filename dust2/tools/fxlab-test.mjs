// Node tests for FX CPU logic: smoke flood fill, occlusion, decal clipping, fire spread.
//   node --import ./tools/three-resolve.mjs tools/fxlab-test.mjs
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { CollisionWorld } from '../src/player/collision.js';
import { SmokeSystem, SMOKE } from '../src/fx/smoke.js';
import { Decals } from '../src/fx/decals.js';
import { rng } from '../src/core/mathx.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const col = new CollisionWorld();
const box = (a, b, s) => col.addBox(v3(...a), v3(...b), s);
box([-1400, -16, -1400], [1400, 0, 1400], 'sand');
box([-520, 0, -420], [-64, 260, -380], 'plaster');
box([64, 0, -420], [520, 260, -380], 'plaster');
box([-64, 200, -420], [64, 260, -380], 'plaster');
box([-96, 0, -1100], [-64, 260, -420], 'concrete');
box([64, 0, -1100], [96, 260, -420], 'concrete');
box([-200, 0, -330], [-80, 24, -270], 'concrete');
col.build();
World.collision = col;

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// ---- smoke in the open ----
const sys = new SmokeSystem(null, null);
const R = rng(1);
let t = 0;
const v = sys.spawn(v3(0, 2, 0), t, R);
let t0 = performance.now();
for (let i = 0; i < 60 && !v.done; i++) { t += 1 / 60; sys.update(1 / 60, t, null); }
const ms = performance.now() - t0;
const ext = { x0: 1e9, x1: -1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
const p = new THREE.Vector3();
for (let i = 0; i < v.nfilled; i++) {
  v.cellCenter(v.filled[i], p);
  ext.x0 = Math.min(ext.x0, p.x); ext.x1 = Math.max(ext.x1, p.x);
  ext.z0 = Math.min(ext.z0, p.z); ext.z1 = Math.max(ext.z1, p.z); ext.y1 = Math.max(ext.y1, p.y);
}
console.log('open smoke:', { cells: v.nfilled, particles: v.np, maxD: v.maxD.toFixed(0), ext, fillMs: ms.toFixed(1), frames: Math.round(t * 60) });
check(v.done && v.nfilled >= SMOKE.BUDGET - 1, 'fill completes within a second');
check(ext.x1 - ext.x0 > 240 && ext.x1 - ext.x0 < 360, `open diameter ~300 (${ext.x1 - ext.x0})`);
check(ext.y1 > 100 && ext.y1 < 170, `height ~130 (${ext.y1})`);
t = 3;
const occCore = 1 - Math.exp(-sys.opticalDepth(v3(0, 64, 400), v3(0, 64, -300), t));
const occEdge = 1 - Math.exp(-sys.opticalDepth(v3(-400, 64, 130), v3(400, 64, 130), t));
const occAbove = 1 - Math.exp(-sys.opticalDepth(v3(-400, 240, 0), v3(400, 240, 0), t));
console.log('occlusion core/edge/above', occCore.toFixed(3), occEdge.toFixed(3), occAbove.toFixed(3));
check(occCore > 0.99, 'core blocks LOS');
check(occAbove < 0.05, 'clear above the smoke');
check(sys.densityAt(v3(0, 50, 0), 3) > 0.9, 'dense inside at 3s');
check(sys.densityAt(v3(0, 50, 0), 0.02) < 0.2, 'not dense at 0.02s');
check(sys.densityAt(v3(0, 50, 0), 19.5) < 0.05, 'gone at 19.5s');
v.kill();

// ---- smoke at the doorway: must flow into the corridor, not through walls ----
t = 0;
const w = sys.spawn(v3(0, 2, -440), t, R);
for (let i = 0; i < 60 && !w.done; i++) { t += 1 / 60; sys.update(1 / 60, t, null); }
let minZ = 1e9, leak = 0, court = 0;
for (let i = 0; i < w.nfilled; i++) {
  w.cellCenter(w.filled[i], p);
  minZ = Math.min(minZ, p.z);
  if (p.z < -420 && (p.x < -64 || p.x > 64)) leak++;
  if (p.z > -380) court++;
}
console.log('corridor smoke:', { cells: w.nfilled, minZ, leak, court });
check(leak === 0, 'no voxels inside/behind corridor walls');
check(minZ < -580, `flows down the corridor (minZ ${minZ})`);
check(court > 50, 'spills out of the doorway into the courtyard');
// through-wall occlusion must be zero on the other side of the wall
const occWall = 1 - Math.exp(-sys.opticalDepth(v3(-300, 64, -600), v3(-300, 64, -800), 3));
check(occWall < 0.01, 'no smoke behind the wall');
w.kill();

// ---- decal clipping ----
const dec = new Decals(null, {});
// on the step top near its edge: must be clipped to x <= -80 and z in [-330, -270]
dec.add(v3(-82, 24, -300), v3(0, 1, 0), 'bullet_concrete', 12, 0.3, 'concrete');
let maxX = -1e9;
for (let i = 0; i < 12; i++) maxX = Math.max(maxX, dec.pos[i * 3]);
check(maxX <= -79.9 && dec.lastClipped >= 1, `clipped at the step edge (maxX ${maxX.toFixed(2)})`);
// on the big floor right next to the step: floor brush continues under the step -> not clipped
dec.add(v3(-70, 0, -300), v3(0, 1, 0), 'bullet_concrete', 12, 0.3, 'sand');
check(dec.lastClipped === 0, 'floor decal not clipped by the step');
// on the wall at the doorway jamb: clipped at x = -64
dec.add(v3(-66, 100, -380), v3(0, 0, 1), 'bullet_plaster', 10, 0.0, 'plaster');
let mx = -1e9;
for (let i = 0; i < 12; i++) mx = Math.max(mx, dec.pos[(2 * 12 + i) * 3]);
check(mx <= -63.9, `clipped at the door jamb (maxX ${mx.toFixed(2)})`);
// coplanar seam: split wall above the door (x -64..64, y 200..260) meets the left wall at x=-64:
// a decal straddling the seam must NOT be cut
dec.add(v3(-64, 230, -380), v3(0, 0, 1), 'bullet_plaster', 10, 0.0, 'plaster');
check(dec.lastClipped === 0, 'not cut at a coplanar brush seam');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
