// Movement verification against Source/CS:GO numbers.
//   cd dust2 && node --import ./tools/three-resolve.mjs tools/movement_test.mjs [-v]
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { CollisionWorld, CONTENTS_PLAYERCLIP, CONTENTS_LADDER } from '../src/player/collision.js';
import { Player } from '../src/player/player.js';
import { gameMovement } from '../src/player/movement.js';
import { IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_JUMP, IN_DUCK, IN_SPEED, newCmd } from '../src/core/input.js';

const VERBOSE = process.argv.includes('-v');
const TICK = 1 / 128;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
let fails = 0, passes = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) passes++; else fails++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
}
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

// ---- scene helpers --------------------------------------------------------------------------
function world(build) {
  const cw = new CollisionWorld();
  cw.addBox(V(-4000, -64, -4000), V(4000, 0, 4000), 'sand'); // floor, top at y=0
  build?.(cw);
  cw.build();
  World.collision = cw;
  World.entities.length = 0;
  World.time = 0;
  return cw;
}

function spawn(x = 0, y = 0, z = 0, yaw = 0, opts = {}) {
  const p = new Player({ team: 'T', isLocal: false, ...opts });
  p.origin.set(x, y, z);
  p.yaw = yaw;
  World.entities.push(p);
  // settle onto the ground
  run(p, 0.1, () => {});
  return p;
}

const cmd = newCmd();
function makeCmd(p, buttons, yaw, pitch = 0) {
  const s = 450;
  cmd.buttons = buttons;
  cmd.forwardmove = ((buttons & IN_FORWARD) ? s : 0) - ((buttons & IN_BACK) ? s : 0);
  cmd.sidemove = ((buttons & IN_MOVERIGHT) ? s : 0) - ((buttons & IN_MOVELEFT) ? s : 0);
  cmd.upmove = 0;
  cmd.yaw = yaw ?? p.yaw;
  cmd.pitch = pitch;
  return cmd;
}

/** Run `seconds` of ticks; fn(t, tick) returns buttons (number) or {buttons, yaw, pitch}. */
function run(p, seconds, fn, onTick) {
  const n = Math.round(seconds / TICK);
  for (let i = 0; i < n; i++) {
    const t = i * TICK;
    let r = fn(t, i) ?? 0;
    if (typeof r === 'number') r = { buttons: r };
    World.time += TICK;
    p.runCommand(makeCmd(p, r.buttons | 0, r.yaw ?? p.yaw, r.pitch ?? 0), TICK);
    onTick?.(t + TICK, i);
  }
}
const hspeed = (p) => Math.hypot(p.velocity.x, p.velocity.z);
const events = [];
for (const ev of ['footstep', 'jump', 'land', 'damage', 'death']) World.on(ev, (e) => events.push({ ev, t: World.time, ...e }));

// =============================================================================================
console.log('\n# Ground acceleration (W from standstill, knife 250)');
{
  world();
  const p = spawn();
  // Independent reference: Source Friction() + Accelerate() difference equation.
  let ref = 0; const refCurve = [];
  for (let i = 0; i < 128; i++) {
    ref = Math.max(0, ref - Math.max(ref, 80) * 5.2 * TICK);
    ref += Math.min(5.5 * 250 * TICK, 250 - ref);
    refCurve.push(ref);
  }
  const curve = [];
  run(p, 1.0, () => IN_FORWARD, () => curve.push(hspeed(p)));
  const at = (t) => curve[Math.round(t / TICK) - 1];
  const rat = (t) => refCurve[Math.round(t / TICK) - 1];
  const rows = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((t) => `${t}s:${f2(at(t))}(ref ${f2(rat(t))})`);
  console.log('   ' + rows.join('  '));
  const maxDev = Math.max(...curve.map((v, i) => Math.abs(v - refCurve[i])));
  check('accel curve matches Source Friction+Accelerate', maxDev < 0.05, `max dev ${maxDev.toFixed(4)} u/s`);
  const t240 = curve.findIndex((v) => v >= 240) * TICK;
  const t249 = curve.findIndex((v) => v >= 249.5) * TICK;
  check('reaches 240 u/s in ~0.4 s', t240 > 0.3 && t240 < 0.5, `t(240)=${f2(t240)}s, t(249.5)=${f2(t249)}s`);
  check('top speed exactly 250', Math.abs(curve[curve.length - 1] - 250) < 0.01, `${curve[curve.length - 1].toFixed(3)}`);

  // Friction stop
  const x0 = p.origin.x; let tStop = -1;
  run(p, 1.0, () => 0, (t) => { if (tStop < 0 && hspeed(p) === 0) tStop = t; });
  const dist = p.origin.x - x0;
  check('release stop time ~0.4 s', tStop > 0.35 && tStop < 0.47, `${f2(tStop)} s`);
  check('release stop distance ~40 u', dist > 36 && dist < 45, `${f2(dist)} u`);
}

console.log('\n# Counter-strafe');
{
  world();
  const p = spawn(0, 0, 0, 0);
  run(p, 1.0, () => IN_MOVERIGHT);
  const v0 = hspeed(p);
  let t85 = -1, t0 = -1;
  run(p, 0.5, () => IN_MOVELEFT, (t) => {
    const vr = p.velocity.z; // moving right = +z at yaw 0
    if (t85 < 0 && vr < 250 * 0.34) t85 = t;
    if (t0 < 0 && vr <= 0) t0 = t;
  });
  check('counter-strafe to accurate speed (<34%) in ~0.08 s', t85 > 0.05 && t85 < 0.11, `from ${f2(v0)}: <85 u/s after ${f2(t85 * 1000)} ms`);
  check('counter-strafe to standstill in ~0.12 s', t0 > 0.09 && t0 < 0.15, `${f2(t0 * 1000)} ms`);
}

console.log('\n# Jump');
{
  world();
  const p = spawn();
  const y0 = p.origin.y;
  let maxY = y0, air = 0, left = false, landT = -1;
  events.length = 0;
  run(p, 1.2, (t) => (t < TICK ? IN_JUMP : 0), (t) => {
    maxY = Math.max(maxY, p.origin.y);
    if (!p.onGround) { left = true; air += TICK; }
    else if (left && landT < 0) landT = t;
  });
  // Source applies StartGravity before CheckJumpButton's `+=`, so at 128 tick the apex is
  // 57 - g*dt*t/2 = 55.83 (54.66 at 64 tick), not the continuous 57.0.
  check('jump apex 55.8 u (Source @128 tick)', Math.abs(maxY - y0 - 55.83) < 0.05, `${(maxY - y0).toFixed(3)} u`);
  check('airtime ~0.74 s', air > 0.72 && air < 0.78, `${f2(air)} s`);
  check('jump + land events', events.some((e) => e.ev === 'jump') && events.some((e) => e.ev === 'land'),
    `land fall speed ${f2(events.find((e) => e.ev === 'land')?.fallSpeed ?? 0)}`);
}

console.log('\n# Crate heights (run-up at 250, best jump timing)');
function tryCrate(h, crouch) {
  let best = false, bestTop = 0;
  for (let d = 4; d <= 120; d += 4) {
    world((cw) => cw.addBox(V(200, 0, -64), V(264, h, 64), 'crate'));
    const p = spawn(-300, 0, 0, 0);
    run(p, 0.8, () => IN_FORWARD);          // accelerate to 250
    let jumped = false, jumpTick = -1;
    run(p, 1.6, (t, i) => {
      let b = IN_FORWARD;
      const edge = 200 - 16;
      if (!jumped && p.origin.x >= edge - d) { jumped = true; jumpTick = i; b |= IN_JUMP; }
      if (crouch && jumped) b |= IN_DUCK;
      return b;
    });
    const onTop = p.origin.y > h - 1 && p.origin.x > 200 - 16;
    if (onTop) { best = true; bestTop = p.origin.y; break; }
    void jumpTick;
  }
  return { ok: best, top: bestTop };
}
{
  const cases = [[55.5, false, true], [56, false, false], [64, false, false], [64, true, true], [65, true, true], [66.5, true, false]];
  for (const [h, crouch, expect] of cases) {
    const r = tryCrate(h, crouch);
    check(`${crouch ? 'crouch-jump' : 'standing jump'} onto ${h}u ${expect ? 'succeeds' : 'fails'}`, r.ok === expect, r.ok ? `landed at y=${f2(r.top)}` : 'could not get up');
  }
}

console.log('\n# Stairs and steps');
{
  // 8u rise x 16u run staircase, 12 steps, then a landing
  world((cw) => { for (let i = 0; i < 12; i++) cw.addBox(V(300 + i * 16, 0, -64), V(900, 8 * (i + 1), 64), 'concrete'); });
  const p = spawn(-100, 0, 0, 0);
  run(p, 0.8, () => IN_FORWARD);
  const x0 = p.origin.x; let minV = 999, maxDy = 0, lastY = p.origin.y, airTicks = 0;
  run(p, 2.4, () => IN_FORWARD, () => {
    minV = Math.min(minV, hspeed(p)); maxDy = Math.max(maxDy, p.origin.y - lastY); lastY = p.origin.y;
    if (!p.onGround) airTicks++;
  });
  const avg = (p.origin.x - x0) / 2.4;
  check('climbs 8u stairs without losing speed', avg > 245 && p.origin.y >= 95.9, `avg ${f2(avg)} u/s, min ${f2(minV)}, top y=${f2(p.origin.y)}, air ticks ${airTicks}`);
  check('stairs: grounded the whole way', airTicks === 0, `${airTicks} airborne ticks`);

  for (const [h, expect] of [[18, true], [18.5, false]]) {
    world((cw) => cw.addBox(V(100, 0, -64), V(400, h, 64), 'concrete'));
    const q = spawn(-100, 0, 0, 0);
    run(q, 1.2, () => IN_FORWARD);
    const up = q.origin.y > h - 0.5;
    check(`single ${h}u step ${expect ? 'is stepped' : 'blocks'}`, up === expect, `y=${f2(q.origin.y)} x=${f2(q.origin.x)}`);
  }
}

console.log('\n# Slopes');
for (const [deg, walkable] of [[30, true], [40, true], [45, true], [46, false], [50, false]]) {
  const len = 400, h = Math.tan(deg * Math.PI / 180) * len;
  world((cw) => { cw.addWedge(V(100, 0, -128), V(100 + len, h, 128), 'x', 1, 'sand'); cw.addBox(V(100 + len, 0, -128), V(100 + len + 400, h, 128), 'sand'); });
  const p = spawn(-100, 0, 0, 0);
  let maxY = 0, groundedOnSlope = 0, slopeTicks = 0;
  run(p, 4, () => IN_FORWARD, () => {
    maxY = Math.max(maxY, p.origin.y);
    if (p.origin.x > 110 && p.origin.x < 100 + len - 20) { slopeTicks++; if (p.onGround) groundedOnSlope++; }
  });
  if (walkable) check(`${deg}° ramp is walkable`, p.origin.y > h - 1 && groundedOnSlope / Math.max(1, slopeTicks) > 0.97, `top y=${f2(p.origin.y)} of ${f2(h)}, grounded ${groundedOnSlope}/${slopeTicks}`);
  else check(`${deg}° ramp is not walkable`, maxY < 60, `max y=${f2(maxY)}`);
}
{
  // sliding: drop onto a 50° slope, must slide down and never count as grounded on it
  const len = 300, h = Math.tan(50 * Math.PI / 180) * len;
  world((cw) => cw.addWedge(V(0, 0, -128), V(len, h, 128), 'x', 1, 'rock'));
  const p = new Player({ team: 'T' }); World.entities.push(p);
  p.origin.set(150, h * 0.5 + 40, 0);
  let grounded = 0;
  run(p, 1.5, () => 0, () => { if (p.onGround && p.origin.x > 5) grounded++; });
  check('slides down a 50° slope', p.origin.x < 20 && p.origin.y < 25, `ended x=${f2(p.origin.x)} y=${f2(p.origin.y)}, grounded-on-slope ticks ${grounded}`);
}

console.log('\n# Air strafing');
{
  function strafeJump(turn) {
    world();
    const p = spawn(0, 0, 0, 0);
    run(p, 0.8, () => IN_FORWARD);
    let yaw = 0, sp0 = 0, left = false, landed = false, spMax = 0;
    run(p, 1.2, (t, i) => {
      if (i === 0) { sp0 = hspeed(p); return { buttons: IN_FORWARD | IN_JUMP, yaw }; }
      if (landed) return { buttons: 0, yaw };
      if (turn) {
        // TAS-optimal: keep wishdir (view-left) at the angle where AirAccelerate adds the most
        const vang = Math.atan2(-p.velocity.z, p.velocity.x) * 180 / Math.PI;
        const v = hspeed(p), add = 12 * 250 * TICK * (p.surfaceFriction);
        const cosT = Math.min(1, Math.max(0, (30 - add) / v));
        const theta = Math.acos(cosT) * 180 / Math.PI; // angle between velocity and wishdir
        yaw = vang - 90 + theta;                      // wishdir = yaw + 90 (left)
        return { buttons: IN_MOVELEFT, yaw };
      }
      return { buttons: IN_MOVELEFT, yaw };
    }, () => { if (!p.onGround) left = true; else if (left) landed = true; spMax = Math.max(spMax, hspeed(p)); });
    return { sp0, sp1: spMax };
  }
  const a = strafeJump(true), b = strafeJump(false);
  check('air-strafe with mouse turn gains speed', a.sp1 - a.sp0 > 40, `${f2(a.sp0)} -> ${f2(a.sp1)} u/s`);
  check('strafe without turning gains ~nothing', b.sp1 - b.sp0 < 3, `${f2(b.sp0)} -> ${f2(b.sp1)} u/s`);
}

console.log('\n# Corners, door frames, prisms, wedges');
{
  // 48u door frame in a wall at x=200..216; approach at 30° off-axis from the side
  world((cw) => {
    cw.addBox(V(200, 0, -1000), V(216, 128, -24), 'plaster');
    cw.addBox(V(200, 0, 24), V(216, 128, 1000), 'plaster');
  });
  const p = spawn(0, 0, 160, 0);
  // fixed heading that clips the door-frame corner; the slide must carry us through
  let stuckTicks = 0;
  const yawDoor = Math.atan2(160, 300) * 180 / Math.PI;
  run(p, 3, () => ({ buttons: IN_FORWARD, yaw: yawDoor }), () => { if (gameMovement.stuckAt(p.origin, p.ducked)) stuckTicks++; });
  check('slides through a 48u door frame', p.origin.x > 260, `x=${f2(p.origin.x)} z=${f2(p.origin.z)} stuck ticks ${stuckTicks}`);

  // acute corner (30° wedge of prism walls): push into it, then back out
  world((cw) => {
    cw.addPrism([{ x: 0, z: 0 }, { x: 600, z: -346 }, { x: 600, z: -400 }, { x: 0, z: -60 }], 0, 200, 'brick');
    cw.addPrism([{ x: 0, z: 0 }, { x: 600, z: 346 }, { x: 600, z: 400 }, { x: 0, z: 60 }], 0, 200, 'brick');
  });
  const q = spawn(400, 0, 0, 180);
  let bad = 0;
  run(q, 2, () => ({ buttons: IN_FORWARD | IN_MOVELEFT, yaw: 180 }), () => { if (gameMovement.stuckAt(q.origin, q.ducked)) bad++; });
  const xIn = q.origin.x;
  run(q, 1, () => ({ buttons: IN_BACK, yaw: 180 }));
  check('acute prism corner: no stuck, backs out', bad === 0 && q.origin.x > xIn + 100, `wedged at x=${f2(xIn)}, backed to ${f2(q.origin.x)}`);

  // slide along a 30°-diagonal wall at 45° incidence: speed must stay steady (no sticking)
  world((cw) => cw.addPrism([{ x: -2000, z: 1154 }, { x: 2000, z: -1154 }, { x: 2000, z: -1400 }, { x: -2000, z: 900 }], 0, 200, 'plaster'));
  const r = spawn(-600, 0, 0, 0);
  const wallYaw = 30; // wall direction heading (+x, -z)
  // heading 45° into the wall (wall lies to the +z side); Source equilibrium along the wall:
  // v = v*(1 - 5.2/128) + 5.5*250/128*cos45  ->  ~187 u/s
  let minS = 999, zeroTicks = 0, touching = 0;
  run(r, 1.5, () => ({ buttons: IN_FORWARD, yaw: wallYaw - 45 }));
  run(r, 2, () => ({ buttons: IN_FORWARD, yaw: wallYaw - 45 }), () => {
    const s2 = hspeed(r); minS = Math.min(minS, s2); if (s2 < 1) zeroTicks++;
    const d = -(r.origin.z - (-0.575 * r.origin.x - 250)) / Math.hypot(1, 0.575); if (d > 0 && d < 23) touching++; // north face
  });
  check('slides smoothly along a diagonal wall', zeroTicks === 0 && minS > 180 && minS < 195 && touching > 200,
    `min speed ${f2(minS)} (Source ~187), zero-speed ticks ${zeroTicks}, touching ${touching}/256`);
}
{
  // fuzz: random inputs in a cluttered room of boxes / prisms / wedges / crates
  const rng = (() => { let a = 1234567; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  world((cw) => {
    cw.addBox(V(-600, 0, -620), V(600, 300, -600), 'plaster'); cw.addBox(V(-600, 0, 600), V(600, 300, 620), 'plaster');
    cw.addBox(V(-620, 0, -600), V(-600, 300, 600), 'plaster'); cw.addBox(V(600, 0, -600), V(620, 300, 600), 'plaster');
    for (let i = 0; i < 18; i++) {
      const x = -500 + rng() * 1000, z = -500 + rng() * 1000, s = 20 + rng() * 60, h = 20 + rng() * 90;
      const k = i % 4;
      if (k === 0) cw.addBox(V(x, 0, z), V(x + s, h, z + s), 'crate');
      else if (k === 1) cw.addOrientedBox(V(x, h / 2, z), V(s, h / 2, s * 0.4), rng() * 180, 'brick');
      else if (k === 2) cw.addWedge(V(x, 0, z), V(x + s * 2, h * 0.6, z + s), rng() < 0.5 ? 'x' : 'z', rng() < 0.5 ? 1 : -1, 'sand');
      else cw.addPrism([{ x, z }, { x: x + s, z: z + s * 0.3 }, { x: x + s * 0.6, z: z + s }], 0, h, 'rock');
    }
    cw.addBox(V(-200, 60, 200), V(0, 80, 400), 'metal'); // low ceiling
  });
  let stuckEvents = 0, nan = 0, totalTicks = 0, maxStuck = 0;
  for (let trial = 0; trial < 40; trial++) {
    const p = new Player({ team: 'T' }); World.entities.length = 0; World.entities.push(p);
    p.origin.set(-400 + rng() * 800, 150, -400 + rng() * 800);
    p.yaw = rng() * 360;
    let held = 0, yaw = p.yaw, run1 = 0;
    run(p, 4, (t, i) => {
      if (i % 20 === 0) {
        held = [IN_FORWARD, IN_BACK, IN_MOVELEFT, IN_MOVERIGHT, IN_FORWARD | IN_MOVELEFT, IN_FORWARD | IN_MOVERIGHT][Math.floor(rng() * 6)];
        if (rng() < 0.3) held |= IN_JUMP; if (rng() < 0.25) held |= IN_DUCK; if (rng() < 0.15) held |= IN_SPEED;
      }
      yaw += (rng() - 0.5) * 6;
      return { buttons: held, yaw };
    }, () => {
      totalTicks++;
      if (!Number.isFinite(p.origin.x + p.origin.y + p.origin.z)) nan++;
      if (gameMovement.stuckAt(p.origin, p.ducked)) { stuckEvents++; run1++; maxStuck = Math.max(maxStuck, run1); } else run1 = 0;
    });
  }
  check('fuzz: never embedded in solid after a tick', stuckEvents === 0 && nan === 0, `${stuckEvents} stuck ticks (longest ${maxStuck}), ${nan} NaN, ${totalTicks} ticks`);
}

console.log('\n# Ducking');
{
  // 60u-high tunnel: must crouch to enter; can't stand up inside
  world((cw) => cw.addBox(V(200, 60, -200), V(600, 100, 200), 'concrete'));
  const p = spawn(0, 0, 0, 0);
  run(p, 1.5, () => IN_FORWARD);
  check('standing player blocked by 60u ceiling', p.origin.x < 200 - 15, `x=${f2(p.origin.x)}`);
  run(p, 2.0, () => IN_FORWARD | IN_DUCK, () => {});
  const inside = p.origin.x > 250 && p.origin.x < 550;
  const x1 = p.origin.x;
  check('crouched player walks in under it', inside || p.origin.x > 200, `x=${f2(x1)} ducked=${p.ducked}`);
  // release duck while inside
  world((cw) => cw.addBox(V(200, 60, -200), V(600, 100, 200), 'concrete'));
  const q = spawn(0, 0, 0, 0);
  run(q, 0.5, () => IN_DUCK);
  run(q, 3.0, (t) => (t < 3.0 ? IN_FORWARD | IN_DUCK : 0));
  const xs = q.origin.x;
  run(q, 0.6, () => 0);
  check('cannot unduck under the ceiling', q.ducked && q.duckAmount === 1 && q.origin.x > 200, `x=${f2(xs)} ducked=${q.ducked} amount=${q.duckAmount}`);
  run(q, 6.0, () => IN_FORWARD);
  check('unducks after leaving the tunnel', !q.ducked && q.duckAmount === 0 && q.origin.x > 600, `x=${f2(q.origin.x)} ducked=${q.ducked}`);
}
{
  world();
  const p = spawn();
  const eyes = [];
  run(p, 0.5, () => IN_DUCK, () => eyes.push(p.eyeHeight));
  const t46 = eyes.findIndex((e) => e <= 46.001) * TICK;
  let maxStep = 0; for (let i = 1; i < eyes.length; i++) maxStep = Math.max(maxStep, Math.abs(eyes[i] - eyes[i - 1]));
  check('duck eye 64 -> 46 in ~0.2 s, smooth', t46 > 0.15 && t46 < 0.3 && maxStep < 1.2, `t=${f2(t46)}s, max step ${f2(maxStep)} u/tick`);
  run(p, 0.5, () => 0);
  // speeds
  world(); const w = spawn();
  run(w, 1.5, () => IN_FORWARD | IN_SPEED);
  check('shift-walk speed 130', Math.abs(hspeed(w) - 130) < 0.5, f2(hspeed(w)));
  run(w, 1.5, () => IN_FORWARD | IN_DUCK);
  check('crouch-walk speed 85', Math.abs(hspeed(w) - 85) < 0.5, f2(hspeed(w)));
  run(w, 1.5, () => IN_FORWARD | IN_DUCK | IN_SPEED);
  check('crouch+shift speed 85', Math.abs(hspeed(w) - 85) < 0.5, f2(hspeed(w)));
  w.active = { def: { maxSpeed: 200 } };
  run(w, 1.5, () => IN_FORWARD);
  check('AWP-speed weapon runs 200', Math.abs(hspeed(w) - 200) < 0.5, f2(hspeed(w)));
  w.active = null;
  // duck spam penalty
  world(); const s = spawn();
  run(s, 2.0, (t) => ((Math.floor(t / 0.1) % 2) ? IN_DUCK : 0));
  check('duck spam lowers duck speed', s.duckSpeed < 5, `duckSpeed ${f2(s.duckSpeed)}`);
}
{
  // crouch-jump eye continuity: eye world-Y must not jump when the hull shifts in air
  world();
  const p = spawn();
  let maxJump = 0, last = p.origin.y + p.eyeHeight;
  run(p, 1.0, (t) => (t < TICK ? IN_JUMP : (t > 0.15 ? IN_DUCK : 0)), () => {
    const e = p.origin.y + p.eyeHeight; maxJump = Math.max(maxJump, Math.abs(e - last)); last = e;
  });
  check('in-air duck keeps the eye continuous', maxJump < 3.5, `max eye delta/tick ${f2(maxJump)} u`);
}

console.log('\n# Stamina, falling, footsteps');
{
  world();
  const p = spawn();
  let y0 = p.origin.y, max1 = 0, max2 = 0, phase = 0, left = false;
  run(p, 2.0, (t, i) => {
    if (i === 0) return IN_JUMP;
    if (phase === 1 && p.onGround) { phase = 2; return IN_JUMP; }
    return 0;
  }, () => {
    if (phase === 0) { max1 = Math.max(max1, p.origin.y - y0); if (!p.onGround) left = true; else if (left) phase = 1; }
    else if (phase === 2) max2 = Math.max(max2, p.origin.y - y0);
  });
  check('chained jump is lower (CS:GO stamina)', max2 < max1 - 10 && max2 > 25, `first ${f2(max1)} u, immediate re-jump ${f2(max2)} u`);

  world((cw) => cw.addBox(V(-100, 0, -100), V(100, 300, 100), 'concrete'));
  const q = spawn(0, 300, 0, 0);
  events.length = 0;
  run(q, 0.6, () => IN_FORWARD);
  run(q, 2.0, () => 0);
  const dmg = events.filter((e) => e.ev === 'damage').reduce((s, e) => s + e.amount, 0);
  const land = events.find((e) => e.ev === 'land');
  check('fall damage from 300u ~30 hp', dmg >= 25 && dmg <= 38, `${dmg} hp (fall speed ${f2(land?.fallSpeed ?? 0)})`);

  world();
  const r = spawn();
  run(r, 0.6, () => IN_FORWARD);
  events.length = 0;
  run(r, 3.0, () => IN_FORWARD);
  const runSteps = events.filter((e) => e.ev === 'footstep').length;
  events.length = 0;
  run(r, 0.6, () => IN_FORWARD | IN_SPEED);
  events.length = 0;
  run(r, 3.0, () => IN_FORWARD | IN_SPEED);
  const walkSteps = events.filter((e) => e.ev === 'footstep').length;
  run(r, 0.6, () => IN_FORWARD | IN_DUCK | IN_SPEED);
  events.length = 0;
  run(r, 3.0, () => IN_FORWARD | IN_DUCK);
  const duckSteps = events.filter((e) => e.ev === 'footstep' && e.kind === 'step').length;
  check('running footsteps every 0.3 s', runSteps >= 9 && runSteps <= 11, `${runSteps} in 3 s`);
  check('shift-walk / crouch-walk silent', walkSteps === 0 && duckSteps === 0, `walk ${walkSteps}, crouch ${duckSteps}`);

  // landing sound thresholds (Mapper's Reference @128 tick: jump onto >=11u block silent,
  // run off <=46u silent)
  function landVel(setup) { events.length = 0; setup(); const e = events.filter((x) => x.ev === 'land').pop(); return e?.fallSpeed ?? 0; }
  const onto = (h) => landVel(() => {
    world((cw) => cw.addBox(V(-400, 0, -400), V(400, h, 400), 'crate'));
    const s = new Player({ team: 'T' }); World.entities.push(s); s.origin.set(-900, 0, 0);
    run(s, 0.1, () => 0);
    let j = false;
    run(s, 3, () => { let b = IN_FORWARD; if (!j && s.origin.x > -416 - 100) { j = true; b |= IN_JUMP; } return b; });
  });
  const off = (h) => landVel(() => {
    world((cw) => cw.addBox(V(-400, 0, -400), V(0, h, 400), 'crate'));
    const s = new Player({ team: 'T' }); World.entities.push(s); s.origin.set(-50, h, 0);
    run(s, 0.1, () => 0);
    run(s, 1.5, () => IN_FORWARD | IN_SPEED);
  });
  const T = World.cvar.sv_land_sound_speed;
  const a10 = onto(10), a11 = onto(11), b46 = off(46), b47 = off(47);
  if (VERBOSE) console.log(`   land speeds: jump onto 10u ${f2(a10)}, 11u ${f2(a11)}; walk off 46u ${f2(b46)}, 47u ${f2(b47)}; threshold ${T}`);
  check('silent landing thresholds match CS:GO (128 tick)', a10 >= T && a11 < T && b46 < T && b47 >= T,
    `onto10 ${f2(a10)} onto11 ${f2(a11)} off46 ${f2(b46)} off47 ${f2(b47)} (T=${T})`);
}

console.log('\n# Ladder');
{
  world((cw) => {
    cw.addBox(V(200, 0, -200), V(232, 400, 200), 'concrete');
    cw.addBox(V(196, 0, -24), V(200, 300, 24), 'metal', CONTENTS_PLAYERCLIP | CONTENTS_LADDER);
  });
  const p = spawn(100, 0, 0, 0);
  let maxVy = 0;
  run(p, 1.0, () => IN_FORWARD, () => { maxVy = Math.max(maxVy, p.velocity.y); });
  check('climbs a ladder at ~200 u/s', p.origin.y > 80 && maxVy > 180 && maxVy < 260, `y=${f2(p.origin.y)}, max vy ${f2(maxVy)}, movetype ${p.moveType}`);
  run(p, 0.1, () => IN_JUMP);
  check('jumping off the ladder pushes away', p.moveType === 'walk' && p.velocity.x < -150, `vx=${f2(p.velocity.x)}`);
}

console.log('\n# Players');
{
  world();
  const a = spawn(0, 0, 0, 0), b = spawn(100, 0, 0, 180);
  run(a, 1, () => IN_FORWARD);
  check('players block each other', a.origin.x < 100 - 31.9 && a.origin.x > 60, `a.x=${f2(a.origin.x)}`);
  const c = new Player({ team: 'T' }); World.entities.push(c); c.origin.set(100, 150, 0);
  run(c, 1.2, () => 0);
  check('can stand on a head', Math.abs(c.origin.y - 72) < 0.2 && c.onGround && c.groundEntity === b, `y=${f2(c.origin.y)}`);
  // damage model
  const v = new Player({ team: 'CT' }); v.armor = 100; v.helmet = false;
  v.takeDamage({ amount: 36, hitgroup: 1, armorPen: 0.775 });
  check('AK headshot without helmet = 144 (dead)', !v.alive, `health ${v.health}`);
  const w = new Player({ team: 'CT' }); w.armor = 100; w.helmet = true;
  w.takeDamage({ amount: 36, hitgroup: 1, armorPen: 0.775 });
  check('AK headshot vs helmet = 111 (dead)', !w.alive);
  const x = new Player({ team: 'CT' }); x.armor = 100;
  x.takeDamage({ amount: 36, hitgroup: 2, armorPen: 0.775 });
  check('AK chest vs kevlar = 27', x.health === 100 - 27 && x.armor === 100 - 4, `hp ${x.health} armor ${x.armor}`);
  const y = new Player({ team: 'CT' }); y.origin.set(500, 0, 0);
  const hit = y.rayHit(V(0, 64 + 1.5, 0), V(1, 0, 0), 1000);
  check('fallback hitbox: head shot at eye level', hit && hit.hitgroup === 1 && Math.abs(hit.t - (500 - 5.2)) < 0.5, hit ? `t=${f2(hit.t)} hg=${hit.hitgroup}` : 'miss');
  const hit2 = y.rayHit(V(0, 20, 0), V(1, 0, 0), 1000);
  check('fallback hitbox: leg shot', hit2 && (hit2.hitgroup === 6 || hit2.hitgroup === 7), hit2 ? `hg=${hit2.hitgroup}` : 'miss');
}

console.log('\n# Render interpolation (144/165 Hz display, 128 Hz ticks)');
{
  world();
  World.camera = new THREE.PerspectiveCamera(74, 16 / 9, 1, 12000);
  World.input = { pitch: 0, yaw: 0 };
  const p = new Player({ team: 'T', isLocal: true });
  World.entities.push(p);
  p.origin.set(0, 0, 0);
  run(p, 1.0, () => IN_FORWARD);
  for (const hz of [144, 165, 60]) {
    let acc = 0, lastX = null, maxErr = 0, jitterSeed = 1;
    const deltas = [];
    for (let f = 0; f < 400; f++) {
      let dt = 1 / hz;
      jitterSeed = (jitterSeed * 16807) % 2147483647;
      dt += ((jitterSeed / 2147483647) - 0.5) * 0.0006; // +-0.3 ms vsync noise
      acc += dt;
      while (acc >= TICK) { World.time += TICK; p.runCommand(makeCmd(p, IN_FORWARD, 0), TICK); acc -= TICK; }
      const alpha = acc / TICK;
      World.frame++; p.frame(dt, alpha);
      const x = World.camera.position.x;
      if (lastX !== null) { const err = Math.abs((x - lastX) - 250 * dt); maxErr = Math.max(maxErr, err); deltas.push(x - lastX); }
      lastX = x;
    }
    check(`camera motion smooth at ${hz} Hz`, maxErr < 0.01, `max per-frame error ${maxErr.toFixed(5)} u (step ${f2(250 / hz)} u)`);
  }
  // stair smoothing: an 18u step must not pop the camera in one frame
  world((cw) => cw.addBox(V(100, 0, -200), V(600, 18, 200), 'concrete'));
  p.origin.set(0, 0, 0); p.velocity.set(0, 0, 0); p._snapInterp();
  run(p, 0.1, () => 0);
  let acc = 0, lastY = null, maxDy = 0;
  for (let f = 0; f < 200; f++) {
    const dt = 1 / 144; acc += dt;
    while (acc >= TICK) { World.time += TICK; p.runCommand(makeCmd(p, IN_FORWARD, 0), TICK); acc -= TICK; }
    World.frame++; p.frame(dt, acc / TICK);
    const y = World.camera.position.y;
    if (lastY !== null) maxDy = Math.max(maxDy, y - lastY);
    lastY = y;
  }
  check('18u step: camera rises smoothly (<= 150 u/s)', maxDy < 150 / 144 + 0.05 && lastY > 18 + 63, `max rise/frame ${f2(maxDy)} u, final eye ${f2(lastY)}`);
  World.camera = null; World.input = null;
}

console.log('\n# Real de_dust2 collision (random walkers)');
try {
  const { buildDust2 } = await import('../src/map/dust2.js');
  const map = await buildDust2({ textures: null, props: null });
  World.collision = map.collision; World.entities.length = 0;
  let seed = 4242; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const spawns = [...map.spawns.T, ...map.spawns.CT];
  const ps = spawns.slice(0, 10).map((s, i) => { const p = new Player({ team: i % 2 ? 'CT' : 'T' }); p.respawn(s); World.entities.push(p); p._b = IN_FORWARD; p._y = s.yaw; return p; });
  let bad = 0, nan = 0, ticks = 0;
  const t0 = performance.now();
  for (let i = 0; i < 128 * 15; i++) {
    World.time += TICK;
    for (const p of ps) {
      if (i % 40 === 0) { p._b = [IN_FORWARD, IN_FORWARD | IN_MOVELEFT, IN_FORWARD | IN_MOVERIGHT, IN_BACK][Math.floor(rnd() * 4)] | (rnd() < 0.25 ? IN_JUMP : 0) | (rnd() < 0.2 ? IN_DUCK : 0); if (rnd() < 0.3) p._y += (rnd() - 0.5) * 180; }
      p._y += (rnd() - 0.5) * 4;
      p.runCommand(makeCmd(p, p._b, p._y), TICK); ticks++;
      if (!Number.isFinite(p.origin.x + p.origin.y + p.origin.z)) nan++;
      if (gameMovement.stuckAt(p.origin, p.ducked) || p.origin.y < -1500) bad++;
    }
  }
  const us = (performance.now() - t0) / ticks * 1000;
  check('real map: 10 walkers x 15 s, never embedded / out of world', bad === 0 && nan === 0, `${ticks} player-ticks, ${us.toFixed(1)} us per player-tick, ${map.collision.brushes.length} brushes`);
} catch (err) {
  console.log(`  skip real-map fuzz (map did not build in node: ${err.message})`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
