// Render lab scene: a compact Dust II-like block (street, courtyard, covered passage, crates,
// barrels, stairs) built from boxes with TextureLib materials + matching collision brushes,
// so the lighting pipeline can be judged independently of the real map.
import * as THREE from 'three';
import { CollisionWorld } from '../src/player/collision.js';
import { TextureLib } from '../src/art/textures.js';

const PLAIN = new Map();
function labMaterial(key, opts, plain) {
  if (!plain) return TextureLib.material(key, opts);
  if (!PLAIN.has(key)) {
    const m = TextureLib.material(key, opts);
    PLAIN.set(key, new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.9, map: m.map || null }));
  }
  return PLAIN.get(key);
}

export function buildLab({ plain = false } = {}) {
  const root = new THREE.Group();
  root.name = 'renderlab';
  const col = new CollisionWorld();
  const geo = new Map();
  const box = (min, max, key, surf = 'plaster', opts = { world: true }) => {
    const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
    const k = `${sx}|${sy}|${sz}`;
    if (!geo.has(k)) geo.set(k, new THREE.BoxGeometry(sx, sy, sz));
    const m = new THREE.Mesh(geo.get(k), labMaterial(key, opts, plain));
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    m.updateMatrix(); m.matrixAutoUpdate = false;
    root.add(m);
    col.addBox(new THREE.Vector3(...min), new THREE.Vector3(...max), surf);
    return m;
  };
  // ground: sand courtyard + concrete street
  box([-2400, -32, -2400], [2400, 0, 2400], 'sand_floor', 'sand');
  box([-2400, 0, 300], [2400, 2, 700], 'concrete_floor', 'concrete');
  // street walls (long sightline running along X, like Long A)
  box([-2400, 0, 700], [600, 340, 780], 'plaster_wall');
  box([700, 0, 700], [2400, 420, 820], 'plaster_wall');
  box([-2400, 0, 180], [-900, 300, 300], 'plaster_wall');
  box([-700, 0, 180], [900, 260, 300], 'stone_wall', 'rock');
  box([1100, 0, 180], [2400, 380, 300], 'plaster_wall');
  // courtyard buildings (south side)
  box([-900, 0, -900], [-500, 380, 180], 'plaster_wall');
  box([-500, 0, -1300], [300, 300, -900], 'brick_tan', 'brick');
  box([500, 0, -900], [1100, 420, 0], 'plaster_wall');
  box([1100, 0, -700], [1600, 260, 180], 'stone_wall', 'rock');
  // covered passage (roof over a corridor between two blocks) -> warm bounce under overhang
  box([-500, 0, -900], [-460, 220, -300], 'plaster_wall');
  box([-300, 0, -900], [-260, 220, -300], 'plaster_wall');
  box([-520, 220, -900], [-240, 268, -300], 'stone_block', 'rock');
  // arch-like doorway: wall with a gap and a lintel
  box([0, 0, -300], [300, 260, -250], 'plaster_wall');
  box([420, 0, -300], [500, 260, -250], 'plaster_wall');
  box([300, 180, -300], [420, 260, -250], 'arch_stone', 'rock');
  // crates + barrels in the courtyard
  box([-120, 0, -140], [-56, 64, -76], 'wood_crate', 'crate');
  box([-56, 0, -140], [8, 64, -76], 'wood_crate', 'crate');
  box([-100, 64, -130], [-36, 128, -66], 'wood_crate', 'crate');
  box([120, 0, -600], [220, 90, -500], 'wood_crate', 'crate');
  const barrelGeo = new THREE.CylinderGeometry(15, 15, 46, 28);
  for (const [x, z] of [[40, -60], [74, -44], [260, -620]]) {
    const b = new THREE.Mesh(barrelGeo, labMaterial('metal_barrel', {}, plain));
    b.position.set(x, 23, z);
    root.add(b);
    col.addBox(new THREE.Vector3(x - 15, 0, z - 15), new THREE.Vector3(x + 15, 46, z + 15), 'metal');
  }
  // stairs up to a ledge
  for (let i = 0; i < 6; i++) box([900, 0, -120 + i * 20], [1100, 16 + i * 16, -100 + i * 20], 'concrete_floor', 'concrete');
  box([900, 0, 0], [1100, 96, 180], 'stone_block', 'rock');
  // low sandbag-ish wall
  box([-300, 0, 60], [100, 44, 96], 'sandbag', 'sand');
  // distant tall buildings for the haze / skyline
  box([-2400, 0, 1400], [-1400, 700, 2400], 'plaster_wall');
  box([1500, 0, 1600], [2400, 560, 2400], 'brick_tan', 'brick');
  box([-2400, 0, -2400], [-1500, 520, -1600], 'plaster_wall');
  col.build();

  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const zone = (a, b, name) => ({ min: v(...a), max: v(...b), name });
  return {
    root, collision: col,
    spawns: { T: [{ pos: v(0, 0, 400), yaw: 0 }], CT: [{ pos: v(0, 0, -400), yaw: 180 }] },
    bombsites: { A: zone([0, 0, -200], [400, 200, 0], 'A'), B: zone([-400, 0, -200], [0, 200, 0], 'B') },
    buyzones: { T: zone([-300, 0, 300], [300, 200, 700], 'T'), CT: zone([-300, 0, -700], [300, 200, -300], 'CT') },
    sun: { dir: v(-0.45, -0.82, -0.36).normalize(), color: new THREE.Color(0xfff1dc), intensity: 3 },
    ambient: { sky: new THREE.Color(0xbfd6ff), ground: new THREE.Color(0x8a6a45), intensity: 1 },
    fog: { color: new THREE.Color(0xd8c8a8), density: 0.00005 },
    walkable: new Float32Array(),
    callouts: {},
  };
}

// A stand-in first-person weapon (metal receiver + wood furniture) to judge viewmodel light.
export function buildViewmodelDummy() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2b2c, metalness: 0.9, roughness: 0.42 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4226, metalness: 0, roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x3d4a2e, metalness: 0, roughness: 0.85 });
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; g.add(m); return m; };
  add(new THREE.BoxGeometry(2.2, 3.2, 16), metal, 0, 0, -8);
  add(new THREE.CylinderGeometry(0.55, 0.55, 18, 16), metal, 0, 0.9, -24, Math.PI / 2);
  add(new THREE.BoxGeometry(2.4, 2.6, 9), wood, 0, -0.4, -21);
  add(new THREE.BoxGeometry(1.8, 6, 2.6), metal, 0, -4, -9, 0.35);
  add(new THREE.BoxGeometry(2.2, 5, 3), wood, 0, -3.4, -2, -0.3);
  add(new THREE.BoxGeometry(4.5, 4.5, 14), skin, -3.5, -5, 1, 0.2);
  g.position.set(7, -8.5, -16);
  g.rotation.y = 0.06;
  return g;
}

export const LAB_VIEWS = {
  street:    { eye: [-1300, 64, 500], pitch: 2, yaw: 3 },
  courtyard: { eye: [-700, 330, 250], pitch: 24, yaw: -48 },
  passage:   { eye: [-380, 64, -250], pitch: 4, yaw: -88 },
  crates:    { eye: [-260, 64, 180], pitch: 12, yaw: -35 },
  overview:  { eye: [-1500, 700, 900], pitch: 26, yaw: -38 },
  skyline:   { eye: [0, 64, 500], pitch: -6, yaw: 90 },
};
