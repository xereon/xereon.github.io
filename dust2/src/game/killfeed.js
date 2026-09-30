// Kill feed (top-right). Newest entry at the bottom, like CS. Entries involving the local
// player get the red outline (your kill) or red fill (your death).
import { icon, hasIcon } from './icons.js';
import { keyOf } from './economy.js';

const MAX = 6;
const LIFE = 6.5, LIFE_LOCAL = 10;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class KillFeed {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'killfeed';
    parent.appendChild(this.el);
    this.items = [];
  }

  /**
   * e = { attacker:{name,team}, assister?, victim:{name,team}, weapon, headshot, wallbang,
   *       smoke, noscope, blind, flashAssist, local: 'kill'|'death'|null, suicide }
   */
  push(e, now) {
    const row = document.createElement('div');
    row.className = 'kf-row' + (e.local === 'kill' ? ' kf-mine' : '') + (e.local === 'death' ? ' kf-died' : '') + (e.local === 'assist' ? ' kf-assist' : '');
    let h = '';
    if (e.attacker && !e.suicide) {
      if (e.blind) h += `<span class="kf-ic kf-mod">${icon('blind')}</span>`;
      h += `<span class="kf-name t-${e.attacker.team}">${esc(e.attacker.name)}</span>`;
      if (e.assister) {
        h += `<span class="kf-plus">+</span>`;
        if (e.flashAssist) h += `<span class="kf-ic kf-mod">${icon('blind')}</span>`;
        h += `<span class="kf-name t-${e.assister.team}">${esc(e.assister.name)}</span>`;
      }
    }
    const wkey = keyOf(e.weapon) || 'world';
    h += `<span class="kf-ic kf-weapon">${icon(hasIcon(wkey) && wkey !== 'world' ? wkey : 'skull')}</span>`;
    if (e.noscope) h += `<span class="kf-ic kf-mod">${icon('noscope')}</span>`;
    if (e.smoke) h += `<span class="kf-ic kf-mod">${icon('smoke')}</span>`;
    if (e.wallbang) h += `<span class="kf-ic kf-mod">${icon('wallbang')}</span>`;
    if (e.headshot) h += `<span class="kf-ic kf-mod kf-hs">${icon('headshot')}</span>`;
    h += `<span class="kf-name t-${e.victim?.team}">${esc(e.victim?.name)}</span>`;
    row.innerHTML = h;
    this.el.appendChild(row);
    const life = e.local ? LIFE_LOCAL : LIFE;
    this.items.push({ row, die: now + life });
    while (this.items.length > MAX) this.items.shift().row.remove();
  }

  clear() { for (const it of this.items) it.row.remove(); this.items.length = 0; }

  update(now) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const left = it.die - now;
      if (left <= 0) { it.row.remove(); this.items.splice(i, 1); }
      else if (left < 0.4 && !it.fading) { it.fading = true; it.row.classList.add('kf-out'); }
    }
  }
}
