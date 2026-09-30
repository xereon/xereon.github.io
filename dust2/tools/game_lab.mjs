#!/usr/bin/env node
// Fast HUD iteration without WebGL: renders tools/game_lab.html (real HUD modules) over a
// captured game frame.   node tools/game_lab.mjs --bg /tmp/hud/bg.png --map /tmp/hud/map.json
//   --modes hud,buymenu --sizes 1600x900,1920x1080 --outdir /tmp/hud/lab
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
const MODES = String(opt.modes || 'hud,buymenu,scoreboard,roundend,mainmenu,teamselect,settings,pause,matchend,scope,flash,planted,spectate,damage').split(',');
const SIZES = String(opt.sizes || '1600x900').split(',').map((s) => s.split('x').map(Number));
const outdir = opt.outdir || '/tmp/hud/lab';
fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  let f = p === '/bg.png' && opt.bg ? opt.bg : p === '/mapdump.json' && opt.map ? opt.map : path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const errors = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const [W, H] of SIZES) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); else if (opt.verbose) console.log(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
    const q = new URLSearchParams({ hud: '1' });
    if (opt.bg) q.set('bg', '/bg.png');
    if (opt.yaw) q.set('yaw', opt.yaw);
    await page.goto(`http://127.0.0.1:${server.address().port}/tools/game_lab.html?${q}`);
    await page.waitForFunction(() => window.__READY, null, { timeout: 60000 });
    for (const m of MODES) {
      await page.evaluate((mode) => window.__hud.demo(mode), m);
      await page.evaluate(() => window.__harness.frames(3));
      const out = path.join(outdir, `${m}_${W}x${H}.png`);
      await page.screenshot({ path: out });
      console.log('wrote', out);
    }
    await page.close();
  }
} catch (e) { errors.push(String(e.stack || e)); }
finally { await browser.close(); server.close(); }
if (errors.length) { console.error([...new Set(errors)].slice(0, 20).map((e) => '  ✗ ' + e).join('\n')); process.exit(2); }
