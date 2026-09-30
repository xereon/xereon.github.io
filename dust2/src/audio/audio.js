// Audio — WebAudio runtime for DUST II (CONTRACT.md §15).
//
// Every sound is synthesised in code (src/audio/synth/*, rendered once in a Worker into
// AudioBuffers). At runtime: pooled voices -> [lowpass (air + occlusion)] -> gain -> HRTF
// panner -> bus; a mono send feeds the listener-environment convolution reverb. Buses go
// through a glue compressor, a limiter and a soft ceiling (true peak < -1 dBFS).
//
// Other modules only emit World events (fire, footstep, impact, damage, ...); this module
// subscribes itself. Direct API for weapons/fx: play(), playAt(), startLoop(), flashed().
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { Dbg } from '../core/debug.js';
import { Bank } from './bank.js';
import { Mixer, profile, distanceGain, airCutoff } from './mixer.js';
import { Occlusion } from './occlusion.js';
import { ReverbEnv } from './reverb.js';
import { Ambient } from './ambient.js';
import { MASK_VISIBLE } from '../player/collision.js';

defCvar('volume', 0.9, 0, 1, 'master volume');
defCvar('snd_weapons', 1, 0, 2, 'weapons bus (gunshots, explosions, hits)');
defCvar('snd_footsteps', 1, 0, 2, 'foley bus (footsteps, jumps, handling)');
defCvar('snd_world', 1, 0, 2, 'world bus (impacts, grenades, bomb)');
defCvar('snd_ambience', 1, 0, 2, 'ambience bus (wind, birds, emitters)');
defCvar('snd_ui', 1, 0, 2, 'UI / radio bus');
defCvar('snd_music', 0.8, 0, 2, 'music stingers bus');
defCvar('snd_reverb', 1, 0, 2, 'environment reverb send scale');
defCvar('snd_hrtf', 1, 0, 1, '1 = HRTF binaural panning, 0 = equal-power stereo');
defCvar('snd_occlusion', 1, 0, 1, 'occlusion strength (ray-traced through world geometry)');
defCvar('snd_maxvoices', 48, 8, 64, 'max simultaneous voices (lowest priority stolen)');
defCvar('snd_duck', 0.7, 0, 1, 'ambience ducking under gunfire');
defCvar('snd_distance', 1, 0.25, 3, 'scales every audible distance');
defCvar('snd_own_footsteps', 0.3, 0, 1.5, 'level of your own footsteps');

const dB = (d) => Math.pow(10, d / 20);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- name normalisation -------------------------------------------------------------------
const W_ALIAS = {
  usps: 'usp', uspsilencer: 'usp', hkp2000: 'usp', p2000: 'usp', m4a1silencer: 'm4a1s', m4a1: 'm4a4', deserteagle: 'deagle', revolver: 'deagle',
  r8: 'deagle', galilar: 'galil', zeus: 'taser', zeusx27: 'taser', elite: 'dualberettas', berettas: 'dualberettas', sg556: 'sg553',
  mp5: 'mp5sd', cz75: 'cz75a', he: 'hegrenade', grenade: 'hegrenade', flash: 'flashbang', smoke: 'smokegrenade', incendiary: 'incgrenade',
  molly: 'molotov', incgrenade: 'incgrenade', ppbizon: 'bizon', sawedoff: 'sawedoff', ssg: 'ssg08', scout: 'ssg08',
};
export function weaponKey(w) {
  if (!w) return null;
  let k = typeof w === 'string' ? w : (w.key ?? w.id ?? w.def?.key ?? w.weapon ?? w.name);
  if (typeof k !== 'string') return null;
  k = k.toLowerCase().replace(/^weapon_/, '').replace(/[^a-z0-9]/g, '');
  if (/knife|bayonet|karambit|dagger|butterfly/.test(k)) return 'knife';
  return W_ALIAS[k] || k;
}
const FAM = {
  glock: 'pistol', usp: 'pistol', p250: 'pistol', deagle: 'pistol', tec9: 'pistol', fiveseven: 'pistol', dualberettas: 'pistol', cz75a: 'pistol', taser: 'pistol',
  mp9: 'smg', mac10: 'smg', mp5sd: 'smg', mp7: 'smg', ump45: 'smg', p90: 'smg', bizon: 'smg',
  nova: 'shotgun', xm1014: 'shotgun', mag7: 'shotgun', sawedoff: 'shotgun', negev: 'lmg', m249: 'lmg',
  galil: 'rifle', famas: 'rifle', ak47: 'ak', m4a4: 'rifle', m4a1s: 'rifle', aug: 'rifle', sg553: 'rifle',
  ssg08: 'sniper', awp: 'sniper', g3sg1: 'sniper', scar20: 'sniper', knife: 'knife',
  hegrenade: 'grenade', flashbang: 'grenade', smokegrenade: 'grenade', molotov: 'grenade', incgrenade: 'grenade', decoy: 'grenade', c4: 'c4',
};
const GRENADES = new Set(['hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade', 'decoy']);
const SUPPRESSIBLE = new Set(['m4a1s', 'usp']);
const RELOAD_TIME = { pistol: 2.2, smg: 2.4, rifle: 2.5, ak: 2.4, sniper: 3.6, shotgun: 0.5, lmg: 5.5 };
const RELOAD_PARTS = {
  pistol: [['magout', 0.12], ['magin', 0.55], ['slide', 0.82]],
  smg: [['magout', 0.15], ['magin', 0.55], ['boltback', 0.74], ['boltfwd', 0.8]],
  rifle: [['magout', 0.14], ['magin', 0.52], ['boltback', 0.74], ['boltfwd', 0.8]],
  ak: [['magout', 0.16], ['magin', 0.5], ['boltback', 0.74], ['boltfwd', 0.8]],
  sniper: [['magout', 0.18], ['magin', 0.55], ['boltback', 0.76], ['boltfwd', 0.84]],
  shotgun: [['shell', 0.1]],
  lmg: [['coveropen', 0.1], ['box', 0.3], ['box', 0.52], ['coverclose', 0.72], ['boltback', 0.84], ['boltfwd', 0.9]],
};
const FOOT = { sand: 'sand', gravel: 'gravel', dirt: 'dirt', concrete: 'concrete', brick: 'concrete', rock: 'concrete', default: 'concrete',
  plaster: 'plaster', wood: 'wood', crate: 'wood', metal: 'metal', metaldoor: 'metal', metalgrate: 'metalgrate', tile: 'tile', glass: 'tile',
  cloth: 'dirt', rubber: 'concrete', water: 'sand', flesh: 'dirt' };
const IMPACT = { concrete: 'concrete', brick: 'concrete', rock: 'concrete', default: 'concrete', plaster: 'plaster', tile: 'tile', wood: 'wood',
  crate: 'wood', metal: 'metal', metalgrate: 'metal', metaldoor: 'metaldoor', sand: 'sand', gravel: 'sand', dirt: 'dirt', flesh: 'flesh',
  glass: 'glass', cloth: 'cloth', rubber: 'cloth', water: 'sand' };
const SHELL_CLS = { metal: 'metal', metalgrate: 'metal', metaldoor: 'metal', wood: 'wood', crate: 'wood', sand: 'soft', gravel: 'soft', dirt: 'soft',
  cloth: 'soft', rubber: 'soft', water: 'soft', flesh: 'soft' };
const SHELL_KIND = { pistol: 'pistol', smg: 'pistol', rifle: 'rifle', ak: 'rifle', lmg: 'rifle', sniper: 'sniper', shotgun: 'shotgun' };
const shellCls = (s) => SHELL_CLS[s] || 'hard';
// long one-shots that other modules may re-emit rapidly: ignore retriggers within N seconds
const GUARD = { bomb_final: 1.5, stinger_ct_win: 3, stinger_t_win: 3, stinger_mvp: 4, stinger_bomb10: 9, radio_go: 1 };

// ---- scratch ------------------------------------------------------------------------------
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _up = new THREE.Vector3();
const _lp = new THREE.Vector3(), _q = new THREE.Quaternion();
const toVec = (p, out) => (p == null ? null : Array.isArray(p) ? out.set(p[0], p[1], p[2]) : out.set(p.x, p.y, p.z));

function eyeOf(ent, out) {
  if (ent?.eyePos) { try { ent.eyePos(out); return out; } catch {} }
  const o = ent?.origin;
  if (!o) return null;
  return out.set(o.x, o.y + (ent.eyeHeight ?? 64), o.z);
}
function feetOf(ent, out) { const o = ent?.origin; return o ? out.set(o.x, o.y + 2, o.z) : null; }

// ---- voices -------------------------------------------------------------------------------
let _vid = 1;
class Voice {
  constructor(a, spatial) {
    const ctx = a.ctx;
    this.a = a; this.spatial = spatial;
    this.inA = ctx.createGain(); this.inB = ctx.createGain();
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 0.5; this.filter.frequency.value = 20000;
    this.gain = ctx.createGain();
    this.send = ctx.createGain(); this.send.gain.value = 0;
    this.inA.connect(this.filter); this.inB.connect(this.filter); this.filter.connect(this.gain);
    this.gain.connect(this.send); this.send.connect(a.reverbIn);
    if (spatial) {
      const p = this.panner = ctx.createPanner();
      p.panningModel = World.cvar.snd_hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse'; p.refDistance = 1; p.rolloffFactor = 0; p.maxDistance = 1e6;
      this.gain.connect(p);
    }
    this.out = spatial ? this.panner : this.gain;
    this.bus = null;
    this.state = 0;          // 0 free, 1 playing, 2 releasing
    this.srcA = null; this.srcB = null;
    this.pos = new THREE.Vector3();
    this.reset();
  }
  reset() {
    this.id = _vid++; this.name = ''; this.p = null; this.ent = null; this.attach = null; this.cat = null;
    this.prio = 0; this.start = 0; this.end = 0; this.freeAt = 0; this.loop = false;
    this.base = 1; this.occ = 0; this.occT = 0; this.nextUpd = 0; this.lastG = -1; this.lastF = -1; this.occlude = true; this.range = 1; this.rampT = null;
  }
  route(bus) {
    if (this.bus === bus) return;
    if (this.bus) { try { this.out.disconnect(this.bus); } catch {} }
    this.out.connect(bus); this.bus = bus;
  }
  /** Fade out and free shortly after. */
  release(fade = 0.02) {
    if (this.state !== 1) return;
    const t = this.a.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + fade);
    this.send.gain.cancelScheduledValues(t); this.send.gain.setTargetAtTime(0, t, fade / 3);
    for (const s of [this.srcA, this.srcB]) if (s) { try { s.stop(t + fade + 0.01); } catch {} }
    this.state = 2; this.freeAt = t + fade + 0.05;
    if (this.handle) this.handle.active = false;
  }
  free() {
    for (const s of [this.srcA, this.srcB]) if (s) { try { s.disconnect(); } catch {} }
    this.srcA = this.srcB = null;
    if (this.handle) this.handle.active = false;
    this.handle = null;
    this.state = 0;
  }
}

class Handle {
  constructor(v) { this.v = v; this.id = v.id; this.active = true; }
  get alive() { return this.active && this.v.id === this.id && this.v.state === 1; }
  stop(fade = 0.05) { if (this.alive) this.v.release(fade); this.active = false; }
  setPos(p) { if (this.alive) toVec(p, this.v.pos); }
  setVolume(x, ramp = 0.1) {
    if (!this.alive) return;
    const v = this.v;
    v.base = v.p.gain * x; v.nextUpd = 0; v.rampT = ramp;
    if (!v.spatial) { v.gain.gain.setTargetAtTime(v.base, v.a.ctx.currentTime, ramp); v.lastG = v.base; }
  }
}

export class Audio {
  /**
   * opts.context — use an existing (e.g. Offline) AudioContext (tests)
   * opts.force   — run even inside the screenshot harness
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.enabled = false;
    this.unlocked = false;
    this.voices = [];
    this.timers = [];
    this.listenerPos = new THREE.Vector3();
    this.bomb = null;
    this.loops = new Map();     // key -> Handle (smokes, fires, defuse)
    this.track = new Map();     // ent -> { active, onGround, vy, ducking, stepT, air }
    this.seen = { footstep: 0, jumpland: 0, shell: 0, freeze: false, bombBeep: false, decoyFire: false, shellIn: false };
    this.guard = new Map();     // name -> last start time (retrigger guard for long one-shots)
    this.lastHit = new Map();
    this.impactTimes = [0, 0, 0, 0, 0];
    this.pendingFlash = [];
    this.statsCount = { played: 0, dropped: 0, stolen: 0 };
    this._opts = opts;
    this.deferred = [];
    const harness = World.harness && !World.params?.has?.('audio');
    if (harness && !opts.force && !opts.context) return; // screenshot harness: stay silent + free
    try { this._init(opts); } catch (err) { console.error('[audio] init failed', err); this.enabled = false; }
  }

  // ---- setup ----------------------------------------------------------------------------
  /**
   * Constructor half: synthesis starts at once (Worker, no AudioContext needed) and events are
   * wired. The WebAudio graph is built on the first user gesture (unlock) — a context created
   * earlier could not start anyway — or immediately for tests / ?audio harness runs.
   */
  _init(opts) {
    this.bank = new Bank(null);
    this.enabled = true;
    World.on('cvar', ({ name }) => {
      if (!this.mixer) return;
      if (/^(volume|snd_)/.test(name)) this.mixer.applyCvars();
      if (name === 'snd_hrtf' && !World.cvar.snd_hrtf) for (const v of this.voices) if (v.panner) v.panner.panningModel = 'equalpower';
    });
    this.bank.onReady((name) => {
      if (name.startsWith('ir_') && this.reverb) this.reverb.setIR(name.slice(3), this.bank.pick(name));
      // sounds asked for while their buffer was still rendering: play if still fresh
      const D = this.deferred;
      for (let i = D.length - 1; i >= 0; i--) {
        if (D[i].name !== name) continue;
        const d = D.splice(i, 1)[0];
        if (performance.now() - d.t < 250) this._start(d.name, d.pos, d.opts);
      }
    });
    this._wire();
    this.ready = this.bank.init().then(() => { if (!opts.noPreload) this._queueBoot(); });
    // build + resume on the first gesture / pointer lock (autoplay policy)
    if (typeof window !== 'undefined' && !opts.context) {
      const g = () => { this.unlock(); window.removeEventListener('pointerdown', g, true); window.removeEventListener('keydown', g, true); };
      window.addEventListener('pointerdown', g, true);
      window.addEventListener('keydown', g, true);
    }
    if (opts.context || (opts.force && !opts.deferGraph) || (World.harness && World.params?.has?.('audio'))) this.unlock();
    // menu / buy-menu feedback without the UI having to call us: delegated click + hover ticks
    if (typeof document !== 'undefined' && !opts.context) {
      const SEL = 'button, [data-act], .btn, .mm-btn, [data-buy], [data-item], [role=button]';
      let hoverEl = null, hoverT = 0;
      document.addEventListener('pointerdown', (e) => {
        if (!World.input?.locked && e.target?.closest?.(SEL)) this.play('ui_click');
      }, true);
      document.addEventListener('pointerover', (e) => {
        const el = e.target?.closest?.(SEL);
        if (!el || el === hoverEl || World.input?.locked) return;
        hoverEl = el;
        const t = performance.now();
        if (t - hoverT > 45) { hoverT = t; this.play('ui_hover', { volume: 0.6, jitter: 0.02 }); }
      }, true);
    }
  }

  /** Master volume 0..1 (same as the `volume` cvar). */
  setVolume(v) { World.cvar.volume = Math.max(0, Math.min(1, +v || 0)); this.mixer?.applyCvars(); }

  _queueBoot() {
    const m = this.bank.meta;
    if (!m) return;
    const names = m.soundNames();
    const tier = (t) => names.filter((n) => m.soundDef(n).tier === t);
    const team = World.match?.localTeam || World.local?.team || 'T';
    const pistol = team === 'CT' ? 'usp' : 'glock';
    const first = [...tier(0), `weapon_${pistol}_fire_2d`, 'deploy_knife', 'deploy_pistol', 'knife_slash', `weapon_${pistol}_fire`];
    this.bank.queue(first);
    this.bank.queue(tier(1));
    this.bank.queue(tier(2));
    this.bootAt = performance.now();
  }

  /** WebAudio half: context, buses, reverb, voice pool. */
  _initGraph(opts) {
    let ctx = opts.context || null;
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      try { ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch { ctx = new AC(); }
    }
    this.ctx = ctx;
    this.bank.ctx = ctx;
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.mixer = new Mixer(ctx, opts.destination || ctx.destination);
    this.reverbIn = ctx.createGain();
    this.reverb = new ReverbEnv(ctx, this.reverbIn, this.mixer.worldIn);
    for (const e of ['open', 'room', 'tunnel']) if (this.bank.has(`ir_${e}`)) this.reverb.setIR(e, this.bank.pick(`ir_${e}`));
    this.occl = new Occlusion();
    this.ambient = new Ambient(this);
    this.warm(6, 4);
    this.mixer.applyCvars();
    return true;
  }

  /** Build the graph if needed, resume the AudioContext (call from a user gesture), start ambience. */
  unlock() {
    if (!this.enabled) return;
    if (!this.ctx) {
      try { if (!this._initGraph(this._opts)) return; } catch (err) { console.error('[audio] graph init failed', err); return; }
    }
    if (this.ctx.state === 'suspended' && !this.offline) this.ctx.resume?.().catch(() => {});
    this.unlocked = true;
    this.ambient?.start();
  }

  profileOf(name) { return profile(name); }
  profileGain(name) { return profile(name).gain; }

  // ---- voice management -------------------------------------------------------------------
  /** Pre-build voices (loads the HRTF database now instead of on the first gunshot). */
  warm(n3d = 16, n2d = 6) {
    if (!this.ctx) return;
    let s = 0, f = 0;
    for (const v of this.voices) if (v.spatial) s++; else f++;
    for (; s < n3d; s++) this.voices.push(new Voice(this, true));
    for (; f < n2d; f++) this.voices.push(new Voice(this, false));
  }

  _activeCount() { let n = 0; for (const v of this.voices) if (v.state === 1) n++; return n; }

  _alloc(spatial, prio) {
    const max = World.cvar.snd_maxvoices | 0 || 48;
    let free = null, active = 0, worst = null, worstP = Infinity;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.state === 0) { if (!free && v.spatial === spatial) free = v; continue; }
      if (v.state !== 1) continue;
      active++;
      // older sounds lose priority as they decay
      const age = v.loop ? 0 : Math.min(1, (now - v.start) / Math.max(0.05, v.end - v.start));
      const p = v.prio * (1 - 0.6 * age);
      if (p < worstP) { worstP = p; worst = v; }
    }
    if (active >= max) {
      if (!worst || worstP >= prio) { this.statsCount.dropped++; return null; }
      worst.release(0.03); this.statsCount.stolen++;
    }
    if (!free) {
      if (this.voices.length >= max + 16) { this.statsCount.dropped++; return null; }
      free = new Voice(this, spatial);
      this.voices.push(free);
    }
    return free;
  }

  _src(buf, rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.playbackRate.value = rate;
    return s;
  }

  /**
   * Core start. pos = null for 2D. Returns a Handle or null.
   * opts: volume, pitch, jitter, delay, variant, ent, attach ('eye'|'feet'), occlude, loop, fadeIn, cat, bus, name2d
   */
  _start(name, pos, opts = {}) {
    if (!this.enabled || !this.ctx) return null;
    // before the first user gesture the context is suspended: drop, don't queue a burst for later
    if (!this.offline && this.ctx.state !== 'running') return null;
    const p = profile(name);
    const spatial = pos != null && p.spatial && !opts.force2D;
    if (!this.bank.need(name)) {
      if (!opts.loop && !opts.noDefer && this.bank.pending.has(name) && this.deferred.length < 24) {
        this.deferred.push({ name, pos: pos != null ? toVec(pos, new THREE.Vector3()) : null, opts: { ...opts, noDefer: true }, t: performance.now() });
      }
      return null;
    }
    const ctx = this.ctx, now = ctx.currentTime, cv = World.cvar;
    const scale = (cv.snd_distance ?? 1) * (opts.range ?? 1);
    let d = 0, dg = 1;
    if (spatial) {
      toVec(pos, _v);
      d = _v.distanceTo(this.listenerPos);
      dg = distanceGain(p, d, scale);
      if (dg <= 0.0005) { this.statsCount.dropped++; return null; }
    }
    const base = p.gain * (opts.volume ?? 1);
    const prio = (opts.prio ?? p.prio) * (0.4 + 0.6 * Math.min(1, base * dg * 3));
    // per-entity overlap limit (auto fire tails, footsteps)
    if (opts.ent && opts.cat) this._limitOverlap(opts.ent, opts.cat, opts.cat === 'shot' ? 3 : 2);
    const v = this._alloc(spatial, prio);
    if (!v) return null;
    v.reset();
    v.name = name; v.p = p; v.prio = prio; v.base = base; v.ent = opts.ent || null; v.attach = opts.attach || null; v.cat = opts.cat || null;
    v.loop = !!opts.loop; v.occlude = opts.occlude !== false && p.occl > 0; v.range = opts.range ?? 1;
    if (spatial) {
      v.pos.copy(_v);
      // HRTF where localisation matters (near / important); cheap equal-power for distant & ambient
      const model = cv.snd_hrtf && (d < 1800 || p.prio >= 0.9) && p.bus !== 'ambience' ? 'HRTF' : 'equalpower';
      if (v.panner.panningModel !== model) v.panner.panningModel = model;
    }

    // close/far crossfade
    let farW = 0;
    if (spatial && p.far && p.xf) {
      farW = smooth(p.xf[0] * scale, p.xf[1] * scale, d);
      if (farW > 0 && !this.bank.need(p.far)) farW = 0;
    }
    const rate = (opts.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * (opts.jitter ?? 0.03));
    const when = now + (opts.delay || 0);
    let dur = 0;
    if (farW < 0.999) {
      const s = this._src(this.bank.pick(name, opts.variant ?? -1), rate);
      s.loop = v.loop; s.connect(v.inA); v.inA.gain.value = Math.cos(farW * Math.PI / 2);
      s.start(when, v.loop && opts.random ? Math.random() * s.buffer.duration : 0);
      v.srcA = s; dur = s.buffer.duration / rate;
    }
    if (farW > 0.001) {
      const s = this._src(this.bank.pick(p.far), rate);
      s.connect(v.inB); v.inB.gain.value = Math.sin(farW * Math.PI / 2);
      s.start(when); v.srcB = s; dur = Math.max(dur, s.buffer.duration / rate);
    }
    v.start = when; v.end = v.loop ? Infinity : when + dur + 0.05;

    // occlusion + air absorption + gains
    let occ = 0;
    if (spatial && v.occlude && (cv.snd_occlusion ?? 1) > 0) occ = this.occl.query(this.listenerPos, v.pos, null, 3) * p.occl * cv.snd_occlusion;
    v.occ = occ;
    const g = this._gainFor(v, dg, occ);
    const fc = spatial ? this._cutFor(d, occ) : 20000;
    v.gain.gain.cancelScheduledValues(now);
    if (opts.fadeIn) { v.gain.gain.setValueAtTime(0, now); v.gain.gain.linearRampToValueAtTime(g, now + opts.fadeIn); }
    else v.gain.gain.setValueAtTime(g, now);
    v.filter.frequency.cancelScheduledValues(now); v.filter.frequency.setValueAtTime(fc, now);
    v.send.gain.cancelScheduledValues(now); v.send.gain.setValueAtTime(this._sendFor(v, dg, occ), now);
    v.lastG = g; v.lastF = fc;
    if (spatial) this._setPannerPos(v, now);
    v.route(this.mixer.bus[opts.bus || p.bus] || this.mixer.bus.world);
    v.state = 1;
    v.nextUpd = now + 0.05;
    this.statsCount.played++;
    v.handle = new Handle(v);
    return v.handle;
  }

  // fully blocked: -9 dB and a ~1.1 kHz lowpass (muffled but still identifiable, like CS)
  _gainFor(v, dg, occ) { return v.base * dg * dB(-9 * occ); }
  _cutFor(d, occ) { return Math.min(airCutoff(d), 20000 * Math.pow(1100 / 20000, occ)); }
  _sendFor(v, dg, occ) {
    const s = v.p.sendGain;
    if (!s) return 0;
    return v.base * s * (World.cvar.snd_reverb ?? 1) * Math.sqrt(dg) * (1 + 1.2 * occ);
  }
  _setPannerPos(v, t) {
    const p = v.panner;
    if (p.positionX) { p.positionX.value = v.pos.x; p.positionY.value = v.pos.y; p.positionZ.value = v.pos.z; }
    else p.setPosition(v.pos.x, v.pos.y, v.pos.z);
  }

  _limitOverlap(ent, cat, maxN) {
    let n = 0, oldest = null;
    for (const v of this.voices) {
      if (v.state !== 1 || v.ent !== ent || v.cat !== cat) continue;
      n++;
      if (!oldest || v.start < oldest.start) oldest = v;
    }
    if (n >= maxN && oldest) oldest.release(cat === 'shot' ? 0.08 : 0.03);
  }

  // ---- public API --------------------------------------------------------------------------
  /** 2D sound (UI, local player's own weapon). */
  play(name, opts = {}) { return this._start(name, null, opts); }

  /** 3D sound at a world position (Vector3 or [x,y,z]). */
  playAt(name, pos, opts = {}) {
    if (pos == null) return this._start(name, null, opts);
    return this._start(name, pos, opts);
  }

  /** Looping sound (2D when pos is null). Returns a Handle with stop()/setPos()/setVolume(). */
  startLoop(name, pos = null, opts = {}) { return this._start(name, pos, { ...opts, loop: true, jitter: opts.jitter ?? 0 }); }

  /** Local player -> 2D, anyone else -> 3D at their eye/feet. */
  _entSound(name, ent, opts = {}, where = 'eye') {
    if (!ent) return null;
    if (this._isLocal(ent)) return this.play(name, opts);
    const pos = where === 'feet' ? feetOf(ent, _v2) : eyeOf(ent, _v2);
    if (!pos) return null;
    return this.playAt(name, pos, { ...opts, ent, attach: where });
  }
  _isLocal(ent) { return !!ent && (ent === World.local || (ent.isLocal === true && ent.isBot !== true && !World.local)); }

  /** Gunshot for `ent` with weapon key (handles suppressors, local 2D, bolt/pump follow-ups). */
  gunshot(ent, key, opts = {}) {
    key = weaponKey(key);
    if (!key) return null;
    if (key === 'knife') return this._entSound(opts.heavy ? 'knife_stab' : 'knife_slash', ent, { cat: 'knife' });
    if (GRENADES.has(key)) return this._entSound('nade_throw', ent, {});
    if (key === 'c4') return null;
    let k = key;
    if (SUPPRESSIBLE.has(key) && opts.silenced === false) k = `${key}_unsil`;
    let h;
    if (this._isLocal(ent)) {
      const n2 = `weapon_${k}_fire_2d`;
      if (this.bank.need(n2)) h = this.play(n2, { cat: 'shot', ent });
      else h = this.play(`weapon_${k}_fire`, { cat: 'shot', ent, force2D: true, volume: 0.9 });
    } else {
      const pos = eyeOf(ent, _v2);
      if (!pos) return null;
      h = this.playAt(`weapon_${k}_fire`, pos, { ent, attach: 'eye', cat: 'shot' });
    }
    // action follow-ups
    const fam = FAM[key];
    if (key === 'awp' || key === 'ssg08') {
      this._entSound(`wpn_boltback_sniper`, ent, { delay: 0.5, volume: 0.9 });
      this._entSound(`wpn_boltfwd_sniper`, ent, { delay: 0.78, volume: 0.9 });
    } else if (key === 'nova' || key === 'mag7' || key === 'sawedoff') {
      this._entSound('wpn_pump_shotgun', ent, { delay: 0.34 });
    }
    if (this.seen.shell === 0 && fam !== 'shotgun' && fam !== 'knife') this._fakeShell(ent, fam);
    return h;
  }

  /** volume uses Source's scale: 0.5 = running step, 1 = jump/landing, 0.2 = fast walk. */
  footstep(ent, surface, volume = 0.5) {
    const s = FOOT[surface] || 'concrete';
    const name = `footstep_${s}`;
    volume = Math.min(1.6, Math.max(0, volume) * 2);
    if (this._isLocal(ent)) return this.play(name, { volume: volume * (World.cvar.snd_own_footsteps ?? 0.3), jitter: 0.05 });
    const pos = feetOf(ent, _v2);
    return pos ? this.playAt(name, pos, { ent, attach: 'feet', volume, cat: 'step', jitter: 0.05 }) : null;
  }

  impactAt(point, surface, opts = {}) {
    // shotguns and sprays: cap the burst rate so 9 pellets don't cost 9 voices
    const now = performance.now();
    const ti = this.impactTimes;
    let recent = 0;
    for (let i = 0; i < ti.length; i++) if (now - ti[i] < 45) recent++;
    if (recent >= 4) return null;
    ti.shift(); ti.push(now);
    const s = IMPACT[surface] || 'concrete';
    return this.playAt(`impact_${s}`, point, { volume: opts.volume ?? (recent ? 0.75 : 1), jitter: 0.06 });
  }

  explosion(pos, kind = 'he') {
    const name = kind === 'c4' || kind === 'bomb' ? 'bomb_explode' : kind === 'flash' ? 'flash_pop' : 'he_explode';
    const h = this.playAt(name, pos, { jitter: 0.02 });
    // close blasts deafen and ring (CS behaviour)
    const p = toVec(pos, _v);
    if (p && kind !== 'flash') {
      const d = p.distanceTo(this.listenerPos), R = name === 'bomb_explode' ? 900 : 380;
      if (d < R && this._los(p)) {
        const amt = Math.min(0.9, (1 - d / R) * 0.9);
        this.flashed(amt, 0.8 + 2.2 * amt, 0.45);
      }
    }
    return h;
  }

  /** Muffle the world + tinnitus ring. amount 0..1, dur seconds. */
  flashed(amount, dur = 3, ringScale = 1) {
    if (!this.enabled || !this.mixer || amount < 0.05) return;
    this.mixer.deafen(Math.min(1, amount), dur);
    const h = this.play('tinnitus', { volume: Math.min(1, amount) * ringScale, jitter: 0.01 });
    if (h?.alive) {
      const g = h.v.gain.gain, t = this.ctx.currentTime;
      g.setTargetAtTime(0, t + Math.max(0.3, dur * 0.55), Math.max(0.15, dur * 0.25));
    }
  }

  stopAll(fade = 0.1) { if (!this.ctx) return; for (const v of this.voices) if (v.state === 1) v.release(fade); this.loops.clear(); this.bomb = null; this.timers.length = 0; }

  stats() {
    return {
      state: this.ctx?.state || 'off', voices: this.enabled ? this._activeCount() : 0, pool: this.voices.length,
      env: this.reverb?.dominant(), zone: this.reverb?.zone, ...this.statsCount, bank: this.bank?.stats(),
    };
  }

  /** Warm specific sounds now (e.g. on buy). */
  preload(names) { this.bank?.bump(names); }

  // ---- scheduling helpers ------------------------------------------------------------------
  _after(sec, fn) { if (this.ctx) this.timers.push({ t: this.ctx.currentTime + sec, fn }); }
  _los(p) {
    const col = World.collision;
    if (!col?.rayTrace) return true;
    try { return col.rayTrace(this.listenerPos, p, MASK_VISIBLE).fraction > 0.98; } catch { return true; }
  }

  _fakeShell(ent, fam) {
    // Fallback brass when FX doesn't emit shell_land: only nearby, quiet.
    const kind = SHELL_KIND[fam];
    if (!kind) return;
    const pos = feetOf(ent, _v2);
    if (!pos || pos.distanceTo(this.listenerPos) > 450) return;
    const col = World.collision;
    let surf = 'concrete';
    try { if (col?.rayTrace) { _v.copy(pos); _v.y -= 40; const tr = col.rayTrace(pos, _v, MASK_VISIBLE); if (tr.fraction < 1) surf = tr.surface || surf; } } catch {}
    const name = `shell_${kind}_${shellCls(surf)}`;
    const delay = 0.35 + Math.random() * 0.25;
    if (this._isLocal(ent)) this.play(name, { delay, volume: 0.5 });
    else { _v.set(pos.x + (Math.random() - 0.5) * 40, pos.y, pos.z + (Math.random() - 0.5) * 40); this.playAt(name, _v, { delay }); }
  }

  reloadSounds(ent, key, info = {}) {
    key = weaponKey(key);
    const fam = FAM[key];
    const parts = RELOAD_PARTS[fam];
    if (!parts) return;
    const T = info.time ?? info.reloadTime ?? RELOAD_TIME[fam] ?? 2.5;
    const shells = fam === 'shotgun' ? Math.max(1, info.count ?? 1) : 0;
    const sfam = fam === 'ak' ? 'ak' : fam;
    for (const [part, f] of parts) {
      if (info.empty === false && (part === 'boltback' || part === 'boltfwd' || part === 'slide')) continue;
      if (fam === 'shotgun') { if (!this.seen.shellIn) for (let i = 0; i < shells; i++) this._entSound(`wpn_shell_shotgun`, ent, { delay: 0.1 + i * 0.5 }); continue; }
      this._entSound(`wpn_${part}_${sfam}`, ent, { delay: f * T, jitter: 0.02 }, 'eye');
    }
  }

  // ---- event wiring ------------------------------------------------------------------------
  _wire() {
    const on = (names, fn) => { for (const n of names.split(' ')) World.on(n, (p) => { if (this.enabled) fn(p || {}, n); }); };

    on('pointerlock', () => this.unlock());
    on('fire', (p) => {
      const w = p.weapon;
      const sil = p.silenced ?? w?.silenced ?? w?.silencer ?? w?.silencerOn ?? p.ent?.active?.silenced;
      this.gunshot(p.ent, w, { silenced: sil, heavy: p.heavy || p.secondary });
    });
    on('footstep', (p) => {
      this.seen.footstep = performance.now();
      if (p.kind === 'ladder') return this.footstep(p.ent, 'metal', (p.volume ?? 0.5) * 0.7);
      this.footstep(p.ent, p.surface, p.volume ?? 0.5);
    });
    on('jump', (p) => { this.seen.jumpland = performance.now(); this._entSound('jump', p.ent, { volume: 0.9 }, 'feet'); });
    on('land', (p) => {
      this.seen.jumpland = performance.now();
      if (p.volume === 0) return; // soft landing: CS plays nothing
      this._land(p.ent, p.surface, p.speed ?? p.fallSpeed ?? Math.abs(p.velocity?.y ?? 400));
    });
    on('duck crouch', (p) => { if (p.down !== false && this._isLocal(p.ent)) this.play('crouch', { volume: 0.5 }); });
    on('impact', (p) => {
      if (p.entity) return; // hits on players are voiced by 'damage'
      const pt = p.point || p.pos;
      if (!pt) return;
      if (weaponKey(p.weapon) === 'knife') return this.playAt('knife_hit_wall', pt, {});
      this.impactAt(pt, p.surface);
    });
    on('damage', (p) => this._damage(p));
    on('death', (p) => { const v = p.victim; if (v) this._entSound('death_fall', v, { volume: this._isLocal(v) ? 0.6 : 1 }, 'feet'); });
    on('shell_land shell', (p) => {
      this.seen.shell = performance.now();
      const pt = p.pos || p.point || p.position;
      if (!pt) return;
      const key = weaponKey(p.weapon || p.key);
      const kind = p.kind || SHELL_KIND[FAM[key]] || 'rifle';
      this.playAt(`shell_${kind}_${shellCls(p.surface)}`, pt, { volume: p.volume ?? 1 });
    });
    on('reload', (p) => { if (p.ent) this._trk(p.ent).reloadEmpty = !!p.empty; this.reloadSounds(p.ent, p.weapon, p); });
    on('weapon_shell_in', (p) => { this.seen.shellIn = true; this._entSound('wpn_shell_shotgun', p.ent, { jitter: 0.04 }); });
    on('weapon_reload_end', (p) => {
      const k = weaponKey(p.weapon);
      if ((k === 'nova' || k === 'mag7' || k === 'sawedoff') && p.ent && this._trk(p.ent).reloadEmpty) this._entSound('wpn_pump_shotgun', p.ent, {});
    });
    on('weapon_mode', (p) => this._entSound('wpn_zoom', p.ent, { volume: 0.7 }));
    on('weapon_drop', (p) => { const pt = p.pos || p.point; if (pt) this.playAt('weapon_land', pt, { delay: 0.35 }); });
    on('bomb_dropped', (p) => { const pt = p.pos || p.point; if (pt) this.playAt('weapon_land', pt, { delay: 0.3, volume: 0.8, pitch: 0.9 }); });
    on('weapon_pickup bomb_pickup', (p) => this._entSound('item_pickup', p.ent, {}));
    on('radio', (p) => {
      const me = World.local;
      if (!p.ent || !me || p.ent === me || (p.ent.team && me.team && p.ent.team !== me.team)) return;
      this.play('radio_chirp');
    });
    on('dryfire empty', (p) => this._entSound('wpn_dryfire', p.ent, {}));
    on('zoom', (p) => this._entSound('wpn_zoom', p.ent, {}));
    on('silencer', (p) => this._entSound(p.on === false ? 'wpn_silencer_off' : 'wpn_silencer_on', p.ent, { delay: Math.max(0, (p.time ?? 1.2) - 1.25), jitter: 0 }));
    on('deploy', (p) => this._deploy(p.ent, weaponKey(p.weapon)));
    on('buy', (p) => {
      if (this._isLocal(p.ent)) this.play('ui_buy');
      const k = weaponKey(p.item);
      if (k && FAM[k] && this._isLocal(p.ent)) this.preload([`weapon_${k}_fire_2d`, `deploy_${FAM[k]}`]);
    });
    on('buy_fail buy_denied', () => this.play('ui_deny'));
    on('ui_click', () => this.play('ui_click'));
    on('ui_hover', () => this.play('ui_hover'));
    on('bomb_beep', (p) => { this.seen.bombBeep = true; this.beepLeft = p.timeLeft; });
    on('sound', (p) => {
      const name = p.name;
      if (!name) return;
      const hold = GUARD[name];
      if (hold) { const t = this.guard.get(name) || -1e9; if (performance.now() - t < hold * 1000) return; this.guard.set(name, performance.now()); }
      const o = { volume: p.volume, pitch: p.pitch, jitter: p.jitter, delay: p.delay };
      if (name === 'bomb_beep' && this.beepLeft != null) {
        // the beep carries further as the fuse runs down (CS)
        const frac = Math.max(0, Math.min(1, this.beepLeft / (World.cvar.mp_c4timer || 40)));
        o.volume = (p.volume ?? 1) * (1 + 0.4 * (1 - frac)); o.range = 1 + 0.7 * (1 - frac); o.jitter = 0;
      }
      const pos = p.pos || (p.ent ? eyeOf(p.ent, _v2) : null);
      if (pos && !this._isLocal(p.ent)) this.playAt(name, pos, o); else this.play(name, o);
    });

    // grenades
    on('grenade_pin pin', (p) => this._entSound('nade_pin', p.ent, {}));
    on('grenade_throw throw', (p) => this._entSound('nade_throw', p.ent, {}));
    on('grenade_bounce', (p) => {
      const pt = p.pos || p.point; if (!pt) return;
      const spd = p.speed ?? 300;
      this.playAt(`nade_bounce_${shellCls(p.surface) === 'soft' ? 'soft' : shellCls(p.surface)}`, pt, { volume: Math.min(1, Math.max(0.15, spd / 450)) });
    });
    on('he_detonate hegrenade_detonate explosion', (p) => { const pt = p.pos || p.point; if (pt) this.explosion(pt, p.kind || 'he'); });
    on('flash_detonate flashbang_detonate', (p) => {
      const pt = p.pos || p.point; if (!pt) return;
      this.playAt('flash_pop', pt, { jitter: 0.02 });
      this.pendingFlash.push({ pos: toVec(pt, new THREE.Vector3()), frames: 2, amount: p.amounts?.get?.(World.local) ?? p.localAmount });
    });
    on('smoke_detonate smokegrenade_detonate', (p) => {
      const pt = p.pos || p.point; if (!pt) return;
      this.playAt('smoke_pop', pt, {});
      const key = p.id ?? p.handle ?? `${Math.round(pt.x)}_${Math.round(pt.z)}`;
      const dur = p.duration ?? 18;
      const h = this.startLoop('smoke_loop', pt, { fadeIn: 1.5, delay: 0.5 });
      if (h) { this.loops.set(key, h); this._after(dur * 0.55, () => h.setVolume(0.35, 3)); this._after(dur + 1, () => { h.stop(2); this.loops.delete(key); }); }
    });
    on('smoke_expire smokegrenade_expire', (p) => this._stopLoop(p));
    on('molotov_detonate incgrenade_detonate inferno_start', (p) => {
      const pt = p.pos || p.point; if (!pt) return;
      this.playAt('molotov_break', pt, {});
      const key = p.id ?? p.handle ?? `f${Math.round(pt.x)}_${Math.round(pt.z)}`;
      const dur = p.duration ?? 7;
      const h = this.startLoop('fire_loop', pt, { fadeIn: 0.4, delay: 0.15, prio: 0.8 });
      if (h) { this.loops.set(key, h); this._after(dur + 1.5, () => { if (h.alive) h.stop(0.8); this.loops.delete(key); }); }
    });
    on('inferno_expire molotov_expire', (p) => {
      this._stopLoop(p, p.extinguished ? 0.3 : 1.2);
      if (p.extinguished && (p.pos || p.point)) this.playAt('fire_out', p.pos || p.point, {});
    });
    on('decoy_detonate decoy_start', (p) => this._decoy(p));
    on('decoy_fire', (p) => {
      this.seen.decoyFire = true;
      const pt = p.pos || p.point; if (!pt) return;
      let k = weaponKey(p.weapon);
      if (!FAM[k] || FAM[k] === 'knife' || FAM[k] === 'grenade' || FAM[k] === 'c4') k = 'glock';
      this.playAt(`weapon_${k}_fire`, pt, {});
    });

    // bomb
    on('bomb_plant_start bomb_planting', (p) => { const h = this._entSound('bomb_plant', p.ent, {}); if (h) this.loops.set('plant', h); });
    on('bomb_plant_abort', () => this._stopLoop({ id: 'plant' }, 0.05));
    on('bomb_planted', (p) => this._bombPlanted(p));
    on('bomb_defuse_start bomb_defusing', (p) => {
      const pos = this._bombPos(p);
      const h = pos ? this.startLoop('bomb_defusing', pos, {}) : this._entSound('bomb_defusing', p.ent, { loop: true });
      if (h) this.loops.set('defuse', h);
    });
    on('bomb_defuse_abort', () => this._stopLoop({ id: 'defuse' }, 0.05));
    on('bomb_defused', (p) => {
      this._stopLoop({ id: 'defuse' }, 0.05);
      const pos = this._bombPos(p);
      if (pos) this.playAt('bomb_defused', pos, {});
      this.bomb = null; this._stopWarning();
    });
    on('bomb_exploded', (p) => {
      const pos = this._bombPos(p) || this.bomb?.pos;
      this.bomb = null; this._stopWarning();
      if (pos) this.explosion(pos, 'c4');
    });

    // round flow
    on('freeze_end round_freeze_end round_live', () => { this.seen.freeze = true; this.play('radio_go'); });
    on('round_start', () => {
      for (const h of this.loops.values()) h.stop(0.3);
      this.loops.clear(); this.bomb = null; this._stopWarning(); this.timers.length = 0;
      for (const v of this.voices) if (v.state === 1 && v.name.startsWith('stinger_')) v.release(1.0);
      if (!this.seen.freeze) this.play('radio_go', { variant: 0 });
    });
    on('round_end', (p) => {
      this._stopWarning();
      const w = String(p.winner || '').toUpperCase();
      if (w === 'CT') this.play('stinger_ct_win', { jitter: 0 });
      else if (w === 'T') this.play('stinger_t_win', { jitter: 0 });
    });
    on('round_mvp mvp', (p) => {
      if (!this._isLocal(p.ent)) return;
      for (const v of this.voices) if (v.state === 1 && /stinger_(ct|t)_win/.test(v.name)) v.release(0.6);
      this.play('stinger_mvp', { jitter: 0, delay: 0.3 });
    });
  }

  _stopLoop(p, fade = 0.5) {
    const pt = p.pos || p.point;
    const key = p.id ?? p.handle ?? (pt ? `${Math.round(pt.x)}_${Math.round(pt.z)}` : null);
    const h = this.loops.get(key);
    if (h) { h.stop(fade); this.loops.delete(key); }
    return h;
  }

  _land(ent, surface, speed) {
    const vol = Math.min(1.2, Math.max(0.3, speed / 500));
    this._entSound('land', ent, { volume: vol }, 'feet');
    // the movement code emits its own landing footstep; add one only when it doesn't
    if (!this.seen.footstep && (surface || ent?.groundSurface)) this.footstep(ent, surface || ent.groundSurface, Math.min(0.8, vol * 0.6));
  }

  _damage(p) {
    const vic = p.victim;
    if (!vic) return;
    const key = weaponKey(p.weapon);
    if (key === 'fall' || key === 'world' || key === 'falling') return this._entSound('fall_damage', vic, {}, 'feet');
    const now = performance.now();
    const last = this.lastHit.get(vic);
    const head = p.hitgroup === 1;
    if (last && now - last.t < 60 && (!head || last.head)) return; // one hit sound per pellet burst
    this.lastHit.set(vic, { t: now, head });
    if (this.lastHit.size > 64) this.lastHit.clear();
    let name;
    if (key === 'knife') name = (p.amount ?? 0) > 60 ? 'knife_stab_flesh' : 'knife_hit_flesh';
    else if (head) name = vic.helmet ? 'hit_head_helmet' : 'hit_head';
    else name = vic.armor > 0 && p.hitgroup >= 2 && p.hitgroup <= 5 ? 'hit_kevlar' : 'hit_body';
    if (this._isLocal(vic)) { this.play(name, { volume: 0.9 }); return; }
    const pos = p.point || eyeOf(vic, _v2);
    if (pos) this.playAt(name, pos, { ent: vic });
  }

  _deploy(ent, key) {
    if (!ent || !key) return;
    const fam = FAM[key];
    if (!fam) return;
    const t = performance.now();
    const tr = this._trk(ent);
    if (tr.deployT && t - tr.deployT < 150) return;
    tr.deployT = t;
    this._entSound(`deploy_${fam}`, ent, { volume: this._isLocal(ent) ? 1 : 0.8 });
  }

  _decoy(p) {
    const pt = p.pos || p.point; if (!pt) return;
    const pos = toVec(pt, new THREE.Vector3());
    if (this.seen.decoyFire) return;
    const owner = p.ent || p.owner;
    let key = weaponKey(p.weapon) || weaponKey(owner?.inventory?.primary) || weaponKey(owner?.inventory?.secondary) || 'glock';
    if (!FAM[key] || FAM[key] === 'knife' || FAM[key] === 'grenade') key = 'glock';
    const dur = p.duration ?? 15;
    let t = 0.8;
    while (t < dur) {
      const burst = 1 + Math.floor(Math.random() * 4);
      for (let i = 0; i < burst; i++) this._after(t + i * 0.11, () => { if (!this.seen.decoyFire) this.playAt(`weapon_${key}_fire`, pos, {}); });
      t += 1 + Math.random() * 2.2;
    }
  }

  _bombPos(p) {
    const b = World.match?.bomb;
    const cand = p?.pos || p?.position || b?.pos || b?.position || b?.origin || p?.ent?.origin;
    return cand ? toVec(cand, new THREE.Vector3()) : null;
  }
  _bombPlanted(p) {
    this._stopLoop({ id: 'plant' }, 0.05);
    const pos = this._bombPos(p);
    if (!pos) return;
    this.playAt('bomb_arm', pos, {});
    const timer = p.timer ?? World.match?.bomb?.timer ?? World.cvar.mp_c4timer ?? 40;
    this.bomb = { pos, t0: World.time, timer, next: World.time + 1.0, warned: false, final: false };
    this.bank.bump(['bomb_beep', 'bomb_final', 'stinger_bomb10', 'bomb_explode', 'bomb_explode_far']);
  }
  _bombTimeLeft() {
    const b = World.match?.bomb;
    const tl = b?.timeLeft ?? (b?.explodeAt != null ? b.explodeAt - World.time : null) ?? (b?.blowTime != null ? b.blowTime - World.time : null);
    if (typeof tl === 'number' && isFinite(tl)) return tl;
    return this.bomb.timer - (World.time - this.bomb.t0);
  }
  _updateBomb() {
    const B = this.bomb;
    if (!B) return;
    const left = this._bombTimeLeft();
    const now = World.time;
    if (left <= 10 && !B.warned) { B.warned = true; this.warning = this.play('stinger_bomb10', { jitter: 0, delay: Math.max(0, left - 10) }); }
    if (left <= 1.0) {
      if (!B.final && !this.seen.bombBeep) { B.final = true; this.playAt('bomb_final', B.pos, { jitter: 0 }); }
      return;
    }
    if (this.seen.bombBeep) return; // the C4 module emits its own beeps
    if (now >= B.next) {
      // CS cadence: interval shrinks linearly with the fuse, from ~1 s to 0.15 s
      const frac = Math.max(0, left / B.timer);
      const interval = Math.max(0.15, 0.1 + 0.9 * frac);
      // the beep carries further as the fuse runs down
      this.playAt('bomb_beep', B.pos, { jitter: 0, volume: 1 + 0.4 * (1 - frac), range: 1 + 0.7 * (1 - frac) });
      B.next = now + interval;
    }
  }
  _stopWarning() { if (this.warning?.alive) this.warning.stop(0.4); this.warning = null; }

  _trk(ent) {
    let t = this.track.get(ent);
    if (!t) { t = { active: null, activeObj: undefined, onGround: true, air: 0, vyMin: 0, ducking: false, stepT: 0, deployT: 0 }; this.track.set(ent, t); }
    return t;
  }

  /** Detect weapon switches (deploy), and jump/land/footsteps when those events are absent. */
  _trackEntities(dt) {
    const now = performance.now();
    const synthSteps = this.seen.footstep === 0;   // fallbacks switch off for good once real events arrive
    const synthJump = this.seen.jumpland === 0;
    for (const e of World.entities) {
      if (!e || e.alive === false) continue;
      const t = this._trk(e);
      if (e.active !== t.activeObj) {
        t.activeObj = e.active;
        const key = weaponKey(e.active);
        if (key && key !== t.active) { if (t.active !== null) this._deploy(e, key); t.active = key; }
      }
      const og = e.onGround !== false;
      const vy = e.velocity?.y ?? 0;
      if (!og) { t.air += dt; t.vyMin = Math.min(t.vyMin, vy); }
      if (synthJump) {
        if (t.onGround && !og && vy > 150) this._entSound('jump', e, { volume: 0.8 }, 'feet');
        if (!t.onGround && og && t.air > 0.25) this._land(e, this._groundSurface(e), Math.abs(t.vyMin));
      }
      if (og) { t.air = 0; t.vyMin = 0; }
      t.onGround = og;
      // footstep cadence fallback (walking with shift < 135 u/s is silent, as in CS)
      if (synthSteps && og && e.velocity && !World.cameraOverride) {
        const sp = Math.hypot(e.velocity.x, e.velocity.z);
        if (sp > 135 && !e.ducking) {
          t.stepT -= dt;
          if (t.stepT <= 0) { t.stepT = 0.33 * Math.sqrt(250 / sp); this.footstep(e, this._groundSurface(e), 1); }
        } else t.stepT = 0.05;
      }
    }
    if (this.track.size > World.entities.length + 16) this.track.clear();
  }
  _groundSurface(e) {
    if (e.groundSurface) return e.groundSurface;
    const col = World.collision;
    if (!col?.rayTrace || !e.origin) return 'concrete';
    try { _v.copy(e.origin); _v.y += 4; _v2.copy(e.origin); _v2.y -= 24; const tr = col.rayTrace(_v, _v2, MASK_VISIBLE); return tr.fraction < 1 ? tr.surface || 'concrete' : 'concrete'; }
    catch { return 'concrete'; }
  }

  _updateFlash() {
    if (!this.pendingFlash.length) return;
    for (let i = this.pendingFlash.length - 1; i >= 0; i--) {
      const f = this.pendingFlash[i];
      if (--f.frames > 0) continue;
      this.pendingFlash.splice(i, 1);
      let amt = f.amount;
      const me = World.local;
      if (amt == null && me) amt = World.fx?.blindAmount?.(me);
      if (amt == null || !isFinite(amt)) {
        // estimate: line of sight, distance and how directly we were looking at it
        const d = f.pos.distanceTo(this.listenerPos);
        if (d > 1800 || !this._los(f.pos)) amt = 0;
        else {
          _v.subVectors(f.pos, this.listenerPos).normalize();
          const facing = Math.max(0, _v.dot(_fwd));
          amt = Math.min(1, (1 - d / 1800) * (0.35 + 0.65 * facing) * 1.3);
        }
      }
      if (amt > 0.1) this.flashed(amt, 0.6 + 4.2 * amt);
    }
  }

  // ---- per-frame -----------------------------------------------------------------------------
  update(dt) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    // listener = camera
    const cam = World.camera;
    if (cam) {
      if (cam.getWorldPosition) { cam.getWorldPosition(_lp); cam.getWorldQuaternion(_q); }
      else { _lp.copy(cam.position); _q.copy(cam.quaternion); }
      this.listenerPos.copy(_lp);
      _fwd.set(0, 0, -1).applyQuaternion(_q);
      _up.set(0, 1, 0).applyQuaternion(_q);
      const L = ctx.listener;
      if (L.positionX) {
        L.positionX.value = _lp.x; L.positionY.value = _lp.y; L.positionZ.value = _lp.z;
        L.forwardX.value = _fwd.x; L.forwardY.value = _fwd.y; L.forwardZ.value = _fwd.z;
        L.upX.value = _up.x; L.upY.value = _up.y; L.upZ.value = _up.z;
      } else { L.setPosition?.(_lp.x, _lp.y, _lp.z); L.setOrientation?.(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z); }
    }
    this.occl.beginFrame(now);
    if (this.voices.length < 22) this.warm(Math.min(16, this.voices.length + 1), 6); // build the pool over a few frames
    this.mixer.update(dt);
    if (World.collision) this.reverb.update(dt, this.listenerPos);

    // voices: retire finished, follow entities, refresh distance/occlusion (~20 Hz each)
    const cv = World.cvar, scale = cv.snd_distance ?? 1, occOn = (cv.snd_occlusion ?? 1) > 0;
    for (const v of this.voices) {
      if (v.state === 2) { if (now >= v.freeAt) v.free(); continue; }
      if (v.state !== 1) continue;
      if (now >= v.end) { v.free(); continue; }
      if (!v.spatial || now < v.nextUpd) continue;
      v.nextUpd = now + 0.05;
      if (v.ent && v.ent.alive !== false) { if (v.attach === 'feet') feetOf(v.ent, v.pos); else if (v.attach === 'eye') eyeOf(v.ent, v.pos); }
      this._setPannerPos(v, now);
      const d = v.pos.distanceTo(this.listenerPos);
      const dg = distanceGain(v.p, d, scale * v.range);
      let occ = v.occ;
      if (v.occlude && occOn) occ = this.occl.query(this.listenerPos, v.pos, v.id, 3) * v.p.occl * cv.snd_occlusion;
      v.occ += (occ - v.occ) * 0.5;
      const g = this._gainFor(v, dg, v.occ), fc = this._cutFor(d, v.occ);
      const tc = v.rampT ?? 0.04;
      if (Math.abs(g - v.lastG) > v.lastG * 0.03 + 1e-5) { v.gain.gain.setTargetAtTime(g, now, tc); v.lastG = g; v.rampT = null; }
      if (Math.abs(fc - v.lastF) > v.lastF * 0.05) { v.filter.frequency.setTargetAtTime(fc, now, 0.05); v.lastF = fc; }
      v.send.gain.setTargetAtTime(this._sendFor(v, dg, v.occ), now, 0.06);
    }

    // timers
    if (this.timers.length) {
      for (let i = this.timers.length - 1; i >= 0; i--) {
        const t = this.timers[i];
        if (now >= t.t) { this.timers.splice(i, 1); try { t.fn(); } catch (err) { console.error('[audio] timer', err); } }
      }
    }
    if (this.deferred.length && performance.now() - this.deferred[0].t > 400) this.deferred.length = 0;
    this._updateBomb();
    this._updateFlash();
    this._trackEntities(dt);
    this.ambient.update(dt, this.listenerPos);
  }
}
