// Front-end screens: main menu (over the flyover), team select, settings (with a live
// crosshair editor), controls, pause and match-end. Everything lives in #ui-root.
import { World } from '../core/world.js';
import { icon } from './icons.js';
import { Settings, saveSettings, applySettings, resetSettings, CROSSHAIR_PRESETS, CROSSHAIR_COLORS } from './settings.js';
import { drawCrosshair } from './crosshair.js';
import { Scoreboard } from './scoreboard.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const KEYS = [
  ['Move', 'W A S D'], ['Jump', 'Space'], ['Crouch', 'Ctrl'], ['Walk', 'Shift'],
  ['Fire', 'Mouse 1'], ['Scope / alt-fire', 'Mouse 2'], ['Reload', 'R'], ['Use / defuse / plant', 'E'],
  ['Primary', '1'], ['Secondary', '2'], ['Knife', '3'], ['Grenades', '4'], ['C4', '5'],
  ['Last weapon', 'Q'], ['Drop weapon', 'G'], ['Inspect', 'F'], ['Buy menu', 'B'], ['Scoreboard', 'Tab'],
  ['Team select', 'M'], ['Pause', 'Esc'], ['Debug panel', 'F1'],
];

const DIFFS = [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['expert', 'Expert']];
const SIZES = [[1, '1v1'], [2, '2v2'], [3, '3v3'], [5, '5v5']];

export class Menus {
  constructor(root) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.className = 'menus';
    root.appendChild(this.el);
    this.screen = null;      // 'main' | 'team' | 'settings' | 'controls' | 'pause' | 'matchend'
    this.back = null;        // screen to return to
    this.settingsTab = 'game';
    this.el.addEventListener('click', (e) => this._click(e));
    this.el.addEventListener('input', (e) => this._input(e));
    this.el.addEventListener('change', (e) => this._input(e));
  }

  get open() { return this.screen; }

  _set(screen, html) {
    this.screen = screen;
    this.el.className = 'menus on scr-' + screen;
    this.el.innerHTML = html;
  }

  hide() { this.screen = null; this.el.className = 'menus'; this.el.innerHTML = ''; }

  // ---- main ------------------------------------------------------------------------------
  showMain() {
    const n = (Settings.teamSize || 5) * 2 - 1;
    this._set('main', `
      <div class="mm-shade"></div>
      <div class="mm-top">
        <div class="mm-brand">${icon('bullets')}<span>DUST II</span></div>
        <nav class="mm-nav"><a data-act="play" class="on">Play</a><a data-act="settings">Settings</a><a data-act="controls">Controls</a></nav>
        <div class="mm-profile"><span class="mm-av">${icon('person')}</span><span><b>${esc(Settings.name)}</b><small>Offline · vs Bots</small></span></div>
      </div>
      <div class="mm-left">
        <div class="mm-kicker">Competitive · Defusal</div>
        <h1 class="mm-title">DUST<span>II</span></h1>
        <div class="mm-sub">5v5 · first to 13 · MR12 with overtime</div>
        <div class="mm-buttons">
          <button class="mm-btn primary" data-act="play">${icon('play')}<span>Play</span><em>vs bots</em></button>
          <button class="mm-btn" data-act="settings">${icon('gear')}<span>Settings</span></button>
          <button class="mm-btn" data-act="controls">${icon('mouse')}<span>Controls</span></button>
        </div>
      </div>
      <div class="mm-card">
        <div class="mm-card-h">Match settings</div>
        <div class="mm-row"><span>Map</span><b>de_dust2</b></div>
        <div class="mm-row"><span>Players</span><b>${Settings.teamSize}v${Settings.teamSize} · ${n} bots</b></div>
        <div class="mm-row"><span>Bot difficulty</span><b>${DIFFS.find((d) => d[0] === Settings.difficulty)?.[1] || 'Normal'}</b></div>
        <div class="mm-row"><span>Economy</span><b>$800 start · $16000 max</b></div>
      </div>
      <div class="mm-foot">A from-scratch browser recreation of the Dust II layout. No Valve assets.</div>`);
  }

  // ---- team select ---------------------------------------------------------------------
  showTeam(fromGame = false) {
    this.back = fromGame ? 'pause' : 'main';
    const seg = (name, list, cur) => `<div class="seg" data-seg="${name}">${list.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    this._set('team', `
      <div class="ts-shade"></div>
      <div class="ts-wrap">
        <div class="ts-h"><small>Choose your side</small><h2>Select Team</h2></div>
        <div class="ts-cards">
          <button class="ts-card t-T" data-team="T">
            <div class="ts-emblem">${icon('headT')}</div>
            <div class="ts-name">Terrorists</div>
            <div class="ts-desc">Plant the C4 at bombsite A or B, or eliminate the enemy team.</div>
            <div class="ts-kit">${icon('glock')}<span>Glock-18 · Knife</span></div>
            <kbd>1</kbd>
          </button>
          <button class="ts-card t-CT" data-team="CT">
            <div class="ts-emblem">${icon('headCT')}</div>
            <div class="ts-name">Counter-Terrorists</div>
            <div class="ts-desc">Defend both bombsites, defuse the C4, or eliminate the enemy team.</div>
            <div class="ts-kit">${icon('usp')}<span>USP-S · Knife</span></div>
            <kbd>2</kbd>
          </button>
        </div>
        <div class="ts-opts">
          <div class="ts-opt"><span>Bot difficulty</span>${seg('difficulty', DIFFS, Settings.difficulty)}</div>
          <div class="ts-opt"><span>Team size</span>${seg('teamSize', SIZES, Settings.teamSize)}</div>
        </div>
        <div class="ts-actions">
          <button class="btn ghost" data-act="back">Back</button>
          <button class="btn" data-team="auto">Auto-select <kbd>5</kbd></button>
        </div>
      </div>`);
  }

  // ---- settings ------------------------------------------------------------------------
  showSettings(back = 'main', tab = null) {
    if (tab) this.settingsTab = tab;
    this.back = back;
    const tabs = [['game', 'Game'], ['crosshair', 'Crosshair'], ['video', 'Video'], ['audio', 'Audio'], ['keys', 'Keybinds']];
    this._set('settings', `
      <div class="st-shade"></div>
      <div class="st-panel">
        <div class="st-head"><h2>Settings</h2><div class="st-tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === this.settingsTab ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="st-body">${this._tab(this.settingsTab)}</div>
        <div class="st-foot"><button class="btn ghost" data-act="reset">Reset to defaults</button><span class="st-saved">Saved automatically</span><button class="btn" data-act="back">Done</button></div>
      </div>`);
    this._preview();
  }

  _tab(t) {
    const S = Settings, C = S.crosshair;
    const slider = (path, label, min, max, step, fmt = (v) => v) => {
      const v = this._get(path);
      return `<div class="st-row"><label>${label}</label><div class="st-ctl"><input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${v}"><output data-out="${path}">${fmt(v)}</output></div></div>`;
    };
    const toggle = (path, label) => `<div class="st-row"><label>${label}</label><div class="st-ctl"><button class="tog ${this._get(path) ? 'on' : ''}" data-toggle="${path}"><i></i></button></div></div>`;
    const seg = (path, label, list) => `<div class="st-row"><label>${label}</label><div class="st-ctl"><div class="seg" data-seg="${path}">${list.map(([v, l]) => `<button data-v="${v}" class="${String(this._get(path)) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>`;
    switch (t) {
      case 'game': return `
        <div class="st-group">Mouse</div>
        ${slider('sensitivity', 'Sensitivity', 0.1, 8, 0.01, (v) => (+v).toFixed(2))}
        ${slider('zoomRatio', 'Zoom sensitivity ratio', 0.1, 3, 0.01, (v) => (+v).toFixed(2))}
        <div class="st-group">Player</div>
        <div class="st-row"><label>Name</label><div class="st-ctl"><input type="text" class="st-text" data-path="name" maxlength="20" value="${esc(S.name)}"></div></div>
        <div class="st-group">Radar</div>
        ${slider('radarScale', 'Radar map zoom', 0.4, 1.3, 0.01, (v) => (+v).toFixed(2))}
        ${toggle('radarRotate', 'Rotate radar with view')}
        <div class="st-group">Match</div>
        ${seg('difficulty', 'Bot difficulty', DIFFS)}
        ${seg('teamSize', 'Team size', SIZES)}`;
      case 'crosshair': return `
        <div class="xh-wrap">
          <div class="xh-preview"><canvas width="240" height="240"></canvas><span>Preview</span></div>
          <div class="xh-presets">${Object.keys(CROSSHAIR_PRESETS).map((k) => `<button class="btn ghost sm" data-preset="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        </div>
        ${seg('crosshair.style', 'Style', [['classic', 'Classic (dynamic)'], ['static', 'Classic static']])}
        ${slider('crosshair.size', 'Length', 0, 10, 0.1, (v) => (+v).toFixed(1))}
        ${slider('crosshair.thickness', 'Thickness', 0.1, 3, 0.05, (v) => (+v).toFixed(2))}
        ${slider('crosshair.gap', 'Gap', -5, 5, 0.1, (v) => (+v).toFixed(1))}
        ${toggle('crosshair.outline', 'Outline')}
        ${slider('crosshair.outlineThickness', 'Outline thickness', 0.5, 3, 0.5, (v) => (+v).toFixed(1))}
        ${toggle('crosshair.dot', 'Center dot')}
        ${toggle('crosshair.tStyle', 'T style')}
        ${slider('crosshair.alpha', 'Alpha', 30, 255, 1)}
        <div class="st-row"><label>Color</label><div class="st-ctl sw">${CROSSHAIR_COLORS.map(([n, c]) => `<button class="swatch ${String(c) === String(C.color) ? 'on' : ''}" data-color="${c.join(',')}" title="${n}" style="--c:rgb(${c.join(',')})"></button>`).join('')}</div></div>
        ${slider('crosshair.color.0', 'Red', 0, 255, 1)}
        ${slider('crosshair.color.1', 'Green', 0, 255, 1)}
        ${slider('crosshair.color.2', 'Blue', 0, 255, 1)}`;
      case 'video': return `
        <div class="st-group">Graphics</div>
        ${seg('quality', 'Quality preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])}
        ${slider('fov', 'Field of view (4:3 horizontal)', 70, 110, 1, (v) => v + '°')}
        <div class="st-note">CS uses a fixed 90° (4:3) FOV. Quality changes apply instantly.</div>`;
      case 'audio': return `
        <div class="st-group">Volume</div>
        ${slider('volume', 'Master volume', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')}`;
      case 'keys': return `<div class="kb-grid">${KEYS.map(([a, k]) => `<div class="kb-row"><span>${a}</span><span>${k.split(' ').length > 1 && k.length > 5 && !k.startsWith('Mouse') ? k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('') : `<kbd>${k}</kbd>`}</span></div>`).join('')}</div>
        <div class="st-note">Default Counter-Strike binds. Rebinding is not supported in this build.</div>`;
    }
    return '';
  }

  _get(path) {
    let o = Settings;
    for (const p of path.split('.')) o = o?.[p];
    return o;
  }

  _setPath(path, v) {
    const parts = path.split('.');
    let o = Settings;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    const last = parts[parts.length - 1];
    const cur = o[last];
    if (typeof cur === 'number') v = +v;
    else if (typeof cur === 'boolean') v = !!v;
    o[last] = v;
    saveSettings();
    const top = parts[0];
    if (top === 'crosshair') {
      Settings.crosshair.dynamic = Settings.crosshair.style !== 'static';
      this._preview();
      World.emit('settings', { which: 'crosshair' });
    } else applySettings(top);
  }

  _preview() {
    const cv = this.el.querySelector('.xh-preview canvas');
    if (!cv) return;
    drawCrosshair(cv.getContext('2d'), Settings.crosshair, innerHeight, 0);
  }

  // ---- controls ------------------------------------------------------------------------
  showControls(back = 'main') {
    this.back = back;
    this._set('controls', `
      <div class="st-shade"></div>
      <div class="st-panel narrow">
        <div class="st-head"><h2>Controls</h2></div>
        <div class="st-body"><div class="kb-grid">${KEYS.map(([a, k]) => `<div class="kb-row"><span>${a}</span><span><kbd>${k}</kbd></span></div>`).join('')}</div>
        <div class="st-note">Click the game to capture the mouse. Buy during freeze time and the first 20 seconds of a round, inside your spawn's buy zone. Hold <kbd>E</kbd> on the planted C4 to defuse (5 s with a kit, 10 s without).</div></div>
        <div class="st-foot"><span></span><button class="btn" data-act="back">Done</button></div>
      </div>`);
  }

  // ---- pause ---------------------------------------------------------------------------
  showPause() {
    const M = World.match;
    const sc = M ? `<div class="pz-score"><span class="t-CT">${M.score.CT}</span><em>:</em><span class="t-T">${M.score.T}</span></div>` : '';
    this._set('pause', `
      <div class="pz-shade"></div>
      <div class="pz-panel">
        <div class="pz-h"><small>Match paused</small><h2>Paused</h2>${sc}</div>
        <button class="mm-btn primary" data-act="resume">${icon('play')}<span>Resume</span></button>
        <button class="mm-btn" data-act="team">${icon('person')}<span>Change team</span></button>
        <button class="mm-btn" data-act="settings">${icon('gear')}<span>Settings</span></button>
        <button class="mm-btn" data-act="controls">${icon('mouse')}<span>Controls</span></button>
        <button class="mm-btn danger" data-act="leave">${icon('x')}<span>Leave match</span></button>
      </div>`);
  }

  // ---- match end -----------------------------------------------------------------------
  showMatchEnd(info) {
    const M = World.match;
    const won = info?.localWon;
    const lt = M?.localTeam || 'T';
    const mine = M?.score?.[lt] ?? 0, theirs = M?.score?.[lt === 'T' ? 'CT' : 'T'] ?? 0;
    let best = null;
    if (M) for (const [e, s] of M.stats) if (!best || s.mvps > best.s.mvps || (s.mvps === best.s.mvps && s.score > best.s.score)) best = { e, s };
    this._set('matchend', `
      <div class="me-shade ${won ? 'win' : 'loss'}"></div>
      <div class="me-wrap">
        <div class="me-kicker">Match complete · de_dust2</div>
        <div class="me-result ${won ? 'win' : 'loss'}">${won ? 'Victory' : 'Defeat'}</div>
        <div class="me-score"><span class="${won ? 'w' : ''}">${mine}</span><em>–</em><span class="${won ? '' : 'w'}">${theirs}</span></div>
        ${best ? `<div class="me-mvp">${icon('star')}<span>Match MVP</span><b class="t-${best.e.team}">${esc(best.e.name)}</b><em>${best.s.kills} kills · ${best.s.mvps} MVPs · ${Math.round(M.adr(best.e))} ADR</em></div>` : ''}
        <div class="me-sb"></div>
        <div class="me-actions"><button class="btn ghost" data-act="leave">Main menu</button><button class="btn" data-act="again">Play again</button></div>
      </div>`);
    // final scoreboard under the result
    const data = info?.scoreboard || (M && World.hud?._sbData?.(M, 'Final'));
    if (data) {
      const sb = new Scoreboard(this.el.querySelector('.me-sb'));
      sb.el.classList.add('inline');
      sb.show(true);
      sb.update(data, 0);
    }
  }

  // ---- events --------------------------------------------------------------------------
  _click(e) {
    World.audio?.unlock?.();
    const t = e.target.closest('button, a, [data-act]');
    if (!t) return;
    const hud = World.hud;
    if (t.dataset.tab) { this.settingsTab = t.dataset.tab; this.showSettings(this.back); return; }
    if (t.dataset.preset) {
      Object.assign(Settings.crosshair, JSON.parse(JSON.stringify(CROSSHAIR_PRESETS[t.dataset.preset])));
      saveSettings(); World.emit('settings', { which: 'crosshair' });
      this.showSettings(this.back);
      return;
    }
    if (t.dataset.color) {
      Settings.crosshair.color = t.dataset.color.split(',').map(Number);
      saveSettings(); World.emit('settings', { which: 'crosshair' });
      this.showSettings(this.back);
      return;
    }
    if (t.dataset.toggle) { this._setPath(t.dataset.toggle, !this._get(t.dataset.toggle)); t.classList.toggle('on'); return; }
    const segEl = t.closest('.seg');
    if (segEl && t.dataset.v !== undefined) {
      const path = segEl.dataset.seg;
      for (const b of segEl.querySelectorAll('button')) b.classList.toggle('on', b === t);
      this._setPath(path, t.dataset.v);
      if (path === 'crosshair.style') this.showSettings(this.back);
      return;
    }
    if (t.dataset.team) { hud?.chooseTeam?.(t.dataset.team); return; }
    switch (t.dataset.act) {
      case 'play': this.showTeam(false); break;
      case 'settings': this.showSettings(this.screen === 'pause' ? 'pause' : 'main'); break;
      case 'controls': this.showControls(this.screen === 'pause' ? 'pause' : 'main'); break;
      case 'team': this.showTeam(true); break;
      case 'back': this.goBack(); break;
      case 'reset': resetSettings(); World.emit('settings', { which: 'crosshair' }); this.showSettings(this.back); break;
      case 'resume': hud?.resume?.(); break;
      case 'leave': hud?.leaveMatch?.(); break;
      case 'again': hud?.playAgain?.(); break;
    }
  }

  goBack() {
    const b = this.back || 'main';
    this.back = null;
    if (b === 'pause') this.showPause();
    else if (b === 'main') this.showMain();
    else this.hide();
  }

  _input(e) {
    const t = e.target;
    const path = t.dataset?.path;
    if (!path) return;
    if (t.type === 'text') {
      if (e.type === 'change') { Settings.name = t.value.trim().slice(0, 20) || 'Player'; saveSettings(); if (World.local) World.local.name = Settings.name; }
      return;
    }
    this._setPath(path, t.value);
    const out = this.el.querySelector(`output[data-out="${path}"]`);
    if (out) {
      const v = +t.value;
      out.textContent = path === 'volume' ? Math.round(v * 100) + '%' : path === 'fov' ? v + '°' : Number.isInteger(+t.step) ? String(v) : v.toFixed(t.step < 0.05 ? 2 : 1);
    }
  }

  /** Keyboard shortcuts on menu screens (called by the HUD's key hook). */
  key(code) {
    if (this.screen === 'team') {
      if (code === 'Digit1') { World.hud?.chooseTeam?.('T'); return true; }
      if (code === 'Digit2') { World.hud?.chooseTeam?.('CT'); return true; }
      if (code === 'Digit5') { World.hud?.chooseTeam?.('auto'); return true; }
    }
    return false;
  }
}
