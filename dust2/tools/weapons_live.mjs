#!/usr/bin/env node
// In-game weapons check: boots the real game once (harness mode) and runs scenarios,
// screenshotting each: AK spray at a wall 10 m away (mid-spray + the holes it left),
// AWP scoped, an HE + smoke, and an AK headshot on a CT placed down range.
//   node tools/weapons_live.mjs [--outdir /tmp/weapons/live] [--w 960 --h 540] [--only spray,awp]
// Uses the same render-slot semaphore as tools/shot.mjs. Exit 2 on console/page errors.
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
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { const n = args[i + 1]; opt[args[i].slice(2)] = n && !n.startsWith('--') ? (i++, n) : true; }
const OUT = opt.outdir || '/tmp/weapons/live';
const W = +opt.w || 960, H = +opt.h || 540;
const ONLY = opt.only ? String(opt.only).split(',') : null;
const POSE = opt.pose || 'long_doors';
fs.mkdirSync(OUT, { recursive: true });

// ---- render slot (same scheme as shot.mjs) ----
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
  if (!myLock) { if (waited === 0) console.error('[live] waiting for a free render slot…'); await new Promise((r) => setTimeout(r, 1000)); }
}
const release = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', release);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { release(); process.exit(130); });

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
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const log = (...a) => console.log('[live]', ...a);
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); else if (opt.verbose) console.log(`[page] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });
  const bootErr = await page.evaluate(() => window.__BOOT_ERROR);
  if (bootErr) throw new Error(bootErr);
  for (const f of await page.evaluate(() => window.World?.bootFailures || [])) errors.push(`bootFailure: ${f}`);

  // helpers inside the page
  await page.evaluate((pose) => {
    const Wd = window.World, Hn = window.__harness;
    window.__wl = {
      async faceWall(dist = 400) {
        // from the pose, walk the eye so the first wall ahead is `dist` away
        Hn.applyPose(pose);
        const L = Wd.local, ov = Wd.cameraOverride;
        const T = Wd.camera.position.constructor;
        const eye = new T().copy(ov.eye);
        const y = ov.yaw * Math.PI / 180;
        const fwd = new T(Math.cos(y), 0, -Math.sin(y));
        const tr = Wd.collision.rayTrace(eye, eye.clone().addScaledVector(fwd, 6000), 1);
        const hit = tr.endpos.clone();
        const e2 = hit.clone().addScaledVector(fwd, -dist);
        Hn.applyPose({ eye: [e2.x, e2.y, e2.z], pitch: 0, yaw: ov.yaw });
        L.onGround = true;
        return { wall: hit.toArray(), eye: e2.toArray(), surface: tr.surface };
      },
      async equip(key) { Wd.weapons.give(Wd.local, key); Wd.weapons.switchTo(Wd.local, key); await Hn.frames(80); },
      async hold(bits, frames) { Wd.input.buttons |= bits; await Hn.frames(frames); },
      release(bits) { Wd.input.buttons &= ~bits; },
      state() { const L = Wd.local, a = L.active; return { key: a?.key, clip: a?.clip, st: a?.state, punch: [+L.aimPunch.pitch.toFixed(2), +L.aimPunch.yaw.toFixed(2)], fov: Wd.camera.fov.toFixed(1), scoped: !!L.scoped, inacc: +Wd.weapons.currentInaccuracy(L).toFixed(3) }; },
    };
  }, POSE);
  const shot = async (name) => { const f = path.join(OUT, `${name}.png`); await page.locator('canvas#game').screenshot({ path: f }); log('wrote', f); };
  const want = (n) => !ONLY || ONLY.includes(n);

  if (want('spray')) {
    log('wall', JSON.stringify(await page.evaluate(() => window.__wl.faceWall(400))));
    await page.evaluate(() => window.__wl.equip('ak47'));
    await page.evaluate(() => window.__wl.hold(1, 40));
    log('mid-spray', JSON.stringify(await page.evaluate(() => window.__wl.state())));
    await shot('ak_midspray');
    await page.evaluate(() => window.__wl.hold(1, 150));
    await page.evaluate(() => window.__wl.release(1));
    await page.evaluate(() => window.__harness.frames(90));
    log('after', JSON.stringify(await page.evaluate(() => window.__wl.state())));
    await shot('ak_wall');
  }
  if (want('awp')) {
    await page.evaluate((p) => window.__harness.applyPose(p), POSE);
    await page.evaluate(() => window.__wl.equip('awp'));
    await page.evaluate(() => { window.World.weapons.secondary(window.World.local); return window.__harness.frames(40); });
    log('awp', JSON.stringify(await page.evaluate(() => window.__wl.state())));
    await shot('awp_scoped');
    await page.evaluate(() => { window.World.weapons.secondary(window.World.local); window.World.weapons.secondary(window.World.local); return window.__harness.frames(30); });
  }
  if (want('nades')) {
    await page.evaluate((p) => window.__harness.applyPose(p), POSE);
    await page.evaluate(async () => {
      const Wd = window.World, Hn = window.__harness;
      Wd.local.onGround = true;
      Wd.weapons.give(Wd.local, 'smokegrenade'); Wd.weapons.give(Wd.local, 'hegrenade');
      Wd.weapons.switchTo(Wd.local, 'hegrenade'); await Hn.frames(50);
      Wd.input.buttons |= 1; await Hn.frames(25); Wd.input.buttons &= ~1; await Hn.frames(20);
      await Hn.frames(20);
      Wd.weapons.switchTo(Wd.local, 'smokegrenade'); await Hn.frames(50);
      Wd.input.buttons |= 1; await Hn.frames(25); Wd.input.buttons &= ~1;
    });
    await page.evaluate(() => window.__harness.frames(62));
    await shot('he_explode');
    await page.evaluate(() => window.__harness.frames(240));
    await shot('smoke');
  }
  if (want('kill')) {
    const r = await page.evaluate(async (pose) => {
      const Wd = window.World, Hn = window.__harness;
      Hn.applyPose(pose);
      const L = Wd.local; L.onGround = true;
      const ov = Wd.cameraOverride;
      const T = Wd.camera.position.constructor;
      const y = ov.yaw * Math.PI / 180, fwd = new T(Math.cos(y), 0, -Math.sin(y));
      const eye = new T().copy(ov.eye);
      // put a CT on the floor 500u ahead (or just short of the first wall)
      const tr = Wd.collision.rayTrace(eye, eye.clone().addScaledVector(fwd, 520), 1);
      const at = tr.endpos.clone().addScaledVector(fwd, -24);
      const down = Wd.collision.rayTrace(at, at.clone().setY(at.y - 400), 1);
      const P = await import('./src/player/player.js');
      const t = P.createPlayer({ team: L.team === 'T' ? 'CT' : 'T', isBot: false, name: 'Target' });
      t.respawn({ pos: down.endpos.clone(), yaw: ov.yaw + 180 });
      t.armor = 100; t.helmet = true;
      // nobody animates a non-bot remote player in the harness: pose its model every frame
      const tick = () => { try { t.frame(1 / 60, 1); } catch (e) { console.warn(e); } if (!window.__stopTarget) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      await Hn.frames(30);
      const head = t.origin.clone(); head.y += t.eyeHeight + 1.5;
      const d = head.clone().sub(eye);
      const pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180 / Math.PI, yaw = Math.atan2(-d.z, d.x) * 180 / Math.PI;
      Hn.applyPose({ eye: [eye.x, eye.y, eye.z], pitch, yaw });
      L.onGround = true;
      Wd.weapons.give(L, 'ak47'); Wd.weapons.switchTo(L, 'ak47'); await Hn.frames(80);
      let dead = null; const off = Wd.on('death', (e) => { dead = { hs: e.headshot, w: e.weapon }; });
      Wd.input.buttons |= 1; await Hn.frames(2); Wd.input.buttons &= ~1;
      await Hn.frames(10);
      off();
      return { dist: d.length().toFixed(0), dead, hp: t.health };
    }, POSE);
    log('kill', JSON.stringify(r));
    await shot('ak_headshot');
  }
  if (want('probe')) {
    const pr = await page.evaluate(async () => {
      const Wd = window.World, Hn = window.__harness;
      Wd.weapons.give(Wd.local, 'ak47'); Wd.weapons.switchTo(Wd.local, 'ak47'); await Hn.frames(80);
      Wd.input.buttons |= 1;
      const r = await Hn.probe(90);
      Wd.input.buttons &= ~1;
      return r;
    });
    log('probe while spraying', JSON.stringify({ frameMsMedian: pr.frameMsMedian, frameMsP95: pr.frameMsP95, calls: pr.calls, triangles: pr.triangles }));
  }
} catch (e) {
  errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.error(`\n${errors.length} ERROR(S):\n` + [...new Set(errors)].slice(0, 30).map((e) => '  x ' + e).join('\n'));
  process.exit(2);
}
