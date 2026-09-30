// Human-ish aim for bots.
//
// View angles are driven by a damped spring (angular acceleration = ω²·err − 2ζω·vel) with a
// speed cap: big target switches become a fast ballistic flick that slightly overshoots and
// settles, small ones are smooth tracking. On top of the true aim point sits an error offset
// drawn on acquisition (bigger for moving targets and low skill) that decays while the bot
// keeps tracking, plus a slow wander so even settled aim is never pixel-perfect.
import { angleNormalize, clamp } from '../core/mathx.js';

export class Aim {
  constructor(profile, rnd = Math.random) {
    this.p = profile;
    this.rnd = rnd;
    this.pitch = 0; this.yaw = 0;
    this.vp = 0; this.vy = 0;
    this.errP = 0; this.errY = 0;
    this.trackTime = 0;
    this.phase = rnd() * 100;
    this.onTarget = 0;      // |err| to the true aim point, degrees (after update)
  }

  reset(pitch, yaw) { this.pitch = pitch; this.yaw = yaw; this.vp = 0; this.vy = 0; }

  /** New target: draw a fresh aim error. `moveFactor` 0..1 = how fast the target moves across view. */
  acquire(moveFactor = 0, surprise = 0) {
    const p = this.p, r = this.rnd;
    const E = p.aimError * (0.5 + 0.8 * r()) * (1 + 0.9 * moveFactor + 0.4 * surprise);
    const th = r() * Math.PI * 2;
    this.errY = Math.cos(th) * E;
    this.errP = Math.sin(th) * E * 0.55;
    this.trackTime = 0;
  }

  /** Target jinked (strafe reversal etc.): add error proportional to the surprise. */
  disturb(amount) {
    const s = this.rnd() < 0.5 ? -1 : 1;
    this.errY += s * amount * this.p.aimError * 0.6;
  }

  /**
   * Step toward (wantPitch, wantYaw). mode 'combat' uses the fast profile spring and applies
   * the error model; 'look' is a calm head turn.
   */
  update(dt, wantPitch, wantYaw, mode = 'look') {
    const p = this.p;
    let tp = wantPitch, ty = wantYaw;
    let omega, zeta, vmax;
    if (mode === 'combat') {
      this.trackTime += dt;
      const k = Math.exp(-dt / p.errorDecay);
      this.errP *= k; this.errY *= k;
      this.phase += dt;
      // residual wander: two incommensurate sines, amplitude scales with skill floor
      const w = p.aimError * 0.14;
      const wy = w * (Math.sin(this.phase * 2.3) + 0.6 * Math.sin(this.phase * 5.1 + 1.3));
      const wp = w * 0.6 * (Math.sin(this.phase * 1.7 + 0.4) + 0.5 * Math.sin(this.phase * 4.3));
      tp += this.errP + wp; ty += this.errY + wy;
      omega = p.aimOmega; zeta = p.aimZeta; vmax = p.aimSpeed;
    } else {
      omega = p.lookOmega; zeta = 1.0; vmax = p.lookSpeed;
    }
    const ep = clamp(tp, -89, 89) - this.pitch;
    const ey = angleNormalize(ty - this.yaw);
    this.vp += (omega * omega * ep - 2 * zeta * omega * this.vp) * dt;
    this.vy += (omega * omega * ey - 2 * zeta * omega * this.vy) * dt;
    const sp = Math.hypot(this.vp, this.vy);
    if (sp > vmax) { const s = vmax / sp; this.vp *= s; this.vy *= s; }
    this.pitch = clamp(this.pitch + this.vp * dt, -89, 89);
    this.yaw = angleNormalize(this.yaw + this.vy * dt);
    this.onTarget = Math.hypot(angleNormalize(wantYaw - this.yaw), wantPitch - this.pitch);
    return this;
  }
}

/** Angles (pitch, yaw) from a to b in the CS convention (CONTRACT §1). Writes into out. */
export function anglesTo(ax, ay, az, bx, by, bz, out) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const h = Math.hypot(dx, dz);
  out.yaw = Math.atan2(-dz, dx) * 180 / Math.PI;
  out.pitch = -Math.atan2(dy, h) * 180 / Math.PI;
  return out;
}

// Difficulty presets. Numbers are tuned to feel like CS:GO bots on the matching level.
export const DIFFICULTY = {
  easy: {
    skill: 0.2, reaction: [0.42, 0.62], aimOmega: 11, aimZeta: 0.92, aimSpeed: 380, aimError: 5.0,
    errorDecay: 0.7, headRatio: 0.1, recoilComp: 0.3, fireTolerance: 2.2, counterStrafe: 0.2,
    crouchSpray: 0.15, trackLag: 0.16, lookOmega: 7, lookSpeed: 220, burstDiscipline: 0.3, aggression: 0.35,
  },
  normal: {
    skill: 0.5, reaction: [0.28, 0.42], aimOmega: 16, aimZeta: 0.8, aimSpeed: 620, aimError: 3.0,
    errorDecay: 0.45, headRatio: 0.22, recoilComp: 0.55, fireTolerance: 1.6, counterStrafe: 0.6,
    crouchSpray: 0.35, trackLag: 0.11, lookOmega: 9, lookSpeed: 300, burstDiscipline: 0.6, aggression: 0.5,
  },
  hard: {
    skill: 0.75, reaction: [0.2, 0.3], aimOmega: 22, aimZeta: 0.72, aimSpeed: 900, aimError: 1.8,
    errorDecay: 0.3, headRatio: 0.4, recoilComp: 0.72, fireTolerance: 1.25, counterStrafe: 0.85,
    crouchSpray: 0.45, trackLag: 0.08, lookOmega: 11, lookSpeed: 380, burstDiscipline: 0.8, aggression: 0.6,
  },
  expert: {
    skill: 0.92, reaction: [0.15, 0.22], aimOmega: 28, aimZeta: 0.68, aimSpeed: 1200, aimError: 1.1,
    errorDecay: 0.22, headRatio: 0.6, recoilComp: 0.85, fireTolerance: 1.05, counterStrafe: 0.95,
    crouchSpray: 0.5, trackLag: 0.06, lookOmega: 13, lookSpeed: 450, burstDiscipline: 0.9, aggression: 0.65,
  },
};

/** Resolve a difficulty given as name, 0..3 index or 0..1 skill; jitter per bot so no two play alike. */
export function makeProfile(difficulty = 'normal', rnd = Math.random) {
  let base;
  if (typeof difficulty === 'string' && DIFFICULTY[difficulty.toLowerCase()]) base = DIFFICULTY[difficulty.toLowerCase()];
  else if (typeof difficulty === 'number') {
    const names = ['easy', 'normal', 'hard', 'expert'];
    const i = difficulty <= 1 && !Number.isInteger(difficulty) ? Math.round(difficulty * 3) : difficulty;
    base = DIFFICULTY[names[clamp(Math.round(i), 0, 3)]];
  } else base = DIFFICULTY.normal;
  const j = (v, a = 0.15) => v * (1 + (rnd() * 2 - 1) * a);
  return {
    ...base,
    reaction: [j(base.reaction[0], 0.1), j(base.reaction[1], 0.1)],
    aimOmega: j(base.aimOmega), aimError: j(base.aimError, 0.2), headRatio: clamp(j(base.headRatio, 0.3), 0, 0.95),
    recoilComp: clamp(j(base.recoilComp, 0.15), 0, 0.95), aggression: clamp(j(base.aggression, 0.35), 0.05, 0.95),
    teamwork: clamp(0.4 + rnd() * 0.6, 0, 1),
    awper: rnd() < 0.3,
  };
}
