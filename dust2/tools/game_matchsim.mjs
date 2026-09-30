// Headless full-match integration: real Dust II map + nav + Player + WeaponSystem + bots +
// MatchController, no rendering. Checks the round loop, economy and bomb flow end to end.
//   node --import ./tools/three-resolve.mjs tools/game_matchsim.mjs [minutes=6] [--verbose]
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { buildNavMeshSync } from '../src/ai/navmesh.js';

const MIN = +(process.argv[2] || 6);
const VERBOSE = process.argv.includes('--verbose');
World.harness = false;
World.params = new URLSearchParams('');
const t0 = performance.now();
const map = await (await import('../src/map/dust2.js')).buildDust2({ textures: null, props: null });
World.map = map; World.collision = map.collision;
World.scene = new THREE.Scene(); World.camera = new THREE.PerspectiveCamera(74, 16 / 9, 1, 12000);
World.viewScene = new THREE.Scene(); World.viewCamera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 200);
World.nav = buildNavMeshSync(map);
const W = await import('../src/weapons/system.js');
(await import('../src/game/economy.js')).setRegistry((await import('../src/weapons/registry.js')).WEAPONS);
World.weapons = new W.WeaponSystem();
await import('../src/player/player.js');
const B = await import('../src/ai/bot.js');
World.bots = new B.BotManager();
await World.bots.ready;
const G = await import('../src/game/rules.js');
World.match = new G.MatchController();
World.emit('ready', {});
console.log(`setup ${(performance.now() - t0).toFixed(0)} ms`);

const M = World.match;
const log = [];
const counts = { kills: 0, hs: 0, plants: 0, defuses: 0, explodes: 0, buys: 0, wallbang: 0 };
World.on('killfeed', (e) => { counts.kills++; if (e.headshot) counts.hs++; if (e.wallbang) counts.wallbang++; if (VERBOSE) console.log(`  ${World.time.toFixed(1)} ${e.attacker?.name ?? 'world'} [${e.weapon}${e.headshot ? ' HS' : ''}] ${e.victim.name}`); });
World.on('bomb_planted', (e) => { counts.plants++; log.push(`R${M.history.length + 1} ${World.time.toFixed(1)} plant ${e.site} by ${e.ent?.name} phase=${M.phase}`); });
World.on('bomb_defused', (e) => { counts.defuses++; log.push(`R${M.history.length + 1} ${World.time.toFixed(1)} defused by ${e.ent?.name} phase=${M.phase}`); });
World.on('bomb_exploded', () => { counts.explodes++; log.push(`R${M.history.length + 1} ${World.time.toFixed(1)} exploded phase=${M.phase} timer=${M.bomb.timer.toFixed(1)}`); });
World.on('round_end', (e) => log.push(`R${e.round} ${World.time.toFixed(1)} end ${e.winner} ${e.reason}`));
World.on('buy', () => counts.buys++);
World.on('round_end', (e) => {
  const money = M.players().map((p) => p.money);
  const line = `R${e.round} ${e.winner.padEnd(2)} ${e.reason.padEnd(13)} score T${M.score.T}-CT${M.score.CT}  $min ${Math.min(...money)} max ${Math.max(...money)} loss T${M.economy.lossLevel.T} CT${M.economy.lossLevel.CT}  mvp ${e.mvp?.name ?? '-'}`;
  console.log(line);
});
World.on('match_end', (e) => console.log('MATCH END', e.winner, JSON.stringify(e.score)));

World.cvar.mp_freezetime = 3;
M.beginMatch('T', { teamSize: 5, difficulty: 'hard' });
console.log('players', M.players().map((p) => `${p.name}(${p.team})`).join(' '));
const dt = 1 / 128;
const t1 = performance.now();
const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origErr(...a); };
let checks = 0;
for (let i = 0; i < MIN * 60 * 128 && M.phase !== 'matchend'; i++) {
  World.time += dt;
  World.bots.tick(dt);
  World.weapons.tick(dt);
  M.tick(dt);
  if (i % 2 === 0) { World.bots.frame?.(dt * 2, 1); World.weapons.frame?.(dt * 2); }
  if (i % 128 === 0) {
    checks++;
    for (const p of M.players()) {
      if (!(p.money >= 0 && p.money <= 16000)) errors.push(`money out of range ${p.name} ${p.money}`);
    }
  }
}
const wall = (performance.now() - t1) / 1000;
console.log(`\nsim ${(World.time / 60).toFixed(1)} min in ${wall.toFixed(1)} s wall, rounds ${M.history.length}, phase ${M.phase}`);
console.log(JSON.stringify(counts));
console.log(log.slice(0, 40).join('\n'));
const reasons = {};
for (const h of M.history) reasons[h.reason] = (reasons[h.reason] || 0) + 1;
console.log('reasons', JSON.stringify(reasons));
if (errors.length) { console.log(`${errors.length} errors, first:`, errors.slice(0, 5)); process.exit(1); }
