// Spray patterns + recoil dynamics (CONTRACT §7).
//
// recoilTable(key) -> Array<[yawDeg, pitchDeg]>: the AIM PUNCH at the moment shot i is fired
// during an uninterrupted spray (index 0 = first shot = [0, 0]). Source sign convention:
// +yaw = left, +pitch = down, so a rising pattern has negative pitch. Bullets leave along
// view + aimPunch * weapon_recoil_scale (2, as CS:GO), so the wall pattern is 2x the table.
//
// How the pattern is produced at runtime (CS:GO model, split across two modules):
//   * the Player owns decay: aimPunch decays exp 8 + lin 18 deg/s and integrates aimPunchVel
//     (decaying 4.5/s) every tick — CS:GO DecayAimPunchAngle;
//   * we own the kick: after every shot we add an impulse to aimPunchVel. Instead of CS:GO's
//     seeded random walk we solve for the impulse that lands the punch on the next pattern
//     point one cycle later, so the recognisable Valve patterns come out exactly while the
//     motion stays smooth, decays naturally and re-centres like CS when you stop firing.
//
// Pattern sources:
//   * AK-47, M4A4, M4A1-S, FAMAS, Galil, UMP-45, AUG, SG 553: per-shot compensation tables
//     measured from the real game (the widely circulated recoil-control data), converted
//     at 0.055 deg per count (sensitivity 2.5 * m_yaw 0.022).
//   * MP9, MAC-10, MP7, MP5-SD, P90, CZ75, Negev, M249: key points of the in-game charts.
//   * everything else (pistols, shotguns, snipers): CS:GO's own recoil generator
//     (recoil angle/variance/magnitude, first-shot suppression, same punch dynamics).
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { WEAPONS } from './registry.js';

defCvar('weapon_recoil_scale', 2, 0, 5, 'bullet deflection per degree of aim punch (CS:GO 2)');
defCvar('weapon_recoil_view_punch_extra', 0.055, 0, 1, 'camera view punch per unit of recoil kick');
defCvar('weapon_recoil_decay2_exp', 8, 0, 100, 'aim punch exponential decay');
defCvar('weapon_recoil_decay2_lin', 18, 0, 100, 'aim punch linear decay (deg/s)');
defCvar('weapon_recoil_vel_decay', 4.5, 0, 100, 'aim punch velocity decay');
defCvar('weapon_recoil_pattern_scale', 1, 0, 3, 'spray pattern size multiplier');
defCvar('weapon_recoil_variance', 1, 0, 4, 'per-shot seeded recoil jitter (x recoilAngleVariance)');
defCvar('weapon_recoil_suppression_shots', 4, 0, 10, 'first shots with reduced kick (CS:GO)');
defCvar('weapon_recoil_suppression_factor', 0.75, 0, 1, 'kick scale of the first shot');

const K_BULLET = 0.055;       // bullet degrees per compensation count
const K_PUNCH = K_BULLET / 2; // aim punch degrees (weapon_recoil_scale 2)

// ---- measured compensation tables: [dx, dy] mouse counts applied after shot i (x right, y down)
const MACRO = {
  ak47: [[-4, 7], [4, 19], [-3, 29], [-1, 31], [13, 31], [8, 28], [13, 21], [-17, 12], [-42, -3], [-21, 2], [12, 11], [-15, 7],
    [-26, -8], [-3, 4], [40, 1], [19, 7], [14, 10], [27, 0], [33, -10], [-21, -2], [7, 3], [-7, 9], [-8, 4], [19, -3], [5, 6],
    [-20, -1], [-33, -4], [-45, -21], [-14, 1]],
  m4a4: [[2, 7], [0, 9], [-6, 16], [7, 21], [-9, 23], [-5, 27], [16, 15], [11, 13], [22, 5], [-4, 11], [-18, 6], [-30, -4],
    [-24, 0], [-25, -6], [0, 4], [8, 4], [-11, 1], [-13, -2], [2, 2], [33, -1], [10, 6], [27, 3], [10, 2], [11, 0], [-12, 0],
    [6, 5], [4, 5], [3, 1], [4, -1]],
  m4a1s: [[1, 6], [0, 4], [-4, 14], [4, 18], [-6, 21], [-4, 24], [14, 14], [8, 12], [18, 5], [-14, 5], [-25, -3], [-19, 0],
    [-22, -3], [1, 3], [8, 3], [-9, 1], [-13, -2], [3, 2], [1, 1]],
  famas: [[-4, 5], [1, 4], [-6, 10], [-1, 17], [0, 20], [14, 18], [16, 12], [-6, 12], [-20, 8], [-16, 5], [-13, 2], [4, 5],
    [23, 4], [12, 6], [20, -3], [5, 0], [15, 0], [3, 5], [-4, 3], [-25, -1], [-3, 2], [11, 0], [15, -7], [15, -10]],
  galil: [[4, 4], [-2, 5], [6, 10], [12, 15], [-1, 21], [2, 24], [6, 16], [11, 10], [-4, 14], [-22, 8], [-30, -3], [-29, -13],
    [-9, 8], [-12, 2], [-7, 1], [0, 1], [4, 7], [25, 7], [14, 4], [25, -3], [31, -9], [6, 3], [-12, 3], [13, -1], [10, -1],
    [16, -4], [-9, 5], [-32, -5], [-24, -3], [-15, 5], [6, 8], [-14, -3], [-24, -14], [-13, -1]],
  ump45: [[-1, 6], [-4, 8], [-2, 18], [-4, 23], [-9, 23], [-3, 26], [11, 17], [-4, 12], [9, 13], [18, 8], [15, 5], [-1, 3],
    [5, 6], [0, 6], [9, -3], [5, -1], [-12, 4], [-19, 1], [-1, -2], [15, -5], [17, -2], [-6, 3], [-20, -2], [-3, -1]],
  aug: [[5, 6], [0, 13], [-5, 22], [-7, 26], [5, 29], [9, 30], [14, 21], [6, 15], [14, 13], [-16, 11], [-5, 6], [13, 0],
    [1, 6], [-22, 5], [-38, -11], [-31, -13], [-3, 6], [-5, 5], [-9, 0], [24, 1], [32, 3], [15, 6], [-5, 1], [-17, -1],
    [-12, 2], [4, 3], [10, 1], [6, -1], [-3, 1]],
  sg553: [[-4, 9], [-13, 15], [-9, 25], [-6, 29], [-8, 31], [-7, 36], [-20, 14], [14, 17], [-8, 12], [-15, 8], [-5, 5],
    [6, 5], [-8, 6], [2, 11], [-14, -6], [-20, -17], [-18, -9], [-8, -2], [41, 3], [56, -5], [43, -1], [18, 9], [14, 9],
    [6, 7], [21, -3], [29, -4], [-6, 8], [-15, 5], [-38, -5]],
};

// ---- chart key points: [shotIndex, rightDeg, upDeg] of the BULLET on the wall
const KEYS = {
  mp9: [[0, 0, 0], [3, 0.3, 1.6], [6, 0.6, 3.6], [9, 0.4, 5.0], [12, 1.4, 5.6], [15, 2.6, 5.8], [18, 1.5, 6.1], [21, -0.8, 6.2],
    [24, -2.0, 6.3], [27, -0.8, 6.5], [29, 0.6, 6.4]],
  mac10: [[0, 0, 0], [3, 0.2, 1.4], [6, 0.8, 3.2], [9, 1.5, 4.4], [12, 2.4, 5.0], [15, 3.3, 5.4], [18, 3.0, 5.8], [21, 1.6, 6.0],
    [24, 0.8, 6.1], [27, 1.9, 6.3], [29, 2.6, 6.2]],
  mp7: [[0, 0, 0], [3, -0.2, 1.6], [6, -0.3, 3.6], [9, 0.2, 5.0], [12, -1.2, 5.5], [15, -2.2, 5.6], [18, -0.5, 5.9], [21, 1.6, 6.0],
    [24, 2.2, 6.1], [27, 0.6, 6.2], [29, -0.6, 6.3]],
  mp5sd: [[0, 0, 0], [3, 0.2, 1.3], [6, 0.1, 3.0], [9, -0.3, 4.3], [12, -1.3, 4.7], [15, -1.8, 4.9], [18, -0.4, 5.1], [21, 1.3, 5.2],
    [24, 1.7, 5.3], [27, 0.4, 5.4], [29, -0.5, 5.4]],
  p90: [[0, 0, 0], [4, 0.3, 2.2], [8, 0.7, 4.3], [12, 1.4, 5.6], [16, 2.4, 6.0], [20, 2.2, 6.3], [24, 0.3, 6.5], [28, -1.8, 6.6],
    [32, -2.4, 6.8], [36, -0.8, 6.9], [40, 1.2, 7.0], [44, 1.6, 7.1], [49, 0.2, 7.2]],
  cz75: [[0, 0, 0], [3, 0.2, 2.2], [6, -0.4, 4.0], [9, 0.6, 5.0], [11, 0.3, 5.4]],
  // CS:GO 2020 Negev: violent climb, then it settles into a flat laser line
  negev: [[0, 0, 0], [2, 0.2, 1.5], [5, 0.5, 4.2], [9, 0.3, 6.6], [13, -0.2, 7.4], [18, -0.6, 6.8], [25, 0.2, 6.0], [35, 0.7, 5.6],
    [50, -0.6, 5.4], [70, 0.6, 5.4], [90, -0.5, 5.3], [110, 0.5, 5.4], [130, -0.4, 5.3], [149, 0.3, 5.4]],
  m249: [[0, 0, 0], [4, 0.2, 2.6], [8, -0.3, 4.8], [12, 0.4, 6.0], [18, 1.8, 6.6], [25, 2.5, 7.0], [32, 0.5, 7.3], [40, -2.0, 7.5],
    [48, -2.4, 7.7], [56, -0.2, 7.8], [64, 2.0, 7.9], [72, 1.4, 8.0], [80, -1.2, 8.0], [90, -1.6, 8.1], [99, 0.4, 8.1]],
};

// ---- small deterministic PRNG (mulberry32) with reusable state (no closures per call) ----
export class Rand {
  constructor(seed = 1) { this.s = seed >>> 0; }
  seed(s) { this.s = s >>> 0; return this; }
  next() {
    let a = (this.s = (this.s + 0x6D2B79F5) | 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
}

export function hashKey(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---- punch dynamics (mirror of Player.decayPunch — keep in sync) -------------------------
const cvn = (name, def) => { const v = World.cvar?.[name]; return typeof v === 'number' ? v : def; };

/** One tick of CS:GO DecayAimPunchAngle on plain {pitch,yaw} objects (exactly Player.decayPunch). */
export function stepPunch(p, v, dt) {
  const exp = cvn('weapon_recoil_decay2_exp', 8), lin = cvn('weapon_recoil_decay2_lin', 18);
  const vd = cvn('weapon_recoil_vel_decay', 4.5);
  if (p.pitch || p.yaw || p.roll) {
    const k = Math.exp(-exp * dt);
    p.pitch *= k; p.yaw *= k; if (p.roll) p.roll *= k;
    const l = lin * dt;
    const mag = Math.hypot(p.pitch, p.yaw, p.roll || 0);
    if (mag > l && mag > 1e-5) { const s = 1 - l / mag; p.pitch *= s; p.yaw *= s; if (p.roll) p.roll *= s; }
    else { p.pitch = 0; p.yaw = 0; if (p.roll) p.roll = 0; }
  }
  if (v.pitch || v.yaw) {
    p.pitch += v.pitch * dt * 0.5; p.yaw += v.yaw * dt * 0.5;
    const k = Math.exp(-vd * dt);
    v.pitch *= k; v.yaw *= k;
    p.pitch += v.pitch * dt * 0.5; p.yaw += v.yaw * dt * 0.5;
    if (Math.abs(v.pitch) + Math.abs(v.yaw) < 1e-3) { v.pitch = 0; v.yaw = 0; }
  }
}

const _sp = { pitch: 0, yaw: 0, roll: 0 }, _sv = { pitch: 0, yaw: 0 };
function simulate(p0, v0, dvP, dvY, k, dt) {
  _sp.pitch = p0.pitch; _sp.yaw = p0.yaw; _sp.roll = 0;
  _sv.pitch = v0.pitch + dvP; _sv.yaw = v0.yaw + dvY;
  for (let i = 0; i < k; i++) stepPunch(_sp, _sv, dt);
  return _sp;
}

/**
 * Velocity impulse that brings the aim punch from (p, v) to `target` after `k` ticks of
 * decay. Writes {pitch, yaw} into out. Newton iterations on a nearly-affine map.
 */
export function solveKick(p, v, targetP, targetY, k, dt, out) {
  if (k < 1) k = 1;
  // initial guess from the linear gain (ignores the linear-decay dead zone)
  const exp = cvn('weapon_recoil_decay2_exp', 8), vd = cvn('weapon_recoil_vel_decay', 4.5);
  let g = 0;
  for (let j = 1; j <= k; j++) g += dt * 0.5 * (Math.exp(-vd * (j - 1) * dt) + Math.exp(-vd * j * dt)) * Math.exp(-exp * (k - j) * dt);
  let r = simulate(p, v, 0, 0, k, dt);
  let dP = (targetP - r.pitch) / g, dY = (targetY - r.yaw) / g;
  // Newton with a finite-difference Jacobian (the dead zone makes the fixed gain slow)
  for (let it = 0; it < 8; it++) {
    r = simulate(p, v, dP, dY, k, dt);
    const fP = r.pitch, fY = r.yaw;
    const eP = targetP - fP, eY = targetY - fY;
    if (Math.abs(eP) + Math.abs(eY) < 2e-4) break;
    const h = 0.5;
    r = simulate(p, v, dP + h, dY, k, dt); const a11 = (r.pitch - fP) / h, a21 = (r.yaw - fY) / h;
    r = simulate(p, v, dP, dY + h, k, dt); const a12 = (r.pitch - fP) / h, a22 = (r.yaw - fY) / h;
    const det = a11 * a22 - a12 * a21;
    if (Math.abs(det) < 1e-12) { dP += eP / g; dY += eY / g; continue; }
    dP += (a22 * eP - a12 * eY) / det;
    dY += (-a21 * eP + a11 * eY) / det;
  }
  out.pitch = dP; out.yaw = dY;
  return out;
}

// ---- table construction ---------------------------------------------------------------
function fromMacro(deltas) {
  const out = [[0, 0]];
  let cx = 0, cy = 0;
  for (const [dx, dy] of deltas) {
    cx += dx; cy += dy;
    // compensation moves the view by (right cx, down cy) => the bullet sat (left cx, up cy)
    out.push([cx * K_PUNCH, -cy * K_PUNCH]);
  }
  return out;
}

function fromKeys(keys, n) {
  const out = [];
  const last = keys[keys.length - 1][0];
  for (let i = 0; i < Math.max(n, last + 1); i++) {
    let s = 0;
    while (s < keys.length - 2 && keys[s + 1][0] < i) s++;
    const p0 = keys[Math.max(0, s - 1)], p1 = keys[s], p2 = keys[Math.min(keys.length - 1, s + 1)], p3 = keys[Math.min(keys.length - 1, s + 2)];
    const span = Math.max(1e-6, p2[0] - p1[0]);
    const t = Math.min(1, Math.max(0, (i - p1[0]) / span));
    const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    const x = i > last ? keys[keys.length - 1][1] : cr(p0[1], p1[1], p2[1], p3[1]);
    const y = i > last ? keys[keys.length - 1][2] : cr(p0[2], p1[2], p2[2], p3[2]);
    // bullet right x / up y (deg)  ->  punch yaw (left +) / pitch (down +)
    out.push([-x / 2, -y / 2]);
  }
  return out;
}

/**
 * CS:GO GenerateRecoilTable + punch dynamics: what the engine itself would produce.
 * The table carries .kicks = [[angleDeg, magnitude]] per shot index; weapons built this way
 * (pistols, shotguns, snipers) kick directly like CS:GO instead of using the pattern solver,
 * so a slow AWP still slams the view even though its punch has recovered by the next shot.
 */
function fromSim(def, key, n) {
  const rnd = new Rand(def.recoilSeed ?? hashKey(key));
  const dt = 1 / 128;
  const p = { pitch: 0, yaw: 0, roll: 0 }, v = { pitch: 0, yaw: 0 };
  const out = [[0, 0]];
  const kicks = [];
  const cyc = def.cycleTime || 0.1;
  const full = def.fireMode === 'auto';
  const variance = def.recoilAngleVariance ?? 20, magBase = def.recoilMagnitude ?? 20;
  let angle = 0, mag = magBase, carry = 0;
  for (let j = 0; j < n; j++) {
    const aNew = rnd.range(-variance, variance) * 0.35, mNew = magBase * rnd.range(0.92, 1.08);
    if (full && j > 0) { angle += (aNew - angle) * 0.5; mag += (mNew - mag) * 0.5; } else { angle = aNew; mag = mNew; }
    const supN = 4, supF = 0.75;
    const sup = j < supN ? supF + (1 - supF) * (j / supN) : 1;
    kicks.push([angle, mag * sup]);
    if (j === n - 1) break;
    const a = angle * Math.PI / 180;
    v.pitch += -Math.cos(a) * mag * sup;
    v.yaw += -Math.sin(a) * mag * sup;
    carry += cyc / dt;
    const k = Math.floor(carry + 1e-6); carry -= k;
    for (let t = 0; t < k; t++) stepPunch(p, v, dt);
    out.push([p.yaw, p.pitch]);
  }
  out.kicks = kicks;
  return out;
}

/** Continue a pattern past its data with a gentle seeded wander around the last point. */
function extend(tab, n, key) {
  if (tab.length >= n) return tab;
  const rnd = new Rand(hashKey(key) ^ 0x51ED);
  const [y0, p0] = tab[tab.length - 1];
  let phase = rnd.next() * 6.28;
  for (let i = tab.length; i < n; i++) {
    phase += 0.35 + rnd.next() * 0.1;
    tab.push([y0 + Math.sin(phase) * 0.35, p0 - (i - tab.length) * 0.0 + Math.cos(phase * 0.7) * 0.08]);
  }
  return tab;
}

const cache = new Map();

/** Cumulative aim punch [yawDeg, pitchDeg] at each shot index of a full-auto spray. */
export function recoilTable(key) {
  let t = cache.get(key);
  if (t) return t;
  const def = WEAPONS[key];
  const n = Math.max(2, def?.mag || 30);
  if (MACRO[key]) t = fromMacro(MACRO[key]);
  else if (KEYS[key]) t = fromKeys(KEYS[key], n);
  else if (def && def.recoilMagnitude > 0) t = fromSim(def, key, n);
  else t = [[0, 0], [0, 0]];
  const kicks = t.kicks;
  t = extend(t, n, key);
  if (kicks) t.kicks = kicks;
  // cumulative max magnitude, used to re-sync the recoil index with a decayed punch
  t.maxMag = new Float32Array(t.length);
  let m = 0;
  for (let i = 0; i < t.length; i++) { m = Math.max(m, Math.hypot(t[i][0], t[i][1])); t.maxMag[i] = m; }
  cache.set(key, t);
  return t;
}

/** Interpolated table sample at a fractional index (clamped). Writes {pitch,yaw}. */
export function sampleTable(tab, idx, out) {
  const s = (World.cvar?.weapon_recoil_pattern_scale ?? 1);
  const n = tab.length;
  if (idx <= 0) { out.yaw = tab[0][0] * s; out.pitch = tab[0][1] * s; return out; }
  if (idx >= n - 1) { out.yaw = tab[n - 1][0] * s; out.pitch = tab[n - 1][1] * s; return out; }
  const i = Math.floor(idx), f = idx - i;
  out.yaw = (tab[i][0] + (tab[i + 1][0] - tab[i][0]) * f) * s;
  out.pitch = (tab[i][1] + (tab[i + 1][1] - tab[i][1]) * f) * s;
  return out;
}

/** Largest recoil index whose pattern magnitude is still <= mag (keeps taps honest). */
export function indexForMagnitude(tab, mag) {
  const s = (World.cvar?.weapon_recoil_pattern_scale ?? 1) || 1;
  const m = tab.maxMag, target = mag / s;
  if (!m || target >= m[m.length - 1]) return m ? m.length - 1 : 0;
  let lo = 0, hi = m.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m[mid] <= target) lo = mid; else hi = mid; }
  const span = m[hi] - m[lo];
  return lo + (span > 1e-6 ? Math.min(1, Math.max(0, (target - m[lo]) / span)) : 0);
}

export const PATTERN_SOURCES = { measured: Object.keys(MACRO), charted: Object.keys(KEYS) };
