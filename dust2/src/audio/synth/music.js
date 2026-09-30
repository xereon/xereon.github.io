// UI sounds, radio and short original orchestral-hybrid stingers.
// Instruments are band-limited analog-style voices (detuned saw ensembles with filter/amp
// envelopes, vibrato, breath noise) + synthetic percussion, glued with an FDN hall.
import { white, pink, svf, biquad, mix, modal, softclip, dcblock, fadeOut, envAD, TAU, osc, sweepSine, scale, peak, copy, fdn, compress, wander } from './dsp.js';
import { clack, burst, tock, rattle, beep } from './mech.js';

const unit = (x) => { const p = peak(x); return p > 1e-9 ? scale(x, 1 / p) : x; };
const NOTES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
export const hz = (name) => { const m = /^([A-G][#b]?)(-?\d)$/.exec(name); return 440 * Math.pow(2, (NOTES[m[1]] + (+m[2] + 1) * 12 - 69) / 12); };

/** Stereo mix bus with constant-power pan. */
class Bus {
  constructor(s, dur) { this.s = s; this.L = new Float32Array(s.n(dur)); this.R = new Float32Array(s.n(dur)); }
  add(x, t, gain = 1, pan = 0) {
    const a = (pan + 1) * Math.PI / 4;
    mix(this.L, x, gain * Math.cos(a), this.s.n(t)); mix(this.R, x, gain * Math.sin(a), this.s.n(t));
  }
}

function adsr(n, sr, a, d, sus, r, dur, fade = 0) {
  const e = new Float32Array(n);
  const nd = Math.round(dur * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = t < a ? Math.pow(t / a, 1.6) : t < a + d ? 1 - (1 - sus) * ((t - a) / d) : sus;
    if (fade > 0 && t > a) v *= 1 - fade * Math.min(1, (t - a) / Math.max(0.01, dur - a));
    if (i > nd) v *= Math.exp(-(i - nd) / (r * sr) * 3);
    e[i] = v;
  }
  return e;
}
function vibFreq(n, sr, f, cents, depth, rate, delay, s) {
  const fr = new Float32Array(n), ratio = Math.pow(2, cents / 1200), ph = s.rand(0, TAU);
  for (let i = 0; i < n; i++) { const t = i / sr; const d = depth * Math.min(1, Math.max(0, (t - delay) / 0.3)); fr[i] = f * ratio * (1 + d * Math.sin(TAU * rate * t + ph)); }
  return fr;
}

function brass(bus, s, t, dur, f, vel = 0.8, pan = 0, bright = 1, fade = 0) {
  const sr = s.sr, n = s.n(dur + 0.45);
  const v = new Float32Array(n);
  for (const c of [-7, 0, 6.5]) mix(v, osc(n, sr, vibFreq(n, sr, f, c + s.rand(-1.5, 1.5), 0.0035, 5.2, 0.35, s), 'saw', s.rand(0, TAU)), 0.33);
  const br = white(n, s.r); svf(br, sr, 'bp', 1600, 1.4); mix(v, br, 0.008);
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    const open = tt < 0.09 ? tt / 0.09 : Math.max(0.55, 1 - (tt - 0.09) * 1.5);
    cut[i] = (250 + (500 + 2600 * vel) * bright * open) * (i > s.n(dur) ? Math.exp(-(i - s.n(dur)) / (0.2 * sr)) : 1) + 150;
  }
  svf(v, sr, 'lp', cut, 1.1);
  svf(v, sr, 'lp', cut, 0.6);
  svf(v, sr, 'hp', f * 0.7, 0.6);
  const e = adsr(n, sr, 0.07 + 0.04 * (1 - vel), 0.25, 0.8, 0.35, dur, fade);
  for (let i = 0; i < n; i++) v[i] *= e[i];
  softclip(v, 1.4);
  bus.add(v, t, vel * 0.5, pan);
}

function strings(bus, s, t, dur, f, vel = 0.6, pan = 0, attack = 0.35, fade = 0) {
  const sr = s.sr, n = s.n(dur + 0.8);
  const v = new Float32Array(n);
  for (let k = 0; k < 6; k++) mix(v, osc(n, sr, vibFreq(n, sr, f, s.rand(-14, 14), 0.003, s.rand(4.8, 6), 0.2, s), 'saw', s.rand(0, TAU)), 1 / 6);
  svf(v, sr, 'lp', 2600, 0.7); svf(v, sr, 'lp', 3000, 0.6); svf(v, sr, 'hp', 180, 0.7);
  svf(v, sr, 'peak', 1200, 1.2);
  const e = adsr(n, sr, attack, 0.3, 0.85, 0.8, dur, fade);
  for (let i = 0; i < n; i++) v[i] *= e[i];
  bus.add(v, t, vel * 0.45, pan);
}

function choir(bus, s, t, dur, f, vel = 0.5, pan = 0, fade = 0) {
  const sr = s.sr, n = s.n(dur + 1.0);
  const src = new Float32Array(n);
  for (let k = 0; k < 4; k++) mix(src, osc(n, sr, vibFreq(n, sr, f, s.rand(-10, 10), 0.004, s.rand(4.5, 5.5), 0.3, s), 'saw', s.rand(0, TAU)), 0.25);
  const v = new Float32Array(n);
  for (const [F, g, q] of [[750, 1, 5], [1150, 0.55, 7], [2600, 0.22, 9], [3300, 0.1, 9]]) mix(v, svf(copy(src), sr, 'bp', F, q), g);
  const e = adsr(n, sr, 0.5, 0.4, 0.9, 0.9, dur, fade);
  for (let i = 0; i < n; i++) v[i] *= e[i];
  bus.add(unit(v), t, vel * 0.35, pan);
}

function taiko(bus, s, t, vel = 1, pan = 0, pitch = 1) {
  const sr = s.sr, n = s.n(0.9);
  const v = sweepSine(n, sr, 135 * pitch, 56 * pitch, 0.035);
  envAD(v, sr, 0.001, 0.22);
  const nz = pink(n, s.r); envAD(nz, sr, 0.0005, 0.06); svf(nz, sr, 'lp', 700, 0.7); mix(v, unit(nz), 0.5);
  const sl = white(s.n(0.03), s.r); envAD(sl, sr, 0.0002, 0.006); svf(sl, sr, 'bp', 1100, 0.8); mix(v, unit(sl), 0.25);
  softclip(unit(v), 1.6);
  bus.add(v, t, vel * 0.9, pan);
}
function timpani(bus, s, t, f, vel = 0.8, pan = 0) {
  const sr = s.sr, n = s.n(2.2);
  const v = new Float32Array(n);
  modal(v, sr, 0, [[f, 1, 0.7], [f * 1.505, 0.55, 0.5], [f * 1.985, 0.35, 0.4], [f * 2.44, 0.2, 0.3], [f * 2.9, 0.1, 0.2]], 1, 0.002);
  const m = pink(s.n(0.1), s.r); envAD(m, sr, 0.0005, 0.015); svf(m, sr, 'lp', 1500, 0.7); mix(v, unit(m), 0.4);
  bus.add(unit(v), t, vel * 0.7, pan);
}
function crash(bus, s, t, vel = 0.7, swell = 0) {
  const sr = s.sr, n = s.n(4.2 + swell);
  for (const pan of [-0.5, 0.5]) {
    const v = white(n, s.r);
    const ns = s.n(swell);
    for (let i = 0; i < n; i++) {
      const tt = (i - ns) / sr;
      v[i] *= tt < 0 ? Math.pow(1 + tt / Math.max(0.01, swell), 3) * 0.6 : Math.exp(-tt / 0.9) * Math.min(1, tt / 0.002 + 0.2) * Math.min(1, (n - i) / (0.5 * sr));
    }
    svf(v, sr, 'hp', 3200, 0.7);
    const r = copy(v); svf(r, sr, 'bp', 5200, 4); mix(v, r, 0.6);
    svf(v, sr, 'lp', 12000, 0.7);
    bus.add(v, t - swell, vel * 0.18, pan);
  }
}
function boom(bus, s, t, vel = 1) {
  const sr = s.sr, n = s.n(1.4);
  const v = sweepSine(n, sr, 70, 28, 0.15);
  envAD(v, sr, 0.003, 0.35);
  const nz = brown(n, s); envAD(nz, sr, 0.002, 0.1); svf(nz, sr, 'lp', 250, 0.7); mix(v, unit(nz), 0.4);
  bus.add(unit(v), t, vel * 0.8, 0);
}
function brown(n, s) { const o = pink(n, s.r); svf(o, s.sr, 'lp', 300, 0.7); return o; }
function spiccato(bus, s, t, f, vel = 0.5, pan = 0, len = 0.12) {
  const sr = s.sr, n = s.n(len + 0.2);
  const v = new Float32Array(n);
  for (let k = 0; k < 3; k++) mix(v, osc(n, sr, f * Math.pow(2, s.rand(-10, 10) / 1200), 'saw', s.rand(0, TAU)), 0.33);
  svf(v, sr, 'lp', { f0: 2400, f1: 700, tau: 0.05 }, 0.9);
  const e = adsr(n, sr, 0.008, 0.06, 0.4, 0.08, len);
  for (let i = 0; i < n; i++) v[i] *= e[i];
  bus.add(v, t, vel * 0.5, pan);
}
function riser(bus, s, t, dur, vel = 0.4) {
  const sr = s.sr, n = s.n(dur);
  for (const pan of [-0.6, 0.6]) {
    const v = pink(n, s.r);
    for (let i = 0; i < n; i++) v[i] *= Math.pow(i / n, 2.2);
    svf(v, sr, 'bp', (tt) => 300 * Math.pow(25, tt / dur), 1.4);
    bus.add(unit(v), t, vel * 0.25, pan);
  }
}

/** Glue: hall reverb, gentle bus compression, peak normalise. */
function master(bus, s, { wet = 0.32, t60 = 2.6 } = {}) {
  const sr = s.sr;
  const mono = new Float32Array(bus.L.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (bus.L[i] + bus.R[i]) * 0.5;
  const [rl, rr] = fdn(mono, sr, { t60, damp: 4500, size: 1.4, predelay: 0.025, len: mono.length / sr });
  const g = wet / Math.max(1e-9, peak(rl) + peak(rr)) * 2 * 0.5;
  for (let i = 0; i < mono.length; i++) { bus.L[i] += rl[i] * g; bus.R[i] += rr[i] * g; }
  for (const c of [bus.L, bus.R]) { dcblock(c, sr, 25); biquad(c, sr, 'highshelf', 6000, 0.7, -5); }
  // linked stereo compression
  const lk = new Float32Array(mono.length);
  for (let i = 0; i < lk.length; i++) lk[i] = Math.max(Math.abs(bus.L[i]), Math.abs(bus.R[i]));
  const p = peak(lk) || 1;
  for (const c of [bus.L, bus.R]) { scale(c, 1 / p); compress(c, sr, -10, 2, 0.015, 0.3, 0.003); }
  for (const c of [bus.L, bus.R]) fadeOut(c, sr, 1.0);
  return [bus.L, bus.R];
}

// ---- stingers --------------------------------------------------------------------------------
export function stingerCT(s) {
  const b = new Bus(s, 6.9);
  // impact
  boom(b, s, 0, 1); taiko(b, s, 0, 1, -0.3); taiko(b, s, 0.004, 0.9, 0.3, 0.9); timpani(b, s, 0, hz('D2'), 0.9); crash(b, s, 0, 0.8);
  // D - C - G/B - D  (I - bVII - IV - I), heroic horns
  const chords = [
    [0.0, 1.3, ['D3', 'A3', 'D4', 'F#4']], [1.35, 0.58, ['C3', 'G3', 'C4', 'E4']], [1.95, 0.58, ['B2', 'G3', 'D4', 'G4']], [2.55, 2.1, ['D3', 'A3', 'D4', 'F#4', 'A4']],
  ];
  for (const [t, d, notes] of chords) notes.forEach((nn, i) => brass(b, s, t, d, hz(nn), t > 2 ? 0.95 : 0.8, (i - 2) * 0.25, 1, t > 2 ? 0.55 : 0));
  // melody (trumpet line, brighter)
  for (const [t, d, nn] of [[0.0, 0.42, 'A4'], [0.45, 0.85, 'D5'], [1.35, 0.55, 'E5'], [1.95, 0.55, 'D5'], [2.55, 2.0, 'F#5']]) brass(b, s, t, d, hz(nn), 0.9, 0.1, 1.15, t > 2 ? 0.5 : 0);
  // strings & choir bed
  for (const nn of ['D2', 'A2', 'D3']) strings(b, s, 0, 2.5, hz(nn), 0.5, nn === 'A2' ? -0.4 : 0.4, 0.15);
  for (const nn of ['D3', 'F#3', 'A3', 'D4']) strings(b, s, 2.5, 2.2, hz(nn), 0.6, 0, 0.25, 0.5);
  for (const nn of ['F#4', 'A4', 'D5']) choir(b, s, 2.45, 2.1, hz(nn), 0.55, nn === 'A4' ? 0 : nn === 'D5' ? 0.35 : -0.35, 0.5);
  // driving low ostinato
  for (let k = 0; k < 8; k++) spiccato(b, s, k * 0.165, hz(k < 7 ? 'D2' : 'C2'), 0.6, -0.2);
  for (let k = 0; k < 4; k++) spiccato(b, s, 1.35 + k * 0.15, hz(k < 2 ? 'C2' : 'B1'), 0.6, -0.2);
  // fill into the final chord
  [2.2, 2.32, 2.42, 2.5].forEach((t, i) => taiko(b, s, t, 0.5 + i * 0.12, i & 1 ? 0.35 : -0.35, 1.1));
  taiko(b, s, 2.55, 1, 0); timpani(b, s, 2.55, hz('D2'), 1); crash(b, s, 2.55, 0.9, 0.35); boom(b, s, 2.55, 0.8);
  return master(b, s);
}

export function stingerT(s) {
  const b = new Bus(s, 6.6);
  // war drums: DUM . da-DUM . DUM . da-DUM
  const hits = [[0, 1], [0.3, 0.6], [0.42, 0.9], [0.78, 1], [1.08, 0.6], [1.2, 0.95], [1.56, 0.7], [1.66, 0.8], [1.76, 1]];
  hits.forEach(([t, v], i) => taiko(b, s, t, v, i & 1 ? 0.4 : -0.4, i % 3 === 0 ? 0.85 : 1));
  boom(b, s, 0, 1); crash(b, s, 0, 0.5);
  // low brass: E5 power -> F (phrygian bII) -> E major (phrygian dominant)
  for (const nn of ['E2', 'B2', 'E3']) brass(b, s, 0.0, 1.15, hz(nn), 0.85, nn === 'B2' ? -0.3 : 0.2, 0.75);
  for (const nn of ['F2', 'C3', 'F3']) brass(b, s, 1.2, 0.55, hz(nn), 0.9, nn === 'C3' ? -0.3 : 0.2, 0.8);
  for (const nn of ['E2', 'B2', 'E3', 'G#3', 'B3']) brass(b, s, 1.8, 2.6, hz(nn), 0.95, 0, 0.95, 0.6);
  // ornamented horn line (phrygian dominant run)
  const mel = [[0.3, 0.2, 'E4'], [0.5, 0.2, 'F4'], [0.7, 0.35, 'G#4'], [1.08, 0.12, 'A4'], [1.2, 0.3, 'G#4'], [1.5, 0.28, 'F4'], [1.8, 2.4, 'E4']];
  for (const [t, d, nn] of mel) brass(b, s, t, d, hz(nn), 0.85, 0.15, 1.05, d > 1 ? 0.55 : 0);
  // tremolo strings + choir on the resolution
  for (const nn of ['E3', 'B3', 'E4', 'G#4']) {
    for (let k = 0; k < 18; k++) spiccato(b, s, 1.8 + k * 0.07, hz(nn), 0.22 * (1 + k / 18), nn === 'E3' ? -0.5 : 0.4, 0.06);
    strings(b, s, 1.8, 2.5, hz(nn), 0.45, nn === 'E4' ? 0.4 : -0.3, 0.6, 0.5);
  }
  for (const nn of ['E4', 'G#4', 'B4']) choir(b, s, 1.75, 2.4, hz(nn), 0.5, nn === 'G#4' ? 0 : nn === 'B4' ? 0.4 : -0.4, 0.5);
  timpani(b, s, 1.8, hz('E2'), 1); crash(b, s, 1.8, 0.8, 0.4); boom(b, s, 1.8, 0.9);
  return master(b, s);
}

export function stingerMVP(s) {
  const b = new Bus(s, 9.4);
  const B = 0.6; // 100 bpm
  const t0 = 0.5;
  riser(b, s, 0, t0 + 0.05, 0.6);
  crash(b, s, t0, 0.5, 0.45);
  // Dm - Bb - F - C | F   (vi - IV - I - V - I in F)
  const prog = [['D2', ['D3', 'A3', 'D4', 'F4']], ['Bb1', ['Bb2', 'F3', 'Bb3', 'D4']], ['F2', ['F3', 'A3', 'C4', 'F4']], ['C2', ['C3', 'G3', 'C4', 'E4']]];
  prog.forEach(([root, notes], k) => {
    const t = t0 + k * 2 * B;
    notes.forEach((nn, i) => strings(b, s, t, 2 * B, hz(nn), 0.55, (i - 1.5) * 0.3, 0.12));
    notes.slice(1).forEach((nn, i) => brass(b, s, t, 2 * B - 0.05, hz(nn), 0.6, (i - 1) * 0.4, 0.8));
    for (let e = 0; e < 4; e++) spiccato(b, s, t + e * B / 2, hz(root) * 2, 0.55, -0.3);
    taiko(b, s, t, 0.9, -0.2); taiko(b, s, t + B, 0.55, 0.3, 1.15);
    timpani(b, s, t, hz(root) * (hz(root) < 60 ? 2 : 1), 0.6);
  });
  // theme
  const mel = [[0, 1, 'A4'], [1, 1, 'D5'], [2, 1.5, 'F5'], [3.5, 0.5, 'D5'], [4, 1, 'C5'], [5, 1, 'A4'], [6, 1, 'G4'], [7, 1, 'C5']];
  for (const [bt, d, nn] of mel) brass(b, s, t0 + bt * B, d * B - 0.03, hz(nn), 0.9, 0.05, 1.15);
  // arrival: F major
  const tf = t0 + 8 * B;
  for (const nn of ['F2', 'C3', 'F3', 'A3', 'C4', 'F4']) brass(b, s, tf, 2.2, hz(nn), 0.95, 0, 1, 0.55);
  brass(b, s, tf, 2.2, hz('F5'), 0.95, 0.1, 1.15, 0.5);
  for (const nn of ['A4', 'C5', 'F5']) choir(b, s, tf - 0.05, 2.2, hz(nn), 0.55, nn === 'C5' ? 0 : nn === 'F5' ? 0.4 : -0.4, 0.5);
  for (const nn of ['F2', 'C3', 'F3', 'A3']) strings(b, s, tf, 2.2, hz(nn), 0.6, 0, 0.1, 0.5);
  [-0.36, -0.24, -0.12].forEach((d, i) => taiko(b, s, tf + d, 0.6 + 0.1 * i, i & 1 ? 0.3 : -0.3, 1.1));
  taiko(b, s, tf, 1, 0); timpani(b, s, tf, hz('F2'), 1); crash(b, s, tf, 0.9, 0.3); boom(b, s, tf, 0.8);
  return master(b, s);
}

export function stingerBomb10(s) {
  // ten seconds of rising dread: pulsing bass, heartbeat, clock ticks, dissonant string swell
  const b = new Bus(s, 10.2);
  const sr = s.sr;
  const e8 = 0.2;
  for (let k = 0; k < 50; k++) {
    const t = k * e8, u = t / 10;
    const n = s.n(0.19), v = osc(n, sr, hz(k % 8 === 7 ? 'Eb1' : 'D1') * 2, 'saw');
    mix(v, osc(n, sr, hz('D1') * 2 * 1.004, 'saw'), 0.8);
    svf(v, sr, 'lp', { f0: 350 + 2200 * u, f1: 150 + 500 * u, tau: 0.06 }, 1.4);
    envAD(v, sr, 0.004, 0.09);
    b.add(v, t, 0.35 + 0.25 * u, 0);
    // clock tick
    const tk = new Float32Array(s.n(0.05));
    clack(tk, s, 0, { amp: 0.25 + 0.3 * u, f: k & 1 ? 4200 : 3600, ring: 0.004, body: 0.05 });
    b.add(tk, t, 0.5, k & 1 ? 0.5 : -0.5);
    if (k % 2 === 0) { // heartbeat kick on the beat
      const kn = s.n(0.3), kk = sweepSine(kn, sr, 90, 42, 0.03); envAD(kk, sr, 0.002, 0.09);
      b.add(kk, t, 0.55 + 0.3 * u, 0);
    }
  }
  for (const [nn, pan] of [['D3', -0.5], ['Eb3', 0.5], ['A3', -0.2], ['D4', 0.3], ['Eb4', 0]]) strings(b, s, 1.5, 8.5, hz(nn), 0.5, pan, 6.5);
  riser(b, s, 3, 7.0, 0.8);
  const out = master(b, s, { wet: 0.25, t60: 1.8 });
  return out;
}

// ---- radio / UI ------------------------------------------------------------------------------
function radioEQ(x, sr) { svf(x, sr, 'hp', 350, 0.7); svf(x, sr, 'lp', 3400, 0.7); svf(x, sr, 'peak', 1800, 1); softclip(x, 2.5); return x; }
export function radioGo(s) {
  const sr = s.sr, n = s.n(1.0);
  const o = new Float32Array(n);
  tock(o, s, 0, { amp: 0.5, f: 1200, dec: 0.006 }); // PTT click
  // static burst with crackle gating
  const st = white(n, s.r), g = wander(n, sr, 60, s.r);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = t < 0.28 ? Math.min(1, t / 0.01) : t < 0.62 ? 0.18 : t < 0.8 ? 0.9 * Math.exp(-(t - 0.62) / 0.06) : 0;
    st[i] *= env * (0.6 + 0.4 * Math.abs(g[i]));
  }
  mix(o, st, 0.5);
  // three rising radio blips over a quiet carrier
  for (const [t, f] of [[0.3, 1047], [0.42, 1319], [0.54, 1568]]) {
    const b = new Float32Array(s.n(0.1));
    beep(b, s, 0, 0.075, { amp: 1, f, harm: 0.6, buzz: 0.2 });
    mix(o, b, 0.55, s.n(t));
  }
  radioEQ(o, sr);
  tock(o, s, 0.8, { amp: 0.4, f: 1000, dec: 0.006 });
  dcblock(o, sr, 60); fadeOut(o, sr, 0.02);
  return [unit(o)];
}
export function uiClick(s, soft = false) {
  const o = new Float32Array(s.n(0.06));
  burst(o, s, 0, { dur: 0.0015, amp: 1, bp: soft ? 5200 : 3200, q: 1.2, decay: 0.0005 });
  if (!soft) tock(o, s, 0, { amp: 0.4, f: 900, dec: 0.004 });
  dcblock(o, s.sr, 100); fadeOut(o, s.sr, 0.01);
  return [unit(o)];
}
export function uiBuy(s) {
  const o = new Float32Array(s.n(0.55));
  clack(o, s, 0, { amp: 0.6, f: 2400, ring: 0.015, body: 0.6 });
  rattle(o, s, 0.02, 0.15, { amp: 0.2, count: 6, f: 3200 });
  clack(o, s, 0.12, { amp: 0.45, f: 2800, ring: 0.012, body: 0.4 });
  for (const [t, f] of [[0.03, 1760], [0.11, 2637]]) modal(o, s.sr, s.n(t), [[f, 0.12, 0.12], [f * 2.01, 0.04, 0.06]], 1);
  dcblock(o, s.sr, 60); fadeOut(o, s.sr, 0.02);
  return [unit(o)];
}
export function uiDeny(s) {
  const sr = s.sr, o = new Float32Array(s.n(0.35));
  for (const t of [0, 0.13]) {
    const n = s.n(0.1), v = osc(n, sr, 185, 'square'); mix(v, osc(n, sr, 188, 'saw'), 0.5);
    svf(v, sr, 'lp', 1400, 0.8); envAD(v, sr, 0.003, 0.06);
    mix(o, v, 0.5, s.n(t));
  }
  dcblock(o, sr, 60); fadeOut(o, sr, 0.02);
  return [unit(o)];
}

/** Teammate radio message: PTT click, a breath of static, short chirp, release click. */
export function radioChirp(s) {
  const sr = s.sr, n = s.n(0.42);
  const o = new Float32Array(n);
  tock(o, s, 0, { amp: 0.5, f: 1200, dec: 0.006 });
  const st = white(n, s.r);
  for (let i = 0; i < n; i++) { const t = i / sr; st[i] *= t < 0.3 ? 0.25 * Math.min(1, t / 0.01) : 0; }
  mix(o, st, 1);
  const b = new Float32Array(s.n(0.08));
  beep(b, s, 0, 0.05, { amp: 1, f: s.pick([1319, 1480, 1175]), harm: 0.5, buzz: 0.2 });
  mix(o, b, 0.5, s.n(0.03));
  tock(o, s, 0.31, { amp: 0.45, f: 1000, dec: 0.005 });
  radioEQ(o, sr);
  dcblock(o, sr, 60); fadeOut(o, sr, 0.02);
  return [unit(o)];
}
