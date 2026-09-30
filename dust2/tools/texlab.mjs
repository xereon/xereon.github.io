#!/usr/bin/env node
// Screenshot driver for tools/texlab.html (texture agent's swatch board).
//   node tools/texlab.mjs --keys plaster_wall,stone_block --out /tmp/tex/a.png
//   node tools/texlab.mjs --view maps --keys plaster_wall --out /tmp/tex/m.png
//   node tools/texlab.mjs --all --outdir /tmp/tex/board      (every material, 4 per sheet)
//   node tools/texlab.mjs --view decals --out /tmp/tex/decals.png
// Same render-slot semaphore and SwiftShader flags as tools/shot.mjs. Exits 2 on any
// console error / page error.
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
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const next = args[i + 1];
  opt[a.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
}

// ---- shared render-slot semaphore (see shot.mjs) ----
const SLOTS = +process.env.DUST2_SHOT_SLOTS || 2;
const LOCKDIR = '/tmp/dust2-shot-locks';
fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let myLock = null;
for (let waited = 0; !myLock; waited++) {
  for (let i = 0; i < SLOTS && !myLock; i++) {
    const f = path.join(LOCKDIR, `slot${i}.lock`);
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); myLock = f; }
    catch {
      const pid = +fs.readFileSync(f, 'utf8').trim();
      if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} }
    }
  }
  if (!myLock) {
    if (waited === 0) console.error('[texlab] waiting for a free render slot…');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const releaseLock = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
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
const port = server.address().port;

const errors = [];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-webgl', '--disable-gpu-sandbox'],
});

async function shoot(query, out) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    else if (opt.verbose) console.log(`[page:${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const url = `http://127.0.0.1:${port}/tools/texlab.html?${query}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__TEXLAB_READY, null, { timeout: +opt.timeout || 300000, polling: 250 });
  const info = await page.evaluate(() => window.__TEXLAB);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  console.log(`wrote ${out}  (bake ${info.bakeMs.toFixed(0)} ms, ready ${info.readyMs.toFixed(0)} ms, page ${Date.now() - t0} ms, maxAniso ${info.maxAniso})`);
  const bench = await page.evaluate(() => window.__BENCH);
  if (bench) console.log(bench.join('\n'));
  if (opt.timings) console.log(JSON.stringify(info.stats.perKey), JSON.stringify(info.stats.stages || {}));
  await page.close();
}

try {
  const base = new URLSearchParams();
  for (const k of ['view', 'cell', 'quality', 'exposure', 'profile', 'eager']) if (opt[k]) base.set(k, opt[k]);
  if (opt.all) {
    const keys = (opt.keys ? String(opt.keys).split(',') : null) || JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/texlab.keys.json'), 'utf8'));
    const per = +opt.per || 4;
    const outdir = opt.outdir || '/tmp/texlab';
    for (let i = 0; i < keys.length; i += per) {
      const q = new URLSearchParams(base); q.set('keys', keys.slice(i, i + per).join(','));
      await shoot(q.toString(), path.join(outdir, `sheet${String(i / per).padStart(2, '0')}.png`));
    }
  } else {
    const q = new URLSearchParams(base); if (opt.keys) q.set('keys', opt.keys);
    await shoot(q.toString(), opt.out || '/tmp/texlab/lab.png');
  }
} catch (e) { errors.push(String(e.stack || e)); }
finally { await browser.close(); server.close(); }
if (errors.length) {
  console.error(`\n${errors.length} ERROR(S):\n` + [...new Set(errors)].slice(0, 30).map((e) => '  ✗ ' + e).join('\n'));
  process.exit(2);
}
