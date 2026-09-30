// Node tests for the character module: analytic ray-vs-capsule, head hitbox coverage,
// pose sanity (feet on the ground, hands on the weapon, no NaNs), ragdoll settling.
//   node --import ./tools/three-resolve.mjs tools/charlab_test.mjs
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { rayCapsule, rayVsHitboxes } from '../src/player/hitboxes.js';
import { createCharacterModel } from '../src/player/character.js';
import { BONE, HAND_R, HAND_L } from '../src/player/models/skeleton.js';
import { CollisionWorld } from '../src/player/collision.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log('  FAIL', msg); } };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// ---- 1. analytic ray vs capsule --------------------------------------------------------------
{
  const A = V(0, 0, 0), B = V(0, 10, 0), r = 2;
  const dirX = V(1, 0, 0);
  ok(near(rayCapsule(V(-10, 5, 0), dirX, A, B, r), 8), 'side hit on cylinder body at t=8');
  ok(rayCapsule(V(-10, 5, 2.01), dirX, A, B, r) < 0, 'miss just past the radius');
  ok(near(rayCapsule(V(-10, 5, 1.99), dirX, A, B, r), 10 - Math.sqrt(4 - 1.99 * 1.99), 1e-3), 'graze inside radius');
  ok(near(rayCapsule(V(0, 30, 0), V(0, -1, 0), A, B, r), 18), 'from above hits the cap at y=12');
  ok(near(rayCapsule(V(0, -30, 0), V(0, 1, 0), A, B, r), 28), 'from below hits the cap at y=-2');
  ok(near(rayCapsule(V(-10, 11.5, 0), dirX, A, B, r), 10 - Math.sqrt(4 - 1.5 * 1.5), 1e-3), 'hits the top hemisphere off-axis');
  ok(rayCapsule(V(-10, 12.01, 0), dirX, A, B, r) < 0, 'miss just above the cap');
  ok(rayCapsule(V(10, 5, 0), dirX, A, B, r) < 0, 'capsule behind the ray');
  ok(rayCapsule(V(0, 5, 0.5), dirX, A, B, r) === 0, 'origin inside returns 0');
  const d = V(1, 1, 0).normalize();
  const t = rayCapsule(V(-20, -15, 0), d, A, B, r);
  const p = V(-20, -15, 0).addScaledVector(d, t);
  const cy = Math.max(0, Math.min(10, p.y));
  ok(t > 0 && near(Math.hypot(p.x, p.y - cy, p.z), r, 1e-3), 'diagonal hit lands on the surface');
}

// ---- 2. character: pose + head hitbox coverage -------------------------------------------------
function ent(o = {}) {
  return Object.assign({ alive: true, origin: V(0, 0, 0), velocity: V(0, 0, 0), yaw: 0, pitch: 0, onGround: true, duckAmount: 0,
    active: { def: { slot: 'primary' }, key: 'ak47' } }, o);
}
function settle(m, e, n = 60) { for (let i = 0; i < n; i++) { e.origin.addScaledVector(e.velocity, e.onGround ? 1 / 60 : 0); m.update(e, 1 / 60); } }
function worldOf(m, bone, ofs = V(0, 0, 0)) {
  const a = m.anim;
  return ofs.clone().applyQuaternion(a.Qm[bone]).add(a.Pm[bone]).applyQuaternion(m.rootQuat).add(m.root.position);
}
for (const team of ['T', 'CT']) {
  const m = createCharacterModel(team);
  const e = ent({ team, yaw: 0 });
  settle(m, e);
  const hb = m.worldHitboxes(e);
  const head = hb.find((h) => h.hitgroup === 1 && h.bone === BONE.head);
  const hc = head.a.clone().add(head.b).multiplyScalar(0.5);
  ok(hc.y > 62 && hc.y < 69, `${team} head centre height ${hc.y.toFixed(1)} near eye level`);
  // head shots from front / back / side / above must register as hitgroup 1
  const shots = [
    ['front', V(200, 0, 0), V(-1, 0, 0)], ['back', V(-200, 0, 0), V(1, 0, 0)],
    ['left side', V(0, 0, -200), V(0, 0, 1)], ['right side', V(0, 0, 200), V(0, 0, -1)],
  ];
  for (const [n, o, d] of shots) {
    const start = hc.clone().add(o);
    const r = rayVsHitboxes(hb, start, d, 1000);
    ok(r && r.hitgroup === 1, `${team} headshot from ${n} -> ${r?.hitgroup}`);
  }
  const top = rayVsHitboxes(hb, V(hc.x, 200, hc.z), V(0, -1, 0), 1000);
  ok(top && top.hitgroup === 1, `${team} headshot from above -> ${top?.hitgroup}`);
  // just past the ear (outside the visible head) must miss the head
  const earZ = team === 'CT' ? 5.9 : 4.9;
  const miss = rayVsHitboxes(hb, V(hc.x + 200, hc.y + 1.5, earZ), V(-1, 0, 0), 1000);
  ok(!miss || miss.hitgroup !== 1, `${team} ray just past the ear misses the head (got ${miss?.hitgroup})`);
  // body shot hits chest (from behind: from the front the support arm crosses the chest, as in CS)
  const chest = rayVsHitboxes(hb, V(-200, 52, 0), V(1, 0, 0), 1000);
  ok(chest && chest.hitgroup === 2, `${team} chest shot from behind -> ${chest?.hitgroup}`);
  const front = rayVsHitboxes(hb, V(200, 52, 0), V(-1, 0, 0), 1000);
  ok(front && (front.hitgroup === 2 || front.hitgroup === 4 || front.hitgroup === 5), `${team} chest shot from front hits chest or arm -> ${front?.hitgroup}`);
  const stom = rayVsHitboxes(hb, V(-200, 44, 0), V(1, 0, 0), 1000);
  ok(stom && stom.hitgroup === 3, `${team} stomach shot from behind -> ${stom?.hitgroup}`);
  const leg = rayVsHitboxes(hb, V(200, 14, 4.5), V(-1, 0, 0), 1000);
  ok(leg && leg.hitgroup === 7, `${team} right shin -> ${leg?.hitgroup}`);
  ok(!rayVsHitboxes(hb, V(200, 80, 0), V(-1, 0, 0), 1000), `${team} ray over the head misses everything`);

  // feet on the ground, hands at the weapon grips
  for (const [label, o] of [['idle', {}], ['run', { velocity: V(250, 0, 0) }], ['crouch', { duckAmount: 1 }], ['strafe', { velocity: V(0, 0, 200) }],
    ['back', { velocity: V(-200, 0, 0) }], ['aim up', { pitch: -80 }], ['aim down', { pitch: 80 }], ['pistol', { active: { def: { slot: 'secondary' }, key: 'usp' } }]]) {
    const m2 = createCharacterModel(team);
    const e2 = ent({ team, ...o });
    let minFoot = Infinity, maxFoot = -Infinity, nan = false, maxHandErr = 0;
    for (let i = 0; i < 90; i++) {
      e2.origin.addScaledVector(e2.velocity, 1 / 60);
      m2.update(e2, 1 / 60);
      for (const q of m2.anim.Qm) if (!Number.isFinite(q.x + q.y + q.z + q.w)) nan = true;
      for (const s of ['L', 'R']) {
        const f = worldOf(m2, BONE['foot_' + s]);
        minFoot = Math.min(minFoot, f.y); maxFoot = Math.max(maxFoot, f.y);
      }
      // right grip centre vs weapon origin
      const g = worldOf(m2, BONE.hand_R, HAND_R.grip);
      const w = m2.anim.weaponPos.clone().applyQuaternion(m2.rootQuat).add(m2.root.position);
      maxHandErr = Math.max(maxHandErr, g.distanceTo(w));
    }
    ok(!nan, `${team} ${label}: no NaN rotations`);
    ok(minFoot > 2.0 && minFoot < 5.5, `${team} ${label}: lowest ankle ${minFoot.toFixed(2)} ~ on the ground`);
    ok(maxFoot < (label === 'run' ? 18 : 14), `${team} ${label}: ankle lift ${maxFoot.toFixed(1)}`);
    ok(maxHandErr < 1.5, `${team} ${label}: right hand on grip (err ${maxHandErr.toFixed(2)})`);
  }
}

// ---- 3. foot skating: planted foot must not move in world space ------------------------------------
{
  const m = createCharacterModel('T');
  const e = ent({ velocity: V(220, 0, 0) });
  settle(m, e, 120);
  let maxSlide = 0, prev = null, prevStance = false;
  for (let i = 0; i < 240; i++) {
    e.origin.addScaledVector(e.velocity, 1 / 120);
    m.update(e, 1 / 120);
    const f = worldOf(m, BONE.toe_L);
    const grounded = f.y < 2.2;
    if (prev && grounded && prevStance) maxSlide = Math.max(maxSlide, Math.hypot(f.x - prev.x, f.z - prev.z));
    prev = f; prevStance = grounded;
  }
  ok(maxSlide < 0.9, `run: planted toe slides at most ${maxSlide.toFixed(2)}u per 1/120 s (body moves ${(220 / 120).toFixed(2)})`);
}

// ---- 3b. foot IK: one foot on a step edge, the other drops to the floor below ---------------------
{
  const col = new CollisionWorld();
  col.addBox(V(-500, -64, -500), V(500, 0, 500));
  col.addBox(V(-60, 0, -100), V(0.5, 12, 100));
  World.collision = col;
  const m = createCharacterModel('T');
  const e = ent({ origin: V(0, 12, 0), yaw: 0 });
  settle(m, e, 90);
  const l = worldOf(m, BONE.foot_L), r = worldOf(m, BONE.foot_R);
  ok(l.y > 1.5 && l.y < 7, `foot IK: front (left) foot reaches the lower floor (ankle y ${l.y.toFixed(1)})`);
  ok(r.y > 13.5 && r.y < 19, `foot IK: back (right) foot stays on the step (ankle y ${r.y.toFixed(1)})`);
  World.collision = null;
}

// ---- 4. ragdoll settles on a stair step and sleeps ---------------------------------------------------
{
  const col = new CollisionWorld();
  col.addBox(V(-500, -64, -500), V(500, 0, 500));
  col.addBox(V(10, 0, -100), V(200, 16, 100));
  col.build?.();
  World.collision = col;
  const m = createCharacterModel('CT');
  const e = ent({ origin: V(0, 0, 0), yaw: 180 });
  settle(m, e);
  m.ragdoll(V(1, 0.2, 0).normalize(), 2, 2);
  let t = 0;
  while (!m.rag.asleep && t < 6) { m.update(e, 1 / 60); t += 1 / 60; }
  ok(m.rag.asleep, `ragdoll sleeps (t=${t.toFixed(2)}s)`);
  const ps = m.rag.p;
  const minY = Math.min(...ps.map((p) => p.y));
  const maxY = Math.max(...ps.map((p) => p.y));
  ok(minY > -0.5, `ragdoll stays above the floor (min y ${minY.toFixed(2)})`);
  ok(maxY < 30, `ragdoll collapsed (max y ${maxY.toFixed(1)})`);
  const onStep = ps.some((p) => p.x > 12 && p.y > 15);
  ok(onStep, 'part of the body rests on the step');
  let nan = false; for (const q of m.rag.Qm) if (!Number.isFinite(q.x + q.y + q.z + q.w)) nan = true;
  ok(!nan, 'ragdoll bone rotations finite');
  const hb = m.worldHitboxes(e);
  ok(hb.every((h) => Number.isFinite(h.a.x + h.b.y)), 'ragdoll hitboxes finite');
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
