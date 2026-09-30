// Weapon handling foley: deploy, reload parts, dry fire, zoom, silencer, knife, shell casings.
import { white, pink, svf, mix, modal, softclip, dcblock, fadeOut, envAD, TAU, tick } from './dsp.js';
import { clack, scrape, cloth, rattle, whoosh, spring, burst, tock, thud } from './mech.js';

const fin = (o, s) => { dcblock(o, s.sr, 30); fadeOut(o, s.sr, 0.01); return [o]; };

// Family tuning: heavier weapons have lower, clunkier modes.
const FAMF = {
  rifle: { f: 2400, body: 0.6, bodyF: 480 }, ak: { f: 1900, body: 0.8, bodyF: 380 },
  smg: { f: 2900, body: 0.45, bodyF: 560 }, pistol: { f: 3400, body: 0.35, bodyF: 650 },
  sniper: { f: 2100, body: 0.7, bodyF: 420 }, shotgun: { f: 2000, body: 0.7, bodyF: 400 }, lmg: { f: 1800, body: 0.9, bodyF: 340 },
};

export function deploy(s, fam) {
  const o = new Float32Array(s.n(0.75));
  const F = FAMF[fam] || FAMF.rifle;
  if (fam === 'knife') {
    // blade drawn from sheath: bright metallic slither with a ringing tail
    scrape(o, s, 0.02, 0.22, { amp: 0.35, f0: 3500, f1: 7000, q: 2.2, rough: 0.5, hp: 2000 });
    modal(o, s.sr, s.n(0.21), [[3150, 0.25, 0.25], [5230, 0.18, 0.18], [7810, 0.12, 0.12], [9920, 0.06, 0.08]], 0.8);
    cloth(o, s, 0, 0.18, { amp: 0.12 });
    return fin(o, s);
  }
  if (fam === 'grenade' || fam === 'c4') {
    cloth(o, s, 0, 0.25, { amp: 0.25 });
    rattle(o, s, 0.08, 0.15, { amp: 0.12, count: 5, f: fam === 'c4' ? 2400 : 3300 });
    if (fam === 'c4') tock(o, s, 0.22, { amp: 0.4, f: 700 });
    return fin(o, s);
  }
  cloth(o, s, 0, 0.3, { amp: 0.3, f: 1800 });
  rattle(o, s, 0.05, 0.25, { amp: 0.1, count: 6, f: F.f * 1.5 });
  if (fam === 'pistol') {
    clack(o, s, 0.2, { amp: 0.45, f: F.f, ring: 0.012, body: F.body, bodyF: F.bodyF });
  } else {
    // shoulder + charging handle tug
    thud(o, s, 0.16, { amp: 0.25, f0: 160, f1: 80, dec: 0.03, noise: 0.8 });
    scrape(o, s, 0.24, 0.07, { amp: 0.22, f0: F.f * 0.8, f1: F.f * 1.2 });
    clack(o, s, 0.32, { amp: 0.6, f: F.f, ring: 0.018, body: F.body, bodyF: F.bodyF });
  }
  return fin(o, s);
}

/** Reload / action parts. part: magout magin boltback boltfwd slide pump shell coveropen coverclose box */
export function part(s, fam, part) {
  const F = FAMF[fam] || FAMF.rifle;
  const o = new Float32Array(s.n(0.5));
  switch (part) {
    case 'magout':
      clack(o, s, 0, { amp: 0.35, f: F.f * 1.3, ring: 0.008, body: 0.2, bodyF: F.bodyF * 1.4 }); // release button
      scrape(o, s, 0.012, 0.07, { amp: 0.28, f0: F.f * 0.7, f1: F.f * 0.5, rough: 0.8 });
      clack(o, s, 0.075, { amp: 0.4, f: F.f * 0.6, ring: 0.01, body: F.body * 1.2, bodyF: F.bodyF, click: 0.5 });
      break;
    case 'magin':
      scrape(o, s, 0, 0.06, { amp: 0.25, f0: F.f * 0.5, f1: F.f * 0.8, rough: 0.8 });
      clack(o, s, 0.06, { amp: 0.8, f: F.f * 0.9, ring: 0.02, body: F.body * 1.3, bodyF: F.bodyF });
      clack(o, s, 0.078, { amp: 0.35, f: F.f * 1.4, ring: 0.008, body: 0.1 }); // latch
      break;
    case 'boltback':
      scrape(o, s, 0, 0.08, { amp: 0.3, f0: F.f * 0.8, f1: F.f * 1.3, rough: 0.6 });
      spring(o, s, 0.01, { amp: 0.05, f: 900, dur: 0.07 });
      clack(o, s, 0.082, { amp: 0.6, f: F.f * 1.05, ring: 0.015, body: F.body * 0.8, bodyF: F.bodyF });
      break;
    case 'boltfwd':
      scrape(o, s, 0, 0.025, { amp: 0.3, f0: F.f * 1.2, f1: F.f * 0.9, rough: 0.5 });
      clack(o, s, 0.026, { amp: 1.0, f: F.f, ring: 0.022, body: F.body * 1.2, bodyF: F.bodyF });
      rattle(o, s, 0.03, 0.05, { amp: 0.08, count: 3, f: F.f * 1.6 });
      break;
    case 'slide': // pistol slide release
      scrape(o, s, 0, 0.015, { amp: 0.2, f0: 4000, f1: 3000 });
      clack(o, s, 0.016, { amp: 0.9, f: F.f, ring: 0.014, body: F.body, bodyF: F.bodyF });
      break;
    case 'pump':
      scrape(o, s, 0, 0.07, { amp: 0.35, f0: 1500, f1: 2400, rough: 0.7 });
      clack(o, s, 0.07, { amp: 0.75, f: 1900, ring: 0.014, body: 0.9, bodyF: 380 });
      scrape(o, s, 0.13, 0.06, { amp: 0.3, f0: 2400, f1: 1600, rough: 0.7 });
      clack(o, s, 0.19, { amp: 0.85, f: 2100, ring: 0.016, body: 1.0, bodyF: 360 });
      break;
    case 'shell': // shotgun shell pushed into the tube
      scrape(o, s, 0, 0.04, { amp: 0.18, f0: 1600, f1: 1200, rough: 0.8 });
      tock(o, s, 0.04, { amp: 0.5, f: 950, dec: 0.01 });
      clack(o, s, 0.05, { amp: 0.35, f: 2600, ring: 0.01, body: 0.3 });
      spring(o, s, 0.05, { amp: 0.04, f: 1400, dur: 0.05 });
      break;
    case 'coveropen':
      clack(o, s, 0, { amp: 0.5, f: 1700, ring: 0.02, body: 0.8, bodyF: 330 });
      spring(o, s, 0.005, { amp: 0.08, f: 800, dur: 0.12 });
      rattle(o, s, 0.02, 0.1, { amp: 0.1, count: 5, f: 3000 });
      break;
    case 'coverclose':
      scrape(o, s, 0, 0.03, { amp: 0.2, f0: 1800, f1: 1400 });
      clack(o, s, 0.03, { amp: 1.0, f: 1600, ring: 0.025, body: 1.1, bodyF: 320 });
      break;
    case 'box': // belt box swap
      thud(o, s, 0, { amp: 0.4, f0: 180, f1: 90, dec: 0.03 });
      rattle(o, s, 0.01, 0.22, { amp: 0.25, count: 16, f: 2600, ring: 0.01 });
      clack(o, s, 0.2, { amp: 0.6, f: 1800, ring: 0.015, body: 0.9, bodyF: 360 });
      break;
    default:
      clack(o, s, 0, { amp: 0.6, f: F.f });
  }
  return fin(o, s);
}

export function dryfire(s) {
  const o = new Float32Array(s.n(0.15));
  clack(o, s, 0, { amp: 0.6, f: 3300, ring: 0.006, body: 0.25, bodyF: 800, bright: 1.3 });
  clack(o, s, 0.011, { amp: 0.25, f: 4200, ring: 0.004, body: 0.1 });
  return fin(o, s);
}

export function zoom(s) {
  const o = new Float32Array(s.n(0.18));
  clack(o, s, 0, { amp: 0.45, f: 3800, ring: 0.005, body: 0.15, bright: 1.2 });
  scrape(o, s, 0.005, 0.07, { amp: 0.1, f0: 5000, f1: 3500, q: 3, rough: 0.2, hp: 2500 });
  clack(o, s, 0.07, { amp: 0.2, f: 4500, ring: 0.004, body: 0 });
  return fin(o, s);
}

export function silencer(s, on) {
  const o = new Float32Array(s.n(1.0));
  // threads: accelerating (on) / decelerating (off) micro ticks with a faint metallic ring
  const N = 14;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const t = on ? 0.8 * Math.pow(u, 0.75) : 0.8 * (1 - Math.pow(1 - u, 0.75));
    const a = 0.12 + 0.12 * s.r();
    modal(o, s.sr, s.n(t), [[s.rand(4200, 5200), a, 0.006], [s.rand(7000, 8200), a * 0.5, 0.004]], 1);
    tick(o, s.n(t), a * 0.6, s, 0.001, 0.8);
  }
  scrape(o, s, 0, 0.8, { amp: 0.05, f0: 3800, f1: 4200, q: 3, rough: 0.9, hp: 2000 });
  clack(o, s, on ? 0.82 : 0.0, { amp: 0.5, f: 3100, ring: 0.02, body: 0.3 });
  return fin(o, s);
}

// ---- knife -----------------------------------------------------------------------------------
export function knifeSlash(s, heavy = false) {
  const o = new Float32Array(s.n(heavy ? 0.45 : 0.32));
  whoosh(o, s, 0, heavy ? 0.36 : 0.22, { amp: heavy ? 0.9 : 0.7, f0: heavy ? 400 : 700, f1: heavy ? 1800 : 3200, q: 1.1, peakAt: 0.4 });
  whoosh(o, s, 0.01, heavy ? 0.3 : 0.18, { amp: 0.25, f0: 3000, f1: 7000, q: 2, peakAt: 0.5 });
  cloth(o, s, 0, 0.2, { amp: 0.1 });
  return fin(o, s);
}
export function knifeHitWall(s) {
  const o = new Float32Array(s.n(0.45));
  clack(o, s, 0, { amp: 0.9, f: 2800, ring: 0.05, body: 0.3, bright: 1.2, modes: [1, 1.63, 2.41, 3.37, 4.1] });
  scrape(o, s, 0.004, 0.07, { amp: 0.3, f0: 5000, f1: 3500, rough: 0.9, hp: 1500 });
  tick(o, s.n(0.003), 0.4, s, 0.004, 0.5);
  return fin(o, s);
}
export function knifeHitFlesh(s, stab = false) {
  const o = new Float32Array(s.n(0.4));
  thud(o, s, 0, { amp: 0.8, f0: 150, f1: 70, dec: 0.04, noise: 1.2, lp: 900 });
  // wet slice
  const n = s.n(0.09);
  const b = white(n, s.r); envAD(b, s.sr, 0.002, stab ? 0.035 : 0.02);
  svf(b, s.sr, 'bp', { f0: 2600, f1: 900, tau: 0.03 }, 1.4);
  mix(o, b, 0.8);
  if (stab) thud(o, s, 0.05, { amp: 0.4, f0: 110, f1: 60, dec: 0.05 });
  return fin(o, s);
}

// ---- shell casings ---------------------------------------------------------------------------
const SHELL = {
  rifle: { f: 5200, ring: 0.06, n: 4 }, pistol: { f: 6800, ring: 0.045, n: 4 },
  sniper: { f: 4300, ring: 0.08, n: 4 }, shotgun: { f: 1100, ring: 0.012, n: 3, plastic: true },
};
/** kind: rifle pistol sniper shotgun; cls: hard metal wood soft */
export function shell(s, kind, cls) {
  const K = SHELL[kind] || SHELL.rifle;
  const o = new Float32Array(s.n(0.7));
  let t = 0, gap = s.rand(0.08, 0.13), a = 1;
  const bounces = K.n + (cls === 'soft' ? -2 : 0);
  for (let b = 0; b < Math.max(1, bounces); b++) {
    if (K.plastic) {
      tock(o, s, t, { amp: 0.5 * a, f: K.f * s.rand(0.9, 1.1) * (cls === 'metal' ? 1.3 : 1), dec: 0.012 });
      if (cls === 'metal') modal(o, s.sr, s.n(t), [[2600, 0.2 * a, 0.03]], 1);
    } else if (cls === 'soft') {
      burst(o, s, t, { dur: 0.008, amp: 0.5 * a, lp: 2500, hp: 300, decay: 0.002 });
      modal(o, s.sr, s.n(t), [[K.f * 0.7, 0.1 * a, 0.006]], 1);
    } else {
      const ring = K.ring * (cls === 'metal' ? 1.6 : cls === 'wood' ? 0.35 : 1);
      const f = K.f * s.rand(0.95, 1.05);
      const md = [[f, 0.5, ring], [f * 2.71, 0.3, ring * 0.7], [f * 1.53, 0.2, ring * 0.8], [f * 4.9, 0.12, ring * 0.4]];
      modal(o, s.sr, s.n(t), md, a * 0.7);
      burst(o, s, t, { dur: 0.002, amp: 0.4 * a, hp: cls === 'wood' ? 600 : 2500, lp: cls === 'wood' ? 3000 : 0 });
      if (cls === 'wood') tock(o, s, t, { amp: 0.3 * a, f: 700, dec: 0.01 });
    }
    t += gap; gap *= s.rand(0.55, 0.7); a *= s.rand(0.45, 0.65);
  }
  return fin(o, s);
}

// ---- grenade handling ------------------------------------------------------------------------
export function pinPull(s) {
  const o = new Float32Array(s.n(0.4));
  clack(o, s, 0, { amp: 0.4, f: 3600, ring: 0.03, body: 0.1 });
  scrape(o, s, 0.01, 0.06, { amp: 0.15, f0: 4000, f1: 5000, rough: 0.6, hp: 2000 });
  modal(o, s.sr, s.n(0.07), [[4700, 0.3, 0.12], [7100, 0.2, 0.08], [2950, 0.12, 0.1]], 0.6); // pin ring jingle
  modal(o, s.sr, s.n(0.12), [[5100, 0.2, 0.09], [7600, 0.12, 0.06]], 0.5);
  return fin(o, s);
}
export function throwWhoosh(s) {
  const o = new Float32Array(s.n(0.45));
  cloth(o, s, 0, 0.25, { amp: 0.25 });
  whoosh(o, s, 0.05, 0.3, { amp: 0.45, f0: 350, f1: 1400, q: 1.0 });
  clack(o, s, 0.08, { amp: 0.15, f: 2600, ring: 0.02, body: 0.1 }); // spoon flies off
  return fin(o, s);
}

/** A dropped weapon (or the C4) hitting the ground: clunk, rattle, small bounce. */
export function weaponLand(s, heavy = true) {
  const o = new Float32Array(s.n(0.7));
  thud(o, s, 0, { amp: 0.7, f0: 170, f1: 90, dec: 0.03, noise: 1.2, lp: 900 });
  clack(o, s, 0.002, { amp: 0.7, f: heavy ? 1700 : 2300, ring: 0.03, body: 1.0, bodyF: 340 });
  rattle(o, s, 0.01, 0.2, { amp: 0.22, count: 10, f: 2600 });
  const t2 = s.rand(0.16, 0.22);
  clack(o, s, t2, { amp: 0.35, f: heavy ? 1900 : 2500, ring: 0.02, body: 0.7, bodyF: 380 });
  thud(o, s, t2, { amp: 0.3, f0: 160, f1: 90, dec: 0.02 });
  rattle(o, s, t2 + 0.01, 0.12, { amp: 0.1, count: 5, f: 3000 });
  return fin(o, s);
}

/** Picking up a weapon / item: grab rattle + latch click. */
export function itemPickup(s) {
  const o = new Float32Array(s.n(0.4));
  cloth(o, s, 0, 0.18, { amp: 0.25 });
  rattle(o, s, 0.02, 0.14, { amp: 0.2, count: 7, f: 3000 });
  clack(o, s, 0.13, { amp: 0.5, f: 2500, ring: 0.014, body: 0.5 });
  return fin(o, s);
}
