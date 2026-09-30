// BotManager — owns every bot, schedules their expensive work and wires them to the match.
//
//   World.bots.spawnTeam(team, count, difficulty)   create bots (Player instances, isBot)
//   World.bots.onRoundStart()                        reset plans, buy (also on 'round_start')
//   World.bots.tick(dt) / frame(dt, alpha)           called by the main loop
//   World.bots.frozen = true                         harness: bots stand still
//
// Budgets (10 bots): LOS checks are round-robined (~7 pair checks/tick + current targets every
// other tick), paths are queued (≤ 2 A* per tick), decisions run at ~8 Hz staggered, map intel
// is baked once at boot. Typical cost is well under 1 ms per 128 Hz tick.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { rng } from '../core/mathx.js';
import { Dbg } from '../core/debug.js';
import { Bot } from './brain.js';
import { makeProfile } from './aim.js';
import { MapIntel } from './intel.js';
import { TeamBrain } from './tactics.js';
import { pickName, reserveName, releaseName } from './names.js';
import { shoppingList, buyItem } from './buy.js';
import * as WI from './weaponinfo.js';
import { createBotPlayer } from './botplayer.js';

const _lift = new THREE.Vector3();
const HULL_MIN = new THREE.Vector3(-16, 0, -16), HULL_MAX = new THREE.Vector3(16, 72, 16), HULL_DUCK = new THREE.Vector3(16, 54, 16);

defCvar('bot_difficulty', 1, 0, 3, '0 easy, 1 normal, 2 hard, 3 expert (new bots)');
defCvar('bot_stop', 0, 0, 1, 'freeze all bots in place');
defCvar('bot_dont_shoot', 0, 0, 1, 'bots never press attack');
defCvar('bot_ignore_players', 0, 0, 1, 'bots do not see the local player');

const DIFF_NAMES = ['easy', 'normal', 'hard', 'expert'];

class BombState {
  constructor() { this.pos = new THREE.Vector3(); this.droppedPos = new THREE.Vector3(); this.reset(); }
  reset() {
    this.planted = false; this.site = null; this.plantTime = 0; this.dropped = false;
    this.defused = false; this.exploded = false; this.timer = 40;
  }
  timeLeft(now) { return this.planted ? this.timer - (now - this.plantTime) : Infinity; }
}

export class BotManager {
  constructor() {
    this.frozen = false;
    this.handlesBuying = true;          // rules.js skips its own bot buys
    this.bots = [];
    this.rnd = rng((Date.now() ^ 0x5eed) >>> 0);
    this.teams = { T: new TeamBrain(this, 'T'), CT: new TeamBrain(this, 'CT') };
    this.bomb = new BombState();
    this.intel = null;
    this.pathQueue = [];
    this.deferred = [];
    this.tickN = 0;
    this.pairCursor = 0;
    this.roundStartAt = -1;
    this.roundStartTime = 0;
    this.liveAt = 0;
    this.buyQueue = [];
    this.stats = { stuck: 0, kills: 0, deaths: 0, plants: 0, defuses: 0, paths: 0, pathMs: 0, tickMs: 0, tickMsMax: 0, ticks: 0 };
    this.log = [];
    this.playerMod = null;
    this._radioAt = new Map();

    /** Resolves when optional modules (player, economy) have been probed. */
    this.ready = Promise.all([
      WI.loadWeaponModules(),
      import('../player/player.js').then((m) => { this.playerMod = m; }).catch(() => {}),
    ]);
    this._bakeIntel();
    this._wire();
    if (World.params?.get?.('botsim')) {
      this.ready.then(() => import('./botsim.js')).then((m) => m.startBotSim(this)).catch((e) => console.error('[bots] botsim', e));
    }
  }

  _bakeIntel() {
    try {
      if (World.nav?.count && !this.intel) {
        this.intel = new MapIntel(World.nav, World.map);
        this.intel.ensure();
        Dbg.log('[bots] intel baked', this.intel.bakeMs.toFixed(0), 'ms');
      }
    } catch (err) {
      console.warn('[bots] map intel failed', err);
      this.intel = null;
    }
  }

  // ---- creation --------------------------------------------------------------------------

  /** Create `count` bots on `team`. difficulty: 'easy'|'normal'|'hard'|'expert' or 0..3. */
  spawnTeam(team, count = 5, difficulty) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.addBot(team, difficulty));
    return out;
  }

  addBot(team, difficulty, name) {
    const diff = difficulty ?? DIFF_NAMES[Math.round(World.cvar.bot_difficulty ?? 1)];
    const rnd = rng((this.rnd() * 4294967296) >>> 0);
    if (name) reserveName(name); else name = pickName(rnd);
    const ent = this._createEntity(team, name);
    if (!ent) return null;
    ent.isBot = true;
    ent.name ??= name;
    if (ent.money === undefined) ent.money = 800;
    const bot = new Bot(this, ent, makeProfile(diff, rnd), rnd);
    bot.difficulty = typeof diff === 'number' ? DIFF_NAMES[Math.round(diff)] || 'normal' : diff;
    ent.bot = bot;
    this.bots.push(bot);
    if (!ent.alive || ent.origin.lengthSq() === 0) this._placeAtSpawn(ent);
    bot.resetRound(World.time);
    if (this.teams[team]?.assigned) this.teams[team].assignRoles(World.time);
    return bot;
  }

  _createEntity(team, name) {
    const P = this.playerMod;
    try {
      if (P?.createPlayer) return P.createPlayer({ team, isBot: true, name });
    } catch (err) { console.error('[bots] createPlayer threw', err); }
    return createFallbackPlayer({ team, name });
  }

  _placeAtSpawn(ent) {
    const list = World.map?.spawns?.[ent.team] || [];
    if (!list.length) return;
    const used = World.entities.filter((e) => e !== ent && e.alive);
    let spawn = list.find((s) => used.every((e) => e.origin.distanceTo(s.pos) > 40)) || list[(this.rnd() * list.length) | 0];
    if (ent.respawn) ent.respawn(spawn);
    else { ent.origin.copy(spawn.pos); ent.yaw = spawn.yaw; ent.alive = true; ent.health = 100; }
    ent.yaw = spawn.yaw;
    ent.bot?.aim.reset(0, spawn.yaw);
  }

  kick(bot) {
    const i = this.bots.indexOf(bot);
    if (i < 0) return;
    this.bots.splice(i, 1);
    releaseName(bot.ent.name);
    if (this.playerMod?.removePlayer && !bot.ent._fallbackFrame) { this.playerMod.removePlayer(bot.ent); return; }
    const j = World.entities.indexOf(bot.ent);
    if (j >= 0) World.entities.splice(j, 1);
    bot.ent.model?.root?.removeFromParent?.();
    bot.ent.dispose?.();
  }

  kickAll() { for (const b of this.bots.slice()) this.kick(b); }
  removeAll() { this.kickAll(); }
  clear() { this.kickAll(); }

  // ---- round flow ------------------------------------------------------------------------

  onRoundStart() {
    const now = World.time;
    if (Math.abs(now - this.roundStartAt) < 0.5) return;   // rules call + event: once
    this.roundStartAt = now;
    this.roundStartTime = now;
    this.liveAt = now + this.freezeLeft();
    this.bomb.reset();
    this.roundOver = false;
    for (const t of Object.values(this.teams)) t.onRoundStart(now);
    for (const b of this.bots) {
      b.resetRound(now);
      b.aim.reset(0, b.ent.yaw || 0);
    }
    this._scheduleBuys(now);
    if (!this.intel) this._bakeIntel();
    const fc = World.nav?.failCost;
    if (fc) for (let i = 0; i < fc.length; i++) fc[i] *= 0.25;
    this.defer(() => { for (const b of this.bots) if (b.ent.alive && this.embedded(b.ent)) this.rescue(b); });
    for (const t of Object.values(this.teams)) if (this.intel?.ready) t.assignRoles(now);
  }

  _scheduleBuys(now) {
    this.buyQueue.length = 0;
    const ctx = { T: { awpTaken: false }, CT: { awpTaken: false } };
    for (const b of this.bots) {
      if (!b.ent.alive) continue;
      const mode = this.teams[b.team]?.econ || 'full';
      const list = shoppingList(b.ent, b.p, mode, b.rnd, ctx[b.team]);
      let t = now + 0.3 + b.rnd() * 2.2;
      for (const key of list) { this.buyQueue.push({ bot: b, key, at: t }); t += 0.15 + b.rnd() * 0.25; }
    }
  }

  _runBuys(now) {
    for (let i = this.buyQueue.length - 1; i >= 0; i--) {
      const q = this.buyQueue[i];
      if (now < q.at) continue;
      this.buyQueue.splice(i, 1);
      if (q.bot.ent.alive && buyItem(q.bot.ent, q.key)) {
        this.logEvent('buy', { bot: q.bot.ent.name, item: q.key });
        const cls = WI.weaponClass(q.key);
        if (cls !== 'grenade' && q.key !== 'kevlar' && q.key !== 'kevlarhelmet' && q.key !== 'defusekit') WI.switchTo(q.bot.ent, WI.bestGunKey(q.bot.ent));
      }
    }
  }

  // ---- queries used by bots / tactics ------------------------------------------------------

  teamOf(team) { return this.teams[team]; }

  freezeTime() {
    const m = World.match;
    if (this.sim) return this.sim.freeze > 0;
    if (!m) return false;
    if (typeof m.isFreezeTime === 'function') return !!m.isFreezeTime();
    if (typeof m.freezeTime === 'boolean') return m.freezeTime;
    if (m.phase === 'freeze' || m.state === 'freeze' || m.state === 'freezetime' || m.phase === 'freezetime') return true;
    return false;
  }

  freezeLeft() {
    const m = World.match;
    if (this.sim) return this.sim.freeze;
    if (m?.phase === 'freeze' && typeof m.timer === 'number') return Math.max(0, m.timer);
    for (const k of ['freezeLeft', 'freezeTimeLeft', 'phaseTimeLeft']) if (typeof m?.[k] === 'number') return this.freezeTime() ? m[k] : 0;
    return this.freezeTime() ? 15 : 0;
  }

  freezeLeftAt(start) { return Math.max(0, this.liveAt - start); }

  roundTimeLeft(now) {
    const m = World.match;
    if (this.sim) return this.sim.roundLeft;
    if (m?.started && typeof m.roundTime === 'number' && (m.phase === 'live' || m.phase === 'planted')) return m.roundTime;
    for (const k of ['roundTimeLeft', 'timeLeft', 'clock']) if (typeof m?.[k] === 'number' && !this.freezeTime()) return m[k];
    return this.liveAt + 115 - now;
  }

  isPistolRound() {
    if (this.sim) return this.sim.round === 1 && this.bots.every((b) => (b.ent.money ?? 800) <= 1000);
    const m = World.match;
    const r = m?.round ?? m?.roundNumber;
    if (typeof r === 'number') return r === 1 || r === 13 || (m?.half && r === (m.halfLength || 12) + 1);
    return this.bots.every((b) => (b.ent.money ?? 800) <= 1000 && !WI.slotItem(b.ent, 'primary'));
  }

  aliveCount(team) { let n = 0; for (const e of World.entities) if (e.alive && e.team === team) n++; return n; }

  queuePath(bot) { this.pathQueue.push(bot); }
  defer(fn) { this.deferred.push(fn); }

  separation(bot, out) {
    out.set(0, 0, 0);
    const o = bot.ent.origin, md = bot.moveDir;
    for (const b of this.bots) {
      if (b === bot || !b.ent.alive || b.team !== bot.team) continue;
      const dx = b.ent.origin.x - o.x, dz = b.ent.origin.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 80 * 80 || Math.abs(b.ent.origin.y - o.y) > 60) continue;
      const d = Math.sqrt(d2) || 1;
      if (dx * md.x + dz * md.z < 0) continue;              // only friends ahead of us
      const side = (md.x * dz - md.z * dx) > 0 ? 1 : -1;     // step to the side they're not on
      const w = (80 - d) / 80 * 1.1;
      out.x += md.z * side * w; out.z += -md.x * side * w;
    }
    return out;
  }

  /** A living teammate within `r` in front of the bot (movement direction)? */
  friendAhead(bot, r = 56) {
    const o = bot.ent.origin, md = bot.moveDir;
    for (const b of this.bots) {
      if (b === bot || !b.ent.alive || b.team !== bot.team) continue;
      const dx = b.ent.origin.x - o.x, dz = b.ent.origin.z - o.z;
      if (dx * dx + dz * dz > r * r || Math.abs(b.ent.origin.y - o.y) > 60) continue;
      if (dx * md.x + dz * md.z > 0) return true;
    }
    return false;
  }

  /** Is the entity's standing hull inside solid geometry? */
  embedded(ent) {
    const cw = World.collision;
    if (!cw || !ent?.origin) return false;
    // lifted a little: a hull resting exactly on a floor plane counts as touching, not stuck
    const maxs = ent.ducked ? HULL_DUCK : HULL_MAX;
    _lift.copy(ent.origin); _lift.y += 1;
    return cw.hullTrace(HULL_MIN, maxs, _lift, _lift).startSolid;
  }

  /** Move an embedded bot to the nearest free nav spot (bad spawn points happen). */
  rescue(bot) {
    const nav = World.nav, e = bot.ent;
    const k = nav?.nearest(e.origin);
    if (k < 0 || k === undefined) return;
    e.origin.set(nav.px[k], nav.py[k] + 0.5, nav.pz[k]);
    e.velocity?.set(0, 0, 0);
    e._snapInterp?.();
    this.stats.rescued = (this.stats.rescued || 0) + 1;
    this.logEvent('rescue', { bot: e.name, pos: e.origin.toArray().map(Math.round) });
  }

  /** Is a teammate already standing on (or right next to) this spot? */
  spotTaken(bot, pos) {
    for (const b of this.bots) {
      if (b === bot || !b.ent.alive || b.team !== bot.team) continue;
      if (Math.hypot(b.ent.origin.x - pos.x, b.ent.origin.z - pos.z) < 40) return true;
    }
    return false;
  }

  radio(bot, msg, pos) {
    if (!bot) return;
    const now = World.time, last = this._radioAt.get(bot) || -99;
    if (now - last < 4) return;
    this._radioAt.set(bot, now);
    World.emit('radio', { ent: bot.ent, msg, pos, area: pos ? World.nav?.areaOf?.(pos) : undefined });
  }

  logEvent(type, data) {
    const e = { t: +World.time.toFixed(2), type, ...data };
    this.log.push(e);
    if (this.log.length > 2000) this.log.splice(0, 500);
    Dbg.log('[bots]', type, data);
  }

  // Bomb fallbacks: only when no C4 implementation exists (weapons agent's c4.js owns this).
  _realBomb() { return !!((World.match?.bomb && World.match.started) || World.bomb || World.c4 || World.weapons?.c4); }

  planting(bot, now) {
    if (this._realBomb() || this.bomb.planted) return;
    if (now - bot.plantStart >= 3.2) {
      const site = this.intel?.siteAt(bot.ent.origin, 8)?.name || null;
      if (!site) return;
      World.emit('bomb_planted', { site, ent: bot.ent, pos: bot.ent.origin.clone() });
    }
  }

  defusing(bot, now) {
    if (this._realBomb() || !this.bomb.planted) return;
    if (bot.ent.origin.distanceTo(this.bomb.pos) > 60) return;
    if (now - bot.defuseStart >= (bot.ent.defuser ? 5 : 10)) World.emit('bomb_defused', { site: this.bomb.site, ent: bot.ent });
  }

  // ---- events ------------------------------------------------------------------------------

  _wire() {
    World.on('round_start', () => this.onRoundStart());
    World.on('round_end', () => { this.roundOver = true; });
    World.on('bomb_planted', (e) => {
      const b = this.bomb;
      b.planted = true; b.dropped = false; b.plantTime = World.time; b.site = e?.site || null;
      const p = e?.pos || World.bomb?.pos || World.c4?.pos || e?.ent?.origin;
      if (p) b.pos.copy(p);
      if (!b.site && this.intel) b.site = this.intel.nearestSite(b.pos)?.name || null;
      b.timer = World.match?.bombTime ?? World.cvar.mp_c4timer ?? 40;
      this.stats.plants++;
      this.logEvent('plant', { bot: e?.ent?.name, site: b.site });
    });
    World.on('bomb_defused', (e) => { this.bomb.planted = false; this.bomb.defused = true; this.stats.defuses++; this.logEvent('defuse', { bot: e?.ent?.name }); });
    World.on('bomb_exploded', () => { this.bomb.planted = false; this.bomb.exploded = true; this.logEvent('explode', {}); });
    World.on('bomb_dropped', (e) => { this.bomb.dropped = true; if (e?.pos) this.bomb.droppedPos.copy(e.pos); });
    World.on('bomb_pickup', () => { this.bomb.dropped = false; });
    // Ts with fire nades punish a defuse
    World.on('bomb_begindefuse', (e) => {
      const pos = this.bomb.planted ? this.bomb.pos : e?.ent?.origin;
      if (!pos) return;
      for (const b of this.bots) {
        if (b.team !== 'T' || !b.ent.alive) continue;
        const d = b.ent.origin.distanceTo(pos);
        if (d > 250 && d < 1300) b.nadeRequest = { target: pos.clone(), t: World.time };
      }
    });
    World.on('death', (e) => this._onDeath(e));
    World.on('damage', (e) => { if (e?.victim?.bot && e.attacker) e.victim.bot.hurtBy(e.attacker, World.time); });
    World.on('footstep', (e) => this._onSound(e?.ent, 1, 1100 * Math.min(1, (e?.volume ?? 0.5) * 2)));
    World.on('fire', (e) => {
      const k = WI.keyOf(e?.weapon);
      const silenced = k === 'm4a1s' || k === 'usp' || k === 'mp5sd';
      this._onSound(e?.ent, 2, silenced ? 900 : k === 'knife' ? 300 : 2600);
    });
  }

  _onSound(ent, level, radius) {
    if (!ent?.origin || !ent.alive) return;
    const now = World.time, r2 = radius * radius;
    for (const b of this.bots) {
      if (!b.ent.alive || b.team === ent.team) continue;
      if (b.ent.origin.distanceToSquared(ent.origin) < r2) b.hear(ent.origin, level, now, ent);
    }
  }

  _onDeath(e) {
    const v = e?.victim, a = e?.attacker;
    if (!v) return;
    const now = World.time;
    if (a?.bot && a !== v && a.team !== v.team) { a.bot.stats.kills++; this.stats.kills++; }
    if (v.bot) this.stats.deaths++;
    this.logEvent('kill', { killer: a?.name, kt: a?.team, victim: v.name, vt: v.team, weapon: WI.keyOf(e.weapon), hs: !!e.headshot,
      area: World.nav?.areaOf?.(v.origin) || '', dist: a ? Math.round(a.origin.distanceTo(v.origin)) : 0 });
    // bomb carrier dropped the C4 where he died
    if (v.team === 'T' && (WI.hasC4(v) || this.bomb.carrier === v) && !this.bomb.planted) {
      this.bomb.dropped = true; this.bomb.droppedPos.copy(v.origin);
    }
    // teammates nearby learn where the shot came from (trade)
    for (const b of this.bots) {
      if (!b.ent.alive || b.team !== v.team || b.ent === v) continue;
      if (b.ent.origin.distanceTo(v.origin) < 1500 && a && a.team !== b.team) {
        b.threatPos.copy(a.origin); b.threatTime = now;
        b.hear(a.origin, 2, now, a);
      }
    }
    this.teams[v.team]?.teammateDied(v.origin, now);
    if (v.bot) { v.bot.target = null; v.bot.path = null; }
  }

  // ---- per tick ------------------------------------------------------------------------------

  tick(dt) {
    const t0 = performance.now();
    const now = World.time;
    this.tickN++;
    if (this.deferred.length) { const d = this.deferred.splice(0); for (const f of d) f(); }
    if (this.roundStartAt < 0 && this.bots.length) this.onRoundStart();
    if (!this.bots.length) return;
    const frozen = this.frozen || World.cvar.bot_stop;
    if (!frozen) {
      if (this.buyQueue.length) this._runBuys(now);
      this._trackBomb(now);
      for (const t of Object.values(this.teams)) t.update(now);
      this._perceive(now);
      this._runPaths();
    }
    for (const b of this.bots) {
      if (!b.ent.alive) continue;
      if (frozen) { b.cmd.buttons = 0; b.cmd.forwardmove = b.cmd.sidemove = 0; b.issue(dt); continue; }
      b.update(dt, now);
      if (World.cvar.bot_dont_shoot) b.cmd.buttons &= ~1;
    }
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ticks++; s.tickMs += (ms - s.tickMs) * 0.01; if (ms > s.tickMsMax) s.tickMsMax = ms;
    s.tickMsTotal = (s.tickMsTotal || 0) + ms;
  }

  _trackBomb(now) {
    // the rules module owns the real bomb: mirror its state
    const mb = World.match?.started ? World.match.bomb : null;
    if (mb) {
      const b = this.bomb;
      b.carrier = mb.state === 'carried' ? mb.carrier : null;
      b.dropped = mb.state === 'dropped';
      if (b.dropped) b.droppedPos.copy(mb.pos);
      if (mb.state === 'planted') {
        if (!b.planted) { b.planted = true; b.pos.copy(mb.pos); b.site = mb.site; }
        b.timer = mb.timer + (now - b.plantTime);   // timeLeft(now) == mb.timer
      } else if (b.planted && mb.state !== 'planted') b.planted = false;
      return;
    }
    if ((this.tickN & 15) !== 0 || this.bomb.planted) return;
    let carrier = null;
    for (const e of World.entities) if (e.alive && e.team === 'T' && WI.hasC4(e)) { carrier = e; break; }
    this.bomb.carrier = carrier;
    if (carrier) this.bomb.dropped = false;
    const real = World.bomb || World.c4;
    if (real?.dropped && real.pos) { this.bomb.dropped = true; this.bomb.droppedPos.copy(real.pos); }
  }

  _perceive(now) {
    const bots = this.bots, ents = World.entities;
    const E = ents.length, B = bots.length;
    if (!E || !B) return;
    const ignoreLocal = World.cvar.bot_ignore_players || this.sim;
    // 1) current targets: every other tick
    for (const b of bots) {
      if (!b.ent.alive || !b.target) continue;
      if (((this.tickN + b.id) & 1) === 0) b.checkVisibility(b.target, now);
    }
    // 2) round-robin the remaining pairs
    const total = E * B;
    const budget = Math.max(4, Math.ceil(total / 10));
    let done = 0;
    for (let n = 0; n < total && done < budget; n++) {
      this.pairCursor = (this.pairCursor + 1) % total;
      const b = bots[(this.pairCursor / E) | 0], e = ents[this.pairCursor % E];
      if (!b || !e || !b.ent.alive || !e.alive || e === b.ent || e.team === b.team || !e.team || e === b.target) continue;
      if (e.spectator || (ignoreLocal && e.isLocal)) continue;
      const m = b.known.get(e);
      if (m && now - m.lastCheck < 0.05) continue;
      b.checkVisibility(e, now);
      done++;
    }
  }

  _runPaths() {
    let n = 0;
    const t0 = performance.now();
    while (this.pathQueue.length && n < 2) {
      const b = this.pathQueue.shift();
      if (!b.ent.alive || !b.pathPending) { b.pathPending = false; continue; }
      b.computePath();
      n++;
      if (performance.now() - t0 > 1.2) break;
    }
    if (n) { this.stats.paths += n; this.stats.pathMs += performance.now() - t0; }
  }

  /** Render-rate: interpolate + pose every bot's third-person model (main.js only frames the local player). */
  frame(dt, alpha) {
    if (World.cvar.nav_draw && World.nav && !World.nav._debug) World.nav.setDebugVisible?.(true);
    for (const b of this.bots) {
      const e = b.ent;
      if (e._fallbackFrame) { e._fallbackFrame(dt); continue; }
      try { e.frame?.(dt, alpha); }
      catch (err) { console.error('[bots] ent.frame threw', err); e.frame = null; }
    }
  }

  /** Summary for tools/tests. */
  report() {
    const s = this.stats;
    return {
      bots: this.bots.length, alive: this.bots.filter((b) => b.ent.alive).length,
      stuck: s.stuck, kills: s.kills, plants: s.plants, defuses: s.defuses,
      paths: s.paths, pathMsAvg: s.paths ? s.pathMs / s.paths : 0,
      tickMsAvg: s.ticks ? s.tickMsTotal / s.ticks : 0, tickMsMax: s.tickMsMax,
      intelMs: this.intel?.bakeMs, navMs: World.nav?.bakeMs,
    };
  }
}

// ---- fallback entity (only if src/player/player.js has no createPlayer yet) ------------------
function createFallbackPlayer(o) { return createBotPlayer(o); }
