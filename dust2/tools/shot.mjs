#!/usr/bin/env node
// Screenshot / probe harness. See CONTRACT.md §10.
//
//   node tools/shot.mjs --pose long_doors --out /tmp/a.png
//   node tools/shot.mjs --all --outdir /tmp/shots            (every pose, one browser)
//   node tools/shot.mjs --poses mid,catwalk --outdir /tmp/s
//   node tools/shot.mjs --pose mid --eval "cv.exposure=1.3" --out /tmp/b.png
//   node tools/shot.mjs --pose mid --probe                   (JSON perf/budget dump)
//   node tools/shot.mjs --list-poses
//
// Exit code 2 on any console error / page error / boot failure (after still writing shots).
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
const opt = { eval: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const next = args[i + 1];
  const val = next === undefined || next.startsWith('--') ? true : (i++, next);
  if (k === 'eval') opt.eval.push(val); else opt[k] = val;
}

const poses = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/poses.json'), 'utf8'));
if (opt['list-poses']) {
  for (const [k, v] of Object.entries(poses)) console.log(k.padEnd(18), v.desc || '');
  process.exit(0);
}

// ---- cross-process semaphore: at most SLOTS concurrent headless browsers ------------------
// SwiftShader is CPU-bound; many agents screenshotting at once would thrash the box.
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
    if (waited === 0) console.error('[shot] waiting for a free render slot…');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const releaseLock = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });

const W = +opt.w || 1600, H = +opt.h || 900;
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
const port = server.address().port;

const errors = [];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(`console.error: ${t}`);
    else if (opt.verbose) console.log(`[page:${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const q = new URLSearchParams({ harness: '1' });
  if (opt.quality) q.set('quality', opt.quality);
  if (opt.viewmodel !== undefined) q.set('viewmodel', String(opt.viewmodel));
  if (opt.live) q.set('live', '1');
  if (opt.query) for (const kv of String(opt.query).split('&')) { const [k, v = '1'] = kv.split('='); q.set(k, v); }
  const url = `http://127.0.0.1:${port}/index.html?${q}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: +opt.timeout || 240000, polling: 250 });
  const bootErr = await page.evaluate(() => window.__BOOT_ERROR);
  if (bootErr) { errors.push(`BOOT: ${bootErr}`); throw new Error('boot failed'); }
  const bootMs = Date.now() - t0;
  const failures = await page.evaluate(() => window.World?.bootFailures || []);
  for (const f of failures) errors.push(`bootFailure: ${f}`);

  for (const e of opt.eval) await page.evaluate(e);

  const list = opt.all ? Object.keys(poses) : opt.poses ? String(opt.poses).split(',') : [opt.pose || Object.keys(poses)[0]];
  const frames = +opt.frames || 8;
  const outdir = opt.outdir || (opt.out ? path.dirname(opt.out) : '/tmp');
  fs.mkdirSync(outdir, { recursive: true });

  for (const name of list) {
    await page.evaluate((n) => window.__harness.applyPose(n), name);
    if (opt.evalpose) await page.evaluate(opt.evalpose);
    await page.evaluate((f) => window.__harness.frames(f), frames);
    if (opt.probe) {
      const r = await page.evaluate((n) => window.__harness.probe(n), +opt.probe > 1 ? +opt.probe : 30);
      console.log(JSON.stringify({ pose: name, bootMs, ...r }, null, 1));
      continue;
    }
    const out = list.length === 1 && opt.out ? opt.out : path.join(outdir, `${name}.png`);
    const canvas = await page.$('canvas#game');
    await (opt.fullpage ? page : canvas).screenshot({ path: out });
    console.log(`wrote ${out}`);
  }
  console.log(`boot ${bootMs}ms`);
} catch (e) {
  if (!errors.length) errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  const uniq = [...new Set(errors)];
  console.error(`\n${uniq.length} ERROR(S):\n` + uniq.slice(0, 30).map((e) => '  ✗ ' + e).join('\n'));
  exitCode = 2;
}
process.exit(exitCode);
