// Angle + vector helpers. Source conventions on Three.js Y-up axes (CONTRACT.md §1).
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/** yaw 0 looks down -Z, increases CCW from above. pitch positive looks DOWN. */
export function angleVectors(pitch, yaw, out = {
  forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
}) {
  const p = pitch * DEG, y = yaw * DEG;
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  out.forward.set(-sy * cp, -sp, -cy * cp);
  out.right.set(cy, 0, -sy);
  out.up.crossVectors(out.right, out.forward).normalize();
  return out;
}

/** Horizontal-only forward/right (for movement). */
export function flatVectors(yaw, fwd, right) {
  const y = yaw * DEG;
  fwd.set(-Math.sin(y), 0, -Math.cos(y));
  right.set(Math.cos(y), 0, -Math.sin(y));
}

export function applyViewAngles(obj, pitch, yaw, roll = 0) {
  _e.set(-pitch * DEG, yaw * DEG, roll * DEG, 'YXZ');
  obj.quaternion.setFromEuler(_e);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const approach = (cur, target, delta) => (cur < target ? Math.min(cur + delta, target) : Math.max(cur - delta, target));
export function angleNormalize(a) { a %= 360; if (a > 180) a -= 360; if (a < -180) a += 360; return a; }
export function angleDiff(a, b) { return angleNormalize(a - b); }

/** Frame-rate independent exponential smoothing factor. */
export const damp = (lambda, dt) => 1 - Math.exp(-lambda * dt);

/** Deterministic PRNG (mulberry32). Same seed -> same sequence on every client. */
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

/** Pool of scratch vectors for hot paths. Call .reset() at frame start if you use .get(). */
export class VecPool {
  constructor(n = 64) { this.v = Array.from({ length: n }, () => new THREE.Vector3()); this.i = 0; }
  get() { const v = this.v[this.i++ % this.v.length]; return v.set(0, 0, 0); }
  reset() { this.i = 0; }
}
