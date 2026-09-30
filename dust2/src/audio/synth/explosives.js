// Grenades, explosions, fire and the C4.
import { white, pink, brown, svf, mix, modal, softclip, dcblock, fadeOut, fadeIn, envAD, TAU, tick, scatter, sweepSine, wander, scale, peak, copy, compress } from './dsp.js';
import { clack, scrape, cloth, rattle, whoosh, burst, tock, thud, beep } from './mech.js';

const unit = (x) => { const p = peak(x); return p > 1e-9 ? scale(x, 1 / p) : x; };
const fin = (o, s, hp = 25, fo = 0.05) => { dcblock(o, s.sr, hp); fadeOut(o, s.sr, fo); return [o]; };

/** Make a seamless loop from a stationary signal: crossfade the last `xf` seconds over the head. */
export function loopify(x, sr, xf) {
  const X = Math.round(xf * sr), n = x.length - X;
  const o = x.slice(0, n);
  for (let i = 0; i < X; i++) {
    const u = i / X;
    o[i] = x[i] * Math.sin(u * Math.PI / 2) + x[n + i] * Math.cos(u * Math.PI / 2);
  }
  return o;
}

/**
 * Explosion: crack + Friedlander blast + sub drop + body + debris rain + rolling tail.
 * size 1 = HE grenade, 1.6 = C4. far = distant version.
 */
export function explosion(s, size = 1, far = false) {
  const sr = s.sr;
  const len = (far ? 3.8 : 3.2) * Math.sqrt(size);
  const n = s.n(len);
  const dry = new Float32Array(n);
  // crack
  if (!far) {
    const c = white(s.n(0.02), s.r); envAD(c, sr, 0.00005, 0.004); svf(c, sr, 'hp', 1000, 0.6);
    mix(dry, unit(c), 1.0);
  }
  // blast pulse
  {
    const T = 0.009 * size;
    const b = new Float32Array(s.n(T * 8));
    for (let i = 0; i < b.length; i++) { const u = i / sr / T; b[i] = (1 - u) * Math.exp(-1.6 * u); }
    svf(b, sr, 'lp', 1400, 0.7);
    mix(dry, unit(b), 0.9);
  }
  // sub drop
  {
    const t = sweepSine(s.n(0.9 * size), sr, 95, 26 / Math.sqrt(size), 0.08, 0);
    envAD(t, sr, 0.002, 0.14 * size);
    mix(dry, unit(t), 0.5);
  }
  // body
  {
    const b = white(s.n(0.8 * size), s.r); mix(b, pink(b.length, s.r), 1.5);
    envAD(b, sr, 0.0008, 0.1 * size);
    svf(b, sr, 'lp', { f0: 9000, f1: 700, tau: 0.08 * size }, 0.7);
    svf(b, sr, 'hp', 90, 0.7);
    mix(dry, unit(b), 1.0);
    // crunch: mid-band grit of the casing fragmenting
    const cr = white(s.n(0.3 * size), s.r); envAD(cr, sr, 0.0005, 0.035 * size); svf(cr, sr, 'bp', 1800, 0.8);
    mix(dry, unit(cr), 0.45);
  }
  compress(unit(dry), sr, -16, 4, 0.0005, 0.12, 0.001);
  unit(dry);
  softclip(dry, 2.6, 0.1);
  if (far) { svf(dry, sr, 'lp', 1300, 0.6); svf(dry, sr, 'lp', 1700, 0.6); svf(dry, sr, 'hp', 45, 0.7); unit(dry); }
  const out = copy(dry);

  // debris rain: stones, grit, sand
  if (!far) {
    scatter(out, s, Math.round(260 * size), 0.08, 2.2 * size, (o, at, a, ss) => {
      if (ss.r() < 0.25) modal(o, sr, at, [[ss.rand(1800, 5500), a * 0.5, ss.rand(0.004, 0.012)]], 1);
      tick(o, at, a, ss, ss.rand(0.0005, 0.002), ss.rand(0.3, 1));
    }, (u) => 0.16 * Math.pow(1 - u, 2.2) * (u < 0.05 ? u / 0.05 : 1));
    const h = pink(s.n(2.6 * size), s.r);
    envAD(h, sr, 0.08, 0.45 * size);
    fadeOut(h, sr, 0.8 * size);
    svf(h, sr, 'bp', 3000, 0.5);
    mix(out, unit(h), 0.12);
  }
  // slapback echoes off buildings
  const eSrc = svf(copy(dry), sr, 'lp', far ? 700 : 1500, 0.7);
  svf(eSrc, sr, 'hp', 60, 0.7);
  for (const [d, g] of [[0.11, 0.35], [0.26, 0.3], [0.45, 0.22], [0.7, 0.14], [1.0, 0.08]]) mix(out, eSrc, g * s.rand(0.7, 1.1), s.n(d * s.rand(0.85, 1.15) * Math.sqrt(size)));
  // rolling rumble
  {
    const T60 = (far ? 3.2 : 2.6) * Math.sqrt(size);
    const r = brown(n, s.r); mix(r, pink(n, s.r), 0.6);
    const roll = wander(n, sr, 3.5, s.r);
    const k = Math.exp(-6.91 / (T60 * sr)), ka = Math.exp(-1 / (0.05 * sr));
    let e = 1, ea = 1;
    for (let i = 0; i < n; i++) { r[i] *= (1 - ea) * e * (1 + 0.55 * roll[i]); e *= k; ea *= ka; }
    svf(r, sr, 'lp', { f0: far ? 900 : 2200, f1: 160, tau: T60 * 0.35 }, 0.6);
    svf(r, sr, 'hp', 35, 0.7);
    mix(out, unit(r), far ? 0.45 : 0.42);
  }
  return fin(out, s, 20, 0.4);
}

export function flashPop(s, far = false) {
  const sr = s.sr, n = s.n(far ? 2.2 : 1.8);
  const d = new Float32Array(n);
  if (!far) {
    const c = white(s.n(0.02), s.r); envAD(c, sr, 0.00003, 0.0018); svf(c, sr, 'hp', 1500, 0.6); mix(d, unit(c), 1);
  }
  const b = white(s.n(0.3), s.r); envAD(b, sr, 0.0003, 0.022); svf(b, sr, 'lp', { f0: 12000, f1: 2500, tau: 0.02 }, 0.7); svf(b, sr, 'hp', 300, 0.7); mix(d, unit(b), 0.9);
  const t = sweepSine(s.n(0.3), sr, 180, 70, 0.015); envAD(t, sr, 0.001, 0.025); mix(d, unit(t), 0.22);
  unit(d); softclip(d, 2.2);
  if (far) { svf(d, sr, 'lp', 1400, 0.6); unit(d); }
  const out = copy(d);
  const e = svf(copy(d), sr, 'lp', 2500, 0.7);
  for (const [dl, g] of [[0.03, 0.3], [0.09, 0.25], [0.2, 0.18], [0.38, 0.1]]) mix(out, e, g, s.n(dl * s.rand(0.85, 1.15)));
  const tl = pink(n, s.r); envAD(tl, sr, 0.01, far ? 0.4 : 0.28); svf(tl, sr, 'lp', { f0: 4000, f1: 600, tau: 0.3 }, 0.6); svf(tl, sr, 'hp', 120, 0.7);
  mix(out, unit(tl), far ? 0.45 : 0.3);
  // magnesium fizz
  if (!far) { const f = white(s.n(0.5), s.r); envAD(f, sr, 0.01, 0.12); svf(f, sr, 'hp', 6000, 0.7); mix(out, unit(f), 0.05); }
  return fin(out, s, 30, 0.2);
}

/** Flashbang ear ring (played 2D for the blinded player). */
export function tinnitus(s) {
  const sr = s.sr, n = s.n(5.0);
  const o = new Float32Array(n);
  const f = 3520;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.04) * (t < 1.2 ? 1 : Math.exp(-(t - 1.2) / 1.3));
    o[i] = env * (Math.sin(TAU * f * t) + 0.55 * Math.sin(TAU * (f + 6.5) * t + 1) + 0.12 * Math.sin(TAU * f * 2.003 * t) + 0.06 * Math.sin(TAU * 1210 * t));
  }
  const h = white(n, s.r); svf(h, sr, 'bp', 5000, 1.5);
  for (let i = 0; i < n; i++) { const t = i / sr; h[i] *= 0.05 * Math.exp(-t / 1.5); }
  mix(o, h, 1);
  return fin(o, s, 100, 0.3);
}

export function smokePop(s) {
  const sr = s.sr, n = s.n(3.2);
  const o = new Float32Array(n);
  clack(o, s, 0, { amp: 0.5, f: 1600, ring: 0.03, body: 1, bodyF: 300 });
  burst(o, s, 0.002, { dur: 0.03, amp: 0.8, bp: 900, q: 0.6, decay: 0.01 });
  // pressurised release: loud hiss that swells then settles
  const h = white(n, s.r); mix(h, pink(n, s.r), 1);
  const w = wander(n, sr, 9, s.r);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.06) * (0.55 + 0.45 * Math.exp(-t / 0.5)) * (t > 2.4 ? Math.max(0, 1 - (t - 2.4) / 0.8) : 1);
    h[i] *= env * (0.85 + 0.15 * w[i]);
  }
  svf(h, sr, 'bp', 2600, 0.45); svf(h, sr, 'hp', 500, 0.7);
  mix(o, unit(h), 0.8);
  return fin(o, s, 40, 0.3);
}
export function smokeLoop(s) {
  const sr = s.sr, L = 6, X = 1;
  const n = s.n(L + X);
  const h = white(n, s.r); mix(h, pink(n, s.r), 1.4);
  const w = wander(n, sr, 3, s.r), w2 = wander(n, sr, 14, s.r);
  for (let i = 0; i < n; i++) h[i] *= (0.8 + 0.12 * w[i] + 0.08 * w2[i]);
  svf(h, sr, 'bp', 2200, 0.5); svf(h, sr, 'hp', 400, 0.7);
  return [unit(loopify(h, sr, X))];
}

export function molotovBreak(s) {
  const sr = s.sr, o = new Float32Array(s.n(1.6));
  burst(o, s, 0, { dur: 0.003, amp: 1, hp: 2000, decay: 0.0008 });
  thud(o, s, 0, { amp: 0.4, f0: 300, f1: 140, dec: 0.012 });
  for (let i = 0; i < 45; i++) {
    const t = 0.001 + 0.45 * Math.pow(s.r(), 2);
    modal(o, sr, s.n(t), [[s.rand(2500, 9500), s.rand(0.05, 0.25) * (1 - t), s.rand(0.015, 0.06)], [s.rand(4000, 11000), 0.05, 0.02]], 1);
    tick(o, s.n(t), 0.1, s, 0.0008, 0.7);
  }
  // ignition whoosh
  const n = s.n(1.5), f = brown(n, s.r); mix(f, pink(n, s.r), 0.8);
  for (let i = 0; i < n; i++) { const t = i / sr; f[i] *= Math.pow(Math.min(1, t / 0.18), 2) * Math.exp(-Math.max(0, t - 0.2) / 0.5); }
  svf(f, sr, 'lp', { f0: 3000, f1: 600, tau: 0.4 }, 0.7);
  mix(o, unit(f), 0.75, s.n(0.05));
  return fin(o, s, 30, 0.2);
}
export function fireLoop(s) {
  const sr = s.sr, L = 6, X = 1;
  const n = s.n(L + X);
  const roar = brown(n, s.r); mix(roar, pink(n, s.r), 0.5);
  const w = wander(n, sr, 2.5, s.r), w2 = wander(n, sr, 11, s.r);
  for (let i = 0; i < n; i++) roar[i] *= (0.7 + 0.2 * w[i] + 0.1 * w2[i]);
  svf(roar, sr, 'lp', 700, 0.7); svf(roar, sr, 'hp', 50, 0.7);
  const o = unit(roar);
  scale(o, 0.6);
  // crackle
  scatter(o, s, 900, 0, L + X, (out, at, a, ss) => { tick(out, at, a, ss, ss.rand(0.0004, 0.0025), ss.rand(0.2, 0.9)); }, () => 0.35);
  scatter(o, s, 40, 0, L + X, (out, at, a, ss) => { burst(out, ss, at / sr, { dur: 0.004, amp: a, bp: ss.rand(800, 2500), q: 0.8 }); }, () => 0.5);
  const h = white(n, s.r); svf(h, sr, 'hp', 3500, 0.7); mix(o, h, 0.03);
  return [unit(loopify(o, sr, X))];
}
export function fireOut(s) {
  const sr = s.sr, n = s.n(1.2), o = white(n, s.r);
  for (let i = 0; i < n; i++) { const t = i / sr; o[i] *= Math.exp(-t / 0.35) * Math.min(1, t / 0.02); }
  svf(o, sr, 'bp', { f0: 3000, f1: 1200, tau: 0.5 }, 0.6);
  return fin(unit(o), s, 60, 0.1);
}

/** Grenade canister bouncing. cls: hard soft metal wood */
export function nadeBounce(s, cls) {
  const o = new Float32Array(s.n(0.35));
  const b = s.rand(0.93, 1.07);
  if (cls === 'soft') {
    thud(o, s, 0, { amp: 0.8, f0: 170, f1: 90, dec: 0.02, noise: 1.3, lp: 700 });
    scatter(o, s, 20, 0.001, 0.06, (out, at, a, ss) => tick(out, at, a, ss, 0.0006, 0.5), () => 0.2);
  } else {
    const ring = cls === 'metal' ? 1.6 : cls === 'wood' ? 0.4 : 0.8;
    thud(o, s, 0, { amp: 0.6, f0: 220, f1: 110, dec: 0.012, noise: 0.8 });
    modal(o, s.sr, 0, [[1250 * b, 0.5, 0.03 * ring], [2930 * b, 0.35, 0.022 * ring], [4380 * b, 0.2, 0.015 * ring], [6100 * b, 0.1, 0.01 * ring]], 0.7, 0.0003);
    burst(o, s, 0, { dur: 0.002, amp: 0.6, hp: cls === 'wood' ? 700 : 1500, lp: cls === 'wood' ? 3500 : 0 });
    if (cls === 'wood') tock(o, s, 0, { amp: 0.4, f: 520, dec: 0.015 });
  }
  return fin(o, s, 50, 0.02);
}

export function decoyPop(s) {
  const o = new Float32Array(s.n(0.5));
  clack(o, s, 0, { amp: 0.6, f: 2200, ring: 0.02, body: 0.8, bodyF: 400 });
  burst(o, s, 0, { dur: 0.02, amp: 0.4, bp: 1200, q: 0.7, decay: 0.006 });
  return fin(o, s);
}

// ---- C4 --------------------------------------------------------------------------------------
const KEYS = [1336, 1209, 1477, 1336, 1633, 1209, 1477];
export function bombKey(s, i = 0) {
  const o = new Float32Array(s.n(0.2));
  clack(o, s, 0, { amp: 0.25, f: 3800, ring: 0.004, body: 0.2, bodyF: 900 }); // rubber-dome click
  beep(o, s, 0.004, 0.075, { amp: 0.5, f: KEYS[i % KEYS.length], harm: 0.5, buzz: 0.05 });
  return fin(o, s, 60, 0.01);
}
export function bombPlant(s) {
  // arming sequence while planting (~3 s): seven keypad presses at human rhythm
  const o = new Float32Array(s.n(3.3));
  let t = 0.1;
  for (let i = 0; i < 7; i++) {
    clack(o, s, t, { amp: 0.22, f: 3800, ring: 0.004, body: 0.2, bodyF: 900 });
    beep(o, s, t + 0.004, 0.07, { amp: 0.5, f: KEYS[i] * s.rand(0.995, 1.005), harm: 0.5, buzz: 0.05 });
    t += s.rand(0.3, 0.42);
  }
  cloth(o, s, 0, 0.4, { amp: 0.15 });
  return fin(o, s, 60, 0.02);
}
export function bombArm(s) {
  const o = new Float32Array(s.n(0.6));
  tock(o, s, 0, { amp: 0.5, f: 520, dec: 0.02 });
  thud(o, s, 0, { amp: 0.4, f0: 160, f1: 90, dec: 0.02 });
  clack(o, s, 0.02, { amp: 0.4, f: 2600, ring: 0.015, body: 0.5 });
  beep(o, s, 0.18, 0.06, { amp: 0.45, f: 1760, harm: 0.4 });
  beep(o, s, 0.28, 0.12, { amp: 0.5, f: 2350, harm: 0.4 });
  return fin(o, s, 60, 0.02);
}
export function bombBeep(s) {
  const o = new Float32Array(s.n(0.22));
  beep(o, s, 0, 0.11, { amp: 0.8, f: 2210, harm: 0.55, buzz: 0.08, attack: 0.001, release: 0.012 });
  return fin(o, s, 80, 0.01);
}
export function bombFinal(s) {
  // last second: beeps accelerate into a rising whine
  const sr = s.sr, o = new Float32Array(s.n(1.25));
  let t = 0, gap = 0.16;
  while (t < 0.85) { beep(o, s, t, Math.min(0.05, gap * 0.5), { amp: 0.6, f: 2210, harm: 0.55 }); t += gap; gap = Math.max(0.04, gap * 0.8); }
  const n = s.n(1.2), w = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / n; ph += TAU * (900 + 2400 * u * u) / sr; w[i] = (Math.sin(ph) + 0.3 * Math.sin(3 * ph)) * Math.pow(u, 1.5) * (u > 0.95 ? (1 - u) / 0.05 : 1); }
  mix(o, w, 0.35);
  return fin(o, s, 80, 0.01);
}
export function bombDefusing(s) {
  // kit opens, wire tinkering: ratchet ticks, snips, probe clicks (loops ~2.4 s)
  const o = new Float32Array(s.n(2.5));
  for (let i = 0; i < 16; i++) {
    const t = s.rand(0.05, 2.3);
    const kind = s.r();
    if (kind < 0.4) rattle(o, s, t, 0.08, { amp: 0.2, count: 5, f: 3000 });
    else if (kind < 0.7) clack(o, s, t, { amp: 0.3, f: s.rand(2500, 4200), ring: 0.008, body: 0.2 });
    else scrape(o, s, t, 0.06, { amp: 0.12, f0: 3000, f1: 4500, rough: 0.9 });
  }
  cloth(o, s, 0, 0.5, { amp: 0.15 });
  return fin(o, s, 60, 0.02);
}
export function bombDefused(s) {
  const sr = s.sr, o = new Float32Array(s.n(1.0));
  clack(o, s, 0, { amp: 0.6, f: 3400, ring: 0.01, body: 0.2 }); // snip
  const n = s.n(0.6), w = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / n; ph += TAU * (2400 * Math.pow(0.35, u)) / sr; w[i] = (Math.sin(ph) + 0.35 * Math.sin(3 * ph)) * Math.min(1, u * 40) * (1 - u); }
  mix(o, w, 0.3, s.n(0.08));
  return fin(o, s, 80, 0.02);
}
