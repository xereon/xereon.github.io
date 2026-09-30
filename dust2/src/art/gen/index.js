// Registry of every material / decal definition. Keys are the CONTRACT §5 names.
import * as masonry from './masonry.js';
import { C } from './util.js';

// Flat colours used before the bake finishes (and in Node tests).
export const FALLBACK = {
  sand_floor: 0xcbb285, sand_blend: 0xc4a97a, gravel: 0xa99a82, concrete_wall: 0xb9ad98,
  concrete_floor: 0xa89c88, plaster_wall: 0xd9c49c, plaster_trim: 0xcdb58a, brick_tan: 0xc0976a,
  brick_red: 0x9a5a3e, stone_block: 0xc2ad86, stone_wall: 0xb5a17c, rubble: 0x9e8f76,
  wood_planks: 0x8a6440, wood_crate: 0x9b7447, wood_door: 0x6e4a2c, metal_door: 0x5b6f78,
  metal_grate: 0x555a5c, metal_beam: 0x5e5a55, metal_barrel: 0x3f5a6a, tile_floor: 0xb89a74,
  tile_wall: 0xc9b89a, cloth_awning: 0x8d3a2a, cloth_tarp: 0x6b6b4a, rope: 0x9b8660,
  sandbag: 0xb09a72, arch_stone: 0xcab790, roof_tile: 0x9a5a3a, window_frame: 0x4b3a2a,
  glass: 0x88a0a8, poster: 0xc8b8a0, crate_label: 0x9b7447,
};

const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const placeholder = (key) => ({
  world: 128, normal: 1, ao: 0.6, surface: 'default', seed: 99,
  glsl: `void surface(vec2 uv, inout Surf o) {
  float n = fbmU(uv, 8.0, 5, 0.5, 1.0);
  o.h = 0.3 * n;
  o.col = ${C(hex(FALLBACK[key]))} * (0.9 + 0.15 * n);
  o.rough = 0.85;
}`,
});

const ALL = { ...masonry };
export const DEFS = {};
for (const k of Object.keys(FALLBACK)) DEFS[k] = ALL[k] || placeholder(k);

export const DECALS = {};
export const DETAIL = {
  size: 256, world: 16, normal: 1, ao: 0, cavity: 0, seed: 5,
  glsl: `void surface(vec2 uv, inout Surf o) {
  o.h = 0.04 * fbmU(uv, 32.0, 3, 0.55, 1.0) + 0.02 * fbmU(uv, 128.0, 1, 0.5, 2.0);
}`,
};
