// Shared surface properties. See CONTRACT.md §4.
export const SURFACES = {
  default:    { footstepPitch: 1.00, impactSound: 'impact_concrete', decal: 'bullet_concrete', dustColor: 0xb8a58a, dustAmount: 1.0, penetrationModifier: 1.0, hardness: 0.7 },
  sand:       { footstepPitch: 0.90, impactSound: 'impact_sand',     decal: 'bullet_sand',     dustColor: 0xd2b98e, dustAmount: 1.6, penetrationModifier: 0.3, hardness: 0.2 },
  gravel:     { footstepPitch: 0.95, impactSound: 'impact_sand',     decal: 'bullet_sand',     dustColor: 0xa99a82, dustAmount: 1.2, penetrationModifier: 0.4, hardness: 0.4 },
  dirt:       { footstepPitch: 0.90, impactSound: 'impact_sand',     decal: 'bullet_sand',     dustColor: 0x9b8567, dustAmount: 1.4, penetrationModifier: 0.3, hardness: 0.25 },
  concrete:   { footstepPitch: 1.00, impactSound: 'impact_concrete', decal: 'bullet_concrete', dustColor: 0xbdb3a3, dustAmount: 1.0, penetrationModifier: 0.5, hardness: 0.9 },
  plaster:    { footstepPitch: 1.00, impactSound: 'impact_plaster',  decal: 'bullet_plaster',  dustColor: 0xe0cfb0, dustAmount: 1.5, penetrationModifier: 0.7, hardness: 0.5 },
  brick:      { footstepPitch: 1.00, impactSound: 'impact_concrete', decal: 'bullet_concrete', dustColor: 0xc49a70, dustAmount: 1.2, penetrationModifier: 0.45, hardness: 0.85 },
  rock:       { footstepPitch: 1.00, impactSound: 'impact_concrete', decal: 'bullet_concrete', dustColor: 0xa89c88, dustAmount: 0.9, penetrationModifier: 0.3, hardness: 1.0 },
  tile:       { footstepPitch: 1.10, impactSound: 'impact_tile',     decal: 'bullet_concrete', dustColor: 0xcfc3ad, dustAmount: 0.7, penetrationModifier: 0.6, hardness: 0.9 },
  wood:       { footstepPitch: 0.85, impactSound: 'impact_wood',     decal: 'bullet_wood',     dustColor: 0x8a6a45, dustAmount: 0.8, penetrationModifier: 1.0, hardness: 0.4 },
  crate:      { footstepPitch: 0.80, impactSound: 'impact_wood',     decal: 'bullet_wood',     dustColor: 0x8a6a45, dustAmount: 0.8, penetrationModifier: 1.0, hardness: 0.35 },
  metal:      { footstepPitch: 1.20, impactSound: 'impact_metal',    decal: 'bullet_metal',    dustColor: 0x777777, dustAmount: 0.3, penetrationModifier: 0.4, hardness: 1.0 },
  metalgrate: { footstepPitch: 1.30, impactSound: 'impact_metal',    decal: 'bullet_metal',    dustColor: 0x777777, dustAmount: 0.2, penetrationModifier: 1.0, hardness: 0.8 },
  metaldoor:  { footstepPitch: 1.20, impactSound: 'impact_metaldoor',decal: 'bullet_metal',    dustColor: 0x6d6d6d, dustAmount: 0.3, penetrationModifier: 0.8, hardness: 0.8 },
  cloth:      { footstepPitch: 0.80, impactSound: 'impact_cloth',    decal: null,              dustColor: 0xb09a7a, dustAmount: 0.4, penetrationModifier: 1.0, hardness: 0.1 },
  glass:      { footstepPitch: 1.30, impactSound: 'impact_glass',    decal: 'bullet_glass',    dustColor: 0xdddddd, dustAmount: 0.1, penetrationModifier: 1.0, hardness: 0.6 },
  water:      { footstepPitch: 1.00, impactSound: 'impact_water',    decal: null,              dustColor: 0x7a8a90, dustAmount: 0.0, penetrationModifier: 1.0, hardness: 0.0 },
  rubber:     { footstepPitch: 0.90, impactSound: 'impact_rubber',   decal: 'bullet_concrete', dustColor: 0x333333, dustAmount: 0.2, penetrationModifier: 0.8, hardness: 0.3 },
  flesh:      { footstepPitch: 1.00, impactSound: 'impact_flesh',    decal: 'blood',           dustColor: 0x6a0a0a, dustAmount: 0.0, penetrationModifier: 1.0, hardness: 0.1 },
};

export const surf = (k) => SURFACES[k] || SURFACES.default;
