// Node test for the CPU half of the GI bake (voxeliser, Chebyshev field, under-floor fill).
//   node --import ./tools/three-resolve.mjs tools/renderlab_gitest.mjs
import * as THREE from 'three';
import { CollisionWorld } from '../src/player/collision.js';
import { GIVolume } from '../src/engine/gi.js';

const col = new CollisionWorld();
const root = new THREE.Group();
const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
const box = (a, b) => {
  col.addBox(new THREE.Vector3(...a), new THREE.Vector3(...b), 'plaster');
  const m = new THREE.Mesh(new THREE.BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]), mat);
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  root.add(m);
};
box([-512, -16, -512], [512, 0, 512]);   // floor
box([100, 0, -512], [116, 256, 512]);    // thin wall (16u)
col.build();
const gi = new GIVolume({});
const V = 32, vmin = new THREE.Vector3(-544, -64, -544);
const vx = 34, vy = 12, vz = 34;
const t0 = performance.now();
const occ = gi._voxelize({ root, collision: col }, vmin, V, vx, vy, vz);
const ms = performance.now() - t0;
const at = (x, y, z) => { const i = x + y * vx + z * vx * vy; return { a: occ.rgba[i * 4 + 3], r: occ.rgba[i * 4], fill: occ.fill[i] }; };
const cell = (p) => [Math.floor((p[0] - vmin.x) / V), Math.floor((p[1] - vmin.y) / V), Math.floor((p[2] - vmin.z) / V)];
let ok = true;
const expect = (name, cond) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name); ok &&= cond; };
const floorCell = cell([0, -8, 0]), airCell = cell([-300, 100, 0]), belowCell = cell([0, -50, 0]), wallCell = cell([108, 100, 0]);
expect('floor voxel solid', at(...floorCell).a === 255);
expect('air voxel empty', at(...airCell).a === 0);
expect('below floor filled', at(...belowCell).a === 255 && at(...belowCell).fill === 1);
expect('thin wall voxelised', at(...wallCell).a === 255);
const d = at(...cell([-300, 200, 0])).r;
expect(`distance field sane (${d})`, d >= 2 && d <= 12);
const nearWall = at(...cell([60, 100, 0])).r, adj = at(...cell([80, 100, 0])).r;
expect(`distance 2 cells from wall is 2 (${nearWall}), adjacent is 1 (${adj})`, nearWall === 2 && adj === 1);
const above = at(...cell([0, 16, 0]));
expect(`voxel just above the floor top (y 0..32) is air (${above.a})`, above.a === 0);
console.log(`voxelise ${ms.toFixed(1)} ms`, gi._vt);
process.exit(ok ? 0 : 1);
