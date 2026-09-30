// Node sim: 5v5 bots headless. Synthetic mini-Dust by default; --real uses src/map/dust2.js and
// --full runs the real WeaponSystem + FX + MatchController (rounds, economy, bomb). --check makes
// it a pass/fail regression test.
//   node --import ./tools/three-resolve.mjs tools/ai_simtest.mjs [seconds] [difficulty|Tdiff,CTdiff] [--real] [--full] [--money=N] [--check]
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { CollisionWorld } from '../src/player/collision.js';
import { buildNavMeshSync } from '../src/ai/navmesh.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export function miniDust() {
  const cw = new CollisionWorld();
  const box = (a, b, s = 'concrete') => cw.addBox(V(...a), V(...b), s);
  box([-1600, -32, -1600], [1600, 0, 1600], 'sand');
  box([-1632, 0, -1632], [1632, 320, -1500]); box([-1632, 0, 1500], [1632, 320, 1632]);
  box([-1632, 0, -1500], [-1500, 320, 1500]); box([1500, 0, -1500], [1632, 320, 1500]);
  // buildings separating long | mid | tunnels, leaving strips at z -700..-560 (short / mid-to-B)
  box([300, 0, -560], [1100, 320, 900]);
  box([-1100, 0, -560], [-300, 320, 900]);
  // T spawn wall with three exits (long, mid, tunnels)
  box([-1100, 0, 1000], [-300, 200, 1040]); box([300, 0, 1000], [1100, 200, 1040]);
  // mid doors: a wall across mid with an offset 128u gap (breaks spawn-to-spawn LOS)
  box([-300, 0, -200], [-64, 220, -170]); box([64, 0, -200], [300, 220, -170]);
  box([-40, 0, -120], [140, 220, -90]);
  // CT spawn separated from the sites by walls with doorways
  box([-400, 0, -1500], [-360, 200, -1150]); box([360, 0, -1500], [400, 200, -1150]);
  // cover on the sites
  box([800, 0, -1250], [864, 64, -1186], 'crate'); box([900, 0, -1000], [964, 48, -936], 'crate');
  box([-900, 0, -1250], [-836, 64, -1186], 'crate'); box([-1000, 0, -950], [-936, 48, -886], 'crate');
  // stairs up to a raised catwalk in mid (not required, but exercised)
  for (let i = 0; i < 6; i++) box([100, 0, 400 - i * 24], [260, 12 * (i + 1), 424 - i * 24]);
  box([100, 0, -100], [260, 72, 280]);
  // a ramp in tunnels
  cw.addWedge(V(-1450, 0, 200), V(-1150, 48, 400), 'z', -1);
  box([-1450, 0, -100], [-1150, 48, 200]);
  cw.addWedge(V(-1450, 0, -300), V(-1150, 48, -100), 'z', 1);
  cw.build();
  const zone = (a, b, name) => ({ min: V(...a), max: V(...b), name });
  const spawns = { T: [], CT: [] };
  for (let i = 0; i < 5; i++) { spawns.T.push({ pos: V(-160 + i * 80, 0, 1300), yaw: 90 }); spawns.CT.push({ pos: V(-160 + i * 80, 0, -1350), yaw: 270 }); }
  return {
    collision: cw, spawns,
    bombsites: { A: zone([600, -10, -1450], [1400, 150, -800], 'A'), B: zone([-1400, -10, -1450], [-600, 150, -800], 'B') },
    callouts: {
      t_spawn: zone([-1500, -10, 1040], [1500, 200, 1500], 't_spawn'), ct_spawn: zone([-360, -10, -1500], [360, 200, -1150], 'ct_spawn'),
      long: zone([1100, -10, -800], [1500, 200, 1040], 'long'), mid: zone([-300, -10, -560], [300, 200, 1040], 'mid'),
      tunnels: zone([-1500, -10, -800], [-1100, 200, 1040], 'tunnels'), short: zone([300, -10, -800], [1100, 200, -560], 'short'),
      mid_to_b: zone([-1100, -10, -800], [-300, 200, -560], 'mid_to_b'),
      a_site: zone([400, -10, -1500], [1500, 200, -800], 'a_site'), b_site: zone([-1500, -10, -1500], [-400, 200, -800], 'b_site'),
    },
    walkable: new Float32Array(),
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('ai_simtest.mjs');
if (isMain) {
  const SECS = +(process.argv[2] || 90), DIFF = process.argv[3] || 'normal';
  const REAL = process.argv.includes('--real');
  const map = REAL ? await (await import('../src/map/dust2.js')).buildDust2({ textures: null, props: null }) : miniDust();
  World.map = map; World.collision = map.collision;
  const FULL = process.argv.includes('--full');
  const money = (process.argv.find((a) => a.startsWith('--money=')) || '').slice(8);
  World.params = new URLSearchParams(`botsim=${FULL ? 'rules' : '1'}&botdiff=${DIFF}&botfreeze=2${money ? `&botmoney=${money}` : ''}`);
  if (FULL) {
    // the real game modules, headless: movement, weapons/ballistics/grenades, fx (smoke/flash), rules
    const [{ WeaponSystem }, { FX }, { MatchController }] = await Promise.all([
      import('../src/weapons/system.js'), import('../src/fx/index.js'), import('../src/game/rules.js')]);
    World.weapons = new WeaponSystem();
    try { World.fx = new FX(); } catch (e) { console.log('fx unavailable', e.message); }
    World.match = new MatchController();
  }
  let t0 = performance.now();
  World.nav = buildNavMeshSync(map);
  console.log(`nav ${World.nav.count} nodes in ${(performance.now() - t0).toFixed(0)} ms`);
  const { BotManager } = await import('../src/ai/bot.js');
  t0 = performance.now();
  const mgr = new BotManager();
  World.bots = mgr;
  console.log(`intel ${(performance.now() - t0).toFixed(0)} ms`);
  for (const [n, s] of Object.entries(mgr.intel.sites)) {
    console.log(` site ${n}: T routes ${s.tRoutes.map((r) => `${r.name} (${r.length | 0}u, holds ${r.holds?.length})`).join(' | ')}; CT routes ${s.ctRoutes.map((r) => r.name).join(' | ')}`);
  }
  console.log(' mid hold', mgr.intel.mid?.hold ? mgr.intel.mid.hold.pos.toArray().map(Math.round) : null);
  await import('../src/ai/botsim.js');
  await mgr.ready;
  await new Promise((r) => setTimeout(r, 50)); // let the lazy botsim import settle
  World.emit('ready', {});
  const dt = 1 / 128;
  t0 = performance.now();
  for (let i = 0; i < SECS * 128; i++) {
    World.time += dt;
    mgr.tick(dt);
    World.weapons?.tick?.(dt);
    World.match?.tick?.(dt);
    if ((i & 1) === 0) World.fx?.update?.(dt * 2);
  }
  const wall = performance.now() - t0;
  const rep = window_free_report(mgr);
  console.log(JSON.stringify(rep, null, 1));
  console.log(`sim ${SECS}s in ${(wall / 1000).toFixed(1)} s wall; AI+move ${(wall / (SECS * 128)).toFixed(3)} ms/tick`);
  if (process.argv.includes('--check')) {
    // regression gate: fights resolve, bombs get planted, nobody shoots friends, nobody stays stuck
    const L = mgr.log;
    const kills = L.filter((e) => e.type === 'kill');
    const tk = kills.filter((e) => e.kt && e.kt === e.vt).length;
    const hardStuck = L.filter((e) => e.type === 'stuck' && e.level >= 3).length;
    const plants = L.filter((e) => e.type === 'plant').length;
    const fails = [];
    if (kills.length < SECS / 30) fails.push(`too few kills (${kills.length})`);
    if (REAL && SECS >= 240 && plants < 1) fails.push('no bomb plants');
    if (tk > 0) fails.push(`${tk} teamkills`);
    if (hardStuck > SECS / 60) fails.push(`${hardStuck} unresolved stuck events`);
    if (rep.tickMsAvg > 1) fails.push(`bot tick ${rep.tickMsAvg.toFixed(2)} ms > 1 ms`);
    console.log(fails.length ? `CHECK FAILED: ${fails.join('; ')}` : 'CHECK OK');
    process.exitCode = fails.length ? 1 : 0;
  }
  const want = (process.argv.find((a) => a.startsWith('--events=')) || '--events=plan,execute,rotate,plant,defuse,explode,round_end,kill,stuck').slice(9).split(',');
  const ev = mgr.log.filter((e) => want.includes(e.type));
  const lim = process.argv.includes('--all') ? 1e9 : 80;
  for (const e of ev.slice(0, lim)) console.log('EV', JSON.stringify(e));
}

function window_free_report(mgr) {
  const sim = mgr.sim || mgr.simStats;
  const ttk = sim?.ttk?.slice().sort((a, b) => a - b) || [];
  return { ...mgr.report(), rounds: World.match?.started ? World.match.history.length : sim?.round, score: World.match?.started ? World.match.score : sim?.score, ttkAvg: ttk.length ? +(ttk.reduce((s, x) => s + x, 0) / ttk.length).toFixed(2) : null, ttkN: ttk.length, areas: sim?.areas };
}
