// Node test: bake the navmesh on a synthetic CollisionWorld and check paths.
//   node --import ./tools/three-resolve.mjs tools/ai_navtest.mjs
import * as THREE from 'three';
import { CollisionWorld } from '../src/player/collision.js';
import { buildNavMeshSync, LINK_JUMP, LINK_DROP, LINK_CJUMP } from '../src/ai/navmesh.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : '  FAIL'} ${msg}`); if (!cond) fails++; };

export function testWorld() {
  const cw = new CollisionWorld();
  cw.addBox(V(-1200, -32, -1200), V(1200, 0, 1200), 'sand');            // ground
  // outer walls
  cw.addBox(V(-1232, 0, -1232), V(1232, 300, -1200)); cw.addBox(V(-1232, 0, 1200), V(1232, 300, 1232));
  cw.addBox(V(-1232, 0, -1200), V(-1200, 300, 1200)); cw.addBox(V(1200, 0, -1200), V(1232, 300, 1200));
  // a dividing wall x=0 from z=-1200..600 — the only way across is a 96u doorway at z 200..296,
  // or around the end at z>600
  cw.addBox(V(-16, 0, -1200), V(16, 200, 200));
  cw.addBox(V(-16, 108, 200), V(16, 200, 296));                          // lintel over the door
  cw.addBox(V(-16, 0, 296), V(16, 200, 600));
  // corridor: two walls along z at x=-800..-400, 128u apart
  cw.addBox(V(-800, 0, -700), V(-400, 150, -684)); cw.addBox(V(-800, 0, -540), V(-400, 150, -524));
  // stairs up to a platform at y=128 (8 steps of 16u, 24u deep) rising toward -z, at x 400..560
  for (let i = 0; i < 8; i++) cw.addBox(V(400, 0, -200 - i * 24), V(560, 16 * (i + 1), -176 - i * 24));
  cw.addBox(V(400, 0, -600), V(700, 128, -368));                         // platform A (stairs top)
  // ramp up to platform B (y=96) along +x, at z 700..860, 45° max -> 160 long rising 96
  cw.addWedge(V(300, 0, 700), V(460, 96, 860), 'x', 1);
  cw.addBox(V(460, 0, 700), V(700, 96, 1000));                            // platform B
  // a 64u box and a 40u box in open ground
  cw.addBox(V(-700, 0, 700), V(-600, 64, 1000));                          // 64 tall wall-like box
  cw.addBox(V(-400, 0, 900), V(-340, 40, 960));                           // 40 tall box
  // thin-wall case (Dust II A ramp): a platform at 96 behind a 20u-thick wall 128 tall, with a
  // ramp beside the wall rising to 112. The wall top is standable but a tightrope; the real way
  // onto the platform is a ramp round the far side.
  cw.addBox(V(-1150, 0, -1150), V(-996, 96, -850));                        // platform C
  cw.addBox(V(-996, 0, -1150), V(-970, 128, -850));                        // thin wall (26u, on a grid column)
  cw.addWedge(V(-970, 0, -1100), V(-850, 112, -850), 'z', -1);             // side ramp up to 112
  cw.addBox(V(-970, 0, -1150), V(-850, 112, -1100));                       // ramp top landing
  cw.addWedge(V(-1150, 0, -850), V(-996, 96, -700), 'z', -1);              // access ramp onto C
  cw.build();
  const zone = (a, b, name) => ({ min: V(...a), max: V(...b), name });
  return {
    collision: cw,
    spawns: { T: [{ pos: V(-900, 0, -900), yaw: 0 }], CT: [{ pos: V(900, 0, 900), yaw: 180 }] },
    bombsites: { A: zone([420, 100, -580], [680, 200, -400], 'A'), B: zone([480, 80, 720], [680, 180, 980], 'B') },
    callouts: {
      west: zone([-1200, -10, -1200], [0, 200, 1200], 'west'),
      east: zone([0, -10, -1200], [1200, 200, 1200], 'east'),
      corridor: zone([-800, -10, -684], [-400, 150, -540], 'corridor'),
      platA: zone([400, 100, -600], [700, 200, -368], 'platA'),
    },
    walkable: new Float32Array(),
  };
}

const map = testWorld();
const t0 = performance.now();
const nav = buildNavMeshSync(map);
const ms = performance.now() - t0;
console.log(`baked ${nav.count} nodes, ${nav.linkTo.length} links in ${ms.toFixed(0)} ms`, nav.stats);

// 1. across the dividing wall: must use the doorway (z 200..296) or go around the end (z>600)
{
  const p = nav.findPath(V(-600, 0, -300), V(600, 0, -300));
  ok(!!p, 'path across the dividing wall exists');
  const nodes = nav.lastPathNodes;
  let crossZ = null;
  for (let i = 1; i < nodes.length; i++) {
    const ax = nav.px[nodes[i - 1]], bx = nav.px[nodes[i]];
    if (ax < 0 && bx >= 0) crossZ = (nav.pz[nodes[i - 1]] + nav.pz[nodes[i]]) / 2;
  }
  ok(crossZ !== null && crossZ > 200 && crossZ < 296, `crosses x=0 through the doorway (z=${crossZ?.toFixed(0)})`);
  for (const w of p || []) ok(Math.abs(w.x) > 16 + 15 || (w.z > 200 && w.z < 296), `waypoint (${w.x.toFixed(0)},${w.z.toFixed(0)}) not inside wall`);
}
// 2. stairs up to platform A
{
  const p = nav.findPath(V(480, 0, 0), V(550, 128, -500));
  ok(!!p, 'path up the stairs exists');
  const nodes = nav.lastPathNodes;
  const last = nodes[nodes.length - 1];
  ok(Math.abs(nav.py[last] - 128) < 2, `ends on platform (y=${nav.py[last].toFixed(1)})`);
  let viaStairs = nodes.some((n) => nav.px[n] > 400 && nav.px[n] < 560 && nav.pz[n] < -176 && nav.pz[n] > -392 && nav.py[n] > 10 && nav.py[n] < 125);
  ok(viaStairs, 'goes via the stair steps');
  let jumps = 0;
  for (let i = 1; i < nodes.length; i++) { const k = nav.linkBetween(nodes[i - 1], nodes[i]); if (nav.linkType[k] !== 0) jumps++; }
  ok(jumps === 0, `no jumps needed on stairs (${jumps})`);
}
// 3. ramp up to platform B
{
  const p = nav.findPath(V(200, 0, 780), V(600, 96, 850));
  ok(!!p, 'path up the ramp exists');
  const nodes = nav.lastPathNodes;
  ok(nodes.some((n) => nav.px[n] > 310 && nav.px[n] < 450 && nav.py[n] > 10 && nav.py[n] < 90), 'goes via the ramp');
  ok(Math.abs(nav.py[nodes[nodes.length - 1]] - 96) < 2, 'ends on platform B');
}
// 4. 64u box: nothing climbs it; path around it
{
  const top = nav.nearest(V(-650, 64, 850));
  ok(top < 0 || nav.py[top] < 60 || Math.hypot(nav.px[top] + 650, nav.pz[top] - 850) > 40, 'no reachable node on top of 64u box');
  const p = nav.findPath(V(-800, 0, 850), V(-500, 0, 850));
  ok(!!p, 'path past 64u box');
  const nodes = nav.lastPathNodes;
  ok(nodes.every((n) => nav.py[n] < 5), 'path around the 64u box stays on the ground');
  ok(nodes.some((n) => nav.pz[n] < 700 - 16 || nav.pz[n] > 1000 + 16), 'path detours around its end');
}
// 5. 40u box: jumpable (a jump link exists onto it)
{
  const top = nav.nearest(V(-370, 40, 930), 60);
  ok(top >= 0 && Math.abs(nav.py[top] - 40) < 2, '40u box top has a node');
  let jump = false, drop = false;
  for (let a = 0; a < nav.count; a++) for (let k = nav.linkStart[a]; k < nav.linkStart[a + 1]; k++) {
    if (nav.linkTo[k] === top && (nav.linkType[k] === LINK_JUMP || nav.linkType[k] === LINK_CJUMP)) jump = true;
    if (a === top && nav.linkType[k] === LINK_DROP) drop = true;
  }
  ok(jump && drop, `40u box has jump-up (${jump}) and drop-down (${drop}) links`);
}
// 6. drop from platform A to the ground is a one-way link
{
  const p = nav.findPath(V(650, 128, -450), V(800, 0, -450));
  ok(!!p && p.some((w) => w.t === LINK_DROP), 'path off platform A uses a drop');
}
// 7. nothing inside walls; corridor nodes keep 16u off the walls
{
  let bad = 0;
  for (let i = 0; i < nav.count; i++) {
    const x = nav.px[i], z = nav.pz[i];
    if (x > -800 && x < -400 && ((z > -700 - 16 && z < -684 + 16) || (z > -540 - 16 && z < -524 + 16)) && nav.py[i] < 140) bad++;
    if (Math.abs(x) < 16 + 15.9 && (z < 200 || z > 296) && z < 600 && nav.py[i] < 190) bad++;
  }
  ok(bad === 0, `no nodes inside/against walls (${bad})`);
  ok(nav.areaOf(V(-600, 0, -600)) === 'corridor', `areaOf corridor = ${nav.areaOf(V(-600, 0, -600))}`);
  ok(nav.areaOf(V(550, 128, -500)) === 'platA', `areaOf platform = ${nav.areaOf(V(550, 128, -500))}`);
}
// 7b. thin wall: path from the side ramp onto platform C goes round, never along the wall top
{
  const p = nav.findPath(V(-915, 0, -820), V(-1075, 96, -1000));
  ok(!!p, 'path onto platform C exists');
  const nodes = nav.lastPathNodes;
  const onWall = nodes.filter((n) => nav.py[n] > 118 && nav.px[n] > -1012 && nav.px[n] < -954 && nav.pz[n] > -1090).length;
  ok(onWall === 0, `path avoids the thin wall top (${onWall} wall nodes)`);
  let ridge = 0, top = 0;
  for (let i = 0; i < nav.count; i++) if (nav.py[i] > 118 && nav.px[i] > -1012 && nav.px[i] < -954 && nav.pz[i] > -1090) { top++; if (nav.ridge[i] || nav.overhang[i]) ridge++; }
  ok(top > 0, `wall top is sampled (${top} nodes)`);
  ok(ridge >= top * 0.9, `wall-top nodes flagged ridge/overhang (${ridge}/${top})`);
}
// 8. perf: many random paths
{
  const t = performance.now();
  let n = 0, found = 0;
  for (let i = 0; i < 200; i++) {
    const a = V(Math.random() * 2200 - 1100, 0, Math.random() * 2200 - 1100), b = V(Math.random() * 2200 - 1100, 0, Math.random() * 2200 - 1100);
    if (nav.findPath(a, b)) found++; n++;
  }
  const per = (performance.now() - t) / n;
  console.log(`  path avg ${per.toFixed(2)} ms (${found}/${n} found)`);
  ok(per < 3, 'avg path < 3 ms');
}
ok(ms < 2000, `bake < 2 s (${ms.toFixed(0)} ms)`);
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall nav tests passed');
process.exit(fails ? 1 : 0);
