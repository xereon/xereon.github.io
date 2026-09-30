// Ray-traced occlusion: fraction of (direct + two offset) rays from listener to source that
// hit solid world (MASK_VISIBLE). Cached per key, with a per-frame ray budget.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { MASK_VISIBLE } from '../player/collision.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _side = new THREE.Vector3(), _dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Occlusion {
  constructor() {
    this.cache = new Map();   // key -> { t, v }
    this.rays = 0;            // rays spent this frame
    this.budget = 24;         // rays per frame
    this.ttl = 0.12;          // seconds a cached value stays fresh
    this.now = 0;
  }
  beginFrame(now) { this.rays = 0; this.now = now; if (this.cache.size > 256) this.cache.clear(); }

  _blocked(from, to) {
    const col = World.collision;
    if (!col?.rayTrace) return false;
    this.rays++;
    const tr = col.rayTrace(from, to, MASK_VISIBLE);
    return !!tr && (tr.fraction < 0.999 || tr.startSolid) && !tr.allSolid;
  }

  /**
   * 0 = clear line of sight, 1 = fully blocked. `key` caches the result (entity or voice id);
   * `quality` 1 = direct ray only, 3 = direct + offsets (smoother around corners).
   */
  query(listener, src, key = null, quality = 3) {
    if (!World.collision?.rayTrace) return 0;
    if (key != null) {
      const c = this.cache.get(key);
      if (c && (this.now - c.t < this.ttl || this.rays >= this.budget)) return c.v;
    }
    if (this.rays >= this.budget && key == null) quality = 1;
    let v = 0;
    // pull the source a few units toward the listener so points ON a surface don't self-occlude
    _dir.subVectors(listener, src);
    const len = _dir.length();
    _c.copy(src);
    if (len > 8) _c.addScaledVector(_dir, 6 / len);
    src = _c;
    try {
      if (!this._blocked(listener, src)) v = 0;
      else if (quality < 3 || this.rays + 2 > this.budget * 1.5) v = 1;
      else {
        // two offset rays: raised source (over low cover) and a lateral offset (around corners)
        _dir.subVectors(src, listener); _dir.y = 0;
        if (_dir.lengthSq() < 1e-4) _dir.set(1, 0, 0);
        _side.crossVectors(_dir.normalize(), UP).multiplyScalar(44);
        let hits = 1;
        _b.copy(src); _b.y += 40;
        if (this._blocked(listener, _b)) hits++;
        _b.copy(src).add(_side);
        _a.copy(listener).sub(_side);
        if (this._blocked(_a, _b)) hits++;
        v = hits === 1 ? 0.45 : hits === 2 ? 0.75 : 1;
      }
    } catch { v = 0; }
    if (key != null) {
      const c = this.cache.get(key);
      if (c) { c.t = this.now; c.v = v; } else this.cache.set(key, { t: this.now, v });
    }
    return v;
  }
}
