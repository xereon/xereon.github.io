#!/usr/bin/env node
// Screenshot driver for tools/renderlab.html (rendering agent's lighting test scene).
//   node tools/renderlab.mjs --view street --out /tmp/render/a.png [--w 960 --h 540]
//   node tools/renderlab.mjs --views street,courtyard --outdir /tmp/render/r1
//   node tools/renderlab.mjs --view street --eval "cv.exposure=1.2" --out /tmp/x.png
//   node tools/renderlab.mjs --view street --probe          (timings + renderer.info JSON)
// Same render-slot semaphore / SwiftShader flags as tools/shot.mjs; exit 2 on console errors.
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
    if (waited === 0) console.error('[renderlab] waiting for a free render slot…');
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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
});
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); else if (opt.verbose) console.log(`[page:${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  const q = new URLSearchParams();
  if (opt.quality) q.set('quality', opt.quality);
  if (opt.vm !== undefined) q.set('vm', String(opt.vm));
  if (opt.query) for (const kv of String(opt.query).split('&')) { const [k, v = '1'] = kv.split('='); q.set(k, v); }
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/tools/renderlab.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: +opt.timeout || 400000, polling: 250 });
  const bootErr = await page.evaluate(() => window.__BOOT_ERROR);
  if (bootErr) { errors.push(`BOOT: ${bootErr}`); throw new Error('boot failed'); }
  const bootMs = Date.now() - t0;
  for (const e of opt.eval) await page.evaluate(e);
  const views0 = opt.views ? String(opt.views).split(',') : [opt.view || 'street'];
  // --variants "name:js|name2:js2": every view is shot once per variant (cvars reset between)
  const variants = opt.variants ? String(opt.variants).split('|').filter(Boolean).map((v) => { const i = v.indexOf(':'); return [v.slice(0, i), v.slice(i + 1)]; }) : [['', '']];
  const baseCv = await page.evaluate(() => ({ ...window.World.cvar }));
  const views = [];
  for (const v of views0) for (const [vn, js] of variants) views.push({ v, vn, js });
  const outdir = opt.outdir || (opt.out ? path.dirname(opt.out) : '/tmp');
  fs.mkdirSync(outdir, { recursive: true });
  const frames = async (n, profile = false) => page.evaluate(([n, p]) => window.renderFrames(n, p), [n, profile]);
  for (const { v, vn, js } of views) {
    await page.evaluate((b) => { for (const k in b) if (window.cv[k] !== b[k]) window.cv[k] = b[k]; }, baseCv);
    if (js) await page.evaluate(js);
    await page.evaluate((v) => window.setView(v), v);
    await frames(+opt.frames || 3);
    if (opt.probe) {
      const f = await frames(2);
      const prof = await frames(1, true);
      const r = await page.evaluate(() => { const i = window.__LAB.rp.renderer.info;
        return { textures: i.memory.textures, geometries: i.memory.geometries, programs: i.programs?.length, ...window.__LAB.timings }; });
      const pw = opt.probeworld ? await page.evaluate(() => window.probeWorld()) : undefined;
      console.log(JSON.stringify({ view: v, bootMs, frameMs: Math.round(f.ms), calls: f.calls, tris: f.tris, passes: prof.passes, world: pw, ...r }));
      continue;
    }
    const out = views.length === 1 && opt.out ? opt.out : path.join(outdir, `${v}${vn ? '__' + vn : ''}.png`);
    await (await page.$('canvas#game')).screenshot({ path: out });
    console.log(`wrote ${out}`);
  }
  console.log(`boot ${bootMs}ms`, JSON.stringify(await page.evaluate(() => window.__LAB.timings)));
} catch (e) {
  if (!errors.length) errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  const uniq = [...new Set(errors)];
  console.error(`\n${uniq.length} ERROR(S):\n` + uniq.slice(0, 30).map((e) => '  ✗ ' + e).join('\n'));
  code = 2;
}
process.exit(code);
