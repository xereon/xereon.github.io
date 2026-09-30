// Runtime ambience: the desert wind bed (thinned + darkened indoors), random distant birds and
// far rattles placed around the listener, and looping spatial emitters (power box hum, tarp).
import * as THREE from 'three';
import { World } from '../core/world.js';
import { MASK_VISIBLE } from '../player/collision.js';

const _p = new THREE.Vector3();

// Fallback emitters when the map doesn't list `soundEmitters`: [sound, callout zone]. Each is
// placed against the nearest wall inside that zone (found with a few rays), or skipped.
const ANCHORS = [['amb_powerbox', 'ct_spawn'], ['amb_powerbox', 'b_plat'], ['amb_tarp', 'long'], ['amb_tarp', 'a_site'], ['amb_tarp', 'top_mid']];
const _c = new THREE.Vector3(), _e = new THREE.Vector3();

export class Ambient {
  constructor(audio) {
    this.a = audio;
    this.wind = null;
    this.nextBird = 4 + Math.random() * 6;
    this.nextRattle = 9 + Math.random() * 10;
    this.emitters = null;
    this.emitTimer = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const a = this.a, ctx = a.ctx;
    this.windLP = ctx.createBiquadFilter(); this.windLP.type = 'lowpass'; this.windLP.frequency.value = 18000;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.windLP.connect(this.windGain).connect(a.mixer.bus.ambience);
    this._tryWind();
  }

  _tryWind() {
    const a = this.a;
    if (this.wind || !a.bank.need('amb_wind')) return;
    const buf = a.bank.pick('amb_wind');
    const src = a.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(this.windLP);
    src.start(a.ctx.currentTime, Math.random() * buf.duration);
    this.wind = src;
    this.windGain.gain.setTargetAtTime(a.profileGain('amb_wind'), a.ctx.currentTime, 1.5);
  }

  _buildEmitters() {
    const list = [];
    const src = World.map?.soundEmitters;
    if (Array.isArray(src)) {
      for (const e of src) if (e?.pos && e.type) list.push({ type: e.type.startsWith('amb_') ? e.type : `amb_${e.type}`, pos: e.pos.clone ? e.pos.clone() : new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z) });
    } else if (World.collision?.rayTrace && World.map?.callouts) {
      for (const [type, zone] of ANCHORS) {
        const z = World.map.callouts[zone];
        if (!z?.min || !z?.max) continue;
        try {
          _c.addVectors(z.min, z.max).multiplyScalar(0.5); _c.y = z.min.y + 72;
          if (World.collision.pointContents?.(_c)) continue;
          let best = Infinity, bx = 0, bz = 0;
          for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4, dx = Math.cos(a), dz = Math.sin(a);
            _e.set(_c.x + dx * 700, _c.y, _c.z + dz * 700);
            const tr = World.collision.rayTrace(_c, _e, MASK_VISIBLE);
            if (tr.fraction < 1 && !tr.startSolid && tr.fraction * 700 < best) { best = tr.fraction * 700; bx = dx; bz = dz; }
          }
          if (best < 700) list.push({ type, pos: new THREE.Vector3(_c.x + bx * (best - 18), _c.y, _c.z + bz * (best - 18)) });
        } catch {}
      }
    }
    this.emitters = list.map((e) => ({ ...e, handle: null }));
  }

  update(dt, listener) {
    if (!this.started) return;
    const a = this.a;
    if (!this.wind) this._tryWind();
    // wind follows how enclosed the listener is
    const enc = a.reverb ? a.reverb.enclosure : 0;
    const t = a.ctx.currentTime;
    if (this.wind) {
      this.windLP.frequency.setTargetAtTime(18000 * Math.pow(500 / 18000, enc), t, 0.6);
      this.windGain.gain.setTargetAtTime(a.profileGain('amb_wind') * (1 - 0.6 * enc), t, 0.6);
    }
    // one-shots around the listener
    this.nextBird -= dt; this.nextRattle -= dt;
    if (this.nextBird <= 0) {
      this.nextBird = 7 + Math.random() * 14;
      if (enc < 0.8) this._around('amb_bird', listener, 1500, 3200, 500, 1100);
    }
    if (this.nextRattle <= 0) {
      this.nextRattle = 12 + Math.random() * 18;
      this._around('amb_rattle', listener, 1200, 2600, 50, 300);
    }
    // looping emitters: virtual until in range
    this.emitTimer -= dt;
    if (this.emitTimer <= 0 && World.map) {
      this.emitTimer = 0.5;
      if (!this.emitters) this._buildEmitters();
      for (const e of this.emitters) {
        const d = e.pos.distanceTo(listener);
        const max = a.profileOf(e.type).max;
        if (d < max && !e.handle?.active) e.handle = a.startLoop(e.type, e.pos, { fadeIn: 1.0, random: true });
        else if (d > max * 1.15 && e.handle?.active) { e.handle.stop(0.6); e.handle = null; }
      }
    }
  }

  _around(name, listener, rMin, rMax, hMin, hMax) {
    const ang = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
    _p.set(listener.x + Math.cos(ang) * r, listener.y + hMin + Math.random() * (hMax - hMin), listener.z + Math.sin(ang) * r);
    this.a.playAt(name, _p, { occlude: false, volume: 0.6 + Math.random() * 0.4, pitch: 0.92 + Math.random() * 0.16 });
  }

  stop() {
    try { this.wind?.stop(); } catch {}
    this.wind = null;
    for (const e of this.emitters || []) e.handle?.stop(0.2);
    this.emitters = null;
    this.started = false;
  }
}
