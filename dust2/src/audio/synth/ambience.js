// Desert ambience: wind bed, gust whistles, distant birds, far rattles, spatial emitters,
// and the procedural impulse responses used by the runtime convolution reverb.
import { white, pink, brown, svf, mix, modal, dcblock, fadeOut, fadeIn, envAD, TAU, osc, wander, scale, peak, copy, impulse, tick, scatter } from './dsp.js';
import { loopify } from './explosives.js';
import { clack, rattle, cloth, burst } from './mech.js';

const unit = (x) => { const p = peak(x); return p > 1e-9 ? scale(x, 1 / p) : x; };

/** Stereo wind loop (~24 s) with gusts. */
export function windBed(s) {
  const sr = s.sr, L = 24, X = 3, n = s.n(L + X);
  // shared gust envelope with a little L/R skew so gusts move across the stereo field
  const gust = wander(n, sr, 0.18, s.r), gust2 = wander(n, sr, 0.5, s.r);
  const outs = [];
  for (let ch = 0; ch < 2; ch++) {
    const sk = s.n(ch ? 0.35 : 0);
    const g = (i) => { const k = Math.max(0, i - sk); return Math.max(0, 0.55 + 0.35 * gust[k] + 0.15 * gust2[k]); };
    // low body
    const lo = brown(n, s.r); svf(lo, sr, 'lp', 220, 0.7); svf(lo, sr, 'hp', 30, 0.7);
    // mid whoosh with moving band
    const md = pink(n, s.r);
    const band = new Float32Array(n);
    for (let i = 0; i < n; i++) band[i] = 380 + 520 * g(i);
    svf(md, sr, 'bp', band, 0.9);
    // sand hiss riding the gusts
    const hs = white(n, s.r); svf(hs, sr, 'bp', 5200, 0.6);
    // narrow whistles through gaps (very quiet, only in strong gusts)
    const wh = white(n, s.r);
    const wf = new Float32Array(n);
    const wv = wander(n, sr, 0.3, s.r);
    for (let i = 0; i < n; i++) wf[i] = 900 + 260 * wv[i] + 200 * g(i);
    svf(wh, sr, 'bp', wf, 18);
    const o = new Float32Array(n);
    const lop = peak(lo) || 1, mdp = peak(md) || 1, hsp = peak(hs) || 1, whp = peak(wh) || 1;
    for (let i = 0; i < n; i++) {
      const G = g(i);
      o[i] = lo[i] / lop * (0.5 + 0.5 * G) * 0.9 + md[i] / mdp * G * 0.55 + hs[i] / hsp * Math.pow(G, 2.5) * 0.12 + wh[i] / whp * Math.max(0, G - 0.75) * 0.5;
    }
    dcblock(o, sr, 25);
    outs.push(loopify(o, sr, X));
  }
  const p = Math.max(peak(outs[0]), peak(outs[1])) || 1;
  for (const o of outs) scale(o, 0.89 / p);
  return outs;
}

/** Distant bird: a short phrase of FM chirps. */
export function bird(s) {
  const sr = s.sr, o = new Float32Array(s.n(1.4));
  const kind = Math.floor(s.r() * 3);
  let t = 0.02;
  const notes = kind === 0 ? 3 + Math.floor(s.r() * 3) : kind === 1 ? 2 : 6;
  for (let k = 0; k < notes; k++) {
    const dur = kind === 2 ? s.rand(0.03, 0.05) : s.rand(0.07, 0.16);
    const n = s.n(dur), f0 = s.rand(2200, 3800), f1 = f0 * (kind === 1 ? s.rand(0.6, 0.75) : s.rand(1.1, 1.5));
    const fr = new Float32Array(n);
    for (let i = 0; i < n; i++) { const u = i / n; fr[i] = f0 + (f1 - f0) * Math.sin(u * Math.PI * 0.5) + 180 * Math.sin(TAU * s.rand(28, 40) * i / sr); }
    const v = osc(n, sr, fr, 'sine');
    for (let i = 0; i < n; i++) { const u = i / n; v[i] *= Math.sin(Math.PI * u) ** 1.5; }
    mix(o, v, s.rand(0.5, 1), s.n(t));
    t += dur + (kind === 2 ? s.rand(0.02, 0.04) : s.rand(0.05, 0.14));
  }
  svf(o, sr, 'lp', 5000, 0.7); // distance
  fadeOut(o, sr, 0.02);
  return [unit(o)];
}

/** Far-away tin / chain rattle carried on the wind. */
export function farRattle(s) {
  const o = new Float32Array(s.n(1.5));
  const n = 3 + Math.floor(s.r() * 5);
  for (let k = 0; k < n; k++) {
    const t = s.rand(0, 0.9);
    clack(o, s, t, { amp: s.rand(0.2, 0.6), f: s.rand(700, 1400), ring: s.rand(0.05, 0.15), body: 0.4, bodyF: 300, modes: [1, 1.52, 2.3, 3.1, 4.3] });
  }
  svf(o, s.sr, 'lp', 2500, 0.7); svf(o, s.sr, 'hp', 150, 0.7);
  fadeOut(o, s.sr, 0.05);
  return [unit(o)];
}

/** Electrical hum loop (power box / transformer): 50 Hz family + buzz. Seamless at 4 s. */
export function powerHum(s) {
  const sr = s.sr, L = 4, n = s.n(L);
  const o = new Float32Array(n);
  const H = [[100, 1], [200, 0.45], [300, 0.28], [400, 0.12], [500, 0.08], [700, 0.05], [900, 0.03], [1100, 0.025]];
  for (const [f, a] of H) { const ph = s.rand(0, TAU); for (let i = 0; i < n; i++) o[i] += a * Math.sin(TAU * f * i / sr + ph); }
  // mains buzz: rectified pulses rich in harmonics
  for (let i = 0; i < n; i++) { const v = Math.sin(TAU * 100 * i / sr); o[i] += 0.12 * Math.sign(v) * Math.pow(Math.abs(v), 12); }
  const hs = white(s.n(L + 1), s.r); svf(hs, sr, 'bp', 3000, 0.7);
  const lp = loopify(hs, sr, 1);
  mix(o, lp, 0.02);
  return [unit(o)];
}

/** Flapping tarp loop (8 s): cloth flutter bursts driven by gusts. */
export function tarpFlap(s) {
  const sr = s.sr, L = 8, X = 1, n = s.n(L + X);
  const o = new Float32Array(n);
  let t = 0.1;
  while (t < L + X - 0.5) {
    const burstLen = s.rand(0.3, 1.1);
    const rate = s.rand(7, 13);
    for (let tt = 0; tt < burstLen; tt += 1 / rate * s.rand(0.8, 1.2)) {
      const a = Math.sin(Math.PI * tt / burstLen) * s.rand(0.4, 1);
      cloth(o, s, t + tt, 0.05, { amp: a * 0.6, f: s.rand(700, 1300), q: 0.8, rate: 80, lo: 0.8 });
      burst(o, s, t + tt, { dur: 0.01, amp: a * 0.35, bp: 600, q: 0.8, decay: 0.004 });
    }
    t += burstLen + s.rand(0.3, 1.6);
  }
  const bed = pink(n, s.r); svf(bed, sr, 'bp', 900, 0.6); mix(o, unit(bed), 0.02);
  dcblock(o, sr, 40);
  return [unit(loopify(o, sr, X))];
}

// ---- impulse responses for the runtime convolution reverb -----------------------------------
export function irOpen(s) {
  // open desert: short dry slap off nearby walls, little diffuse energy
  return impulse(s.sr, 101, { len: 1.0, t60Lo: 0.55, t60Hi: 0.25, xover: 1200, predelay: 0.012, diffuse: 0.2, hiGain: 0.45,
    early: [[0.021, 0.9, 3500], [0.047, 0.7, 3000], [0.083, 0.55, 2500], [0.131, 0.4, 2000], [0.19, 0.25, 1800]], lp: 5000, hp: 90 });
}
export function irRoom(s) {
  // stone room / hallway: dense early reflections, medium decay
  return impulse(s.sr, 202, { len: 1.5, t60Lo: 1.1, t60Hi: 0.6, xover: 1800, predelay: 0.006, diffuse: 1, hiGain: 0.7,
    early: [[0.007, 0.8, 6000], [0.013, 0.6, 5000], [0.019, 0.55, 5000], [0.026, 0.45, 4000], [0.034, 0.4, 4000], [0.045, 0.3, 3500]], lp: 7000, hp: 80 });
}
export function irTunnel(s) {
  // tight tunnel: flutter between close walls -> ringing, low-mid build-up
  return impulse(s.sr, 303, { len: 1.8, t60Lo: 1.5, t60Hi: 0.7, xover: 1300, predelay: 0.004, diffuse: 0.8, hiGain: 0.6,
    comb: { delay: 0.0105, fb: 0.55 },
    early: [[0.0045, 0.9, 5000], [0.0105, 0.8, 4500], [0.021, 0.6, 4000], [0.0315, 0.45, 3500], [0.042, 0.35, 3000]], lp: 5500, hp: 70 });
}
