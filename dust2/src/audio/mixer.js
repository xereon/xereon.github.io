// Bus graph + master chain + per-sound runtime profiles.
//
//   weapons ┐
//   foley   ┤                                 ┌─ ui ─────┐
//   world   ├─> deafen LP ─> deafen gain ─┐   ├─ music ──┤
//   ambience┘   (flashbang)               ├──>┴──────────┴─> master ─> glue comp ─> limiter ─> ceiling ─> out
//   reverb returns ───────────────────────┘   self (tinnitus) ┘
import { World } from '../core/world.js';

const dB = (d) => Math.pow(10, d / 20);
export const BUSES = ['weapons', 'foley', 'world', 'ambience', 'ui', 'music', 'self'];
const DEAFENED = new Set(['weapons', 'foley', 'world', 'ambience']);
export const BUS_CVAR = { weapons: 'snd_weapons', foley: 'snd_footsteps', world: 'snd_world', ambience: 'snd_ambience', ui: 'snd_ui', music: 'snd_music' };

/**
 * Runtime profile for a sound name.
 * bus, level (dB at <= ref), ref/max (units), prio (0..1 importance), spatial (false = 2D),
 * far (crossfade partner), xf [start, end] crossfade distances, occl (occlusion strength), send (reverb send dB)
 */
const RULES = [
  [/^weapon_.*_fire_2d$/, { bus: 'weapons', level: -1, spatial: false, prio: 1, send: -14 }],
  [/^weapon_(m4a1s|usp|mp5sd)_fire$/, { bus: 'weapons', level: -4, ref: 110, max: 1500, prio: 0.9, farSuffix: true, xf: [500, 1200], send: -12 }],
  [/^weapon_(m4a1s|usp|mp5sd)_fire_far$/, { bus: 'weapons', level: -8, ref: 110, max: 1500, prio: 0.9, send: -8 }],
  [/^weapon_taser_fire$/, { bus: 'weapons', level: -4, ref: 120, max: 1400, prio: 0.8, send: -12 }],
  [/^weapon_.*_fire$/, { bus: 'weapons', level: 0, ref: 260, max: 6000, prio: 0.95, farSuffix: true, xf: [650, 1700], send: -10 }],
  [/^weapon_.*_fire_far$/, { bus: 'weapons', level: -1, ref: 260, max: 6000, prio: 0.95, send: -6 }],
  [/^footstep_/, { bus: 'foley', level: 3, ref: 130, max: 1100, prio: 0.85, send: -16 }],
  [/^(jump|land|crouch)$/, { bus: 'foley', level: -3, ref: 100, max: 950, prio: 0.75, send: -18 }],
  [/^(fall_damage|death_fall)$/, { bus: 'foley', level: -6, ref: 100, max: 1200, prio: 0.7, send: -14 }],
  [/^impact_/, { bus: 'world', level: -9, ref: 70, max: 1600, prio: 0.45, send: -14 }],
  [/^shell_/, { bus: 'world', level: -21, ref: 40, max: 500, prio: 0.12, send: -20 }],
  [/^hit_head/, { bus: 'weapons', level: -3, ref: 320, max: 3500, prio: 0.97, send: -16, occl: 0.4 }],
  [/^hit_(body|kevlar)$/, { bus: 'weapons', level: -7, ref: 150, max: 1800, prio: 0.75, send: -16 }],
  [/^he_explode$/, { bus: 'weapons', level: 3, ref: 500, max: 9000, prio: 1, farSuffix: true, xf: [900, 2400], send: -6 }],
  [/^he_explode_far$/, { bus: 'weapons', level: 2, ref: 500, max: 9000, prio: 1, send: -4 }],
  [/^bomb_explode$/, { bus: 'weapons', level: 5, ref: 900, max: 14000, prio: 1, farSuffix: true, xf: [1400, 3500], send: -4 }],
  [/^bomb_explode_far$/, { bus: 'weapons', level: 4, ref: 900, max: 14000, prio: 1, send: -3 }],
  [/^flash_pop$/, { bus: 'weapons', level: 0, ref: 380, max: 6000, prio: 0.95, farSuffix: true, xf: [900, 2200], send: -8 }],
  [/^flash_pop_far$/, { bus: 'weapons', level: -1, ref: 380, max: 6000, prio: 0.95, send: -6 }],
  [/^tinnitus$/, { bus: 'self', level: -14, spatial: false, prio: 1 }],
  [/^smoke_pop$/, { bus: 'world', level: -6, ref: 200, max: 2200, prio: 0.8, send: -10 }],
  [/^smoke_loop$/, { bus: 'world', level: -15, ref: 150, max: 1400, prio: 0.6, send: -12 }],
  [/^molotov_break$/, { bus: 'weapons', level: -3, ref: 220, max: 2600, prio: 0.9, send: -10 }],
  [/^fire_loop$/, { bus: 'world', level: -9, ref: 180, max: 1800, prio: 0.75, send: -12 }],
  [/^fire_out$/, { bus: 'world', level: -10, ref: 150, max: 1400, prio: 0.5 }],
  [/^decoy_pop$/, { bus: 'world', level: -10, ref: 100, max: 1200, prio: 0.4 }],
  [/^nade_bounce_/, { bus: 'world', level: -9, ref: 90, max: 1300, prio: 0.7, send: -14 }],
  [/^nade_(pin|throw)$/, { bus: 'foley', level: -12, ref: 70, max: 800, prio: 0.6, send: -18 }],
  [/^bomb_beep$/, { bus: 'world', level: -5, ref: 220, max: 2600, prio: 0.92, send: -14, occl: 0.6 }],
  [/^bomb_final$/, { bus: 'world', level: -3, ref: 300, max: 3500, prio: 0.95, send: -14, occl: 0.5 }],
  [/^bomb_(key|plant|arm|defusing|defused)$/, { bus: 'world', level: -9, ref: 110, max: 1300, prio: 0.8, send: -16 }],
  [/^(deploy_|wpn_)/, { bus: 'foley', level: -11, ref: 60, max: 750, prio: 0.35, send: -18 }],
  [/^weapon_land$/, { bus: 'world', level: -9, ref: 90, max: 1100, prio: 0.5, send: -16 }],
  [/^item_pickup$/, { bus: 'foley', level: -12, ref: 60, max: 600, prio: 0.4, send: -18 }],
  [/^radio_chirp$/, { bus: 'ui', level: -18, spatial: false, prio: 0.6 }],
  [/^knife_/, { bus: 'weapons', level: -6, ref: 80, max: 900, prio: 0.6, send: -16 }],
  [/^(ui_|radio_)/, { bus: 'ui', level: -12, spatial: false, prio: 1 }],
  [/^stinger_/, { bus: 'music', level: -9, spatial: false, prio: 1 }],
  [/^amb_wind$/, { bus: 'ambience', level: -21, spatial: false, prio: 0.3 }],
  [/^amb_(bird|rattle)$/, { bus: 'ambience', level: -24, ref: 400, max: 5000, prio: 0.1, occl: 0 }],
  [/^amb_powerbox$/, { bus: 'ambience', level: -20, ref: 50, max: 520, prio: 0.15, send: -20 }],
  [/^amb_tarp$/, { bus: 'ambience', level: -19, ref: 110, max: 950, prio: 0.15, send: -18 }],
];
const DEFAULT = { bus: 'world', level: -10, ref: 100, max: 1500, prio: 0.5, send: -14 };
const cache = new Map();
export function profile(name) {
  let p = cache.get(name);
  if (p) return p;
  p = { ...DEFAULT };
  for (const [re, v] of RULES) if (re.test(name)) { Object.assign(p, v); break; }
  p.spatial = p.spatial !== false;
  p.gain = dB(p.level);
  p.sendGain = p.send != null ? dB(p.send) : 0;
  p.occl = p.occl ?? 1;
  if (p.farSuffix) p.far = name + '_far';
  cache.set(name, p);
  return p;
}

/**
 * Distance attenuation: inverse-distance from `ref`, then a smooth fade to silence at `max`
 * (CS-style hard audibility radius: footsteps die at ~1100u, gunshots carry across the map).
 */
export function distanceGain(p, d, scale = 1) {
  const ref = p.ref * scale, max = p.max * scale;
  if (d >= max) return 0;
  let g = d <= ref ? 1 : Math.pow(ref / d, 0.9);
  const u = d / max;
  if (u > 0.78) { const k = (u - 0.78) / 0.22; g *= 1 - k * k * (3 - 2 * k); }
  return g;
}

/** Air absorption lowpass cutoff (Hz) at distance d (units). */
export const airCutoff = (d) => 20000 / (1 + d / 1400);

export class Mixer {
  /** @param {BaseAudioContext} ctx */
  constructor(ctx, dest = ctx.destination) {
    this.ctx = ctx;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    // master chain
    this.master = g(0.8);
    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -12; this.glue.knee.value = 12; this.glue.ratio.value = 2;
    this.glue.attack.value = 0.006; this.glue.release.value = 0.18;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.09;
    this.trim = g(dB(-3.5));   // Chrome's compressors add automatic make-up gain; claw it back
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = softCeilingCurve(0.84);
    this.ceiling.oversample = 'none';
    this.master.connect(this.glue).connect(this.limiter).connect(this.trim).connect(this.ceiling).connect(dest);

    // deafen group (flashbang)
    this.deafLP = ctx.createBiquadFilter(); this.deafLP.type = 'lowpass'; this.deafLP.frequency.value = 20000; this.deafLP.Q.value = 0.5;
    this.deafGain = g(1);
    this.deafLP.connect(this.deafGain).connect(this.master);

    this.bus = {};
    for (const b of BUSES) {
      const n = g(1);
      n.connect(DEAFENED.has(b) ? this.deafLP : this.master);
      this.bus[b] = n;
    }
    // ambience/music duck stage (sidechain from weapons)
    this.duck = g(1);
    this.bus.ambience.disconnect(); this.bus.ambience.connect(this.duck).connect(this.deafLP);
    this.musicDuck = g(1);
    this.bus.music.disconnect(); this.bus.music.connect(this.musicDuck).connect(this.master);

    // sidechain detector on the weapons bus
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.bus.weapons.connect(this.analyser);
    this._scBuf = new Float32Array(this.analyser.fftSize);
    this._duckEnv = 0;
    this.deafUntil = 0;
  }

  /** Reverb returns enter before the deafen filter. */
  get worldIn() { return this.deafLP; }

  applyCvars() {
    const cv = World.cvar;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(Math.max(0, cv.volume ?? 0.8), t, 0.03);
    for (const [b, name] of Object.entries(BUS_CVAR)) this.bus[b].gain.setTargetAtTime(Math.max(0, cv[name] ?? 1), t, 0.03);
  }

  /** Sidechain ducking of ambience (and a touch of music) under gunfire. */
  update(dt) {
    const a = this.analyser;
    a.getFloatTimeDomainData(this._scBuf);
    let s = 0;
    const buf = this._scBuf;
    for (let i = 0; i < buf.length; i += 2) s += buf[i] * buf[i];
    const rms = Math.sqrt(s / (buf.length / 2));
    const lvl = 20 * Math.log10(rms + 1e-9);
    const amt = World.cvar.snd_duck ?? 0.7;
    // above -38 dBFS on the weapons bus start ducking, ~12 dB at full scale
    const target = Math.min(1, Math.max(0, (lvl + 38) / 30)) * amt;
    const k = target > this._duckEnv ? 1 - Math.exp(-dt / 0.02) : 1 - Math.exp(-dt / 0.9);
    this._duckEnv += (target - this._duckEnv) * k;
    const t = this.ctx.currentTime;
    this.duck.gain.setTargetAtTime(dB(-12 * this._duckEnv), t, 0.02);
    this.musicDuck.gain.setTargetAtTime(dB(-4 * this._duckEnv), t, 0.05);
  }

  /** Flashbang / close explosion: muffle the world, recover over `dur` seconds. */
  deafen(amount, dur) {
    const t = this.ctx.currentTime;
    const f = this.deafLP.frequency, gn = this.deafGain.gain;
    const cut = 20000 * Math.pow(350 / 20000, amount);
    f.cancelScheduledValues(t); gn.cancelScheduledValues(t);
    f.setValueAtTime(Math.max(f.value, 30), t);
    f.exponentialRampToValueAtTime(Math.max(200, cut), t + 0.03);
    f.setTargetAtTime(20000, t + dur * 0.35, dur * 0.3);
    gn.setValueAtTime(gn.value, t);
    gn.linearRampToValueAtTime(dB(-16 * amount), t + 0.03);
    gn.setTargetAtTime(1, t + dur * 0.3, dur * 0.3);
    this.deafUntil = t + dur;
  }
}

/** Soft ceiling: linear to ~0.6*c, then tanh knee that never exceeds c. */
function softCeilingCurve(c, n = 4096) {
  const curve = new Float32Array(n);
  const knee = 0.6 * c;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= knee ? a : knee + (c - knee) * Math.tanh((a - knee) / (c - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
