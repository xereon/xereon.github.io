#!/usr/bin/env node
// Screenshot every HUD/menu state from ONE page load (faster than one shot.mjs per state).
//   node tools/game_shots.mjs --outdir /tmp/hud/r1 --sizes 1600x900,1920x1080 --pose t_spawn
//   node tools/game_shots.mjs --modes hud,buymenu --sizes 960x540
// Uses the same render-slot semaphore as shot.mjs. Exit 2 on console/page errors.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const n = args[i + 1];
  opt[args[i].slice(2)] = n === undefined || n.startsWith('--') ? true : (i++, n);
}
const MODES = String(opt.modes || 'hud,buymenu,scoreboard,roundend,mainmenu,teamselect,settings,pause,matchend,scope,flash,planted,spectate,damage').split(',');
const SIZES = String(opt.sizes || '1600x900').split(',').map((s) => s.split('x').map(Number));
const outdir = opt.outdir || '/tmp/hud/shots';
fs.mkdirSync(outdir, { recursive: true });

const SLOTS = +process.env.DUST2_SHOT_SLOTS || 2;
const LOCKDIR = '/tmp/dust2-shot-locks';
fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let myLock = null;
for (let waited = 0; !myLock; waited++) {
  for (let i = 0; i < SLOTS && !myLock; i++) {
    const f = path.join(LOCKDIR, `slot${i}.lock`);
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); myLock = f; }
    catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } }
  }
  if (!myLock) { if (waited === 0) console.error('[shots] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
const release = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'] });
try {
  const [W0, H0] = SIZES[0];
  const page = await browser.newPage({ viewport: { width: W0, height: H0 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack || '')));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  // --match T|CT: run a real match (live bots) instead of the demo states
  const q = new URLSearchParams(opt.match ? { harness: '1', live: '1' } : { harness: '1', hud: '1' });
  if (opt.quality) q.set('quality', opt.quality);
  if (opt.pose) q.set('pose', opt.pose);
  if (opt.query) for (const kv of String(opt.query).split('&')) { const [k, v = '1'] = kv.split('='); q.set(k, v); }
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });
  const be = await page.evaluate(() => window.__BOOT_ERROR);
  if (be) throw new Error('boot: ' + be);
  for (const f of await page.evaluate(() => window.World?.bootFailures || [])) errors.push('bootFailure: ' + f);
  if (opt.eval) await page.evaluate(String(opt.eval));
  if (opt.match) {
    await page.evaluate((t) => { World.cameraOverride = null; World.match.beginMatch(t, { teamSize: 5 }); }, String(opt.match));
    const n = +opt.shots || 3, step = +opt.frames || 30;
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => window.__harness.frames(k), step);
      const st = await page.evaluate(() => { const M = World.match; return { t: +World.time.toFixed(1), phase: M.phase, round: M.roundNumber, score: M.score, clock: +M.clock().toFixed(1), alive: { T: M.aliveCount('T'), CT: M.aliveCount('CT') }, money: World.local?.money, bomb: M.bomb.state, ents: World.entities.length }; });
      console.log(JSON.stringify(st));
      const out = path.join(outdir, `match_${i}.png`);
      await page.screenshot({ path: out, timeout: 240000 });
      console.log('wrote', out);
    }
    SIZES.length = 0;
  }
  for (const [W, H] of SIZES) {
    await page.setViewportSize({ width: W, height: H });
    for (const m of MODES) {
      await page.evaluate((mode) => { window.__hud.demo(mode); }, m);
      await page.evaluate((n) => window.__harness.frames(n), +opt.frames || 3);
      const out = path.join(outdir, `${m}_${W}x${H}.png`);
      await page.screenshot({ path: out, timeout: 240000 });
      console.log('wrote', out);
    }
  }
} catch (e) { errors.push(String(e.stack || e)); }
finally { await browser.close(); server.close(); }
if (errors.length) { console.error(`\n${errors.length} ERROR(S):\n` + [...new Set(errors)].slice(0, 20).map((e) => '  ✗ ' + e).join('\n')); process.exit(2); }
