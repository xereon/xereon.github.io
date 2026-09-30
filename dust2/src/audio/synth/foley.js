// Footsteps, body foley, bullet impacts and player-hit sounds.
import { white, pink, svf, mix, modal, softclip, dcblock, fadeOut, envAD, TAU, tick, scatter, sweepSine, osc, scale, peak } from './dsp.js';
import { clack, scrape, cloth, rattle, whoosh, burst, tock, thud } from './mech.js';

const fin = (o, s, hp = 30) => { dcblock(o, s.sr, hp); fadeOut(o, s.sr, 0.015); return [o]; };
const unit = (x) => { const p = peak(x); return p > 1e-9 ? scale(x, 1 / p) : x; };

/** Tiny grain for sand/gravel crunch: noise tick optionally with a pebble ping. */
function grain(lo, hi, ping = 0, dur = 0.0006) {
  return (out, at, amp, s) => {
    const n = Math.max(6, Math.round(dur * s.sr * s.rand(0.6, 1.6)));
    const g = white(n, s.r);
    envAD(g, s.sr, 0.00005, dur * 0.35);
    svf(g, s.sr, 'bp', s.rand(lo, hi), 0.9);
    mix(out, g, amp, at);
    if (ping > 0) modal(out, s.sr, at, [[s.rand(hi * 0.8, hi * 1.6), amp * ping, 0.003]], 1);
  };
}

// One foot contact on a surface; `w` = weight (1 heel, ~0.6 toe)
function contact(o, s, t, surf, w) {
  const sr = s.sr, at = s.n(t);
  switch (surf) {
    case 'sand': {
      thud(o, s, t, { amp: 0.14 * w, f0: 110, f1: 60, dec: 0.018, noise: 1.2, lp: 400 });
      scatter(o, s, Math.round(120 * w), t, t + 0.07 * w + 0.02, grain(1800, 6500, 0, 0.0005), (u) => (1 - u) * 0.7 * w);
      const h = pink(s.n(0.1), s.r); envAD(h, sr, 0.004, 0.022); svf(h, sr, 'bp', 3000, 0.6); mix(o, unit(h), 0.45 * w, at);
      const l = pink(s.n(0.08), s.r); envAD(l, sr, 0.003, 0.02); svf(l, sr, 'bp', 700, 0.8); mix(o, unit(l), 0.18 * w, at);
      break;
    }
    case 'gravel': {
      thud(o, s, t, { amp: 0.16 * w, f0: 120, f1: 60, dec: 0.018, noise: 1, lp: 500 });
      scatter(o, s, Math.round(50 * w), t, t + 0.09 * w + 0.02, grain(1200, 3800, 0.6, 0.0012), (u) => Math.pow(1 - u, 0.7) * 0.9 * w);
      scatter(o, s, Math.round(50 * w), t, t + 0.05, grain(3000, 8000, 0, 0.0004), () => 0.35 * w);
      const l = pink(s.n(0.08), s.r); envAD(l, sr, 0.002, 0.02); svf(l, sr, 'bp', 900, 0.8); mix(o, unit(l), 0.2 * w, at);
      break;
    }
    case 'dirt': {
      thud(o, s, t, { amp: 0.3 * w, f0: 120, f1: 60, dec: 0.02, noise: 1.4, lp: 600 });
      burst(o, s, t, { dur: 0.012, amp: 0.45 * w, bp: 900, q: 0.7, decay: 0.004 });
      scatter(o, s, Math.round(40 * w), t, t + 0.06, grain(900, 3000, 0, 0.0009), (u) => (1 - u) * 0.5 * w);
      break;
    }
    case 'concrete': case 'plaster': case 'tile': {
      const tile = surf === 'tile', pl = surf === 'plaster';
      thud(o, s, t, { amp: 0.18 * w, f0: 140, f1: 70, dec: 0.012, noise: 0.9, lp: 800 });
      // sole slap: broadband mid click + a bright tick on top
      burst(o, s, t, { dur: 0.01, amp: (pl ? 0.7 : 0.9) * w, bp: pl ? 1300 : 1700, q: 0.7, decay: pl ? 0.0026 : 0.0018 });
      burst(o, s, t, { dur: 0.004, amp: (tile ? 0.9 : pl ? 0.3 : 0.5) * w, bp: tile ? 4200 : 3600, q: 1, decay: tile ? 0.0009 : 0.0007 });
      if (tile) modal(o, sr, at, [[s.rand(3100, 3500), 0.14 * w, 0.016], [s.rand(5000, 5600), 0.09 * w, 0.011]], 1);
      // grit under the sole + a short scuff
      scatter(o, s, Math.round((pl ? 30 : 18) * w), t, t + 0.035, grain(2500, 7000, 0, 0.0004), () => (pl ? 0.35 : 0.28) * w);
      scrape(o, s, t + 0.006, 0.035, { amp: 0.09 * w, f0: 2600, f1: 2200, rough: 0.9, hp: 1200 });
      break;
    }
    case 'wood': {
      thud(o, s, t, { amp: 0.22 * w, f0: 150, f1: 85, dec: 0.016, noise: 0.8, lp: 900 });
      modal(o, sr, at, [[s.rand(230, 260), 0.3 * w, 0.018], [s.rand(390, 430), 0.3 * w, 0.016], [s.rand(600, 660), 0.25 * w, 0.013], [s.rand(950, 1040), 0.18 * w, 0.01], [s.rand(1420, 1550), 0.1 * w, 0.007]], 1, 0.0008);
      burst(o, s, t, { dur: 0.006, amp: 0.7 * w, bp: 1600, q: 0.8, decay: 0.0016 });
      break;
    }
    case 'metal': {
      thud(o, s, t, { amp: 0.25 * w, f0: 150, f1: 80, dec: 0.014, noise: 0.7, lp: 900 });
      burst(o, s, t, { dur: 0.004, amp: 0.6 * w, bp: 2800, q: 0.8, decay: 0.0009 });
      const b = s.rand(0.94, 1.06);
      modal(o, sr, at, [[410 * b, 0.28, 0.08], [1130 * b, 0.3, 0.07], [1870 * b, 0.24, 0.055], [2720 * b, 0.18, 0.045], [3690 * b, 0.12, 0.035], [4810 * b, 0.08, 0.025]].map((m) => [m[0], m[1] * w, m[2] * s.rand(0.8, 1.2)]), 0.6, 0.0008);
      break;
    }
    case 'metalgrate': {
      thud(o, s, t, { amp: 0.2 * w, f0: 160, f1: 90, dec: 0.012, noise: 0.6 });
      const hits = 3 + Math.floor(s.r() * 3);
      for (let i = 0; i < hits; i++) {
        const tt = t + i * s.rand(0.004, 0.009);
        const a = w * (1 - i / (hits + 1)) * s.rand(0.6, 1);
        modal(o, sr, s.n(tt), [[s.rand(850, 950), 0.25 * a, 0.05], [s.rand(2000, 2200), 0.25 * a, 0.045], [s.rand(3300, 3600), 0.18 * a, 0.03], [s.rand(5000, 5500), 0.1 * a, 0.02]], 0.7);
        burst(o, s, tt, { dur: 0.0015, amp: 0.3 * a, hp: 2000 });
      }
      break;
    }
    default: contact(o, s, t, 'concrete', w);
  }
}

export const FOOT_SURFACES = ['sand', 'gravel', 'concrete', 'plaster', 'wood', 'metal', 'metalgrate', 'tile', 'dirt'];

export function footstep(s, surf) {
  const ring = surf === 'metal' ? 0.4 : surf === 'metalgrate' ? 0.3 : 0.12;
  const o = new Float32Array(s.n(0.2 + ring));
  const toe = s.rand(0.045, 0.085);
  contact(o, s, 0.002, surf, 1);
  contact(o, s, toe, surf, s.rand(0.5, 0.72));
  // kit + cloth (the "tactical" layer of CS footsteps)
  if (s.r() < 0.7) rattle(o, s, s.rand(0, 0.03), 0.06, { amp: 0.035, count: 3, f: 3600 });
  cloth(o, s, 0, 0.12, { amp: 0.035, f: 2600 });
  svf(o, s.sr, 'lp', 11000, 0.7);
  return fin(o, s, 40);
}

export function jump(s) {
  const o = new Float32Array(s.n(0.4));
  cloth(o, s, 0, 0.28, { amp: 0.4, f: 1800, rate: 45 });
  rattle(o, s, 0.02, 0.18, { amp: 0.18, count: 7, f: 3000 });
  burst(o, s, 0, { dur: 0.02, amp: 0.25, bp: 1200, q: 0.6, decay: 0.006 });
  return fin(o, s);
}
export function land(s) {
  const o = new Float32Array(s.n(0.45));
  thud(o, s, 0, { amp: 0.9, f0: 120, f1: 50, dec: 0.045, noise: 1.2, lp: 600 });
  thud(o, s, s.rand(0.012, 0.025), { amp: 0.5, f0: 110, f1: 55, dec: 0.035 });
  rattle(o, s, 0.005, 0.15, { amp: 0.3, count: 10, f: 2800 });
  cloth(o, s, 0, 0.2, { amp: 0.3, f: 1600 });
  return fin(o, s);
}
export function crouch(s) {
  const o = new Float32Array(s.n(0.3));
  cloth(o, s, 0, 0.24, { amp: 0.4, f: 1500, rate: 25 });
  rattle(o, s, 0.05, 0.12, { amp: 0.06, count: 3, f: 3200 });
  return fin(o, s);
}

/** Short breathy grunt: glottal pulse train through vowel formants. */
function grunt(o, s, t, { f0 = 115, dur = 0.22, amp = 0.35 } = {}) {
  const sr = s.sr, n = s.n(dur);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = i / n; f[i] = f0 * (1.15 - 0.3 * u) * (1 + 0.02 * Math.sin(TAU * 7 * i / sr)); }
  const src = osc(n, sr, f, 'saw');
  const br = white(n, s.r); mix(src, br, 0.35);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = i / n; env[i] = Math.min(1, u / 0.08) * Math.pow(1 - u, 1.5); }
  for (let i = 0; i < n; i++) src[i] *= env[i];
  const v = new Float32Array(n);
  for (const [F, g, q] of [[620, 1, 6], [1150, 0.6, 8], [2500, 0.25, 10], [3400, 0.1, 10]]) {
    const b = svf(new Float32Array(src), sr, 'bp', F, q);
    mix(v, b, g);
  }
  svf(v, sr, 'lp', 3500, 0.7);
  mix(o, unit(v), amp, s.n(t));
}

export function fallDamage(s) {
  const o = new Float32Array(s.n(0.55));
  thud(o, s, 0, { amp: 1.0, f0: 110, f1: 45, dec: 0.06, noise: 1.4, lp: 500 });
  // crunch: dense sharp crackle (knees / gear)
  scatter(o, s, 40, 0, 0.05, (out, at, a, ss) => burst(out, ss, at / ss.sr, { dur: 0.0015, amp: a, hp: 1500, decay: 0.0004 }), (u) => (1 - u) * 0.5);
  rattle(o, s, 0.01, 0.15, { amp: 0.3, count: 10, f: 2600 });
  grunt(o, s, 0.03, { f0: 120, dur: 0.24, amp: 0.3 });
  softclip(o, 1.5);
  return fin(o, s);
}

export function deathFall(s) {
  const o = new Float32Array(s.n(1.1));
  cloth(o, s, 0, 0.4, { amp: 0.35, f: 1400, rate: 30 });
  rattle(o, s, 0.05, 0.4, { amp: 0.15, count: 10, f: 2800 });
  thud(o, s, s.rand(0.22, 0.28), { amp: 0.6, f0: 110, f1: 55, dec: 0.05, noise: 1.2 });
  thud(o, s, s.rand(0.42, 0.5), { amp: 1.0, f0: 95, f1: 45, dec: 0.08, noise: 1.5, lp: 450 });
  clack(o, s, s.rand(0.45, 0.55), { amp: 0.35, f: 1900, ring: 0.03, body: 0.8, bodyF: 380 }); // weapon hits the ground
  rattle(o, s, 0.5, 0.2, { amp: 0.18, count: 6, f: 2400 });
  return fin(o, s);
}

// ---- bullet impacts --------------------------------------------------------------------------
export const IMPACT_SURFACES = ['concrete', 'plaster', 'tile', 'wood', 'metal', 'metaldoor', 'sand', 'dirt', 'flesh', 'glass', 'cloth'];

function ricochet(o, s, t) {
  const n = s.n(0.35);
  const f0 = s.rand(3000, 4500), f1 = f0 * s.rand(0.35, 0.5);
  const fr = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = i / n; fr[i] = f0 * Math.pow(f1 / f0, u) * (1 + 0.04 * Math.sin(TAU * 38 * i / s.sr)); }
  const w = osc(n, s.sr, fr, 'sine');
  const nz = white(n, s.r); svf(nz, s.sr, 'bp', f0 * 0.8, 3); mix(w, nz, 0.3);
  for (let i = 0; i < n; i++) { const u = i / n; w[i] *= Math.min(1, u / 0.02) * Math.pow(1 - u, 1.8); }
  mix(o, w, 0.28, s.n(t));
}

export function impact(s, surf, variant = 0) {
  const o = new Float32Array(s.n(0.6));
  const sr = s.sr;
  const dust = (amt, lo, hi, dur = 0.15) => scatter(o, s, Math.round(40 * amt), 0.002, dur, grain(lo, hi, 0, 0.0005), (u) => Math.pow(1 - u, 1.5) * amt);
  switch (surf) {
    case 'concrete': case 'tile': case 'plaster': {
      const pl = surf === 'plaster', tile = surf === 'tile';
      burst(o, s, 0, { dur: 0.002, amp: pl ? 0.8 : 1.1, hp: pl ? 900 : 1400, lp: pl ? 7000 : 0, decay: 0.0006 });
      burst(o, s, 0, { dur: 0.012, amp: 0.5, bp: pl ? 1200 : 1900, q: 0.8, decay: 0.004 });
      thud(o, s, 0, { amp: 0.4, f0: 320, f1: 150, dec: 0.01, noise: 0.5, lp: 1200 });
      if (tile) modal(o, sr, 0, [[s.rand(3600, 4000), 0.25, 0.025], [s.rand(5800, 6400), 0.15, 0.018]], 1);
      dust(pl ? 0.6 : 0.45, pl ? 1200 : 2200, pl ? 4500 : 7500, pl ? 0.22 : 0.16);
      const h = pink(s.n(0.2), s.r); envAD(h, sr, 0.003, pl ? 0.07 : 0.045); svf(h, sr, 'bp', pl ? 2500 : 4000, 0.7); mix(o, unit(h), pl ? 0.35 : 0.25);
      if (!pl && variant % 4 === 3) ricochet(o, s, 0.004);
      break;
    }
    case 'wood': {
      burst(o, s, 0, { dur: 0.003, amp: 1.1, hp: 1400, decay: 0.0007 });
      modal(o, sr, 0, [[s.rand(200, 240), 0.4, 0.028], [s.rand(460, 520), 0.35, 0.022], [s.rand(880, 960), 0.25, 0.016], [s.rand(1500, 1700), 0.15, 0.01]], 0.8, 0.0005);
      thud(o, s, 0, { amp: 0.35, f0: 200, f1: 110, dec: 0.02, noise: 0.6 });
      scatter(o, s, 36, 0.001, 0.05, (out, at, a, ss) => burst(out, ss, at / ss.sr, { dur: 0.001, amp: a, hp: 2000, decay: 0.0003 }), (u) => (1 - u) * 0.55);
      break;
    }
    case 'metal': case 'metaldoor': {
      const door = surf === 'metaldoor';
      burst(o, s, 0, { dur: 0.0015, amp: 1.0, hp: 2000, decay: 0.0004 });
      const b = s.rand(0.93, 1.07);
      const md = door
        ? [[420, 0.4, 0.3], [890, 0.35, 0.22], [1410, 0.3, 0.18], [2270, 0.2, 0.12], [3120, 0.15, 0.09], [4400, 0.08, 0.05]]
        : [[1850, 0.45, 0.2], [3120, 0.35, 0.14], [4400, 0.25, 0.1], [5650, 0.15, 0.07], [7300, 0.1, 0.05], [980, 0.2, 0.12]];
      modal(o, sr, 0, md.map((m) => [m[0] * b * s.rand(0.98, 1.02), m[1], m[2] * s.rand(0.8, 1.2), s.rand(0, TAU)]), 0.8, 0.0003);
      thud(o, s, 0, { amp: door ? 0.5 : 0.25, f0: 250, f1: 120, dec: 0.015 });
      if (!door && variant % 3 === 2) ricochet(o, s, 0.003);
      break;
    }
    case 'sand': case 'dirt': {
      const d = surf === 'dirt';
      thud(o, s, 0, { amp: 0.7, f0: d ? 150 : 170, f1: 80, dec: 0.018, noise: 1.3, lp: d ? 600 : 800 });
      burst(o, s, 0, { dur: 0.004, amp: 0.4, bp: 1000, q: 0.7 });
      dust(d ? 0.35 : 0.5, d ? 1200 : 2000, d ? 4000 : 7000, 0.18);
      const h = pink(s.n(0.25), s.r); envAD(h, sr, 0.004, 0.06); svf(h, sr, 'bp', d ? 2000 : 3500, 0.6); mix(o, unit(h), 0.3);
      break;
    }
    case 'flesh': {
      thud(o, s, 0, { amp: 0.9, f0: 150, f1: 70, dec: 0.03, noise: 1.3, lp: 1100 });
      const b = white(s.n(0.05), s.r); envAD(b, sr, 0.0008, 0.012); svf(b, sr, 'bp', { f0: 1400, f1: 700, tau: 0.01 }, 1.2); mix(o, unit(b), 0.55);
      burst(o, s, 0, { dur: 0.002, amp: 0.3, bp: 2500, q: 0.8 });
      break;
    }
    case 'glass': {
      burst(o, s, 0, { dur: 0.002, amp: 1.0, hp: 2500, decay: 0.0005 });
      for (let i = 0; i < 26; i++) {
        const t = 0.002 + 0.35 * Math.pow(s.r(), 1.8);
        modal(o, sr, s.n(t), [[s.rand(3000, 9000), s.rand(0.05, 0.25) * (1 - t * 2), s.rand(0.02, 0.07)]], 1);
      }
      break;
    }
    case 'cloth': {
      thud(o, s, 0, { amp: 0.6, f0: 160, f1: 80, dec: 0.018, noise: 1.2, lp: 700 });
      const h = pink(s.n(0.12), s.r); envAD(h, sr, 0.002, 0.03); svf(h, sr, 'bp', 2200, 0.7); mix(o, unit(h), 0.3);
      break;
    }
    default: return impact(s, 'concrete', variant);
  }
  softclip(o, 1.2);
  return fin(o, s, 40);
}

// ---- hit feedback ----------------------------------------------------------------------------
export function hitHelmet(s) {
  // the CS helmet "tink": one narrow dominant partial, a couple of weak inharmonics, a click
  const o = new Float32Array(s.n(0.55));
  const f = s.rand(3850, 4150);
  modal(o, s.sr, 0, [[f, 1.0, 0.11], [f * 1.583, 0.28, 0.065], [f * 0.69, 0.22, 0.08], [f * 2.26, 0.1, 0.04]], 0.6, 0.0002);
  burst(o, s, 0, { dur: 0.0015, amp: 0.7, hp: 3000, decay: 0.0004 });
  thud(o, s, 0, { amp: 0.25, f0: 180, f1: 90, dec: 0.015 });
  return fin(o, s, 60);
}
export function hitHead(s) {
  // no helmet: hollow bony "dink" + wet thwack
  const o = new Float32Array(s.n(0.35));
  const f = s.rand(1100, 1250);
  modal(o, s.sr, 0, [[f, 0.8, 0.045], [f * 1.56, 0.5, 0.032], [f * 2.31, 0.3, 0.022], [f * 3.4, 0.12, 0.012]], 0.6, 0.0003);
  burst(o, s, 0, { dur: 0.002, amp: 0.8, hp: 1800, decay: 0.0005 });
  thud(o, s, 0, { amp: 0.6, f0: 160, f1: 75, dec: 0.025, noise: 1.2, lp: 1200 });
  const b = white(s.n(0.04), s.r); envAD(b, s.sr, 0.0008, 0.01); svf(b, s.sr, 'bp', 1600, 1.1); mix(o, unit(b), 0.35);
  softclip(o, 1.3);
  return fin(o, s, 50);
}
export function hitBody(s) {
  const o = new Float32Array(s.n(0.3));
  thud(o, s, 0, { amp: 0.5, f0: 170, f1: 90, dec: 0.028, noise: 1.3, lp: 1300 });
  burst(o, s, 0, { dur: 0.012, amp: 0.9, bp: 1100, q: 0.6, decay: 0.003 });
  burst(o, s, 0, { dur: 0.02, amp: 0.6, bp: 380, q: 1, decay: 0.006 });
  const b = white(s.n(0.04), s.r); envAD(b, s.sr, 0.001, 0.01); svf(b, s.sr, 'bp', 900, 1.2); mix(o, unit(b), 0.3);
  softclip(o, 1.4);
  return fin(o, s, 40);
}
export function hitKevlar(s) {
  const o = new Float32Array(s.n(0.3));
  thud(o, s, 0, { amp: 0.4, f0: 150, f1: 70, dec: 0.028, noise: 1.1, lp: 1100 });
  burst(o, s, 0, { dur: 0.008, amp: 0.9, bp: 2300, q: 1.0, decay: 0.0018 });
  burst(o, s, 0, { dur: 0.02, amp: 0.5, bp: 450, q: 1, decay: 0.005 });
  tock(o, s, 0, { amp: 0.35, f: 620, dec: 0.012 });
  const h = pink(s.n(0.08), s.r); envAD(h, s.sr, 0.001, 0.02); svf(h, s.sr, 'bp', 3000, 0.8); mix(o, unit(h), 0.25);
  softclip(o, 1.3);
  return fin(o, s, 40);
}
