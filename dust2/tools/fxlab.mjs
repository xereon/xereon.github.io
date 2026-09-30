#!/usr/bin/env node
// FX lab driver: deterministic screenshots of every effect in a small courtyard.
//
//   node tools/fxlab.mjs --list
//   node tools/fxlab.mjs --shots smoke_3s,he_fireball --outdir /tmp/fx --w 960 --h 540
//   node tools/fxlab.mjs --all --outdir /tmp/fx
//   node tools/fxlab.mjs --mode atlas --out /tmp/fx/atlas.png       (texture atlases)
//   node tools/fxlab.mjs --shots smoke_3s --query "pipe=game"        (use engine RenderPipeline)
//
// Exit code 2 on any console error / page error.
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

// ---- shared semaphore with tools/shot.mjs ------------------------------------------------
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
    if (waited === 0) console.error('[fxlab] waiting for a free render slot…');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const releaseLock = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });

const W = +opt.w || 960, H = +opt.h || 540;
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
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(`console.error: ${t}`);
    else if (opt.verbose || m.type() === 'warning') console.log(`[page:${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const q = new URLSearchParams();
  if (opt.mode) q.set('mode', opt.mode);
  if (opt.query) for (const kv of String(opt.query).split('&')) { const [k, v = '1'] = kv.split('='); q.set(k, v); }
  const url = `http://127.0.0.1:${port}/tools/fxlab.html?${q}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__FXLAB_READY || window.__FXLAB_ERROR, null, { timeout: +opt.timeout || 240000, polling: 250 });
  const bootErr = await page.evaluate(() => window.__FXLAB_ERROR);
  if (bootErr) { errors.push(`BOOT: ${bootErr}`); throw new Error('boot failed'); }
  console.log(`boot ${Date.now() - t0}ms`);
  for (const e of opt.eval) await page.evaluate(e);

  if (opt.list) {
    const names = await page.evaluate(() => window.__fxlab.list());
    for (const n of names) console.log(n);
  } else if (opt.mode === 'atlas') {
    const out = opt.out || '/tmp/fxlab/atlas.png';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.evaluate(() => window.__fxlab.frames(2));
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H }, timeout: 120000 });
    console.log(`wrote ${out}`);
  } else {
    const names = opt.all ? await page.evaluate(() => window.__fxlab.list())
      : String(opt.shots || opt.shot || 'muzzle_rifle').split(',');
    const outdir = opt.outdir || (opt.out ? path.dirname(opt.out) : '/tmp/fxlab');
    fs.mkdirSync(outdir, { recursive: true });
    for (const name of names) {
      const t1 = Date.now();
      const info = await page.evaluate((n) => window.__fxlab.run(n), name);
      const out = names.length === 1 && opt.out ? opt.out : path.join(outdir, `${name}.png`);
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H }, timeout: 120000 });
      console.log(`wrote ${out}  (${Date.now() - t1}ms) ${info ? JSON.stringify(info) : ''}`);
      if (opt.after) console.log('  after:', JSON.stringify(await page.evaluate(opt.after)));
    }
  }
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
