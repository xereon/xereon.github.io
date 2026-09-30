#!/usr/bin/env node
// Pose-matched reference pairs: renders our Dust II from the exact camera pose of each real
// CS:GO / CS2 reference frame and writes side-by-side + BLIND comparison images.
//
//   node tools/refpair.mjs --refs <REFS dir> --out /tmp/dust2-refpair
//   node tools/refpair.mjs --refs <REFS> --filter long_doors          (substring of id/callout/file)
//   node tools/refpair.mjs --refs <REFS> --primary                    (one hero view per spot)
//   node tools/refpair.mjs --refs <REFS> --poses-only --write-poses tools/refposes.json
//   node tools/refpair.mjs --refs <REFS> --list
//
// REFS/index.json entries: { id, file, game, callout, source:{x,y,z|null}, yaw, pitch, fov43,
//   eyeAboveFloor?, floorAt?:{x,y}, floorHint?, primary?, confidence, notes }
//   source.x/y are Source/Hammer world units; source.z (optional) is the Source EYE height.
//   yaw/pitch are Source angles (yaw 0 = east/+x, 90 = north/+y; pitch + = down).
//   fov43 is CS "fov_desired" (horizontal at 4:3, Hor+) -> vertical fov is aspect-independent:
//   90 -> 73.74 deg vertical (106.26 deg horizontal at 16:9). Verified against the CS:GO frames.
//
// Outputs (in --out): ours_<id>.png, pair_<id>.png (ref left | ours right, W x H/2),
//   blind/<id>_X.png + blind/<id>_Y.png (random order, both re-encoded identically),
//   blind/key.json (the answers — keep it away from critics), refpair.json (poses used).
//
// Other options: --w 1920 --h 1080  --frames 8  --quality high  --query "k=v&k2=v2"
//   --floor zone|lowest|highest (default zone)  --hfov <deg> (force literal horizontal fov)
//   --fov43 <deg>  --keep-bots  --viewmodel 1  --eval "<js>"  --timeout <ms>  --verbose
//
// Exit codes: 0 ok, 2 console/page/boot errors (outputs still written), 3 some entries had no
// usable floor (skipped, listed on stderr), 1 bad arguments.
// Reference images are Valve-copyrighted: this tool refuses to write inside the repository.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // dust2/
const REPO = path.resolve(ROOT, '..');

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
const die = (msg, code = 1) => { console.error(`[refpair] ${msg}`); process.exit(code); };
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// ---- reference library ----------------------------------------------------------------------
const DEFAULT_REFS = '/tmp/claude-0/-home-user-xereon-github-io/3029034b-4cd3-5362-9a03-750b17d68c57/scratchpad/refs';
const REFS = path.resolve(String(opt.refs || process.env.DUST2_REFS || DEFAULT_REFS));
const indexFile = path.join(REFS, 'index.json');
if (!fs.existsSync(indexFile)) die(`no reference index at ${indexFile} (pass --refs <dir> or set DUST2_REFS)`);
if (inside(REFS, REPO)) console.error('[refpair] WARNING: reference library lives inside the repo — it must never be committed');
let entries = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
for (const e of entries) e.id ||= path.basename(e.file, path.extname(e.file));
if (opt.filter) {
  const subs = String(opt.filter).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  entries = entries.filter((e) => subs.some((s) => `${e.id} ${e.callout} ${e.file} ${e.game}`.toLowerCase().includes(s)));
}
if (opt.game) entries = entries.filter((e) => e.game === opt.game);
if (opt.primary) entries = entries.filter((e) => e.primary);
if (opt.limit) entries = entries.slice(0, +opt.limit);
if (opt.list) {
  for (const e of entries) {
    const s = e.source;
    console.log(`${e.id.padEnd(26)} ${e.game.padEnd(5)} (${s.x}, ${s.y}${s.z != null ? ', ' + s.z : ''}) yaw ${e.yaw} pitch ${e.pitch} [${e.confidence}]${e.primary ? ' *' : ''}`);
  }
  process.exit(0);
}
if (!entries.length) die('no index entries match the filter');

const W = +opt.w || 1920, H = +opt.h || 1080;
const OUT = path.resolve(String(opt.out || '/tmp/dust2-refpair'));
const posesOnly = !!opt['poses-only'];
if (!posesOnly && inside(OUT, REPO)) die(`refusing to write reference-derived images inside the repo (${OUT}); use a /tmp path`);
const BLIND = path.join(OUT, 'blind');
if (!posesOnly) fs.mkdirSync(BLIND, { recursive: true });
const DEG = Math.PI / 180;
// CS fov is horizontal at 4:3 (Hor+): vertical fov does not depend on the aspect ratio.
const vfovFor = (e) => {
  if (opt.hfov) return 2 * Math.atan(Math.tan((+opt.hfov * DEG) / 2) * (H / W)) / DEG;
  const f43 = +(opt.fov43 || e.fov43 || 90);
  return 2 * Math.atan(Math.tan((f43 * DEG) / 2) * 0.75) / DEG;
};

// ---- cross-process semaphore (same slots as shot.mjs): at most SLOTS headless browsers -------
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
    if (waited === 0) console.error('[refpair] waiting for a free render slot…');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const releaseLock = () => { try { if (myLock && fs.readFileSync(myLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(myLock); } catch {} };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

// ---- static server: game files + /__refs/ (library) + /__mem/ (our fresh renders) -----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const mem = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  if (p === '/__blank') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>refpair</title>'); return; }
  if (p.startsWith('/__mem/')) {
    const b = mem.get(p.slice(7));
    if (!b) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(b); return;
  }
  let base = ROOT;
  if (p.startsWith('/__refs/')) { base = REFS; p = p.slice(7); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(base, p);
  if (!inside(f, base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

// ---- in-page: floor trace + pose ------------------------------------------------------------
// Casts down the vertical line at (x, y) through every solid, collecting upward-facing
// (normal.y > 0.7) surfaces that have >= 70u of free space above them (a standing player fits).
// Choice: floorHint (closest) > --floor mode. 'zone' (default) = lowest candidate inside the
// map's own callout zones (World.map.callouts) containing the point — this keeps the camera out
// of tunnel roofs / awnings; falls back to the highest candidate when no zone matches.
function pagePose(a) {
  const Wd = window.World, C = Wd?.collision;
  const out = { floor: null, candidates: [], how: null };
  if (a.zEye == null) {
    if (!C?.hullTrace) return { error: 'World.collision.hullTrace is missing (collision/map not loaded)' };
    const V = Wd.camera.position.constructor;
    const ZERO = new V(0, 0, 0), s = new V(), e = new V();
    const MASK = 1 | 2 | 4; // MASK_PLAYER: solid | playerclip | grate
    const tx = a.fx, tz = -a.fy;
    const solidAt = (y) => {
      s.set(tx, y, tz);
      if (C.pointContents) return (C.pointContents(s) & MASK) !== 0;
      return !!C.hullTrace(ZERO, ZERO, s, e.set(tx, y - 0.5, tz), MASK).startSolid;
    };
    let y = 4000;
    for (let guard = 0; y > -4000 && guard < 500; guard++) {
      const t = C.hullTrace(ZERO, ZERO, s.set(tx, y, tz), e.set(tx, -4000, tz), MASK);
      if (t.startSolid || t.allSolid) { let yy = y - 2; while (yy > -4000 && solidAt(yy)) yy -= 2; y = yy; continue; }
      if (!(t.fraction < 1)) break;
      const hy = t.endpos.y, ny = t.normal.y, surface = t.surface;
      if (ny > 0.7) {
        const h = C.hullTrace(ZERO, ZERO, s.set(tx, hy + 1, tz), e.set(tx, hy + 73, tz), MASK);
        out.candidates.push({ y: +hy.toFixed(2), ny: +ny.toFixed(3), surface, headroom: h.startSolid ? 0 : +(h.fraction * 72).toFixed(1) });
      }
      y = hy - 1;
    }
    const ok = out.candidates.filter((c) => c.headroom >= 70);
    if (!ok.length) {
      return { error: `floor trace found no standable surface with headroom at Source (${a.fx}, ${a.fy})` +
        (out.candidates.length ? ` (upward hits without headroom: ${out.candidates.map((c) => c.y).join(', ')})` : ' (no hits at all — map not built here?)'), ...out };
    }
    const lowest = (l) => l.reduce((m, c) => (c.y < m.y ? c : m));
    const highest = (l) => l.reduce((m, c) => (c.y > m.y ? c : m));
    if (a.floorHint != null) {
      out.floor = ok.reduce((m, c) => (Math.abs(c.y - a.floorHint) < Math.abs(m.y - a.floorHint) ? c : m));
      out.how = `closest to floorHint ${a.floorHint}`;
    } else if (a.mode === 'lowest') { out.floor = lowest(ok); out.how = 'lowest'; }
    else if (a.mode === 'highest') { out.floor = highest(ok); out.how = 'highest'; }
    else {
      const zones = Object.entries(Wd.map?.callouts || {}).filter(([, z]) => z?.min && z?.max &&
        tx >= z.min.x && tx <= z.max.x && tz >= z.min.z && tz <= z.max.z);
      const band = ok.filter((c) => zones.some(([, z]) => c.y >= z.min.y - 24 && c.y <= z.max.y + 1));
      if (band.length) { out.floor = lowest(band); out.how = `lowest inside zone ${[...new Set(zones.map(([n]) => n))].join('/')}`; }
      else { out.floor = highest(ok); out.how = zones.length ? 'highest (no candidate inside zone band)' : 'highest (no callout zone here)'; }
    }
  }
  const eyeY = a.zEye != null ? a.zEye : out.floor.y + a.eyeAbove;
  out.how ||= 'source.z (eye) given';
  return { ...out, eye: [a.sx, +eyeY.toFixed(2), -a.sy] };
}

// ---- in-page: grab the WebGL canvas right after the game's own rAF render --------------------
// Our rAF callback is queued behind the main loop's, so the drawing buffer still holds the
// frame just rendered (works without preserveDrawingBuffer; no DOM HUD, no stability wait).
function pageCapture() {
  return new Promise((res) => {
    requestAnimationFrame(() => {
      try {
        const gl = document.querySelector('canvas#game');
        const c = document.createElement('canvas');
        c.width = gl.width; c.height = gl.height;
        const g = c.getContext('2d');
        g.drawImage(gl, 0, 0);
        // blank check: a cleared buffer reads back as uniform black / transparent
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let lo = 255 * 4, hi = 0;
        for (let i = 0; i < d.length; i += 4 * 997) { const v = d[i] + d[i + 1] + d[i + 2] + d[i + 3]; if (v < lo) lo = v; if (v > hi) hi = v; }
        res({ w: c.width, h: c.height, blank: hi - lo < 3, url: c.toDataURL('image/png') });
      } catch (e) { res({ error: String(e) }); }
    });
  });
}

// ---- in-page: compositing (same encoder for ref and ours so blind files don't leak) ---------
async function pageCompose({ refUrl, oursUrl, W, H, caption }) {
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image failed to load: ' + u)); i.src = u; });
  const [ref, ours] = await Promise.all([load(refUrl), load(oursUrl)]);
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const enc = (w, h, draw) => { c.width = w; c.height = h; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; draw(); return c.toDataURL('image/png'); };
  const hw = Math.round(W / 2), hh = Math.round(H / 2);
  const label = (t, x, y, px) => {
    g.font = `600 ${px}px sans-serif`; g.textBaseline = 'top';
    const m = g.measureText(t).width;
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x - 6, y - 4, m + 12, px + 8);
    g.fillStyle = '#fff'; g.fillText(t, x, y);
  };
  const px = Math.max(11, Math.round(hh / 30));
  const pair = enc(hw * 2, hh, () => {
    g.fillStyle = '#000'; g.fillRect(0, 0, hw * 2, hh);
    g.drawImage(ref, 0, 0, hw, hh); g.drawImage(ours, hw, 0, hw, hh);
    g.fillStyle = '#000'; g.fillRect(hw - 1, 0, 2, hh);
    label(caption.left, 10, 8, px); label(caption.right, hw + 10, 8, px);
    label(caption.pose, 10, hh - px - 12, Math.round(px * 0.8));
  });
  const full = (img) => enc(W, H, () => g.drawImage(img, 0, 0, W, H));
  return { pair, ref: full(ref), ours: full(ours) };
}
const fromDataUrl = (s) => Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');

// ---- run ------------------------------------------------------------------------------------
const errors = [];
const floorFailures = [];
const done = [];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(`console.error: ${t}`);
    else if (opt.verbose) console.log(`[page:${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const q = new URLSearchParams({ harness: '1', viewmodel: String(opt.viewmodel ?? 0) });
  if (opt.quality) q.set('quality', opt.quality);
  if (opt.query) for (const kv of String(opt.query).split('&')) { const [k, v = '1'] = kv.split('='); q.set(k, v); }
  const t0 = Date.now();
  await page.goto(`${origin}/index.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: +opt.timeout || 240000, polling: 250 });
  const bootErr = await page.evaluate(() => window.__BOOT_ERROR);
  if (bootErr) { errors.push(`BOOT: ${bootErr}`); throw new Error('boot failed'); }
  console.log(`[refpair] booted in ${Date.now() - t0}ms; ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; ${W}x${H}`);
  for (const f of await page.evaluate(() => window.World?.bootFailures || [])) errors.push(`bootFailure: ${f}`);
  if (!(await page.evaluate(() => typeof window.__harness?.applyPose === 'function'))) throw new Error('window.__harness.applyPose missing');
  for (const e of opt.eval) await page.evaluate(e);

  // Gate the game's render so the SwiftShader GPU process is idle between captures; otherwise
  // the 1080p render loop starves the compositing page (and every other agent's harness).
  await page.evaluate(() => {
    const R = window.World?.renderer;
    if (R && typeof R.render === 'function' && !R.__refpairGate) {
      const orig = R.render.bind(R);
      const g = (R.__refpairGate = { on: false });
      R.render = (...a) => (g.on ? orig(...a) : undefined);
    }
  });
  const gate = (on) => page.evaluate((v) => { const g = window.World?.renderer?.__refpairGate; if (g) g.on = v; }, on);

  const comp = posesOnly ? null : await browser.newPage();
  if (comp) await comp.goto(`${origin}/__blank`);
  const frames = +opt.frames || 8;
  const mode = String(opt.floor || 'zone');

  for (const e of entries) try {
    const tE = Date.now();
    const s = e.source || {};
    const fa = e.floorAt || s;
    const vfov = vfovFor(e);
    const r = await page.evaluate(pagePose, {
      sx: +s.x, sy: +s.y, fx: +fa.x, fy: +fa.y, zEye: s.z ?? null,
      eyeAbove: e.eyeAboveFloor ?? 64, floorHint: e.floorHint ?? null, mode,
    });
    if (r.error) {
      floorFailures.push(`${e.id}: ${r.error}`);
      console.error(`[refpair] ✗ ${e.id}: ${r.error}`);
      continue;
    }
    const pose = { eye: r.eye, pitch: e.pitch ?? 0, yaw: e.yaw ?? 0, fov: +vfov.toFixed(4) };
    const rec = { id: e.id, file: e.file, game: e.game, callout: e.callout, primary: !!e.primary, source: s, pose,
      floor: r.floor, floorHow: r.how, candidates: r.candidates, confidence: e.confidence };
    const floorTxt = r.floor ? `floor y=${r.floor.y} (${r.how}; ${r.candidates.length} hit${r.candidates.length === 1 ? '' : 's'})` : r.how;
    if (posesOnly) { done.push(rec); console.log(`[refpair] ${e.id}: eye [${pose.eye.join(', ')}] ${floorTxt}`); continue; }

    await gate(true);
    await page.evaluate(({ p, keepBots }) => {
      window.__harness.applyPose(p);
      if (!keepBots) {
        try { for (const ent of window.World.entities || []) if (ent !== window.World.local && ent?.model?.root) ent.model.root.visible = false; } catch {}
      }
    }, { p: pose, keepBots: !!opt['keep-bots'] });
    await page.evaluate((f) => window.__harness.frames(f), frames);
    const camFov = await page.evaluate(() => window.World?.camera?.fov);
    if (camFov != null && Math.abs(camFov - pose.fov) > 0.05) console.error(`[refpair] WARNING ${e.id}: camera fov ${camFov} != requested ${pose.fov}`);
    const cap = await page.evaluate(pageCapture);
    let shot;
    if (cap.error || cap.blank) {
      console.error(`[refpair] ${e.id}: in-page capture ${cap.error ? 'failed (' + cap.error + ')' : 'was blank'}; falling back to a page screenshot`);
      await page.evaluate(() => { for (const el of document.querySelectorAll('body > *:not(canvas#game)')) el.style.visibility = 'hidden'; });
      shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H }, timeout: 300000 });
    } else shot = fromDataUrl(cap.url);
    await gate(false);
    fs.writeFileSync(path.join(OUT, `ours_${e.id}.png`), shot);

    const key = crypto.randomBytes(8).toString('hex');
    mem.set(key, shot);
    const gameName = e.game === 'cs2' ? 'CS2' : e.game === 'csgo' ? 'CS:GO' : e.game;
    const c = await comp.evaluate(pageCompose, {
      refUrl: `${origin}/__refs/${e.file.split('/').map(encodeURIComponent).join('/')}`,
      oursUrl: `${origin}/__mem/${key}`, W, H,
      caption: { left: `REFERENCE (${gameName})`, right: 'OURS',
        pose: `${e.id}  src (${s.x}, ${s.y})  yaw ${pose.yaw}  pitch ${pose.pitch}  eye y ${pose.eye[1]}  vfov ${pose.fov}` },
    });
    mem.delete(key);
    fs.writeFileSync(path.join(OUT, `pair_${e.id}.png`), fromDataUrl(c.pair));
    const refIsX = crypto.randomInt(2) === 0;
    fs.writeFileSync(path.join(BLIND, `${e.id}_X.png`), fromDataUrl(refIsX ? c.ref : c.ours));
    fs.writeFileSync(path.join(BLIND, `${e.id}_Y.png`), fromDataUrl(refIsX ? c.ours : c.ref));
    rec.blind = { X: refIsX ? 'ref' : 'ours', Y: refIsX ? 'ours' : 'ref' };
    done.push(rec);
    console.log(`[refpair] ✓ ${e.id}: eye [${pose.eye.join(', ')}] ${floorTxt} (${((Date.now() - tE) / 1000).toFixed(1)}s)`);
  } catch (err) {
    try { await gate(false); } catch {}
    errors.push(`${e.id}: ${String(err.message || err).split('\n')[0]}`);
    console.error(`[refpair] ✗ ${e.id}: ${String(err.message || err).split('\n')[0]}`);
  }
  await comp?.close();
} catch (err) {
  if (!errors.length) errors.push(String(err.stack || err));
} finally {
  await browser.close();
  server.close();
}

// ---- manifests ------------------------------------------------------------------------------
if (!posesOnly && done.length) {
  const keyFile = path.join(BLIND, 'key.json');
  let key = {};
  try { key = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch {}
  for (const d of done) key[d.id] = { ...d.blind, ref: d.file, game: d.game, callout: d.callout };
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 1));
  const manFile = path.join(OUT, 'refpair.json');
  let man = {};
  try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch {}
  for (const d of done) { const { blind, ...rest } = d; man[d.id] = { ...rest, when: new Date().toISOString() }; }
  fs.writeFileSync(manFile, JSON.stringify(man, null, 1));
  console.log(`[refpair] wrote ${done.length} pair(s) to ${OUT} (blind key: ${keyFile})`);
}
if (opt['write-poses'] && done.length) {
  // Named harness poses (Three-space eye) — merge into tools/poses.json to use with shot.mjs.
  const pf = path.resolve(String(opt['write-poses']));
  let poses = {};
  try { poses = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch {}
  const DIRN = { 0: 'east', 90: 'north', 180: 'west', 270: 'south' };
  for (const d of done) {
    const dir = DIRN[((d.pose.yaw % 360) + 360) % 360] || `yaw ${d.pose.yaw}`;
    const p = { eye: d.pose.eye, pitch: d.pose.pitch, yaw: d.pose.yaw, fov: d.pose.fov,
      desc: `REF ${d.game} ${d.callout} looking ${dir} (Source ${d.source.x}, ${d.source.y}); pair: ${d.file}`,
      ref: d.file };
    poses[`ref_${d.id}`] = p;
    if (d.primary && d.game === 'csgo') poses[`ref_${d.callout}`] = p;
  }
  const sorted = Object.fromEntries(Object.entries(poses).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(pf, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`[refpair] wrote ${Object.keys(sorted).length} pose(s) to ${pf}`);
}

let exitCode = 0;
if (errors.length) {
  const uniq = [...new Set(errors)];
  console.error(`\n${uniq.length} ERROR(S):\n` + uniq.slice(0, 30).map((e) => '  ✗ ' + e).join('\n'));
  exitCode = 2;
}
if (floorFailures.length) {
  console.error(`\n${floorFailures.length} entr${floorFailures.length === 1 ? 'y' : 'ies'} skipped — no usable floor:\n` + floorFailures.map((f) => '  ✗ ' + f).join('\n'));
  if (!exitCode) exitCode = 3;
}
process.exit(exitCode);
