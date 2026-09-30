// Sound catalog: name -> how to synthesise it. Shared by the Worker (renders) and the main
// thread (knows names/tiers). Tiers: 0 = before anything else (IRs, footsteps, hits),
// 1 = common (default weapons, impacts), 2 = background, 3 = on demand only.
import { S, hashStr, normalize, trim } from './dsp.js';
import { gunshot, gunParams, GUN_DEFS, taserZap } from './guns.js';
import * as H from './handling.js';
import * as F from './foley.js';
import * as X from './explosives.js';
import * as M from './music.js';
import * as A from './ambience.js';

export const SR = 48000;
export const WEAPON_KEYS = ['knife', 'glock', 'usp', 'p250', 'deagle', 'tec9', 'fiveseven', 'dualberettas', 'cz75a', 'mp9', 'mac10', 'mp5sd',
  'mp7', 'ump45', 'p90', 'bizon', 'nova', 'xm1014', 'mag7', 'sawedoff', 'negev', 'm249', 'galil', 'famas', 'ak47', 'm4a4', 'm4a1s', 'ssg08',
  'aug', 'sg553', 'awp', 'g3sg1', 'scar20', 'taser'];
const COMMON_GUNS = new Set(['ak47', 'm4a4', 'm4a1s', 'awp', 'glock', 'usp', 'deagle']);
const EXTRA_GUNS = new Set(['cz75a', 'mp7', 'bizon', 'sawedoff']); // not in the contract list: render on demand only
export const PARTS = {
  pistol: ['magout', 'magin', 'slide'], smg: ['magout', 'magin', 'boltback', 'boltfwd'], rifle: ['magout', 'magin', 'boltback', 'boltfwd'],
  ak: ['magout', 'magin', 'boltback', 'boltfwd'], sniper: ['magout', 'magin', 'boltback', 'boltfwd'], shotgun: ['shell', 'pump'],
  lmg: ['coveropen', 'box', 'coverclose', 'boltback', 'boltfwd'],
};

const C = new Map();
/** gen(s, variantIndex) -> Float32Array[] */
function def(name, gen, { vars = 1, sr = SR, tier = 2, loop = false, norm = 0.89, raw = false } = {}) {
  C.set(name, { name, gen, vars, sr, tier, loop, norm, raw });
}

// --- IRs
def('ir_open', (s) => A.irOpen(s), { tier: 0, raw: true });
def('ir_room', (s) => A.irRoom(s), { tier: 0, raw: true });
def('ir_tunnel', (s) => A.irTunnel(s), { tier: 0, raw: true });

// --- guns
for (const k of Object.keys(GUN_DEFS)) {
  const P = gunParams(k);
  const common = COMMON_GUNS.has(k) && !k.endsWith('_unsil');
  const unsil = k.endsWith('_unsil') || EXTRA_GUNS.has(k);
  const base = k;
  def(`weapon_${base}_fire`, (s) => gunshot(s, P, 'close'), { vars: common ? 4 : 3, tier: unsil ? 3 : common ? 1 : 2 });
  def(`weapon_${base}_fire_far`, (s) => gunshot(s, P, 'far'), { vars: 2, sr: 24000, tier: unsil ? 3 : common ? 1 : 2 });
  def(`weapon_${base}_fire_2d`, (s) => gunshot(s, P, 'stereo'), { vars: 4, tier: 3 });
}
def('weapon_taser_fire', (s) => taserZap(s), { vars: 2, tier: 2 });
def('weapon_taser_fire_2d', (s) => taserZap(s), { vars: 1, tier: 3 });

// --- handling
for (const fam of ['pistol', 'smg', 'rifle', 'ak', 'sniper', 'shotgun', 'lmg', 'knife', 'grenade', 'c4']) {
  def(`deploy_${fam}`, (s) => H.deploy(s, fam), { vars: 2, tier: fam === 'knife' || fam === 'pistol' ? 1 : 2 });
}
for (const [fam, parts] of Object.entries(PARTS)) for (const p of parts) def(`wpn_${p}_${fam}`, (s) => H.part(s, fam, p), { vars: 2, tier: 2 });
def('wpn_dryfire', (s) => H.dryfire(s), { vars: 2, tier: 1 });
def('wpn_zoom', (s) => H.zoom(s), { vars: 2, tier: 1 });
def('wpn_silencer_on', (s) => H.silencer(s, true), { tier: 2 });
def('wpn_silencer_off', (s) => H.silencer(s, false), { tier: 2 });
def('weapon_land', (s) => H.weaponLand(s, true), { vars: 3, tier: 2 });
def('item_pickup', (s) => H.itemPickup(s), { vars: 2, tier: 2 });
def('knife_slash', (s) => H.knifeSlash(s, false), { vars: 3, tier: 1 });
def('knife_stab', (s) => H.knifeSlash(s, true), { vars: 2, tier: 1 });
def('knife_hit_wall', (s) => H.knifeHitWall(s), { vars: 3, tier: 1 });
def('knife_hit_flesh', (s) => H.knifeHitFlesh(s, false), { vars: 2, tier: 1 });
def('knife_stab_flesh', (s) => H.knifeHitFlesh(s, true), { vars: 2, tier: 1 });
for (const kind of ['rifle', 'pistol', 'sniper', 'shotgun']) for (const cls of ['hard', 'metal', 'wood', 'soft']) {
  def(`shell_${kind}_${cls}`, (s) => H.shell(s, kind, cls), { vars: 3, tier: 2 });
}

// --- grenades
def('nade_pin', (s) => H.pinPull(s), { vars: 2, tier: 2 });
def('nade_throw', (s) => H.throwWhoosh(s), { vars: 2, tier: 2 });
for (const cls of ['hard', 'metal', 'wood', 'soft']) def(`nade_bounce_${cls}`, (s) => X.nadeBounce(s, cls), { vars: 3, tier: 2 });
def('he_explode', (s) => X.explosion(s, 1, false), { vars: 3, tier: 2 });
def('he_explode_far', (s) => X.explosion(s, 1, true), { vars: 2, sr: 24000, tier: 2 });
def('flash_pop', (s) => X.flashPop(s, false), { vars: 2, tier: 2 });
def('flash_pop_far', (s) => X.flashPop(s, true), { vars: 2, sr: 24000, tier: 2 });
def('tinnitus', (s) => X.tinnitus(s), { tier: 2 });
def('smoke_pop', (s) => X.smokePop(s), { tier: 2 });
def('smoke_loop', (s) => X.smokeLoop(s), { tier: 2, loop: true, sr: 32000 });
def('molotov_break', (s) => X.molotovBreak(s), { vars: 2, tier: 2 });
def('fire_loop', (s) => X.fireLoop(s), { tier: 2, loop: true, sr: 32000 });
def('fire_out', (s) => X.fireOut(s), { tier: 2 });
def('decoy_pop', (s) => X.decoyPop(s), { tier: 2 });

// --- foley
for (const surf of F.FOOT_SURFACES) def(`footstep_${surf}`, (s) => F.footstep(s, surf), { vars: 6, tier: 0 });
def('jump', (s) => F.jump(s), { vars: 3, tier: 1 });
def('land', (s) => F.land(s), { vars: 3, tier: 1 });
def('crouch', (s) => F.crouch(s), { vars: 2, tier: 2 });
def('fall_damage', (s) => F.fallDamage(s), { vars: 2, tier: 2 });
def('death_fall', (s) => F.deathFall(s), { vars: 3, tier: 2 });
for (const surf of F.IMPACT_SURFACES) def(`impact_${surf}`, (s, v) => F.impact(s, surf, v), { vars: 4, tier: 1 });
def('hit_head_helmet', (s) => F.hitHelmet(s), { vars: 3, tier: 0 });
def('hit_head', (s) => F.hitHead(s), { vars: 3, tier: 0 });
def('hit_body', (s) => F.hitBody(s), { vars: 3, tier: 0 });
def('hit_kevlar', (s) => F.hitKevlar(s), { vars: 3, tier: 0 });

// --- bomb
def('bomb_key', (s, v) => X.bombKey(s, v), { vars: 7, tier: 2 });
def('bomb_plant', (s) => X.bombPlant(s), { vars: 2, tier: 2 });
def('bomb_arm', (s) => X.bombArm(s), { tier: 2 });
def('bomb_beep', (s) => X.bombBeep(s), { tier: 2 });
def('bomb_final', (s) => X.bombFinal(s), { tier: 2 });
def('bomb_defusing', (s) => X.bombDefusing(s), { vars: 2, tier: 2 });
def('bomb_defused', (s) => X.bombDefused(s), { tier: 2 });
def('bomb_explode', (s) => X.explosion(s, 1.7, false), { vars: 2, tier: 2 });
def('bomb_explode_far', (s) => X.explosion(s, 1.7, true), { sr: 24000, tier: 2 });

// --- UI / music
def('ui_click', (s) => M.uiClick(s, false), { vars: 2, tier: 1 });
def('ui_hover', (s) => M.uiClick(s, true), { vars: 2, tier: 1 });
def('ui_buy', (s) => M.uiBuy(s), { vars: 2, tier: 1 });
def('ui_deny', (s) => M.uiDeny(s), { tier: 1 });
def('radio_go', (s) => M.radioGo(s), { vars: 2, tier: 1 });
def('radio_chirp', (s) => M.radioChirp(s), { vars: 3, tier: 2 });
def('stinger_ct_win', (s) => M.stingerCT(s), { tier: 2 });
def('stinger_t_win', (s) => M.stingerT(s), { tier: 2 });
def('stinger_mvp', (s) => M.stingerMVP(s), { tier: 2 });
def('stinger_bomb10', (s) => M.stingerBomb10(s), { tier: 2 });

// --- ambience
def('amb_wind', (s) => A.windBed(s), { tier: 1, loop: true, sr: 32000, norm: 0.89 });
def('amb_bird', (s) => A.bird(s), { vars: 5, tier: 2, sr: 32000 });
def('amb_rattle', (s) => A.farRattle(s), { vars: 4, tier: 2, sr: 32000 });
def('amb_powerbox', (s) => A.powerHum(s), { tier: 2, loop: true, sr: 24000 });
def('amb_tarp', (s) => A.tarpFlap(s), { tier: 2, loop: true, sr: 32000 });

export const catalog = C;
export const soundNames = () => [...C.keys()];
export const soundDef = (name) => C.get(name);

/** Render every variation of `name`. Returns { name, sr, loop, vars: Float32Array[][], ms }. */
export function renderSound(name, srOverride = 0) {
  const d = C.get(name);
  if (!d) return null;
  const sr = srOverride && !d.sr ? srOverride : d.sr;
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const vars = [];
  for (let v = 0; v < d.vars; v++) {
    const s = new S(sr, hashStr(name) + v * 7919);
    let chs = d.gen(s, v);
    if (!d.raw) {
      if (!d.loop) chs = trim(chs, sr, -72);
      normalize(chs, d.norm);
    }
    vars.push(chs);
  }
  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  return { name, sr, loop: d.loop, vars, ms };
}
