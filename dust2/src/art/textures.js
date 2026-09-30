// BASELINE STUB — texture agent replaces this. See CONTRACT.md §5.
import * as THREE from 'three';

const COLORS = {
  sand_floor: 0xcbb285, sand_blend: 0xc4a97a, gravel: 0xa99a82, concrete_wall: 0xb9ad98,
  concrete_floor: 0xa89c88, plaster_wall: 0xd9c49c, plaster_trim: 0xcdb58a, brick_tan: 0xc0976a,
  brick_red: 0x9a5a3e, stone_block: 0xc2ad86, stone_wall: 0xb5a17c, rubble: 0x9e8f76,
  wood_planks: 0x8a6440, wood_crate: 0x9b7447, wood_door: 0x6e4a2c, metal_door: 0x5b6f78,
  metal_grate: 0x555a5c, metal_beam: 0x5e5a55, metal_barrel: 0x3f5a6a, tile_floor: 0xb89a74,
  tile_wall: 0xc9b89a, cloth_awning: 0x8d3a2a, cloth_tarp: 0x6b6b4a, rope: 0x9b8660,
  sandbag: 0xb09a72, arch_stone: 0xcab790, roof_tile: 0x9a5a3a, window_frame: 0x4b3a2a,
  glass: 0x88a0a8, poster: 0xc8b8a0, crate_label: 0x9b7447,
};
const cache = new Map();
export const TextureLib = {
  ready: Promise.resolve(),
  keys: () => Object.keys(COLORS),
  maps: () => ({}),
  material(key, opts = {}) {
    const k = key + JSON.stringify(opts);
    if (!cache.has(k)) cache.set(k, new THREE.MeshStandardMaterial({ color: COLORS[key] ?? 0xff00ff, roughness: 0.9 }));
    return cache.get(k);
  },
};
