#!/usr/bin/env node
// Prop lab screenshotter (props agent).
//   node tools/proplab.mjs --view crate --out /tmp/p/crate.png [--w 1600 --h 900] [--query "variant=1&az=20"]
//   node tools/proplab.mjs --set final --outdir /tmp/p      (lineup + crate/stack/door/car close-ups)
// Exit code 2 on any console error / page error.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const k = args[i].slice(2), n = args[i + 1];
  opt[k] = n === undefined || n.startsWith('--') ? true : (i++, n);
}

// same cross-process render semaphore as shot.mjs
const SLOTS = +process.env.DUST2_SHOT_SLOTS || 2, LOCKDIR = '/tmp/dust2-shot-locks';
fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let myLock = null;
for (let waited = 0; !myLock; waited++) {
  for (let i = 0; i < SLOTS && !myLock; i++) {
    const f = path.join(LOCKDIR, `slot${i}.lock`);
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); myLock = f; }
    catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } }
  }
  if (!myLock) { if (waited === 0) console.error('[proplab] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
const release = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', release);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { release(); process.exit(130); });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const W = +opt.w || 1600, H = +opt.h || 900;
const SETS = {
  final: [['yard', 'view=yard'], ['yardL', 'view=yard&half=L'], ['yardR', 'view=yard&half=R'], ['crate', 'view=crate&variant=0&az=32&el=16&dist=0.78'], ['stack', 'view=stack&az=30&el=15&dist=0.8'],
    ['door', 'view=door&az=18&el=6&dist=0.62'], ['car', 'view=car&az=40&el=14&dist=0.72']],
};
// --jobs "name=query;name2=query2"  (query without leading ?)
const jobs = opt.set ? SETS[opt.set] : opt.jobs ? String(opt.jobs).split(';').filter(Boolean).map((j) => { const i = j.indexOf('='); return [j.slice(0, i), j.slice(i + 1)]; })
  : [[opt.name || opt.view || 'lineup', `view=${opt.view || 'lineup'}${opt.query ? '&' + opt.query : ''}`]];
const outdir = opt.outdir || (opt.out ? path.dirname(opt.out) : '/tmp');
fs.mkdirSync(outdir, { recursive: true });

const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'] });
try {
  for (const [name, query] of jobs) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); else if (opt.verbose || m.type() === 'warning') console.log(`[page:${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/tools/proplab.html?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__READY, null, { timeout: +opt.timeout || 240000, polling: 250 });
    const out = jobs.length === 1 && opt.out ? opt.out : path.join(outdir, `${name}.png`);
    await page.screenshot({ path: out });
    const st = await page.evaluate(() => ({ stats: window.__STATS, info: window.__INFO }));
    console.log(`wrote ${out} (${Date.now() - t0}ms) calls=${st.info?.calls} tris=${st.info?.triangles}`);
    if (opt.stats) console.log(JSON.stringify(st.stats));
    await page.close();
  }
} catch (e) { errors.push(String(e.stack || e)); }
finally { await browser.close(); server.close(); }
if (errors.length) { console.error(`\n${errors.length} ERROR(S):\n` + [...new Set(errors)].slice(0, 20).map((e) => '  ✗ ' + e).join('\n')); process.exit(2); }
