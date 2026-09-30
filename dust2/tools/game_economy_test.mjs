// Economy + match-flow tests for src/game/{economy,rules}.js
//   cd dust2 && node --import ./tools/three-resolve.mjs tools/game_economy_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import {
  ECON, Economy, canBuy, effectivePrice, killAwardOf, formatAfterRound, clampMoney, FORMAT,
} from '../src/game/economy.js';
import { MatchController } from '../src/game/rules.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
};

console.log('economy');
test('pistol-round loser gets $1900, then 2400/2900/3400 capped', () => {
  const e = new Economy();
  const got = [];
  for (let i = 0; i < 6; i++) got.push(e.settleRound('T', 'elimination', false).award.CT);
  assert.deepEqual(got, [1900, 2400, 2900, 3400, 3400, 3400]);
});
test('CS2: a win steps the loss bonus down one level (not reset)', () => {
  const e = new Economy();
  for (let i = 0; i < 4; i++) e.settleRound('T', 'elimination', false); // CT at max level
  e.settleRound('CT', 'elimination', false);                           // CT wins one
  assert.equal(e.settleRound('T', 'elimination', false).award.CT, 2900);
});
test('after a win streak the loss bonus bottoms out at $1400', () => {
  const e = new Economy();
  e.settleRound('CT', 'elimination', false); e.settleRound('CT', 'elimination', false);
  assert.equal(e.settleRound('T', 'elimination', false).award.CT, 1400);
});
test('win rewards: elim 3250, time 3250, bomb 3500, defuse 3500', () => {
  const e = new Economy();
  assert.equal(e.settleRound('T', 'elimination', false).award.T, 3250);
  assert.equal(e.settleRound('CT', 'time', false).award.CT, 3250);
  assert.equal(e.settleRound('T', 'bomb_exploded', true).award.T, 3500);
  assert.equal(e.settleRound('CT', 'bomb_defused', true).award.CT, 3500);
});
test('Ts get +$800 plant bonus on a lost round', () => {
  const e = new Economy();
  const s = e.settleRound('CT', 'bomb_defused', true);
  assert.equal(s.award.T, 1900 + 800);
  assert.equal(s.plantBonus, 800);
});
test('Ts alive when time expires (no plant) earn nothing', () => {
  const e = new Economy();
  const s = e.settleRound('CT', 'time', false);
  assert.equal(Economy.playerRoundMoney(s, { team: 'T', alive: true }), 0);
  assert.equal(Economy.playerRoundMoney(s, { team: 'T', alive: false }), 1900);
});
test('money clamps to $16000 and never negative', () => {
  assert.equal(clampMoney(15800 + 3250), ECON.MAX);
  assert.equal(clampMoney(-50), 0);
});
test('kill awards (CS2 table)', () => {
  assert.equal(killAwardOf('knife'), 1500);
  assert.equal(killAwardOf('awp'), 100);
  assert.equal(killAwardOf('mac10'), 600);
  assert.equal(killAwardOf('p90'), 300);
  assert.equal(killAwardOf('nova'), 900);
  assert.equal(killAwardOf('xm1014'), 600);
  assert.equal(killAwardOf('ak47'), 300);
  assert.equal(killAwardOf('hegrenade'), 300);
  assert.equal(Economy.killReward({ team: 'T' }, { team: 'T' }, 'ak47'), -300);
});

console.log('loadout rules');
const P = (o) => ({ team: 'CT', money: 16000, armor: 0, helmet: false, defuser: false, inventory: { primary: null, secondary: 'usp', knife: 'knife', grenades: [], c4: null, taser: null }, ...o });
test('max 2 flashbangs, 1 of other nades, 4 total', () => {
  const p = P({ inventory: { grenades: ['flashbang', 'flashbang'] } });
  assert.equal(canBuy(p, 'flashbang').reason, 'type_limit');
  p.inventory.grenades = ['flashbang', 'smokegrenade', 'hegrenade', 'incgrenade'];
  assert.equal(canBuy(p, 'decoy').reason, 'grenade_limit');
  p.inventory.grenades = ['smokegrenade'];
  assert.equal(canBuy(p, 'smokegrenade').reason, 'type_limit');
  assert.equal(canBuy(p, 'flashbang').ok, true);
});
test('team restrictions', () => {
  assert.equal(canBuy(P({ team: 'T' }), 'm4a4').reason, 'team');
  assert.equal(canBuy(P({ team: 'CT' }), 'ak47').reason, 'team');
  assert.equal(canBuy(P({ team: 'T' }), 'defusekit').reason, 'team');
  assert.equal(canBuy(P({ team: 'T' }), 'awp').ok, true);
});
test('armor pricing: helmet upgrade $350, refill vest keeps helmet price at $650', () => {
  assert.equal(effectivePrice(P({ armor: 100 }), 'kevlarhelmet'), 350);
  assert.equal(effectivePrice(P({ armor: 40, helmet: true }), 'kevlarhelmet'), 650);
  assert.equal(canBuy(P({ armor: 100, helmet: true }), 'kevlarhelmet').reason, 'owned');
});
test('cannot afford', () => {
  assert.equal(canBuy(P({ money: 2000 }), 'm4a4').reason, 'money');
});

console.log('match format');
test('halftime after 12, match point at 13', () => {
  assert.deepEqual(formatAfterRound(12, { T: 7, CT: 5 }), { swap: true, halftime: true });
  assert.equal(formatAfterRound(20, { T: 13, CT: 7 }).end, true);
  assert.equal(formatAfterRound(20, { T: 12, CT: 8 }).end, undefined);
});
test('12-12 -> overtime with $10k, OT half at 27, OT win at 16', () => {
  const r = formatAfterRound(24, { T: 12, CT: 12 });
  assert.equal(r.overtime, true); assert.equal(r.otMoney, true);
  assert.equal(formatAfterRound(27, { T: 14, CT: 13 }).swap, true);
  assert.equal(formatAfterRound(28, { T: 16, CT: 12 }).end, true);
  assert.equal(formatAfterRound(29, { T: 15, CT: 14 }).end, undefined);
  const again = formatAfterRound(30, { T: 15, CT: 15 });
  assert.equal(again.newOvertime, true);
  assert.equal(formatAfterRound(34, { T: 19, CT: 15 }).end, true);
});

// ---- integration: drive MatchController with fake players --------------------------------
console.log('match controller');
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const zone = (a, b) => ({ min: v(...a), max: v(...b) });
World.map = {
  spawns: {
    T: [0, 1, 2, 3, 4].map((i) => ({ pos: v(i * 40, 0, 0), yaw: 0 })),
    CT: [0, 1, 2, 3, 4].map((i) => ({ pos: v(i * 40, 0, -2000), yaw: 180 })),
  },
  bombsites: { A: zone([1000, -50, -1000], [1400, 200, -600]), B: zone([-1400, -50, -1000], [-1000, 200, -600]) },
  buyzones: { T: zone([-200, -50, -200], [400, 200, 200]), CT: zone([-200, -50, -2200], [400, 200, -1800]) },
};
World.harness = false;
World.cvar.mp_freezetime = 0;
function mkPlayer(team, i) {
  const p = {
    team, name: `${team}${i}`, isBot: true, alive: true, health: 100, armor: 0, helmet: false, defuser: false,
    origin: v(0, 0, 0), velocity: v(0, 0, 0), yaw: 0, onGround: true, money: 0,
    inventory: { primary: null, secondary: null, knife: null, grenades: [], c4: null, taser: null },
    respawn(sp) { this.origin.copy(sp.pos); this.alive = true; this.health = 100; },
  };
  World.entities.push(p);
  return p;
}
const Ts = [0, 1, 2, 3, 4].map((i) => mkPlayer('T', i));
const CTs = [0, 1, 2, 3, 4].map((i) => mkPlayer('CT', i));
World.local = null;
World.bots = { handlesBuying: true, frozen: false };
const m = new MatchController();
m.beginMatch('T');
const kill = (a, b, weapon = 'ak47') => { b.alive = false; World.emit('death', { victim: b, attacker: a, weapon, headshot: false }); };
const tickUntil = (cond, max = 20000) => { for (let i = 0; i < max && !cond(); i++) { World.time += 1 / 64; m.tick(1 / 64); } };

test('everyone starts on $800 with default pistols', () => {
  assert.equal(m.phase, 'live');
  for (const p of World.entities) assert.equal(p.money, 800);
  assert.equal(Ts[0].inventory.secondary, 'glock');
  assert.equal(CTs[0].inventory.secondary, 'usp');
  assert.equal(m.bomb.state, 'carried');
});
test('elimination: T win, kill awards + round money', () => {
  const ak = Ts[0];
  for (const ct of CTs) kill(ak, ct, 'glock');
  assert.equal(m.phase, 'roundend');
  assert.equal(m.score.T, 1);
  assert.equal(ak.money, 800 + 5 * 300 + 3250);
  assert.equal(Ts[1].money, 800 + 3250);
  assert.equal(CTs[0].money, 800 + 1900);
  assert.equal(m.lastRoundEnd.mvp, ak);
});
test('round 2: survivors keep kit, bomb plant -> defuse, plant bonus for Ts', () => {
  tickUntil(() => m.phase === 'live');
  assert.equal(m.history.length, 1);
  const c = m.bomb.carrier;
  assert.ok(c && c.team === 'T');
  const moneyBefore = Ts.map((t) => t.money);
  c.origin.set(1200, 0, -800);
  m.use(c, true);
  tickUntil(() => { m.use(c, true); return m.bomb.state === 'planted'; }, 400);
  assert.equal(m.phase, 'planted');
  assert.equal(c.money, moneyBefore[Ts.indexOf(c)] + 300);
  const d = CTs[2];
  d.origin.set(1210, 0, -800);
  tickUntil(() => { m.use(d, true); return m.phase === 'roundend'; }, 64 * 12);
  assert.equal(m.history[1].reason, 'bomb_defused');
  // CT won by defuse: 3500 (+300 defuser); T lost after winning one: level 0 -> $1400 + $800 plant
  const tIdx = Ts.indexOf(c) === 0 ? 1 : 0;
  assert.equal(Ts[tIdx].money, moneyBefore[tIdx] + 1400 + 800);
});
test('time runs out: CT win, surviving Ts get $0', () => {
  tickUntil(() => m.phase === 'live');
  const before = Ts[3].money;
  kill(CTs[0], Ts[4]);
  const deadBefore = Ts[4].money;
  tickUntil(() => m.phase === 'roundend', 64 * 200);
  assert.equal(m.history[2].reason, 'time');
  assert.equal(Ts[3].money, before);
  assert.ok(Ts[4].money > deadBefore);
});
test('bomb detonation: T win $3500', () => {
  tickUntil(() => m.phase === 'live');
  const c = m.bomb.carrier;
  c.origin.set(-1200, 0, -800);
  const before = Ts.map((t) => t.money);
  tickUntil(() => { m.use(c, true); return m.phase === 'planted'; }, 400);
  tickUntil(() => m.phase === 'roundend', 64 * 45);
  assert.equal(m.history[3].reason, 'bomb_exploded');
  const other = Ts.find((t) => t !== c);
  assert.equal(other.money, Math.min(16000, before[Ts.indexOf(other)] + 3500));
});
test('halftime swaps sides and resets money to $800', () => {
  let guard = 0;
  while (m.history.length < 12 && guard++ < 50) {
    tickUntil(() => m.phase === 'live');
    const winner = m.history.length % 2 ? 'T' : 'CT';
    const [A, B] = winner === 'T' ? [Ts, CTs] : [CTs, Ts];
    for (const b of B) if (b.alive) kill(A[0], b);
  }
  const scoreBefore = { ...m.score };
  tickUntil(() => m.phase === 'live');
  assert.equal(Ts[0].team, 'CT');
  assert.equal(m.score.T, scoreBefore.CT);
  assert.equal(m.localTeam, 'CT');
  for (const p of World.entities) assert.equal(p.money, 800);
  assert.equal(Ts[0].inventory.secondary, 'usp');
});
test('first to 13 ends the match', () => {
  let guard = 0;
  while (m.phase !== 'matchend' && guard++ < 40) {
    tickUntil(() => m.phase === 'live' || m.phase === 'matchend');
    if (m.phase === 'matchend') break;
    const winSide = Ts[0].team;  // group "Ts" wins every round now
    for (const p of World.entities) if (p.team !== winSide && p.alive) kill(Ts[0], p);
    tickUntil(() => m.phase !== 'roundend', 64 * 10);
  }
  assert.equal(m.phase, 'matchend');
  assert.equal(Math.max(m.score.T, m.score.CT), 13);
});
test('money never exceeds $16000', () => {
  for (const p of World.entities) assert.ok(p.money <= 16000 && p.money >= 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
