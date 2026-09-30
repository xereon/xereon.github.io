// CS2 competitive match flow: MR12 (first to 13), MR3 overtime, freeze/buy time, economy,
// C4 (carry / drop / plant / defuse / detonate), win conditions, stats, MVP.
// UI lives in hud.js; this module only owns rules + state and talks through World events.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { IN_USE, IN_ATTACK } from '../core/input.js';
import {
  ECON, Economy, FORMAT, formatAfterRound, clampMoney, canBuy, item, setRegistry,
  DEFAULT_PISTOL, keyOf, grenadeCounts,
} from './economy.js';
import { Settings } from './settings.js';
import { BombModel } from './bomb.js';

defCvar('mp_freezetime', FORMAT.FREEZE, 0, 60, 'freeze time at round start (s)');
defCvar('mp_roundtime', FORMAT.ROUND, 10, 600, 'round length (s)');
defCvar('mp_c4timer', FORMAT.BOMB, 10, 90, 'bomb fuse (s)');
defCvar('mp_round_restart_delay', FORMAT.ROUND_END, 1, 15, 'delay after round end (s)');
defCvar('mp_buytime', FORMAT.BUY, 0, 120, 'buy time after freeze (s)');
defCvar('mp_halftime_duration', FORMAT.HALFTIME, 0, 30, 'halftime pause (s)');

const BOT_NAMES = {
  T: ['Vitaliy', 'Crusher', 'Kosta', 'Ramil', 'Arkady', 'Dusan'],
  CT: ['Lukas', 'Maddox', 'Finn', 'Ezra', 'Callum', 'Rhys'],
};

const DEFUSE_RANGE = 62;
const PICKUP_RANGE = 44;
const _v = new THREE.Vector3();

const other = (t) => (t === 'T' ? 'CT' : 'T');
const inZone = (p, z, pad = 0) => !!z && p &&
  p.x >= z.min.x - pad && p.x <= z.max.x + pad &&
  p.z >= z.min.z - pad && p.z <= z.max.z + pad &&
  p.y >= z.min.y - 72 && p.y <= z.max.y + 72;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export class MatchController {
  constructor() {
    this.phase = 'idle';       // idle | menu | warmup | freeze | live | planted | roundend | halftime | matchend
    this.timer = 0;            // seconds left in the current phase
    this.roundTime = 0;        // round clock (live phase)
    this.buyTimeLeft = 0;
    this.score = { T: 0, CT: 0 };
    this.history = [];         // [{ round, winner, reason }]
    this.overtime = 0;         // 0 = regulation, 1.. = OT period
    this.swaps = 0;            // side swaps so far (history entries record it)
    this.economy = new Economy();
    this.stats = new Map();    // ent -> stats
    this.lastRoundEnd = null;
    this.matchWinner = null;
    this._localTeam = 'T';
    this._pending = null;      // what to do when the round-end timer expires
    this.deaths = [];          // this round's death marks for the radar
    this.dmgTable = new Map(); // victim -> Map(attacker -> dmg) this life (assists)
    this.lastHit = new Map();  // victim -> { penetrated, attacker }
    this.spawnPos = new Map(); // ent -> spawn position (freeze time lock)
    this.useHeldAt = new Map();// ent -> World.time of last use() call (bot API)
    this.bomb = {
      state: 'none',           // none | carried | dropped | planted | defused | exploded
      carrier: null, planter: null, defuser: null,
      pos: new THREE.Vector3(), site: null, timer: 0, beepAt: 0,
      plantProgress: 0, plantPos: new THREE.Vector3(),
      defuseProgress: 0, defuseTime: FORMAT.DEFUSE, defusePos: new THREE.Vector3(),
    };
    Object.defineProperty(this.bomb, 'timeLeft', { get() { return this.state === 'planted' ? Math.max(0, this.timer) : null; }, enumerable: false });
    this.bombModel = new BombModel();
    this.sideHadPlayers = { T: false, CT: false };
    this.started = false;

    try { if (World.scene) this.bombModel.preload(); } catch (e) { console.warn('[match] bomb model', e); }
    this._loadRegistry();

    World.on('death', (e) => this._onDeath(e));
    World.on('damage', (e) => this._onDamage(e));
    World.on('bomb_planted', (e) => this._onBombPlanted(e));
    World.on('bomb_defused', (e) => this._onBombDefused(e));
    World.on('bomb_exploded', (e) => this._onBombExploded(e));
  }

  get localTeam() { return this._localTeam; }
  set localTeam(t) { this._localTeam = t === 'CT' ? 'CT' : 'T'; }
  get freezeTime() { return this.phase === 'freeze'; }
  get frozen() { return this.phase === 'freeze'; }
  get roundNumber() { return this.history.length + (this.phase === 'roundend' || this.phase === 'halftime' || this.phase === 'matchend' ? 0 : 1); }
  get isLive() { return this.phase === 'live' || this.phase === 'planted'; }

  async _loadRegistry() {
    const direct = World.weapons?.WEAPONS || World.weapons?.registry || World.WEAPONS;
    if (direct) { setRegistry(direct); return; }
    // Only import when some other module already pulled registry.js in (avoids a 404 while
    // the weapons module is still a stub).
    let loaded = false;
    try { loaded = performance.getEntriesByType('resource').some((e) => /\/weapons\/registry\.js(\?|$)/.test(e.name)); } catch { loaded = false; }
    if (!loaded) return;
    try { const m = await import('../weapons/registry.js'); setRegistry(m.WEAPONS || m.default || null); }
    catch (e) { console.warn('[match] registry import failed', e); }
  }

  // ---- lifecycle ------------------------------------------------------------------------
  /** Called by main.js outside the harness: show the main menu over the flyover. */
  start() {
    this.phase = 'menu';
    World.hud?.showMainMenu?.();
  }

  /** Team select -> live match. opts: { difficulty, teamSize } */
  beginMatch(team, opts = {}) {
    if (team === 'auto' || !team) team = Math.random() < 0.5 ? 'T' : 'CT';
    this.localTeam = team;
    const difficulty = opts.difficulty || Settings.difficulty || 'normal';
    const size = Math.max(1, Math.min(5, opts.teamSize || Settings.teamSize || 5));
    const local = World.local;
    if (local) {
      local.team = team;
      local.name = Settings.name || 'Player';
      local.isLocal = true;
    }

    // Bots: reuse existing (rematch) with their original sides, else spawn fresh.
    const bots = World.entities.filter((e) => e.isBot);
    if (bots.length && World.bots?.removeAll) { World.bots.removeAll(); }
    else if (bots.length && World.bots?.clear) { World.bots.clear(); }
    if (!World.entities.some((e) => e.isBot)) {
      try {
        World.bots?.spawnTeam?.(team, size - (local ? 1 : 0), difficulty);
        World.bots?.spawnTeam?.(other(team), size, difficulty);
      } catch (e) { console.error('[match] spawnTeam failed', e); }
    } else {
      for (const b of World.entities) if (b.isBot && b._origTeam) b.team = b._origTeam;
    }
    const used = { T: 0, CT: 0 };
    for (const e of World.entities) {
      if (e.isBot) {
        e._origTeam = e._origTeam || e.team;
        if (!e.name) e.name = BOT_NAMES[e.team]?.[used[e.team]++ % 6] || 'Bot';
      }
    }
    if (World.bots && !(World.harness && !World.params?.has('live'))) World.bots.frozen = false;

    this.score = { T: 0, CT: 0 };
    this.history = [];
    this.overtime = 0;
    this.swaps = 0;
    this.matchWinner = null;
    this.economy.resetHalf();
    this.stats.clear();
    for (const e of this.players()) {
      e.money = ECON.START;
      this._strip(e);
      e.armor = 0; e.helmet = false; e.defuser = false;
      this.stat(e);
    }
    this.started = true;
    World.hud?.onMatchBegin?.();
    World.emit('match_start', { team });
    this._startRound(true);
  }

  /** Leave the match and return to the main menu. */
  toMenu() {
    this.phase = 'menu';
    this.started = false;
    this.bomb.state = 'none';
    this.bombModel.hide();
    if (World.bots) World.bots.frozen = true;
    World.hud?.showMainMenu?.();
  }

  players() {
    const out = [];
    for (const e of World.entities) if (e && (e.team === 'T' || e.team === 'CT')) out.push(e);
    return out;
  }

  stat(e) {
    let s = this.stats.get(e);
    if (!s) {
      s = { ent: e, kills: 0, deaths: 0, assists: 0, hs: 0, damage: 0, mvps: 0, score: 0, roundKills: 0, roundDamage: 0, plants: 0, defuses: 0, clutch: 0 };
      this.stats.set(e, s);
    }
    return s;
  }

  adr(e) { const s = this.stats.get(e); return s ? s.damage / Math.max(1, this.history.length) : 0; }

  // ---- rounds ---------------------------------------------------------------------------
  _startRound(first = false) {
    const map = World.map;
    this.deaths.length = 0;
    this.dmgTable.clear();
    this.lastHit.clear();
    this.lastRoundEnd = null;
    this._pending = null;
    const b = this.bomb;
    b.state = 'none'; b.carrier = b.planter = b.defuser = null; b.site = null;
    b.plantProgress = 0; b.defuseProgress = 0;
    this.bombModel.hide();

    const freeze = World.harness ? 0 : World.cvar.mp_freezetime;
    const lists = { T: shuffle([...(map?.spawns?.T || [])]), CT: shuffle([...(map?.spawns?.CT || [])]) };
    const idx = { T: 0, CT: 0 };
    const pl = this.players();
    this.sideHadPlayers.T = pl.some((e) => e.team === 'T');
    this.sideHadPlayers.CT = pl.some((e) => e.team === 'CT');
    // local player first so they never get the "overflow" spawn
    pl.sort((a, c) => (c === World.local) - (a === World.local));
    for (const e of pl) {
      const s = this.stat(e);
      s.roundKills = 0; s.roundDamage = 0;
      const list = lists[e.team];
      const sp = list.length ? list[idx[e.team]++ % list.length] : null;
      // Survivors keep weapons + armor; the dead (and everyone after a side swap) re-kit.
      const survived = !first && !this._rekitAll && e.alive !== false;
      const armor = e.armor, helmet = e.helmet, defuser = e.defuser;
      this._respawn(e, sp);
      if (survived) { e.armor = armor; e.helmet = helmet; e.defuser = defuser; }
      else {
        e.armor = 0; e.helmet = false; e.defuser = false;
        this._strip(e);
        this._give(e, 'knife');
        this._give(e, DEFAULT_PISTOL[e.team]);
      }
      if (sp) this.spawnPos.set(e, (this.spawnPos.get(e) || new THREE.Vector3()).copy(sp.pos));
      e.frozen = freeze > 0; // Player honours this: no movement, looking allowed
    }

    this._rekitAll = false;

    // C4 to a random terrorist (a surviving carrier's old bomb is taken back first)
    for (const e of pl) {
      if (keyOf(e.inventory?.c4) !== 'c4') continue;
      try { World.weapons?.remove?.(e, 'c4'); } catch (err) { console.error('[match] remove c4', err); }
      if (e.inventory.c4) e.inventory.c4 = null;
    }
    const ts = pl.filter((e) => e.team === 'T');
    if (ts.length) {
      const c = ts[(Math.random() * ts.length) | 0];
      b.state = 'carried'; b.carrier = c;
      this._giveC4(c);
    }

    this.phase = 'freeze';
    this.timer = freeze;
    this.roundTime = World.cvar.mp_roundtime;
    this.buyTimeLeft = World.cvar.mp_buytime;
    if (World.cameraOverride && !World.harness) World.cameraOverride = null;
    World.emit('round_start', { round: this.history.length + 1 });
    try { World.bots?.onRoundStart?.(); } catch (e) { console.error('[match] bots.onRoundStart', e); }
    if (!World.bots?.handlesBuying) for (const e of pl) if (e.isBot) this._botBuy(e);
    if (freeze <= 0) this._goLive();
  }

  _goLive() {
    for (const e of this.players()) e.frozen = false;
    this.phase = 'live';
    this.timer = 0;
    this.roundTime = World.cvar.mp_roundtime;
    this.buyTimeLeft = World.cvar.mp_buytime;
    World.emit('round_live', { round: this.history.length + 1 });
  }

  _respawn(e, sp) {
    try {
      if (sp && e.respawn) e.respawn(sp);
      else if (sp) {
        e.origin?.copy?.(sp.pos); e.velocity?.set?.(0, 0, 0);
        e.yaw = sp.yaw; e.pitch = 0;
      }
    } catch (err) { console.error('[match] respawn', err); }
    e.alive = true;
    e.health = 100;
    if (e === World.local && sp && World.input) { World.input.yaw = sp.yaw; World.input.pitch = 0; }
  }

  _strip(e) {
    const W = World.weapons;
    try {
      if (W?.strip) { W.strip(e); return; }
      if (W?.clearInventory) { W.clearInventory(e); return; }
    } catch (err) { console.error('[match] strip', err); }
    if (!e.inventory) e.inventory = { primary: null, secondary: null, knife: null, grenades: [], c4: null, taser: null };
    const inv = e.inventory;
    inv.primary = null; inv.secondary = null; inv.c4 = null; inv.taser = null;
    if (Array.isArray(inv.grenades)) inv.grenades.length = 0; else inv.grenades = [];
  }

  /** Hand an item to a player: WeaponSystem when present, else a shadow inventory for the UI. */
  _give(e, key) {
    const it = item(key);
    if (!it) return false;
    if (key === 'kevlar') { e.armor = 100; return true; }
    if (key === 'kevlarhelmet') { e.armor = 100; e.helmet = true; return true; }
    if (key === 'defusekit') { e.defuser = true; return true; }
    const W = World.weapons;
    if (W?.give) {
      const k = key === 'zeus' ? 'taser' : key;
      try { return W.give(e, k) !== false; } catch (err) { console.error('[match] give', key, err); }
      return false;
    }
    if (!e.inventory) e.inventory = { primary: null, secondary: null, knife: null, grenades: [], c4: null, taser: null };
    const inv = e.inventory;
    switch (it.slot) {
      case 'primary': inv.primary = key; break;
      case 'secondary': inv.secondary = key; break;
      case 'knife': inv.knife = key; break;
      case 'grenade': inv.grenades.push(key); break;
      case 'taser': inv.taser = key; break;
      case 'c4': inv.c4 = key; break;
    }
    if (!e.active || it.slot === 'primary' || (it.slot === 'secondary' && !inv.primary)) e.active = key;
    return true;
  }

  _giveC4(e) {
    if (keyOf(e.inventory?.c4) === 'c4') return;
    if (!this._give(e, 'c4') && e.inventory) e.inventory.c4 = 'c4'; // shadow item for the HUD
  }

  // ---- buying ---------------------------------------------------------------------------
  inBuyZone(e) { return inZone(e?.origin, World.map?.buyzones?.[e?.team], 16); }

  /** Buy window: freeze time + first mp_buytime seconds of the round, in your buy zone. */
  canBuyNow(e = World.local) {
    if (!e || e.alive === false) return false;
    const p = this.phase;
    if (p !== 'freeze' && p !== 'warmup' && !(p === 'live' && this.buyTimeLeft > 0)) return false;
    return this.inBuyZone(e);
  }

  buyCheck(e, key) {
    const r = canBuy(e, key);
    if (r.ok && !this.canBuyNow(e)) return { ok: false, reason: 'zone', price: r.price };
    return r;
  }

  /** Buy for any player. Returns true on success. Bots call this too. */
  buy(e, key, { ignoreZone = false } = {}) {
    const r = canBuy(e, key);
    if (!r.ok) return false;
    if (!ignoreZone && !this.canBuyNow(e)) return false;
    e.money = clampMoney((e.money || 0) - r.price);
    this._give(e, key);
    World.emit('buy', { ent: e, item: key });
    return true;
  }

  _botBuy(e) {
    const T = e.team === 'T';
    const tryBuy = (k) => this.buy(e, k, { ignoreZone: true });
    const pistolRound = this.history.length === 0 || this.history.length === FORMAT.HALF;
    const hasPrimary = !!keyOf(e.inventory?.primary);
    if (pistolRound) {
      const r = Math.random();
      if (T) { if (r < 0.6) tryBuy('kevlar'); else { tryBuy('tec9'); tryBuy('flashbang'); } }
      else if (r < 0.4) tryBuy('kevlar'); else { tryBuy('defusekit'); tryBuy('p250'); tryBuy('flashbang'); }
      return;
    }
    const m = e.money;
    if (!hasPrimary) {
      const awper = Math.random() < 0.18 && m >= 4750 + 1000;
      const rifle = awper ? 'awp' : T ? 'ak47' : (Math.random() < 0.5 ? 'm4a1s' : 'm4a4');
      const cheap = T ? 'galil' : 'famas', smg = T ? 'mac10' : 'mp9';
      if (m >= item(rifle).price + 1000) { tryBuy(rifle); tryBuy('kevlarhelmet'); }
      else if (m >= item(rifle).price + 650) { tryBuy(rifle); tryBuy('kevlar'); }
      else if (m >= 3100 && this.economy.lossLevel[e.team] >= 2) { tryBuy(cheap); tryBuy('kevlar'); }
      else if (m >= 2400 && this.economy.lossLevel[e.team] >= 3) { tryBuy(smg); tryBuy('kevlar'); }
      else if (m < 2000 && Math.random() < 0.5) tryBuy('p250');
    }
    if ((e.armor || 0) < 100 && e.money >= 1000 + 600) tryBuy('kevlarhelmet');
    if (e.money >= 1300) for (const g of ['smokegrenade', 'flashbang', T ? 'molotov' : 'incgrenade', 'hegrenade']) {
      if (e.money < 700) break;
      tryBuy(g);
    }
    if (!T && e.money >= 400 && Math.random() < 0.7) tryBuy('defusekit');
  }

  // ---- simulation -----------------------------------------------------------------------
  tick(dt) {
    if (!this.started) return;
    switch (this.phase) {
      case 'freeze':
        this.timer -= dt;
        this._lockFreeze();
        if (this.timer <= 0) this._goLive();
        break;
      case 'live':
        this.roundTime -= dt;
        this.buyTimeLeft = Math.max(0, this.buyTimeLeft - dt);
        this._bombCarry(dt);
        this._checkElimination();
        if (this.phase === 'live' && this.roundTime <= 0) {
          this.roundTime = 0;
          this._endRound('CT', 'time');
        }
        break;
      case 'planted': {
        const b = this.bomb;
        b.timer -= dt;
        this._bombDefuse(dt);
        this._beep();
        if (b.timer <= 0 && b.state === 'planted') this._explode();
        this._checkElimination();
        break;
      }
      case 'roundend':
        this.timer -= dt;
        this._bombTickAfterEnd(dt);
        if (this.timer <= 0) this._afterRoundEnd();
        break;
      case 'halftime':
        this.timer -= dt;
        if (this.timer <= 0) this._startRound();
        break;
    }
    this.bombModel.update(dt);
  }

  /** LED blink on the CS beep cadence (the audio module plays the beeps from bomb_planted). */
  _beep() {
    const b = this.bomb;
    if (World.time < b.beepAt || b.timer <= 0) return;
    const frac = Math.max(0, b.timer / World.cvar.mp_c4timer);
    b.beepAt = World.time + Math.max(0.15, 0.1 + 0.9 * frac);
    this.bombModel.blink();
  }

  _lockFreeze() {
    for (const e of this.players()) {
      if (e.alive === false) continue;
      const sp = this.spawnPos.get(e);
      if (!sp || !e.origin) continue;
      e.origin.x = sp.x; e.origin.z = sp.z;
      if (e.velocity) { e.velocity.x = 0; e.velocity.z = 0; }
    }
  }

  /** Bot API: call every tick while the bot wants to hold USE (plant with C4 / defuse). */
  use(e, held = true) { if (held) this.useHeldAt.set(e, World.time); else this.useHeldAt.delete(e); }

  /** USE held (defuse / plant), or ATTACK with the C4 in hand (plant). Bots: usercmd buttons. */
  _holdingUse(e) {
    let b;
    if (e === World.local) {
      const I = World.input;
      if (!I || World.paused || World.hud?.captureInput) return false;
      b = I.buttons | 0;
    } else {
      const t = this.useHeldAt.get(e);
      if (t !== undefined && World.time - t < 0.12) return true;
      b = (e.lastCmd?.buttons ?? e.cmd?.buttons ?? e.buttons ?? 0) | 0;
    }
    if (b & IN_USE) return true;
    return !!(b & IN_ATTACK) && keyOf(e.active) === 'c4';
  }

  siteAt(p) {
    const s = World.map?.bombsites;
    if (!s) return null;
    for (const k of ['A', 'B']) if (inZone(p, s[k], 8)) return k;
    return null;
  }

  _bombCarry(dt) {
    const b = this.bomb;
    if (b.state === 'dropped') {
      for (const e of this.players()) {
        if (e.team !== 'T' || e.alive === false || !e.origin) continue;
        if (e.origin.distanceTo(b.pos) < PICKUP_RANGE) {
          b.state = 'carried'; b.carrier = e;
          this.bombModel.hide();
          this._giveC4(e);
          World.emit('bomb_pickup', { ent: e });
          break;
        }
      }
      return;
    }
    if (b.state !== 'carried' || !b.carrier) return;
    const c = b.carrier;
    const site = this.siteAt(c.origin);
    const canPlant = site && c.alive !== false && c.onGround !== false;
    if (canPlant && this._holdingUse(c)) {
      if (b.plantProgress === 0) {
        b.plantPos.copy(c.origin);
        World.emit('bomb_beginplant', { ent: c, site });
        World.emit('bomb_plant_start', { ent: c, site });
      }
      b.plantProgress += dt;
      c.frozen = true;
      c.origin.x = b.plantPos.x; c.origin.z = b.plantPos.z;
      if (c.velocity) { c.velocity.x = 0; c.velocity.z = 0; }
      if (b.plantProgress >= FORMAT.PLANT) this._plant(c, site);
    } else if (b.plantProgress > 0) {
      b.plantProgress = 0;
      c.frozen = false;
      World.emit('bomb_abortplant', { ent: c });
      World.emit('bomb_plant_abort', { ent: c });
    }
  }

  _plant(c, site) {
    const b = this.bomb;
    b.state = 'planted';
    b.planter = c; b.carrier = null;
    b.site = site;
    b.pos.copy(c.origin);
    this._settleBombToGround(b.pos);
    b.timer = World.cvar.mp_c4timer;
    b.beepAt = World.time;
    b.plantProgress = 0;
    c.frozen = false;
    if (c.inventory?.c4) { try { World.weapons?.remove?.(c, 'c4'); } catch {} if (c.inventory.c4 === 'c4') c.inventory.c4 = null; }
    c.money = clampMoney((c.money || 0) + ECON.PLANT_PLAYER);
    const s = this.stat(c); s.plants++; s.score += 2;
    this.phase = 'planted';
    this.bombModel.show(b.pos, c.yaw || 0);
    World.emit('bomb_planted', { site, ent: c, pos: b.pos.clone() });
  }

  _settleBombToGround(p) {
    const col = World.collision;
    if (!col?.rayTrace) return;
    try {
      _v.set(p.x, p.y + 24, p.z);
      const end = new THREE.Vector3(p.x, p.y - 64, p.z);
      const tr = col.rayTrace(_v, end, 1);
      if (tr.fraction < 1) p.y = tr.endpos.y;
    } catch { /* keep feet height */ }
  }

  _onBombPlanted(e) {
    // Planted by another module (weapons C4 / bot AI): adopt it.
    const b = this.bomb;
    if (b.state === 'planted' || !this.started) return;
    const who = e?.ent || b.carrier;
    const pos = e?.pos || who?.origin;
    if (!pos) return;
    b.state = 'planted';
    b.planter = who || null; b.carrier = null;
    b.pos.copy(pos);
    b.site = e?.site || this.siteAt(pos) || 'A';
    b.timer = World.cvar.mp_c4timer;
    b.beepAt = World.time;
    if (who) {
      who.money = clampMoney((who.money || 0) + ECON.PLANT_PLAYER);
      const s = this.stat(who); s.plants++; s.score += 2;
    }
    if (this.phase === 'live') this.phase = 'planted';
    this.bombModel.show(b.pos, who?.yaw || 0);
  }

  _bombDefuse(dt) {
    const b = this.bomb;
    if (b.state !== 'planted') return;
    // current defuser keeps going while holding USE and staying alive / in range
    if (b.defuser) {
      const d = b.defuser;
      if (d.alive === false || !this._holdingUse(d) || d.origin.distanceTo(b.pos) > DEFUSE_RANGE + 12) {
        b.defuser = null; b.defuseProgress = 0; d.frozen = false;
        World.emit('bomb_abortdefuse', { ent: d });
        World.emit('bomb_defuse_abort', { ent: d });
      } else {
        b.defuseProgress += dt;
        d.frozen = true;
        d.origin.x = b.defusePos.x; d.origin.z = b.defusePos.z;
        if (d.velocity) { d.velocity.x = 0; d.velocity.z = 0; }
        if (b.defuseProgress >= b.defuseTime) {
          if (b.timer > 0) this._defused(d);
        }
      }
      return;
    }
    for (const e of this.players()) {
      if (e.team !== 'CT' || e.alive === false || !e.origin) continue;
      if (e.origin.distanceTo(b.pos) > DEFUSE_RANGE) continue;
      if (!this._holdingUse(e)) continue;
      b.defuser = e;
      b.defuseProgress = 0;
      b.defuseTime = e.defuser ? FORMAT.DEFUSE_KIT : FORMAT.DEFUSE;
      b.defusePos.copy(e.origin);
      World.emit('bomb_begindefuse', { ent: e, kit: !!e.defuser });
      World.emit('bomb_defuse_start', { ent: e, kit: !!e.defuser, pos: b.pos });
      break;
    }
  }

  _defused(d) {
    const b = this.bomb;
    b.state = 'defused';
    d.money = clampMoney((d.money || 0) + ECON.DEFUSE_PLAYER);
    const s = this.stat(d); s.defuses++; s.score += 2;
    b.defuser = null; d.frozen = false;
    World.emit('bomb_defused', { site: b.site, ent: d, pos: b.pos.clone() });
    if (this.phase === 'planted') this._endRound('CT', 'bomb_defused', d);
  }

  _onBombDefused(e) {
    const b = this.bomb;
    if (b.state !== 'planted') return;
    const d = e?.ent || null;
    b.state = 'defused';
    if (d) {
      d.money = clampMoney((d.money || 0) + ECON.DEFUSE_PLAYER);
      const s = this.stat(d); s.defuses++; s.score += 2;
    }
    if (this.phase === 'planted') this._endRound('CT', 'bomb_defused', d);
  }

  _explode() {
    const b = this.bomb;
    b.state = 'exploded';
    if (b.defuser) b.defuser.frozen = false;
    b.defuser = null;
    this.bombModel.hide();
    // Settle the round before the blast kills anyone, so the deaths can't read as an
    // elimination win for the CTs.
    World.emit('bomb_exploded', { site: b.site, pos: b.pos.clone(), ent: b.planter });
    if (this.phase === 'planted') this._endRound('T', 'bomb_exploded', b.planter);
    try { World.fx?.explosion?.(b.pos.clone().setY(b.pos.y + 16), { scale: 3.5, bomb: true }); } catch (e) { console.error('[match] fx.explosion', e); }
    // Radius damage (CS: 500 dmg, 1750u radius, gaussian falloff)
    const R = 1750, sigma = R / 3;
    for (const e of this.players()) {
      if (e.alive === false || !e.origin) continue;
      const d = e.origin.distanceTo(b.pos);
      if (d > R) continue;
      let dmg = 500 * Math.exp(-(d * d) / (2 * sigma * sigma));
      if (dmg < 1) continue;
      if ((e.armor || 0) > 0) { const absorbed = Math.min(dmg * 0.5, e.armor * 2); dmg -= absorbed; e.armor = Math.max(0, e.armor - absorbed / 2); }
      dmg = Math.round(dmg);
      const dir = _v.copy(e.origin).sub(b.pos).normalize();
      if (e.takeDamage) {
        try { e.takeDamage({ amount: dmg, hitgroup: 0, attacker: null, weapon: 'c4', point: e.origin.clone(), dir: dir.clone(), armorPen: 1, hitgroupApplied: true }); }
        catch (err) { console.error('[match] takeDamage', err); }
      } else {
        e.health = Math.max(0, (e.health ?? 100) - dmg);
        if (e.health <= 0 && e.alive !== false) { e.alive = false; World.emit('death', { victim: e, attacker: null, weapon: 'c4', headshot: false }); }
      }
    }
  }

  _onBombExploded(e) {
    const b = this.bomb;
    if (b.state !== 'planted') return; // ours already handled it
    b.state = 'exploded';
    this.bombModel.hide();
    if (this.phase === 'planted') this._endRound('T', 'bomb_exploded', b.planter);
  }

  _bombTickAfterEnd(dt) {
    // Bomb keeps ticking after an elimination win (CTs all dead) — it still goes off.
    const b = this.bomb;
    if (b.state !== 'planted') return;
    b.timer -= dt;
    this._beep();
    if (b.timer <= 0) this._explode();
  }

  // ---- events ---------------------------------------------------------------------------
  _onDamage(e) {
    if (!e?.victim || !this.started) return;
    const v = e.victim, a = e.attacker;
    const amt = Math.max(0, Math.min(100, e.amount || 0));
    if (a && a !== v && a.team !== v.team) {
      let t = this.dmgTable.get(v);
      if (!t) this.dmgTable.set(v, (t = new Map()));
      const prev = t.get(a) || 0;
      const add = Math.min(amt, Math.max(0, 100 - prev));
      t.set(a, prev + add);
      const s = this.stat(a); s.damage += add; s.roundDamage += add;
    }
    this.lastHit.set(v, { attacker: a, penetrated: !!e.penetrated, time: World.time, weapon: e.weapon });
  }

  _onDeath(e) {
    const v = e?.victim;
    if (!v || !this.started) return;
    const a = e.attacker && e.attacker !== v ? e.attacker : null;
    const w = keyOf(e.weapon);
    const vs = this.stat(v);
    vs.deaths++;
    let assister = null, flashAssist = false;
    if (a) {
      const as = this.stat(a);
      if (a.team === v.team) { as.kills--; as.score -= 2; }
      else {
        as.kills++; as.roundKills++; as.score += 2;
        if (e.headshot) as.hs++;
      }
      const reward = Economy.killReward(a, v, w);
      a.money = clampMoney((a.money || 0) + reward);
      // assist: another enemy of the victim who dealt > 40 damage this life
      const t = this.dmgTable.get(v);
      if (t) {
        let best = 40;
        for (const [who, dmg] of t) if (who !== a && who.team !== v.team && dmg > best) { best = dmg; assister = who; }
      }
      if (assister) { const s = this.stat(assister); s.assists++; s.score += 1; }
    }
    this.dmgTable.delete(v);

    const hit = this.lastHit.get(v);
    const fx = World.fx;
    let smoke = false, blind = false, noscope = false;
    try {
      if (a && fx?.smokeOcclusion && a.eyePos && v.origin) {
        const from = a.eyePos(new THREE.Vector3());
        const to = _v.copy(v.origin); to.y += 48;
        smoke = fx.smokeOcclusion(from, to) > 0.5;
      }
      if (a && fx?.blindAmount) blind = fx.blindAmount(a) > 0.45;
    } catch { /* optional */ }
    const wi = item(w);
    if (a && wi?.zoom && (w === 'awp' || w === 'ssg08' || w === 'g3sg1' || w === 'scar20') && !a.scoped) noscope = true;

    const L = World.local;
    const info = {
      attacker: a, assister, victim: v, weapon: w || (a ? null : 'world'),
      headshot: !!e.headshot, wallbang: !!(hit && hit.penetrated && hit.attacker === a),
      smoke, blind, noscope, flashAssist, suicide: !a,
      local: a === L && L ? 'kill' : v === L ? 'death' : assister === L && L ? 'assist' : null,
    };
    World.emit('killfeed', info);

    if (v.origin) this.deaths.push({ x: v.origin.x, z: v.origin.z, team: v.team, ent: v });
    const b = this.bomb;
    if (b.state === 'carried' && b.carrier === v) {
      b.state = 'dropped';
      b.carrier = null;
      b.pos.copy(v.origin);
      this._settleBombToGround(b.pos);
      if (v.inventory?.c4) { try { World.weapons?.remove?.(v, 'c4'); } catch {} if (v.inventory.c4 === 'c4') v.inventory.c4 = null; }
      this.bombModel.show(b.pos, v.yaw || 0);
      World.emit('bomb_dropped', { ent: v, pos: b.pos.clone() });
    }
    if (b.defuser === v) { b.defuser = null; b.defuseProgress = 0; }
    v.frozen = false;
    this._checkElimination();
  }

  aliveCount(team) {
    let n = 0;
    for (const e of World.entities) if (e && e.team === team && e.alive !== false) n++;
    return n;
  }

  _checkElimination() {
    if (!this.isLive) return;
    const t = this.aliveCount('T'), ct = this.aliveCount('CT');
    const planted = this.bomb.state === 'planted';
    if (this.sideHadPlayers.CT && ct === 0) { this._endRound('T', 'elimination'); return; }
    if (this.sideHadPlayers.T && t === 0 && !planted) this._endRound('CT', 'elimination');
  }

  _endRound(winner, reason, hero = null) {
    if (this.phase === 'roundend' || this.phase === 'matchend' || this.phase === 'halftime') return;
    const planted = this.bomb.state === 'planted' || this.bomb.state === 'exploded' || this.bomb.state === 'defused';
    this.phase = 'roundend';
    this.timer = World.cvar.mp_round_restart_delay;
    this.score[winner]++;
    const round = this.history.length + 1;
    this.history.push({ round, winner, reason, swaps: this.swaps });

    // Economy
    const settle = this.economy.settleRound(winner, reason, planted);
    for (const e of this.players()) e.money = clampMoney((e.money || 0) + Economy.playerRoundMoney(settle, e));

    // MVP
    let mvp = null, mvpReason = '';
    if (reason === 'bomb_exploded' && hero && hero.team === winner) { mvp = hero; mvpReason = 'planting the bomb'; }
    else if (reason === 'bomb_defused' && hero) { mvp = hero; mvpReason = 'defusing the bomb'; }
    else {
      let best = null;
      for (const e of this.players()) {
        if (e.team !== winner) continue;
        const s = this.stat(e);
        if (!best || s.roundKills > best.roundKills || (s.roundKills === best.roundKills && s.roundDamage > best.roundDamage)) best = s;
      }
      if (best && (best.roundKills > 0 || best.roundDamage > 0)) { mvp = best.ent; mvpReason = 'most eliminations'; }
    }
    if (mvp) { this.stat(mvp).mvps++; World.emit('round_mvp', { ent: mvp, reason: mvpReason }); }

    this.lastRoundEnd = { round, winner, reason, mvp, mvpReason, settle, localWon: winner === this.localTeam };
    this._pending = formatAfterRound(this.history.length, this.score);
    World.emit('round_end', { round, winner, reason, mvp });
  }

  _afterRoundEnd() {
    const next = this._pending || {};
    this._pending = null;
    if (next.end) {
      this.phase = 'matchend';
      this.matchWinner = next.winner;
      this.bombModel.hide();
      if (World.bots) World.bots.frozen = true;
      World.emit('match_end', { winner: next.winner, score: { ...this.score }, localWon: next.winner === this.localTeam });
      return;
    }
    if (next.overtime || next.newOvertime) this.overtime++;
    if (next.swap) this._swapSides();
    if (next.otMoney || next.swap) {
      const money = next.otMoney ? ECON.OT_START : ECON.START;
      this.economy.resetHalf();
      for (const e of this.players()) e.money = money;
    }
    if (next.halftime) {
      this.phase = 'halftime';
      this.timer = World.harness ? 0 : World.cvar.mp_halftime_duration;
      World.emit('halftime', { score: { ...this.score } });
      if (this.timer <= 0) this._startRound();
      return;
    }
    this._startRound();
  }

  _swapSides() {
    for (const e of this.players()) {
      e.team = other(e.team);
      e.armor = 0; e.helmet = false; e.defuser = false;
      this._strip(e);
      if (e.model && !e.isLocal && e._attachModel) {
        // character models are built per team: rebuild with the new side's agent
        try { e.model.dispose?.(); } catch (err) { console.error('[match] model dispose', err); }
        e.model.root?.parent?.remove(e.model.root);
        e.model = null; e._ragdolled = false;
        try { e._attachModel(); } catch (err) { console.error('[match] model rebuild', err); }
      }
    }
    const t = this.score.T; this.score.T = this.score.CT; this.score.CT = t;
    this._rekitAll = true;
    this.swaps++;
    this._localTeam = other(this._localTeam);
    this.bomb.state = 'none';
    try { World.bots?.onTeamSwap?.(); } catch (e) { console.error('[match] bots.onTeamSwap', e); }
    World.emit('team_swap', {});
  }

  // ---- queries for HUD ------------------------------------------------------------------
  /** Seconds on the top-centre clock for the current phase. */
  clock() {
    switch (this.phase) {
      case 'freeze': case 'warmup': case 'halftime': return Math.max(0, this.timer);
      case 'live': return Math.max(0, this.roundTime);
      case 'planted': return Math.max(0, this.bomb.timer);
      case 'roundend': return Math.max(0, this.roundTime);
      default: return 0;
    }
  }

  grenadeCount(e) { return grenadeCounts(e).total; }
}
