#!/usr/bin/env node
// Viewmodel lab screenshotter. Serves dust2/, opens tools/vmlab.html and runs a shot list.
//
//   node tools/vmlab.mjs --out /tmp/vm --weapons ak47,m4a4 --shots fp,tt,reload,inspect
//   node tools/vmlab.mjs --out /tmp/vm --weapons ak47 --shots fp --w 960 --h 540
//   node tools/vmlab.mjs --out /tmp/vm --weapons ak47 --eval "lab.anim('reload', 1.0)" --name custom
//
// Shots: fp (first-person 1600x900 default), tt (3/4 turntable 1024²), ttl (left side), ttr
// (right side), top, reload / reload_empty / inspect / draw / fire (mid-animation, first person).
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
const opt = { eval: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i]; if (!a.startsWith('--')) continue;
  const k = a.slice(2), next = args[i + 1];
  const val = next === undefined || next.startsWith('--') ? true : (i++, next);
  if (k === 'eval') opt.eval.push(val); else opt[k] = val;
}
const out = opt.out || '/tmp/vmlab';
fs.mkdirSync(out, { recursive: true });
const weapons = String(opt.weapons || 'ak47').split(',');
const shots = String(opt.shots || 'fp,tt').split(String(opt.shots || '').includes('|') ? '|' : ',');
const W = +opt.w || 1600, H = +opt.h || 900;

// same cross-process render semaphore as tools/shot.mjs
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
  if (!myLock) { if (waited === 0) console.error('[vmlab] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
const release = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', release);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { release(); process.exit(130); });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); else if (opt.verbose) console.log(`[page] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack}`));
  const qs = new URLSearchParams({ w: weapons[0], team: opt.team || 'T', nohud: '1' });
  if (opt.exp) qs.set('exp', opt.exp);
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/tools/vmlab.html?${qs}`);
  await page.waitForFunction(() => window.__READY, null, { timeout: 180000, polling: 250 });
  console.log(`[vmlab] ready in ${Date.now() - t0} ms`);
  for (const w of weapons) {
    const team = opt.team || (await page.evaluate((k) => ({ ak47: 'T', galil: 'T', sg553: 'T', glock: 'T', tec9: 'T', mac10: 'T', g3sg1: 'T' })[k] || 'CT', w));
    const tris = await page.evaluate(([k, t]) => window.lab.set(k, t), [w, team]);
    for (const e of opt.eval) await page.evaluate(e);
    for (const s of shots) {
      let size = [W, H];
      if (['tt', 'ttl', 'ttr', 'top', 'ttf'].includes(s)) size = [+opt.tts || 1024, +opt.tts || 1024];
      await page.setViewportSize({ width: size[0], height: size[1] });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.evaluate(([k, t]) => { window.lab.set(k, t); }, [w, team]);
      const cmd = {
        fp: 'lab.fp()',
        tt: 'lab.turntable(-40, 18, 0.62, false)',
        ttl: 'lab.turntable(-90, 4, 0.62, false)',
        ttr: 'lab.turntable(90, 4, 0.62, false)',
        ttf: 'lab.turntable(-30, 12, 0.55, true)',
        top: 'lab.turntable(-10, 70, 0.62, false)',
        reload: 'lab.anim("reload", 0.3 * 2.4); lab.fp()',
        reload2: 'lab.anim("reload", 0.62 * 2.4); lab.fp()',
        reload_empty: 'lab.anim("reload_empty", 0.8 * 2.4); lab.fp()',
        inspect: 'lab.anim("inspect", 1.4); lab.fp()',
        inspect2: 'lab.anim("inspect", 3.2); lab.fp()',
        draw: 'lab.anim("draw", 0.25); lab.fp()',
        fire: 'lab.anim("fire", 0.03); lab.fp()',
        melee: 'lab.anim("melee", 0.22); lab.fp()',
        pin: 'lab.anim("pin", 0.6); lab.fp()',
        silencer: 'lab.anim("silencer_off", 1.0); lab.fp()',
      }[s] || s;
      await page.evaluate(cmd);
      const tag = s.length > 24 ? 'x' + shots.indexOf(s) : s.replace(/[^a-z0-9_]/gi, '');
      const f = path.join(out, `${opt.name ? opt.name + '_' : ''}${w}_${tag}.png`);
      await page.screenshot({ path: f });
      console.log(`wrote ${f}  (tris ${tris})`);
    }
    if (opt.info) console.log(JSON.stringify(await page.evaluate(() => window.lab.info())));
  }
} catch (e) { errors.push(String(e.stack || e)); }
finally { await browser.close(); server.close(); }
if (errors.length) { console.error(`\n${errors.length} ERROR(S):\n` + [...new Set(errors)].slice(0, 20).map((e) => '  ✗ ' + e).join('\n')); code = 2; }
process.exit(code);
