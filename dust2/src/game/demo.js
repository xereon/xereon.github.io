// Harness-only "live-looking" HUD state so the interface can be judged in screenshots
// (?harness&hud=1, ?harness&ui=buymenu|scoreboard|roundend|...). Never used in real play.
import * as THREE from 'three';
import { World } from '../core/world.js';

const P = (name, team, extra = {}) => ({
  name, team, alive: true, health: 100, armor: 100, helmet: true, money: 0, isBot: true, isLocal: false,
  origin: new THREE.Vector3(), yaw: 0, inventory: { primary: null, secondary: null, grenades: [] }, ...extra,
});

let roster = null;
export function demoRoster() {
  if (roster) return roster;
  const T = [
    P('Player', 'T', { isBot: false, isLocal: true, money: 3150, inventory: { primary: 'ak47', secondary: 'glock', knife: 'knife', grenades: ['flashbang', 'smokegrenade', 'molotov'], c4: null } }),
    P('Vitaliy', 'T', { money: 1850, health: 64, inventory: { primary: 'ak47' } }),
    P('Crusher', 'T', { money: 700, inventory: { primary: 'awp' } }),
    P('Kosta', 'T', { alive: false, health: 0, money: 2450, inventory: {} }),
    P('Ramil', 'T', { money: 4200, health: 23, inventory: { primary: 'galil', c4: 'c4' } }),
  ];
  const CT = [
    P('Lukas', 'CT', { alive: false, health: 0, money: 5400 }),
    P('Maddox', 'CT', { alive: false, health: 0, money: 900 }),
    P('Finn', 'CT', { money: 2100, health: 71, inventory: { primary: 'm4a1s' } }),
    P('Ezra', 'CT', { money: 350, inventory: { primary: 'famas' } }),
    P('Callum', 'CT', { money: 6200, health: 88, inventory: { primary: 'awp' } }),
  ];
  const stats = new Map();
  const S = (e, k, a, d, adr, hs, mvps, score) => stats.set(e, { kills: k, assists: a, deaths: d, damage: adr * 13, hs: Math.round(k * hs), mvps, score });
  S(T[0], 17, 4, 9, 104.6, 0.53, 4, 42); S(T[1], 12, 6, 11, 88.2, 0.42, 2, 33); S(T[2], 10, 2, 10, 71.9, 0.2, 2, 24);
  S(T[3], 6, 5, 12, 55.3, 0.33, 0, 18); S(T[4], 8, 3, 11, 61.0, 0.5, 1, 20);
  S(CT[0], 14, 3, 10, 93.4, 0.57, 3, 35); S(CT[1], 9, 7, 12, 70.1, 0.44, 1, 27); S(CT[2], 11, 2, 11, 76.5, 0.36, 1, 27);
  S(CT[3], 7, 4, 13, 58.8, 0.43, 0, 19); S(CT[4], 12, 1, 9, 84.0, 0.25, 1, 28);
  const history = [];
  const reasons = ['elimination', 'elimination', 'bomb_exploded', 'elimination', 'time', 'bomb_defused', 'elimination'];
  const wins = 'TTCCTCTCCTCT'.split('').map((c) => (c === 'T' ? 'T' : 'CT'));
  wins.push('T');
  wins.forEach((w, i) => {
    let r = reasons[(i * 3 + 1) % reasons.length];
    if (w === 'T' && (r === 'time' || r === 'bomb_defused')) r = 'elimination';
    if (w === 'CT' && r === 'bomb_exploded') r = 'bomb_defused';
    history.push({ round: i + 1, winner: i >= 12 ? (w === 'T' ? 'CT' : 'T') : w, reason: r });
  });
  roster = { T, CT, all: [...T, ...CT], stats, history, score: { T: 7, CT: 6 } };
  return roster;
}

/** Place the demo roster around the current camera so the radar has content. */
export function demoPositions() {
  const r = demoRoster();
  const c = World.camera?.position || new THREE.Vector3();
  const yaw = World.input?.yaw ?? 0;
  const rad = (yaw * Math.PI) / 180;
  const fx = Math.cos(rad), fz = -Math.sin(rad), rx = Math.sin(rad), rz = Math.cos(rad);
  const place = (e, f, s, y) => { e.origin.set(c.x + fx * f + rx * s, c.y - 64, c.z + fz * f + rz * s); e.yaw = yaw + y; };
  place(r.T[0], 0, 0, 0);
  place(r.T[1], -260, 180, 40); place(r.T[2], -600, -320, -30); place(r.T[3], 420, 380, 0); place(r.T[4], -150, -120, 10);
  place(r.CT[0], 700, 260, 180); place(r.CT[1], 980, -200, 180); place(r.CT[2], 820, 520, 200);
  place(r.CT[3], 1500, 900, 160); place(r.CT[4], 2100, -500, 190);
  return r;
}
