// Mechanical / foley building blocks shared by weapons, footsteps, grenades and the bomb.
// Every function ADDS into `out` at time `t` (seconds) and is deterministic given `s`.
import { white, pink, svf, biquad, modal, mix, scale, copy, tick, onepole, envAD, wander, TAU } from './dsp.js';

const ms = (s, t) => Math.round(t * s.sr);

/** Short filtered noise burst: the basis of clicks and transients. */
export function burst(out, s, t, { dur = 0.003, amp = 1, hp = 0, lp = 0, bp = 0, q = 1, attack = 0.00015, decay = null } = {}) {
  const n = s.n(dur * 1.0 + 0.002);
  const b = white(n, s.r);
  envAD(b, s.sr, attack, decay ?? dur / 3);
  if (hp) svf(b, s.sr, 'hp', hp, 0.7);
  if (lp) svf(b, s.sr, 'lp', lp, 0.7);
  if (bp) svf(b, s.sr, 'bp', bp, q);
  return mix(out, b, amp, ms(s, t));
}

/**
 * Metal-on-metal clack: sharp click + inharmonic ring + low clunk.
 * f = fundamental of the ring; ring = ring decay seconds; body = clunk amount.
 */
export function clack(out, s, t, { amp = 1, f = 2500, ring = 0.018, bright = 1, body = 0.5, bodyF = 520, click = 1, modes = null } = {}) {
  const at = ms(s, t);
  burst(out, s, t, { dur: 0.0012, amp: 0.9 * amp * click, hp: 1800 * bright, decay: 0.0004 });
  burst(out, s, t, { dur: 0.004, amp: 0.5 * amp * click, bp: f * 1.3, q: 0.8, decay: 0.0012 });
  const ratios = modes || [1, 1.47, 2.09, 2.56, 3.13, 3.94, 4.7];
  const md = ratios.map((r, i) => [f * r * s.jit(1, 0.03), (0.5 / (1 + i * 0.55)) * s.rand(0.6, 1.1), ring * s.rand(0.6, 1.2) / (1 + i * 0.25), s.rand(0, TAU)]);
  modal(out, s.sr, at, md, amp * 0.55);
  if (body > 0) burst(out, s, t, { dur: 0.012, amp: amp * body * 1.4, bp: bodyF, q: 1.8, decay: 0.006 });
  return out;
}

/** Friction scrape (slide/bolt travel): noise with stick-slip roughness, swept bandpass. */
export function scrape(out, s, t, dur, { amp = 0.4, f0 = 2500, f1 = 3500, q = 1.4, rough = 0.7, hp = 700 } = {}) {
  const n = s.n(dur);
  const b = white(n, s.r);
  // stick-slip: rectified fast wander multiplies the noise
  const w = wander(n, s.sr, 180, s.r);
  const w2 = wander(n, s.sr, 30, s.r);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7;
    b[i] *= env * (1 - rough + rough * Math.abs(w[i])) * (0.75 + 0.25 * w2[i]);
  }
  svf(b, s.sr, 'bp', (tt) => f0 + (f1 - f0) * Math.min(1, tt / dur), q);
  svf(b, s.sr, 'hp', hp, 0.7);
  return mix(out, b, amp, ms(s, t));
}

/** Cloth / gear rustle. */
export function cloth(out, s, t, dur, { amp = 0.3, f = 2200, q = 0.7, rate = 35, lo = 0 } = {}) {
  const n = s.n(dur);
  const b = pink(n, s.r);
  const w = wander(n, s.sr, rate, s.r);
  const w2 = wander(n, s.sr, rate * 0.3, s.r);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = Math.pow(Math.sin(Math.PI * u), 0.8);
    const flutter = Math.max(0, 0.35 + 0.65 * w[i]) * (0.7 + 0.3 * w2[i]);
    b[i] *= env * flutter;
  }
  svf(b, s.sr, 'bp', f, q);
  svf(b, s.sr, 'hp', 350, 0.7);
  if (lo) { const l = copy(b); svf(l, s.sr, 'lp', 500, 0.7); mix(b, l, lo); }
  return mix(out, b, amp * 2.2, ms(s, t));
}

/** Loose kit rattle: a burst of small metallic ticks. */
export function rattle(out, s, t, dur, { amp = 0.25, count = 10, f = 4200, ring = 0.006 } = {}) {
  for (let i = 0; i < count; i++) {
    const tt = t + dur * Math.pow(s.r(), 1.3);
    const a = amp * s.rand(0.3, 1);
    modal(out, s.sr, ms(s, tt), [[f * s.rand(0.7, 1.4), a, ring * s.rand(0.5, 1.5)], [f * s.rand(1.6, 2.4), a * 0.5, ring * 0.6]], 1);
    tick(out, ms(s, tt), a * 0.6, s, 0.0006, 0.9);
  }
  return out;
}

/** Air whoosh: swept bandpass noise with a bell envelope. */
export function whoosh(out, s, t, dur, { amp = 0.5, f0 = 500, f1 = 2500, q = 1.2, peakAt = 0.45 } = {}) {
  const n = s.n(dur);
  const b = pink(n, s.r);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const e = u < peakAt ? Math.pow(u / peakAt, 2) : Math.pow(1 - (u - peakAt) / (1 - peakAt), 1.6);
    b[i] *= e;
  }
  svf(b, s.sr, 'bp', (tt) => { const u = Math.min(1, tt / dur); return f0 * Math.pow(f1 / f0, Math.sin(u * Math.PI * 0.5)); }, q);
  return mix(out, b, amp * 2, ms(s, t));
}

/** Spring twang: short decaying glide. */
export function spring(out, s, t, { amp = 0.12, f = 1100, dur = 0.05 } = {}) {
  const n = s.n(dur);
  const b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const fr = f * (1 + 0.6 * Math.exp(-u * 8)) * (1 + 0.03 * Math.sin(TAU * 60 * i / s.sr));
    ph += TAU * fr / s.sr;
    b[i] = Math.sin(ph) * Math.exp(-u * 5) * (1 - Math.exp(-i / 20));
  }
  return mix(out, b, amp, ms(s, t));
}

/**
 * Body thud (boot, fist, body, sandbag): band-limited noise body (100-500 Hz) carries it, a short
 * pitch-dropping sine adds weight without turning into sub rumble.
 */
export function thud(out, s, t, { amp = 0.8, f0 = 140, f1 = 60, dec = 0.05, noise = 0.6, lp = 700 } = {}) {
  const n = s.n(dec * 6 + 0.01);
  const b = new Float32Array(n);
  let ph = 0, f = f0 - f1;
  const lo = Math.max(f1, 75);
  const kf = Math.exp(-1 / (0.012 * s.sr));
  for (let i = 0; i < n; i++) { b[i] = Math.sin(ph); ph += TAU * (lo + f) / s.sr; f *= kf; }
  envAD(b, s.sr, 0.0015, dec * 0.6);
  const nz = pink(n, s.r);
  envAD(nz, s.sr, 0.0005, dec * 0.7);
  svf(nz, s.sr, 'lp', Math.max(lp, 400), 0.8);
  svf(nz, s.sr, 'hp', 110, 0.7);
  const pb = peakOf(b) || 1, pn = peakOf(nz) || 1;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = b[i] / pb * 0.5 + nz[i] / pn * Math.min(1.2, 0.35 + noise * 0.45);
  svf(o, s.sr, 'hp', 55, 0.7);
  return mix(out, o, amp, ms(s, t));
}
const peakOf = (x) => { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; };

/** Plastic/polymer tock: damped low-Q resonance. */
export function tock(out, s, t, { amp = 0.5, f = 900, dec = 0.012 } = {}) {
  const at = ms(s, t);
  modal(out, s.sr, at, [[f, 0.6, dec], [f * 2.3, 0.3, dec * 0.6], [f * 3.9, 0.15, dec * 0.4]], amp);
  burst(out, s, t, { dur: 0.002, amp: amp * 0.5, bp: f * 2, q: 0.7 });
  return out;
}

/** Electronic beep with slight buzz and soft edges (C4, keypads). */
export function beep(out, s, t, dur, { amp = 0.4, f = 2000, harm = 0.35, buzz = 0.1, attack = 0.002, release = 0.006 } = {}) {
  const n = s.n(dur + release);
  const b = new Float32Array(n);
  const na = Math.max(1, Math.round(attack * s.sr)), nd = s.n(dur), nr = Math.max(1, Math.round(release * s.sr));
  for (let i = 0; i < n; i++) {
    const ph = TAU * f * i / s.sr;
    let e = i < na ? i / na : 1;
    if (i > nd) e *= Math.max(0, 1 - (i - nd) / nr);
    // piezo: fundamental + odd partials + a little 2nd for asymmetry
    const v = Math.sin(ph) + harm * Math.sin(3 * ph) * 0.6 + harm * 0.3 * Math.sin(5 * ph) + 0.12 * Math.sin(2 * ph + 0.7);
    b[i] = v * e * (1 + buzz * Math.sin(TAU * 100 * i / s.sr));
  }
  return mix(out, b, amp * 0.6, ms(s, t));
}

