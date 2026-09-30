// Quick in-page diagnostic (no screenshot): is the map in the scene and in the camera frustum?
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKDIR = '/tmp/dust2-shot-locks'; fs.mkdirSync(LOCKDIR, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let lock = null;
while (!lock) {
  for (let i = 0; i < 2 && !lock; i++) { const f = path.join(LOCKDIR, `slot${i}.lock`); try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); lock = f; } catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } } }
  if (!lock) await new Promise((r) => setTimeout(r, 1000));
}
process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock); } catch {} });
const server = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });
console.log(await page.evaluate(async () => {
  const H = window.__harness; H.applyPose('t_spawn'); await H.frames(2);
  const cam = World.camera, root = World.map?.root;
  let meshes = 0, visible = 0; root?.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) visible++; } });
  const r = World.renderer.renderer || World.renderer.gl; const info = r?.info?.render || {};
  const THREE = await import('three');
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  let inFr = 0; root?.traverse((o) => { if (o.isMesh && o.geometry) { o.geometry.boundingSphere || o.geometry.computeBoundingSphere(); const s = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld); if (fr.intersectsSphere(s)) inFr++; } });
  return JSON.stringify({ rootInScene: !!root && root.parent === World.scene, meshes, visible, inFrustum: inFr, calls: info.calls, tris: info.triangles,
    camPos: cam.position.toArray().map(Math.round), camMW: cam.matrixWorld.elements.slice(12, 15).map(Math.round), near: cam.near, far: cam.far, fov: cam.fov, aspect: cam.aspect,
    local: World.local && World.local.origin.toArray().map(Math.round), override: !!World.cameraOverride, bootFailures: World.bootFailures });
}));
console.log('errors:', errs.slice(0, 5));
await browser.close(); server.close();
