#!/usr/bin/env node
// AI lab: browser screenshots of the bot navigation graph and of live bot simulations.
//
//   node tools/ailab.mjs nav --out /tmp/ai/nav.png [--w 1500 --h 1600] [--region x0,z0,x1,z1] [--intel 0]
//   node tools/ailab.mjs sim --secs 90 --outdir /tmp/ai/sim [--diff normal|hard,easy] [--money 4000] [--rules]
//
// Same static server + render-slot semaphore as tools/shot.mjs, but uses page screenshots with
// long timeouts (SwiftShader frames of the full pipeline can take many seconds) and prints
// nav/intel/bot statistics as JSON. Exits 2 on console errors / page errors / boot failures.
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
const mode = args[0] || 'nav';
const opt = {};
for (let i = 1; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const k = args[i].slice(2), v = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
  opt[k] = v;
}

// ---- render slot semaphore (shared with shot.mjs) -----------------------------------------
const SLOTS = +process.env.DUST2_SHOT_SLOTS || 2;
const LOCKDIR = '/tmp/dust2-shot-locks';
fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let myLock = null;
for (let waited = 0; !myLock; waited++) {
  for (let i = 0; i < SLOTS && !myLock; i++) {
    const f = path.join(LOCKDIR, `slot${i}.lock`);
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); myLock = f; }
    catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } }
  }
  if (!myLock) { if (waited === 0) console.error('[ailab] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 250)); }
}
const releaseLock = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });

// ---- static server ------------------------------------------------------------------------
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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
});
const W = +opt.w || (mode === 'nav' ? 1500 : 960), H = +opt.h || (mode === 'nav' ? 1600 : 540);
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(600000);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); else if (opt.verbose) console.log(`[page:${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const q = new URLSearchParams({ harness: '1' });
  if (mode === 'sim') {
    q.set('live', '1');
    q.set('botsim', opt.rules ? 'rules' : '1');
    q.set('botdiff', String(opt.diff || 'normal'));
    q.set('botfreeze', '3');
    q.set('botmoney', String(opt.money || 800));
  }
  if (opt.quality) q.set('quality', opt.quality);
  q.set('viewmodel', '0');
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/index.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 900000, polling: 500 });
  const bootErr = await page.evaluate(() => window.__BOOT_ERROR);
  if (bootErr) { errors.push(`BOOT: ${bootErr}`); throw new Error('boot failed'); }
  for (const f of await page.evaluate(() => window.World?.bootFailures || [])) errors.push(`bootFailure: ${f}`);
  const stats = await page.evaluate(() => {
    const W = window.World, nav = W.nav, intel = W.bots?.intel;
    return {
      navNodes: nav?.count, navLinks: nav?.linkTo?.length, navBakeMs: Math.round(nav?.bakeMs || 0), navStats: nav?.stats,
      intelMs: Math.round(intel?.bakeMs || 0),
      sites: intel ? Object.fromEntries(Object.entries(intel.sites).map(([k, s]) => [k, s.tRoutes.map((r) => `${r.name} ${Math.round(r.length)}u holds:${r.holds?.length}`)])) : null,
    };
  });
  console.log(JSON.stringify({ bootMs: Date.now() - t0, ...stats }, null, 1));

  const shoot = async (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // two rAFs so the replaced/overridden frame is presented
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: file, timeout: 600000, animations: 'allow', caret: 'initial' });
    console.log(`wrote ${file}`);
  };

  if (mode === 'nav') {
    const region = opt.region ? String(opt.region).split(',').map(Number) : null;
    await page.addStyleTag({ content: '#hud-root,#ui-root{display:none!important}' });
    await page.evaluate(async ({ region, intel }) => {
      const m = await import('/tools/ai_topdown.js');
      window.__td = m.install({ region, intel });
    }, { region, intel: opt.intel !== '0' });
    await shoot(opt.out || '/tmp/ai_nav.png');
  } else if (mode === 'sim') {
    const secs = +(opt.secs || 90);
    const outdir = opt.outdir || '/tmp/ai_sim';
    const rep = await page.evaluate(async (secs) => {
      const s = window.__botsim;
      if (!s) throw new Error('botsim not running');
      let rep = null, shotAt = -1, bot = null;
      for (let t = 0; t < secs; t += 0.5) {
        rep = s.step(0.5);
        if (!bot && t > 12) {
          bot = s.mgr.bots.find((b) => b.ent.alive && b.target?.alive && b.targetMem?.visible && b.ent.origin.distanceTo(b.target.origin) > 250) || null;
          if (bot) { shotAt = t; break; }
        }
      }
      window.__shotBot = bot;
      return { ...rep, shotAt, bot: bot?.ent.name, target: bot?.target?.name };
    }, secs);
    console.log(JSON.stringify(rep));
    // over-the-shoulder camera on the engaged bot
    await page.evaluate(() => {
      const W = window.World, b = window.__shotBot || window.__botsim.mgr.bots.find((x) => x.ent.alive);
      if (!b) return;
      const e = b.ent, yaw = b.aim.yaw * Math.PI / 180, V = e.origin.constructor;
      const eye = new V(e.origin.x - Math.cos(yaw) * 60 + Math.sin(yaw) * 22, e.origin.y + 76, e.origin.z + Math.sin(yaw) * 60 + Math.cos(yaw) * 22);
      W.cameraOverride = { eye, pitch: b.aim.pitch + 3, yaw: b.aim.yaw, fov: null };
      W.local?.setPose?.(eye, b.aim.pitch + 3, b.aim.yaw);
      W.camera.position.copy(eye);
      W.bots.frame(0.016, 1);
    });
    await shoot(path.join(outdir, 'fight.png'));
    // then the rest of the sim, and a top-down of where everyone is
    const rep2 = await page.evaluate((secs) => {
      const s = window.__botsim;
      const left = Math.max(0, secs - (s.sim.round ? 0 : 0) - window.World.time);
      const r = s.step(Math.max(1, left));
      const log = s.mgr.log;
      const kills = log.filter((e) => e.type === 'kill');
      return { ...r, kills: kills.length, hs: kills.filter((k) => k.hs).length, stuckEvents: log.filter((e) => e.type === 'stuck').length,
        plants: log.filter((e) => e.type === 'plant').length, nades: log.filter((e) => e.type === 'nade').length,
        routes: log.filter((e) => e.type === 'plan').map((e) => e.plan) };
    }, secs);
    console.log(JSON.stringify(rep2));
    await page.addStyleTag({ content: '#hud-root,#ui-root{display:none!important}' });
    await page.setViewportSize({ width: 1400, height: 1500 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    await page.evaluate(async () => { const m = await import('/tools/ai_topdown.js'); m.install({ intel: false, linkOpacity: 0.1 }); });
    await shoot(path.join(outdir, 'topdown.png'));
  }
} catch (e) {
  if (!errors.length) errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.error(`\n${errors.length} ERROR(S):\n` + [...new Set(errors)].slice(0, 20).map((e) => '  ✗ ' + e).join('\n'));
  code = 2;
}
process.exit(code);
