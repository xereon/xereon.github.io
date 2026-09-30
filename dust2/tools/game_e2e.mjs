#!/usr/bin/env node
// End-to-end UI flow in the real game (no harness): main menu -> Play -> team select ->
// freeze time HUD -> buy menu (buy an AK/M4) -> scoreboard (Tab) -> pause (Esc).
//   node tools/game_e2e.mjs --outdir /tmp/hud/e2e [--w 1280 --h 720] [--quality low]
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
for (let i = 0; i < args.length; i++) { if (!args[i].startsWith('--')) continue; const n = args[i + 1]; opt[args[i].slice(2)] = n === undefined || n.startsWith('--') ? true : (i++, n); }
const outdir = opt.outdir || '/tmp/hud/e2e';
fs.mkdirSync(outdir, { recursive: true });
const W = +opt.w || 1280, H = +opt.h || 720;

const LOCKDIR = '/tmp/dust2-shot-locks'; let lock = null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
fs.mkdirSync(LOCKDIR, { recursive: true });
for (let w = 0; !lock; w++) {
  for (let i = 0; i < 2 && !lock; i++) { const f = `${LOCKDIR}/slot${i}.lock`; try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); lock = f; } catch { const pid = +fs.readFileSync(f, 'utf8'); if (!pid || !alive(pid)) try { fs.unlinkSync(f); } catch {} } }
  if (!lock) { if (!w) console.error('[e2e] waiting for a render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const shot = async (page, name) => { const f = path.join(outdir, name + '.png'); await page.screenshot({ path: f, timeout: 300000 }); console.log('wrote', f); };
const frames = (page, n) => page.evaluate((k) => new Promise((res) => { let l = k; const s = () => (--l <= 0 ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); }), n);
const state = (page) => page.evaluate(() => { const M = World.match; return { phase: M?.phase, round: M?.roundNumber, team: M?.localTeam, money: World.local?.money, prim: World.local?.inventory?.primary?.key ?? World.local?.inventory?.primary ?? null, armor: World.local?.armor, menu: World.hud?.menus?.open, buy: World.hud?.buy?.open, ents: World.entities.length, capture: World.hud?.captureInput }; });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html${opt.quality ? '?quality=' + opt.quality : ''}`);
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 400000, polling: 500 });
  if (await page.evaluate(() => window.__BOOT_ERROR)) throw new Error('boot error');
  await frames(page, 30);
  await shot(page, '1_mainmenu');
  await page.click('.mm-btn.primary');
  await frames(page, 3);
  await shot(page, '2_teamselect');
  await page.click(`.ts-card[data-team="${opt.team || 'T'}"]`);
  await frames(page, 20);
  console.log(JSON.stringify(await state(page)));
  await shot(page, '3_freeze');
  await page.keyboard.press('KeyB');
  await frames(page, 4);
  const rifle = (await state(page)).team === 'CT' ? 'm4a1s' : 'ak47';
  await page.click('.bm-card[data-key="kevlarhelmet"]');
  await page.keyboard.press('Digit2'); await page.keyboard.press('Digit4'); // pistols -> Tec-9 / Five-SeveN
  await frames(page, 3);
  await shot(page, '4_buymenu');
  console.log(JSON.stringify(await state(page)));
  await page.keyboard.press('Escape');
  await frames(page, 3);
  await page.keyboard.down('Tab');
  await frames(page, 4);
  await shot(page, '5_scoreboard');
  await page.keyboard.up('Tab');
  await frames(page, 60);
  console.log(JSON.stringify(await state(page)), rifle);
  await shot(page, '6_live');
} catch (e) { errors.push(String(e.stack || e)); }
finally { await browser.close(); server.close(); }
if (errors.length) { console.error([...new Set(errors)].slice(0, 20).map((e) => '  ✗ ' + e).join('\n')); process.exit(2); }
