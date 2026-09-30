#!/usr/bin/env node
// Screenshots the movement lab (tools/movementlab.html): stand / half-duck / duck views.
//   node tools/movementlab.mjs --outdir /tmp/movement/lab [--pose long_doors] [--w 960 --h 540]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2); const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i] ?? true;
const OUT = opt.outdir || '/tmp/movement/lab', W = +opt.w || 960, H = +opt.h || 540, POSE = opt.pose || 'long_doors';
fs.mkdirSync(OUT, { recursive: true });
const LOCKDIR = '/tmp/dust2-shot-locks'; fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let lock = null;
for (let w = 0; !lock; w++) {
  for (let i = 0; i < 2 && !lock; i++) { const f = path.join(LOCKDIR, `slot${i}.lock`); try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); lock = f; } catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } } }
  if (!lock) { if (!w) console.error('[lab] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock); } catch {} });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/tools/movementlab.html?w=${W}&h=${H}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY, null, { timeout: 300000, polling: 250 });
  const step = async (name, js) => {
    const r = await page.evaluate(js);
    await page.evaluate(() => window.lab.render());
    await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 240000 });
    console.log(`${name}: ${JSON.stringify(r)}`);
  };
  await step('lab_stand', `lab.pose(${JSON.stringify(POSE)}); lab.sim(0.4, 0)`);
  await step('lab_duck_half', `lab.sim(0.1, 4)`);
  await step('lab_duck', `lab.sim(0.4, 4)`);
  await step('lab_crouchjump_apex', `lab.sim(0.6, 0); lab.sim(1/60, 2 | 4); lab.sim(0.36, 4)`);
} catch (e) { errs.push(String(e.stack || e)); }
await browser.close(); server.close();
if (errs.length) { console.error('ERRORS:\n  ' + [...new Set(errs)].join('\n  ')); process.exit(2); }
