// CS-style rotating radar. The map image is rasterised once from MapData.walkable (triangle
// soup, height-shaded); if the map ships no walkable soup we fall back to a heightfield
// sampled with collision rays. Per frame we blit it rotated/zoomed around the local player
// and draw player dots, death marks, the bomb and site labels on top (always upright).
import * as THREE from 'three';
import { World } from '../core/world.js';
import { Settings } from './settings.js';

const DEG = Math.PI / 180;
const TEAM_COLORS = ['#f2c14e', '#a77dff', '#4fd67a', '#4aa8ff', '#ff8a3d'];
export const teammateColor = (i) => TEAM_COLORS[i % TEAM_COLORS.length];

export class Radar {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'radar';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    parent.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d');
    this.img = null;          // pre-rendered map
    this.bounds = null;       // { x0, z0, w, h }
    this.built = false;
    this.size = 0;
    this.sites = [];
  }

  resize(px) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const s = Math.round(px);
    if (s === this.size) return;
    this.size = s;
    this.canvas.width = this.canvas.height = Math.round(s * dpr);
    this.canvas.style.width = this.canvas.style.height = s + 'px';
    this.dpr = dpr;
  }

  build() {
    const map = World.map;
    if (!map) return false;
    this.built = true;
    this.sites = [];
    for (const k of ['A', 'B']) {
      const z = map.bombsites?.[k];
      if (z) this.sites.push({ name: k, x: (z.min.x + z.max.x) / 2, z: (z.min.z + z.max.z) / 2 });
    }
    const tris = map.walkable;
    const nav = World.nav;
    try {
      if (nav?.count > 200 && nav.px) this._fromNav(nav);
      else if (tris && tris.length >= 9) this._fromTriangles(tris);
      else this._fromRays(map);
    } catch (e) {
      console.warn('[radar] build failed', e);
      this.img = null;
    }
    return true;
  }

  _canvasFor(x0, z0, w, h) {
    const maxPx = 1400;
    const s = maxPx / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.ceil(w * s));
    c.height = Math.max(2, Math.ceil(h * s));
    this.bounds = { x0, z0, w, h, s };
    this.img = c;
    return c.getContext('2d');
  }

  _heightColor(t, a = 1) {
    // low areas cool/dark, high areas warm/light (reads like a CS overview)
    const r = Math.round(104 + t * 104), g = Math.round(108 + t * 98), b = Math.round(114 + t * 82);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** Bot nav grid (World.nav: 24u columns, one node per standable floor) -> overview. */
  _fromNav(nav) {
    const n = nav.count, X = nav.px, Y = nav.py, Z = nav.pz;
    const cell = nav.cell || 24;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i];
      if (Z[i] < z0) z0 = Z[i]; if (Z[i] > z1) z1 = Z[i];
      if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i];
    }
    const pad = 96;
    x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
    const ctx = this._canvasFor(x0, z0, x1 - x0, z1 - z0);
    const s = this.bounds.s;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Y[a] - Y[b]);
    const dy = Math.max(1, y1 - y0);
    // nodes sit 16u off the walls: grow each spot so the floor reaches the wall line. Round
    // stamps (not squares) keep diagonal walls from reading as stair steps.
    const r = (cell * 0.5 + 12) * s;
    const re = r + 16 * s;
    const TAU = Math.PI * 2;
    ctx.fillStyle = 'rgba(236,238,240,0.95)';
    for (const i of order) { ctx.beginPath(); ctx.arc((X[i] - x0) * s, (Z[i] - z0) * s, re, 0, TAU); ctx.fill(); }
    ctx.fillStyle = 'rgba(20,22,26,0.9)';
    for (const i of order) { ctx.beginPath(); ctx.arc((X[i] - x0) * s, (Z[i] - z0) * s, r + 7 * s, 0, TAU); ctx.fill(); }
    for (const i of order) {
      ctx.fillStyle = this._heightColor((Y[i] - y0) / dy);
      ctx.beginPath(); ctx.arc((X[i] - x0) * s, (Z[i] - z0) * s, r, 0, TAU); ctx.fill();
    }
  }

  _fromTriangles(t) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < t.length; i += 3) {
      const x = t[i], y = t[i + 1], z = t[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const pad = 64;
    x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
    const ctx = this._canvasFor(x0, z0, x1 - x0, z1 - z0);
    const s = this.bounds.s;
    const n = t.length / 9;
    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const hy = (i) => (t[i * 9 + 1] + t[i * 9 + 4] + t[i * 9 + 7]) / 3;
    order.sort((a, b) => hy(a) - hy(b));
    const dy = Math.max(1, y1 - y0);
    const path = (i) => {
      const o = i * 9;
      ctx.beginPath();
      ctx.moveTo((t[o] - x0) * s, (t[o + 2] - z0) * s);
      ctx.lineTo((t[o + 3] - x0) * s, (t[o + 5] - z0) * s);
      ctx.lineTo((t[o + 6] - x0) * s, (t[o + 8] - z0) * s);
      ctx.closePath();
    };
    // 1) outline band: every triangle stroked wide in a light edge colour
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(214,218,222,0.9)';
    ctx.lineWidth = Math.max(3, 10 * s);
    for (const i of order) { path(i); ctx.stroke(); }
    // 2) fills, low -> high, with a hairline stroke in the same colour to hide seams
    ctx.lineWidth = 1;
    for (const i of order) {
      const c = this._heightColor((hy(i) - y0) / dy);
      ctx.fillStyle = c; ctx.strokeStyle = c;
      path(i); ctx.fill(); ctx.stroke();
    }
  }

  _fromRays(map) {
    const col = map.collision || World.collision;
    if (!col?.rayTrace) return;
    const box = new THREE.Box3().setFromObject(map.root);
    if (box.isEmpty()) return;
    const x0 = box.min.x, z0 = box.min.z, w = box.max.x - x0, h = box.max.z - z0;
    const step = Math.max(16, Math.max(w, h) / 220);
    const nx = Math.ceil(w / step), nz = Math.ceil(h / step);
    // walkable band: around spawn heights (keeps roofs out of the overview)
    let sy0 = Infinity, sy1 = -Infinity;
    for (const team of ['T', 'CT']) for (const s of map.spawns?.[team] || []) { sy0 = Math.min(sy0, s.pos.y); sy1 = Math.max(sy1, s.pos.y); }
    if (!Number.isFinite(sy0)) { sy0 = box.min.y; sy1 = box.min.y; }
    const lo = sy0 - 400, hi = sy1 + 260;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const hgt = new Float32Array(nx * nz).fill(NaN);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * step, z = z0 + (j + 0.5) * step;
        a.set(x, box.max.y + 16, z); b.set(x, box.min.y - 16, z);
        const tr = col.rayTrace(a, b, 1);
        if (tr.fraction < 1 && tr.normal.y > 0.7 && tr.endpos.y >= lo && tr.endpos.y <= hi) hgt[j * nx + i] = tr.endpos.y;
      }
    }
    const ctx = this._canvasFor(x0, z0, w, h);
    const s = this.bounds.s, cs = step * s;
    const dy = Math.max(1, hi - lo);
    ctx.fillStyle = 'rgba(214,218,222,0.9)';
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (Number.isNaN(hgt[j * nx + i])) continue;
      ctx.fillRect(i * cs - cs * 0.5, j * cs - cs * 0.5, cs * 2, cs * 2);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const y = hgt[j * nx + i];
      if (Number.isNaN(y)) continue;
      ctx.fillStyle = this._heightColor((y - lo) / dy);
      ctx.fillRect(i * cs, j * cs, cs + 0.6, cs + 0.6);
    }
  }

  /**
   * @param view { x, z, yaw, rotate }
   * @param blips array of { x, z, yaw, kind: 'self'|'mate'|'enemy'|'dead'|'deadenemy'|'bomb'|'bombplanted', color, carrier }
   */
  draw(view, blips, time) {
    if (!this.built && World.map) this.build();
    const ctx = this.ctx, S = this.size, dpr = this.dpr || 1;
    if (!S) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const r = S * 0.035;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, S, S, r) : ctx.rect(0, 0, S, S);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,10,12,0.62)';
    ctx.fillRect(0, 0, S, S);

    const span = 3300 * (Settings.radarScale || 0.8);
    const k = S / span;
    const phi = view.rotate ? (view.yaw - 90) * DEG : 0;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const half = S / 2;
    this._k = k; this._cos = cos; this._sin = sin; this._cx = view.x; this._cz = view.z; this._half = half;

    if (this.img && this.bounds) {
      const B = this.bounds;
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(phi);
      ctx.scale(k, k);
      ctx.translate(-view.x, -view.z);
      ctx.globalAlpha = 0.92;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.img, B.x0, B.z0, B.w, B.h);
      ctx.restore();
    }

    // site labels
    ctx.font = `800 ${Math.round(S * 0.085)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const site of this.sites) {
      const p = this._project(site.x, site.z);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(site.name, p[0] + 1, p[1] + 1.5);
      ctx.fillStyle = 'rgba(255,236,190,0.85)';
      ctx.fillText(site.name, p[0], p[1]);
    }

    const dot = S * 0.028;
    for (const b of blips) {
      const p = this._project(b.x, b.z);
      let [px, py] = p;
      const out = px < dot || py < dot || px > S - dot || py > S - dot;
      if (out) {
        if (b.kind !== 'mate' && b.kind !== 'bombplanted') continue;
        px = Math.min(S - dot, Math.max(dot, px)); py = Math.min(S - dot, Math.max(dot, py));
      }
      switch (b.kind) {
        case 'dead': case 'deadenemy': this._x(px, py, dot * 0.8, b.color); break;
        case 'bomb': this._bomb(px, py, dot * 1.1, '#e8c86a', false, time); break;
        case 'bombplanted': this._bomb(px, py, dot * 1.2, '#ff4040', true, time); break;
        case 'enemy': this._dot(px, py, dot, '#ff3b30', null, 0, false); break;
        case 'mate': this._dot(px, py, dot, b.color, b.yaw, phi, false, b.carrier, b.label); break;
        case 'self': this._dot(px, py, dot * 1.12, '#ffffff', view.rotate ? 90 : b.yaw, view.rotate ? 0 : 0, true, b.carrier); break;
      }
    }
    ctx.restore();
  }

  _project(x, z) {
    const dx = (x - this._cx) * this._k, dz = (z - this._cz) * this._k;
    const out = this._p || (this._p = [0, 0]);
    out[0] = dx * this._cos - dz * this._sin + this._half;
    out[1] = dx * this._sin + dz * this._cos + this._half;
    return out;
  }

  _dot(x, y, r, color, yaw, phi, self, carrier, label) {
    const ctx = this.ctx;
    if (yaw != null) {
      // view wedge: world yaw -> radar angle (yaw 0 = +X = east)
      const a = -yaw * DEG + phi;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(r * 2.1, 0); ctx.lineTo(r * 0.55, -r * 0.95); ctx.lineTo(r * 0.55, r * 0.95); ctx.closePath();
      ctx.fillStyle = self ? 'rgba(255,255,255,0.95)' : color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1.2;
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.3); ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
    if (carrier) {
      ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = '#b21e1e'; ctx.fill();
    }
    if (label) {
      ctx.font = `800 ${Math.round(r * 1.2)}px ${FONT}`;
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 0.5);
    }
  }

  _x(x, y, r, color) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = r * 0.75;
    ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = r * 0.42;
    ctx.stroke();
  }

  _bomb(x, y, r, color, planted, time) {
    const ctx = this.ctx;
    const pulse = planted ? 0.55 + 0.45 * Math.abs(Math.sin(time * 4)) : 1;
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - r - 1, y - r * 0.7 - 1, r * 2 + 2, r * 1.4 + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x - r, y - r * 0.7, r * 2, r * 1.4);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - r * 0.7, y - r * 0.4, r * 0.8, r * 0.8);
    ctx.restore();
  }
}

export const FONT = '"Stratum2", "Stratum", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
