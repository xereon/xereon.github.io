// Bots-only simulation (?botsim=1): 5v5 bots, the local player spectates.
//
// Uses the real MatchController when ?botsim=rules, otherwise a tiny round loop of its own
// (freeze -> live -> bomb -> end -> respawn) so the AI can be exercised while the rules,
// weapons and C4 modules are still being written. When no WeaponSystem exists, a minimal
// hitscan rifle stands in so fights resolve. Exposes window.__botsim for tools/aisim.mjs.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { IN_ATTACK, IN_RELOAD, IN_DUCK } from '../core/input.js';
import { angleVectors } from '../core/mathx.js';
import { MASK_SHOT } from '../player/collision.js';

export function startBotSim(mgr) {
  const params = World.params;
  const mode = params.get('botsim');
  const diff = params.get('botdiff') || 'normal';
  const [diffT, diffCT = diffT] = diff.split(',');
  const n = +(params.get('botn') || 5);
  const sim = {
    freeze: 0, roundLeft: 115, round: 0, score: { T: 0, CT: 0 }, over: false, overAt: 0,
    freezeLen: +(params.get('botfreeze') || 3), ttk: [], firstContact: [], areas: {}, started: false,
    money: +(params.get('botmoney') || 800),
    ownRules: mode !== 'rules' || !World.match?.start,
  };
  // engagement time-to-kill (first sight -> kill), both rule modes
  World.on('death', (e) => {
    const a = e?.attacker?.bot, v = e?.victim;
    if (!a || !v) return;
    const m = a.known.get(v);
    if (m && m.firstSeen > 0) { const t = World.time - m.firstSeen; if (t >= 0 && t < 8) sim.ttk.push(t); }
  });
  const begin = () => {
    if (sim.started) return;
    sim.started = true;
    if (World.local) { World.local.spectator = true; World.local.alive = World.local.alive && !sim.ownRules ? World.local.alive : false; }
    if (!sim.ownRules) {
      // real MatchController running 5v5 bots; the local player (if any) spectates
      World.on('round_start', () => { if (World.local) { World.local.alive = false; World.local.spectator = true; } });
      World.on('round_end', (e) => mgr.logEvent('round_end', { winner: e?.winner, reason: e?.reason, round: e?.round, score: `${World.match.score?.T}-${World.match.score?.CT}` }));
      World.cvar.mp_freezetime = sim.freezeLen;
      // beginMatch() (re)spawns the bots itself: force n per side and per-side difficulty
      const spawn = mgr.spawnTeam.bind(mgr);
      mgr.spawnTeam = (team, count, d) => spawn(team, n, team === 'T' ? diffT : diffCT);
      if (sim.money !== 800) World.on('round_start', () => { if (World.match.history?.length === 0) for (const b of mgr.bots) b.ent.money = sim.money; });
      World.match.beginMatch?.('T', { difficulty: diffT, teamSize: n });
      mgr.sim = null;
      mgr.simStats = sim;
      return;
    }
    mgr.sim = sim;
    mgr.spawnTeam('T', n, diffT);
    mgr.spawnTeam('CT', n, diffCT);
    sim.guns = World.weapons?.give ? null : new SimGuns();
    newRound();
  };

  function newRound() {
    sim.round++; sim.over = false; sim.freeze = sim.freezeLen; sim.roundLeft = 115;
    const spawns = World.map?.spawns || {};
    for (const team of ['T', 'CT']) {
      const bots = mgr.bots.filter((b) => b.team === team);
      bots.forEach((b, i) => {
        const list = spawns[team] || [];
        const s = list[i % Math.max(1, list.length)];
        if (s) {
          if (b.ent.respawn) b.ent.respawn(s); else { b.ent.origin.copy(s.pos); b.ent.alive = true; b.ent.health = 100; }
          b.ent.yaw = s.yaw;
        }
        if (sim.round === 1) b.ent.money = sim.money;
        b.ent.money = Math.min(16000, (b.ent.money ?? 800));
        if (sim.guns) sim.guns.equip(b.ent);
        const W = World.weapons;
        if (W?.remove && b.ent.inventory?.c4) W.remove(b.ent, 'c4');
        else if (b.ent.inventory) b.ent.inventory.c4 = null;
        // CS: the dead re-kit with knife + pistol, survivors keep their guns
        if (W?.give && !W.inventoryHasGun?.(b.ent) && !b.ent.inventory?.secondary && !b.ent.inventory?.primary) {
          W.give(b.ent, 'knife'); W.give(b.ent, b.team === 'T' ? 'glock' : 'usp');
        }
      });
      if (team === 'T' && bots.length) {
        const c = bots[(Math.random() * bots.length) | 0].ent;
        if (World.weapons?.give) World.weapons.give(c, 'c4'); else if (c.inventory) c.inventory.c4 = 'c4';
      }
    }
    mgr.roundStartAt = -1;
    World.emit('round_start', { round: sim.round });
    mgr.onRoundStart();
  }

  function endRound(winner, reason) {
    if (sim.over) return;
    sim.over = true; sim.overAt = World.time;
    sim.score[winner]++;
    for (const b of mgr.bots) b.ent.money = Math.min(16000, (b.ent.money ?? 0) + (b.team === winner ? 3250 : 1900));
    mgr.logEvent('round_end', { winner, reason, round: sim.round, score: `${sim.score.T}-${sim.score.CT}` });
    World.emit('round_end', { round: sim.round, winner, reason });
  }

  sim.tick = (dt) => {
    if (!sim.ownRules || !sim.started) return;
    if (sim.over) { if (World.time - sim.overAt > 3) newRound(); return; }
    if (sim.freeze > 0) { sim.freeze -= dt; if (sim.freeze <= 0) mgr.liveAt = World.time; return; }
    sim.roundLeft -= dt;
    const aT = mgr.aliveCount('T'), aCT = mgr.aliveCount('CT');
    const bomb = mgr.bomb;
    if (bomb.planted && bomb.timeLeft(World.time) <= 0) { World.emit('bomb_exploded', { site: bomb.site }); endRound('T', 'bomb_exploded'); return; }
    if (bomb.defused) { endRound('CT', 'bomb_defused'); return; }
    if (!aCT) { endRound('T', 'elimination'); return; }
    if (!aT && !bomb.planted) { endRound('CT', 'elimination'); return; }
    if (sim.roundLeft <= 0 && !bomb.planted) { endRound('CT', 'time'); return; }
    sim.guns?.tick(dt);
    // stand-in C4 drop/pickup (the weapons module owns this in the real game)
    {
      const W = World.weapons;
      for (const b of mgr.bots) if (!b.ent.alive && b.ent.inventory?.c4) {
        if (W?.remove) W.remove(b.ent, 'c4'); else b.ent.inventory.c4 = null;
        bomb.dropped = true; bomb.droppedPos.copy(b.ent.origin);
      }
      if (bomb.dropped && !bomb.planted) for (const b of mgr.bots) {
        if (b.team === 'T' && b.ent.alive && b.ent.origin.distanceTo(bomb.droppedPos) < 48) {
          if (W?.give) W.give(b.ent, 'c4'); else b.ent.inventory.c4 = 'c4';
          bomb.dropped = false; World.emit('bomb_pickup', { ent: b.ent }); break;
        }
      }
    }
    // where are the bots? (route diversity)
    if ((mgr.tickN & 127) === 0) for (const b of mgr.bots) if (b.ent.alive) {
      const a = World.nav?.areaOf?.(b.ent.origin) || '?';
      const k = `${b.team}:${a}`;
      sim.areas[k] = (sim.areas[k] || 0) + 1;
    }
  };


  // hook our tick in front of the bots
  const origTick = mgr.tick.bind(mgr);
  mgr.tick = (dt) => { sim.tick(dt); origTick(dt); };

  if (typeof window !== 'undefined') {
    window.__botsim = {
      sim, mgr,
      /** Run `sec` seconds of simulation synchronously (no rendering). */
      step(sec, dt = World.tickInterval) {
        const steps = Math.round(sec / dt);
        for (let i = 0; i < steps; i++) {
          World.time += dt;
          World.bots?.tick?.(dt);
          World.weapons?.tick?.(dt);
          if (!sim.ownRules) World.match?.tick?.(dt);
          for (const e of World.entities) if (e !== World.local && !e.isBot) e.tick?.(dt);
          if ((i & 3) === 0) { World.weapons?.frame?.(dt * 4); World.fx?.update?.(dt * 4); }
        }
        World.bots?.frame?.(dt, 1);
        return this.report();
      },
      report() {
        const r = mgr.report();
        const ttk = sim.ttk.slice().sort((x, y) => x - y);
        return { ...r, round: sim.round, score: sim.score, time: +World.time.toFixed(1),
          ttkAvg: ttk.length ? ttk.reduce((s, x) => s + x, 0) / ttk.length : null, ttkMedian: ttk.length ? ttk[ttk.length >> 1] : null, ttkN: ttk.length };
      },
      log: () => mgr.log,
      areas: () => sim.areas,
    };
  }

  if (typeof window !== 'undefined' && window.__READY) begin();
  else World.on('ready', begin);
}

// ---- stand-in hitscan rifle (only when there is no WeaponSystem) ----------------------------
const _dir = new THREE.Vector3(), _eye = new THREE.Vector3(), _end = new THREE.Vector3();
const _av = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const MUL = { 1: 4, 2: 1, 3: 1.25, 4: 1, 5: 1, 6: 0.75, 7: 0.75 };

export class SimGuns {
  equip(ent) {
    const key = ent.team === 'T' ? 'ak47' : 'm4a4';
    ent.inventory.primary = { key, clip: 30, reserve: 90, reloading: false };
    ent.inventory.secondary = { key: ent.team === 'T' ? 'glock' : 'usp', clip: 20, reserve: 100 };
    ent.active = 'primary';
    ent.armor = 100; ent.helmet = true;
    ent._g = { cool: 0, shots: 0, reloadT: 0, lastAttack: false };
  }
  tick(dt) {
    for (const ent of World.entities) {
      if (!ent.alive || !ent.isBot || !ent._g) continue;
      const g = ent._g, w = ent.inventory.primary;
      const cmd = ent.lastCmd;
      g.cool -= dt;
      if (w.reloading) { g.reloadT -= dt; if (g.reloadT <= 0) { const n = Math.min(30 - w.clip, w.reserve); w.clip += n; w.reserve -= n; w.reloading = false; } continue; }
      if (cmd && (cmd.buttons & IN_RELOAD) && w.clip < 30 && w.reserve > 0) { w.reloading = true; g.reloadT = 2.5; continue; }
      const atk = cmd && (cmd.buttons & IN_ATTACK);
      if (!atk) { g.shots = Math.max(0, g.shots - dt * 12); }
      if (atk && g.cool <= 0 && w.clip > 0) {
        g.cool = 0.1; w.clip--; g.shots++;
        // simple spray: vertical climb then horizontal wander; aim punch = half the visual kick
        const s = g.shots;
        ent.aimPunch.pitch -= Math.min(0.5, 0.18 + s * 0.02);
        ent.aimPunch.yaw += s > 8 ? (Math.sin(s * 0.7) * 0.35) : 0;
        const speed = Math.hypot(ent.velocity.x, ent.velocity.z);
        const inacc = (speed > 110 ? 6 : speed > 60 ? 2.5 : 0.35) * (cmd.buttons & IN_DUCK ? 0.7 : 1) + Math.min(s, 10) * 0.08;
        const sc = World.cvar.weapon_recoil_scale ?? 2;
        const pitch = ent.pitch + ent.aimPunch.pitch * sc, yaw = ent.yaw + ent.aimPunch.yaw * sc;
        const r1 = Math.random() * Math.PI * 2, r2 = Math.random() * inacc;
        angleVectors(pitch + Math.sin(r1) * r2, yaw + Math.cos(r1) * r2, _av);
        ent.eyePos ? ent.eyePos(_eye) : _eye.set(ent.origin.x, ent.origin.y + 64, ent.origin.z);
        _end.copy(_eye).addScaledVector(_av.forward, 8192);
        World.emit('fire', { ent, weapon: w.key, seed: s });
        const tr = World.collision.rayTrace(_eye, _end, MASK_SHOT, ent);
        if (tr.entity && tr.entity.alive) {
          const d = tr.fraction * 8192;
          let dmg = (w.key === 'ak47' ? 36 : 33) * Math.pow(0.98, d / 500) * (MUL[tr.hitgroup] || 1);
          tr.entity.takeDamage?.({ amount: dmg, hitgroup: tr.hitgroup, attacker: ent, weapon: w.key, armorPen: 0.775 });
        }
      }
    }
  }
}
