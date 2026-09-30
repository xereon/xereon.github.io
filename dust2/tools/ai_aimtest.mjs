// Node test: bot aim model — flick with slight overshoot, settle time ordered by difficulty.
//   node --import ./tools/three-resolve.mjs tools/ai_aimtest.mjs
import { Aim, makeProfile } from '../src/ai/aim.js';
import { rng } from '../src/core/mathx.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok ' : '  FAIL'} ${m}`); if (!c) fails++; };
const res = {};
for (const d of ['easy', 'normal', 'hard', 'expert']) {
  const settle = [], over = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 7919);
    const a = new Aim(makeProfile(d, r), r);
    a.reset(0, 0);
    a.acquire(0.3, 0.5);
    const target = 40;                // 40° flick to the left
    let t = 0, maxYaw = 0, st = null;
    for (let i = 0; i < 128 * 3; i++) {
      a.update(1 / 128, 0, target, 'combat');
      t += 1 / 128;
      maxYaw = Math.max(maxYaw, a.yaw);
      if (st === null && a.onTarget < 1.0) st = t;
    }
    settle.push(st ?? 3); over.push(maxYaw - target);
  }
  settle.sort((x, y) => x - y);
  res[d] = { median: settle[settle.length >> 1], overshoot: over.reduce((s, x) => s + Math.max(0, x), 0) / over.length };
  console.log(`  ${d.padEnd(7)} settle<1° median ${res[d].median.toFixed(2)} s, mean overshoot ${res[d].overshoot.toFixed(2)}°`);
}
ok(res.easy.median > res.normal.median && res.normal.median > res.hard.median && res.hard.median > res.expert.median, 'settle time ordered easy > normal > hard > expert');
ok(res.expert.median < 0.45 && res.easy.median < 2.5, 'settle times in human range');
ok(res.hard.overshoot > 0.05, 'fast flicks overshoot a little (not robotic)');
ok(res.hard.overshoot < 6, 'overshoot bounded');
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall aim tests passed');
process.exit(fails ? 1 : 0);
