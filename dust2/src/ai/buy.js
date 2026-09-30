// Bot purchases: team-coordinated eco / force / full buys like CS bots, by money.
import { World } from '../core/world.js';
import * as WI from './weaponinfo.js';

/**
 * Shopping list for one bot. `mode` is the team's decision ('pistol'|'eco'|'force'|'full')
 * so the team buys together; `awpTaken` makes sure only one bot per team picks the AWP.
 */
export function shoppingList(ent, profile, mode, rnd, ctx = {}) {
  const T = ent.team === 'T';
  const money = ent.money ?? 800;
  const list = [];
  let m = money;
  const want = (k) => { const p = WI.priceOf(k); if (p <= m && WI.teamAllows(k, ent.team)) { list.push(k); m -= p; return true; } return false; };
  const primary = WI.keyOf(WI.slotItem(ent, 'primary'));
  const hasArmor = (ent.armor ?? 0) >= 50;
  const nades = () => {
    const opts = T ? ['smokegrenade', 'flashbang', 'molotov', 'hegrenade', 'flashbang'] : ['smokegrenade', 'flashbang', 'incgrenade', 'hegrenade', 'flashbang'];
    for (const k of opts) if (m > 350 && rnd() < 0.7) want(k);
  };

  if (mode === 'pistol') {
    const r = rnd();
    if (r < 0.45) want('kevlar');
    else if (r < 0.7) { want('p250'); want('flashbang'); }
    else if (r < 0.85) { want(T ? 'tec9' : 'fiveseven'); want('flashbang'); }
    else { if (!T) want('defusekit'); want('smokegrenade'); want('flashbang'); }
    return list;
  }
  if (mode === 'eco') {
    // save, maybe a cheap pistol upgrade with spare cash
    if (money > 1900 && rnd() < 0.4) want(rnd() < 0.5 ? 'p250' : 'deagle');
    return list;
  }
  if (primary && (mode !== 'full' || primary === 'awp' || /ak47|m4a4|m4a1s|aug|sg553/.test(primary))) {
    // kept a gun from last round: top up utility and armor
    if (!hasArmor || !ent.helmet) want('kevlarhelmet') || want('kevlar');
    if (!T && !ent.defuser && rnd() < 0.6) want('defusekit');
    nades();
    return list;
  }
  if (mode === 'force') {
    const guns = T ? ['galil', 'mac10', 'ump45'] : ['famas', 'mp9', 'ump45'];
    for (const g of guns) if (m >= WI.priceOf(g) + 650 && want(g)) break;
    want('kevlar');
    if (m > 300) want('flashbang');
    return list;
  }
  // full buy
  const awp = !ctx.awpTaken && profile.awper && m >= 4750 + 1000 + 200;
  if (awp && want('awp')) ctx.awpTaken = true;
  else if (T) { want('ak47') || want('galil'); }
  else { (rnd() < 0.5 ? want('m4a4') || want('m4a1s') : want('m4a1s') || want('m4a4')) || want('famas'); }
  want('kevlarhelmet') || want('kevlar');
  if (!T && m >= 400 && rnd() < 0.7) want('defusekit');
  nades();
  return list;
}

/** Buy one item: prefer the rules module's buy (money, buy zone, HUD) else do it ourselves. */
export function buyItem(ent, key) {
  const match = World.match;
  if (match?.buy && match.started !== false) {
    try { const r = match.buy(ent, key, { ignoreZone: true }); return r !== false && r?.ok !== false; }
    catch { return false; }
  }
  if (!World.weapons?.give || !WI.canBuy(ent, key)) return false;
  ent.money = (ent.money ?? 0) - WI.priceOf(key);
  World.weapons.give(ent, key);
  World.emit('buy', { ent, item: key });
  return true;
}
