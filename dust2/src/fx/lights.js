// Fixed pool of point lights for flashes / explosions / fire. Lights are always in the scene
// (so shader light counts never change -> no recompiles); idle lights sit at intensity 0.
import * as THREE from 'three';

export class LightPool {
  constructor(scene, count = 3) {
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 400, 2);
      l.castShadow = false;
      l.userData.fx = true;
      l.name = `fx-light-${i}`;
      scene?.add(l);
      this.slots.push({ light: l, t0: 0, dur: 0, peak: 0, prio: -1, flicker: 0, attack: 0, hold: 0, color: new THREE.Color(), seed: i * 7.1, owner: null, active: false });
    }
  }

  /**
   * Claim a light. intensity is candela-ish (three physical units: irradiance = I / d^2).
   * Steals the lowest-priority / most-finished slot when all are busy.
   */
  spawn(now, pos, color, intensity, radius, dur, { prio = 1, flicker = 0, attack = 0.0, hold = 0, owner = null } = {}) {
    let best = null, bestScore = Infinity;
    for (const s of this.slots) {
      const remaining = s.active ? Math.max(0, s.t0 + s.dur - now) / Math.max(s.dur, 1e-3) : -1;
      const score = s.active ? s.prio * 10 + remaining : -1;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    if (best.active && best.prio > prio) return null;
    best.active = true; best.t0 = now; best.dur = dur; best.peak = intensity; best.prio = prio;
    best.flicker = flicker; best.attack = attack; best.hold = hold; best.owner = owner;
    best.color.set(color);
    best.light.position.copy(pos);
    best.light.distance = radius;
    best.light.color.copy(best.color);
    return best;
  }

  release(owner) {
    for (const s of this.slots) if (s.owner === owner) { s.active = false; s.light.intensity = 0; s.owner = null; }
  }

  update(now) {
    for (const s of this.slots) {
      if (!s.active) { s.light.intensity = 0; continue; }
      const t = now - s.t0;
      if (t >= s.dur) { s.active = false; s.light.intensity = 0; s.owner = null; continue; }
      let k;
      if (t < s.attack) k = t / s.attack;
      else if (t < s.attack + s.hold) k = 1;
      else { const u = (t - s.attack - s.hold) / Math.max(1e-3, s.dur - s.attack - s.hold); k = (1 - u) * (1 - u); }
      if (s.flicker > 0) {
        const f = 0.55 * Math.sin(now * 23 + s.seed) + 0.3 * Math.sin(now * 41.7 + s.seed * 2.3) + 0.15 * Math.sin(now * 71.3);
        k *= 1 - s.flicker * (0.5 + 0.5 * f);
      }
      s.light.intensity = s.peak * k;
    }
  }

  clear() { for (const s of this.slots) { s.active = false; s.light.intensity = 0; s.owner = null; } }
}
