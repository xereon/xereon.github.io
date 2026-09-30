// CS2-style buy menu: five categories (Gear, Pistols, Mid-Tier [SMGs | Heavy], Rifles,
// Grenades) as a grid of cards with silhouettes, price and kill award. Number keys pick a
// category then an item; click buys. Unaffordable / restricted items grey out.
import { World } from '../core/world.js';
import { icon } from './icons.js';
import { BUY_LAYOUT, item, canBuy, grenadeCounts, keyOf, owns, effectivePrice } from './economy.js';

const REASON_TEXT = {
  money: 'Not enough money', owned: 'You already have this', team: 'Not available for your team',
  grenade_limit: 'You cannot carry any more grenades', type_limit: 'You cannot carry any more of these',
  zone: 'You are not in a buy zone', time: 'Buy time has expired', dead: 'You are dead', unknown: 'Unavailable',
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class BuyMenu {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'buymenu';
    parent.appendChild(this.el);
    this.open = false;
    this.team = null;
    this.cat = -1;          // selected category (keyboard)
    this.cards = new Map(); // key -> element
    this.sig = '';
    this.demo = null;       // harness: { ent, buyTime }
    this.msgT = 0;
    this._onKey = (e) => this._key(e);
    this.el.addEventListener('mousedown', (e) => {
      const card = e.target.closest?.('.bm-card');
      if (card) { e.preventDefault(); this.buy(card.dataset.key); return; }
      if (e.target.closest?.('.bm-close') || e.target === this.el) this.close(true);
    });
    this.el.addEventListener('mouseover', (e) => {
      const card = e.target.closest?.('.bm-card');
      if (card && card.dataset.key !== this.hover) { this.hover = card.dataset.key; this._detail(); }
    });
  }

  ent() { return this.demo?.ent || World.local; }

  build(team) {
    this.team = team;
    const cols = BUY_LAYOUT[team] || BUY_LAYOUT.T;
    // shared gradient for the silhouettes (defined once; the cards reference it by id)
    let html = `<svg class="bm-defs" width="0" height="0" aria-hidden="true"><defs>
      <linearGradient id="bm-metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e2e3e0"/><stop offset="1" stop-color="#a9adb1"/></linearGradient>
    </defs></svg><div class="bm-panel t-${team}">
      <div class="bm-top">
        <div class="bm-title">${icon('cart')}<span>Buy Menu</span></div>
        <div class="bm-money"><small>Money</small><b class="bm-m"></b></div>
        <div class="bm-time"><small>Buy time</small><b class="bm-t"></b></div>
        <div class="bm-close"><kbd>B</kbd><kbd>Esc</kbd><span>Close</span></div>
      </div>
      <div class="bm-grid">`;
    cols.forEach((c, ci) => {
      const card = (k, ii) => {
        const it = item(k);
        if (!it) return '';
        return `<div class="bm-card s-${it.slot}" data-key="${k}" data-cat="${ci}">
          <span class="bm-key">${(ii + 1) % 10}</span>
          <span class="bm-award">${it.killAward ? '+$' + it.killAward : ''}</span>
          <div class="bm-art">${icon(k)}</div>
          <div class="bm-meta"><span class="bm-name">${it.name}</span><span class="bm-price"></span></div>
          <span class="bm-owned"></span>
        </div>`;
      };
      if (c.split) {
        const a = c.items.slice(0, c.split), b = c.items.slice(c.split);
        html += `<div class="bm-col bm-wide" data-cat="${ci}">
          <div class="bm-head"><kbd>${ci + 1}</kbd><span>${c.label}</span><em>SMGs &nbsp;·&nbsp; Heavy</em></div>
          <div class="bm-sub">${a.map((k, i) => card(k, i)).join('')}</div>
          <div class="bm-sub">${b.map((k, i) => card(k, i + a.length)).join('')}</div>
        </div>`;
      } else {
        html += `<div class="bm-col" data-cat="${ci}">
          <div class="bm-head"><kbd>${ci + 1}</kbd><span>${c.label}</span></div>
          ${c.items.map((k, i) => card(k, i)).join('')}
        </div>`;
      }
    });
    html += `</div>
      <div class="bm-bottom">
        <div class="bm-loadout"></div>
        <div class="bm-detail"></div>
      </div>
      <div class="bm-msg"></div>
    </div>`;
    this.el.innerHTML = html;
    this.cards.clear();
    for (const c of this.el.querySelectorAll('.bm-card')) this.cards.set(c.dataset.key, c);
    this.$m = this.el.querySelector('.bm-m');
    this.$t = this.el.querySelector('.bm-t');
    this.$time = this.el.querySelector('.bm-time');
    this.$load = this.el.querySelector('.bm-loadout');
    this.$detail = this.el.querySelector('.bm-detail');
    this.$msg = this.el.querySelector('.bm-msg');
    this.sig = '';
    this._detail();
  }

  show(team) {
    if (team !== this.team) this.build(team);
    this.open = true;
    this.cat = -1;
    this.el.classList.add('on');
    this._markCat();
    addEventListener('keydown', this._onKey, true);
    this.sig = '';
    this.refresh(true);
  }

  close(relock = false) {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('on');
    removeEventListener('keydown', this._onKey, true);
    World.hud?._menuClosed?.(relock);
  }

  _key(e) {
    if (!this.open) return;
    const code = e.code;
    if (code === 'Escape' || code === 'KeyB') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (code === 'Escape' && this.cat >= 0) { this.cat = -1; this._markCat(); return; }
      this.close(true);
      return;
    }
    const m = /^(Digit|Numpad)(\d)$/.exec(code);
    if (m) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const n = +m[2];
      const cols = BUY_LAYOUT[this.team] || [];
      if (this.cat < 0) {
        if (n >= 1 && n <= cols.length) { this.cat = n - 1; this._markCat(); }
      } else {
        const list = cols[this.cat]?.items || [];
        const idx = n === 0 ? 9 : n - 1; // "0" is the tenth item
        if (idx < list.length) this.buy(list[idx]);
        this.cat = -1; this._markCat();
      }
      return;
    }
    // swallow gameplay keys while the menu is open (Tab is left alone for the scoreboard)
    if (code !== 'Tab' && code !== 'F1' && code !== 'Backquote') e.stopImmediatePropagation();
  }

  _markCat() {
    for (const col of this.el.querySelectorAll('.bm-col')) col.classList.toggle('sel', +col.dataset.cat === this.cat);
    this.el.querySelector('.bm-grid')?.classList.toggle('picking', this.cat >= 0);
  }

  _check(key) {
    const ent = this.ent();
    if (!ent) return { ok: false, reason: 'unknown', price: item(key)?.price || 0 };
    if (this.demo) return canBuy(ent, key);
    if (ent.alive === false) return { ok: false, reason: 'dead', price: effectivePrice(ent, key) };
    const M = World.match;
    const r = canBuy(ent, key);
    if (!r.ok) return r;
    if (M && !M.canBuyNow(ent)) {
      const timeUp = M.phase !== 'freeze' && M.phase !== 'warmup' && M.buyTimeLeft <= 0;
      return { ok: false, reason: timeUp ? 'time' : 'zone', price: r.price };
    }
    return r;
  }

  buy(key) {
    const ent = this.ent();
    const r = this._check(key);
    const card = this.cards.get(key);
    if (!r.ok) {
      this._flash(REASON_TEXT[r.reason] || 'Unavailable', true);
      card?.classList.remove('deny'); void card?.offsetWidth; card?.classList.add('deny');
      return false;
    }
    let ok = false;
    if (this.demo) { ent.money -= r.price; ok = true; }
    else ok = !!World.match?.buy?.(ent, key);
    if (ok) {
      card?.classList.remove('bought'); void card?.offsetWidth; card?.classList.add('bought');
      this._flash(`Purchased ${item(key)?.name}`, false);
      this.refresh(true);
    }
    return ok;
  }

  _flash(text, bad) {
    if (!this.$msg) return;
    this.$msg.textContent = text;
    this.$msg.className = 'bm-msg on' + (bad ? ' bad' : '');
    this.msgT = performance.now() + 1600;
  }

  _detail() {
    if (!this.$detail) return;
    const it = item(this.hover);
    if (!it) { this.$detail.innerHTML = '<span class="bm-hint">Press a category number, then an item number — or click a card.</span>'; return; }
    const stat = (label, v, max) => v == null ? '' :
      `<div class="bm-stat"><span>${label}</span><i><b style="width:${Math.min(100, (v / max) * 100).toFixed(0)}%"></b></i><em>${v}</em></div>`;
    this.$detail.innerHTML = `<div class="bm-dname">${it.name}</div>
      <div class="bm-dgrid">
        ${stat('Damage', it.dmg, 120)}${stat('Fire rate', it.rpm, 1000)}${stat('Armor pen.', it.pen, 100)}
        ${it.mag ? `<div class="bm-stat"><span>Magazine</span><em>${it.mag} / ${it.reserve ?? ''}</em></div>` : ''}
        <div class="bm-stat"><span>Kill award</span><em>$${it.killAward ?? 0}</em></div>
      </div>`;
  }

  /** Update affordability / owned states (cheap; only touches DOM when the signature changes). */
  refresh(force = false) {
    if (!this.open) return;
    const ent = this.ent();
    if (!ent) return;
    const M = World.match;
    const buyLeft = this.demo ? this.demo.buyTime : (M ? (M.phase === 'freeze' ? M.timer + M.buyTimeLeft : M.buyTimeLeft) : 0);
    this.$m.textContent = '$' + (ent.money | 0);
    const tl = Math.max(0, buyLeft);
    this.$t.textContent = fmtTime(tl);
    this.$time.classList.toggle('low', tl < 5);
    if (performance.now() > this.msgT && this.$msg.classList.contains('on')) this.$msg.classList.remove('on');
    const inv = ent.inventory || {};
    const g = grenadeCounts(ent);
    const sig = [ent.money | 0, ent.armor | 0, !!ent.helmet, !!ent.defuser, keyOf(inv.primary), keyOf(inv.secondary), keyOf(inv.taser), g.total, g.flashbang | 0, M?.phase, tl > 0, M?.inBuyZone?.(ent)].join('|');
    if (!force && sig === this.sig) return;
    this.sig = sig;
    for (const [key, el] of this.cards) {
      const r = this._check(key);
      const has = owns(ent, key);
      el.classList.toggle('cant', !r.ok && r.reason !== 'owned');
      el.classList.toggle('poor', r.reason === 'money');
      el.classList.toggle('owned', has);
      el.querySelector('.bm-price').textContent = '$' + r.price;
      const n = item(key)?.slot === 'grenade' ? (g[key] || 0) : 0;
      el.querySelector('.bm-owned').textContent = n > 1 ? `×${n}` : has ? 'Owned' : '';
    }
    // current loadout strip
    const slot = (k, cls = '') => k ? `<span class="bm-li ${cls}">${icon(k)}</span>` : '';
    let lo = slot(keyOf(inv.primary), 'wide') + slot(keyOf(inv.secondary)) + slot(keyOf(inv.taser));
    for (const gk of inv.grenades || []) lo += slot(keyOf(gk), 'nade');
    if ((ent.armor | 0) > 0) lo += `<span class="bm-li gear">${icon(ent.helmet ? 'armorhelmet' : 'armor')}<em>${ent.armor | 0}</em></span>`;
    if (ent.defuser) lo += slot('defusekit', 'nade');
    this.$load.innerHTML = `<small>Loadout</small>${lo || '<span class="bm-hint">Empty</span>'}`;
  }
}
