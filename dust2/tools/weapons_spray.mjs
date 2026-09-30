// Spray chart: fire full magazines at a wall 400u (10 m) away through the real WeaponSystem +
// Player (spread and all), then draw the impact scatter + the no-spread path, CS spray-chart
// style, and screenshot it with Playwright.
//   node --import ./tools/three-resolve.mjs tools/weapons_spray.mjs [--out /tmp/weapons/spray.png] [--keys ak47,m4a4]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setupWorld, makePlayer, stepSeconds, step, collect, World, V } from './weapons_sim.mjs';
import { IN_ATTACK } from '../src/core/input.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = arg('out', '/tmp/weapons/spray.png');
const KEYS = arg('keys', 'ak47,m4a4,m4a1s,galil,famas,aug,sg553,ump45,mp9,mac10,p90,negev').split(',');
const RUNS = +arg('runs', 3);
const DIST = 400;

const { W } = await setupWorld({ boxes: [{ min: [DIST, -200, -1200], max: [DIST + 64, 900, 1200], surface: 'concrete' }] });

function spray(key, nospread, seedSalt) {
  World.entities.length = 0;
  World.cvar.weapon_accuracy_nospread = nospread ? 1 : 0;
  const p = makePlayer('T', V(0, 0, 0), { name: `s${seedSalt}` });
  p._wpn.seed = 1234567 + seedSalt * 7919;
  p.lastCmd.buttons = 1 << 2; // crouch: the canonical spray-transfer stance
  W.give(p, key); W.switchTo(p, key); stepSeconds(1.6);
  const pts = [];
  const off = World.on('impact', (e) => { if (!e.exit && e.surface !== 'flesh' && e.point.x > DIST - 2) pts.push([e.point.z, e.point.y - (p.eyeHeight + p.origin.y)]); });
  const def = p.active.def;
  p.lastCmd.buttons |= IN_ATTACK;
  stepSeconds(def.mag * def.cycleTime + 0.05);
  p.lastCmd.buttons &= ~IN_ATTACK;
  off();
  World.cvar.weapon_accuracy_nospread = 0;
  return { pts: pts.slice(0, def.mag), name: def.name, mag: def.mag, rpm: def.rpm };
}

const data = [];
for (const key of KEYS) {
  const path0 = spray(key, true, 0);
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(spray(key, false, r + 1).pts);
  data.push({ key, name: path0.name, rpm: path0.rpm, path: path0.pts, runs });
}

// ---- draw with a real canvas (Playwright) ----
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const cols = Math.min(4, data.length), rows = Math.ceil(data.length / cols);
const PW = 340, PH = 540, S = 4.2; // px per inch on the wall (10 m)
const html = `<!doctype html><html><body style="margin:0;background:#15171a"><canvas id=c width=${cols * PW} height=${rows * PH}></canvas>
<script>
const D = ${JSON.stringify(data)};
const c = document.getElementById('c'), g = c.getContext('2d');
g.fillStyle = '#15171a'; g.fillRect(0, 0, c.width, c.height);
D.forEach((d, i) => {
  const ox = (i % ${cols}) * ${PW}, oy = Math.floor(i / ${cols}) * ${PH};
  g.save(); g.translate(ox, oy);
  g.fillStyle = '#c9b48f'; g.fillRect(6, 6, ${PW} - 12, ${PH} - 12);         // plaster wall
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1;
  for (let x = 6; x < ${PW} - 6; x += 12 * ${S}) { g.beginPath(); g.moveTo(x, 6); g.lineTo(x, ${PH} - 6); g.stroke(); }
  for (let y = ${PH} - 60; y > 6; y -= 12 * ${S}) { g.beginPath(); g.moveTo(6, y); g.lineTo(${PW} - 6, y); g.stroke(); }
  const cx = ${PW} / 2, cy = ${PH} - 60;
  const P = (p) => [cx + p[0] * ${S}, cy - p[1] * ${S}];
  // crosshair where you aimed
  g.strokeStyle = '#1aff4a'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx - 9, cy); g.lineTo(cx - 3, cy); g.moveTo(cx + 3, cy); g.lineTo(cx + 9, cy);
  g.moveTo(cx, cy - 9); g.lineTo(cx, cy - 3); g.moveTo(cx, cy + 3); g.lineTo(cx, cy + 9); g.stroke();
  // real sprays (with spread): bullet holes
  d.runs.forEach((run, r) => run.forEach((p) => { const [x, y] = P(p);
    g.fillStyle = 'rgba(25,20,15,0.85)'; g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fill();
    g.fillStyle = 'rgba(90,70,50,0.5)'; g.beginPath(); g.arc(x, y, 4.2, 0, 7); g.fill(); }));
  // the pattern (no spread) as a numbered path
  g.strokeStyle = 'rgba(210,30,30,0.9)'; g.lineWidth = 1.5; g.beginPath();
  d.path.forEach((p, k) => { const [x, y] = P(p); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  g.font = 'bold 9px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  d.path.forEach((p, k) => { const [x, y] = P(p);
    g.fillStyle = k === 0 ? '#ffd23a' : '#d21e1e'; g.beginPath(); g.arc(x, y, 5.5, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.fillText(String(k + 1), x, y + 0.5); });
  g.fillStyle = '#111'; g.font = 'bold 15px sans-serif'; g.textAlign = 'left';
  g.fillText(d.name + '  ' + d.rpm + ' rpm', 14, 22);
  g.font = '11px sans-serif'; g.fillText('10 m, crouched, ' + d.runs.length + ' mags + pattern', 14, 38);
  g.fillText('grid = 12 in', 14, 52);
  g.restore();
});
</script></body></html>`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: cols * PW, height: rows * PH } });
await page.setContent(html);
await page.locator('#c').screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
for (const d of data) {
  const top = Math.max(...d.path.map((p) => p[1]));
  const xs = d.path.map((p) => p[0]);
  console.log(`${d.key.padEnd(8)} climb ${(top).toFixed(1)}in  width ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}in  holes ${d.runs.map((r) => r.length).join('/')}`);
}
