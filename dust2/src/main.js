// Boot + main loop. Owned by the lead. Feature agents: do not edit — see CONTRACT.md.
//
// Every subsystem is loaded with a guarded dynamic import so one broken module can't take
// the whole game down while agents work in parallel. Failures surface in the console and
// in the boot overlay, and the screenshot harness treats them as hard errors.
import * as THREE from 'three';
import { World } from './core/world.js';
import { defCvar } from './core/cvars.js';
import { Input, newCmd } from './core/input.js';
import { Dbg } from './core/debug.js';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
World.harness = HARNESS;
World.params = params;

defCvar('host_timescale', 1, 0, 4, 'simulation speed');
defCvar('fps_max', 0, 0, 1000, '0 = uncapped (vsync)');
defCvar('r_drawviewmodel', 1, 0, 1, 'draw first-person weapon');

const bootFill = document.getElementById('boot-fill');
const bootStatus = document.getElementById('boot-status');
const status = (msg, frac) => {
  if (bootStatus) bootStatus.textContent = msg;
  if (bootFill && frac != null) bootFill.style.width = `${Math.round(frac * 100)}%`;
  Dbg.log('[boot]', msg);
};

const failures = [];
async function load(path, what) {
  try { return await import(path); }
  catch (err) {
    failures.push(`${what}: ${err.message}`);
    console.error(`[boot] failed to load ${what} (${path})`, err);
    return null;
  }
}
async function guard(what, fn, fallback = null) {
  try { return await fn(); }
  catch (err) {
    failures.push(`${what}: ${err.message}`);
    console.error(`[boot] ${what} threw`, err);
    return fallback;
  }
}

async function boot() {
  const canvas = document.getElementById('game');

  status('Starting renderer…', 0.05);
  const R = await load('./engine/renderer.js', 'renderer');
  const renderer = new R.RenderPipeline(canvas);
  World.renderer = renderer;
  World.scene = renderer.scene;
  World.camera = renderer.camera;
  World.viewScene = renderer.viewScene;
  World.viewCamera = renderer.viewCamera;
  renderer.setQuality(params.get('quality') || World.quality);

  World.input = new Input(canvas);

  status('Generating materials…', 0.15);
  const T = await load('./art/textures.js', 'textures');
  if (T?.TextureLib?.ready) await guard('textures.ready', () => T.TextureLib.ready);
  World.textures = T?.TextureLib || null;

  status('Building Dust II…', 0.35);
  const M = await load('./map/dust2.js', 'map');
  const map = M ? await guard('buildDust2', () => M.buildDust2()) : null;
  if (!map) throw new Error('Map failed to build — see console.');
  World.map = map;
  World.collision = map.collision;
  World.scene.add(map.root);
  await guard('renderer.setMap', () => renderer.setMap?.(map));

  status('Baking navigation…', 0.55);
  const N = await load('./ai/navmesh.js', 'navmesh');
  World.nav = N ? await guard('nav build', () => N.buildNavMesh(map)) : null;

  status('Loading audio…', 0.62);
  const A = await load('./audio/audio.js', 'audio');
  World.audio = A ? await guard('audio', () => new A.Audio()) : null;

  status('Loading effects…', 0.68);
  const F = await load('./fx/index.js', 'fx');
  World.fx = F ? await guard('fx', () => new F.FX()) : null;

  status('Loading weapons…', 0.75);
  const W = await load('./weapons/system.js', 'weapons');
  World.weapons = W ? await guard('weapons', () => new W.WeaponSystem()) : null;

  status('Loading players…', 0.82);
  const P = await load('./player/player.js', 'player');
  const B = await load('./ai/bot.js', 'bots');
  World.bots = B ? await guard('bots', () => new B.BotManager()) : null;

  status('Loading interface…', 0.9);
  const H = await load('./game/hud.js', 'hud');
  World.hud = H ? await guard('hud', () => new H.Hud(document.getElementById('hud-root'))) : null;
  const G = await load('./game/rules.js', 'rules');
  World.match = G ? await guard('match', () => new G.MatchController()) : null;

  // Local player
  if (P) {
    World.local = await guard('local player', () => P.createLocalPlayer(World.match?.localTeam || 'T'));
  }

  // Warm up shaders so the first real frame doesn't hitch.
  status('Compiling shaders…', 0.95);
  await guard('precompile', () => renderer.precompile?.());

  if (HARNESS) await import('./core/harness.js').then((h) => h.setupHarness());
  else await guard('match.start', () => World.match?.start?.());

  status('Ready', 1);
  if (HARNESS) document.getElementById('boot')?.remove();
  else {
    document.getElementById('boot')?.classList.add('done');
    setTimeout(() => document.getElementById('boot')?.remove(), 800);
  }

  if (failures.length) console.error('[boot] completed with failures:\n  ' + failures.join('\n  '));
  World.bootFailures = failures;

  startLoop();
}

// ---- main loop ----------------------------------------------------------------------------
const cmd = newCmd();
let acc = 0;
let last = performance.now();
const MAX_FRAME = 0.1;

function tick(dt) {
  World.time += dt;
  const input = World.input;
  const local = World.local;

  if (local && input && !World.paused && !(World.hud?.captureInput)) {
    input.buildCmd(cmd);
    local.runCommand?.(cmd, dt);
  }
  World.bots?.tick?.(dt);
  World.weapons?.tick?.(dt);
  World.match?.tick?.(dt);
  for (const e of World.entities) if (e !== local && !e.isBot) e.tick?.(dt);
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(MAX_FRAME, (now - last) / 1000);
  const cap = World.cvar.fps_max;
  if (cap > 0 && dt < 1 / cap - 0.0005) return;
  last = now;
  if (World.harnessFixedDt) dt = World.harnessFixedDt;
  dt *= World.cvar.host_timescale;
  World.dt = dt;
  World.frame++;

  const input = World.input;
  for (const imp of input.takeImpulses()) World.emit('impulse', imp);
  if (!World.paused) input.applyMouse();

  // Fixed-step simulation at tickrate, rendering interpolates.
  const ti = World.tickInterval;
  acc += World.paused ? 0 : dt;
  let steps = 0;
  while (acc >= ti && steps < 16) { tick(ti); acc -= ti; steps++; }
  if (steps === 16) acc = 0;
  World.alpha = acc / ti;

  // Per-frame (render-rate) updates: camera, viewmodel, fx, hud, audio listener.
  World.local?.frame?.(dt, World.alpha);
  World.bots?.frame?.(dt, World.alpha);
  World.weapons?.frame?.(dt);
  World.fx?.update?.(dt);
  World.audio?.update?.(dt);
  World.hud?.update?.(dt);
  World.renderer.render(dt);
}

function startLoop() {
  last = performance.now();
  requestAnimationFrame(frame);
  window.__READY = true;
  World.emit('ready', {});
}

boot().catch((err) => {
  console.error('[boot] fatal', err);
  status(`Failed to start: ${err.message}`, null);
  document.getElementById('boot')?.classList.add('error');
  window.__BOOT_ERROR = String(err && err.stack || err);
});
