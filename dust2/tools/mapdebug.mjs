#!/usr/bin/env node
// Map agent debug driver: boots the real game in harness mode, applies a pose and prints
// diagnostics (scene / camera / map meshes / centre pixel probes). Shares the render-slot
// semaphore with shot.mjs.
//   node tools/mapdebug.mjs --pose long_a [--eval "..."] [--out x.png]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2); const opt = { eval: [] };
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2), n = a[i + 1]; const v = n && !n.startsWith('--') ? (i++, n) : true; if (k === 'eval') opt.eval.push(v); else opt[k] = v; }
const LOCKDIR = '/tmp/dust2-shot-locks'; fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let lock = null;
while (!lock) {
  for (let i = 0; i < 2 && !lock; i++) { const f = path.join(LOCKDIR, `slot${i}.lock`); try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); lock = f; } catch { const p = +fs.readFileSync(f, 'utf8'); if (!p || !alive(p)) try { fs.unlinkSync(f); } catch {} } }
  if (!lock) await new Promise((r) => setTimeout(r, 1000));
}
process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
try {
  const page = await browser.newPage({ viewport: { width: +opt.w || 960, height: +opt.h || 540 } });
  page.on('console', (m) => { if (m.type() === 'error' || opt.verbose) console.log(`[page:${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const q = new URLSearchParams({ harness: '1' }); if (opt.quality) q.set('quality', opt.quality);
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?${q}`);
  await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 500 });
  for (const e of opt.eval) await page.evaluate(e);
  await page.evaluate((n) => window.__harness.applyPose(n), opt.pose || 'long_a');
  const t0 = Date.now();
  await page.evaluate(() => window.__harness.frames(3));
  console.log('3 frames in', Date.now() - t0, 'ms');
  const info = await page.evaluate(() => {
    const W = window.World, cam = W.camera, root = W.map?.root;
    const out = { cam: cam.position.toArray().map(Math.round), camFar: cam.far, camNear: cam.near, sceneChildren: W.scene.children.length };
    out.rootInScene = !!root && root.parent === W.scene; out.rootVisible = root?.visible;
    let meshes = 0, vis = 0; const mats = {};
    root?.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) vis++; const m = o.material; mats[m.name || m.type] = { vc: m.vertexColors, tr: m.transparent, op: m.opacity, side: m.side, cw: m.colorWrite, dw: m.depthWrite, map: !!m.map, col: m.color?.getHexString() }; } });
    out.meshes = meshes; out.visible = vis; out.mats = Object.fromEntries(Object.entries(mats).slice(0, 6));
    const r = W.renderer.renderer; out.info = { calls: r.info.render.calls, tris: r.info.render.triangles };
    out.bounds = W.renderer.bounds ? { min: W.renderer.bounds.min?.toArray?.(), max: W.renderer.bounds.max?.toArray?.() } : null;
    return out;
  });
  console.log(JSON.stringify(info, null, 1));
  if (opt.out) { const d = await page.evaluate(() => document.getElementById('game').toDataURL('image/png')); fs.writeFileSync(opt.out, Buffer.from(d.split(',')[1], 'base64')); console.log('wrote', opt.out); }
} finally { await browser.close(); server.close(); }
process.exit(0);
