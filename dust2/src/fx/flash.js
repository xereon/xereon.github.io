// Flashbang: detonation visuals, per-entity blindness (CS facing/LOS/distance rules) and the
// burnt-in afterimage for the local player (a low-res capture of the frame at detonation,
// drawn as a full-screen quad over the viewmodel; the HUD draws the white-out on top).
import * as THREE from 'three';
import { World } from '../core/world.js';
import { angleVectors } from '../core/mathx.js';
import { PF } from './particles.js';
import { SPR } from './atlas.js';
import { sparks } from './impacts.js';

const MASK_VISIBLE = 1;
const _eye = new THREE.Vector3(), _to = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _av = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };

const OVERLAY_FRAG = /* glsl */`
uniform sampler2D uTex;
uniform float uAfter;
uniform float uWhite;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  c = c / (1.0 + c);                      // simple tonemap of the HDR capture
  float l = dot(c, vec3(0.3, 0.55, 0.15));
  c = mix(vec3(l), c, 0.55) * 1.6 + 0.08; // washed-out, over-bright ghost
  vec3 col = mix(c, vec3(8.0), uWhite);
  float a = max(uAfter, uWhite);
  gl_FragColor = vec4(col * a, a);
}`;

export class Flash {
  constructor(fx) {
    this.fx = fx;
    this.state = new Map(); // ent -> { t0, hold, fade, peak }
    this.rt = null;
    this.captureAt = -1;
    this.localStart = -1;
    this.uniforms = { uTex: { value: null }, uAfter: { value: 0 }, uWhite: { value: 0 } };
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      name: 'fx-flash-overlay', uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: OVERLAY_FRAG,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.overlay.frustumCulled = false;
    this.overlay.renderOrder = 1000;
    this.overlay.visible = false;
    this.overlay.userData.fx = true;
    (World.viewScene || World.scene)?.add(this.overlay);
    this.ev = { ent: null, amount: 0, duration: 0, pos: null };
    this.afterObj = { texture: null, strength: 0, blind: 0 };
  }

  detonate(pos) {
    const fx = this.fx, R = fx.rand, S = fx.pool.spec, now = fx.now;
    // blindness
    const col = World.collision;
    for (const ent of World.entities) {
      if (!ent || ent.alive === false) continue;
      if (ent.eyePos) ent.eyePos(_eye);
      else if (ent.origin) _eye.copy(ent.origin).setY(ent.origin.y + (ent.eyeHeight ?? 64));
      else continue;
      if (col && col.rayTrace(pos, _eye, MASK_VISIBLE).fraction < 0.999) continue;
      const smoke = fx.smokeOcclusion(pos, _eye);
      if (smoke > 0.9) continue;
      const dist = _eye.distanceTo(pos);
      const f = Math.max(0, Math.min(1, 1.15 - dist / 2400)) * (1 - smoke);
      if (f <= 0.02) continue;
      angleVectors(ent.pitch || 0, ent.yaw || 0, _av);
      _to.subVectors(pos, _eye).normalize();
      const dot = _av.forward.dot(_to);
      let hold, fade, peak;
      if (dot >= 0.6) { hold = 2.0; fade = 2.9; peak = 1; }
      else if (dot >= 0.3) { hold = 1.2; fade = 2.2; peak = 1; }
      else if (dot >= -0.2) { hold = 0.45; fade = 1.5; peak = 0.95; }
      else { hold = 0.0; fade = 0.9; peak = 0.7; }
      hold *= f; fade *= Math.max(0.35, f);
      peak *= Math.min(1, 0.4 + f);
      let st = this.state.get(ent);
      if (!st) { st = { t0: 0, hold: 0, fade: 0, peak: 0 }; this.state.set(ent, st); }
      // stack with an existing flash: keep whichever ends later / is stronger now
      const cur = this.amountAt(st, now);
      if (peak >= cur || now + hold + fade > st.t0 + st.hold + st.fade) {
        st.t0 = now; st.hold = hold; st.fade = fade; st.peak = Math.max(peak, cur);
      }
      this.ev.ent = ent; this.ev.amount = st.peak; this.ev.duration = hold + fade; this.ev.pos = pos;
      World.emit('flashed', this.ev);
      if (ent === World.local && st.peak > 0.6 && hold + fade > 1.0) {
        this.localStart = now;
        this.capture();       // the frame as it was, before the burst itself
      }
    }
    // visuals
    S.reset(); S.pos.copy(pos);
    S.life = 0.2; S.size0 = 40; S.size1 = 75;
    S.c0.set(6, 6, 6.6, 1); S.c1.set(2, 2, 2.3, 0);
    S.sprite = SPR.GLOW; S.flags = PF.ADD; S.fadeIn = 0; S.fadeOut = 0.15;
    fx.pool.emit(S, now);
    S.reset(); S.pos.copy(pos);
    S.life = 0.12; S.size0 = 34; S.size1 = 48; S.rot = R() * 6.283;
    S.c0.set(18, 18, 20, 1); S.c1.set(8, 8, 9, 0);
    S.sprite = SPR.FLARE; S.flags = PF.ADD; S.fadeIn = 0; S.fadeOut = 0.3;
    fx.pool.emit(S, now);
    sparks(fx, pos, _up, Math.round(16 * fx.scale), 500, -1e6, { life: 0.35, size: 0.25, hot: 1.4, spread: 2 });
    for (let i = 0; i < 4; i++) {
      S.reset(); S.pos.copy(pos);
      S.vel.set((R() - 0.5) * 60, 10 + R() * 30, (R() - 0.5) * 60);
      S.drag = 2.5; S.gravity = -0.03; S.life = 1.6 + R();
      S.size0 = 3; S.size1 = 16 + R() * 8; S.rot = R() * 6.283;
      S.c0.set(0.75, 0.75, 0.75, 0.35); S.c1.set(0.75, 0.75, 0.75, 0);
      S.sprite = SPR.SMOKE0 + 3; S.frames = 12; S.flags = PF.LIT | PF.SOFT | PF.TURB;
      fx.pool.emit(S, now);
    }
    _to.copy(pos);
    fx.lights.spawn(now, _to, 0xeef2ff, 3e5, 1500, 0.28, { prio: 3, hold: 0.03 });
  }

  amountAt(st, now) {
    const t = now - st.t0;
    if (t < 0) return 0;
    if (t < st.hold) return st.peak;
    const u = (t - st.hold) / Math.max(st.fade, 1e-3);
    if (u >= 1) return 0;
    return st.peak * Math.pow(1 - u, 1.35);
  }

  blindAmount(ent) {
    const st = this.state.get(ent);
    return st ? this.amountAt(st, this.fx.now) : 0;
  }

  /** Grab a low-res HDR copy of the scene for the afterimage. */
  capture() {
    const r = World.renderer?.renderer;
    if (!r || !World.scene || !World.camera) return;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, (size.x / 4) | 0), h = Math.max(36, (size.y / 4) | 0);
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    }
    const prev = r.getRenderTarget(), prevAuto = r.autoClear;
    r.setRenderTarget(this.rt);
    r.autoClear = true;
    this.overlay.visible = false;
    try { r.render(World.scene, World.camera); } finally {
      r.setRenderTarget(prev);
      r.autoClear = prevAuto;
    }
    this.uniforms.uTex.value = this.rt.texture;
  }

  update() {
    const fx = this.fx, now = fx.now;
    if (this.captureAt >= 0) { this.captureAt = -1; this.capture(); }
    const L = World.local;
    const b = L ? this.blindAmount(L) : 0;
    const whiteout = fx.cvar('fx_flash_whiteout', 0) > 0;
    const hasTex = !!this.uniforms.uTex.value && this.localStart >= 0;
    // afterimage lingers a little behind the white-out
    const after = hasTex ? Math.min(1, b * 1.5) * 0.75 : 0;
    this.uniforms.uAfter.value = after;
    this.uniforms.uWhite.value = whiteout ? b : 0;
    this.overlay.visible = after > 0.003 || (whiteout && b > 0.003);
    if (hasTex && after > 0.003) {
      const o = this.afterObj;
      o.texture = this.uniforms.uTex.value; o.strength = after; o.blind = b;
      fx.flashAfterimage = o;
    } else fx.flashAfterimage = null;
  }

  clear() { this.state.clear(); this.localStart = -1; this.overlay.visible = false; }
}
