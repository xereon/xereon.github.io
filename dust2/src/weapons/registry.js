// Weapon + equipment definitions (CONTRACT §7). CS:GO / CS2 items_game.txt values, from memory.
//
// Units / conventions
//   damage        base damage per bullet (per pellet for shotguns)
//   armorPen      fraction of damage that goes through kevlar (= items_game "armor ratio" / 2)
//   rangeModifier falloff per 500u: dmg * rangeModifier^(dist/500)
//   cycleTime     seconds between shots (60 / RPM)
//   spread / inaccuracy*   items_game script units = milliradians (code multiplies by 0.001)
//   inaccuracyLand         script units * fall speed (u/s) -> mrad (CS:GO OnLand)
//   inaccuracyJump         constant air penalty (apex); inaccuracyJumpInitial scales with
//                          sqrt(vertical speed) like CS:GO GetInaccuracy
//   recoilMagnitude        CS:GO "recoil magnitude" (aim punch velocity, deg/s per shot)
//   maxSpeedAlt            speed while scoped (Player also reads maxSpeedZoom)
//   alt                    overrides while the weapon is in its secondary mode:
//                          scoped (AUG/SG/snipers), silencer OFF (M4A1-S/USP-S), burst (Glock/FAMAS)
//   zoom                   CS fov levels (horizontal @4:3), e.g. AWP [40, 10]

const deepFreezeless = (o) => o; // defs are plain mutable objects (tweakable from the console)

// Per-class defaults. Everything can be overridden per weapon.
const CLASS = {
  pistol: {
    slot: 'secondary', cat: 'pistol', killAward: 300, range: 4096, fireMode: 'semi', penetration: 1,
    maxSpeed: 240, deployTime: 1.0, headshotMul: 4, tracerFreq: 1, recoilAngleVariance: 20,
    inaccuracyJump: 30, inaccuracyJumpInitial: 70, inaccuracyLand: 0.12, inaccuracyLadder: 70,
    recoveryTransition: [0, 0], tagging: 0.5, taggingSmall: 0.65, shellEject: 'auto', family: 'pistol',
  },
  smg: {
    slot: 'primary', cat: 'smg', killAward: 600, range: 4096, fireMode: 'auto', penetration: 1,
    maxSpeed: 240, deployTime: 1.0, headshotMul: 4, tracerFreq: 3, recoilAngleVariance: 70,
    inaccuracyJump: 45, inaccuracyJumpInitial: 95, inaccuracyLand: 0.14, inaccuracyLadder: 90,
    recoveryTransition: [2, 5], tagging: 0.5, taggingSmall: 0.6, shellEject: 'auto', family: 'smg',
  },
  heavy: {
    slot: 'primary', cat: 'heavy', killAward: 900, range: 3000, fireMode: 'semi', penetration: 1,
    maxSpeed: 220, deployTime: 1.0, headshotMul: 4, tracerFreq: 1, recoilAngleVariance: 20,
    inaccuracyJump: 35, inaccuracyJumpInitial: 80, inaccuracyLand: 0.15, inaccuracyLadder: 80,
    recoveryTransition: [0, 0], tagging: 0.45, taggingSmall: 0.6, shellEject: 'pump', family: 'shotgun',
  },
  lmg: {
    slot: 'primary', cat: 'heavy', killAward: 300, range: 8192, fireMode: 'auto', penetration: 2,
    maxSpeed: 195, deployTime: 1.2, headshotMul: 4, tracerFreq: 1, recoilAngleVariance: 60,
    inaccuracyJump: 120, inaccuracyJumpInitial: 200, inaccuracyLand: 0.3, inaccuracyLadder: 150,
    recoveryTransition: [2, 12], tagging: 0.4, taggingSmall: 0.55, shellEject: 'auto', family: 'lmg',
  },
  rifle: {
    slot: 'primary', cat: 'rifle', killAward: 300, range: 8192, fireMode: 'auto', penetration: 2,
    maxSpeed: 215, deployTime: 1.0, headshotMul: 4, tracerFreq: 3, recoilAngleVariance: 70,
    inaccuracyJump: 75, inaccuracyJumpInitial: 140, inaccuracyLand: 0.24, inaccuracyLadder: 140,
    recoveryTransition: [2, 5], tagging: 0.4, taggingSmall: 0.55, shellEject: 'auto', family: 'rifle',
  },
  sniper: {
    slot: 'primary', cat: 'rifle', killAward: 300, range: 8192, fireMode: 'semi', penetration: 2.5,
    maxSpeed: 215, deployTime: 1.25, headshotMul: 4, tracerFreq: 1, recoilAngleVariance: 20,
    inaccuracyJump: 250, inaccuracyJumpInitial: 300, inaccuracyLand: 0.3, inaccuracyLadder: 250,
    recoveryTransition: [0, 0], tagging: 0.4, taggingSmall: 0.55, shellEject: 'auto', family: 'sniper',
    resumeZoom: false, zoomTime: 0.1,
  },
};

function W(cls, o) {
  const base = CLASS[cls];
  const d = { ...base, ...o };
  // CS:GO "final" recovery times are ~1.375x the initial ones for full-auto weapons
  d.recoveryTimeStandFinal ??= d.recoveryTimeStand * (d.fireMode === 'auto' ? 1.375 : 1);
  d.recoveryTimeCrouchFinal ??= d.recoveryTimeCrouch * (d.fireMode === 'auto' ? 1.375 : 1);
  d.bullets ??= 1;
  if (d.maxSpeedAlt != null) d.maxSpeedZoom = d.maxSpeedAlt; // Player.weaponMaxSpeed() reads this
  d.rpm = Math.round(60 / d.cycleTime);
  if (d.reloadType === 'shell') {
    // shell-by-shell: reloadTime is what a typical 4-shell reload takes (the viewmodel clip
    // length); reloadTimeFull is an empty tube.
    d.reloadTime = +(d.reloadStart + 4 * d.shellTime + d.reloadEnd).toFixed(3);
    d.reloadTimeFull = +(d.reloadStart + d.mag * d.shellTime + d.reloadEnd).toFixed(3);
  }
  if (d.alt) d.alt = { ...d.alt };
  return d;
}

export const WEAPONS = deepFreezeless({
  // ---------------------------------------------------------------- melee -----------------
  knife: {
    name: 'Knife', team: null, slot: 'knife', cat: 'melee', family: 'knife', price: 0, killAward: 1500,
    damage: 40, damageChained: 25, damageBackstab: 90,             // primary (slash)
    damageStab: 65, damageStabBackstab: 180,                          // secondary (stab)
    range: 48, rangeStab: 32, armorPen: 0.85, headshotMul: 1,
    cycleTime: 0.4, cycleTimeHit: 0.5, cycleTimeStab: 1.0, cycleTimeStabHit: 1.1,
    deployTime: 1.0, maxSpeed: 250, mag: 0, reserve: 0, fireMode: 'melee', tracerFreq: 0,
    spread: 0, inaccuracyStand: 0, inaccuracyCrouch: 0, inaccuracyMove: 0, inaccuracyFire: 0,
    recoilMagnitude: 0, tagging: 0.5, taggingSmall: 0.65, penetration: 0,
  },

  // ---------------------------------------------------------------- pistols ---------------
  glock: W('pistol', {
    name: 'Glock-18', team: 'T', price: 200, damage: 30, armorPen: 0.47, rangeModifier: 0.85,
    cycleTime: 0.15, mag: 20, reserve: 120, reloadTime: 2.27, deployTime: 1.0, maxSpeed: 240,
    spread: 2.0, inaccuracyStand: 5.6, inaccuracyCrouch: 4.2, inaccuracyMove: 13.4, inaccuracyFire: 56,
    recoveryTimeStand: 0.33, recoveryTimeCrouch: 0.28, recoilMagnitude: 18,
    burst: { count: 3, interval: 0.05, cycle: 0.5 },
    alt: { spread: 5.0, inaccuracyFire: 36, recoilMagnitude: 14 }, // burst mode
  }),
  usp: W('pistol', {
    name: 'USP-S', team: 'CT', price: 200, damage: 35, armorPen: 0.505, rangeModifier: 0.91,
    cycleTime: 0.17, mag: 12, reserve: 24, reloadTime: 2.17, deployTime: 1.0, maxSpeed: 240,
    spread: 1.5, inaccuracyStand: 3.4, inaccuracyCrouch: 2.6, inaccuracyMove: 12.6, inaccuracyFire: 52,
    recoveryTimeStand: 0.35, recoveryTimeCrouch: 0.29, recoilMagnitude: 23,
    silencer: true, silencerTime: 2.7, silencerOffTime: 2.2, tracerFreq: 0,
    alt: { spread: 2.0, inaccuracyStand: 5.3, inaccuracyCrouch: 4.0, inaccuracyFire: 71, recoilMagnitude: 29, tracerFreq: 1 }, // silencer off
  }),
  p250: W('pistol', {
    name: 'P250', team: null, price: 300, damage: 38, armorPen: 0.64, rangeModifier: 0.9,
    cycleTime: 0.15, mag: 13, reserve: 26, reloadTime: 2.2, maxSpeed: 240,
    spread: 2.0, inaccuracyStand: 6.1, inaccuracyCrouch: 4.6, inaccuracyMove: 13.4, inaccuracyFire: 52,
    recoveryTimeStand: 0.33, recoveryTimeCrouch: 0.28, recoilMagnitude: 26,
  }),
  deagle: W('pistol', {
    name: 'Desert Eagle', team: null, price: 700, damage: 53, armorPen: 0.932, rangeModifier: 0.81,
    cycleTime: 0.225, mag: 7, reserve: 35, reloadTime: 2.2, deployTime: 1.13, maxSpeed: 230, penetration: 2,
    spread: 2.0, inaccuracyStand: 5.9, inaccuracyCrouch: 4.4, inaccuracyMove: 58, inaccuracyFire: 107,
    inaccuracyJump: 60, inaccuracyJumpInitial: 140,
    recoveryTimeStand: 0.81, recoveryTimeCrouch: 0.68, recoilMagnitude: 39, tagging: 0.4, taggingSmall: 0.55,
  }),
  tec9: W('pistol', {
    name: 'Tec-9', team: 'T', price: 500, damage: 33, armorPen: 0.906, rangeModifier: 0.831,
    cycleTime: 0.12, mag: 18, reserve: 90, reloadTime: 2.5, maxSpeed: 240,
    spread: 2.0, inaccuracyStand: 8.9, inaccuracyCrouch: 7.0, inaccuracyMove: 11.8, inaccuracyFire: 49,
    recoveryTimeStand: 0.42, recoveryTimeCrouch: 0.35, recoilMagnitude: 29,
  }),
  fiveseven: W('pistol', {
    name: 'Five-SeveN', team: 'CT', price: 500, damage: 32, armorPen: 0.9115, rangeModifier: 0.81,
    cycleTime: 0.15, mag: 20, reserve: 100, reloadTime: 2.2, maxSpeed: 240,
    spread: 2.0, inaccuracyStand: 6.8, inaccuracyCrouch: 5.1, inaccuracyMove: 13.5, inaccuracyFire: 30,
    recoveryTimeStand: 0.33, recoveryTimeCrouch: 0.28, recoilMagnitude: 25,
  }),
  dualberettas: W('pistol', {
    name: 'Dual Berettas', team: null, price: 300, damage: 38, armorPen: 0.575, rangeModifier: 0.79,
    cycleTime: 0.12, mag: 30, reserve: 120, reloadTime: 3.8, maxSpeed: 240,
    spread: 2.0, inaccuracyStand: 10.5, inaccuracyCrouch: 8.0, inaccuracyMove: 16, inaccuracyFire: 30,
    recoveryTimeStand: 0.35, recoveryTimeCrouch: 0.3, recoilMagnitude: 18,
  }),
  cz75: W('pistol', {
    name: 'CZ75-Auto', team: null, price: 500, killAward: 100, damage: 31, armorPen: 0.7765, rangeModifier: 0.85,
    cycleTime: 0.1, fireMode: 'auto', mag: 12, reserve: 12, reloadTime: 2.7, deployTime: 1.8, maxSpeed: 240,
    spread: 2.0, inaccuracyStand: 8.0, inaccuracyCrouch: 6.0, inaccuracyMove: 14, inaccuracyFire: 17,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoilMagnitude: 20, recoilAngleVariance: 60, tracerFreq: 1,
  }),

  // ---------------------------------------------------------------- SMGs ------------------
  mp9: W('smg', {
    name: 'MP9', team: 'CT', price: 1250, damage: 26, armorPen: 0.6, rangeModifier: 0.87,
    cycleTime: 0.07, mag: 30, reserve: 120, reloadTime: 2.13, maxSpeed: 240,
    spread: 0.6, inaccuracyStand: 16.3, inaccuracyCrouch: 12.2, inaccuracyMove: 44, inaccuracyFire: 5.3,
    recoveryTimeStand: 0.33, recoveryTimeCrouch: 0.28, recoilMagnitude: 19,
  }),
  mac10: W('smg', {
    name: 'MAC-10', team: 'T', price: 1050, damage: 29, armorPen: 0.575, rangeModifier: 0.8,
    cycleTime: 0.075, mag: 30, reserve: 100, reloadTime: 2.6, maxSpeed: 240,
    spread: 0.6, inaccuracyStand: 15.0, inaccuracyCrouch: 11.3, inaccuracyMove: 41, inaccuracyFire: 5.9,
    recoveryTimeStand: 0.35, recoveryTimeCrouch: 0.29, recoilMagnitude: 18,
  }),
  mp5sd: W('smg', {
    name: 'MP5-SD', team: null, price: 1500, damage: 27, armorPen: 0.625, rangeModifier: 0.85,
    cycleTime: 0.08, mag: 30, reserve: 120, reloadTime: 2.63, maxSpeed: 235,
    spread: 0.6, inaccuracyStand: 10.0, inaccuracyCrouch: 7.5, inaccuracyMove: 37, inaccuracyFire: 5.0,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoilMagnitude: 17, tracerFreq: 0, suppressed: true,
  }),
  mp7: W('smg', {
    name: 'MP7', team: null, price: 1500, damage: 29, armorPen: 0.625, rangeModifier: 0.85,
    cycleTime: 0.08, mag: 30, reserve: 120, reloadTime: 3.13, maxSpeed: 220,
    spread: 0.6, inaccuracyStand: 11.0, inaccuracyCrouch: 8.2, inaccuracyMove: 38, inaccuracyFire: 5.3,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoilMagnitude: 20,
  }),
  ump45: W('smg', {
    name: 'UMP-45', team: null, price: 1200, damage: 35, armorPen: 0.65, rangeModifier: 0.75,
    cycleTime: 0.09, mag: 25, reserve: 100, reloadTime: 3.5, maxSpeed: 230,
    spread: 0.6, inaccuracyStand: 14.0, inaccuracyCrouch: 10.5, inaccuracyMove: 53, inaccuracyFire: 6.1,
    recoveryTimeStand: 0.33, recoveryTimeCrouch: 0.28, recoilMagnitude: 23,
  }),
  p90: W('smg', {
    name: 'P90', team: null, price: 2350, killAward: 300, damage: 26, armorPen: 0.69, rangeModifier: 0.86,
    cycleTime: 0.07, mag: 50, reserve: 100, reloadTime: 3.35, maxSpeed: 230,
    spread: 0.6, inaccuracyStand: 12.0, inaccuracyCrouch: 9.0, inaccuracyMove: 30, inaccuracyFire: 4.1,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoilMagnitude: 16,
  }),

  // ---------------------------------------------------------------- heavy -----------------
  nova: W('heavy', {
    name: 'Nova', team: null, price: 1050, damage: 26, bullets: 9, armorPen: 0.5, rangeModifier: 0.7,
    cycleTime: 0.88, mag: 8, reserve: 32, reloadType: 'shell', reloadStart: 0.5, shellTime: 0.5, reloadEnd: 0.35,
    deployTime: 1.0, maxSpeed: 220,
    spread: 40, inaccuracyStand: 6.0, inaccuracyCrouch: 4.5, inaccuracyMove: 60, inaccuracyFire: 50,
    recoveryTimeStand: 0.4, recoveryTimeCrouch: 0.35, recoilMagnitude: 143,
  }),
  xm1014: W('heavy', {
    name: 'XM1014', team: null, price: 2000, killAward: 600, damage: 20, bullets: 6, armorPen: 0.8, rangeModifier: 0.7,
    cycleTime: 0.35, fireMode: 'auto', mag: 7, reserve: 32, reloadType: 'shell', reloadStart: 0.45, shellTime: 0.37, reloadEnd: 0.35,
    maxSpeed: 215, shellEject: 'auto',
    spread: 38, inaccuracyStand: 6.5, inaccuracyCrouch: 5.0, inaccuracyMove: 60, inaccuracyFire: 40,
    recoveryTimeStand: 0.4, recoveryTimeCrouch: 0.35, recoilMagnitude: 71, recoilAngleVariance: 30,
  }),
  mag7: W('heavy', {
    name: 'MAG-7', team: 'CT', price: 1300, damage: 30, bullets: 8, armorPen: 0.75, rangeModifier: 0.45,
    range: 1400, cycleTime: 0.85, mag: 5, reserve: 32, reloadTime: 2.5, maxSpeed: 225, magFed: true,
    spread: 40, inaccuracyStand: 6.0, inaccuracyCrouch: 4.5, inaccuracyMove: 55, inaccuracyFire: 50,
    recoveryTimeStand: 0.4, recoveryTimeCrouch: 0.35, recoilMagnitude: 165, recoilAngleVariance: 30,
  }),
  negev: W('lmg', {
    name: 'Negev', team: null, price: 1700, damage: 35, armorPen: 0.71, rangeModifier: 0.97,
    cycleTime: 0.075, mag: 150, reserve: 300, reloadTime: 5.7, maxSpeed: 150,
    spread: 1.0, inaccuracyStand: 12.0, inaccuracyCrouch: 9.0, inaccuracyMove: 150, inaccuracyFire: 1.2,
    recoveryTimeStand: 0.6, recoveryTimeCrouch: 0.5, recoilMagnitude: 23,
    wildBeast: { edgeShots: 3, settleShots: 12, first: 2.2, settled: 0.25 }, // CS:GO 2020 Negev
  }),
  m249: W('lmg', {
    name: 'M249', team: null, price: 5200, damage: 32, armorPen: 0.8, rangeModifier: 0.97,
    cycleTime: 0.08, mag: 100, reserve: 200, reloadTime: 5.7, maxSpeed: 195,
    spread: 2.0, inaccuracyStand: 5.3, inaccuracyCrouch: 4.0, inaccuracyMove: 173, inaccuracyFire: 3.9,
    recoveryTimeStand: 0.6, recoveryTimeCrouch: 0.5, recoilMagnitude: 22,
  }),

  // ---------------------------------------------------------------- rifles ----------------
  galil: W('rifle', {
    name: 'Galil AR', team: 'T', price: 1800, damage: 30, armorPen: 0.775, rangeModifier: 0.98,
    cycleTime: 0.09, mag: 35, reserve: 90, reloadTime: 2.97, maxSpeed: 215,
    spread: 0.6, inaccuracyStand: 7.4, inaccuracyCrouch: 5.5, inaccuracyMove: 148, inaccuracyFire: 10.0,
    recoveryTimeStand: 0.39, recoveryTimeCrouch: 0.29, recoilMagnitude: 30,
  }),
  famas: W('rifle', {
    name: 'FAMAS', team: 'CT', price: 2050, damage: 30, armorPen: 0.7, rangeModifier: 0.96,
    cycleTime: 0.09, mag: 25, reserve: 90, reloadTime: 3.3, maxSpeed: 220,
    spread: 0.6, inaccuracyStand: 6.2, inaccuracyCrouch: 4.6, inaccuracyMove: 133, inaccuracyFire: 9.2,
    recoveryTimeStand: 0.33, recoveryTimeCrouch: 0.28, recoilMagnitude: 21,
    burst: { count: 3, interval: 0.075, cycle: 0.55 },
    alt: { inaccuracyFire: 6.0, recoilMagnitude: 17 },   // burst mode
  }),
  ak47: W('rifle', {
    name: 'AK-47', team: 'T', price: 2700, damage: 36, armorPen: 0.775, rangeModifier: 0.98,
    cycleTime: 0.1, mag: 30, reserve: 90, reloadTime: 2.43, deployTime: 1.0, maxSpeed: 215,
    spread: 0.6, inaccuracyStand: 6.41, inaccuracyCrouch: 4.81, inaccuracyMove: 175.06, inaccuracyFire: 7.8,
    inaccuracyJump: 80, inaccuracyJumpInitial: 140, inaccuracyLand: 0.242, inaccuracyLadder: 140,
    recoveryTimeStand: 0.3687, recoveryTimeCrouch: 0.3053, recoveryTimeStandFinal: 0.5069, recoveryTimeCrouchFinal: 0.4197,
    recoilMagnitude: 30, recoilAngleVariance: 70, recoilSeed: 223,
  }),
  m4a4: W('rifle', {
    name: 'M4A4', team: 'CT', price: 3100, damage: 33, armorPen: 0.7, rangeModifier: 0.97,
    cycleTime: 0.09, mag: 30, reserve: 90, reloadTime: 3.07, maxSpeed: 225,
    spread: 0.6, inaccuracyStand: 5.6, inaccuracyCrouch: 4.2, inaccuracyMove: 141, inaccuracyFire: 7.0,
    recoveryTimeStand: 0.42, recoveryTimeCrouch: 0.35, recoilMagnitude: 23,
  }),
  m4a1s: W('rifle', {
    name: 'M4A1-S', team: 'CT', price: 2900, damage: 38, armorPen: 0.7, rangeModifier: 0.99,
    cycleTime: 0.1, mag: 20, reserve: 80, reloadTime: 3.07, maxSpeed: 225,
    spread: 0.35, inaccuracyStand: 3.68, inaccuracyCrouch: 2.76, inaccuracyMove: 123, inaccuracyFire: 7.0,
    recoveryTimeStand: 0.39, recoveryTimeCrouch: 0.33, recoilMagnitude: 21,
    silencer: true, silencerTime: 2.7, silencerOffTime: 2.2, tracerFreq: 0,
    alt: { spread: 0.6, inaccuracyStand: 5.6, inaccuracyCrouch: 4.2, inaccuracyFire: 9.0, recoilMagnitude: 24, tracerFreq: 3 },
  }),
  sg553: W('rifle', {
    name: 'SG 553', team: 'T', price: 3000, damage: 30, armorPen: 1.0, rangeModifier: 0.98,
    cycleTime: 0.09, mag: 30, reserve: 90, reloadTime: 2.8, maxSpeed: 210, maxSpeedAlt: 150,
    spread: 0.6, inaccuracyStand: 5.6, inaccuracyCrouch: 4.2, inaccuracyMove: 144, inaccuracyFire: 8.2,
    recoveryTimeStand: 0.4, recoveryTimeCrouch: 0.33, recoilMagnitude: 28,
    zoom: [45], zoomTime: 0.1,
    alt: { cycleTime: 0.135, spread: 0.3, inaccuracyStand: 2.9, inaccuracyCrouch: 2.2, inaccuracyFire: 6.5, recoilMagnitude: 22 },
  }),
  aug: W('rifle', {
    name: 'AUG', team: 'CT', price: 3300, damage: 28, armorPen: 0.9, rangeModifier: 0.98,
    cycleTime: 0.09, mag: 30, reserve: 90, reloadTime: 3.8, maxSpeed: 220, maxSpeedAlt: 150,
    spread: 0.5, inaccuracyStand: 4.9, inaccuracyCrouch: 3.7, inaccuracyMove: 139, inaccuracyFire: 6.6,
    recoveryTimeStand: 0.35, recoveryTimeCrouch: 0.3, recoilMagnitude: 26,
    zoom: [45], zoomTime: 0.1,
    alt: { cycleTime: 0.12, spread: 0.3, inaccuracyStand: 2.8, inaccuracyCrouch: 2.1, inaccuracyFire: 5.5, recoilMagnitude: 21 },
  }),
  ssg08: W('sniper', {
    name: 'SSG 08', team: null, price: 1700, damage: 88, armorPen: 0.85, rangeModifier: 0.98,
    cycleTime: 1.25, mag: 10, reserve: 90, reloadTime: 3.7, deployTime: 1.25, maxSpeed: 230, maxSpeedAlt: 230,
    spread: 0.28, inaccuracyStand: 23.8, inaccuracyCrouch: 17.9, inaccuracyMove: 48, inaccuracyFire: 40,
    inaccuracyJump: 22, inaccuracyJumpInitial: 50, inaccuracyLand: 0.12,
    recoveryTimeStand: 0.25, recoveryTimeCrouch: 0.2, recoilMagnitude: 33, shellEject: 'bolt',
    zoom: [40, 15], zoomTime: 0.08, resumeZoom: true,
    alt: { inaccuracyStand: 2.3, inaccuracyCrouch: 1.7, inaccuracyFire: 30, inaccuracyJump: 1.0, inaccuracyJumpInitial: 40 },
  }),
  awp: W('sniper', {
    name: 'AWP', team: null, price: 4750, killAward: 100, damage: 115, armorPen: 0.975, rangeModifier: 0.99,
    cycleTime: 1.455, mag: 5, reserve: 30, reloadTime: 3.67, deployTime: 1.25, maxSpeed: 200, maxSpeedAlt: 100,
    spread: 0.2, inaccuracyStand: 60, inaccuracyCrouch: 45, inaccuracyMove: 176, inaccuracyFire: 110,
    inaccuracyJump: 280, inaccuracyJumpInitial: 300,
    recoveryTimeStand: 0.35, recoveryTimeCrouch: 0.25, recoilMagnitude: 78, shellEject: 'bolt',
    zoom: [40, 10], zoomTime: 0.12, resumeZoom: true,
    alt: { inaccuracyStand: 1.9, inaccuracyCrouch: 1.4, inaccuracyFire: 110, inaccuracyJump: 180 },
  }),
  g3sg1: W('sniper', {
    name: 'G3SG1', team: 'T', price: 5000, damage: 80, armorPen: 0.825, rangeModifier: 0.98,
    cycleTime: 0.25, mag: 20, reserve: 90, reloadTime: 4.7, maxSpeed: 215, maxSpeedAlt: 120,
    spread: 0.3, inaccuracyStand: 30, inaccuracyCrouch: 22, inaccuracyMove: 170, inaccuracyFire: 30,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoilMagnitude: 30,
    zoom: [40, 15], zoomTime: 0.1,
    alt: { inaccuracyStand: 2.3, inaccuracyCrouch: 1.8, inaccuracyFire: 25 },
  }),
  scar20: W('sniper', {
    name: 'SCAR-20', team: 'CT', price: 5000, damage: 80, armorPen: 0.825, rangeModifier: 0.98,
    cycleTime: 0.25, mag: 20, reserve: 90, reloadTime: 3.1, maxSpeed: 215, maxSpeedAlt: 120,
    spread: 0.3, inaccuracyStand: 30, inaccuracyCrouch: 22, inaccuracyMove: 170, inaccuracyFire: 30,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoilMagnitude: 31,
    zoom: [40, 15], zoomTime: 0.1,
    alt: { inaccuracyStand: 2.3, inaccuracyCrouch: 1.8, inaccuracyFire: 25 },
  }),

  // ---------------------------------------------------------------- taser -----------------
  taser: {
    name: 'Zeus x27', team: null, slot: 'taser', cat: 'gear', family: 'pistol', price: 200, killAward: 0,
    damage: 500, armorPen: 1.0, rangeModifier: 0.0049, headshotMul: 1, range: 183, bullets: 1,
    cycleTime: 0.15, fireMode: 'semi', mag: 1, reserve: 0, reloadTime: 0, deployTime: 1.0, maxSpeed: 220,
    penetration: 0, spread: 2.0, inaccuracyStand: 2.0, inaccuracyCrouch: 1.5, inaccuracyMove: 20, inaccuracyFire: 0,
    inaccuracyJump: 30, inaccuracyJumpInitial: 60, inaccuracyLand: 0.1, inaccuracyLadder: 60,
    recoveryTimeStand: 0.3, recoveryTimeCrouch: 0.25, recoveryTransition: [0, 0],
    recoilMagnitude: 8, recoilAngleVariance: 20, tracerFreq: 1, singleUse: true, tagging: 0.5, taggingSmall: 0.65,
    shellEject: 'none', rpm: 400,
  },

  // ---------------------------------------------------------------- grenades --------------
  hegrenade: { name: 'HE Grenade', team: null, slot: 'grenade', cat: 'grenade', family: 'grenade', price: 300, killAward: 300, max: 1,
    damage: 98, radius: 350, armorPen: 0.58, fuse: 1.5, detonate: 'timer', maxSpeed: 245, deployTime: 0.6 },
  flashbang: { name: 'Flashbang', team: null, slot: 'grenade', cat: 'grenade', family: 'grenade', price: 200, killAward: 300, max: 2,
    fuse: 1.5, detonate: 'timer', maxSpeed: 245, deployTime: 0.6 },
  smokegrenade: { name: 'Smoke Grenade', team: null, slot: 'grenade', cat: 'grenade', family: 'grenade', price: 300, killAward: 300, max: 1,
    fuse: 1.5, detonate: 'rest', duration: 18, radius: 144, maxSpeed: 245, deployTime: 0.6 },
  molotov: { name: 'Molotov', team: 'T', slot: 'grenade', cat: 'grenade', family: 'grenade', price: 400, killAward: 300, max: 1,
    fuse: 2.0, detonate: 'impact', duration: 7, radius: 150, burnDps: 40, maxSpeed: 245, deployTime: 0.6 },
  incgrenade: { name: 'Incendiary Grenade', team: 'CT', slot: 'grenade', cat: 'grenade', family: 'grenade', price: 500, killAward: 300, max: 1,
    fuse: 2.0, detonate: 'impact', duration: 7, radius: 150, burnDps: 40, maxSpeed: 245, deployTime: 0.6 },
  decoy: { name: 'Decoy Grenade', team: null, slot: 'grenade', cat: 'grenade', family: 'grenade', price: 50, killAward: 300, max: 1,
    fuse: 1.5, detonate: 'rest', duration: 15, damage: 5, radius: 50, maxSpeed: 245, deployTime: 0.6 },

  // ---------------------------------------------------------------- gear / bomb -----------
  kevlar: { name: 'Kevlar Vest', team: null, slot: 'gear', cat: 'gear', price: 650, killAward: 0 },
  kevlarhelmet: { name: 'Kevlar + Helmet', team: null, slot: 'gear', cat: 'gear', price: 1000, killAward: 0 },
  defusekit: { name: 'Defuse Kit', team: 'CT', slot: 'gear', cat: 'gear', price: 400, killAward: 0 },
  c4: { name: 'C4 Explosive', team: 'T', slot: 'c4', cat: 'c4', family: 'c4', price: 0, killAward: 300,
    maxSpeed: 250, deployTime: 1.0, plantTime: 3.2, timer: 40, defuseTime: 10, defuseTimeKit: 5,
    damage: 500, radius: 1750 },
});

// Contract alias: 'zeus' is the equipment name, 'taser' the weapon key.
WEAPONS.zeus = WEAPONS.taser;

// Throw physics shared by every grenade (CS:GO CBaseCSGrenade::ThrowGrenade)
export const GRENADE = {
  throwSpeed: 750, underhandFrac: 0.3, playerVelScale: 1.25, gravityScale: 0.4, elasticity: 0.45,
  hull: 2, stopSpeed: 30, pinTime: 0.3, throwDelay: 0.1, throwAnim: 0.5,
};

export const GRENADE_KEYS = ['hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade', 'decoy'];
export const MAX_GRENADES = 4;

export const isGrenade = (k) => WEAPONS[k]?.slot === 'grenade';
export const isGun = (k) => { const d = WEAPONS[k]; return !!d && (d.slot === 'primary' || d.slot === 'secondary' || d.slot === 'taser'); };
export const slotOf = (k) => WEAPONS[k]?.slot ?? null;
export const defOf = (k) => WEAPONS[k] ?? null;

/** Default spawn loadouts (CS: T glock, CT usp-s). */
export const DEFAULT_LOADOUT = { T: ['knife', 'glock'], CT: ['knife', 'usp'] };

export default WEAPONS;
