#!/usr/bin/env node
// Top-down orthographic map check (see maplab.html).
//   node tools/maplab.mjs --out /tmp/map/top.png [--w 1400] [--mode height|render] [--radar /path/radar.png]
// --radar underlays a local overview image (same pos/scale as the de_dust2 overview) to compare
// shapes; the image is only read locally and never becomes part of the repo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const n = a[i + 1]; opt[a[i].slice(2)] = n && !n.startsWith('--') ? (i++, n) : true; }
const W = +opt.w || 1400;
const out = opt.out || '/tmp/maplab.png';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: W } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const q = new URLSearchParams({ w: String(W), mode: opt.mode || 'height' });
  if (opt.radar) q.set('radar', '1');
  if (opt.tex) q.set('tex', '1');
  const PW = +opt.pw || 960, PH = +opt.ph || 540;
  if (opt.mode === 'pose') { q.set('pw', PW); q.set('ph', PH); await page.setViewportSize({ width: PW, height: PH }); }
  await page.goto(`http://127.0.0.1:${server.address().port}/tools/maplab.html?${q}`);
  await page.waitForFunction(() => window.__DONE || window.__ERR, null, { timeout: 180000 });
  const err = await page.evaluate(() => window.__ERR);
  if (err) throw new Error(err);
  if (opt.radar) {
    const b64 = fs.readFileSync(opt.radar).toString('base64');
    await page.evaluate((d) => { const w = document.getElementById('wrap'); w.style.background = `url(${d}) 0 0 / 100% 100% no-repeat`; }, `data:image/png;base64,${b64}`);
  }
  if (opt.mode === 'pose') {
    const names = opt.poses ? String(opt.poses).split(',') : await page.evaluate(() => window.__poses);
    const dir = opt.outdir || path.dirname(out);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      await page.evaluate((n) => window.__pose(n), n);
      await page.locator('#gl').screenshot({ path: path.join(dir, `${n}.png`) });
      console.log('wrote', path.join(dir, `${n}.png`));
    }
  } else {
    await page.locator('#wrap').screenshot({ path: out });
    console.log('wrote', out);
  }
  if (errs.length) { console.error(errs.join('\n')); code = 2; }
} catch (e) { console.error(e); code = 2; }
await browser.close();
server.close();
process.exit(code);
