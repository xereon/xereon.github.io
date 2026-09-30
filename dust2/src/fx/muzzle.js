// Muzzle flashes per weapon class. A flash = HDR core glow + random star (front view) +
// 3-5 flame prongs fanned along the barrel (side view) + forward cone + a few sparks,
// a pooled point light, and a lingering lit smoke wisp in world space.
import * as THREE from 'three';
import { PF } from './particles.js';
import { SPR } from './atlas.js';
import { randCone, viewmodelToWorldMatched, worldToView, dirWorldToView, sunVisibility } from './util.js';

export const MUZZLE = {
  rifle: { scale: 1.0, prongs: 4, prongLen: 2.6, cone: 1.0, glow: 1.0, light: 1.0, smoke: 2, sparks: 3, star: 0 },
  smg: { scale: 0.8, prongs: 3, prongLen: 2.2, cone: 0.8, glow: 0.8, light: 0.75, smoke: 1, sparks: 2, star: 0 },
  pistol: { scale: 0.7, prongs: 3, prongLen: 1.8, cone: 0.6, glow: 0.8, light: 0.7, smoke: 1, sparks: 2, star: 0 },
  deagle: { scale: 1.05, prongs: 4, prongLen: 2.2, cone: 1.1, glow: 1.1, light: 1.0, smoke: 2, sparks: 4, star: 0 },
  shotgun: { scale: 1.35, prongs: 6, prongLen: 1.6, cone: 1.4, glow: 1.3, light: 1.3, smoke: 3, sparks: 7, star: 1 },
  sniper: { scale: 1.6, prongs: 5, prongLen: 2.8, cone: 1.6, glow: 1.4, light: 1.5, smoke: 3, sparks: 5, star: 0 },
  mg: { scale: 1.1, prongs: 4, prongLen: 2.6, cone: 1.1, glow: 1.1, light: 1.1, smoke: 2, sparks: 3, star: 0 },
  suppressed: { scale: 0.45, prongs: 0, prongLen: 0, cone: 0, glow: 0.3, light: 0.25, smoke: 3, sparks: 0, star: -1 },
};

export function muzzleClass(key, opts) {
  const k = key || '';
  const supp = opts?.suppressed ?? (/mp5sd/.test(k) || /(m4a1s|m4a1_silencer|usp)/.test(k) && opts?.suppressed !== false);
  if (supp) return 'suppressed';
  if (/nova|xm1014|mag7|sawed/.test(k)) return 'shotgun';
  if (/awp|ssg08|g3sg1|scar20/.test(k)) return 'sniper';
  if (/negev|m249/.test(k)) return 'mg';
  if (/deagle|r8/.test(k)) return 'deagle';
  if (/glock|p250|tec9|fiveseven|dualberettas|cz75|p2000|elite/.test(k)) return 'pistol';
  if (/mp9|mac10|ump|p90|mp7|bizon|mp5/.test(k)) return 'smg';
  return 'rifle';
}

const _P = new THREE.Vector3(), _D = new THREE.Vector3(), _W = new THREE.Vector3(), _t = new THREE.Vector3();
const _Wd = new THREE.Vector3();

export function muzzleFx(fx, worldPos, dir, key, opts = {}) {
  const cls = muzzleClass(key, opts);
  const M = MUZZLE[cls];
  const R = fx.rand;
  const view = !!opts.viewmodel && fx.vpool;
  const pool = view ? fx.vpool : fx.pool;
  const now = fx.now;
  const P = _P, D = _D;
  if (view) { worldToView(worldPos, P); dirWorldToView(dir, D).normalize(); }
  else { P.copy(worldPos); D.copy(dir).normalize(); }
  const s = M.scale * (opts.scale ?? 1) * (view ? fx.cvar('fx_muzzle_view_scale', 0.75) : 1);
  const bright = fx.cvar('fx_muzzle_bright', 1);
  const S = pool.spec;
  const life = 0.034 + R() * 0.02;

  // core glow
  S.reset();
  S.pos.copy(P).addScaledVector(D, 1.5 * s);
  S.life = life * 1.3;
  S.size0 = 4.5 * s * M.glow; S.size1 = 5.5 * s * M.glow;
  S.rot = R() * 6.283;
  S.c0.set(3.2 * bright, 1.9 * bright, 0.7 * bright, 1); S.c1.set(2 * bright, 0.9 * bright, 0.25 * bright, 0);
  S.sprite = SPR.GLOW; S.flags = PF.ADD;
  S.fadeIn = 0; S.fadeOut = 0.35;
  pool.emit(S, now);

  if (M.star >= 0) {
    // front star (seen head-on)
    S.reset();
    S.pos.copy(P).addScaledVector(D, 2 * s);
    S.life = life;
    S.size0 = (4.2 + R() * 1.6) * s; S.size1 = S.size0 * 1.25;
    S.rot = R() * 6.283;
    S.c0.set(7 * bright, 4.2 * bright, 1.5 * bright, 1); S.c1.set(5 * bright, 2.2 * bright, 0.5 * bright, 0.3);
    S.sprite = M.star === 1 ? SPR.SHOTGUN : SPR.STAR0 + ((R() * 4) | 0);
    S.flags = PF.ADD;
    S.fadeIn = 0; S.fadeOut = 0.5;
    pool.emit(S, now);

    // flame prongs fanned around the barrel axis
    for (let i = 0; i < M.prongs; i++) {
      S.reset();
      S.pos.copy(P);
      randCone(D, 0.1 + (cls === 'shotgun' ? 0.1 : 0), R, _t);
      S.vel.copy(_t); // axis
      S.life = life;
      S.size0 = (1.3 + R() * 0.9) * s; S.size1 = S.size0 * 1.2;
      S.stretch = M.prongLen * (0.9 + R() * 1.2) * 2.4;
      S.rot = R() < 0.5 ? 1 : -1;
      S.c0.set(4.5 * bright, 2.2 * bright, 0.6 * bright, 1); S.c1.set(3 * bright, 1.1 * bright, 0.2 * bright, 0.4);
      S.sprite = SPR.PRONG0 + ((R() * 2) | 0);
      S.flags = PF.ADD | PF.AXIS;
      S.fadeIn = 0; S.fadeOut = 0.5;
      pool.emit(S, now);
    }
    // forward cone
    if (M.cone > 0) {
      S.reset();
      S.pos.copy(P);
      S.vel.copy(D);
      S.life = life * 0.9;
      S.size0 = 2.4 * s * M.cone; S.size1 = S.size0 * 1.3;
      S.stretch = 5.5 + R() * 2;
      S.c0.set(3.5 * bright, 1.8 * bright, 0.5 * bright, 1); S.c1.set(2.2 * bright, 0.8 * bright, 0.15 * bright, 0);
      S.sprite = SPR.CONE; S.flags = PF.ADD | PF.AXIS;
      S.fadeIn = 0; S.fadeOut = 0.4;
      pool.emit(S, now);
    }
  } else {
    // suppressed: a small hot puff
    S.reset();
    S.pos.copy(P).addScaledVector(D, 1);
    S.life = 0.05;
    S.size0 = 1.6; S.size1 = 2.4;
    S.rot = R() * 6.283;
    S.c0.set(2.5 * bright, 1.8 * bright, 1.1 * bright, 0.8); S.c1.set(1, 0.6, 0.3, 0);
    S.sprite = SPR.SUPP; S.flags = PF.ADD;
    pool.emit(S, now);
  }

  // sparks / unburnt powder
  for (let i = 0; i < M.sparks; i++) {
    S.reset();
    S.pos.copy(P).addScaledVector(D, 2 * s);
    randCone(D, 0.06, R, _t);
    S.vel.copy(_t).multiplyScalar(900 + R() * 900);
    S.drag = 4; S.gravity = 0.3;
    S.life = 0.05 + R() * 0.07;
    S.size0 = 0.18 * s + 0.08; S.size1 = S.size0 * 0.6;
    S.stretch = 0.012;
    S.c0.set(9, 6, 2.5, 1); S.c1.set(4, 1.4, 0.3, 0.5);
    S.sprite = SPR.SPARK; S.flags = PF.ADD | PF.STRETCH | PF.MINPX;
    S.fadeIn = 0; S.fadeOut = 0.5;
    pool.emit(S, now);
  }

  // smoke wisp: always in world space at the on-screen muzzle position
  const W = opts.viewmodel ? viewmodelToWorldMatched(worldPos, _W) : _W.copy(worldPos);
  const Wd = _Wd.copy(dir).normalize();
  const S2 = fx.pool.spec;
  const sun = M.smoke > 0 ? sunVisibility(W) : 1;
  for (let i = 0; i < M.smoke * fx.scale; i++) {
    S2.reset();
    S2.pos.copy(W).addScaledVector(Wd, 2 + R() * 6);
    S2.vel.copy(Wd).multiplyScalar(30 + R() * 60);
    S2.vel.y += 12 + R() * 10;
    S2.drag = 2.2; S2.gravity = -0.03;
    S2.life = 1.1 + R() * 1.2;
    S2.size0 = 1.2 * M.scale; S2.size1 = (8 + R() * 7) * M.scale;
    S2.rot = R() * 6.283; S2.rotVel = (R() - 0.5) * 1.5;
    const a = cls === 'suppressed' ? 0.42 : 0.3;
    S2.c0.set(0.7, 0.7, 0.68, a); S2.c1.set(0.7, 0.7, 0.68, 0);
    S2.sprite = i === 0 ? SPR.WISP : SPR.SMOKE0 + 8; S2.frames = i === 0 ? 1 : 8;
    S2.flags = PF.LIT | PF.TURB | PF.NEARFADE;
    S2.fadeIn = 0.05; S2.fadeOut = 0.4; S2.sun = sun; S2.seed = R();
    fx.pool.emit(S2, now);
  }

  // light: world light at the (matched) world position; view light for the gun/hands
  if (M.light > 0 && fx.cvar('fx_muzzle_light', 1) > 0) {
    _t.copy(W).addScaledVector(Wd, 6);
    fx.lights.spawn(now, _t, 0xffa050, 9000 * M.light * bright, 380 * Math.sqrt(M.light), 0.06, { prio: 0, owner: null });
    if (view) fx.flashViewLight(P, D, M.light * bright);
  }
}
