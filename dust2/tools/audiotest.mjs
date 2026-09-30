#!/usr/bin/env node
// Analytic verification of the procedural audio (we can't listen, so we measure).
//
//   node tools/audiotest.mjs                 full run: stats for every sound, key PNG/WAVs, browser checks
//   node tools/audiotest.mjs --only ak47,awp  stats + PNG/WAV only for names matching these substrings
//   node tools/audiotest.mjs --no-browser     skip the Playwright part
//   node tools/audiotest.mjs --out /tmp/audio
//   node tools/audiotest.mjs --only xyz --no-browser --game   boot the real game with ?harness&audio and fire events
//
// Node renders the synthesis directly (the same modules the Worker runs; checked bit-identical
// against an in-browser render). The Playwright page (tools/audiolab.html) then boots the real
// runtime on an OfflineAudioContext for spatial / occlusion / limiter / loudness checks.
// Exit code 2 when a check fails.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stats, spectrogramPNG, montagePNG, writeWav, truePeak, loudness, mono } from './audio_analyze.mjs';
import { soundNames, soundDef, renderSound } from '../src/audio/synth/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const k = args[i].slice(2), n = args[i + 1];
  opt[k] = n === undefined || n.startsWith('--') ? true : (i++, n);
}
const OUT = opt.out || '/tmp/audio';
fs.mkdirSync(path.join(OUT, 'png'), { recursive: true });
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? '  ok ' : '  FAIL'} ${msg}`); if (!ok) failures.push(msg); };
const db = (v) => 20 * Math.log10(Math.max(1e-12, v));

// ---- 1. every sound: timing, level, spectral stats -----------------------------------------
const KEY = [
  'weapon_ak47_fire', 'weapon_ak47_fire_2d', 'weapon_ak47_fire_far', 'weapon_m4a4_fire', 'weapon_m4a1s_fire', 'weapon_usp_fire',
  'weapon_awp_fire', 'weapon_awp_fire_far', 'weapon_deagle_fire', 'weapon_glock_fire', 'weapon_nova_fire', 'weapon_negev_fire',
  'footstep_sand', 'footstep_metal', 'footstep_concrete', 'footstep_metalgrate', 'footstep_wood',
  'hit_head_helmet', 'hit_head', 'hit_body', 'impact_concrete', 'impact_metal', 'bomb_beep', 'bomb_plant', 'he_explode', 'flash_pop',
  'tinnitus', 'smoke_pop', 'molotov_break', 'stinger_ct_win', 'stinger_t_win', 'stinger_mvp', 'stinger_bomb10', 'radio_go', 'amb_wind',
  'knife_slash', 'deploy_knife', 'wpn_magin_ak', 'wpn_boltfwd_rifle', 'shell_rifle_hard',
];
const only = opt.only ? String(opt.only).split(',') : null;
const names = soundNames().filter((n) => !only || only.some((o) => n.includes(o)));
const table = {};
let totMs = 0, totBytes = 0;
const tierMs = {};
console.log(`\n== synthesis: ${names.length} sounds ==`);
for (const n of names) {
  const r = renderSound(n);
  const d = soundDef(n);
  totMs += r.ms; tierMs[d.tier] = (tierMs[d.tier] || 0) + r.ms;
  totBytes += r.vars.reduce((a, chs) => a + chs.reduce((x, c) => x + c.length * 4, 0), 0);
  const chs = r.vars[0];
  const finite = r.vars.every((v) => v.every((c) => c.every(Number.isFinite)));
  if (!finite) check(false, `${n}: non-finite samples`);
  if (n.startsWith('ir_')) { table[n] = { ms: Math.round(r.ms), dur: +(chs[0].length / r.sr).toFixed(2) }; continue; }
  const st = stats(chs, r.sr);
  st.ms = Math.round(r.ms); st.vars = r.vars.length; st.ch = chs.length; st.sr = r.sr;
  // variations must actually differ (not the same buffer twice)
  if (r.vars.length > 1) {
    const a = r.vars[0][0], b = r.vars[1][0];
    let diff = 0; for (let i = 0; i < Math.min(a.length, b.length, 20000); i++) diff += Math.abs(a[i] - b[i]);
    st.varDiff = +diff.toFixed(1);
  }
  table[n] = st;
  if (KEY.includes(n) || (only && !n.endsWith('_2d'))) {
    const maxDur = n.startsWith('stinger') || n === 'amb_wind' ? null : Math.min(st.dur, n.includes('_far') || n.includes('awp') || n.includes('explode') ? 3 : 1.6);
    spectrogramPNG(chs, r.sr, path.join(OUT, 'png', `${n}.png`), `${n}  peak ${st.peakDb} dB  crest ${st.crestDb} dB  centroid ${st.centroidHz} Hz (150ms: ${st.centroid150Hz})`, { maxDur });
    if (/_fire$/.test(n) || /_fire_(2d|far)$/.test(n)) spectrogramPNG(chs.map((c) => c.slice(0, Math.round(0.12 * r.sr))), r.sr, path.join(OUT, 'png', `${n}_zoom.png`), `${n} first 120 ms`);
    writeWav(path.join(OUT, `${n}.wav`), n === 'amb_wind' ? chs.map((c) => c.slice(0, r.sr * 12)) : chs, r.sr);
  }
}
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(table, null, 1));
// side-by-side contact sheets of the signature sounds
const sheet = (list, file) => {
  const items = list.filter((x) => soundDef(x[0])).map(([n, maxDur]) => { const r = renderSound(n); const st = table[n] || stats(r.vars[0], r.sr); return { chs: r.vars[0], sr: r.sr, maxDur, title: `${n}  cen150 ${st.centroid150Hz} HZ` }; });
  if (items.length) montagePNG(items, path.join(OUT, 'png', file));
};
// one-file demo reel of the signature sounds (stereo, 48 kHz) for quick listening
if (!only) {
  const reel = ['weapon_ak47_fire_2d', 'weapon_ak47_fire', 'weapon_ak47_fire_far', 'weapon_m4a4_fire', 'weapon_m4a1s_fire', 'weapon_usp_fire', 'weapon_glock_fire',
    'weapon_deagle_fire', 'weapon_awp_fire', 'weapon_nova_fire', 'footstep_sand', 'footstep_concrete', 'footstep_metal', 'footstep_wood', 'hit_head_helmet', 'hit_head',
    'hit_body', 'impact_concrete', 'impact_metal', 'bomb_beep', 'he_explode', 'flash_pop', 'knife_slash', 'wpn_magout_ak', 'wpn_magin_ak', 'wpn_boltfwd_ak', 'stinger_ct_win'];
  const SR = 48000, gap = Math.round(0.35 * SR);
  const parts = reel.filter((n) => soundDef(n)).map((n) => renderSound(n));
  const up = (c, sr) => { if (sr === SR) return c; const o = new Float32Array(Math.round(c.length * SR / sr)); for (let i = 0; i < o.length; i++) { const x = i * sr / SR, k = Math.floor(x), f = x - k; o[i] = (c[k] || 0) * (1 - f) + (c[k + 1] || 0) * f; } return o; };
  const total = parts.reduce((a, r) => a + Math.round(r.vars[0][0].length * SR / r.sr) + gap, 0);
  const L = new Float32Array(total), R = new Float32Array(total);
  let at = 0;
  for (const r of parts) {
    const ch = r.vars[0].map((c) => up(c, r.sr));
    L.set(ch[0], at); R.set(ch[1] || ch[0], at);
    at += ch[0].length + gap;
  }
  for (const c of [L, R]) for (let i = 0; i < c.length; i++) c[i] *= 0.7;
  writeWav(path.join(OUT, 'demo_reel.wav'), [L, R], SR);
  console.log(`demo reel: ${OUT}/demo_reel.wav (${(total / SR).toFixed(1)} s: ${reel.join(', ')})`);
}
if (!only) {
  sheet([['weapon_ak47_fire', 1.2], ['weapon_m4a4_fire', 1.2], ['weapon_m4a1s_fire', 0.6], ['weapon_awp_fire', 2.4], ['weapon_glock_fire', 0.8], ['weapon_deagle_fire', 1.2], ['weapon_ak47_fire_far', 1.8], ['weapon_nova_fire', 1.4]], 'sheet_guns.png');
  sheet([['footstep_sand', 0.3], ['footstep_metal', 0.5], ['footstep_concrete', 0.3], ['footstep_wood', 0.3], ['hit_head_helmet', 0.5], ['hit_head', 0.35], ['bomb_beep', 0.15], ['he_explode', 2.8]], 'sheet_foley.png');
}
console.log(`rendered in ${(totMs / 1000).toFixed(2)} s CPU (by tier ms: ${JSON.stringify(Object.fromEntries(Object.entries(tierMs).map(([k, v]) => [k, Math.round(v)])))}), ${(totBytes / 1e6).toFixed(1)} MB PCM`);
const row = (n) => { const s = table[n]; if (!s) return; console.log(`  ${n.padEnd(28)} ${String(s.dur).padStart(5)}s pk ${String(s.peakDb).padStart(5)} rms50 ${String(s.rms50Db).padStart(6)} crest ${String(s.crestDb).padStart(5)} cen ${String(s.centroidHz).padStart(5)} cen150 ${String(s.centroid150Hz).padStart(5)} bands ${JSON.stringify(s.bands)}`); };
console.log('\n== key sounds ==');
for (const n of KEY) row(n);

// ---- 2. analytic expectations for the signature sounds -------------------------------------
if (!only) {
  console.log('\n== signature checks ==');
  const T = table;
  const badPk = Object.entries(T).filter(([, s]) => s.peakDb != null && !(s.peakDb <= -0.9 && s.peakDb > -1.5)).map(([n]) => n);
  check(!badPk.length, `every sound normalised to -1 dBFS peak (off: ${badPk.join(', ') || 'none'})`);
  const same = Object.entries(T).filter(([, s]) => s.varDiff === 0).map(([n]) => n);
  check(!same.length, `variations differ (identical: ${same.join(', ') || 'none'})`);
  check(T.weapon_ak47_fire.attackMs < 3, `AK attack is near-instant (${T.weapon_ak47_fire.attackMs} ms)`);
  check(T.weapon_ak47_fire.bands.low + T.weapon_ak47_fire.bands.mid + T.weapon_ak47_fire.bands.himid > 60, 'AK energy mostly 100 Hz-6 kHz');
  check(T.weapon_m4a4_fire.centroid150Hz > T.weapon_ak47_fire.centroid150Hz * 1.25, `M4A4 brighter than AK (${T.weapon_m4a4_fire.centroid150Hz} vs ${T.weapon_ak47_fire.centroid150Hz} Hz)`);
  check(T.weapon_m4a1s_fire.bands.high < 8 && T.weapon_m4a1s_fire.dur < T.weapon_m4a4_fire.dur * 0.7, 'M4A1-S: no HF crack, short tail');
  check(T.weapon_awp_fire.dur > T.weapon_ak47_fire.dur * 1.5 && T.weapon_awp_fire.bands.sub > T.weapon_ak47_fire.bands.sub, 'AWP: longer tail, more sub than AK');
  check(T.weapon_glock_fire.centroid150Hz > T.weapon_deagle_fire.centroid150Hz, 'Glock lighter than Deagle');
  check(T.weapon_ak47_fire_far.centroidHz < T.weapon_ak47_fire.centroidHz * 0.7, 'far AK is darker than close AK');
  check(T.footstep_metal.decay40Ms > T.footstep_sand.decay40Ms * 2, `metal footstep rings (${T.footstep_metal.decay40Ms} ms) far longer than sand (${T.footstep_sand.decay40Ms} ms)`);
  check(T.footstep_sand.centroidHz > 2000 && T.footstep_concrete.centroidHz > 900, `sand crunches high (${T.footstep_sand.centroidHz} Hz), concrete clicks (${T.footstep_concrete.centroidHz} Hz)`);
  check(T.hit_body.bands.sub < 45, `body hit is a thud, not sub rumble (sub ${T.hit_body.bands.sub}%)`);
  check(T.hit_head_helmet.decay40Ms > T.hit_head.decay40Ms && T.hit_head_helmet.centroidHz > 2500, `helmet tink: narrow high partial (${T.hit_head_helmet.centroidHz} Hz) that rings longer than the no-helmet dink`);
  check(T.bomb_beep.dur < 0.3 && T.bomb_beep.centroidHz > 1500, 'C4 beep short and high');
  check(T.he_explode.dur > 2 && T.he_explode.bands.sub + T.he_explode.bands.low > 50, 'HE: long, low-heavy');
  check(T.tinnitus.dur > 3 && Math.abs(T.tinnitus.centroidHz - 3500) < 800, 'tinnitus ~3.5 kHz tone, multi-second');
}

// ---- 3. browser: runtime graph checks via Playwright -----------------------------------------
if (!opt['no-browser'] && !only && !opt['game-only']) {
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/tools/audiolab.html?test`);
    await page.waitForFunction(() => window.__lab, null, { timeout: 30000 });
    const dec = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

    console.log('\n== browser synthesis == node synthesis ==');
    const probe = ['weapon_ak47_fire', 'footstep_sand', 'hit_head_helmet', 'bomb_beep'];
    const cs = await page.evaluate((n) => window.__lab.checksums(n), probe);
    for (const n of probe) {
      const r = renderSound(n);
      let s = 0; for (const c of r.vars[0]) for (let i = 0; i < c.length; i++) s += c[i] * ((i % 7) + 1);
      check(Math.abs(cs[n].sum - s) < 1e-3 * Math.max(1, Math.abs(s)) && cs[n].len === r.vars[0][0].length, `${n} browser render matches node (${cs[n].ms.toFixed(0)} ms in page)`);
    }

    console.log('\n== boot: worker synthesis timing (real AudioContext) ==');
    const bt = await page.evaluate(() => window.__lab.bootTiming());
    console.log('  ', JSON.stringify(bt));
    check(bt.workerUsed, 'synthesis runs in a Worker');
    check(bt.ctorMs < 20, `Audio constructor is cheap (${bt.ctorMs.toFixed(1)} ms; graph built on first gesture in ${bt.unlockMs.toFixed(1)} ms)`);
    check(bt.priorityMs < 1500, `priority set (${bt.prioritySounds} sounds) ready in ${Math.round(bt.priorityMs)} ms (< 1500)`);
    check(bt.p95LagMs < 8 && bt.worstMainThreadLagMs < 120, `main thread stays responsive during background synthesis (p95 lag ${bt.p95LagMs.toFixed(1)} ms, worst ${bt.worstMainThreadLagMs.toFixed(1)} ms)`);

    const off = async (script, o) => {
      const r = await page.evaluate(([s, oo]) => window.__lab.offline(s, oo), [script, o]);
      return { ...r, channels: r.channels.map(dec) };
    };
    const rmsDb = (c, a = 0, b = c.length) => { let s = 0; for (let i = a; i < b; i++) s += c[i] * c[i]; return db(Math.sqrt(s / Math.max(1, b - a))); };

    console.log('\n== listener orientation vs CONTRACT angleVectors ==');
    const ang = await page.evaluate(() => window.__lab.angles());
    check(ang.worst < 1e-4, `listener forward/up match angleVectors() (max error ${ang.worst.toExponential(1)})`);

    console.log('\n== spatialisation (HRTF), facing north ==');
    const right = await off('single', { name: 'impact_concrete', pos: [300, 64, 0], dur: 1 });
    const left = await off('single', { name: 'impact_concrete', pos: [-300, 64, 0], dur: 1 });
    const lr = (r) => rmsDb(r.channels[1]) - rmsDb(r.channels[0]);
    check(lr(right) > 3, `source east (+X) is louder in the RIGHT ear by ${lr(right).toFixed(1)} dB`);
    check(lr(left) < -3, `source west (-X) is louder in the LEFT ear by ${(-lr(left)).toFixed(1)} dB`);

    console.log('\n== distance model ==');
    const lv = [];
    for (const d of [150, 400, 800, 1050, 1250]) {
      const r = await off('single', { name: 'footstep_concrete', pos: [0, 64, -d], dur: 1, occlude: false });
      lv.push([d, +rmsDb(mono(r.channels.slice(0, 2))).toFixed(1)]);
    }
    console.log('   footstep level by distance', JSON.stringify(lv));
    check(lv[0][1] > lv[1][1] && lv[1][1] > lv[2][1], 'footsteps fall off with distance');
    check(lv[3][1] > -90 && lv[4][1] < -95, 'footsteps audible at ~1050u, silent beyond ~1100u (CS radius)');
    const gunFar = await off('single', { name: 'weapon_ak47_fire', pos: [0, 64, -3200], dur: 3, occlude: false });
    check(rmsDb(mono(gunFar.channels.slice(0, 2))) > -70, `AK still clearly audible at 3200u (${rmsDb(mono(gunFar.channels.slice(0, 2))).toFixed(1)} dB)`);

    console.log('\n== occlusion (virtual wall) ==');
    const clear = await off('single', { name: 'weapon_ak47_fire', pos: [0, 64, -700], dur: 2 });
    const walled = await off('single', { name: 'weapon_ak47_fire', pos: [0, 64, -700], dur: 2, wall: true });
    const sc = stats(clear.channels.slice(0, 2), 48000), sw = stats(walled.channels.slice(0, 2), 48000);
    check(rmsDb(mono(clear.channels.slice(0, 2))) - rmsDb(mono(walled.channels.slice(0, 2))) > 5, `wall attenuates (${(rmsDb(mono(clear.channels.slice(0, 2))) - rmsDb(mono(walled.channels.slice(0, 2)))).toFixed(1)} dB)`);
    check(sw.centroid150Hz < sc.centroid150Hz * 0.6 && sw.centroid150Hz > 150, `wall muffles but keeps the weapon identifiable (centroid ${sc.centroid150Hz} -> ${sw.centroid150Hz} Hz)`);

    console.log('\n== full mix through the runtime graph ==');
    const mix = await off('mix', { dur: 14 });
    const M = mix.channels.slice(0, 2);
    const tp = truePeak(M);
    check(db(tp) < -1, `master true peak ${db(tp).toFixed(2)} dBFS (< -1)`);
    const lu = loudness(M, 48000);
    console.log('   master loudness', JSON.stringify(lu));
    const busL = {};
    mix.buses.forEach((b, i) => { busL[b] = loudness([mix.channels[2 + i]], 48000); });
    console.log('   bus loudness (pre-master):', Object.entries(busL).map(([b, l]) => `${b} ${l.integrated} LUFS (mom.max ${l.momentaryMax})`).join(' | '));
    check(busL.weapons.momentaryMax - busL.foley.momentaryMax > 6 && busL.weapons.momentaryMax - busL.foley.momentaryMax < 26, 'weapons dominate footsteps but footsteps stay in range');
    check(busL.ambience.integrated < busL.weapons.integrated - 10, 'ambience bed sits well under the action');
    check(Math.abs(busL.music.momentaryMax - busL.weapons.momentaryMax) < 12, 'stinger level sits near the weapons level');
    writeWav(path.join(OUT, 'scene_mix.wav'), M, 48000);
    spectrogramPNG(M, 48000, path.join(OUT, 'png', 'scene_mix.png'), `runtime mix: true peak ${db(tp).toFixed(1)} dBFS, ${lu.integrated} LUFS`, { w: 1400 });
    console.log('   stats', JSON.stringify(mix.stats));
  } catch (err) {
    failures.push(String(err.stack || err));
    console.error(err);
  } finally {
    await browser.close();
    server.close();
  }
  for (const e of [...new Set(errors)]) check(false, `console error: ${e}`);
}

// ---- 4. in-game: boot the real game with ?harness&audio and fire World events ---------------
if (opt.game) {
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
  // share tools/shot.mjs's render-slot semaphore (SwiftShader is CPU bound)
  const LOCKDIR = '/tmp/dust2-shot-locks', SLOTS = +process.env.DUST2_SHOT_SLOTS || 2;
  fs.mkdirSync(LOCKDIR, { recursive: true });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let lock = null;
  while (!lock) {
    for (let i = 0; i < SLOTS && !lock; i++) {
      const f = path.join(LOCKDIR, `slot${i}.lock`);
      try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); lock = f; }
      catch { const pid = +fs.readFileSync(f, 'utf8').trim(); if (!pid || !alive(pid)) { try { fs.unlinkSync(f); } catch {} } }
    }
    if (!lock) await new Promise((r) => setTimeout(r, 1000));
  }
  process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} });
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  console.log('\n== in-game (index.html?harness&audio) ==');
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?harness=1&audio=1&pose=t_spawn`);
    await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 500 });
    const r = await page.evaluate(async () => {
      const W = window.World, A = W.audio;
      const out = { hasAudio: !!A, enabled: A?.enabled };
      if (!A?.enabled) return out;
      await A.ready;
      const want = ['weapon_ak47_fire', 'weapon_ak47_fire_far', 'weapon_glock_fire_2d', 'footstep_sand', 'impact_concrete', 'hit_head_helmet', 'he_explode', 'bomb_beep', 'bomb_arm', 'radio_go', 'amb_wind', 'ir_open'];
      A.preload(want);
      const t0 = performance.now();
      while (want.some((n) => !A.bank.has(n)) && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200));
      const cam = W.camera.position;
      const THREE_V = cam.constructor;
      const bot = { origin: new THREE_V(cam.x + 600, cam.y - 64, cam.z - 300), eyeHeight: 64, alive: true, helmet: true, armor: 100, velocity: new THREE_V(), onGround: true, isBot: true };
      const before = A.stats().played;
      W.emit('round_start', { round: 1 });
      W.emit('fire', { ent: bot, weapon: 'ak47', seed: 1 });
      W.emit('fire', { ent: W.local, weapon: 'glock', seed: 2 });
      W.emit('footstep', { ent: bot, surface: 'sand', volume: 1 });
      W.emit('impact', { point: new THREE_V(cam.x + 100, cam.y, cam.z - 200), surface: 'concrete' });
      W.emit('damage', { victim: bot, hitgroup: 1, amount: 100, point: new THREE_V(cam.x + 600, cam.y, cam.z - 300) });
      W.emit('he_detonate', { pos: new THREE_V(cam.x - 800, cam.y - 50, cam.z - 900) });
      W.emit('bomb_planted', { site: 'A', pos: new THREE_V(cam.x + 300, cam.y - 60, cam.z), timer: 40 });
      await new Promise((r) => setTimeout(r, 2500));
      const st = A.stats();
      W.emit('bomb_defused', { site: 'A' });
      return { ...out, playedDuring: st.played - before, stats: st, ctx: A.ctx.state, listener: [A.listenerPos.x, A.listenerPos.y, A.listenerPos.z].map(Math.round) };
    });
    console.log('  ', JSON.stringify(r));
    check(r.enabled, 'audio runs inside the game with ?audio');
    check(r.playedDuring >= 7, `game events produced sounds (${r.playedDuring} voices started)`);
    check(r.ctx === 'running', `context running (${r.ctx})`);
  } catch (err) { failures.push(String(err.stack || err)); console.error(err); }
  finally { await browser.close(); server.close(); }
  for (const e of [...new Set(errors)]) check(false, `game console error: ${e}`);
}

console.log(`\nwrote ${OUT}/stats.json, ${OUT}/png/*.png, ${OUT}/*.wav`);
if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(2); }
console.log('\nall checks passed');
