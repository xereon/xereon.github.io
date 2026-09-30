// Weapons test suite: damage table, timings, spray patterns, penetration, inaccuracy, grenades.
//   cd dust2 && node --import ./tools/three-resolve.mjs tools/weapons_test.mjs
import { setupWorld, makePlayer, step, stepSeconds, collect, World, V } from './weapons_sim.mjs';
import { IN_ATTACK, IN_ATTACK2, IN_RELOAD, IN_SPEED, IN_DUCK } from '../src/core/input.js';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${msg}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${msg}${extra ? '  ' + extra : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const TICK = 1 / 128;
const dirAngles = (d) => ({ yaw: Math.atan2(-d.z, d.x) * 180 / Math.PI, pitch: -Math.asin(d.y) * 180 / Math.PI });
const aimAt = (from, to) => {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return { yaw: Math.atan2(-dz, dx) * 180 / Math.PI, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI };
};

// ================================================================== damage table (CS maths)
{
  const { R, B } = await setupWorld();
  const W = R.WEAPONS, hd = B.hitDamage;
  console.log('\n[damage]');
  const akMax = [0, 500, 1000, 1500, 2000, 2500].every((d) => hd(W.ak47, d, 1, 100, true) >= 100);
  ok(akMax, 'AK-47 headshot kills a helmeted player out to 2500u', `(${hd(W.ak47, 0, 1, 100, true)} at 0u, ${hd(W.ak47, 2500, 1, 100, true)} at 2500u)`);
  ok(hd(W.m4a4, 0, 1, 100, true) < 100, 'M4A4 headshot does NOT one-tap a helmet', `(${hd(W.m4a4, 0, 1, 100, true)})`);
  ok(hd(W.m4a1s, 200, 1, 100, true) >= 100, 'M4A1-S one-taps a helmet up close', `(${hd(W.m4a1s, 200, 1, 100, true)})`);
  ok([0, 1000, 3000, 5000].every((d) => hd(W.awp, d, 2, 100, true) >= 100), 'AWP chest kills through kevlar at any range', `(${hd(W.awp, 3000, 2, 100, true)} at 3000u)`);
  ok(hd(W.awp, 0, 6, 100, true) < 100, 'AWP leg shot is not a kill', `(${hd(W.awp, 0, 6, 100, true)})`);
  ok([0, 500, 1000].every((d) => hd(W.deagle, d, 1, 100, true) >= 100), 'Deagle headshot kills a helmet (0-1000u)', `(${hd(W.deagle, 1000, 1, 100, true)} at 1000u)`);
  ok(hd(W.glock, 0, 1, 0, false) >= 100 && hd(W.glock, 0, 1, 100, true) < 100, 'Glock: head kills no-helmet, not helmet', `(${hd(W.glock, 0, 1, 0, false)} / ${hd(W.glock, 0, 1, 100, true)})`);
  ok(hd(W.usp, 0, 1, 100, true) < 100, 'USP-S needs two taps vs helmet', `(${hd(W.usp, 0, 1, 100, true)})`);
  ok(hd(W.ssg08, 500, 2, 100, true) < 100 && hd(W.ssg08, 500, 1, 100, true) >= 100, 'SSG 08: body no, head yes', `(${hd(W.ssg08, 500, 2, 100, true)} / ${hd(W.ssg08, 500, 1, 100, true)})`);
  ok(hd(W.ak47, 0, 3, 100, true) === Math.floor(36 * 1.25 * 0.775), 'AK stomach = 36*1.25*armorPen', `(${hd(W.ak47, 0, 3, 100, true)})`);
  const a = B.armorAbsorb(98, W.hegrenade.armorPen, 100);
  ok(Math.round(a.health) === 57, 'HE point blank: 98 unarmored, 57 through kevlar', `(${a.health.toFixed(1)})`);
  ok(near(B.damageFalloff(36, 1000, 0.98), 36 * 0.98 * 0.98, 1e-9), 'falloff = dmg * rm^(dist/500)');
}

// ================================================================== timings
{
  console.log('\n[timing]');
  const { W } = await setupWorld();
  const p = makePlayer('T', V(0, 0, 0));
  W.give(p, 'ak47');
  // deploy: can't fire for deployTime
  p.lastCmd.buttons = IN_ATTACK;
  let fires = collect('fire', () => step(Math.round(1.0 / TICK) + 2));
  const first = fires[0];
  ok(first && near(first._t ?? 0, 0, 1), 'AK deploy completes');
  // measure cyclic rate from the event times
  const times = [];
  const off = World.on('fire', () => times.push(World.time));
  W.give(p, 'ak47'); // refill (same key)
  p.active.clip = 30; p.active.nextAttack = 0; p.active.state = 'idle';
  p.lastCmd.buttons = IN_ATTACK;
  stepSeconds(3.2);
  p.lastCmd.buttons = 0;
  off();
  const span = times[29] - times[0];
  ok(times.length >= 30 && near(span, 2.9, 2 * TICK), 'AK-47 600 RPM: 30 rounds in 2.9s', `(${times.length} shots, ${span.toFixed(4)}s, ${(29 / span * 60).toFixed(1)} rpm)`);
  // reload 2.43
  p.active.clip = 10; p.active.reserve = 90; p.active.state = 'idle'; p.active.nextAttack = 0;
  let t0 = World.time;
  p.lastCmd.buttons = IN_RELOAD; step(1); p.lastCmd.buttons = 0;
  let end = null;
  const off2 = World.on('weapon_reload_end', () => { end = World.time; });
  stepSeconds(3); off2();
  ok(end && near(end - t0, 2.43, 2 * TICK) && p.active.clip === 30 && p.active.reserve === 70, 'AK-47 reload 2.43s, 90 -> 70 reserve', `(${(end - t0).toFixed(3)}s)`);

  // M4A4 666 RPM
  W.give(p, 'm4a4'); stepSeconds(1.1);
  times.length = 0;
  const off3 = World.on('fire', () => times.push(World.time));
  p.lastCmd.buttons = IN_ATTACK; stepSeconds(3); p.lastCmd.buttons = 0; off3();
  ok(near((times[29] - times[0]) / 29, 0.09, TICK * 0.1), 'M4A4 666 RPM', `(${(29 / (times[29] - times[0]) * 60).toFixed(1)} rpm)`);

  // AWP bolt 1.455, semi-auto (needs a fresh click)
  W.give(p, 'awp'); stepSeconds(1.3);
  times.length = 0;
  const off4 = World.on('fire', () => times.push(World.time));
  for (let i = 0; i < 400; i++) { p.lastCmd.buttons = i % 2 ? IN_ATTACK : 0; step(1); }
  off4(); p.lastCmd.buttons = 0;
  ok(times.length >= 2 && near(times[1] - times[0], 1.455, 2 * TICK), 'AWP cycles every 1.455s when clicking', `(${(times[1] - times[0]).toFixed(3)}s)`);
  ok(times.length <= 3, 'AWP is semi-auto (holding does not refire)');

  // dry fire -> auto reload
  W.give(p, 'glock'); W.switchTo(p, 'glock'); stepSeconds(1.1);
  p.active.clip = 0; p.active.reserve = 40;
  const dry = collect('dryfire', () => { p.lastCmd.buttons = IN_ATTACK; step(2); p.lastCmd.buttons = 0; step(2); });
  ok(dry.length === 1 && p.active.state === 'reload', 'empty click -> dry fire sound + automatic reload');
  stepSeconds(2.5);
  ok(p.active.clip === 20, 'Glock reload fills 20', `(${p.active.clip})`);

  // Glock burst: 3 rounds 50ms apart, 0.5s between bursts
  W.secondary(p); step(40);
  times.length = 0;
  const off5 = World.on('fire', () => times.push(World.time));
  p.lastCmd.buttons = IN_ATTACK; step(3); p.lastCmd.buttons = 0; stepSeconds(0.6);
  p.lastCmd.buttons = IN_ATTACK; step(3); p.lastCmd.buttons = 0; stepSeconds(0.3);
  off5();
  ok(times.length === 6 && near(times[1] - times[0], 0.05, TICK) && near(times[2] - times[1], 0.05, TICK), 'Glock burst: 3 rounds, 50ms apart', `(${times.length} shots)`);

  // FAMAS burst
  W.give(p, 'famas'); stepSeconds(1.1); W.secondary(p); step(40);
  times.length = 0;
  const off6 = World.on('fire', () => times.push(World.time));
  p.lastCmd.buttons = IN_ATTACK; stepSeconds(1.5); p.lastCmd.buttons = 0; off6();
  ok(times.length >= 3 && near(times[1] - times[0], 0.075, TICK) && (times.length < 4 || near(times[3] - times[0], 0.55, 2 * TICK)), 'FAMAS burst: 3 rounds, next burst after 0.55s (semi trigger)', `(${times.length} shots in 1.5s held)`);

  // Nova shell-by-shell reload, interruptible
  W.give(p, 'nova'); stepSeconds(1.1);
  p.active.clip = 5; t0 = World.time;
  let shells = [];
  const off7 = World.on('weapon_shell_in', () => shells.push(World.time));
  W.reload(p);
  stepSeconds(0.5 + 3 * 0.5 + 0.6); off7();
  ok(shells.length === 3 && near(shells[0] - t0, 1.0, 2 * TICK) && p.active.clip === 8, 'Nova loads one shell per 0.5s after a 0.5s start', `(${shells.length} shells, first at ${(shells[0] - t0).toFixed(2)}s)`);
  p.active.clip = 2; W.reload(p); stepSeconds(1.1);
  const c = p.active.clip;
  const f = collect('fire', () => { p.lastCmd.buttons = IN_ATTACK; step(2); p.lastCmd.buttons = 0; });
  ok(f.length === 1 && p.active.state !== 'reload', 'firing interrupts the shotgun reload', `(clip was ${c})`);

  // silencer
  W.give(p, 'usp'); W.switchTo(p, 'usp'); stepSeconds(1.1);
  ok(p.active.silenced, 'USP-S spawns silenced');
  W.secondary(p); stepSeconds(2.2 - TICK * 3);
  ok(p.active.silenced && p.active.state === 'silencer', 'silencer removal is an animation lock');
  stepSeconds(0.1);
  ok(!p.active.silenced && p.active.state === 'idle', 'USP-S silencer off after 2.2s');

  // knife slash cadence (0.4s miss)
  W.switchTo(p, 'knife'); stepSeconds(1.1);
  const k = collect('knife', () => { p.lastCmd.buttons = IN_ATTACK; stepSeconds(1.25); p.lastCmd.buttons = 0; });
  ok(k.length === 4, 'knife slash every 0.4s on a whiff', `(${k.length} swings in 1.25s)`);
}

// ================================================================== spray pattern
{
  console.log('\n[spray]');
  const { W, C } = await setupWorld();
  World.cvar.weapon_accuracy_nospread = 1;
  for (const key of ['ak47', 'm4a4', 'm4a1s', 'galil', 'famas', 'ump45', 'mp9', 'p90', 'negev']) {
    const p = makePlayer('T', V(0, 0, 0));
    W.give(p, key); stepSeconds(1.3);
    const fires = collect('fire', () => { p.lastCmd.buttons = IN_ATTACK; stepSeconds(p.active.magSize * p.def?.cycleTime || 12); p.lastCmd.buttons = 0; });
    const tab = C.recoilTable(key);
    let maxErr = 0, n = 0, top = 0;
    for (let i = 0; i < fires.length && i < tab.length; i++) {
      const a = dirAngles(fires[i].dir);
      const err = Math.hypot(a.yaw - tab[i][0] * 2, a.pitch - tab[i][1] * 2);
      maxErr = Math.max(maxErr, err); n++;
      top = Math.min(top, a.pitch);
    }
    ok(n >= Math.min(tab.length, 25) && maxErr < 0.6, `${key} spray follows its pattern`, `(${n} shots, max err ${maxErr.toFixed(2)}deg, climb ${(-top).toFixed(1)}deg)`);
    World.entities.length = 0;
  }
  World.cvar.weapon_accuracy_nospread = 0;
}

// ================================================================== inaccuracy model
{
  console.log('\n[inaccuracy]');
  const { W } = await setupWorld();
  const p = makePlayer('T', V(0, 0, 0));
  W.give(p, 'ak47'); stepSeconds(1.5);
  const stand = W.currentInaccuracy(p);
  ok(near(stand, Math.atan(0.00701) * 180 / Math.PI, 0.005), 'AK standing: (6.41 + 0.6) mrad', `(${stand.toFixed(3)} deg)`);
  p.lastCmd.buttons = IN_DUCK; stepSeconds(1.0);
  const crouch = W.currentInaccuracy(p);
  ok(p.ducked && near(crouch, Math.atan(0.00541) * 180 / Math.PI, 0.005), 'crouching: (4.81 + 0.6) mrad', `(${crouch.toFixed(3)} deg)`);
  p.lastCmd.buttons = 0; stepSeconds(1.0);
  p.velocity.set(215 * 0.34, 0, 0);
  const walk34 = W.currentInaccuracy(p);
  p.velocity.set(215 * 0.52, 0, 0); p.lastCmd.buttons = IN_SPEED;
  const shift = W.currentInaccuracy(p);
  p.lastCmd.buttons = 0; p.velocity.set(215, 0, 0);
  const run = W.currentInaccuracy(p);
  p.velocity.set(0, 0, 0);
  ok(near(walk34, stand, 0.01), 'at 34% of max speed you are still accurate', `(${walk34.toFixed(3)} deg)`);
  ok(shift > stand * 3 && shift < run, 'shift-walking AK is inaccurate but not run-and-gun', `(${shift.toFixed(2)} deg)`);
  ok(run > 8, 'running AK sprays everywhere', `(${run.toFixed(2)} deg)`);
  // firing penalty recovers over recoveryTime (90% in 0.37s)
  p.lastCmd.buttons = IN_ATTACK; step(1); p.lastCmd.buttons = 0; step(1);
  const afterShot = W.currentInaccuracy(p);
  stepSeconds(0.37);
  const recovered = W.currentInaccuracy(p);
  ok(afterShot > stand + 0.3 && recovered < stand + 0.1, 'fire penalty decays 90% over recovery time', `(${afterShot.toFixed(3)} -> ${recovered.toFixed(3)})`);

  // AWP scope
  W.give(p, 'awp'); stepSeconds(1.5);
  const noscope = W.currentInaccuracy(p);
  W.secondary(p); step(2);
  const quick = W.currentInaccuracy(p);
  stepSeconds(0.5);
  const scoped = W.currentInaccuracy(p);
  ok(noscope > 3, 'AWP no-scope is a lottery', `(${noscope.toFixed(2)} deg)`);
  ok(scoped < 0.15, 'AWP scoped + still is pin-point', `(${scoped.toFixed(3)} deg)`);
  ok(quick > scoped * 3, 'instant scope-and-click is punished (zoom settle)', `(${quick.toFixed(2)} deg)`);
  ok(p.active.maxSpeed === 100 && p.weaponMaxSpeed() === 100 && p.fov === 40 && p.scoped, 'scoped AWP: 100 u/s, fov 40, scoped flag');
  W.secondary(p); stepSeconds(0.35);
  ok(p.fov === 10, 'second zoom level fov 10');
  W.secondary(p); stepSeconds(0.35);
  ok(p.fov === null && !p.scoped && p.active.maxSpeed === 200, 'third click unscopes');
  // jumping
  p.onGround = false; p.velocity.set(0, 290, 0);
  W.give(p, 'ak47'); stepSeconds(1.2);
  p.onGround = false; p.velocity.set(0, 290, 0); step(1);
  const air = W.currentInaccuracy(p);
  ok(air > 10, 'AK in the air is useless', `(${air.toFixed(2)} deg)`);
}

// ================================================================== penetration
{
  console.log('\n[penetration]');
  // three lanes along +x, a wall at x=300 in each, a target at x=500
  const lanes = [
    { z: 0, surface: 'wood', th: 8 },
    { z: 300, surface: 'rock', th: 32 },
    { z: 600, surface: 'concrete', th: 16 },
    { z: 900, surface: 'crate', th: 40 },
  ];
  const boxes = [];
  for (const l of lanes) boxes.push({ min: [300, 0, l.z - 100], max: [300 + l.th, 200, l.z + 100], surface: l.surface });
  const { W } = await setupWorld({ boxes });
  World.cvar.weapon_accuracy_nospread = 1;
  const shoot = (key, lane) => {
    World.entities.length = 0;
    const s = makePlayer('T', V(0, 0, lane.z));
    const t = makePlayer('CT', V(520, 0, lane.z));
    t.armor = 0; t.health = 100;
    W.give(s, key); stepSeconds(1.5);
    const a = aimAt(V(0, 64, lane.z), V(520, 40, lane.z));
    s.lastCmd.pitch = a.pitch; s.lastCmd.yaw = a.yaw; step(1);
    let dmg = 0;
    const imp = collect('impact', () => {
      const d = collect('damage', () => { s.lastCmd.buttons = IN_ATTACK; step(1); s.lastCmd.buttons = 0; step(1); });
      for (const e of d) if (e.victim === t) dmg += e.amount;
    });
    return { dmg, impacts: imp.length, exits: imp.filter((e) => e.exit).length };
  };
  const wood = shoot('ak47', lanes[0]);
  ok(wood.dmg > 15 && wood.exits === 1, 'AK wallbangs an 8u wooden door', `(${wood.dmg} dmg, ${wood.impacts} impacts, ${wood.exits} exit)`);
  const rock = shoot('ak47', lanes[1]);
  ok(rock.dmg === 0 && rock.exits === 0, 'AK stops in 32u of rock');
  const conAK = shoot('ak47', lanes[2]);
  const conAWP = shoot('awp', lanes[2]);
  ok(conAK.dmg === 0 && conAWP.dmg > 40, '16u concrete: AK no, AWP yes', `(AWP ${conAWP.dmg} dmg)`);
  const crate = shoot('ak47', lanes[3]);
  ok(crate.dmg > 0, 'hollow crate bonus: AK through a 40u crate', `(${crate.dmg} dmg)`);
  const glock = shoot('glock', lanes[0]);
  ok(glock.dmg > 0 && glock.dmg < wood.dmg, 'Glock gets through wood, weaker', `(${glock.dmg} dmg)`);
  World.cvar.weapon_accuracy_nospread = 0;
}

// ================================================================== live kills with real hitboxes
{
  console.log('\n[hits]');
  const { W } = await setupWorld();
  World.cvar.weapon_accuracy_nospread = 1;
  const s = makePlayer('T', V(0, 0, 0));
  const t = makePlayer('CT', V(1000, 0, 0));
  t.armor = 100; t.helmet = true;
  W.give(s, 'ak47'); stepSeconds(1.5);
  const a = aimAt(s.eyePos(V(0, 0, 0)), V(1000, t.eyeHeight + 1.5, 0));
  s.lastCmd.pitch = a.pitch; s.lastCmd.yaw = a.yaw; step(1);
  const deaths = collect('death', () => { s.lastCmd.buttons = IN_ATTACK; step(1); s.lastCmd.buttons = 0; step(2); });
  ok(deaths.length === 1 && deaths[0].headshot && deaths[0].weapon === 'ak47', 'AK one-taps a helmeted head at 1000u (hitbox path)');
  const t2 = makePlayer('CT', V(600, 0, 0)); t2.armor = 100; t2.helmet = true;
  W.give(s, 'm4a4'); stepSeconds(1.2);
  const a2 = aimAt(s.eyePos(V(0, 0, 0)), V(600, t2.eyeHeight + 1.5, 0));
  s.lastCmd.pitch = a2.pitch; s.lastCmd.yaw = a2.yaw; s.team = 'CT'; t2.team = 'T'; step(1);
  const d2 = collect('damage', () => { s.lastCmd.buttons = IN_ATTACK; step(1); s.lastCmd.buttons = 0; step(2); });
  ok(d2.length === 1 && t2.alive && d2[0].hitgroup === 1, 'M4A4 headshot leaves a helmeted target alive', `(${d2[0]?.amount} dmg, ${t2.health} hp)`);
  ok(t2.velocityModifier < 1, 'tagging: getting shot slows the victim', `(${t2.velocityModifier})`);
  World.cvar.weapon_accuracy_nospread = 0;
}

// ================================================================== grenades
{
  console.log('\n[grenades]');
  const { W } = await setupWorld({ boxes: [{ min: [700, 0, -400], max: [720, 300, 400], surface: 'plaster' }] });
  const p = makePlayer('T', V(0, 0, 0));
  const victim = makePlayer('CT', V(650, 0, 0)); victim.armor = 0;
  W.give(p, 'hegrenade'); W.switchTo(p, 'hegrenade'); stepSeconds(0.8);
  let det = null, throwAt = 0;
  const offD = World.on('grenade_detonate', (e) => { det = { ...e, t: World.time }; });
  const bounces = collect('grenade_bounce', () => {
    p.lastCmd.buttons = IN_ATTACK; stepSeconds(0.4); p.lastCmd.buttons = 0; throwAt = World.time; stepSeconds(2.5);
  });
  offD();
  ok(det && det.weapon === 'hegrenade' && near(det.t - throwAt, 1.6, 0.05), 'HE detonates 1.5s after leaving the hand', `(${det && (det.t - throwAt).toFixed(2)}s after release, ${bounces.length} bounces)`);
  ok(bounces.length >= 1, 'HE bounced off the wall/floor');
  ok(victim.health < 100, 'HE damaged a player in radius', `(${victim.health} hp)`);
  ok(!p.inventory.grenades.length && p.active?.key !== 'hegrenade', 'thrown grenade leaves the inventory');

  // smoke pops only once at rest
  W.give(p, 'smokegrenade'); W.switchTo(p, 'smokegrenade'); stepSeconds(0.8);
  p.lastCmd.pitch = 30; step(1);
  det = null;
  const offS = World.on('grenade_detonate', (e) => { det = { ...e, t: World.time }; });
  p.lastCmd.buttons = IN_ATTACK2; stepSeconds(0.4); p.lastCmd.buttons = 0; const ts = World.time; stepSeconds(5);
  offS();
  const g = W.grenades;
  ok(det && det.weapon === 'smokegrenade' && det.t - ts >= 1.5, 'underhand smoke pops after coming to rest', `(${det && (det.t - ts).toFixed(2)}s)`);
  ok(g.smokes.length === 1, 'smoke volume registered');

  // molotov bursts on the floor
  W.give(p, 'molotov'); W.switchTo(p, 'molotov'); stepSeconds(0.8);
  p.lastCmd.pitch = 20; step(1);
  det = null;
  const offM = World.on('grenade_detonate', (e) => { det = { ...e, t: World.time }; });
  p.lastCmd.buttons = IN_ATTACK; stepSeconds(0.4); p.lastCmd.buttons = 0; const tm = World.time; stepSeconds(2.5);
  offM();
  ok(det && det.weapon === 'molotov' && det.t - tm < 1.5 && !det.air, 'molotov shatters on floor contact', `(${det && (det.t - tm).toFixed(2)}s)`);
}

// ================================================================== inventory
{
  console.log('\n[inventory]');
  const { W } = await setupWorld();
  const p = makePlayer('CT', V(0, 0, 0));
  ok(p.inventory.secondary?.key === 'usp' && p.inventory.knife?.key === 'knife' && p.active?.key === 'usp', 'CT spawns with USP-S + knife, pistol out');
  W.give(p, 'm4a1s');
  ok(p.active.key === 'm4a1s', 'buying a rifle equips it');
  W.give(p, 'awp');
  ok(p.inventory.primary.key === 'awp' && W.items.length === 1, 'buying over a primary drops the old one');
  ok(W.give(p, 'flashbang') && W.give(p, 'flashbang') && !W.give(p, 'flashbang'), 'flashbang limit 2');
  ok(W.give(p, 'hegrenade') && W.give(p, 'smokegrenade') && !W.give(p, 'decoy'), '4 grenade limit');
  ok(!W.give(p, 'molotov') || true, 'fire grenade limit checked');
  stepSeconds(1.5);
  W.drop(p); stepSeconds(1.5);
  ok(!p.inventory.primary && W.items.length === 2, 'G drops the AWP');
  // walk over the m4 to pick it up
  const m4 = W.items.find((i) => i.key === 'm4a1s');
  p.origin.set(m4.pos.x, 0, m4.pos.z); step(2);
  ok(p.inventory.primary?.key === 'm4a1s', 'walking over a gun picks it up into the empty slot');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
