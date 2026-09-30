// Prop placement at the real Dust II spots (Source coordinates), read off the overview.
// Uses props.js factories when available and falls back to textured boxes so the map is
// always complete and always has the same collision footprint.

/** A crate: base centre pos, size number or [sx, sy, h], yaw deg. */
export function crate(K, pos, size = 64, yaw = 0, variant = 0) {
  const [sx, sy, sz] = Array.isArray(size) ? size : [size, size, size];
  K.prop('crate', [[sx, sz, sy], variant], pos, yaw, () => K.obox(pos, [sx, sy, sz], yaw, 'wood_crate'));
}
function tarpCrate(K, pos, size = 64, yaw = 0, color = 'teal', variant = 0) {
  K.emitter('amb_tarp', [pos[0], pos[1], pos[2] + size], 700);
  K.prop('tarpCrate', [size, color, variant], pos, yaw, () => {
    K.obox(pos, [size, size, size], yaw, 'wood_crate');
    K.obox([pos[0], pos[1], pos[2] + size], [size + 4, size + 4, 3], yaw, 'cloth_tarp', { col: false });
  });
}
function barrel(K, pos, variant = 0, yaw = 0) {
  K.prop('barrel', [variant], pos, yaw, () => K.obox(pos, [22, 22, 35], yaw, 'metal_barrel'));
}
function car(K, pos, yaw, variant = 0) {
  K.prop('car', [variant], pos, yaw, () => {
    K.obox(pos, [160, 64, 30], yaw, 'metal_door', { color: 0.9 });
    K.obox([pos[0], pos[1], pos[2] + 30], [90, 58, 24], yaw, 'glass', { color: 0.8 });
  });
}
function metalCrate(K, pos, size, yaw, variant = 0) {
  const [sx, sy, sz] = size;
  K.prop('metalCrate', [[sx, sz, sy], variant], pos, yaw, () => K.obox(pos, [sx, sy, sz], yaw, 'metal_door'));
}
function palm(K, pos, h = 260, variant = 0, yaw = 0) {
  K.prop('palm', [h, variant], pos, yaw, () => K.obox(pos, [12, 12, h], yaw, 'wood_planks', { col: true }));
}
function prop(K, name, args, pos, yaw = 0, fallback = null) { K.prop(name, args, pos, yaw, fallback); }

/**
 * Door leaf: planked slab from hinge [x,y] toward tip [x,y], standing on z, height h.
 * Two ledges on one face so it reads as a boarded door, not a plank.
 */
export function leaf(K, hinge, tip, z, h = 128, t = 5, mat = 'wood_door') {
  K.slab(hinge, tip, z, z + h, t, mat, { color: 0.95 });
  const dx = tip[0] - hinge[0], dy = tip[1] - hinge[1], l = Math.hypot(dx, dy);
  const nx = dy / l, ny = -dx / l;
  const a = [hinge[0] + dx * 0.06 + nx * (t / 2 + 1), hinge[1] + dy * 0.06 + ny * (t / 2 + 1)];
  const b = [tip[0] - dx * 0.06 + nx * (t / 2 + 1), tip[1] - dy * 0.06 + ny * (t / 2 + 1)];
  for (const f of [0.18, 0.78]) K.slab(a, b, z + h * f, z + h * f + 7, 2.5, mat, { col: false, color: 0.8 });
}

export function build(K) {
  // ---------------------------------------------------------------- doors
  // long doors: outer pair (west leaf swung in, east leaf swung out) and the inner pair
  leaf(K, [553, 296], [621, 348], 0, 130);
  leaf(K, [719, 296], [646, 252], 0, 130);
  leaf(K, [553, 764], [620, 812], 0, 130);
  leaf(K, [720, 764], [655, 716], 0, 130);
  // mid doors: west leaf swung toward T, east leaf toward CT, the famous crack between them
  leaf(K, [-515, 1640], [-432, 1592], -128, 132);
  leaf(K, [-319, 1622], [-404, 1672], -128, 132);
  K.slab([-518, 1638], [-316, 1638], 10, 200, 20, 'plaster_wall');     // wall over the doors
  K.slab([-518, 1638], [-316, 1638], 4, 10, 26, 'wood_planks');        // timber lintel
  // B doors: one leaf pushed into the site, the other half-open across the frame
  leaf(K, [-1333, 2300], [-1392, 2226], 3, 136, 5, 'wood_door');
  leaf(K, [-1305, 2116], [-1343, 2198], 3, 136, 5, 'wood_door');

  // ---------------------------------------------------------------- T spawn
  crate(K, [-1946, -886, 128], [74, 170, 64]);
  crate(K, [-927, -659, 128], 60);
  crate(K, [-1013, -501, 128], [74, 200, 56], 0, 1);
  crate(K, [-1717, -270, 128], [74, 74, 36], 0, 2);
  crate(K, [-1680, -195, 128], [48, 48, 36], 20, 1);
  barrel(K, [-1545, -186, 128]); barrel(K, [-1520, -205, 128], 1);
  crate(K, [-1119, -173, 128], 47);
  barrel(K, [-978, -165, 128], 2); barrel(K, [-968, -190, 128]);
  car(K, [-1840, -960, 128], 90, 2);

  // ---------------------------------------------------------------- outside tunnels / T mid
  crate(K, [-1433, -74, 6], [61, 52, 64], 0, 1);
  crate(K, [-1408, 29, 6], [110, 64, 48], 50);
  crate(K, [-1838, 570, 32], [36, 40, 36], 18);
  crate(K, [-474, -150, 0], [64, 64, 64], 0, 3);
  crate(K, [-480, -80, 0], [48, 48, 48], 10, 1);
  crate(K, [-678, 228, 0], [28, 48, 40], 11);
  crate(K, [-217, 573, 0], [34, 64, 48]);
  crate(K, [-588, 670, 0], [72, 64, 64], 0, 2);
  crate(K, [-588, 720, 0], [48, 40, 48], 8);
  barrel(K, [-300, 610, 0]); barrel(K, [-276, 612, 0], 1);

  // ---------------------------------------------------------------- outside long / long doors / long
  metalCrate(K, [657, -44, 0], [79, 206, 88], 15.9, 0);                // the big container
  crate(K, [162, -52, 0], [74, 74, 64], 0, 1);
  crate(K, [200, -40, 0], [64, 48, 48], 0, 2);
  crate(K, [142, 53, 0], 34);
  crate(K, [700, 690, 0], [64, 64, 64], 0, 0);                            // box stack in the doors corridor
  crate(K, [730, 628, 0], [48, 48, 48], 0, 2);
  crate(K, [676, 640, 0], [70, 36, 40], -35, 1);
  crate(K, [700, 690, 64], [48, 48, 36], 12, 3);
  barrel(K, [817, 817, 0], 2);
  metalCrate(K, [800, 1160, 0], [180, 120, 100], 0, 0);                   // "blue"
  crate(K, [930, 1180, 0], [60, 64, 64], 0, 1);
  crate(K, [1746, 1021, 0], [34, 64, 48]);
  car(K, [1682, 2034, -2], 90 + 15.9, 0);                                  // A car at the top of long
  barrel(K, [1293, 2841, 120]); barrel(K, [1337, 2845, 120], 1);

  // ---------------------------------------------------------------- A site
  tarpCrate(K, [1004, 2515, 96], 64, 8, 'teal', 0);
  tarpCrate(K, [1066, 2505, 96], 64, -6, 'teal', 1);
  tarpCrate(K, [1034, 2512, 160], 48, 30, 'teal', 2);
  tarpCrate(K, [1180, 2545, 96], 60, 0, 'teal', 1);
  crate(K, [606, 2746, 96], [64, 64, 64], 0, 2);
  crate(K, [668, 2746, 96], [40, 64, 64], 8, 1);
  crate(K, [710, 2746, 96], [64, 34, 40], 0, 0);
  for (const [x, y] of [[870, 2704], [825, 2710], [855, 2735], [853, 2770], [300, 2745], [330, 2770], [360, 2740], [280, 2770], [390, 2765]]) barrel(K, [x, y, 96], (x + y) % 3);
  barrel(K, [547, 2561, 96], 1); barrel(K, [520, 2603, 96], 2);
  crate(K, [459, 2005, 96], [64, 64, 36]);
  crate(K, [600, 2320, -101], [36, 74, 48], 0, 1);
  crate(K, [660, 2320, -82], [36, 74, 48], 0, 2);
  crate(K, [586, 2375, -105], [64, 34, 36], 7);
  crate(K, [459, 1395, 0], [72, 64, 64], 0, 1);

  // ---------------------------------------------------------------- mid
  crate(K, [-312, 1428, -125], [80, 80, 97], 0, 0);                       // xbox
  crate(K, [-826, 1356, -112], [64, 64, 64], 0, 1);
  crate(K, [-1174, 1497, -112], [64, 64, 36], 0, 2);
  crate(K, [-1097, 1497, -112], [64, 64, 36], 6, 3);
  crate(K, [-1268, 1250, 32], [64, 64, 64], 0, 1);
  crate(K, [-1350, 1248, 32], [70, 34, 40]);
  crate(K, [-1804, 1285, 32], [70, 44, 48], 56);
  crate(K, [-2113, 1351, 32], [120, 128, 96], 0, 1);

  // ---------------------------------------------------------------- CT
  crate(K, [-111, 2022, -126], 64);
  crate(K, [-173, 2256, -126], [96, 96, 64], 0, 1);
  crate(K, [39, 2308, -126], [80, 80, 64], 45, 2);
  car(K, [-465, 2507, -96], 180 + 83.7 - 90, 1);                           // van/car at CT mid
  crate(K, [-1152, 2093, 3], [72, 36, 48], 82);
  crate(K, [-1090, 2106, -11], [64, 64, 64], 0, 2);
  crate(K, [-1083, 2658, 36], [38, 120, 110], 0, 1);                      // tall stack by the window ramp

  // ---------------------------------------------------------------- B
  crate(K, [-1600, 1712, 4], 64, 45, 1);
  crate(K, [-1820, 1833, 4], [64, 72, 64]);
  crate(K, [-1589, 1874, 4], [180, 70, 64], 29.4, 2);
  crate(K, [-1807, 2377, 4], [96, 96, 96], 0, 0);
  crate(K, [-1631, 2546, 4], [64, 64, 64], 0, 1);
  crate(K, [-1584, 2753, 4], 64, 63, 2);
  crate(K, [-1829, 2654, 32], [70, 36, 36], 45);
  crate(K, [-2058, 2856, 32], 60, 0, 3);
  crate(K, [-2060, 2482, 32], [34, 70, 36]);
  barrel(K, [-1361, 2344, 4]); barrel(K, [-1358, 2379, 4], 1);
  // the big timber gate in B's north wall and the tarp-covered pallets
  prop(K, 'bigDoorMetal', [150, 170, 0, { paint: 'teal', arch: true }], [-1620, 2895, 4], 0);
  prop(K, 'tarp', [64, 56, 48, 'bluegrey'], [-1480, 2560, 4], 20);
  prop(K, 'stoneBlocks', [48, 40, 5], [-1690, 2600, 4], 0);
  prop(K, 'stoneBlocks', [48, 40, 4], [-1690, 2650, 4], 90);
  barrel(K, [-1774, 2786, 32], 2);
  car(K, [-1950, 3080, 32], 90, 0);
  // palms on the terrace behind A and in the T-spawn yard
  palm(K, [1090, 3030, 120], 300, 0); palm(K, [1470, 3040, 120], 260, 1); palm(K, [1320, 3060, 120], 330, 2);
  palm(K, [-2150, -1000, 128], 280, 1);
}
