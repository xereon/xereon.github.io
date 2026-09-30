// Team-level play. One TeamBrain per side picks a plan at round start, hands each bot a role,
// moves the team through phases (setup -> execute -> post-plant / hold -> rotate -> retake)
// and turns individual sightings into team decisions (rotations, collapses, saves).
import * as THREE from 'three';
import { World } from '../core/world.js';
import * as WI from './weaponinfo.js';

const EYE = 64;
const _v = new THREE.Vector3();

// T plans: groups of bots on a (site, route index). stage=true -> gather hidden before the hit.
const T_PLANS = [
  { name: 'rush_b', w: 0.9, eco: 1.6, site: 'B', groups: [{ site: 'B', route: 0, n: 5, stage: false }] },
  { name: 'split_a', w: 1.2, site: 'A', groups: [{ site: 'A', route: 0, n: 3, stage: true }, { site: 'A', route: 1, n: 2, stage: true }] },
  { name: 'long_a', w: 0.8, site: 'A', groups: [{ site: 'A', route: 0, n: 4, stage: true }, { site: 'B', route: 1, n: 1, stage: true, lurk: true }] },
  { name: 'mid_to_b', w: 0.9, site: 'B', groups: [{ site: 'B', route: 1, n: 2, stage: true }, { site: 'B', route: 0, n: 3, stage: true }] },
  { name: 'default', w: 1.4, site: null, collapse: true, groups: [
    { site: 'A', route: 0, n: 1, stage: true }, { site: 'B', route: 0, n: 2, stage: true },
    { site: 'A', route: 1, n: 1, stage: true }, { site: 'B', route: 1, n: 1, stage: true }] },
  { name: 'fast_a_short', w: 0.5, eco: 1.3, site: 'A', groups: [{ site: 'A', route: 1, n: 5, stage: false }] },
];

function weighted(list, rnd, key = 'w') {
  let sum = 0;
  for (const x of list) sum += x[key] ?? 1;
  let r = rnd() * sum;
  for (const x of list) { r -= x[key] ?? 1; if (r <= 0) return x; }
  return list[list.length - 1];
}

export class TeamBrain {
  constructor(mgr, team) {
    this.mgr = mgr;
    this.team = team;
    this.phase = 'setup';
    this.plan = null;
    this.site = null;             // target / threatened site
    this.executeAt = 0;
    this.roundStart = 0;
    this.sightings = [];          // { ent, pos, time, site }
    this.heat = {};
    this.rotated = null;
    this.econ = 'full';
    this.postSpots = null;
    this.retakeGo = false;
    this.nextUpdate = 0;
    this.smoked = new Set();
  }

  bots() { return this.mgr.bots.filter((b) => b.team === this.team && b.ent.alive); }
  get intel() { return this.mgr.intel; }
  get rnd() { return this.mgr.rnd; }

  // ---- round flow ------------------------------------------------------------------------

  onRoundStart(now) {
    this.roundStart = now;
    this.phase = 'setup';
    this.sightings.length = 0;
    this.smoked = new Set();
    this.heat = {};
    this.rotated = null;
    this.postSpots = null;
    this.retakeGo = false;
    this.plan = null;
    this.site = null;
    this.assigned = false;
    this._execAt = null;
    this._collapsed = false;
    // economy mode from the team's money
    const bots = this.mgr.bots.filter((b) => b.team === this.team);
    const avg = bots.reduce((s, b) => s + (b.ent.money ?? 800), 0) / Math.max(1, bots.length);
    this.econ = this.mgr.isPistolRound() ? 'pistol' : avg >= 3900 ? 'full' : avg >= 2600 ? 'force' : 'eco';
    for (const b of bots) b.role = null;
  }

  /** Called when intel is ready (may be a few ticks into freeze time). */
  assignRoles(now) {
    this.assigned = true;
    const intel = this.intel;
    const bots = this.mgr.bots.filter((b) => b.team === this.team);
    if (!intel?.ready || !Object.keys(intel.sites).length) { for (const b of bots) b.role = { kind: 'hunt' }; return; }
    if (this.team === 'T') this._planT(now, bots); else this._planCT(now, bots);
  }

  _route(siteName, idx) {
    const s = this.intel.sites[siteName] || Object.values(this.intel.sites)[0];
    if (!s?.tRoutes.length) return null;
    return s.tRoutes[Math.min(idx, s.tRoutes.length - 1)];
  }

  _planT(now, bots) {
    const rnd = this.rnd;
    const eco = this.econ === 'eco';
    const plans = T_PLANS.map((p) => ({ ...p, w: (p.w) * (eco ? (p.eco ?? 0.7) : 1) }));
    const plan = weighted(plans, rnd);
    this.plan = plan;
    this.site = plan.site || (rnd() < 0.5 ? 'A' : 'B');
    if (!this.intel.sites[this.site]) this.site = Object.keys(this.intel.sites)[0];
    // execute timing: stage-and-hit plans wait for the group, defaults take their time
    const t = plan.collapse ? 32 + rnd() * 25 : plan.groups.some((g) => g.stage) ? 16 + rnd() * 14 : 0;
    this.executeAt = now + this.mgr.freezeLeft() + t;
    if (!plan.groups.some((g) => g.stage)) this.phase = 'execute';
    // fill groups (bomb carrier never lurks)
    const order = bots.slice().sort(() => rnd() - 0.5);
    const carrier = order.find((b) => WI.hasC4(b.ent));
    if (carrier) { order.splice(order.indexOf(carrier), 1); order.unshift(carrier); }
    let gi = 0, left = plan.groups[0].n, slot = 0;
    const groups = plan.groups;
    const SPREAD = [0, -1, 1, -0.5, 0.5];
    for (const b of order) {
      while (left <= 0 && gi < groups.length - 1) { gi++; left = groups[gi].n; slot = 0; }
      const g = groups[gi];
      left--;
      const route = this._route(g.site, g.route);
      b.role = { kind: g.lurk ? 'lurk' : 'attack', site: g.site, route, stage: g.stage, spread: SPREAD[slot++ % SPREAD.length] + (rnd() - 0.5) * 0.2 };
    }
    this.mgr.logEvent('plan', { team: 'T', plan: plan.name, site: this.site, routes: bots.map((b) => b.role?.route?.name) });
  }

  _planCT(now, bots) {
    const rnd = this.rnd, intel = this.intel;
    const names = Object.keys(intel.sites);
    const A = intel.sites[names[0]], B = intel.sites[names[1]] || A;
    // each round a different spot among the candidates for that angle (attackers pre-aim all of
    // them, so no CT gets pre-aimed every single round)
    const pick = {};
    const hold = (s, ri, hi = 0) => {
      const r = s?.tRoutes[Math.min(ri, s.tRoutes.length - 1)];
      const list = r?.holds;
      if (!list?.length) return null;
      const key = `${s.name}${ri}`;
      pick[key] ??= Math.floor(rnd() * list.length);
      return list[(pick[key] + hi) % list.length];
    };
    // default 2 A / 1 mid / 2 B; sometimes stack a site
    let slots = [
      { site: A.name, h: hold(A, 0) }, { site: B.name, h: hold(B, 0) }, { site: 'mid', h: intel.mid?.hold || hold(B, 1) },
      { site: A.name, h: hold(A, 1) }, { site: B.name, h: hold(B, 1) },
    ];
    const r = rnd();
    if (r < 0.15) slots[3] = { site: B.name, h: hold(B, 0, 1) };           // B stack
    else if (r < 0.3) slots[4] = { site: A.name, h: hold(A, 0, 1) };       // A stack
    this.plan = { name: r < 0.15 ? 'stack_b' : r < 0.3 ? 'stack_a' : 'default' };
    const order = bots.slice().sort(() => rnd() - 0.5);
    // AWPers prefer long-range holds (the first A/B slots are the long routes)
    order.sort((a, b) => (WI.keyOf(WI.slotItem(b.ent, 'primary')) === 'awp') - (WI.keyOf(WI.slotItem(a.ent, 'primary')) === 'awp'));
    order.forEach((b, i) => {
      const s = slots[i % slots.length];
      b.role = { kind: 'hold', site: s.site, hold: s.h, anchor: i < 2, aggressive: rnd() < b.p.aggression * 0.35 };
    });
    this.mgr.logEvent('plan', { team: 'CT', plan: this.plan.name, roles: order.map((b) => b.role.site) });
  }

  // ---- information -----------------------------------------------------------------------

  report(ent, pos, now) {
    const intel = this.intel;
    if (!intel?.ready) return;
    const last = this.sightings.find((s) => s.ent === ent);
    const site = intel.nearestSite(pos);
    const near = site && Math.hypot(pos.x - site.center.x, pos.z - site.center.z) < site.radius + 1300 ? site.name : null;
    if (last) { last.pos.copy(pos); last.time = now; last.site = near; }
    else this.sightings.push({ ent, pos: pos.clone(), time: now, site: near });
  }

  /** A teammate died here: treat as information about that site. */
  teammateDied(pos, now) {
    const site = this.intel?.nearestSite(pos);
    if (site && Math.hypot(pos.x - site.center.x, pos.z - site.center.z) < site.radius + 1300) {
      this.heat[site.name] = (this.heat[site.name] || 0) + 1.2;
    }
  }

  // ---- phase machine (4 Hz) --------------------------------------------------------------

  update(now) {
    if (now < this.nextUpdate) return;
    this.nextUpdate = now + 0.25;
    if (!this.assigned) { if (this.intel?.ready) this.assignRoles(now); else return; }
    // heat: recent enemy presence per site
    for (const k of Object.keys(this.heat)) this.heat[k] *= 0.93;
    for (const s of this.sightings) {
      if (!s.ent.alive) continue;
      if (now - s.time < 0.3 && s.site) this.heat[s.site] = (this.heat[s.site] || 0) + (WI.hasC4(s.ent) ? 0.6 : 0.25);
    }
    const bomb = this.mgr.bomb;
    const live = now - this.roundStart - this.mgr.freezeLeftAt(this.roundStart);
    const timeLeft = this.mgr.roundTimeLeft(now);
    if (this.team === 'T') {
      if (bomb.planted) { this.phase = 'postplant'; return; }
      if (this.phase === 'setup') {
        const bots = this.bots().filter((b) => b.role?.stage && b.role.kind === 'attack');
        const staged = bots.filter((b) => b.arrived && b.goalKind === 'stage').length;
        const ready = bots.length && staged >= Math.ceil(bots.length * 0.8);
        if (this.plan?.collapse && now >= this.executeAt - 6) this._collapse();
        if (now >= this.executeAt || (ready && !this.plan?.collapse && live > 8) || timeLeft < 42) {
          if (this.plan?.collapse && !this._collapsed) this._collapse();
          this.phase = 'execute';
          this._execAt = now;
          this.mgr.radio(this.bots()[0], 'go', null);
          this.mgr.logEvent('execute', { team: 'T', site: this.site, t: live.toFixed(1) });
        }
      }
      // late round with nothing happening -> go now; hopeless -> save
      if (this.phase === 'execute' && timeLeft < 7 && !bomb.planted) this.phase = 'save';
    } else {
      if (bomb.planted) {
        if (this.phase !== 'retake' && this.phase !== 'save') { this.phase = 'retake'; this.retakeStart = now; this.retakeGo = false; }
        // hopeless retakes turn into saves
        const cts = this.bots().length;
        const ts = this.mgr.aliveCount('T');
        const need = this.bots().some((b) => b.ent.defuser) ? 5 : 10;
        if (bomb.timeLeft(now) < need + 1.5 && !this.bots().some((b) => b.task === 'defuse')) this.phase = 'save';
        if (cts === 1 && ts >= 3 && bomb.timeLeft(now) < 25) this.phase = 'save';
        if (this.phase === 'retake' && !this.retakeGo) {
          const gathered = this.bots().filter((b) => b.arrived && b.goalKind === 'regroup').length;
          if (gathered >= Math.min(2, this.bots().length) || now - this.retakeStart > 8 || bomb.timeLeft(now) < need + 14) this.retakeGo = true;
        }
        return;
      }
      // rotate when a site is clearly being hit
      let hot = null, hv = 1.1;
      for (const [k, v] of Object.entries(this.heat)) if (v > hv) { hv = v; hot = k; }
      if (hot && this.rotated !== hot) {
        this.rotated = hot;
        this.phase = 'rotate';
        this.mgr.radio(this.bots()[0], 'rotate', null);
        this.mgr.logEvent('rotate', { team: 'CT', site: hot, heat: hv.toFixed(2) });
      }
    }
  }

  _collapse() {
    if (this._collapsed) return;
    this._collapsed = true;
    // hit the site where fewer CTs have been seen
    const heat = {};
    for (const s of this.sightings) if (s.site && World.time - s.time < 30) heat[s.site] = (heat[s.site] || 0) + 1;
    const names = Object.keys(this.intel.sites);
    names.sort((a, b) => (heat[a] || 0) - (heat[b] || 0) + (this.rnd() - 0.5) * 0.8);
    this.site = names[0];
    for (const b of this.bots()) {
      if (!b.role || b.role.kind === 'lurk') continue;
      if (b.role.site !== this.site) {
        // pick this site's route whose path is nearest to where the bot is now
        const routes = this.intel.sites[this.site].tRoutes;
        let best = routes[0], bd = Infinity;
        for (const r of routes) {
          const i = this.intel.routeIndexNear(r, b.ent.origin);
          const k = r.nodes[i];
          const d = Math.hypot(World.nav.px[k] - b.ent.origin.x, World.nav.pz[k] - b.ent.origin.z);
          if (d < bd) { bd = d; best = r; }
        }
        b.role = { ...b.role, site: this.site, route: best };
      }
    }
  }

  // ---- per-bot decision (called from Bot.think) -------------------------------------------

  decide(bot, now) {
    if (!this.assigned) return;
    const role = bot.role;
    if (!role) { this._hunt(bot, now); return; }
    if (this.team === 'T') this._decideT(bot, role, now); else this._decideCT(bot, role, now);
  }

  _decideT(bot, role, now) {
    const mgr = this.mgr, intel = this.intel, bomb = mgr.bomb, ent = bot.ent;
    if (this.phase === 'postplant' || bomb.planted) { this._guardBomb(bot, now); return; }
    if (this.phase === 'save') { this._save(bot, now); return; }
    // dropped bomb: nearest T fetches it
    if (bomb.dropped && !bot.target) {
      const ts = this.bots();
      let best = null, bd = Infinity;
      for (const b of ts) { const d = b.ent.origin.distanceTo(bomb.droppedPos); if (d < bd) { bd = d; best = b; } }
      if (best === bot && bd < 2500) { bot.task = 'fetch'; bot.setGoal('fetch', bomb.droppedPos, { radius: 8 }); return; }
    }
    const hasC4 = WI.hasC4(ent);
    const inSite = intel.siteAt(ent.origin, -16);
    // the carrier goes straight for a plant spot once on/near a site during a hit
    const tSite = intel.sites[this.site];
    const nearSite = tSite && this.phase === 'execute' && ent.origin.distanceTo(tSite.center) < tSite.radius + 700 ? tSite : null;
    const plantSite = inSite || nearSite;
    if (hasC4 && plantSite && (this.phase === 'execute' || role.kind !== 'lurk')) {
      const s = plantSite;
      // keep the spot we picked unless it's gone bad
      let spot = bot._plantSpot && s.plant.includes(bot._plantSpot) ? bot._plantSpot : null;
      if (!spot) {
        let bd = Infinity;
        for (const p of s.plant) { const d = p.distanceTo(ent.origin); if (d < bd) { bd = d; spot = p; } }
        spot ||= s.center;
        bot._plantSpot = spot;
      }
      bot.task = 'plant';
      bot.setGoal('plant', spot, { radius: 18 });
      return;
    }
    bot._plantSpot = null;
    const route = role.route;
    if (!route) { this._hunt(bot, now); return; }
    const s = intel.sites[role.site];
    if (role.kind === 'lurk') {
      // lurkers hold their staging spot, then flank into the hit late
      if (this.phase === 'execute' && now - (this._execAt ??= now) > 8 + bot.id % 4) {
        const tgt = intel.sites[this.site];
        bot.task = 'flank';
        bot.setGoal('site', tgt.plant[bot.id % Math.max(1, tgt.plant.length)] || tgt.center, { radius: 60 });
      } else {
        bot.task = 'lurk';
        bot.setGoal('stage', route.stage, { route, routeIdx: route.stageIdx, hold: true, look: route.entryEye, walk: this._nearStage(bot, route), crouch: bot.id % 3 === 0 });
      }
      return;
    }
    if (this.phase === 'setup' && role.stage) {
      bot.task = 'stage';
      // spread the group around the staging point so they don't stack in one pixel
      const st = this._spread(route.stage, route, role.spread);
      bot.setGoal('stage', st, { route, routeIdx: route.stageIdx, hold: true, look: route.entryEye, walk: this._nearStage(bot, route), radius: 40 });
      return;
    }
    // execute: follow the route onto the site, then hold it for the plant
    const tgtSite = intel.sites[this.site] || s;
    const r = tgtSite.name === role.site ? route : tgtSite.tRoutes[0];
    if (!intel.siteAt(ent.origin, 60)) {
      bot.task = 'execute';
      // walk (silent) for the last stretch if the team isn't rushing
      const walkIn = false;
      bot.setGoal('site', r.nodes.length ? World.nav.pos(r.nodes[r.nodes.length - 1], _v) : tgtSite.center, { route: r, routeIdx: r.nodes.length - 1, radius: 90, walk: walkIn });
    } else {
      // on site without the bomb: cover the planter, watching the CT entries
      bot.task = 'cover';
      const cr = tgtSite.ctRoutes[bot.id % Math.max(1, tgtSite.ctRoutes.length)];
      const look = cr?.entryEye || tgtSite.eye;
      const spot = this._siteSpot(tgtSite, bot, look);
      bot.setGoal('cover', spot, { hold: true, look, radius: 30 });
    }
  }

  _decideCT(bot, role, now) {
    const mgr = this.mgr, intel = this.intel, bomb = mgr.bomb, ent = bot.ent;
    if (bomb.planted) {
      if (this.phase === 'save') {
        const f = bot.task === 'defuse' ? null : this._fleeSpot(bot);
        if (f) { bot.task = 'save'; bot.setGoal('save', f, { radius: 150 }); } else this._save(bot, now);
        return;
      }
      const s = intel.sites[bomb.site] || intel.nearestSite(bomb.pos);
      const bombEye = _v.copy(bomb.pos); bombEye.y += 40;
      if (!this.retakeGo) {
        // regroup at the retake staging of the nearest CT route, out of sight of the bomb
        let r = s.ctRoutes[0], bd = Infinity;
        for (const cr of s.ctRoutes) { const d = cr.stage.distanceTo(ent.origin); if (d < bd) { bd = d; r = cr; } }
        bot.task = 'regroup';
        bot.setGoal('regroup', r?.stage || s.center, { hold: true, look: r?.entryEye || s.eye, radius: 70 });
        return;
      }
      // closest CT defuses, the others clear/cover
      const cts = this.bots();
      let best = null, bd = Infinity;
      for (const b of cts) { const d = b.ent.origin.distanceTo(bomb.pos); if (d < bd) { bd = d; best = b; } }
      if (best === bot) {
        bot.task = 'defuse';
        bot.setGoal('defuse', bomb.pos, { radius: 26, look: bombEye });
      } else {
        bot.task = 'retake';
        if (!this.postSpots || this.postSpots.site !== s.name) this.postSpots = { site: s.name, list: intel.watchSpots(bombEye.clone(), bomb.pos, 200, 700, 5) };
        const spot = this.postSpots.list[bot.id % Math.max(1, this.postSpots.list.length)] || bomb.pos;
        bot.setGoal('retake', spot, { hold: true, look: bombEye, radius: 40 });
      }
      return;
    }
    // rotations: non-anchors (and the mid player) move to the hot site
    if (this.phase === 'rotate' && this.rotated && this.rotated !== role.site && (!role.anchor || role.site === 'mid')) {
      const s = intel.sites[this.rotated];
      if (s) {
        const holds = s.tRoutes.flatMap((r) => r.holds || []);
        const h = holds[(bot.id + 1) % Math.max(1, holds.length)];
        bot.task = 'rotate';
        bot.setGoal('hold', h?.pos || s.center, { hold: true, look: h?.look || s.eye, radius: 40 });
        return;
      }
    }
    const h = role.hold;
    if (!h) { this._hunt(bot, now); return; }
    // aggressive CTs look for an early pick past their choke, then fall back to the hold
    const live = now - this.roundStart - this.mgr.freezeLeftAt(this.roundStart);
    if (role.aggressive && live < 18 && !this.rotated && h.site !== 'mid') {
      const peek = this._pushSpot(h);
      if (peek) {
        bot.task = 'push';
        bot.setGoal('push', peek.pos, { hold: true, look: peek.look, radius: 48, walk: bot.ent.origin.distanceTo(peek.pos) < 500 });
        return;
      }
    }
    bot.task = 'hold';
    bot.setGoal('hold', h.pos, { hold: true, look: h.look, radius: 32, crouch: bot.p.skill > 0.5 && bot.id % 3 === 1 && WI.keyOf(WI.slotItem(ent, 'primary')) !== 'awp' });
  }

  /** Somewhere outside the C4 blast on the way home (cached per bot per plant). */
  _fleeSpot(bot) {
    const bomb = this.mgr.bomb, nav = World.nav;
    if (bot._flee && bot._fleeFor === bomb.plantTime) return bot._flee;
    const home = this.team === 'T' ? this.intel.tSpawn : this.intel.ctSpawn;
    let spot = home ? home.clone() : null;
    const nodes = home ? nav.astar(nav.nearest(bot.ent.origin), nav.nearest(home)) : null;
    if (nodes) for (const k of nodes) {
      if (Math.hypot(nav.px[k] - bomb.pos.x, nav.pz[k] - bomb.pos.z) > 1650) { spot = nav.pos(k); break; }
    }
    bot._flee = spot; bot._fleeFor = bomb.plantTime;
    return spot;
  }

  _guardBomb(bot, now) {
    const bomb = this.mgr.bomb, intel = this.intel;
    // the bomb doesn't care whose side you're on: clear out before it blows
    const tl = bomb.timeLeft(now);
    if (tl < 10 && (tl < 5 || !(bot.target && bot.targetMem?.visible))) {
      const f = this._fleeSpot(bot);
      if (f) { bot.task = 'flee'; bot.setGoal('flee', f, { radius: 120 }); return; }
    }
    const bombEye = _v.copy(bomb.pos); bombEye.y += 40;
    if (!this.postSpots || this.postSpots.pos?.distanceTo(bomb.pos) > 10) {
      this.postSpots = { pos: bomb.pos.clone(), list: intel.watchSpots(bombEye.clone(), bomb.pos, 300, 950, 6) };
    }
    const list = this.postSpots.list;
    const spot = list[bot.id % Math.max(1, list.length)] || bomb.pos;
    // look toward the CT approach closest to our spot, not at the bomb itself
    const s = intel.sites[bomb.site] || intel.nearestSite(bomb.pos);
    let look = bombEye.clone();
    if (s?.ctRoutes?.length) {
      const cr = s.ctRoutes[bot.id % s.ctRoutes.length];
      if (cr?.entryEye) look = cr.entryEye;
    }
    bot.task = 'postplant';
    bot.setGoal('post', spot, { hold: true, look, radius: 36, crouch: bot.id % 2 === 0 });
  }

  _save(bot, now) {
    const spawn = this.team === 'T' ? this.intel.tSpawn : this.intel.ctSpawn;
    bot.task = 'save';
    if (spawn) bot.setGoal('save', spawn, { radius: 200, walk: true });
  }

  _hunt(bot, now) {
    // no plan: sweep toward the last known enemy, or roam between sites
    const recent = this.sightings.filter((s) => s.ent.alive).sort((a, b) => b.time - a.time)[0];
    bot.task = 'hunt';
    if (recent) { bot.setGoal('hunt', recent.pos, { radius: 120 }); return; }
    const sites = Object.values(this.intel?.sites || {});
    if (sites.length && (bot.goalKind !== 'hunt' || bot.arrived)) bot.setGoal('hunt', sites[(Math.random() * sites.length) | 0].center, { radius: 150 });
  }

  // ---- helpers ---------------------------------------------------------------------------

  /** A spot ~450u past a hold's choke toward the attackers, looking further up their route. */
  _pushSpot(h) {
    if (h._push !== undefined) return h._push;
    const s = this.intel.sites[h.site], r = s?.tRoutes?.[h.route];
    h._push = null;
    if (!r?.dist) return null;
    const want = r.dist[r.entryIdx] + 450, look = r.dist[r.entryIdx] + 1100;
    let i = r.entryIdx, j = r.entryIdx;
    while (i > 0 && r.dist[i] < want) i--;
    while (j > 0 && r.dist[j] < look) j--;
    const nav = World.nav;
    if (!nav.solidSpot(r.nodes[i])) return null;
    const lk = nav.pos(r.nodes[j]); lk.y += EYE;
    h._push = { pos: nav.pos(r.nodes[i]), look: lk };
    return h._push;
  }

  _nearStage(bot, route) { return bot.ent.origin.distanceTo(route.stage) < 700; }

  _spread(p, route, s) {
    // offset sideways by up to ~70u using nav nodes so the spot is valid
    const nav = World.nav;
    const i = Math.max(0, route.stageIdx - 3);
    const k0 = route.nodes[i], k1 = route.nodes[route.stageIdx];
    const dx = nav.px[k1] - nav.px[k0], dz = nav.pz[k1] - nav.pz[k0];
    const l = Math.hypot(dx, dz) || 1;
    const q = new THREE.Vector3(p.x - dz / l * s * 70 - dx / l * Math.abs(s) * 50, p.y, p.z + dx / l * s * 70 - dz / l * Math.abs(s) * 50);
    const k = nav.nearest(q);
    return k >= 0 && Math.abs(nav.py[k] - p.y) < 40 ? nav.pos(k) : p;
  }

  _siteSpot(site, bot, look) {
    const key = `${site.name}:${bot.id}`;
    this._spotCache ||= new Map();
    let s = this._spotCache.get(key);
    if (!s || this._spotCache.round !== this.roundStart) {
      if (this._spotCache.round !== this.roundStart) { this._spotCache.clear(); this._spotCache.round = this.roundStart; }
      const list = this.intel.watchSpots(look, site.center, 120, 500, 4);
      s = list[bot.id % Math.max(1, list.length)] || site.center;
      this._spotCache.set(key, s);
    }
    return s;
  }

  /** Where this bot should pre-aim right now (eye-height points). */
  preaimSpots(bot) {
    const intel = this.intel;
    if (!intel?.ready) return null;
    if (this.team === 'T') {
      if (this.phase === 'postplant') return null;
      const role = bot.role;
      const s = intel.sites[this.phase === 'execute' ? this.site : role?.site];
      if (!s) return null;
      return (s._eyes ||= s.tRoutes.flatMap((r) => (r.holds || []).map((h) => h.eye)));
    }
    if (this.mgr.bomb.planted) {
      const s = intel.sites[this.mgr.bomb.site] || intel.nearestSite(this.mgr.bomb.pos);
      if (!s) return null;
      return (s._ctEyes ||= s.plant.map((p) => new THREE.Vector3(p.x, p.y + 56, p.z)));
    }
    return null;
  }
}
