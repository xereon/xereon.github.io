// Fuzz Source movement over the real de_dust2 collision (node, no rendering).
//   node --import ./tools/three-resolve.mjs tools/movement_mapfuzz.mjs [seconds-per-walker] [walkers]
import { World } from '../src/core/world.js';
import { Player } from '../src/player/player.js';
import { gameMovement } from '../src/player/movement.js';
import { IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED, newCmd } from '../src/core/input.js';

const secs = +process.argv[2] || 20, walkers = +process.argv[3] || 10;
const { buildDust2 } = await import('../src/map/dust2.js');
const t0 = performance.now();
const map = await buildDust2({ textures: null, props: null });
console.log(`map built in ${(performance.now() - t0).toFixed(0)} ms, ${map.collision.brushes.length} brushes`);
World.collision = map.collision; World.map = map;
const TICK = 1 / 128;
let a = 99991; const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
const spawns = [...map.spawns.T, ...map.spawns.CT];
const ps = [];
for (let i = 0; i < walkers; i++) {
  const p = new Player({ team: i % 2 ? 'CT' : 'T', isBot: false });
  const s = spawns[i % spawns.length];
  p.respawn(s); World.entities.push(p); ps.push(p);
  p._held = 0; p._yaw = s.yaw;
}
const cmd = newCmd();
// probe: from a frozen spot, can the hull move 8u in each of 16 directions (walking)?
function report(p) {
  const o = p.origin.clone(), v = p.velocity.clone(), d = p.ducked, g = p.onGround, dA = p.duckAmount, mt = p.moveType;
  const free = [];
  for (let k = 0; k < 16; k++) {
    const q = new Player({ team: 'T' }); q.origin.copy(o); q.ducked = d; q.duckAmount = dA; q.onGround = g;
    const c = newCmd(); c.forwardmove = 450; c.yaw = k * 22.5; c.buttons = IN_FORWARD | (d ? IN_DUCK : 0);
    const saved = World.entities.slice(); World.entities.length = 0; World.entities.push(q);
    for (let t = 0; t < 32; t++) { World.time += TICK; q.runCommand(c, TICK); }
    World.entities.length = 0; World.entities.push(...saved);
    free.push(Math.round(q.origin.distanceTo(o)));
  }
  console.log(`frozen 100 ticks at (${o.x.toFixed(1)},${o.y.toFixed(1)},${o.z.toFixed(1)}) ground=${g} ducked=${d} mt=${mt} held=${p._held} yaw=${(p._yaw % 360).toFixed(0)} vel=(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}) | 0.25s probe dist per 22.5deg: ${free.join(',')}`);
}
let stuck = 0, nan = 0, ticks = 0, frozenTicks = 0, maxFrozen = 0, falls = 0;
const t1 = performance.now();
const n = Math.round(secs / TICK);
for (let i = 0; i < n; i++) {
  World.time += TICK;
  for (const p of ps) {
    if (i % 40 === 0) {
      p._held = [IN_FORWARD, IN_FORWARD, IN_FORWARD | IN_MOVELEFT, IN_FORWARD | IN_MOVERIGHT, IN_MOVELEFT, IN_MOVERIGHT, IN_BACK][Math.floor(rnd() * 7)];
      if (rnd() < 0.25) p._held |= IN_JUMP; if (rnd() < 0.2) p._held |= IN_DUCK; if (rnd() < 0.1) p._held |= IN_SPEED;
      if (rnd() < 0.3) p._yaw += (rnd() - 0.5) * 180;
    }
    p._yaw += (rnd() - 0.5) * 4;
    const b = p._held;
    cmd.buttons = b; cmd.yaw = p._yaw; cmd.pitch = 0;
    cmd.forwardmove = (b & IN_FORWARD ? 450 : 0) - (b & IN_BACK ? 450 : 0);
    cmd.sidemove = (b & IN_MOVERIGHT ? 450 : 0) - (b & IN_MOVELEFT ? 450 : 0);
    const before = p.origin.clone();
    p.runCommand(cmd, TICK);
    ticks++;
    if (!Number.isFinite(p.origin.x + p.origin.y + p.origin.z)) nan++;
    if (gameMovement.stuckAt(p.origin, p.ducked)) stuck++;
    if (p.origin.y < -2000) { falls++; p.respawn(spawns[0]); }
    // "frozen": holding a direction on the ground but not moving for > 1 s (wedged)
    if ((b & (IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT)) && p.origin.distanceTo(before) < 1e-4) {
      p._fz = (p._fz || 0) + 1; frozenTicks++; maxFrozen = Math.max(maxFrozen, p._fz);
      if (p._fz === 100) report(p);
    }
    else p._fz = 0;
  }
}
const ms = performance.now() - t1;
console.log(`${ticks} player-ticks in ${ms.toFixed(0)} ms -> ${(ms / ticks * 1000).toFixed(1)} us per player-tick`);
console.log(`embedded ${stuck}, NaN ${nan}, fell out of world ${falls}, zero-motion-while-pushing ticks ${frozenTicks} (longest run ${maxFrozen} ticks)`);
console.log(`final positions: ${ps.map((p) => `(${p.origin.x.toFixed(0)},${p.origin.y.toFixed(0)},${p.origin.z.toFixed(0)})`).join(' ')}`);
process.exit(stuck || nan || falls ? 1 : 0);
