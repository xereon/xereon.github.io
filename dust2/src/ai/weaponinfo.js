// What a bot needs to know about guns: how to use them, what they cost, how much ammo is left.
// Tolerant of the WeaponSystem storing inventory as keys or as weapon-instance objects.
import { World } from '../core/world.js';

// usage class -> fight style
const CLASS = {
  knife: 'knife', taser: 'taser', zeus: 'taser', c4: 'c4',
  glock: 'pistol', usp: 'pistol', hkp2000: 'pistol', p250: 'pistol', tec9: 'pistol', fiveseven: 'pistol',
  dualberettas: 'pistol', cz75: 'pistol', deagle: 'deagle', revolver: 'deagle',
  mp9: 'smg', mac10: 'smg', mp5sd: 'smg', mp7: 'smg', ump45: 'smg', p90: 'smg', bizon: 'smg',
  nova: 'shotgun', xm1014: 'shotgun', mag7: 'shotgun', sawedoff: 'shotgun',
  negev: 'mg', m249: 'mg',
  galil: 'rifle', famas: 'rifle', ak47: 'rifle', m4a4: 'rifle', m4a1s: 'rifle', aug: 'rifle', sg553: 'rifle',
  ssg08: 'sniper', awp: 'sniper', g3sg1: 'autosniper', scar20: 'autosniper',
  hegrenade: 'grenade', flashbang: 'grenade', smokegrenade: 'grenade', molotov: 'grenade', incgrenade: 'grenade', decoy: 'grenade',
};
const SEMI = new Set(['glock', 'usp', 'hkp2000', 'p250', 'tec9', 'fiveseven', 'dualberettas', 'deagle', 'revolver',
  'nova', 'mag7', 'sawedoff', 'ssg08', 'awp', 'taser', 'zeus']);

// CS2 prices, used only if neither the weapons registry nor the economy module is loaded
const PRICE = {
  glock: 200, usp: 200, hkp2000: 200, p250: 300, tec9: 500, fiveseven: 500, dualberettas: 300, deagle: 700,
  mp9: 1250, mac10: 1050, mp5sd: 1500, ump45: 1200, p90: 2350, nova: 1050, xm1014: 2000, mag7: 1300,
  negev: 1700, m249: 5200, galil: 1800, famas: 2050, ak47: 2700, m4a4: 2900, m4a1s: 2900, ssg08: 1700,
  aug: 3300, sg553: 3000, awp: 4750, g3sg1: 5000, scar20: 5000, taser: 200,
  hegrenade: 300, flashbang: 200, smokegrenade: 300, molotov: 400, incgrenade: 500, decoy: 50,
  kevlar: 650, kevlarhelmet: 1000, defusekit: 400,
};

// Optional modules written in parallel: never hard-imported. The weapons registry is taken
// from the live WeaponSystem (importing a missing file would 404 and fail the harness).
const mods = { registry: null, econ: null };
let loading = null;
export function loadWeaponModules() {
  if (loading) return loading;
  loading = import('../game/economy.js').then((m) => { mods.econ = m; }).catch(() => {});
  return loading;
}
function reg() {
  if (!mods.registry) mods.registry = World.weapons?.WEAPONS || World.weapons?.registry || World.WEAPONS || null;
  return mods.registry;
}

export const keyOf = (v) => (v == null ? null : typeof v === 'string' ? v : (v.key ?? v.id ?? v.type ?? v.name ?? null));
export const weaponClass = (key) => CLASS[key] || (key ? 'rifle' : 'none');
export const isSemi = (key) => {
  const w = reg()?.[key];
  if (w?.fireMode) return w.fireMode === 'semi';
  return SEMI.has(key);
};
export const weaponDef = (key) => reg()?.[key] || null;

export function priceOf(key) {
  const r = reg()?.[key]?.price;
  if (typeof r === 'number') return r;
  const e = mods.econ?.priceOf?.(key);
  if (typeof e === 'number' && e > 0) return e;
  return PRICE[key] ?? 99999;
}

export function teamAllows(key, team) {
  const t = reg()?.[key]?.team ?? mods.econ?.item?.(key)?.team;
  if (t !== undefined) return !t || t === team;
  if (['glock', 'tec9', 'mac10', 'galil', 'ak47', 'sg553', 'g3sg1', 'molotov'].includes(key)) return team === 'T';
  if (['usp', 'hkp2000', 'fiveseven', 'mp9', 'mag7', 'famas', 'm4a4', 'm4a1s', 'aug', 'scar20', 'incgrenade', 'defusekit'].includes(key)) return team === 'CT';
  return true;
}

/** Can `ent` buy `key` right now (money, team, ownership)? Uses the economy rules when present. */
export function canBuy(ent, key) {
  const c = mods.econ?.canBuy?.(ent, key);
  if (c) return c.ok;
  return teamAllows(key, ent.team) && (ent.money ?? 0) >= priceOf(key);
}

/** The weapon instance/key in a slot or active. */
export function slotItem(ent, slot) { return ent?.inventory?.[slot] ?? null; }

export function activeItem(ent) {
  const a = ent?.active;
  if (a == null) return null;
  if (typeof a === 'string') {
    const inv = ent.inventory;
    if (inv && Object.prototype.hasOwnProperty.call(inv, a) && inv[a] && a !== 'grenades') return inv[a];
    return a;
  }
  return a;
}

export function activeKey(ent) { return keyOf(activeItem(ent)); }

/** Rounds in the magazine, or null when unknown. */
export function clipOf(item) {
  if (!item || typeof item !== 'object') return null;
  for (const f of ['clip', 'ammo', 'inClip', 'mag', 'rounds']) if (typeof item[f] === 'number') return item[f];
  return null;
}
export function magSize(key, item) {
  if (item && typeof item === 'object') for (const f of ['magSize', 'maxClip', 'clipSize']) if (typeof item[f] === 'number') return item[f];
  return reg()?.[key]?.mag ?? mods.econ?.item?.(key)?.mag ?? 30;
}
export function reserveOf(item) {
  if (!item || typeof item !== 'object') return null;
  for (const f of ['reserve', 'ammoReserve', 'spare']) if (typeof item[f] === 'number') return item[f];
  return null;
}
export function isReloading(ent) {
  const it = activeItem(ent);
  return !!(ent?.reloading || (it && typeof it === 'object' && (it.reloading || it.state === 'reload')));
}

export function hasGrenade(ent, key) {
  const g = ent?.inventory?.grenades;
  if (!Array.isArray(g)) return false;
  return g.some((x) => keyOf(x) === key);
}

export function hasC4(ent) { return !!ent?.inventory?.c4 || activeKey(ent) === 'c4'; }

export function switchTo(ent, key) {
  if (!key || activeKey(ent) === key) return;
  World.weapons?.switchTo?.(ent, key);
}

/** Best gun the bot carries: primary, else secondary, else knife. */
export function bestGunKey(ent) {
  const p = keyOf(slotItem(ent, 'primary'));
  if (p) {
    const c = clipOf(slotItem(ent, 'primary')), r = reserveOf(slotItem(ent, 'primary'));
    if (c === null || c > 0 || (r ?? 1) > 0) return p;
  }
  const s = keyOf(slotItem(ent, 'secondary'));
  if (s) return s;
  return 'knife';
}
