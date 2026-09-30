// Listener-environment reverb: three convolvers (open desert slap, stone room, tunnel)
// crossfaded by weights that come from callout zones when the map names them, otherwise
// from a cheap ray probe of the listener's surroundings (ceiling height + wall distances).
import * as THREE from 'three';
import { World } from '../core/world.js';
import { MASK_VISIBLE } from '../player/collision.js';

export const ENVS = ['open', 'room', 'tunnel'];
// IRs are energy-normalised; these set how wet each space is (open desert is mostly dry)
const ENV_GAIN = { open: 0.55, room: 0.95, tunnel: 1.15 };
// callout name -> reverb weights (names from src/map/dust2.js CALLOUTS; others fall back to the ray probe)
const ZONE_RULES = [
  [(n) => /tunnel/i.test(n) && !/outside|exit/i.test(n), { tunnel: 1 }],
  [(n) => /^(long_doors|mid_doors|b_doors|under_a)$/i.test(n) || /hall|corridor|underpass|closet/i.test(n), { room: 0.8, open: 0.2 }],
];
const DIRS = [];
for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; DIRS.push(new THREE.Vector3(Math.cos(a), 0.08, Math.sin(a)).normalize()); }
const _end = new THREE.Vector3(), _p = new THREE.Vector3();
const _w = { open: 0, room: 0, tunnel: 0 };
const setW = (o, r, t) => { _w.open = o; _w.room = r; _w.tunnel = t; return _w; };

export class ReverbEnv {
  constructor(ctx, input, output) {
    this.ctx = ctx;
    this.input = input;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 140;
    input.connect(this.hp);
    this.conv = {}; this.gain = {};
    this.w = { open: 1, room: 0, tunnel: 0 };      // smoothed weights
    this.target = { open: 1, room: 0, tunnel: 0 };
    for (const e of ENVS) {
      const c = ctx.createConvolver(); c.normalize = false;
      const g = ctx.createGain(); g.gain.value = e === 'open' ? ENV_GAIN.open : 0;
      this.hp.connect(c); c.connect(g); g.connect(output);
      this.conv[e] = c; this.gain[e] = g;
    }
    this.probe = { i: 0, hits: new Float32Array(9), t: 0 };
    this.enclosure = 0;   // 0 open sky .. 1 covered (drives wind level)
    this.zone = null;
  }

  setIR(env, buffer) { try { this.conv[env].buffer = buffer; } catch (err) { console.error('[audio] IR', err); } }

  _zoneWeights(pos) {
    const zones = World.map?.callouts;
    if (!zones) return null;
    for (const name in zones) {
      const z = zones[name];
      if (!z?.min || !z?.max) continue;
      if (pos.x < z.min.x || pos.x > z.max.x || pos.y < z.min.y - 8 || pos.y > z.max.y || pos.z < z.min.z || pos.z > z.max.z) continue;
      const label = z.name || name;
      for (const [test, w] of ZONE_RULES) if (test(label)) { this.zone = label; return w; }
    }
    this.zone = null;
    return null;
  }

  /** Spread 9 rays over frames: 8 horizontal + 1 up. */
  _probeStep(pos) {
    const col = World.collision;
    if (!col?.rayTrace) return;
    const P = this.probe;
    const i = P.i;
    if (i < 8) { _end.copy(DIRS[i]).multiplyScalar(1400).add(pos); }
    else { _end.copy(pos); _end.y += 700; }
    try {
      const tr = col.rayTrace(pos, _end, MASK_VISIBLE);
      P.hits[i] = tr.fraction < 1 && !tr.startSolid ? tr.fraction * (i < 8 ? 1400 : 700) : Infinity;
    } catch { P.hits[i] = Infinity; }
    P.i = (i + 1) % 9;
  }

  _probeWeights() {
    const h = this.probe.hits;
    let open = 0, sum = 0, n = 0;
    for (let i = 0; i < 8; i++) { if (h[i] === Infinity) open++; else { sum += h[i]; n++; } }
    const mean = n ? sum / n : 1400;
    const ceiling = h[8] < 700;
    const openFrac = open / 8;
    const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    if (ceiling) {
      this.enclosure = 1;
      const narrow = ss(420, 140, mean) * (1 - openFrac * 0.8);
      return setW((1 - narrow) * 0.1, (1 - narrow) * 0.9, narrow);
    }
    const walls = (1 - openFrac) * ss(900, 220, mean);
    this.enclosure = walls * 0.4;
    return setW(1 - walls * 0.55, walls * 0.55, 0);
  }

  update(dt, pos) {
    _p.copy(pos);
    // three probe rays per frame -> full picture every 3 frames
    for (let k = 0; k < 3; k++) this._probeStep(_p);
    const zw = this._zoneWeights(_p);
    const w = zw ? setW(zw.open || 0, zw.room || 0, zw.tunnel || 0) : this._probeWeights();
    if (zw) this.enclosure = zw.tunnel ? 1 : (zw.room || 0);
    // normalise to equal power
    const tot = Math.sqrt(w.open * w.open + w.room * w.room + w.tunnel * w.tunnel) || 1;
    const k = 1 - Math.exp(-dt / 0.35);
    const t = this.ctx.currentTime;
    for (const e of ENVS) {
      this.w[e] += (w[e] / tot - this.w[e]) * k;
      this.gain[e].gain.setTargetAtTime(this.w[e] * ENV_GAIN[e], t, 0.05);
    }
  }

  dominant() { let best = 'open'; for (const e of ENVS) if (this.w[e] > this.w[best]) best = e; return best; }
}
