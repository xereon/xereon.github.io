// CS2 competitive economy + item catalog. Pure module (no World access) so it can be
// unit-tested in node: `node --import ./tools/three-resolve.mjs tools/game_economy_test.mjs`.
//
// Prices / kill awards come from src/weapons/registry.js when it is loaded (see setRegistry);
// the table below is the CS2 fallback so the buy menu works against a stub WeaponSystem.

export const ECON = {
  START: 800,
  MAX: 16000,
  OT_START: 10000,          // overtime starting money (task spec; CS2 ships 12500)
  WIN_ELIM: 3250,           // either side, all enemies dead
  WIN_TIME: 3250,           // CT: round time expired, bomb not planted
  WIN_BOMB: 3500,           // T: bomb detonated
  WIN_DEFUSE: 3500,         // CT: bomb defused
  LOSS_BASE: 1400,          // first loss
  LOSS_STEP: 500,           // + per consecutive loss level
  LOSS_MAX_LEVEL: 4,        // 1400 .. 3400
  LOSS_HALF_START_LEVEL: 1, // pistol-round loser gets 1900 (CS behaviour)
  PLANT_TEAM: 800,          // every T when the bomb was planted but the round was lost
  PLANT_PLAYER: 300,        // planter
  DEFUSE_PLAYER: 300,       // defuser
  TEAMKILL: -300,
};

// ---- catalog ------------------------------------------------------------------------------
// cat: gear | pistol | smg | heavy | rifle | grenade ; slot mirrors Player.inventory
const I = (name, price, killAward, team, slot, cat, extra = {}) => ({ name, price, killAward, team, slot, cat, ...extra });

export const FALLBACK_ITEMS = {
  knife:        I('Knife', 0, 1500, null, 'knife', 'melee'),
  c4:           I('C4 Explosive', 0, 300, 'T', 'c4', 'bomb'),
  glock:        I('Glock-18', 200, 300, 'T', 'secondary', 'pistol', { mag: 20, reserve: 120, dmg: 30, rpm: 400, pen: 47 }),
  usp:          I('USP-S', 200, 300, 'CT', 'secondary', 'pistol', { mag: 12, reserve: 24, dmg: 35, rpm: 352, pen: 50.5 }),
  dualberettas: I('Dual Berettas', 300, 300, null, 'secondary', 'pistol', { mag: 30, reserve: 120, dmg: 38, rpm: 500, pen: 57.5 }),
  p250:         I('P250', 300, 300, null, 'secondary', 'pistol', { mag: 13, reserve: 26, dmg: 38, rpm: 400, pen: 64 }),
  tec9:         I('Tec-9', 500, 300, 'T', 'secondary', 'pistol', { mag: 18, reserve: 90, dmg: 33, rpm: 500, pen: 90.6 }),
  fiveseven:    I('Five-SeveN', 500, 300, 'CT', 'secondary', 'pistol', { mag: 20, reserve: 100, dmg: 32, rpm: 400, pen: 91.2 }),
  deagle:       I('Desert Eagle', 700, 300, null, 'secondary', 'pistol', { mag: 7, reserve: 35, dmg: 53, rpm: 267, pen: 93.2 }),
  mac10:        I('MAC-10', 1050, 600, 'T', 'primary', 'smg', { mag: 30, reserve: 100, dmg: 29, rpm: 800, pen: 57.5 }),
  mp9:          I('MP9', 1250, 600, 'CT', 'primary', 'smg', { mag: 30, reserve: 120, dmg: 26, rpm: 857, pen: 60 }),
  mp5sd:        I('MP5-SD', 1500, 600, null, 'primary', 'smg', { mag: 30, reserve: 120, dmg: 27, rpm: 750, pen: 62.5 }),
  ump45:        I('UMP-45', 1200, 600, null, 'primary', 'smg', { mag: 25, reserve: 100, dmg: 35, rpm: 666, pen: 65 }),
  p90:          I('P90', 2350, 300, null, 'primary', 'smg', { mag: 50, reserve: 100, dmg: 26, rpm: 857, pen: 69 }),
  nova:         I('Nova', 1050, 900, null, 'primary', 'heavy', { mag: 8, reserve: 32, dmg: 26, rpm: 68, pen: 50 }),
  xm1014:       I('XM1014', 2000, 600, null, 'primary', 'heavy', { mag: 7, reserve: 32, dmg: 20, rpm: 171, pen: 80 }),
  mag7:         I('MAG-7', 1300, 900, 'CT', 'primary', 'heavy', { mag: 5, reserve: 32, dmg: 30, rpm: 71, pen: 75 }),
  negev:        I('Negev', 1700, 300, null, 'primary', 'heavy', { mag: 150, reserve: 300, dmg: 35, rpm: 800, pen: 71 }),
  m249:         I('M249', 5200, 300, null, 'primary', 'heavy', { mag: 100, reserve: 200, dmg: 32, rpm: 750, pen: 80 }),
  galil:        I('Galil AR', 1800, 300, 'T', 'primary', 'rifle', { mag: 35, reserve: 90, dmg: 30, rpm: 666, pen: 77.5 }),
  famas:        I('FAMAS', 2050, 300, 'CT', 'primary', 'rifle', { mag: 25, reserve: 90, dmg: 30, rpm: 666, pen: 70 }),
  ak47:         I('AK-47', 2700, 300, 'T', 'primary', 'rifle', { mag: 30, reserve: 90, dmg: 36, rpm: 600, pen: 77.5 }),
  m4a4:         I('M4A4', 2900, 300, 'CT', 'primary', 'rifle', { mag: 30, reserve: 90, dmg: 33, rpm: 666, pen: 70 }),
  m4a1s:        I('M4A1-S', 2900, 300, 'CT', 'primary', 'rifle', { mag: 20, reserve: 80, dmg: 38, rpm: 600, pen: 70 }),
  ssg08:        I('SSG 08', 1700, 300, null, 'primary', 'rifle', { mag: 10, reserve: 90, dmg: 88, rpm: 48, pen: 85, zoom: true }),
  sg553:        I('SG 553', 3000, 300, 'T', 'primary', 'rifle', { mag: 30, reserve: 90, dmg: 30, rpm: 545, pen: 100, zoom: true }),
  aug:          I('AUG', 3300, 300, 'CT', 'primary', 'rifle', { mag: 30, reserve: 90, dmg: 28, rpm: 600, pen: 90, zoom: true }),
  awp:          I('AWP', 4750, 100, null, 'primary', 'rifle', { mag: 5, reserve: 30, dmg: 115, rpm: 41, pen: 97.5, zoom: true }),
  g3sg1:        I('G3SG1', 5000, 300, 'T', 'primary', 'rifle', { mag: 20, reserve: 90, dmg: 80, rpm: 240, pen: 82.5, zoom: true }),
  scar20:       I('SCAR-20', 5000, 300, 'CT', 'primary', 'rifle', { mag: 20, reserve: 90, dmg: 80, rpm: 240, pen: 82.5, zoom: true }),
  taser:        I('Zeus x27', 200, 0, null, 'taser', 'gear'),
  kevlar:       I('Kevlar Vest', 650, 0, null, 'gear', 'gear'),
  kevlarhelmet: I('Kevlar + Helmet', 1000, 0, null, 'gear', 'gear'),
  defusekit:    I('Defuse Kit', 400, 0, 'CT', 'gear', 'gear'),
  flashbang:    I('Flashbang', 200, 300, null, 'grenade', 'grenade', { max: 2 }),
  smokegrenade: I('Smoke Grenade', 300, 300, null, 'grenade', 'grenade', { max: 1 }),
  hegrenade:    I('HE Grenade', 300, 300, null, 'grenade', 'grenade', { max: 1 }),
  molotov:      I('Molotov', 400, 300, 'T', 'grenade', 'grenade', { max: 1 }),
  incgrenade:   I('Incendiary Grenade', 500, 300, 'CT', 'grenade', 'grenade', { max: 1 }),
  decoy:        I('Decoy Grenade', 50, 0, null, 'grenade', 'grenade', { max: 1 }),
};
FALLBACK_ITEMS.zeus = FALLBACK_ITEMS.taser;
FALLBACK_ITEMS.hkp2000 = I('P2000', 200, 300, 'CT', 'secondary', 'pistol');
FALLBACK_ITEMS.world = I('World', 0, 0, null, null, 'world');

export const MAX_GRENADES = 4;

// Buy menu layout. Five CS2 categories; Mid-tier renders as two sub-columns (SMGs / Heavy).
export const BUY_LAYOUT = {
  T: [
    { id: 'gear', label: 'Gear', items: ['kevlar', 'kevlarhelmet', 'taser'] },
    { id: 'pistols', label: 'Pistols', items: ['glock', 'dualberettas', 'p250', 'tec9', 'deagle'] },
    { id: 'mid', label: 'Mid-Tier', items: ['mac10', 'mp5sd', 'ump45', 'p90', 'nova', 'xm1014', 'negev', 'm249'], split: 4 },
    { id: 'rifles', label: 'Rifles', items: ['galil', 'ak47', 'ssg08', 'sg553', 'awp', 'g3sg1'] },
    { id: 'grenades', label: 'Grenades', items: ['flashbang', 'smokegrenade', 'hegrenade', 'molotov', 'decoy'] },
  ],
  CT: [
    { id: 'gear', label: 'Gear', items: ['kevlar', 'kevlarhelmet', 'taser', 'defusekit'] },
    { id: 'pistols', label: 'Pistols', items: ['usp', 'dualberettas', 'p250', 'fiveseven', 'deagle'] },
    { id: 'mid', label: 'Mid-Tier', items: ['mp9', 'mp5sd', 'ump45', 'p90', 'nova', 'xm1014', 'mag7', 'negev', 'm249'], split: 4 },
    { id: 'rifles', label: 'Rifles', items: ['famas', 'm4a4', 'm4a1s', 'ssg08', 'aug', 'awp', 'scar20'] },
    { id: 'grenades', label: 'Grenades', items: ['flashbang', 'smokegrenade', 'hegrenade', 'incgrenade', 'decoy'] },
  ],
};

export const DEFAULT_PISTOL = { T: 'glock', CT: 'usp' };

let REG = null;
/** Merge the WEAPONS registry (src/weapons/registry.js) over the fallback table. */
export function setRegistry(weapons) { REG = weapons && typeof weapons === 'object' ? weapons : null; }
export const hasRegistry = () => !!REG;
export const registryHas = (key) => !!(REG && REG[key]);

const merged = new Map();
export function item(key) {
  if (!key) return null;
  let m = merged.get(key);
  if (m && m._reg === REG) return m;
  const fb = FALLBACK_ITEMS[key];
  const r = REG?.[key];
  if (!fb && !r) return null;
  m = { key, ...(fb || {}), _reg: REG };
  if (r) {
    for (const f of ['name', 'price', 'killAward', 'team', 'slot', 'mag', 'reserve', 'zoom']) {
      if (r[f] !== undefined && r[f] !== null) m[f] = r[f];
    }
    if (r.damage !== undefined) m.dmg = r.damage;
    if (r.cycleTime) m.rpm = Math.round(60 / r.cycleTime);
    if (r.armorPen !== undefined) m.pen = Math.round((r.armorPen <= 1 ? r.armorPen * 100 : r.armorPen) * 10) / 10;
  }
  if (!m.name) m.name = key;
  merged.set(key, m);
  return m;
}
export const priceOf = (key) => item(key)?.price ?? 0;
export const killAwardOf = (key) => item(key)?.killAward ?? 300;
export const nameOf = (key) => item(key)?.name ?? (key ? String(key) : '');
export const teamCanBuy = (key, team) => { const it = item(key); return !!it && (!it.team || it.team === team); };

// ---- inventory helpers (tolerant of keys or weapon-instance objects) -----------------------
export const keyOf = (v) => (v == null ? null : typeof v === 'string' ? v : (v.key ?? v.id ?? v.type ?? v.name ?? null));

export function grenadeCounts(ent) {
  const out = { total: 0 };
  const list = ent?.inventory?.grenades;
  if (Array.isArray(list)) {
    for (const g of list) {
      const k = keyOf(g); if (!k) continue;
      const n = typeof g === 'object' && g && Number.isFinite(g.count) ? g.count : 1;
      out[k] = (out[k] || 0) + n; out.total += n;
    }
  }
  return out;
}

export function owns(ent, key) {
  const inv = ent?.inventory; if (!inv) return false;
  const it = item(key); if (!it) return false;
  switch (key) {
    case 'kevlar': return (ent.armor ?? 0) >= 100;
    case 'kevlarhelmet': return (ent.armor ?? 0) >= 100 && !!ent.helmet;
    case 'defusekit': return !!ent.defuser;
    case 'taser': case 'zeus': return !!inv.taser;
  }
  if (it.slot === 'primary') return keyOf(inv.primary) === key;
  if (it.slot === 'secondary') return keyOf(inv.secondary) === key;
  if (it.slot === 'grenade') return (grenadeCounts(ent)[key] || 0) >= (it.max || 1);
  return false;
}

/** Effective price for this player (Kevlar+Helmet becomes 350 when you already have a full vest). */
export function effectivePrice(ent, key) {
  const p = priceOf(key);
  if (key === 'kevlarhelmet') {
    const armor = ent?.armor ?? 0, helmet = !!ent?.helmet;
    if (armor >= 100 && !helmet) return p - priceOf('kevlar');
    if (helmet && armor < 100) return priceOf('kevlar');
  }
  return p;
}

/**
 * Loadout / money / team validation. Returns { ok, reason, price }.
 * reason: 'team' | 'money' | 'owned' | 'grenade_limit' | 'type_limit' | 'unknown'
 */
export function canBuy(ent, key) {
  const it = item(key);
  if (!it) return { ok: false, reason: 'unknown', price: 0 };
  const team = ent?.team;
  const price = effectivePrice(ent, key);
  if (it.team && team && it.team !== team) return { ok: false, reason: 'team', price };
  if (key === 'defusekit' && team !== 'CT') return { ok: false, reason: 'team', price };
  if (owns(ent, key)) return { ok: false, reason: 'owned', price };
  if (it.slot === 'grenade') {
    const c = grenadeCounts(ent);
    if ((c[key] || 0) >= (it.max || 1)) return { ok: false, reason: 'type_limit', price };
    if (c.total >= MAX_GRENADES) return { ok: false, reason: 'grenade_limit', price };
  }
  if ((ent?.money ?? 0) < price) return { ok: false, reason: 'money', price };
  return { ok: true, reason: null, price };
}

export const clampMoney = (m) => Math.max(0, Math.min(ECON.MAX, Math.round(m)));

// ---- round economy ------------------------------------------------------------------------
export class Economy {
  constructor() { this.lossLevel = { T: ECON.LOSS_HALF_START_LEVEL, CT: ECON.LOSS_HALF_START_LEVEL }; }

  resetHalf() { this.lossLevel.T = this.lossLevel.CT = ECON.LOSS_HALF_START_LEVEL; }

  /** Swap loss levels when teams change sides (levels follow the players, not the side). */
  swapSides() { const t = this.lossLevel.T; this.lossLevel.T = this.lossLevel.CT; this.lossLevel.CT = t; }

  lossBonus(team) { return ECON.LOSS_BASE + ECON.LOSS_STEP * this.lossLevel[team]; }

  static winAward(reason) {
    if (reason === 'bomb_exploded') return ECON.WIN_BOMB;
    if (reason === 'bomb_defused') return ECON.WIN_DEFUSE;
    if (reason === 'time') return ECON.WIN_TIME;
    return ECON.WIN_ELIM;
  }

  /**
   * Settle a round. Returns { award: {T, CT}, lossBonus, plantBonus, noMoneyForLiveTs }
   * and advances loss levels using CS2 rules: a loss pays the current level then steps it
   * up (max 4); a win steps the winner's level DOWN by one instead of resetting it.
   */
  settleRound(winner, reason, planted) {
    const loser = winner === 'T' ? 'CT' : 'T';
    const award = { T: 0, CT: 0 };
    award[winner] = Economy.winAward(reason);
    const lossBonus = this.lossBonus(loser);
    let plantBonus = 0;
    award[loser] = lossBonus;
    if (loser === 'T' && planted) { plantBonus = ECON.PLANT_TEAM; award.T += plantBonus; }
    this.lossLevel[loser] = Math.min(ECON.LOSS_MAX_LEVEL, this.lossLevel[loser] + 1);
    this.lossLevel[winner] = Math.max(0, this.lossLevel[winner] - 1);
    // Ts alive when the clock runs out (no plant) earn nothing.
    const noMoneyForLiveTs = loser === 'T' && reason === 'time' && !planted;
    return { award, lossBonus, plantBonus, noMoneyForLiveTs };
  }

  /** Money to give one player at round end. */
  static playerRoundMoney(settle, ent) {
    if (!ent) return 0;
    if (settle.noMoneyForLiveTs && ent.team === 'T' && ent.alive) return 0;
    return settle.award[ent.team] || 0;
  }

  static killReward(attacker, victim, weaponKey) {
    if (!attacker || !victim || attacker === victim) return 0;
    if (attacker.team === victim.team) return ECON.TEAMKILL;
    return killAwardOf(weaponKey);
  }
}

// ---- match format -------------------------------------------------------------------------
export const FORMAT = {
  HALF: 12,           // MR12: swap after 12
  WIN: 13,            // first to 13
  OT_HALF: 3,         // MR3 overtime halves
  FREEZE: 15, ROUND: 115, BOMB: 40, ROUND_END: 7, BUY: 20, HALFTIME: 10, WARMUP: 0,
  PLANT: 3.2, DEFUSE: 10, DEFUSE_KIT: 5,
};

/** Given a completed-round count and scores, decide what happens next. Pure. */
export function formatAfterRound(roundsPlayed, score) {
  const { HALF, WIN, OT_HALF } = FORMAT;
  const regulation = HALF * 2;
  if (roundsPlayed <= regulation) {
    if (score.T >= WIN || score.CT >= WIN) return { end: true, winner: score.T > score.CT ? 'T' : 'CT' };
    if (roundsPlayed === HALF) return { swap: true, halftime: true };
    if (roundsPlayed === regulation) return { overtime: true, otMoney: true }; // 12-12: sides stay, money resets
    return {};
  }
  // Overtime: blocks of 6 rounds, first to 4 within the block.
  const ot = roundsPlayed - regulation;
  const block = Math.floor((ot - 1) / (OT_HALF * 2));
  const inBlock = ot - block * OT_HALF * 2;
  const base = HALF + block * OT_HALF;         // each side's score at block start
  const need = base + OT_HALF + 1;
  if (score.T >= need || score.CT >= need) return { end: true, winner: score.T > score.CT ? 'T' : 'CT' };
  if (inBlock === OT_HALF) return { swap: true, halftime: true, otMoney: true };
  if (inBlock === OT_HALF * 2) return { swap: false, otMoney: true, newOvertime: true }; // tied again
  return {};
}
