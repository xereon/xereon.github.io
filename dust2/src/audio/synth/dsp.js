// Sample-level DSP primitives for offline synthesis. Pure JS on Float32Arrays: no DOM, no
// three, no WebAudio — runs identically in a Worker, on the main thread and in Node tests.
// Every generator is deterministic for a given (seed, sampleRate).

export const TAU = Math.PI * 2;
export const dB = (db) => Math.pow(10, db / 20);
export const toDb = (g) => 20 * Math.log10(Math.max(1e-12, g));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** mulberry32 */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Per-render synthesis context: sample rate + seeded randomness helpers. */
export class S {
  constructor(sr, seed) { this.sr = sr; this.r = rng(seed); }
  rand(a = 0, b = 1) { return a + (b - a) * this.r(); }
  /** v scaled by a random factor in [1-amt, 1+amt] */
  jit(v, amt) { return v * (1 + (this.r() * 2 - 1) * amt); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length) % arr.length]; }
  n(sec) { return Math.max(1, Math.round(sec * this.sr)); }
  buf(sec) { return new Float32Array(this.n(sec)); }
  gauss() { let u = 0; for (let i = 0; i < 4; i++) u += this.r(); return (u - 2) * 1.732; }
}

// ---- noise ---------------------------------------------------------------------------------
// Noise uses an inlined xorshift32 seeded from the caller's PRNG (5x faster than a closure call).
const seedOf = (r) => ((r() * 4294967296) >>> 0) || 0x9e3779b9;
export function white(n, r) {
  const o = new Float32Array(n);
  let st = seedOf(r);
  for (let i = 0; i < n; i++) { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; o[i] = (st >>> 0) * 4.656612873e-10 - 1; }
  return o;
}
/** Paul Kellet's refined pink filter, ~unit RMS-matched to white*0.5. */
export function pink(n, r) {
  const o = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let st = seedOf(r);
  for (let i = 0; i < n; i++) {
    st ^= st << 13; st ^= st >>> 17; st ^= st << 5;
    const w = (st >>> 0) * 4.656612873e-10 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
    b6 = w * 0.115926;
  }
  return o;
}
export function brown(n, r) {
  const o = new Float32Array(n);
  let y = 0, st = seedOf(r);
  for (let i = 0; i < n; i++) { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; y = (y + 0.02 * ((st >>> 0) * 4.656612873e-10 - 1)) * 0.998; o[i] = y * 3.5; }
  return o;
}
/** Smooth random control signal in [-1,1] with ~`rate` Hz of wander (cosine-interpolated). */
export function wander(n, sr, rate, r) {
  const o = new Float32Array(n);
  const step = Math.max(2, Math.round(sr / Math.max(0.01, rate)));
  let a = r() * 2 - 1, b = r() * 2 - 1;
  for (let i = 0, k = 0; i < n; i++, k++) {
    if (k >= step) { k = 0; a = b; b = r() * 2 - 1; }
    const t = k / step, m = (1 - Math.cos(Math.PI * t)) * 0.5;
    o[i] = a + (b - a) * m;
  }
  return o;
}

// ---- filters -------------------------------------------------------------------------------
// tiny DC bias keeps IIR states out of the (very slow) denormal range when input goes silent
const DN = 1e-20;

// output = m0*v0 + m1*v1 + m2*v2 (v0 input, v1 band, v2 low); m1 is scaled by k at runtime
const MIXES = { lp: [0, 0, 1], bp: [0, 1, 0], hp: [1, -1, -1], notch: [1, -1, 0], peak: [-1, 1, 2], ap: [1, -2, 0] };

/**
 * Zavalishin/Cytomic TPT state-variable filter, stable under fast modulation.
 * fc: Hz number | Float32Array per-sample | {f0, f1, tau} exponential glide | (t)=>Hz.
 * 'bp' is normalised to unity gain at the centre. Processes in place unless `out` given.
 */
export function svf(x, sr, mode, fc, q = 0.7071, out = x) {
  const mm = MIXES[mode] || MIXES.lp;
  const k = 1 / q;
  const m0 = mm[0], m1 = mm[1] * k, m2 = mm[2];
  const n = x.length;
  const nyq = sr * 0.49, piSr = Math.PI / sr;
  let ic1 = 0, ic2 = 0;
  const kind = typeof fc === 'number' ? 0 : fc instanceof Float32Array ? 1 : typeof fc === 'function' ? 3 : 2;
  let gf = 0, gdec = 1, f1 = 0;
  if (kind === 2) { f1 = fc.f1; gf = fc.f0 - fc.f1; gdec = Math.exp(-16 / (Math.max(1e-5, fc.tau) * sr)); }
  const B = kind === 1 ? 1 : 16;
  for (let i0 = 0; i0 < n; i0 += B) {
    let f;
    if (kind === 0) f = fc; else if (kind === 1) f = fc[i0]; else if (kind === 2) { f = f1 + gf; gf *= gdec; } else f = fc(i0 / sr);
    f = f < 5 ? 5 : f > nyq ? nyq : f;
    const g = Math.tan(piSr * f);
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const end = i0 + B < n ? i0 + B : n;
    for (let i = i0; i < end; i++) {
      const v0 = x[i] + DN;
      const v3 = v0 - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      out[i] = m0 * v0 + m1 * v1 + m2 * v2;
    }
  }
  return out;
}

/** RBJ cookbook biquad (static), TDF-II. type: lp hp bp notch peak lowshelf highshelf */
export function biquad(x, sr, type, f, q = 0.7071, gainDb = 0, out = x) {
  const w0 = TAU * clamp(f, 5, sr * 0.49) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    default: return out === x ? x : (out.set(x), out);
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let z1 = 0, z2 = 0;
  for (let i = 0, n = x.length; i < n; i++) {
    const v = x[i] + DN;
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    out[i] = y;
  }
  return out;
}

/** One-pole lowpass (or highpass) in place. */
export function onepole(x, sr, fc, hp = false) {
  const a = Math.exp(-TAU * fc / sr);
  let y = 0;
  for (let i = 0, n = x.length; i < n; i++) {
    y = (1 - a) * (x[i] + DN) + a * y;
    x[i] = hp ? x[i] - y : y;
  }
  return x;
}

export function dcblock(x, sr, fc = 20) {
  const R = Math.exp(-TAU * fc / sr);
  let xm = 0, ym = 0;
  for (let i = 0, n = x.length; i < n; i++) { const v = x[i] + DN; const y = v - xm + R * ym; xm = v; ym = y; x[i] = y; }
  return x;
}

/** Two-pole resonator bank on an excitation; adds into `out`. modes = [[f, gain, tau], ...] */
export function resonate(x, sr, modes, out, from = 0) {
  const n = out.length;
  for (const [f, g, tau] of modes) {
    if (f >= sr * 0.48) continue;
    const r = Math.exp(-1 / (Math.max(1e-4, tau) * sr));
    const c = 2 * r * Math.cos(TAU * f / sr), r2 = r * r;
    const b0 = (1 - r2) * 0.5 * g * 4;
    let y1 = 0, y2 = 0;
    const xl = x.length;
    for (let i = from; i < n; i++) {
      const xi = i - from < xl ? x[i - from] : 0;
      const y = b0 * xi + c * y1 - r2 * y2 + DN;
      y2 = y1; y1 = y;
      out[i] += y;
      if (i - from > xl && Math.abs(y) < 1e-7 && Math.abs(y2) < 1e-7) break;
    }
  }
  return out;
}

/** Damped-sine modal hit added into `out` at sample `at`. modes = [[f, amp, tau, phase?], ...] */
export function modal(out, sr, at, modes, amp = 1, attack = 0.0002) {
  const n = out.length;
  const na = Math.max(1, Math.round(attack * sr));
  for (const md of modes) {
    const f = md[0];
    if (f >= sr * 0.48) continue;
    const a = md[1] * amp, tau = md[2];
    const r = Math.exp(-1 / (tau * sr));
    const w = TAU * f / sr, cw = Math.cos(w), sw = Math.sin(w);
    let re = Math.cos(md[3] || 0), im = Math.sin(md[3] || 0), env = a;
    const end = Math.min(n, at + Math.ceil(tau * sr * 9));
    for (let i = Math.max(0, at), k = 0; i < end; i++, k++) {
      const atk = k < na ? k / na : 1;
      out[i] += im * env * atk;
      const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
      env *= r;
    }
  }
  return out;
}

// ---- envelopes / oscillators -----------------------------------------------------------------
/** Multiply x (from sample `at`) by attack/decay envelope: (1-e^{-t/a}) e^{-t/d}, zero before. */
export function envAD(x, sr, a, d, at = 0, hold = 0) {
  const n = x.length;
  const ka = a > 0 ? Math.exp(-1 / (a * sr)) : 0, kd = Math.exp(-1 / (d * sr));
  const nh = Math.round(hold * sr);
  let ea = 1, ed = 1;
  for (let i = 0; i < n; i++) {
    if (i < at) { x[i] = 0; continue; }
    const k = i - at;
    const e = (1 - ea) * ed;
    ea *= ka; if (k >= nh) { ed *= kd; if (ed < 1e-12) ed = 0; }
    x[i] *= a > 0 ? e : ed;
  }
  return x;
}

/** Piecewise envelope from [[t, v], ...] (linear segments; 'exp' curve = eased). */
export function envPts(n, sr, pts, curve = 1) {
  const o = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    while (j < pts.length - 2 && t >= pts[j + 1][0]) j++;
    const [t0, v0] = pts[j], [t1, v1] = pts[Math.min(j + 1, pts.length - 1)];
    let u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 1;
    if (curve !== 1) u = Math.pow(u, curve);
    o[i] = t < pts[0][0] ? pts[0][1] : t > pts[pts.length - 1][0] ? pts[pts.length - 1][1] : v0 + (v1 - v0) * u;
  }
  return o;
}

export function mulInto(x, env) { for (let i = 0, n = Math.min(x.length, env.length); i < n; i++) x[i] *= env[i]; return x; }

/** Sine whose frequency glides f0 -> f1 with time constant tau. */
export function sweepSine(n, sr, f0, f1, tau, phase = 0) {
  const o = new Float32Array(n);
  let ph = phase, f = f0 - f1;
  const dec = Math.exp(-1 / (Math.max(1e-5, tau) * sr));
  for (let i = 0; i < n; i++) { o[i] = Math.sin(ph); ph += TAU * (f1 + f) / sr; f *= dec; }
  return o;
}

/** Oscillator with arbitrary per-sample frequency array / function. shape: sine saw square tri */
export function osc(n, sr, freq, shape = 'sine', phase = 0) {
  const o = new Float32Array(n);
  let p = phase / TAU; p -= Math.floor(p);
  const isArr = freq instanceof Float32Array, isFn = typeof freq === 'function';
  for (let i = 0; i < n; i++) {
    const f = isArr ? freq[i] : isFn ? freq(i / sr) : freq;
    const dt = f / sr;
    let y;
    if (shape === 'sine') y = Math.sin(TAU * p);
    else if (shape === 'saw') y = 2 * p - 1 - polyblep(p, dt);
    else if (shape === 'square') y = (p < 0.5 ? 1 : -1) + polyblep(p, dt) - polyblep((p + 0.5) % 1, dt);
    else y = 1 - 4 * Math.abs(p - 0.5);
    o[i] = y;
    p += dt; if (p >= 1) p -= 1;
  }
  return o;
}
function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// ---- dynamics / shaping ----------------------------------------------------------------------
export function softclip(x, drive = 1, asym = 0) {
  const norm = Math.tanh(drive);
  for (let i = 0, n = x.length; i < n; i++) {
    const v = x[i] * drive;
    x[i] = Math.tanh(v + asym * v * v) / norm;
  }
  return x;
}

/** Simple feed-forward peak compressor/limiter with lookahead, in place. */
export function compress(x, sr, thrDb = -12, ratio = 4, att = 0.002, rel = 0.08, look = 0.0015) {
  const thr = dB(thrDb), n = x.length, L = Math.round(look * sr);
  const ka = Math.exp(-1 / (att * sr)), kr = Math.exp(-1 / (rel * sr));
  let env = 0;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[Math.min(n - 1, i + L)]);
    env = a > env ? ka * env + (1 - ka) * a : kr * env + (1 - kr) * a;
    g[i] = env > thr ? Math.pow(env / thr, 1 / ratio - 1) : 1;
  }
  for (let i = 0; i < n; i++) x[i] *= g[i];
  return x;
}

// ---- mixing ---------------------------------------------------------------------------------
export function mix(dst, src, gain = 1, at = 0) {
  const n = Math.min(src.length, dst.length - at);
  for (let i = Math.max(0, -at); i < n; i++) dst[i + at] += src[i] * gain;
  return dst;
}
export function scale(x, g) { for (let i = 0, n = x.length; i < n; i++) x[i] *= g; return x; }
export function peak(x) { let p = 0; for (let i = 0, n = x.length; i < n; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; }
export function rms(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }
export function fadeIn(x, sr, sec) { const n = Math.min(x.length, Math.round(sec * sr)); for (let i = 0; i < n; i++) x[i] *= i / n; return x; }
export function fadeOut(x, sr, sec) { const n = x.length, m = Math.min(n, Math.round(sec * sr)); for (let i = 0; i < m; i++) x[n - 1 - i] *= i / m; return x; }
export function copy(x) { return new Float32Array(x); }

/** Delay-and-add echo of `src` into `dst` with a lowpass on the repeat. */
export function echo(dst, src, sr, delay, gain, lp = 0) {
  const at = Math.round(delay * sr);
  if (at >= dst.length) return dst;
  const e = lp ? svf(copy(src), sr, 'lp', lp, 0.6) : src;
  return mix(dst, e, gain, at);
}

/** Trim trailing near-silence (keeps a short fade). Returns a subarray copy. */
export function trim(chs, sr, floorDb = -70) {
  const thr = dB(floorDb);
  let end = 0;
  for (const c of chs) for (let i = c.length - 1; i > end; i--) if (Math.abs(c[i]) > thr) { end = i; break; }
  end = Math.min(chs[0].length, end + Math.round(0.01 * sr));
  return chs.map((c) => { const o = c.slice(0, Math.max(16, end)); fadeOut(o, sr, Math.min(0.02, o.length / sr / 4)); return o; });
}

/** Peak-normalise a set of channels together to `target` (linear). */
export function normalize(chs, target = 0.89) {
  let p = 0;
  for (const c of chs) p = Math.max(p, peak(c));
  if (p > 1e-9) for (const c of chs) scale(c, target / p);
  return chs;
}

// ---- granular -------------------------------------------------------------------------------
/**
 * Scatter `count` micro-events between t0..t1 (density shaped by `dist(u)` in [0,1]).
 * `grain(out, at, amp, s)` renders one event.
 */
export function scatter(out, s, count, t0, t1, grain, ampFn = () => 1) {
  for (let i = 0; i < count; i++) {
    const u = s.r();
    const t = t0 + (t1 - t0) * u;
    grain(out, Math.round(t * s.sr), ampFn(u) * (0.3 + 0.7 * s.r()), s);
  }
  return out;
}

/** A single short filtered noise tick (grit/grain). */
export function tick(out, at, amp, s, dur = 0.0015, color = 1) {
  const n = Math.max(4, Math.round(dur * s.sr));
  let lp = 0;
  const k = Math.exp(-5 / n);
  let e = amp;
  for (let i = 0; i < n && at + i < out.length; i++) {
    const w = s.r() * 2 - 1;
    lp += (w - lp) * color;
    if (at + i >= 0) out[at + i] += lp * e;
    e *= k;
  }
}

// ---- reverb ---------------------------------------------------------------------------------
/**
 * 8-line feedback delay network (Householder mixing, per-line HF damping) -> [L, R].
 * Used for music and big explosions. size scales delay lengths (1 = ~30-80 ms lines).
 */
export function fdn(x, sr, { t60 = 1.5, damp = 3000, size = 1, predelay = 0.01, len = null, diffuse = true } = {}) {
  const N = 8;
  const base = [1433, 1601, 1867, 2053, 2251, 2399, 2617, 2903];
  const d = base.map((v) => Math.max(8, Math.round(v * size * sr / 48000)));
  const total = len ? Math.round(len * sr) : x.length + Math.round((t60 + predelay) * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  const lines = d.map((m) => new Float32Array(m));
  const idx = new Int32Array(N);
  const g = d.map((m) => Math.pow(10, -3 * m / (sr * t60)));
  const lpA = Math.exp(-TAU * damp / sr);
  const lpS = new Float64Array(N);
  const pd = Math.round(predelay * sr);
  // input diffusion allpasses
  const apD = [142, 107, 379, 277].map((v) => Math.max(2, Math.round(v * sr / 48000)));
  const apB = apD.map((m) => new Float32Array(m)); const apI = new Int32Array(4);
  const vals = new Float64Array(N);
  for (let i = 0; i < total; i++) {
    let inp = i - pd >= 0 && i - pd < x.length ? x[i - pd] : 0;
    if (diffuse) for (let a = 0; a < 4; a++) {
      const b = apB[a], j = apI[a];
      const bv = b[j]; const y = -0.6 * inp + bv; b[j] = inp + 0.6 * y; apI[a] = (j + 1) % b.length; inp = y;
    }
    let sum = 0;
    for (let k = 0; k < N; k++) {
      let v = lines[k][idx[k]];
      lpS[k] = (1 - lpA) * v + lpA * lpS[k];
      v = lpS[k] * g[k];
      vals[k] = v; sum += v;
    }
    const h = (2 / N) * sum;
    L[i] = vals[0] - vals[2] + vals[4] - vals[6] + 0.5 * (vals[1] - vals[5]);
    R[i] = vals[1] - vals[3] + vals[5] - vals[7] + 0.5 * (vals[2] - vals[6]);
    for (let k = 0; k < N; k++) {
      lines[k][idx[k]] = vals[k] - h + inp * (k & 1 ? 0.35 : -0.35);
      idx[k] = (idx[k] + 1) % d[k];
    }
  }
  return [L, R];
}

/**
 * Procedural impulse response: band-split exponentially decaying noise + early reflections.
 * opts: { len, t60Lo, t60Hi, xover, predelay, early: [[t, gain, lp], ...], comb: {delay, fb}, width }
 */
export function impulse(sr, seed, o) {
  const s = new S(sr, seed);
  const n = s.n(o.len);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const w = white(n, s.r);
    const lo = onepole(copy(w), sr, o.xover ?? 1500);
    const hi = new Float32Array(n);
    for (let i = 0; i < n; i++) hi[i] = w[i] - lo[i];
    const kL = Math.exp(-6.91 / (o.t60Lo * sr)), kH = Math.exp(-6.91 / (o.t60Hi * sr));
    const pd = Math.round((o.predelay ?? 0) * sr);
    const fin = Math.round((o.fadeIn ?? 0.004) * sr);
    const y = new Float32Array(n);
    let eL = 1, eH = 1;
    for (let i = 0; i < n; i++) {
      if (i < pd) { y[i] = 0; continue; }
      const k = i - pd;
      const f = k < fin ? k / fin : 1;
      y[i] = (lo[i] * eL + hi[i] * eH * (o.hiGain ?? 0.8)) * f * (o.diffuse ?? 1);
      eL *= kL; eH *= kH;
    }
    if (o.comb) {
      const D = Math.round(o.comb.delay * sr * (ch ? 1.07 : 1));
      for (let i = D; i < n; i++) y[i] += y[i - D] * o.comb.fb;
    }
    for (const [t, gain, lp] of o.early || []) {
      const at = Math.round(t * sr * (ch ? s.rand(0.93, 1.07) : 1));
      const len = Math.round(0.0015 * sr);
      const tap = new Float32Array(len);
      for (let i = 0; i < len; i++) tap[i] = (s.r() * 2 - 1) * Math.exp(-i / (len * 0.3));
      if (lp) svf(tap, sr, 'lp', lp, 0.7);
      mix(y, tap, gain * (ch ? s.rand(0.7, 1) : s.rand(0.8, 1)), at);
    }
    if (o.lp) svf(y, sr, 'lp', o.lp, 0.7);
    if (o.hp) svf(y, sr, 'hp', o.hp, 0.7);
    out.push(y);
  }
  // equal-energy normalise so every environment has the same send loudness
  let e = 0; for (const c of out) for (let i = 0; i < c.length; i++) e += c[i] * c[i];
  const g = 1 / Math.sqrt(Math.max(1e-12, e / 2));
  for (const c of out) scale(c, g * 0.5);
  return out;
}
