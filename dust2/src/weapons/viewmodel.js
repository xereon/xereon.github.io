// First-person viewmodel (CONTRACT §13): procedural weapon + gloved arms, keyframed clips with
// crossfades, spring-driven recoil / sway / bob, and muzzle/eject points mapped to world space.
//
//   const vm = new Viewmodel(World.viewScene, World.viewCamera);
//   vm.setWeapon('ak47'); vm.play('draw');  ...each frame: vm.update(dt, ent)
//   vm.muzzleWorld(v) / vm.ejectWorld(v)  -> world-space points that line up on screen
//
// Extras beyond the contract: play('zoom_out' | 'bolt' | 'silencer_on' | 'silencer_off' | 'plant'),
// setSilencer(on), muzzleView(out) (viewScene space) and `muzzleNode` (Object3D at the muzzle,
// in the viewScene, for attaching a viewmodel-space flash), on(event, fn) for anim events.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { buildWeaponModel, buildWorldModel as bwm, resolveKey } from './models/index.js';
import { Arm, handQuat, POSES } from './models/arms.js';
import { makeClip, sample, samplePose } from './models/anims.js';
import { setEnvironment } from './models/materials.js';

export const buildWorldModel = bwm;

defCvar('viewmodel_offset_x', 2.5, -2.5, 2.5, 'viewmodel offset right (CS2 semantics)');
defCvar('viewmodel_offset_y', 0, -2, 2, 'viewmodel offset forward');
defCvar('viewmodel_offset_z', -1.5, -2, 2, 'viewmodel offset up');
defCvar('viewmodel_recoil', 1, 0, 1, 'how far the viewmodel follows aim punch');
defCvar('cl_bobamt_lat', 0.4, 0.1, 2, 'viewmodel lateral bob (in)');
defCvar('cl_bobamt_vert', 0.25, 0.1, 2, 'viewmodel vertical bob (in)');
defCvar('cl_bob_lower_amt', 21, 5, 30, 'viewmodel lowering while running');
defCvar('cl_vm_sway', 1, 0, 3, 'viewmodel mouse-look sway scale');
defCvar('cl_righthand', 1, 0, 1, '1 = right-handed viewmodel');

const DEG = Math.PI / 180;
const PALM = new THREE.Vector3(0, -0.6, -2.0);  // palm centre in hand space
const FADE = 0.14;
const SCALARS = ['magVis', 'bolt', 'slide', 'lhMag', 'lhBolt', 'lhFree', 'lhSil', 'sil', 'silRot', 'silVis', 'vis', 'nade', 'pin',
  'boltLift', 'rhBolt', 'rhFree', 'cover', 'shell', 'pump'];
const VECS = ['gp', 'gr', 'mp', 'mr', 'lhFreeP', 'rp', 'rr', 'silP', 'rhFreeP'];
const STEPPED = ['magVis', 'vis', 'silVis', 'nade', 'shell'];   // visibility-like: never crossfaded
// hand elbow offsets in camera space (in): forearm direction from the wrist
const ELBOW_R = new THREE.Vector3(6, -6, 8);
const ELBOW_L = new THREE.Vector3(-4.5, -7, 6.5);

// critically-ish damped spring on a scalar array
class Spring {
  constructor(n, k, z) { this.x = new Float32Array(n); this.v = new Float32Array(n); this.k = k; this.c = 2 * Math.sqrt(k) * z; this.t = new Float32Array(n); }
  step(dt) {
    const h = 1 / 240;
    for (let s = dt; s > 1e-6; s -= h) {
      const d = Math.min(h, s);
      for (let i = 0; i < this.x.length; i++) {
        const a = -this.k * (this.x[i] - this.t[i]) - this.c * this.v[i];
        this.v[i] += a * d; this.x[i] += this.v[i] * d;
      }
    }
  }
  reset() { this.x.fill(0); this.v.fill(0); this.t.fill(0); }
}

export class Viewmodel {
  constructor(viewScene, viewCamera) {
    this.scene = viewScene || null;
    this.camera = viewCamera || null;
    this.root = new THREE.Group(); this.root.name = 'viewmodel'; this.root.matrixAutoUpdate = false;
    this.rig = new THREE.Group(); this.root.add(this.rig);
    this.pivotNode = new THREE.Group(); this.rig.add(this.pivotNode);
    this.clipNode = new THREE.Group(); this.pivotNode.add(this.clipNode);
    this.inner = new THREE.Group(); this.clipNode.add(this.inner);
    this.muzzleNode = new THREE.Object3D(); this.muzzleNode.name = 'vm_muzzle'; this.inner.add(this.muzzleNode);
    this.scene?.add(this.root);

    this.models = new Map();
    this.cur = null; this.key = null; this.team = null;
    this.armsBy = {};
    this.defs = null;
    this.handlers = new Map();
    // persistent states that clips end in
    this.persist = { slide: 0, sil: 1, silVis: 1, vis: 1, pin: 0, nade: 0 };
    this.silenced = {};
    // clip playback
    this.clip = null; this.clipName = 'idle'; this.t = 0; this.fadeT = 1; this.evIdx = 0;
    this.out = {}; this.snap = {};
    for (const k of SCALARS) { this.out[k] = 0; this.snap[k] = 0; }
    for (const k of VECS) { this.out[k] = [0, 0, 0]; this.snap[k] = [0, 0, 0]; }
    this.tmp3 = [0, 0, 0];
    this.fireT = 9; this.fireDur = 0.1; this.pendingBolt = -1; this.pumpT = 9; this.dualSide = false;
    // procedural motion
    this.kick = new Spring(6, 260, 0.42);
    this.sway = new Spring(4, 90, 0.75);
    this.land = new Spring(2, 120, 0.4);
    this.bobPhase = 0; this.bobAmt = 0; this.breath = 0;
    this.lastYaw = null; this.lastPitch = null; this.wasOnGround = true; this.lastVy = 0;
    this.crouch = 0; this.strafe = 0; this.lower = 0;
    this.envTick = 0; this.envSrc = undefined;
    // scratch
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
    this._e = new THREE.Euler(); this._m = new THREE.Matrix4(); this._m2 = new THREE.Matrix4(); this._p = new THREE.Vector3();
    this._inv = new THREE.Matrix4(); this._tgtP = new THREE.Vector3(); this._tgtQ = new THREE.Quaternion();
    this.fallen = [];

    if (World.weapons) import('./registry.js').then((m) => { this.defs = m.WEAPONS || m.default || null; }).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------
  on(ev, fn) { let s = this.handlers.get(ev); if (!s) this.handlers.set(ev, (s = new Set())); s.add(fn); return () => s.delete(fn); }
  _emit(ev) {
    const s = this.handlers.get(ev);
    if (s) for (const fn of s) { try { fn(ev, this.key); } catch (e) { console.error(e); } }
    World.emit?.('viewmodel_event', { event: ev, weapon: this.key });
  }
  _def() { return this.defs?.[this.key] || World.weapons?.defs?.[this.key] || null; }

  _arms(team) {
    if (!this.armsBy[team]) this.armsBy[team] = { R: new Arm(team, false), L: new Arm(team, true) };
    return this.armsBy[team];
  }

  _entry(key) {
    let e = this.models.get(key);
    if (e) return e;
    const m = buildWeaponModel(key);
    const cfg = m.cfg;
    const hq = (h, left) => (h ? { p: new THREE.Vector3(...h.p), q: handQuat(h.across, h.palm, left), pose: h.pose } : null);
    const H = cfg.hands || {};
    e = {
      key, model: m, cfg, parts: m.parts, anchors: m.anchors,
      pivot: m.anchors.pivot ? m.anchors.pivot.p.clone() : new THREE.Vector3(0, -1, -6),
      R: hq(H.R, false), L: hq(H.L, true),
      magGrab: hq(H.magGrab, true), chargeGrab: hq(H.chargeGrab, true), silGrab: hq(H.silGrab, true),
      boltGrab: hq(H.boltGrab, false),
    };
    // hand targets that ride on moving parts: store them relative to the part's rest matrix
    const rel = (grab, part) => {
      if (!grab || !part) return null;
      const pm = this._partRest(part);
      const inv = pm.clone().invert();
      const gm = new THREE.Matrix4().compose(grab.p, grab.q, new THREE.Vector3(1, 1, 1));
      return inv.multiply(gm);
    };
    if (cfg.dual && e.R) {
      // second pistol in the left hand (shares geometry), canted slightly inward
      const r2 = m.root.clone(true);
      const parts2 = {};
      r2.traverse((o) => { if (o.name && m.parts[o.name]) parts2[o.name] = o; });
      r2.position.set(-6.8, 0.2, 0.8); r2.rotation.set(0, 6 * Math.PI / 180, 4 * Math.PI / 180);
      r2.updateMatrix();
      e.model2 = { root: r2, parts: parts2 };
      const Rh = H.R;
      const lp = new THREE.Vector3(-Rh.p[0], Rh.p[1], Rh.p[2]).applyMatrix4(r2.matrix);
      const lq = handQuat(Rh.across, [-Rh.palm[0], Rh.palm[1], Rh.palm[2]], true).premultiply(r2.quaternion);
      e.L = { p: lp, q: lq, pose: Rh.pose };
      e.magGrab = null;
    }
    e.relPumpL = cfg.pumpTravel && e.parts.pump ? rel(e.L, e.parts.pump) : null;
    e.relMag = rel(e.magGrab, e.parts.mag);
    e.relCharge = rel(e.chargeGrab, e.parts.bolt);
    e.relSil = rel(e.silGrab, e.parts.silencer);
    e.relBoltR = rel(e.boltGrab, e.parts.bolt);
    this.models.set(key, e);
    return e;
  }
  _partRest(part) {
    const m = new THREE.Matrix4();
    const chain = [];
    for (let o = part; o && o.parent && o.name !== 'body'; o = o.parent) chain.unshift(o);
    for (const o of chain) m.multiply(new THREE.Matrix4().makeTranslation(o.userData.rest.x, o.userData.rest.y, o.userData.rest.z));
    return m;
  }
  _partMatrix(part, out) {
    out.identity();
    const chain = this._chain || (this._chain = []);
    chain.length = 0;
    for (let o = part; o && o.parent && o.name !== 'body'; o = o.parent) chain.push(o);
    for (let i = chain.length - 1; i >= 0; i--) { chain[i].updateMatrix(); out.multiply(chain[i].matrix); }
    return out;
  }

  /** Build (cached) and show a weapon. `def` optionally overrides the registry entry. */
  setWeapon(key, def = null) {
    if (def) { this.defs = this.defs || {}; this.defs[key] = def; }
    const mk = this._modelKey(key);
    if (key === this.key && mk === this.cur?.key) return;
    if (this.cur) { this.inner.remove(this.cur.model.root); if (this.cur.model2) this.inner.remove(this.cur.model2.root); }
    const e = this._entry(mk);
    this.cur = e; this.key = key;
    this.inner.add(e.model.root);
    if (e.model2) this.inner.add(e.model2.root);
    this.pivotNode.position.copy(e.pivot);
    this.inner.position.copy(e.pivot).negate();
    if (this.silenced[key] == null) this.silenced[key] = e.cfg.silencer ? 1 : 0;
    this.persist.slide = 0; this.persist.vis = 1; this.persist.pin = 0; this.persist.nade = 0;
    this.persist.sil = this.silenced[key]; this.persist.silVis = this.silenced[key];
    this._attachArms();
    this.kick.reset();
    this.play('draw');
  }

  _modelKey(key) {
    if (key === 'knife' || key === 'knife_t' || key === 'knife_ct') {
      if (key !== 'knife') return key;
      return (this.team || World.local?.team || 'CT') === 'T' ? 'knife_t' : 'knife_ct';
    }
    return resolveKey(key);
  }

  _attachArms() {
    const team = this.team || this.cur?.cfg.team || 'CT';
    const A = this._arms(team);
    for (const t of Object.keys(this.armsBy)) {
      const a = this.armsBy[t];
      for (const s of ['R', 'L']) if (a[s].mount.parent && (t !== team || !this.cur?.[s])) a[s].mount.parent.remove(a[s].mount);
    }
    if (!this.cur) return;
    if (this.cur.R) this.inner.add(A.R.mount);
    if (this.cur.L) this.inner.add(A.L.mount);
    this.arms = A;
  }

  setSilencer(on) {
    if (!this.key) return;
    this.silenced[this.key] = on ? 1 : 0;
    this.persist.sil = this.persist.silVis = on ? 1 : 0;
  }

  /** Start an animation clip (see header for names). */
  play(anim) {
    if (!this.cur) return;
    const cfg = this.cur.cfg, fam = cfg.family, def = this._def();
    if (anim === 'fire' || anim === 'fire_last') {
      if (fam === 'knife') return this.play('melee');
      if (fam === 'grenade') return this.play('throw');
      this._fire(anim === 'fire_last');
      return;
    }
    if (anim === 'idle') { this._startClip(null, 'idle'); if (this.persist.vis === 0) this.persist.vis = 1; return; }
    if (anim === 'zoom_in' && !cfg.scope) return;
    if (anim === 'silencer_on' || anim === 'silencer_off') {
      if (!this.cur.parts.silencer) return;
      this.silenced[this.key] = anim === 'silencer_on' ? 1 : 0;
    }
    if (anim !== 'zoom_in') this.persist.vis = 1;
    const clip = makeClip(anim, cfg, def);
    if (!clip) return;
    if (anim === 'draw') { this.persist.slide = 0; this.persist.pin = 0; this.persist.nade = 0; }
    this._startClip(clip, anim);
  }

  _startClip(clip, name) {
    // snapshot current output for a crossfade
    for (const k of SCALARS) this.snap[k] = this.out[k];
    for (const k of VECS) { const s = this.snap[k], o = this.out[k]; s[0] = o[0]; s[1] = o[1]; s[2] = o[2]; }
    this.fadeT = name === 'draw' ? 1 : 0;
    this.clip = clip; this.clipName = name; this.t = 0; this.evIdx = 0;
    if (name === 'draw') this._sampleInto(0, true);
  }

  _fire(last) {
    const cfg = this.cur.cfg, def = this._def();
    const kb = cfg.kick || [1.2, 2.5];
    const r = (Math.random() - 0.5);
    this.kick.v[2] += kb[0] * 60;          // back (toward camera)
    this.kick.v[1] += kb[0] * 12;          // slightly up
    this.kick.v[3] += kb[1] * 60;          // muzzle up (deg)
    this.kick.v[4] += r * kb[1] * 25;      // yaw jitter
    this.kick.v[5] += (Math.random() - 0.5) * kb[1] * 30;
    this.kick.v[0] += r * 6;
    const ct = def?.cycleTime || cfg.cycle || 0.1;
    this.fireDur = Math.max(0.045, Math.min(0.12, ct * 0.85));
    this.fireT = 0;
    if (cfg.dual) this.dualSide = !this.dualSide;
    if (cfg.pumpAction) this.pumpT = 0;
    if (last && cfg.family === 'pistol') this.persist.slide = 1;
    if (cfg.bolt) { this.pendingBolt = 0.22; this.persist.vis = 1; }
    if (this.clipName !== 'idle' && this.clipName !== 'draw' && this.clip && !this.clip.hold) this._startClip(null, 'idle');
  }

  // ---------------------------------------------------------------------------------------------
  _sampleInto(t, noFade = false) {
    const c = this.clip, ch = c ? c.ch : null, P = this.persist, out = this.out;
    const w = noFade ? 1 : Math.min(1, this.fadeT / FADE);
    const k = w * w * (3 - 2 * w);
    const base = this._base;
    for (const n of SCALARS) {
      let v = ch && ch[n] ? sample(ch[n], t) : base(n, P);
      if (n === 'slide') v = Math.max(v, 0);
      out[n] = k >= 1 ? v : this.snap[n] + (v - this.snap[n]) * k;
    }
    // discrete-valued visibility channels should not fade
    for (const n of STEPPED) out[n] = ch && ch[n] ? sample(ch[n], t) : base(n, P);
    for (const n of VECS) {
      const o = out[n];
      if (ch && ch[n]) sample(ch[n], t, this.tmp3); else { this.tmp3[0] = this.tmp3[1] = this.tmp3[2] = 0; }
      const s = this.snap[n];
      for (let j = 0; j < 3; j++) o[j] = k >= 1 ? this.tmp3[j] : s[j] + (this.tmp3[j] - s[j]) * k;
    }
    this.lhPose = ch?.lhPose ? samplePose(ch.lhPose, t, this._lhp || (this._lhp = ['', '', 0])) : null;
    this.rhPose = ch?.rhPose ? samplePose(ch.rhPose, t, this._rhp || (this._rhp = ['', '', 0])) : null;
  }

  // value of a channel when the active clip doesn't drive it (persistent end states)
  _base(name, P) {
    if (name === 'magVis' || name === 'vis' || name === 'silVis') return P[name] ?? 1;
    if (name === 'slide' || name === 'sil' || name === 'pin' || name === 'nade') return P[name];
    return 0;
  }

  update(dt, ent) {
    if (!this.cur) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    const cv = World.cvar || {};
    if ((++this.envTick & 31) === 1) this._checkEnv();
    const team = ent?.team;
    if (team && team !== this.team) {
      this.team = team;
      if (this.key === 'knife' && this._modelKey('knife') !== this.cur.key) { const k = this.key; this.key = null; this.setWeapon(k); }
      this._attachArms();
    }

    // ---- clip time + events ----
    this.fadeT += dt;
    if (this.clip) {
      this.t += dt / this.clip.dur;
      const ev = this.clip.ev || [];
      while (this.evIdx < ev.length && ev[this.evIdx][0] <= this.t) this._onEvent(ev[this.evIdx++][1]);
      if (this.t >= 1) {
        this.t = 1;
        if (!this.clip.hold) this._endClip();
      }
    }
    if (this.pendingBolt >= 0) {
      this.pendingBolt -= dt;
      if (this.pendingBolt < 0) { this.pendingBolt = -1; const c = makeClip('bolt', this.cur.cfg, this._def()); if (c) this._startClip(c, 'bolt'); }
    }
    this._sampleInto(this.clip ? this.t : 0);
    const o = this.out, P = this.persist;

    // ---- procedural motion ----
    this._procedural(dt, ent, cv);

    // ---- gun transform ----
    const cfg = this.cur.cfg;
    const hand = cv.cl_righthand === 0 ? -1 : 1;
    const bp = cfg.pos;
    const sx = this.sway.x, kx = this.kick.x, lx = this.land.x;
    const bob = this._bob;
    this.rig.position.set(
      bp[0] + (cv.viewmodel_offset_x ?? 2.5) + sx[0] + kx[0] * 0.02 + bob[0] + this.strafe * -0.3,
      bp[1] + (cv.viewmodel_offset_z ?? -1.5) + sx[1] + kx[1] * 0.02 + bob[1] + lx[0] - this.crouch * 0.25 - this.lower,
      bp[2] - (cv.viewmodel_offset_y ?? 0) + kx[2] * 0.02 + this.crouch * 0.3 + this.lower * 0.6,
    );
    const ap = ent?.aimPunch;
    const vr = cv.viewmodel_recoil ?? 1;
    const rx = (cfg.rot?.[0] || 0) + sx[2] + kx[3] * 0.02 + lx[1] + (ap ? -ap.pitch * vr * 0.9 : 0) + bob[2] - this.lower * 3;
    const ry = (cfg.rot?.[1] || 0) + sx[3] + kx[4] * 0.02 + (ap ? ap.yaw * vr * 0.9 : 0) + bob[3];
    const rz = (cfg.rot?.[2] || 0) + kx[5] * 0.02 + this.strafe * 2.5 + bob[4] - this.crouch * 1.5;
    this.rig.rotation.set(rx * DEG, ry * DEG, rz * DEG, 'YXZ');
    this.clipNode.position.set(o.gp[0], o.gp[1], o.gp[2]);
    this.clipNode.rotation.set(o.gr[0] * DEG, o.gr[1] * DEG, o.gr[2] * DEG, 'YXZ');
    this.rig.visible = o.vis > 0.5 && (cv.r_drawviewmodel ?? 1) > 0;

    // ---- parts ----
    const parts = this.cur.parts;
    const fr = this.fireT < this.fireDur ? this.fireT / this.fireDur : 1;
    this.fireT += dt;
    const cyc = fr < 1 ? (fr < 0.35 ? fr / 0.35 : 1 - (fr - 0.35) / 0.65) : 0;
    const pm = parts.mag;
    if (pm) {
      pm.position.set(pm.userData.rest.x + o.mp[0], pm.userData.rest.y + o.mp[1], pm.userData.rest.z + o.mp[2]);
      pm.rotation.set(o.mr[0] * DEG, o.mr[1] * DEG, o.mr[2] * DEG);
      pm.visible = o.magVis > 0.5;
    }
    if (parts.bolt) {
      const b = Math.max(o.bolt, cfg.family !== 'pistol' && !cfg.bolt ? cyc : 0);
      parts.bolt.position.z = parts.bolt.userData.rest.z + b * (cfg.boltTravel || 3);
      if (cfg.bolt) parts.bolt.rotation.z = o.boltLift * (cfg.boltLiftDeg || 65) * DEG;
    }
    if (parts.slide) {
      const s = Math.max(o.slide, P.slide, cfg.family === 'pistol' ? cyc : 0);
      parts.slide.position.z = parts.slide.userData.rest.z + s * (cfg.slideTravel || 1.2);
    }
    if (parts.trigger) parts.trigger.rotation.x = (fr < 1 ? 1 - fr : 0) * -12 * DEG;
    if (parts.hammer) parts.hammer.rotation.x = (fr < 1 ? Math.sin(fr * Math.PI) : 0) * 40 * DEG;
    if (parts.cover) parts.cover.rotation.x = -o.cover * 75 * DEG;
    if (parts.pump) {
      let pc = 0;
      if (cfg.pumpAction && this.pumpT < 0.62) {
        this.pumpT += dt;
        const t = (this.pumpT - 0.16) / 0.42;
        pc = t <= 0 || t >= 1 ? 0 : t < 0.45 ? Math.sin((t / 0.45) * Math.PI / 2) : Math.cos(((t - 0.45) / 0.55) * Math.PI / 2);
      }
      parts.pump.position.z = parts.pump.userData.rest.z + Math.max(o.pump, pc) * (cfg.pumpTravel || 3.2);
    }
    if (parts.silencer) {
      const s = parts.silencer;
      s.visible = o.silVis > 0.5;
      s.position.set(s.userData.rest.x + o.silP[0], s.userData.rest.y + o.silP[1], s.userData.rest.z + o.silP[2] - (1 - Math.min(1, o.sil)) * 1.1);
      s.rotation.z = o.silRot * DEG;
    }
    const p2 = this.cur.model2?.parts;
    if (p2) {
      if (p2.mag) { p2.mag.position.copy(pm.position); p2.mag.rotation.copy(pm.rotation); p2.mag.visible = pm.visible; }
      const alt = this.dualSide ? 1 : 0;
      if (parts.slide && p2.slide) {
        const s1 = Math.max(o.slide, P.slide, alt ? 0 : cyc), s2 = Math.max(o.slide, P.slide, alt ? cyc : 0);
        parts.slide.position.z = parts.slide.userData.rest.z + s1 * (cfg.slideTravel || 1.2);
        p2.slide.position.z = p2.slide.userData.rest.z + s2 * (cfg.slideTravel || 1.2);
      }
    }
    if (parts.pin) parts.pin.visible = o.pin < 0.5;
    if (cfg.family === 'grenade' && parts.body) {
      for (const c of this.cur.model.root.children) if (c !== parts.pin) c.visible = o.nade < 0.5;
    }
    this.muzzleNode.position.copy(this._muzzleAnchor());

    // ---- hands ----
    this._hands();

    // ---- place the root on the view camera ----
    const cam = this.camera;
    if (cam) { cam.updateMatrixWorld(); this.root.matrix.copy(cam.matrixWorld); }
    else this.root.matrix.identity();
    if (hand < 0) this.root.matrix.scale(this._v.set(-1, 1, 1));
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    this._aimArms();
    this._updateFallen(dt);
  }

  _endClip() {
    const n = this.clipName;
    if (n === 'throw') { this.persist.nade = 1; this.persist.vis = 1; }
    if (n === 'pin') this.persist.pin = 1;
    if (n.startsWith('reload') || n === 'draw') this.persist.slide = 0;
    if (n === 'silencer_on' || n === 'silencer_off') { const s = this.silenced[this.key]; this.persist.sil = this.persist.silVis = s; }
    this._startClip(null, 'idle');
    // keep end-state channels steady into idle (no fade from hold-values like lhFree for pin)
    if (n === 'pin') { this.clip = makeClip('pin', this.cur.cfg, null); this.clip.hold = true; this.t = 1; this.clipName = 'pinned'; }
    if (n === 'throw') { this.clip = makeClip('throw', this.cur.cfg, null); this.clip.hold = true; this.t = 1; this.clipName = 'thrown'; }
  }

  _onEvent(name) {
    if (name === 'mag_drop') this._dropMag();
    if (name === 'scoped') this.persist.vis = 0;
    if (name === 'slide_fwd' && this.clipName.startsWith('reload')) this.persist.slide = 0;
    if (name === 'sil_on' || name === 'sil_off') { const s = name === 'sil_on' ? 1 : 0; this.persist.sil = this.persist.silVis = s; }
    this._emit(name);
  }

  // Spawn a falling copy of the magazine in rig space (shares geometry).
  _dropMag() {
    const pm = this.cur.parts.mag;
    if (!pm) return;
    let f = this.fallen.find((x) => !x.alive && x.src === pm);
    if (!f) {
      const obj = pm.clone(true);
      obj.matrixAutoUpdate = true;
      f = { obj, src: pm, alive: false, v: new THREE.Vector3(), w: new THREE.Vector3(), t: 0 };
      this.fallen.push(f);
    }
    pm.updateWorldMatrix(true, false);
    this._inv.copy(this.rig.matrixWorld).invert();
    this._m.multiplyMatrices(this._inv, pm.matrixWorld);
    this._m.decompose(f.obj.position, f.obj.quaternion, f.obj.scale);
    f.obj.visible = true;
    this.rig.add(f.obj);
    f.v.set(-3, -20, 6); f.w.set(2.5, 0.8, 1.2); f.t = 0; f.alive = true;
  }
  _updateFallen(dt) {
    for (const f of this.fallen) {
      if (!f.alive) continue;
      f.t += dt;
      f.v.y -= 386 * dt * 0.6;
      f.obj.position.addScaledVector(f.v, dt);
      this._e.set(f.w.x * dt, f.w.y * dt, f.w.z * dt);
      f.obj.quaternion.multiply(this._q.setFromEuler(this._e));
      if (f.t > 0.8) { f.alive = false; f.obj.parent?.remove(f.obj); }
    }
  }

  _procedural(dt, ent, cv) {
    const sw = cv.cl_vm_sway ?? 1;
    // mouse-look sway from view angle rates
    const yaw = ent?.yaw ?? World.input?.yaw ?? 0, pitch = ent?.pitch ?? World.input?.pitch ?? 0;
    if (this.lastYaw == null) { this.lastYaw = yaw; this.lastPitch = pitch; }
    let dy = yaw - this.lastYaw; dy = ((dy + 540) % 360) - 180;
    const dp = pitch - this.lastPitch;
    this.lastYaw = yaw; this.lastPitch = pitch;
    const inv = dt > 1e-4 ? 1 / dt : 0;
    const yr = Math.max(-600, Math.min(600, dy * inv)), pr = Math.max(-400, Math.min(400, dp * inv));
    const S = this.sway;
    S.t[0] = Math.max(-1.1, Math.min(1.1, yr * 0.0022 * sw));
    S.t[1] = Math.max(-0.8, Math.min(0.8, -pr * 0.0018 * sw));
    S.t[2] = Math.max(-3, Math.min(3, -pr * 0.006 * sw));
    S.t[3] = Math.max(-4, Math.min(4, -yr * 0.008 * sw));
    S.step(dt);
    // recoil springs
    this.kick.step(dt);
    // movement bob (figure-8), lowering, strafe tilt, crouch
    const vel = ent?.velocity;
    const speed = vel ? Math.hypot(vel.x, vel.z) : 0;
    const onGround = ent ? ent.onGround !== false : true;
    const s = Math.min(1, speed / 250) * (onGround ? 1 : 0.2);
    this.bobAmt += (s - this.bobAmt) * Math.min(1, dt * 8);
    this.bobPhase += dt * (Math.PI * 2 / 0.98) * (0.35 + 0.65 * Math.min(1, speed / 250));
    const lat = (cv.cl_bobamt_lat ?? 0.4) * 1.6, vert = (cv.cl_bobamt_vert ?? 0.25) * 1.6;
    this.breath += dt;
    const br = Math.sin(this.breath * 1.6) * 0.035, br2 = Math.sin(this.breath * 0.9 + 1) * 0.25;
    const a = this.bobAmt;
    this._bob = this._bob || [0, 0, 0, 0, 0];
    this._bob[0] = Math.sin(this.bobPhase) * lat * a;
    this._bob[1] = -Math.abs(Math.cos(this.bobPhase)) * vert * a * 1.4 + br;
    this._bob[2] = Math.sin(this.bobPhase * 2) * 0.35 * a + br2 * 0.3;
    this._bob[3] = Math.sin(this.bobPhase) * 0.6 * a;
    this._bob[4] = Math.sin(this.bobPhase) * 0.8 * a + br2 * 0.15;
    this.lower += ((cv.cl_bob_lower_amt ?? 21) / 21 * 0.45 * a - this.lower) * Math.min(1, dt * 6);
    // strafe: lateral velocity in view space
    let latv = 0;
    if (vel) { const yr2 = yaw * DEG; latv = (vel.x * Math.sin(yr2) + vel.z * Math.cos(yr2)) / 250; }
    this.strafe += (Math.max(-1, Math.min(1, latv)) - this.strafe) * Math.min(1, dt * 7);
    const duck = ent ? (ent.duckAmount ?? (ent.ducking ? 1 : 0)) : 0;
    this.crouch += (duck - this.crouch) * Math.min(1, dt * 10);
    // landing kick
    if (ent) {
      if (onGround && !this.wasOnGround) {
        const f = Math.min(1, Math.max(0.15, -this.lastVy / 500));
        this.land.v[0] -= 30 * f; this.land.v[1] -= 90 * f;
      } else if (!onGround && this.wasOnGround && (vel?.y || 0) > 50) { this.land.v[0] += 8; this.land.v[1] += 20; }
      this.wasOnGround = onGround;
      this.lastVy = vel?.y || 0;
    }
    this.land.step(dt);
  }

  // Left/right hand target resolution in gun space.
  _hands() {
    const e = this.cur, o = this.out, A = this.arms;
    if (!A) return;
    const cfg = e.cfg;
    if (e.R) {
      const p = this._tgtP.copy(e.R.p), q = this._tgtQ.copy(e.R.q);
      p.x += o.rp[0]; p.y += o.rp[1]; p.z += o.rp[2];
      if (o.rhBolt > 0 && e.relBoltR) this._blendPart(p, q, e.parts.bolt, e.relBoltR, o.rhBolt);
      if (o.rhFree > 0) { this._v.set(o.rhFreeP[0], o.rhFreeP[1], o.rhFreeP[2]).add(e.R.p); p.lerp(this._v, o.rhFree); }
      this._place(A.R, p, q);
      const rp = this.rhPose;
      if (rp) A.R.setPose(rp[0], rp[1], rp[2]); else A.R.setPose(e.R.pose || 'grip');
    }
    if (e.L) {
      const p = this._tgtP.copy(e.L.p), q = this._tgtQ.copy(e.L.q);
      if (e.relPumpL) this._blendPart(p, q, e.parts.pump, e.relPumpL, 1);
      if (o.lhMag > 0 && e.relMag) this._blendPart(p, q, e.parts.mag, e.relMag, o.lhMag);
      if (o.lhBolt > 0 && e.relCharge) this._blendPart(p, q, e.parts.bolt, e.relCharge, o.lhBolt);
      if (o.lhSil > 0 && e.relSil) this._blendPart(p, q, e.parts.silencer, e.relSil, o.lhSil);
      if (o.lhFree > 0 && !cfg.dual) {
        this._v.set(o.lhFreeP[0], o.lhFreeP[1], o.lhFreeP[2]);
        p.lerp(this._v, o.lhFree);
        if (e.magGrab) q.slerp(e.magGrab.q, o.lhFree * 0.7);
      }
      this._place(A.L, p, q);
      const lp = this.lhPose;
      if (lp) A.L.setPose(lp[0], lp[1], lp[2]); else A.L.setPose(e.L.pose || 'wrap');
    }
    void cfg;
  }
  _blendPart(p, q, part, rel, w) {
    if (!part) return;
    this._partMatrix(part, this._m).multiply(rel);
    this._m.decompose(this._v2, this._q2, this._p);
    p.lerp(this._v2, w); q.slerp(this._q2, w);
  }
  _place(arm, palmP, q) {
    const m = arm.mount;
    m.quaternion.copy(q);
    this._v.copy(PALM).applyQuaternion(q);
    m.position.copy(palmP).sub(this._v);
  }
  _aimArms() {
    const A = this.arms, c = this.cur;
    if (!A || !c) return;
    this._inv.copy(this.rig.matrixWorld).invert();
    if (c.R) this._aimArm(A.R, c.cfg.elbowR ? this._v2.fromArray(c.cfg.elbowR) : ELBOW_R);
    if (c.L) this._aimArm(A.L, c.cfg.elbowL ? this._v2.fromArray(c.cfg.elbowL) : ELBOW_L);
  }
  // forearm points from the wrist toward an elbow placed at a fixed offset in rig space
  _aimArm(arm, off) {
    if (!arm.mount.parent) return;
    arm.mount.updateMatrixWorld(true);
    const w = this._v.setFromMatrixPosition(arm.root.matrixWorld);
    w.applyMatrix4(this._inv).add(off).applyMatrix4(this.rig.matrixWorld);
    arm.aim(w);
  }

  _muzzleAnchor() {
    const a = this.cur.anchors;
    const sil = this.cur.parts.silencer && this.out.silVis > 0.5 && a.muzzle_s;
    return (sil ? a.muzzle_s : a.muzzle)?.p || this._v.set(0, 0, -20);
  }

  // ---- world mapping ----
  /** Muzzle in viewScene world space. */
  muzzleView(out = new THREE.Vector3()) { this.muzzleNode.updateWorldMatrix(true, false); return out.setFromMatrixPosition(this.muzzleNode.matrixWorld); }
  muzzleWorld(out = new THREE.Vector3()) { return this._toWorld(this.muzzleView(out), out); }
  ejectWorld(out = new THREE.Vector3()) {
    const a = this.cur?.anchors?.eject;
    if (!a) return this.muzzleWorld(out);
    out.copy(a.p).applyMatrix4(this.inner.matrixWorld);
    return this._toWorld(out, out);
  }
  // Maps a viewScene point through the view camera's projection onto the world camera at the
  // same view depth, so the point lands on the same pixel.
  _toWorld(p, out) {
    const vc = this.camera, wc = World.camera;
    if (!vc || !wc) return out.copy(p);
    vc.updateMatrixWorld();
    const v = this._p.copy(p).applyMatrix4(vc.matrixWorldInverse);
    const d = Math.max(1, -v.z);
    const tv = Math.tan(vc.fov * DEG / 2) / (vc.zoom || 1), tw = Math.tan(wc.fov * DEG / 2) / (wc.zoom || 1);
    const nx = (v.x / d) / (tv * vc.aspect), ny = (v.y / d) / tv;
    wc.updateMatrixWorld();
    out.set(nx * tw * wc.aspect * d, ny * tw * d, -d).applyMatrix4(wc.matrixWorld);
    return out;
  }

  // ---- lighting / environment fallbacks ----
  _checkEnv() {
    const vs = this.scene;
    const src = vs?.environment ? null : (World.scene?.environment || undefined);
    const key = vs?.environment ? 'view' : src ? 'world' : 'own';
    if (key !== this.envSrc) {
      this.envSrc = key;
      setEnvironment(key === 'view' ? null : key === 'world' ? src : undefined);
    }
    // fallback lights only when the view scene has none
    let has = false;
    if (vs) for (const c of vs.children) if (c.isLight || (c !== this.root && c.children?.some?.((x) => x.isLight))) { has = true; break; }
    const fb = this.root.getObjectByName('vm_fallback_lights');
    if (!has && !fb) {
      const g = new THREE.Group(); g.name = 'vm_fallback_lights';
      const key = new THREE.DirectionalLight(0xfff1dc, 2.4); key.position.set(6, 12, 4); key.target.position.set(0, 0, -20);
      const fill = new THREE.DirectionalLight(0xbcd2ff, 0.6); fill.position.set(-10, 2, 2); fill.target.position.set(0, 0, -20);
      const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x8a6a45, 0.7);
      g.add(key, key.target, fill, fill.target, hemi);
      this.root.add(g);
    } else if (has && fb) this.root.remove(fb);
  }

  get animation() { return this.clipName; }
  get busy() { return !!this.clip && !this.clip.hold && this.clipName !== 'idle'; }
  get triangles() { return this.cur?.model.tris || 0; }
  dispose() { this.scene?.remove(this.root); }
}

export { POSES };
