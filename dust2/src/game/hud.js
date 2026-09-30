// In-game HUD (CS2 layout) + UI orchestration: menus, buy menu, scoreboard, spectator
// camera, pointer-lock flow. Reads World lazily every frame; writes the DOM only when a
// displayed value actually changes.
//
// Harness flags (screenshots): ?harness&hud=1 shows a live-looking HUD; ?harness&ui=<state>
// with state in buymenu | scoreboard | mainmenu | roundend | teamselect | settings | pause |
// matchend | scope | flash | planted | spectate | damage | icons.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { IN_SCORE, IN_ATTACK, IN_ATTACK2 } from '../core/input.js';
import { applyViewAngles, angleVectors } from '../core/mathx.js';
import { icon, WEAPON_ICON_KEYS, GLYPH_KEYS } from './icons.js';
import { item, keyOf, nameOf } from './economy.js';
import { Settings, applySettings } from './settings.js';
import { drawCrosshair, spreadToPx } from './crosshair.js';
import { Radar, teammateColor } from './radar.js';
import { KillFeed } from './killfeed.js';
import { Scoreboard } from './scoreboard.js';
import { BuyMenu } from './buymenu.js';
import { Menus } from './menu.js';
import { Flyover } from './flyover.js';
import { demoRoster, demoPositions } from './demo.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtClock = (s) => { s = Math.max(0, Math.ceil(s - 1e-6)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const SNIPERS = new Set(['awp', 'ssg08', 'g3sg1', 'scar20']);
const RIFLE_SCOPES = new Set(['aug', 'sg553']);
const REASON_TEXT = {
  elimination: 'All enemies eliminated', bomb_exploded: 'Target bombed', bomb_defused: 'Bomb defused', time: 'Target saved',
};
const TEAM_WIN = { CT: 'Counter-Terrorists Win', T: 'Terrorists Win' };
const DMG_ARCS = 6;
// Map callout keys -> the names CS shows under the radar
const CALLOUTS = {
  tspawn: 'T Spawn', t_spawn: 'T Spawn', t_ramp: 'T Ramp', suicide: 'Suicide', top_mid: 'Top Mid', outside_long: 'Outside Long',
  long_doors: 'Long Doors', long_corner: 'Long Corner', blue: 'Blue', pit: 'Pit', side_pit: 'Side Pit', long: 'Long A',
  a_car: 'A Car', a_ramp: 'A Ramp', a_site: 'Bombsite A', goose: 'Goose', a_plat: 'A Platform', short: 'Short A',
  catwalk: 'Catwalk', xbox: 'Xbox', mid: 'Middle', mid_doors: 'Mid Doors', ct_mid: 'CT Mid', ct_spawn: 'CT Spawn',
  under_a: 'Under A', lower_tunnels: 'Lower Tunnels', tunnel_stairs: 'Tunnel Stairs', upper_tunnels: 'Upper Tunnels',
  outside_tunnels: 'Outside Tunnels', b_site: 'Bombsite B', b_plat: 'B Platform', b_tunnel_exit: 'B Tunnels',
  b_window: 'B Window', b_window_ct: 'B Window', b_doors: 'B Doors', mid_to_b: 'Mid to B', tunnels: 'Tunnels', lower_mid: 'Lower Mid',
};

const _v = new THREE.Vector3();
const _vec = { forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };

function h(tag, cls, html = '', parent = null) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  if (parent) parent.appendChild(el);
  return el;
}
const byRoster = (a, b) => ((b.isLocal ? 1 : 0) - (a.isLocal ? 1 : 0)) || ((a.id ?? 0) - (b.id ?? 0));
// numeric change signature for a side's avatars (no per-frame string building)
function sideSig(list, carrier) {
  let h = list.length;
  for (const e of list) h = (h * 31 + (e.alive === false ? 1 : 2) * 1000 + (e.health | 0) + (e === carrier ? 7919 : 0)) | 0;
  return h;
}
const setText = (el, v) => { v = String(v); if (el._t !== v) { el._t = v; el.textContent = v; } };
const setHTML = (el, v) => { if (el._h !== v) { el._h = v; el.innerHTML = v; } };
const setCls = (el, c, on) => { on = !!on; const k = '_c_' + c; if (el[k] !== on) { el[k] = on; el.classList.toggle(c, on); } };
const setStyle = (el, prop, v) => { const k = '_s_' + prop; if (el[k] !== v) { el[k] = v; el.style[prop] = v; } };

export class Hud {
  constructor(root) {
    this.root = root;
    this.ui = document.getElementById('ui-root') || root;
    this.params = World.params || new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.demoMode = World.harness && (this.params.get('hud') === '1' || this.params.has('ui')) ? (this.params.get('ui') || 'hud') : null;
    this.visible = false;
    this.t = 0;
    this.paused = false;
    this.money = null;
    this.lastWeapon = null;
    this.wlUntil = 0;
    this.spec = { target: null, deathT: -1, prevAttack: false, prevAttack2: false, override: { eye: new THREE.Vector3(), pitch: 0, yaw: 0, fov: null, spectate: true }, vm: null };
    this.dmg = [];
    this.alertUntil = 0;
    this.roundEndUntil = 0;
    this.ignoreMenuUntil = 0;
    this.expectUnlock = false;

    root.classList.add('hud');
    this._build();
    this.radar = new Radar(this.$tl);
    this.$tl.appendChild(this.$loc);
    this.$tl.appendChild(this.$moneyRow);
    this.killfeed = new KillFeed(this.layer);
    this.scoreboard = new Scoreboard(this.layer);
    this.buy = new BuyMenu(this.ui);
    this.menus = new Menus(this.ui);
    this.flyover = new Flyover(this.$fade);

    this._resize();
    addEventListener('resize', () => this._resize());
    if (!World.harness) applySettings();

    World.on('killfeed', (e) => this._onKill(e));
    World.on('damage', (e) => this._onDamage(e));
    World.on('round_start', (e) => this._onRoundStart(e));
    World.on('round_live', () => this._onLive());
    World.on('round_end', (e) => this._onRoundEnd(e));
    World.on('match_end', (e) => this._onMatchEnd(e));
    World.on('bomb_planted', (e) => this._alert(`Bomb planted${e?.site ? ' at ' + e.site : ''}`, 'bomb', 4));
    World.on('bomb_defused', () => this._alert('Bomb defused', 'ct', 4));
    World.on('halftime', () => { this._alert('Halftime — switching sides', 'neutral', 8); });
    World.on('impulse', (imp) => this._impulse(imp));
    World.on('pointerlock', (e) => this._pointerLock(e));
    World.on('settings', () => { this.xhSig = ''; });
    World.on('ready', () => this._ready());
    // Clicking the game while a match is running (and no menu is open) captures the mouse.
    document.getElementById('game')?.addEventListener('mousedown', () => {
      if (this.inGame() && !this.captureInput && !World.input?.locked) { World.audio?.unlock?.(); World.input?.lock?.(); }
    });
    addEventListener('keydown', (e) => {
      if (this.menus.open && !this.buy.open && this.menus.key(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  // ---- DOM -------------------------------------------------------------------------------
  _build() {
    const L = this.layer = h('div', 'hud-layer', '', this.root);
    // top-left: radar (canvas inserted by Radar), location, money
    this.$tl = h('div', 'hud-tl', '', L);
    this.$loc = h('div', 'hud-loc');
    this.$moneyRow = h('div', 'hud-money', `<span class="hm-buy">${icon('cart')}</span><span class="hm-v"></span><span class="hm-d"></span>`);
    this.$money = this.$moneyRow.querySelector('.hm-v');
    this.$moneyD = this.$moneyRow.querySelector('.hm-d');
    this.$buyIc = this.$moneyRow.querySelector('.hm-buy');

    // top bar
    this.$top = h('div', 'topbar', `
      <div class="tb-side tb-l"><div class="tb-avs"></div><div class="tb-score t-CT"><b></b></div></div>
      <div class="tb-mid"><div class="tb-clock"><span class="tb-time"></span><span class="tb-bomb">${icon('bomb')}</span></div><div class="tb-phase"></div></div>
      <div class="tb-side tb-r"><div class="tb-score t-T"><b></b></div><div class="tb-avs"></div></div>`, L);
    this.$avL = this.$top.querySelector('.tb-l .tb-avs');
    this.$avR = this.$top.querySelector('.tb-r .tb-avs');
    this.$scCT = this.$top.querySelector('.tb-score.t-CT b');
    this.$scT = this.$top.querySelector('.tb-score.t-T b');
    this.$clock = this.$top.querySelector('.tb-clock');
    this.$time = this.$top.querySelector('.tb-time');
    this.$phase = this.$top.querySelector('.tb-phase');
    this.$alert = h('div', 'hud-alert', '', L);

    // bottom-left vitals
    this.$vitals = h('div', 'hud-vitals', `
      <div class="vt vt-hp"><span class="vt-ic">${icon('health')}</span><span class="vt-n"></span><i class="vt-bar"><b></b></i></div>
      <div class="vt vt-ar"><span class="vt-ic"></span><span class="vt-n"></span><i class="vt-bar"><b></b></i></div>
      <div class="vt-kit">${icon('defuse')}</div>`, L);
    this.$hp = this.$vitals.querySelector('.vt-hp .vt-n');
    this.$hpBar = this.$vitals.querySelector('.vt-hp .vt-bar b');
    this.$hpBox = this.$vitals.querySelector('.vt-hp');
    this.$ar = this.$vitals.querySelector('.vt-ar .vt-n');
    this.$arBar = this.$vitals.querySelector('.vt-ar .vt-bar b');
    this.$arIc = this.$vitals.querySelector('.vt-ar .vt-ic');
    this.$kit = this.$vitals.querySelector('.vt-kit');

    // bottom-right: weapon list + ammo
    this.$wl = h('div', 'hud-wlist', '', L);
    this.$ammo = h('div', 'hud-ammo', `<span class="am-ic">${icon('bullets')}</span><span class="am-clip"></span><span class="am-sep">/</span><span class="am-res"></span>`, L);
    this.$clip = this.$ammo.querySelector('.am-clip');
    this.$res = this.$ammo.querySelector('.am-res');
    this.$wname = h('div', 'hud-wname', '', L);

    // centre: crosshair, damage arcs, progress, hints
    this.$xh = h('canvas', 'hud-xh', '', L);
    this.xctx = this.$xh.getContext('2d');
    let arcs = '';
    for (let i = 0; i < DMG_ARCS; i++) arcs += `<path class="dmg-arc" d="M -76 -178 A 194 194 0 0 1 76 -178" />`;
    this.$dmg = h('div', 'hud-dmg', `<svg viewBox="-200 -200 400 400">${arcs}</svg>`, L);
    this.dmgEls = [...this.$dmg.querySelectorAll('.dmg-arc')];
    this.$prog = h('div', 'hud-prog', `<div class="pg-l"><span class="pg-ic"></span><span class="pg-t"></span><span class="pg-s"></span></div><i><b></b></i>`, L);
    this.$progT = this.$prog.querySelector('.pg-t');
    this.$progS = this.$prog.querySelector('.pg-s');
    this.$progIc = this.$prog.querySelector('.pg-ic');
    this.$progB = this.$prog.querySelector('i b');
    this.$hint = h('div', 'hud-hint', '', L);

    // spectator
    this.$spec = h('div', 'hud-spec', '', L);

    // round-end banner
    this.$rend = h('div', 'hud-rend', '', L);

    // overlays (bottom of stack visually but above the canvas)
    this.$scope = h('div', 'hud-scope', `<div class="sc-lens"></div><i class="sc-h"></i><i class="sc-v"></i><b class="sc-ring"></b><b class="sc-dot"></b>`, this.root);
    this.$flash = h('div', 'hud-flash', '', this.root);
    this.$fade = h('div', 'ui-fade', '', this.ui);
    this.$click = h('div', 'hud-click', `<div><b>Click to play</b><span>Press <kbd>Esc</kbd> for the menu</span></div>`, this.ui);
  }

  _resize() {
    // Crosshair works in device pixels (CS sizes scale with the physical resolution) and is
    // positioned on whole pixels so 1px lines stay crisp.
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    this.H = Math.round(innerHeight * dpr);
    this.radar.resize(this.root.querySelector('.hud-tl')?.clientWidth || Math.round(innerHeight * 0.235));
    const css = Math.max(64, Math.round(innerHeight * 0.36) & ~1);
    this.$xh.width = this.$xh.height = Math.round(css * dpr) & ~1;
    Object.assign(this.$xh.style, {
      width: css + 'px', height: css + 'px', transform: 'none',
      left: ((innerWidth >> 1) - css / 2) + 'px', top: ((innerHeight >> 1) - css / 2) + 'px',
    });
    this.xhSig = '';
  }

  // ---- state helpers -------------------------------------------------------------------
  get captureInput() { return !!(this.menus?.open || this.buy?.open); }
  inGame() { const M = World.match; return !!(M && M.started && M.phase !== 'menu'); }

  showMainMenu() {
    this.buy.close();
    this.menus.showMain();
    if (!World.harness) this.flyover.start();
    World.input?.unlock?.();
    this.visible = false;
    this._syncVisibility();
  }

  chooseTeam(team) {
    World.audio?.unlock?.();
    const M = World.match;
    if (!M) return;
    const midMatch = this.inGame() && M.phase !== 'matchend';
    this.menus.hide();
    this.flyover.stop();
    if (midMatch) {
      // CS lets you switch mid-match: you swap sides at the next round (kill yourself here).
      const t = team === 'auto' ? (M.localTeam === 'T' ? 'CT' : 'T') : team;
      if (t !== M.localTeam && World.local) {
        M.localTeam = t; World.local.team = t;
        if (World.local.alive) { World.local.alive = false; World.emit('death', { victim: World.local, attacker: null, weapon: 'world', headshot: false }); }
      }
      this._setPaused(false);
    } else {
      M.beginMatch(team, { difficulty: Settings.difficulty, teamSize: Settings.teamSize });
    }
    World.input?.lock?.();
  }

  resume() {
    this.menus.hide();
    this._setPaused(false);
    World.input?.lock?.();
  }

  leaveMatch() {
    this._setPaused(false);
    this.menus.hide();
    this.killfeed.clear();
    this._endSpectate();
    World.match?.toMenu?.();
  }

  playAgain() {
    this.menus.hide();
    this.killfeed.clear();
    const M = World.match;
    const team = M?.localTeam && M.swaps % 2 ? (M.localTeam === 'T' ? 'CT' : 'T') : M?.localTeam || 'T';
    M?.beginMatch?.(team, { difficulty: Settings.difficulty, teamSize: Settings.teamSize });
    World.input?.lock?.();
  }

  onMatchBegin() {
    this.flyover.stop();
    this.killfeed.clear();
    this.money = null;
    this._endSpectate();
  }

  _setPaused(p) {
    this.paused = p;
    World.paused = p;
  }

  _menuClosed(relock) {
    if (relock && this.inGame() && !this.menus.open) World.input?.lock?.();
  }

  _ready() {
    this.xhSig = '';
    this._resize();
    if (!this.radar.built && World.map) this.radar.build();
    if (this.demoMode) this._setupDemo();
    if (World.harness) window.__hud = { demo: (m) => this.setDemoMode(m), hud: this };
  }

  /** Harness: switch the demo UI state in place (tools/game_shots.mjs drives this). */
  setDemoMode(mode) {
    this.buy.close(); this.buy.demo = null;
    this.menus.hide();
    this.killfeed.clear();
    this.scoreboard.show(false);
    this.root.querySelector('.icon-sheet')?.remove();
    this.ui.querySelector('.icon-sheet')?.remove();
    for (const el of [this.$rend, this.$prog, this.$hint, this.$alert, this.$spec]) el.classList.remove('on');
    this.$alert.className = 'hud-alert';
    this.root.classList.remove('spectating');
    this.hintText = null; this.specSig = null; this.tbL = this.tbR = null; this.wlSig = null; this.xhSig = '';
    this.dmg = []; this.roundEndUntil = 0;
    const r = demoRoster();
    r.T[0].alive = true; r.T[0].health = 100; r.T[0].money = 3150;
    r.T[0].armor = 100; r.T[0].helmet = true;
    r.T[0].inventory = { primary: 'ak47', secondary: 'glock', knife: 'knife', grenades: ['flashbang', 'smokegrenade', 'molotov'], c4: null };
    this.demoMode = mode || 'hud';
    this._setupDemo();
  }

  // ---- input -----------------------------------------------------------------------------
  _impulse(imp) {
    if (World.harness && !this.params.has('live')) return;
    if (imp === 'menu') {
      if (performance.now() < this.ignoreMenuUntil) return;
      if (this.buy.open) { this.buy.close(true); return; }
      const scr = this.menus.open;
      if (scr === 'pause') { this.resume(); return; }
      if (scr === 'settings' || scr === 'controls' || (scr === 'team' && this.inGame())) { this.menus.goBack(); return; }
      if (scr === 'team') { this.menus.showMain(); return; }
      if (!scr && this.inGame()) this._pause();
      return;
    }
    if (imp === 'buymenu') {
      if (!this.inGame() || this.menus.open) return;
      if (this.buy.open) { this.buy.close(true); return; }
      const M = World.match, L = World.local;
      if (!L || L.alive === false) return;
      if (!M.canBuyNow(L)) {
        const late = M.phase !== 'freeze' && M.buyTimeLeft <= 0;
        this._hintFlash(late ? 'The buy period has expired' : 'You are not in a buy zone');
        return;
      }
      this.expectUnlock = true;
      World.input?.unlock?.();
      this.buy.show(M.localTeam);
      return;
    }
    if (imp === 'teammenu' && this.inGame() && !this.menus.open && !this.buy.open) {
      this.expectUnlock = true;
      World.input?.unlock?.();
      this._setPaused(true);
      this.menus.showTeam(true);
    }
  }

  _pause() {
    this.expectUnlock = true;
    World.input?.unlock?.();
    this._setPaused(true);
    this.menus.showPause();
  }

  _pointerLock(e) {
    if (e.locked) { this.expectUnlock = false; return; }
    if (this.expectUnlock) { this.expectUnlock = false; return; }
    // Esc released the pointer: open the pause menu (the Esc keydown may also arrive).
    if (this.inGame() && !this.menus.open && !this.buy.open && World.match.phase !== 'matchend') {
      this.ignoreMenuUntil = performance.now() + 350;
      this._setPaused(true);
      this.menus.showPause();
    }
  }

  _hintFlash(text) { this.hintFlash = text; this.hintFlashUntil = this.t + 2.2; }

  // ---- events ----------------------------------------------------------------------------
  _onKill(e) {
    const name = (x) => (x ? { name: x.name || 'Player', team: x.team } : null);
    this.killfeed.push({ ...e, attacker: name(e.attacker), assister: name(e.assister), victim: name(e.victim) }, this.t);
    if (e.victim === World.local) { this.spec.deathT = this.t; this.spec.killer = e.attacker; }
  }

  _onDamage(e) {
    const L = World.local;
    if (!L || e?.victim !== L || !(e.amount > 0)) return;
    const a = e.attacker;
    let dx, dz;
    if (a?.origin) { dx = a.origin.x - L.origin.x; dz = a.origin.z - L.origin.z; }
    else if (e.dir) { dx = -e.dir.x; dz = -e.dir.z; }
    else return;
    if (Math.abs(dx) + Math.abs(dz) < 1e-3) return;
    const yawTo = Math.atan2(-dz, dx) * 180 / Math.PI;
    const viewYaw = World.input?.yaw ?? L.yaw ?? 0;
    const screenAngle = -(yawTo - viewYaw);
    const slot = this.dmg.length < DMG_ARCS ? this.dmg.length : this.dmg.reduce((m, d, i, arr) => (d.t0 < arr[m].t0 ? i : m), 0);
    this.dmg[slot] = { angle: screenAngle, t0: this.t, strength: Math.min(1, 0.45 + e.amount / 60) };
  }

  _onRoundStart() {
    this.roundEndUntil = 0;
    setCls(this.$rend, 'on', false);
    this._endSpectate();
    this.money = null;
  }

  _onLive() { /* buy phase over when mp_buytime expires; nothing to show */ }

  _onRoundEnd(e) {
    const M = World.match;
    const info = M?.lastRoundEnd || e;
    this._showRoundEnd(info);
    if (this.buy.open) this.buy.close(false);
  }

  _showRoundEnd(info) {
    const w = info.winner;
    const mvp = info.mvp;
    this.$rend.innerHTML = `
      <div class="re-band t-${w}">
        <div class="re-emblem">${icon(w === 'CT' ? 'headCT' : 'headT')}</div>
        <div class="re-text"><div class="re-title">${TEAM_WIN[w]}</div><div class="re-reason">${REASON_TEXT[info.reason] || ''}</div></div>
      </div>
      ${mvp ? `<div class="re-mvp">${icon('star')}<span class="re-mvp-l">Round MVP</span><b class="t-${mvp.team}">${esc(mvp.name)}</b><em>for ${esc(info.mvpReason || 'most eliminations')}</em></div>` : ''}`;
    setCls(this.$rend, 'on', true);
    this.$rend.classList.remove('anim'); void this.$rend.offsetWidth; this.$rend.classList.add('anim');
    this.roundEndUntil = this.t + 6;
  }

  _onMatchEnd(e) {
    this.buy.close(false);
    World.input?.unlock?.();
    this.expectUnlock = true;
    setTimeout(() => { this.menus.showMatchEnd(e); }, 2200);
  }

  _alert(text, kind = 'neutral', dur = 3) {
    this.$alert.innerHTML = `${kind === 'bomb' ? icon('bomb') : ''}<span>${esc(text)}</span>`;
    this.$alert.className = 'hud-alert on k-' + kind;
    this.alertUntil = this.t + dur;
  }

  // ---- spectator -------------------------------------------------------------------------
  _endSpectate() {
    const s = this.spec;
    if (World.cameraOverride === s.override) World.cameraOverride = null;
    if (s.vm != null) { World.cvar.r_drawviewmodel = s.vm; s.vm = null; }
    s.target = null;
  }

  _spectate(dt) {
    const L = World.local, s = this.spec, I = World.input;
    const mates = World.entities.filter((e) => e !== L && e.team === L.team && e.alive !== false);
    const btn = (!this.captureInput && I) ? I.buttons : 0;
    const a1 = !!(btn & IN_ATTACK), a2 = !!(btn & IN_ATTACK2);
    if (!s.target || s.target.alive === false || s.target.team !== L.team) s.target = mates[0] || null;
    if (mates.length > 1 && ((a1 && !s.prevAttack) || (a2 && !s.prevAttack2))) {
      const i = mates.indexOf(s.target);
      s.target = mates[(i + (a1 ? 1 : mates.length - 1) + mates.length) % mates.length];
    }
    s.prevAttack = a1; s.prevAttack2 = a2;
    // short death cam before switching to a teammate
    const deathCam = this.t - s.deathT < 1.6;
    const tgt = deathCam ? null : s.target;
    if (s.vm == null) { s.vm = World.cvar.r_drawviewmodel; World.cvar.r_drawviewmodel = 0; }
    const o = s.override;
    if (tgt?.origin) {
      const pitch = Math.max(-30, Math.min(55, I?.pitch ?? 10)), yaw = I?.yaw ?? 0;
      angleVectors(pitch, yaw, _vec);
      const base = _v.copy(tgt.renderOrigin || tgt.origin); base.y += 60;
      let dist = 118;
      const col = World.collision;
      if (col?.rayTrace) {
        const end = o.eye.copy(base).addScaledVector(_vec.forward, -dist - 12);
        const tr = col.rayTrace(base, end, 1);
        if (tr.fraction < 1) dist = Math.max(16, tr.fraction * (dist + 12) - 12);
      }
      o.eye.copy(base).addScaledVector(_vec.forward, -dist);
      o.pitch = pitch; o.yaw = yaw;
    } else if (L.origin) {
      // death cam: from where we died, turn toward the killer
      if (World.cameraOverride !== o) { o.eye.copy(L.origin); o.eye.y += 64; o.pitch = I?.pitch ?? 0; o.yaw = I?.yaw ?? 0; }
      const k = s.killer;
      if (k?.origin && k !== L) {
        const dx = k.origin.x - o.eye.x, dz = k.origin.z - o.eye.z, dy = k.origin.y + 50 - o.eye.y;
        const want = Math.atan2(-dz, dx) * 180 / Math.PI;
        let d = ((want - o.yaw + 540) % 360) - 180;
        o.yaw += d * Math.min(1, dt * 5);
        const wantP = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
        o.pitch += (wantP - o.pitch) * Math.min(1, dt * 5);
        if (I) { I.yaw = o.yaw; I.pitch = o.pitch; }
      }
    }
    World.cameraOverride = o;
    const cam = World.camera;
    if (cam) { cam.position.copy(o.eye); applyViewAngles(cam, o.pitch, o.yaw, 0); }
    return deathCam ? null : s.target;
  }

  // ---- per frame -------------------------------------------------------------------------
  update(dt) {
    this.t += dt;
    this.flyover.update(dt);
    if (this.demoMode) { this._demoFrame(dt); return; }
    const M = World.match, L = World.local;
    const inGame = this.inGame();
    this.visible = inGame && !(this.menus.open && this.menus.open !== 'pause' && this.menus.open !== 'team' && this.menus.open !== 'settings' && this.menus.open !== 'controls');
    if (this.menus.open === 'matchend') this.visible = false;
    this._syncVisibility();
    setCls(this.$click, 'on', inGame && !this.captureInput && !World.input?.locked && !World.harness && M.phase !== 'matchend');
    if (!inGame || !L) { this.scoreboard.show(false); return; }

    // spectator camera when dead
    let specTarget = null;
    if (L.alive === false) specTarget = this._spectate(dt);
    else if (this.spec.vm != null || World.cameraOverride === this.spec.override) this._endSpectate();
    const subject = specTarget || L;

    this._vitals(subject);
    this._weapons(subject);
    this._moneyFrame(L, M);
    this._topbar(M, L);
    this._radarFrame(L, M);
    this._crosshair(subject, L.alive === false && !specTarget);
    this._overlays(subject, dt);
    this._progress(M, L);
    this._hints(M, L);
    this._specBar(L, specTarget);
    this.killfeed.update(this.t);
    if (this.roundEndUntil && this.t > this.roundEndUntil) { this.roundEndUntil = 0; setCls(this.$rend, 'on', false); }
    if (this.alertUntil && this.t > this.alertUntil) { this.alertUntil = 0; setCls(this.$alert, 'on', false); }
    this._phaseAlerts(M);

    const tab = !!(World.input && (World.input.buttons & IN_SCORE)) && !this.menus.open;
    const forced = M.phase === 'halftime' || (M.phase === 'matchend');
    this.scoreboard.show(tab || forced);
    if (this.scoreboard.visible) this.scoreboard.update(this._sbData(M, forced ? (M.phase === 'halftime' ? 'Halftime' : 'Match over') : ''), this.t);
    if (this.buy.open) {
      if (!M.canBuyNow(L)) this.buy.close(true);
      else this.buy.refresh();
    }
  }

  _syncVisibility() {
    setCls(this.root, 'on', this.visible);
  }

  _vitals(e) {
    const hp = Math.max(0, Math.round(e.health ?? 0)), ar = Math.max(0, Math.round(e.armor ?? 0));
    setText(this.$hp, hp);
    setStyle(this.$hpBar, 'width', hp + '%');
    setCls(this.$hpBox, 'low', hp <= 20);
    setText(this.$ar, ar);
    setStyle(this.$arBar, 'width', ar + '%');
    const aic = e.helmet ? 'armorhelmet' : 'armor';
    if (this.$arIc._k !== aic) { this.$arIc._k = aic; this.$arIc.innerHTML = icon(aic); }
    setCls(this.$kit, 'on', !!e.defuser);
  }

  _activeWeapon(e) {
    const W = World.weapons;
    let w = null;
    try { w = W?.activeWeapon?.(e) ?? W?.active?.(e) ?? null; } catch { w = null; }
    if (!w) {
      const a = e.active;
      if (a && typeof a === 'object') w = a;
      else if (typeof a === 'string') w = e.inventory?.[a] ?? a;
    }
    return w;
  }

  _weapons(e) {
    const w = this._activeWeapon(e);
    const key = keyOf(w);
    let clip = null, res = null;
    if (w && typeof w === 'object') {
      clip = w.clip ?? w.ammo ?? w.inClip ?? null;
      res = w.reserve ?? w.ammoReserve ?? w.reserveAmmo ?? null;
    }
    try {
      const am = World.weapons?.ammo?.(e);
      if (am) { clip = am.clip ?? clip; res = am.reserve ?? res; }
    } catch { /* optional API */ }
    const it = item(key);
    const hasAmmo = clip != null && it && it.slot !== 'knife' && it.slot !== 'grenade' && key !== 'c4';
    setCls(this.$ammo, 'on', hasAmmo);
    if (hasAmmo) {
      setText(this.$clip, clip);
      setText(this.$res, res ?? '');
      const mag = it?.mag || 30;
      setCls(this.$ammo, 'low', clip <= Math.max(1, Math.floor(mag * 0.2)));
    }
    setText(this.$wname, key ? nameOf(key) : '');
    if (key !== this.lastWeapon) { this.lastWeapon = key; this.wlUntil = this.t + 2.6; }
    // weapon list (inventory), shown briefly after switching
    const inv = e.inventory || {};
    const g = inv.grenades || [];
    const ws = this._wls || (this._wls = []);
    let changed = ws[0] !== inv.primary || ws[1] !== inv.secondary || ws[2] !== inv.knife || ws[3] !== inv.c4 || ws[4] !== inv.taser || ws[5] !== w || ws[6] !== g.length || this.wlSig !== 'live';
    for (let i = 0; !changed && i < g.length; i++) if (ws[7 + i] !== g[i]) changed = true;
    if (changed) {
      ws.length = 0; ws.push(inv.primary, inv.secondary, inv.knife, inv.c4, inv.taser, w, g.length, ...g);
      this.wlSig = 'live';
      const row = (n, k, extra = '') => k ? `<div class="wl-row${k === key ? ' on' : ''}${extra}"><span class="wl-ic">${icon(k)}</span><span class="wl-n">${n}</span></div>` : '';
      let nades = '';
      for (const gk of g) { const k = keyOf(gk); nades += `<span class="wl-nade${k === key ? ' on' : ''}">${icon(k)}</span>`; }
      setHTML(this.$wl,
        row(1, keyOf(inv.primary), ' wide') + row(2, keyOf(inv.secondary)) + row(3, keyOf(inv.knife) || 'knife') +
        (keyOf(inv.taser) ? row(3, keyOf(inv.taser)) : '') +
        (nades ? `<div class="wl-row nades${g.some((x) => keyOf(x) === key) ? ' on' : ''}">${nades}<span class="wl-n">4</span></div>` : '') +
        row(5, keyOf(inv.c4) ? 'c4' : null, ' c4'));
    }
    setCls(this.$wl, 'on', this.t < this.wlUntil || !!this.demoMode);
  }

  _moneyFrame(L, M) {
    const m = L.money | 0;
    if (this.money === null) this.money = m;
    if (m !== this.money) {
      const d = m - this.money;
      this.money = m;
      this.$moneyD.textContent = (d > 0 ? '+$' : '-$') + Math.abs(d);
      this.$moneyRow.classList.remove('up', 'down'); void this.$moneyRow.offsetWidth;
      this.$moneyRow.classList.add(d > 0 ? 'up' : 'down');
    }
    setText(this.$money, '$' + m);
    setCls(this.$buyIc, 'on', !!M?.canBuyNow?.(L));
  }

  /** Players per side, local first then by id. Cached per frame (reused arrays). */
  _roster() {
    const r = this._ros || (this._ros = { T: [], CT: [], frame: -1 });
    if (r.frame === World.frame && World.frame > 0) return r;
    r.frame = World.frame;
    r.T.length = 0; r.CT.length = 0;
    for (const e of World.entities) { if (e.team === 'T') r.T.push(e); else if (e.team === 'CT') r.CT.push(e); }
    r.T.sort(byRoster); r.CT.sort(byRoster);
    return r;
  }

  _topbar(M, L) {
    const r = this._roster();
    const lt = M.localTeam;
    const av = (list, side) => {
      let s = '';
      for (let i = 0; i < 5; i++) {
        const e = list[i];
        if (!e) { s += `<span class="tb-av empty"></span>`; continue; }
        const dead = e.alive === false;
        const hp = Math.max(0, Math.min(100, e.health | 0));
        const bomb = side === 'T' && lt === 'T' && M.bomb?.carrier === e;
        s += `<span class="tb-av t-${side}${dead ? ' dead' : ''}${e.isLocal ? ' me' : ''}">${icon(side === 'CT' ? 'headCT' : 'headT')}${bomb ? `<em class="tb-c4">${icon('bomb')}</em>` : ''}${!dead && side === lt ? `<i style="width:${hp}%"></i>` : ''}${dead ? `<u>${icon('x')}</u>` : ''}</span>`;
      }
      return s;
    };
    const sigL = sideSig(r.CT, M.bomb?.carrier) + (lt === 'CT' ? 1 : 2);
    const sigR = sideSig(r.T, M.bomb?.carrier) + (lt === 'CT' ? 3 : 4);
    if (sigL !== this.tbL) { this.tbL = sigL; this.$avL.innerHTML = av(r.CT, 'CT'); }
    if (sigR !== this.tbR) { this.tbR = sigR; this.$avR.innerHTML = av(r.T, 'T'); }
    setText(this.$scCT, M.score.CT);
    setText(this.$scT, M.score.T);
    const planted = M.bomb?.state === 'planted' && (M.phase === 'planted' || M.phase === 'roundend');
    setCls(this.$clock, 'planted', planted);
    const clk = M.clock();
    setText(this.$time, fmtClock(clk));
    setCls(this.$clock, 'low', M.phase === 'live' && clk <= 10);
    setCls(this.$clock, 'freeze', M.phase === 'freeze' || M.phase === 'halftime');
    const ph = M.phase === 'freeze' ? 'Freeze time' : M.phase === 'halftime' ? 'Halftime' : M.phase === 'warmup' ? 'Warmup' : planted ? 'Bomb planted' : `Round ${Math.min(M.roundNumber, 99)}`;
    setText(this.$phase, ph);
  }

  _radarFrame(L, M) {
    const blips = this._blips || (this._blips = []);
    blips.length = 0;
    const pool = this._bpool || (this._bpool = []);
    let pi = 0;
    const B = (x, z, kind, yaw = null, color = null, carrier = false) => {
      const o = pool[pi] || (pool[pi] = {});
      pi++;
      o.x = x; o.z = z; o.kind = kind; o.yaw = yaw; o.color = color; o.carrier = carrier; o.label = null;
      blips.push(o);
    };
    const lt = L.team;
    const r = this._roster();
    const mates = r[lt] || [];
    mates.forEach((e, i) => {
      if (e === L) return;
      if (e.alive === false) return;
      B(e.origin.x, e.origin.z, 'mate', e.yaw, teammateColor(i), M.bomb?.carrier === e && lt === 'T');
    });
    // spotted enemies: line of sight from any living teammate (throttled)
    this._spotted(L, M);
    for (const e of World.entities) {
      if (e.team && e.team !== lt && e.alive !== false && this.spotted?.get(e) > this.t) B(e.origin.x, e.origin.z, 'enemy');
    }
    for (const d of M.deaths) B(d.x, d.z, d.team === lt ? 'dead' : 'deadenemy', null, d.team === lt ? 'rgba(255,255,255,0.85)' : 'rgba(255,80,70,0.8)');
    const b = M.bomb;
    if (b?.state === 'dropped' && lt === 'T') B(b.pos.x, b.pos.z, 'bomb');
    if (b?.state === 'planted') B(b.pos.x, b.pos.z, 'bombplanted');
    const me = this.spec.target && L.alive === false ? this.spec.target : L;
    if (L.alive !== false) B(L.origin.x, L.origin.z, 'self', World.input?.yaw ?? L.yaw, null, M.bomb?.carrier === L);
    const view = this._view || (this._view = { x: 0, z: 0, yaw: 0, rotate: true });
    view.x = me.origin.x; view.z = me.origin.z;
    view.yaw = me === L ? (World.input?.yaw ?? L.yaw) : me.yaw;
    view.rotate = Settings.radarRotate;
    this.radar.draw(view, blips, this.t);
    setText(this.$loc, this._location(me.origin));
  }

  _spotted(L, M) {
    if (!this.spotted) this.spotted = new Map();
    if (this.t < (this.nextSpot || 0)) return;
    this.nextSpot = this.t + 0.1;
    const col = World.collision;
    if (!col?.rayTrace) return;
    const lt = L.team;
    const eyes = World.entities.filter((e) => e.team === lt && e.alive !== false && e.origin);
    const a = this._sa || (this._sa = new THREE.Vector3()), b2 = this._sb || (this._sb = new THREE.Vector3());
    for (const en of World.entities) {
      if (!en.team || en.team === lt || en.alive === false || !en.origin) continue;
      for (const m of eyes) {
        if (m.origin.distanceToSquared(en.origin) > 3500 * 3500) continue;
        a.copy(m.origin); a.y += 64;
        b2.copy(en.origin); b2.y += 50;
        // rough FOV check (CS spots within the view cone)
        const dx = b2.x - a.x, dz = b2.z - a.z;
        const ang = Math.atan2(-dz, dx) * 180 / Math.PI;
        const my = m === L ? (World.input?.yaw ?? m.yaw) : m.yaw;
        if (Math.abs(((ang - my + 540) % 360) - 180) > 60) continue;
        const tr = col.rayTrace(a, b2, 1);
        if (tr.fraction >= 0.999) {
          if (World.fx?.smokeOcclusion && World.fx.smokeOcclusion(a, b2) > 0.6) continue;
          this.spotted.set(en, this.t + 0.6);
          break;
        }
      }
    }
  }

  _location(p) {
    const co = World.map?.callouts;
    if (!co || !p) return '';
    let best = null, bestVol = Infinity;
    for (const [k, z] of Object.entries(co)) {
      if (!z?.min) continue;
      if (p.x < z.min.x || p.x > z.max.x || p.z < z.min.z || p.z > z.max.z || p.y < z.min.y - 80 || p.y > z.max.y + 80) continue;
      const vol = (z.max.x - z.min.x) * (z.max.z - z.min.z);
      if (vol < bestVol) { bestVol = vol; best = z.name || k; }
    }
    if (!best) return '';
    return CALLOUTS[best] || (/[A-Z ]/.test(best) ? best : best.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  _crosshair(e, hide) {
    const wk = keyOf(this._activeWeapon(e));
    const scoped = !!e.scoped && (SNIPERS.has(wk) || RIFLE_SCOPES.has(wk));
    const show = !hide && !scoped && e.alive !== false && !this.captureInput;
    setCls(this.$xh, 'off', !show);
    if (!show) return;
    const c = Settings.crosshair;
    let spread = 0;
    if (c.dynamic) {
      let inacc = 0;
      try { inacc = World.weapons?.currentInaccuracy?.(e) ?? 0; } catch { inacc = 0; }
      const vfov = World.camera?.fov || 73.74;
      spread = spreadToPx(inacc, vfov, this.H) * 0.5;
      this.xhSpread = this.xhSpread == null ? spread : this.xhSpread + (spread - this.xhSpread) * Math.min(1, World.dt * 18);
      spread = this.xhSpread;
    }
    const sig = Math.round(spread) + '|' + this.H;
    if (sig === this.xhSig) return;
    this.xhSig = sig;
    drawCrosshair(this.xctx, c, this.H, spread);
  }

  _overlays(e, dt) {
    const w = keyOf(this._activeWeapon(e));
    const scoped = !!e.scoped && (SNIPERS.has(w) || RIFLE_SCOPES.has(w));
    setCls(this.$scope, 'on', scoped);
    setCls(this.$scope, 'rifle', scoped && RIFLE_SCOPES.has(w));
    let blind = 0;
    try { blind = World.local?.alive !== false ? (World.fx?.blindAmount?.(World.local) ?? 0) : 0; } catch { blind = 0; }
    setStyle(this.$flash, 'opacity', blind > 0.002 ? Math.min(1, blind).toFixed(3) : '0');
    // damage arcs
    for (let i = 0; i < DMG_ARCS; i++) {
      const d = this.dmg[i], el = this.dmgEls[i];
      if (!d) { setStyle(el, 'opacity', '0'); continue; }
      const age = this.t - d.t0;
      const a = age < 0.08 ? age / 0.08 : Math.max(0, 1 - (age - 0.08) / 1.4);
      setStyle(el, 'opacity', (a * d.strength).toFixed(3));
      el.setAttribute('transform', `rotate(${d.angle.toFixed(1)})`);
      if (a <= 0) this.dmg[i] = null;
    }
  }

  _progress(M, L) {
    const b = M.bomb;
    let on = false;
    if (b.defuser && (b.defuser === L || (b.defuser.team === L.team))) {
      on = true;
      const p = b.defuseProgress / b.defuseTime;
      setText(this.$progT, b.defuser === L ? 'Defusing bomb' : `${b.defuser.name} is defusing`);
      setText(this.$progS, Math.max(0, b.defuseTime - b.defuseProgress).toFixed(1) + 's');
      setStyle(this.$progB, 'width', (Math.min(1, p) * 100).toFixed(1) + '%');
      if (this.$progIc._k !== 'defuse') { this.$progIc._k = 'defuse'; this.$progIc.innerHTML = icon('defuse'); }
      setCls(this.$prog, 'kit', !!b.defuser.defuser);
      setCls(this.$prog, 'late', b.timer < b.defuseTime - b.defuseProgress);
    } else if (b.state === 'carried' && b.carrier === L && b.plantProgress > 0) {
      on = true;
      setText(this.$progT, 'Planting bomb');
      setText(this.$progS, Math.max(0, 3.2 - b.plantProgress).toFixed(1) + 's');
      setStyle(this.$progB, 'width', (Math.min(1, b.plantProgress / 3.2) * 100).toFixed(1) + '%');
      if (this.$progIc._k !== 'bomb') { this.$progIc._k = 'bomb'; this.$progIc.innerHTML = icon('bomb'); }
      setCls(this.$prog, 'kit', false); setCls(this.$prog, 'late', false);
    }
    setCls(this.$prog, 'on', on);
  }

  _hints(M, L) {
    let text = null;
    if (this.hintFlash && this.t < this.hintFlashUntil) text = this.hintFlash;
    else if (L.alive !== false) {
      const b = M.bomb;
      if (b.state === 'planted' && L.team === 'CT' && b.defuser !== L && L.origin.distanceTo(b.pos) < 90) text = `Hold <kbd>E</kbd> to defuse the bomb${L.defuser ? '' : ' <em>(no kit: 10s)</em>'}`;
      else if (b.state === 'carried' && b.carrier === L && M.phase === 'live' && b.plantProgress <= 0) {
        const site = M.siteAt(L.origin);
        text = site ? `Hold <kbd>E</kbd> to plant the bomb at site ${site}` : null;
      } else if (b.state === 'dropped' && L.team === 'T' && L.origin.distanceTo(b.pos) < 300) text = 'The bomb is on the ground nearby — walk over it to pick it up';
      else if (M.phase === 'freeze' && M.history.length === 0 && M.canBuyNow(L)) text = 'Press <kbd>B</kbd> to open the buy menu';
    }
    if (text !== this.hintText) {
      this.hintText = text;
      if (text) this.$hint.innerHTML = `<span>${text}</span>`;
      setCls(this.$hint, 'on', !!text);
    }
  }

  _specBar(L, tgt) {
    const on = L.alive === false;
    setCls(this.$spec, 'on', on);
    setCls(this.root, 'spectating', on);
    if (!on) return;
    const s = tgt ? `${tgt.team}|${tgt.name}|${tgt.health | 0}|${tgt.armor | 0}|${keyOf(this._activeWeapon(tgt))}` : 'dead';
    if (s === this.specSig) return;
    this.specSig = s;
    if (!tgt) { this.$spec.innerHTML = `<div class="sp-card"><div class="sp-l"><small>You died</small><b>${this.spec.killer ? 'Killed by ' + esc(this.spec.killer.name) : 'Spectating'}</b></div></div>`; return; }
    const wk = keyOf(this._activeWeapon(tgt));
    this.$spec.innerHTML = `<div class="sp-card t-${tgt.team}">
      <div class="sp-l"><small>Spectating</small><b>${esc(tgt.name)}</b></div>
      <div class="sp-v">${icon('health')}<span>${tgt.health | 0}</span>${icon(tgt.helmet ? 'armorhelmet' : 'armor')}<span>${tgt.armor | 0}</span></div>
      ${wk ? `<div class="sp-w">${icon(wk)}</div>` : ''}
      <div class="sp-keys"><kbd>Mouse 1</kbd> next <kbd>Mouse 2</kbd> previous</div>
    </div>`;
  }

  _phaseAlerts(M) {
    const key = M.phase + '|' + M.history.length;
    if (key === this.phaseKey) return;
    this.phaseKey = key;
    if (M.phase !== 'freeze') return;
    const n = M.history.length;
    const lt = M.localTeam, ot = lt === 'T' ? 'CT' : 'T';
    if (M.score[lt] === 12 || M.score[ot] === 12) {
      if (M.score[lt] === 12 && M.score[ot] === 12) this._alert('Final round', 'neutral', 4);
      else this._alert('Match point', 'neutral', 4);
    } else if (n === 11) this._alert('Last round of the first half', 'neutral', 4);
    else if (n === 0) this._alert('Match started — good luck, have fun', 'neutral', 4);
  }

  _sbData(M, title = '') {
    const r = this._roster();
    return {
      map: 'Dust II', mode: 'Competitive', round: M.roundNumber, maxRounds: 24, score: M.score,
      localTeam: M.localTeam, teams: r, stat: (e) => M.stats.get(e), adr: (e) => M.adr(e),
      history: M.history, swaps: M.swaps, bombCarrier: M.bomb?.carrier, title,
    };
  }

  // ---- harness demo ----------------------------------------------------------------------
  _setupDemo() {
    const mode = this.demoMode;
    this.root.classList.add('demo');
    this.ui.classList.add('demo');
    const r = demoRoster();
    this.visible = !['mainmenu', 'teamselect', 'settings', 'icons', 'matchend'].includes(mode);
    this._syncVisibility();
    const kills = [
      { attacker: r.T[1], victim: r.CT[0], weapon: 'ak47', headshot: true },
      { attacker: r.CT[2], assister: r.CT[3], victim: r.T[3], weapon: 'm4a1s', smoke: true },
      { attacker: r.T[0], victim: r.CT[1], weapon: 'ak47', headshot: true, wallbang: true, local: 'kill' },
      { attacker: r.T[2], victim: r.CT[3], weapon: 'awp', noscope: true },
    ];
    if (mode !== 'roundend') kills.length = 3;
    if (mode === 'spectate' || mode === 'damage') kills.push({ attacker: r.CT[4], victim: r.T[0], weapon: 'awp', local: 'death' });
    for (const k of kills) this._onKill({ ...k });
    this.money = null;
    switch (mode) {
      case 'buymenu':
        r.T[0].money = 4750;
        r.T[0].inventory = { primary: null, secondary: 'glock', knife: 'knife', grenades: ['flashbang'], c4: null };
        r.T[0].armor = 0; r.T[0].helmet = false;
        this.buy.demo = { ent: r.T[0], buyTime: 17.4 };
        this.buy.show('T');
        this.buy.hover = 'ak47'; this.buy._detail();
        break;
      case 'mainmenu':
        this.menus.showMain();
        if (this.params.has('flyover')) this.flyover.start();
        break;
      case 'teamselect': this.menus.showTeam(false); break;
      case 'settings': this.menus.showSettings('main', this.params.get('tab') || 'crosshair'); break;
      case 'pause': this.menus.showPause(); break;
      case 'roundend':
        this._showRoundEnd({ winner: 'T', reason: 'bomb_exploded', mvp: r.T[0], mvpReason: 'planting the bomb' });
        this.roundEndUntil = 1e9;
        break;
      case 'matchend': this._demoMatchEnd(); break;
      case 'damage':
        this.dmg = [{ angle: 60, t0: 1e9, strength: 1 }, { angle: -140, t0: 1e9, strength: 0.7 }];
        break;
      case 'icons': this._iconSheet(); break;
    }
  }

  _demoMatchEnd() {
    const r = demoRoster();
    const fake = { localTeam: 'T', score: { T: 13, CT: 9 }, stats: new Map([[r.T[0], { kills: 27, mvps: 6, score: 64 }]]), adr: () => 112.4 };
    const M = World.match;
    const saved = M && { localTeam: M._localTeam, score: M.score, stats: M.stats, adr: M.adr };
    if (M) { M._localTeam = 'T'; M.score = fake.score; M.stats = fake.stats; M.adr = fake.adr; }
    const sb = {
      map: 'Dust II', mode: 'Competitive', round: 22, maxRounds: 24, score: fake.score, localTeam: 'T', teams: { T: r.T, CT: r.CT },
      stat: (e) => r.stats.get(e), adr: (e) => (r.stats.get(e)?.damage || 0) / 13, history: r.history.concat(r.history.slice(0, 9).map((h, i) => ({ ...h, round: 14 + i, swaps: 1 }))), swaps: 1, title: 'Final',
    };
    this.menus.showMatchEnd({ localWon: true, scoreboard: sb });
    if (M && saved) { M._localTeam = saved.localTeam; M.score = saved.score; M.stats = saved.stats; M.adr = saved.adr; }
  }

  _iconSheet() {
    const el = h('div', 'icon-sheet', '', this.ui);
    el.innerHTML = [...WEAPON_ICON_KEYS, ...GLYPH_KEYS].map((k) => `<div><span>${icon(k)}</span><em>${k}</em></div>`).join('');
  }

  _demoFrame(dt) {
    const mode = this.demoMode;
    if (!this.visible) { this.killfeed.update(0); return; }
    const r = demoPositions();
    const L = r.T[0];
    const M = World.match;
    const timer = mode === 'buymenu' ? 12 : 87;
    // vitals / weapon
    const subject = mode === 'spectate' ? r.T[1] : L;
    if (mode === 'spectate' || mode === 'damage') { L.alive = mode !== 'spectate'; }
    if (mode === 'damage') L.health = 38;
    this._vitals(subject);
    const inv = subject.inventory;
    const wk = mode === 'scope' ? 'awp' : keyOf(inv.primary) || 'glock';
    subject.active = wk;
    const it = item(wk);
    setCls(this.$ammo, 'on', true);
    setText(this.$clip, mode === 'damage' ? 4 : it?.mag ?? 30);
    setText(this.$res, it?.reserve ?? 90);
    setCls(this.$ammo, 'low', mode === 'damage');
    setText(this.$wname, it?.name || '');
    if (mode !== 'buymenu') {
      const g = inv.grenades || [];
      const sig = 'demo' + wk + g.length;
      if (this.wlSig !== sig) {
        this.wlSig = sig;
        let nades = g.map((k) => `<span class="wl-nade">${icon(k)}</span>`).join('');
        this.$wl.innerHTML = `<div class="wl-row wide on"><span class="wl-ic">${icon(wk)}</span><span class="wl-n">1</span></div>` +
          `<div class="wl-row"><span class="wl-ic">${icon(keyOf(inv.secondary) || 'glock')}</span><span class="wl-n">2</span></div>` +
          `<div class="wl-row"><span class="wl-ic">${icon('knife')}</span><span class="wl-n">3</span></div>` +
          (nades ? `<div class="wl-row nades">${nades}<span class="wl-n">4</span></div>` : '');
      }
      setCls(this.$wl, 'on', mode === 'hud');
    }
    // money
    setText(this.$money, '$' + (L.money | 0));
    setCls(this.$buyIc, 'on', mode === 'buymenu');
    // top bar
    const sig = 'demo';
    if (this.tbL !== sig) {
      this.tbL = this.tbR = sig;
      const av = (list, side) => list.map((e) => `<span class="tb-av t-${side}${e.alive ? '' : ' dead'}${e.isLocal ? ' me' : ''}">${icon(side === 'CT' ? 'headCT' : 'headT')}${side === 'T' && e.inventory?.c4 ? `<em class="tb-c4">${icon('bomb')}</em>` : ''}${e.alive && side === 'T' ? `<i style="width:${e.health}%"></i>` : ''}${e.alive ? '' : `<u>${icon('x')}</u>`}</span>`).join('');
      this.$avL.innerHTML = av(r.CT, 'CT');
      this.$avR.innerHTML = av(r.T, 'T');
    }
    setText(this.$scCT, r.score.CT);
    setText(this.$scT, r.score.T);
    const planted = mode === 'planted';
    setCls(this.$clock, 'planted', planted);
    setText(this.$time, fmtClock(timer));
    setCls(this.$clock, 'freeze', mode === 'buymenu');
    setText(this.$phase, mode === 'buymenu' ? 'Freeze time' : planted ? 'Bomb planted' : 'Round 14');
    // radar
    const blips = [];
    r.T.forEach((e, i) => { if (e !== L && e.alive) blips.push({ x: e.origin.x, z: e.origin.z, yaw: e.yaw, kind: 'mate', color: teammateColor(i), carrier: !!e.inventory?.c4 }); });
    blips.push({ x: r.CT[2].origin.x, z: r.CT[2].origin.z, kind: 'enemy' });
    blips.push({ x: r.T[3].origin.x, z: r.T[3].origin.z, kind: 'dead', color: 'rgba(255,255,255,0.85)' });
    blips.push({ x: r.CT[0].origin.x, z: r.CT[0].origin.z, kind: 'deadenemy', color: 'rgba(255,80,70,0.8)' });
    if (planted) blips.push({ x: r.CT[1].origin.x, z: r.CT[1].origin.z, kind: 'bombplanted' });
    if (mode !== 'spectate') blips.push({ x: L.origin.x, z: L.origin.z, yaw: World.input?.yaw ?? 0, kind: 'self' });
    const view = { x: subject.origin.x, z: subject.origin.z, yaw: World.input?.yaw ?? 0, rotate: Settings.radarRotate };
    this.radar.draw(view, blips, this.t);
    setText(this.$loc, this._location(L.origin) || 'Long Doors');
    // crosshair / overlays
    const scope = mode === 'scope';
    setCls(this.$scope, 'on', scope);
    setCls(this.$xh, 'off', scope || mode === 'spectate' || this.captureInput);
    if (!scope && this.xhSig !== 'demo' + this.H) { this.xhSig = 'demo' + this.H; drawCrosshair(this.xctx, Settings.crosshair, this.H, 0); }
    setStyle(this.$flash, 'opacity', mode === 'flash' ? '0.82' : '0');
    for (let i = 0; i < DMG_ARCS; i++) {
      const d = this.dmg[i], el = this.dmgEls[i];
      if (!d) { setStyle(el, 'opacity', '0'); continue; }
      setStyle(el, 'opacity', String(d.strength));
      el.setAttribute('transform', `rotate(${d.angle})`);
    }
    if (planted) {
      setCls(this.$prog, 'on', true);
      setText(this.$progT, 'Defusing bomb');
      setText(this.$progS, '2.4s');
      setStyle(this.$progB, 'width', '52%');
      if (this.$progIc._k !== 'defuse') { this.$progIc._k = 'defuse'; this.$progIc.innerHTML = icon('defuse'); }
      setCls(this.$prog, 'kit', true);
      if (!this.hintText) { this.hintText = 'x'; this.$hint.innerHTML = `<span>Hold <kbd>E</kbd> to defuse the bomb</span>`; setCls(this.$hint, 'on', true); }
      this.$alert.innerHTML = `${icon('bomb')}<span>Bomb planted at A</span>`;
      this.$alert.className = 'hud-alert on k-bomb';
    }
    if (mode === 'spectate') {
      setCls(this.root, 'spectating', true);
      if (!this.specSig) { this.specSig = 'demo'; this._specBar({ alive: false }, r.T[1]); }
    }
    this.killfeed.update(0);
    if (mode === 'scoreboard' || mode === 'halftime') {
      this.scoreboard.show(true);
      this.scoreboard.update({
        map: 'Dust II', mode: 'Competitive', round: 14, maxRounds: 24, score: r.score, localTeam: 'T', teams: { T: r.T, CT: r.CT },
        stat: (e) => r.stats.get(e), adr: (e) => (r.stats.get(e)?.damage || 0) / 13, history: r.history, swaps: 1, bombCarrier: r.T[4], title: mode === 'halftime' ? 'Halftime' : '',
      }, this.t);
    }
    if (this.buy.open) this.buy.refresh();
  }
}
