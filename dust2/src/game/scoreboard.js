// Tab scoreboard (also shown at halftime / match end). CS2 layout: map + round header,
// two team blocks with big scores, per-player K/A/D/ADR/HS%/MVP/score/money/ping, and the
// round-history strip between the teams.
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REASON_ICON = { elimination: 'skull', bomb_exploded: 'exploded', bomb_defused: 'defuse', time: 'clock' };
const TEAM_NAME = { CT: 'Counter-Terrorists', T: 'Terrorists' };

export class Scoreboard {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'scoreboard';
    parent.appendChild(this.el);
    this.visible = false;
    this.nextBuild = 0;
  }

  show(v) { if (v === this.visible) return; this.visible = v; this.el.classList.toggle('on', v); if (v) this.nextBuild = 0; }

  /**
   * d = { map, mode, round, maxRounds, score:{T,CT}, localTeam, teams:{CT:[],T:[]},
   *       stat(e)->{kills,assists,deaths,damage,hs,mvps,score}, adr(e), history:[], swaps,
   *       bombCarrier, title? }
   */
  update(d, now) {
    if (!this.visible || now < this.nextBuild) return;
    this.nextBuild = now + 0.25;
    const block = (side) => {
      const players = [...(d.teams[side] || [])].sort((a, b) => (d.stat(b)?.score ?? 0) - (d.stat(a)?.score ?? 0));
      const mine = side === d.localTeam;
      let rows = '';
      for (const e of players) {
        const s = d.stat(e) || {};
        const dead = e.alive === false;
        const hs = s.kills > 0 ? Math.round((100 * (s.hs || 0)) / s.kills) : 0;
        const adr = d.adr(e);
        const extra = (d.bombCarrier === e && mine ? `<span class="sb-tag">${icon('bomb')}</span>` : '') +
          (e.defuser && mine && !dead ? `<span class="sb-tag">${icon('defuse')}</span>` : '');
        rows += `<div class="sb-row${e.isLocal ? ' sb-me' : ''}${dead ? ' sb-dead' : ''}">
          <span class="sb-ping">${e.isBot ? 'BOT' : '0'}</span>
          <span class="sb-av t-${side}">${icon(side === 'CT' ? 'headCT' : 'headT')}</span>
          <span class="sb-name">${esc(e.name)}${dead ? `<span class="sb-skull">${icon('skull')}</span>` : ''}${extra}</span>
          <span class="sb-money">${mine ? '$' + (e.money | 0) : ''}</span>
          <span class="sb-n">${s.kills | 0}</span><span class="sb-n">${s.assists | 0}</span><span class="sb-n">${s.deaths | 0}</span>
          <span class="sb-n sb-adr">${adr.toFixed(0)}</span><span class="sb-n">${hs}%</span>
          <span class="sb-n sb-mvp">${s.mvps ? `${icon('star')}${s.mvps > 1 ? s.mvps : ''}` : ''}</span>
          <span class="sb-n sb-score">${s.score | 0}</span>
        </div>`;
      }
      const alive = players.filter((e) => e.alive !== false).length;
      return `<div class="sb-team sb-${side}">
        <div class="sb-thead">
          <div class="sb-big">${d.score[side] | 0}</div>
          <div class="sb-tname"><b>${TEAM_NAME[side]}</b><small>${alive} / ${players.length} alive</small></div>
        </div>
        <div class="sb-row sb-colh"><span>Ping</span><span></span><span>Player</span><span>${mine ? 'Money' : ''}</span><span>K</span><span>A</span><span>D</span><span>ADR</span><span>HS%</span><span>MVP</span><span>Score</span></div>
        ${rows}
      </div>`;
    };
    // round history: one column per round; icon above the line if the team now on CT won it
    let hist = '';
    const max = Math.max(d.maxRounds, d.history.length);
    for (let i = 0; i < max; i++) {
      const h = d.history[i];
      if (i === 12) hist += '<span class="sb-half"></span>';
      if (!h) { hist += `<span class="sb-rh${i === d.history.length ? ' sb-cur' : ''}"><i></i><i></i></span>`; continue; }
      const flipped = ((d.swaps || 0) - (h.swaps || 0)) % 2 === 1;
      const nowSide = flipped ? (h.winner === 'T' ? 'CT' : 'T') : h.winner;
      const ic = `<i class="t-${h.winner}">${icon(REASON_ICON[h.reason] || 'skull')}</i>`;
      hist += `<span class="sb-rh">${nowSide === 'CT' ? ic + '<i></i>' : '<i></i>' + ic}</span>`;
    }
    this.el.innerHTML = `
      <div class="sb-panel">
        <div class="sb-head">
          <div class="sb-map"><b>${esc(d.map)}</b><span>${esc(d.mode)}</span></div>
          <div class="sb-title">${esc(d.title || '')}</div>
          <div class="sb-round">Round ${Math.min(d.round, 99)}<span>/ ${d.maxRounds}</span></div>
        </div>
        ${block('CT')}
        <div class="sb-history"><div class="sb-hl">Round history</div><div class="sb-strip">${hist}</div></div>
        ${block('T')}
      </div>`;
  }
}
