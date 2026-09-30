#!/usr/bin/env node
// In-browser movement check: boots the game once in the harness, releases the camera override
// and drives World.input.buttons like a player would. Screenshots stand/duck views and prints
// movement + camera-smoothness diagnostics.
//   node tools/movement_live.mjs --outdir /tmp/movement [--pose t_spawn] [--w 960 --h 540]
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
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i] ?? true;
const OUT = opt.outdir || '/tmp/movement';
const W = +opt.w || 960, H = +opt.h || 540;
fs.mkdirSync(OUT, { recursive: true });

// same cross-process render semaphore as shot.mjs
const LOCKDIR = '/tmp/dust2-shot-locks';
fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let myLock = null;
for (let waited = 0; !myLock; waited++) {
  for (let i = 0; i < 2 && !myLock; i++) {
    const f = path.join(LOCKDIR, `slot${i}.lock`);
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); myLock = f; }
    catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } }
  }
  if (!myLock) { if (waited === 0) console.error('[live] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
const release = () => { try { if (fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', release);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const errors = [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?harness=1&live=1${opt.quality ? '&quality=' + opt.quality : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });
  const bootErr = await page.evaluate(() => window.__BOOT_ERROR);
  if (bootErr) throw new Error(bootErr);
  const canvas = await page.$('canvas#game');
  const shot = async (name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f, timeout: 240000 }); console.log(`wrote ${f}`); };
  void canvas;

  const pose = opt.pose || Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/poses.json'), 'utf8')))[1];
  const say = (lines) => console.log(lines.join('\n'));

  // 1) standing view, via the real main loop
  say(await page.evaluate(async (pose) => {
    const H = window.__harness, P = World.local, I = World.input;
    const r2 = (v) => Math.round(v * 100) / 100;
    H.applyPose(pose);
    await H.frames(2);
    World.cameraOverride = null;          // hand the camera to the player
    I.buttons = 0;
    World.harnessFixedDt = 0.05;
    await H.frames(3);
    return [`stand: pos=(${r2(P.origin.x)},${r2(P.origin.y)},${r2(P.origin.z)}) ground=${P.onGround} eye=${r2(P.eyeHeight)} camY=${r2(World.camera.position.y)} vfov=${r2(World.camera.fov)}`];
  }, pose));
  await shot('stand');

  // 2) ducked view (hold duck ~0.4 s of game time)
  say(await page.evaluate(async () => {
    const H = window.__harness, P = World.local, I = World.input;
    const r2 = (v) => Math.round(v * 100) / 100;
    I.buttons = 1 << 2;
    await H.frames(8);
    return [`duck: ducked=${P.ducked} amount=${r2(P.duckAmount)} eye=${r2(P.eyeHeight)} camY-originY=${r2(World.camera.position.y - P.origin.y)}`];
  }));
  await shot('duck');

  // 3) numeric checks on the real map collision, driven like main.js but without rendering
  say(await page.evaluate(async () => {
    const P = World.local, I = World.input, out = [];
    const r2 = (v) => Math.round(v * 100) / 100;
    const TI = World.tickInterval;
    const cmd = { forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0, pitch: 0, yaw: P.yaw };
    const tick = (b) => {
      cmd.buttons = b; cmd.forwardmove = (b & 8 ? 450 : 0) - (b & 16 ? 450 : 0);
      cmd.sidemove = (b & 1024 ? 450 : 0) - (b & 512 ? 450 : 0);
      cmd.yaw = I.yaw; cmd.pitch = I.pitch;
      World.time += TI; P.runCommand(cmd, TI);
    };
    for (let i = 0; i < 64; i++) tick(0);            // unduck + settle
    const sp = [];
    for (let i = 0; i < 128; i++) { tick(8); if (i % 13 === 12) sp.push(r2(P.speed2D)); }
    out.push(`W from standstill, speed every ~0.1 s: ${sp.join(' ')}`);
    const y0 = P.origin.y; let maxY = y0, air = 0;
    tick(8 | 2);
    for (let i = 0; i < 128; i++) { tick(8); maxY = Math.max(maxY, P.origin.y); if (!P.onGround) air++; }
    out.push(`jump on the map: apex ${r2(maxY - y0)} u, airtime ${r2(air * TI)} s, speed now ${r2(P.speed2D)}`);
    for (let i = 0; i < 128; i++) tick(0);

    // per-tick cost of the movement code against the real map BVH
    const saveO = P.origin.clone();
    const t0 = performance.now(); const N = 3000;
    for (let i = 0; i < N; i++) { I.yaw = (I.yaw + 0.7) % 360; tick(i % 200 < 150 ? 8 | 1024 : 16 | 2); }
    const us = (performance.now() - t0) / N * 1000;
    P.origin.copy(saveO); P.velocity.set(0, 0, 0); P._snapInterp();
    out.push(`runCommand cost: ${r2(us)} us/tick = ${r2(us * 128 / 1000)} ms per sim-second per player`);

    // main-loop interpolation at 144 Hz with vsync noise: per-frame camera step must be constant.
    // Pick an unobstructed heading first (hull trace 600u) so we measure free running.
    let bestYaw = 0, bestF = -1;
    const mins = { x: -16, y: 0, z: -16 }, maxs = { x: 16, y: 72, z: 16 };
    const o = P.origin.clone(); o.y += 1;
    for (let k = 0; k < 24; k++) {
      const yw = k * 15, e = o.clone(); e.x += Math.cos(yw * Math.PI / 180) * 600; e.z -= Math.sin(yw * Math.PI / 180) * 600;
      const f = World.collision.hullTrace(mins, maxs, o, e).fraction;
      if (f > bestF) { bestF = f; bestYaw = yw; }
    }
    I.yaw = bestYaw; I.pitch = 0;
    for (let i = 0; i < 128; i++) tick(8);
    let acc = 0, last = null, seed = 7; const steps = [];
    for (let f = 0; f < 150; f++) {
      seed = (seed * 16807) % 2147483647;
      const dt = 1 / 144 + ((seed / 2147483647) - 0.5) * 0.0006;
      acc += dt;
      while (acc >= TI) { tick(8); acc -= TI; }
      World.frame++; P.frame(dt, acc / TI);
      const c = World.camera.position;
      if (last) steps.push({ d: Math.hypot(c.x - last.x, c.z - last.z), dt });
      last = c.clone();
    }
    const err = Math.max(...steps.map((s) => Math.abs(s.d - P.speed2D * s.dt)));
    out.push(`144 Hz run on map (heading ${bestYaw}, free ${Math.round(bestF * 600)}u): v=${r2(P.speed2D)}, step ${r2(P.speed2D / 144)} u/frame, max deviation from v*dt ${err.toFixed(5)} u`);
    return out;
  }));

  // 4) one real frame after walking a bit, to confirm the loop keeps running cleanly
  say(await page.evaluate(async () => {
    const H = window.__harness, P = World.local, I = World.input;
    I.buttons = 8; World.harnessFixedDt = 0.05;
    await H.frames(4);
    I.buttons = 0;
    return [`after walk: pos=(${Math.round(P.origin.x)},${Math.round(P.origin.y)},${Math.round(P.origin.z)}) v=${Math.round(P.speed2D)} errors so far: ${(World.bootFailures || []).length}`];
  }));
  await shot('after');
} catch (e) {
  errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error(`\n${errors.length} ERROR(S):\n  ` + [...new Set(errors)].join('\n  ')); process.exit(2); }
