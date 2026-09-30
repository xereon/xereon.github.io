// B side: upper tunnels (corridor, hall, exit), B site with the back platform, the B doors,
// B window and the hall from B doors down to CT mid.
import { zx, zy, zc } from './util.js';

export function build(K) {
  const tun = { mat: 'concrete_floor', wallMat: 'plaster_wall', ceilMat: 'wood_planks', paint: { h: 36, mat: 'plaster_wall#dark' } };
  const stoneWall = { wallMat: 'stone_wall', paint: null };

  // ---- upper tunnels ------------------------------------------------------------------------
  K.region('utun_mouth', zc([[-1736, 716], [-1588, 716], [-1588, 744], [-1736, 744]], 30),
    { ...tun, arch: { spring: 120, crown: 176 }, ceilTop: 330 });
  K.region('utun_corr', zc([[-1736, 744], [-1588, 744], [-1588, 958], [-1736, 958]], 30),
    { ...tun, ceil: 176, beams: { dir: 'x', step: 96 } });
  K.region('utun_hall', zc([
    [-2194, 1022], [-1867, 1022], [-1867, 958], [-1736, 958], [-1588, 958], [-1537, 958], [-1537, 1020],
    [-1293, 1020], [-1293, 1180], [-1293, 1298], [-1653, 1298], [-1653, 1425], [-1906, 1425], [-2057, 1425], [-2194, 1425],
  ], 32), { ...tun, ceil: 182, beams: { dir: 'y', step: 128 } });
  K.region('utun_exit', zc([[-2057, 1425], [-1906, 1425], [-1906, 1765], [-2057, 1765]], 32),
    { ...tun, ceil: 170, beams: { dir: 'x', step: 96 } });
  K.region('utun_exit_mouth', zc([[-2057, 1765], [-1906, 1765], [-1906, 1789], [-2057, 1789]], 32),
    { ...tun, arch: { spring: 118, crown: 170 }, ceilTop: 330, wallMat: 'stone_wall' });
  // support posts in the hall
  K.box([-1798, 1042, 32], [-1782, 1058, 182], 'wood_planks', { color: 0.8 });
  K.box([-1798, 1292, 32], [-1782, 1308, 182], 'wood_planks', { color: 0.8 });

  // ---- B site -------------------------------------------------------------------------------
  K.stairs('b_tunst', [[-2057, 1789], [-1906, 1789], [-1906, 1840], [-2057, 1840]], 32, 4, 4,
    { mat: 'stone_block', tops: { w: 330, e: 330 } });
  K.region('b_main', zc([
    [-2186, 1788], [-2057, 1788], [-2057, 1840], [-1906, 1840], [-1906, 1789], [-1735, 1789], [-1735, 1599],
    [-1604, 1599], [-1592, 1607], [-1544, 1706], [-1361, 1899], [-1361, 2070], [-1334, 2070], [-1334, 2112],
    [-1334, 2306], [-1334, 2600], [-1400, 2600], [-1455, 2600], [-1455, 2640], [-1400, 2640], [-1400, 2719],
    [-1334, 2719], [-1334, 2787], [-1352, 2803], [-1512, 2895], [-1715, 2895], [-1715, 2442], [-1860, 2442],
    [-1980, 2442], [-2185, 2442], [-2185, 2320], [-2211, 2320], [-2211, 2068], [-2186, 2068],
  ], 4), {
    mat: 'sand_floor', ...stoneWall, top: 330, tops: { 25: 64, 26: 64, 28: 64 }, cornice: { mat: 'stone_block', h: 10, out: 5 }, merlons: true,
  });
  K.stairs('b_platst', [[-1980, 2442], [-1860, 2442], [-1860, 2500], [-1980, 2500]], 4, 32, 4,
    { mat: 'stone_block', tops: { e: 64, w: 64 } });
  K.region('b_plat', zc([
    [-2140, 2460], [-1980, 2460], [-1980, 2500], [-1860, 2500], [-1860, 2460], [-1735, 2460], [-1735, 2895],
    [-1874, 2895], [-1874, 3172], [-2140, 3172],
  ], 32), { mat: 'sand_blend', ...stoneWall, top: 360, tops: { 0: 64, 4: 64, 5: 64 }, cornice: { mat: 'stone_block', h: 10, out: 5 }, merlons: true });

  // B window: raised ledge inside the site, the opening through the wall, the CT-side platform
  K.region('bwin_step', zc([[-1455, 2600], [-1400, 2600], [-1400, 2640], [-1455, 2640]], 108), { mat: 'stone_block', ...stoneWall });
  K.region('bwin_in', zc([[-1400, 2600], [-1334, 2600], [-1334, 2719], [-1400, 2719]], 124), { mat: 'stone_block', ...stoneWall, top: 330 });
  K.region('bwin_hole', zc([[-1334, 2626], [-1304, 2626], [-1304, 2719], [-1334, 2719]], 124),
    { mat: 'stone_block', ...stoneWall, ceil: 220, ceilMat: 'wood_planks', headerMat: 'stone_wall' });
  K.region('bwin_out', zc([[-1304, 2586], [-1250, 2586], [-1250, 2732], [-1304, 2732]], 118),
    { mat: 'stone_block', top: 340, paint: { h: 40, mat: 'plaster_wall#teal' } });
  // L-shaped climb from the hall: north up r1, then west up r2 onto the window platform
  K.region('bwin_r2', zx([[-1250, 2586], [-1180, 2586], [-1180, 2732], [-1250, 2732]], -1250, 114, -1180, 80),
    { mat: 'concrete_floor', top: 340, paint: { h: 40, mat: 'plaster_wall#teal' } });
  K.region('bwin_r1', [[-1180, 2586, 42], [-1052, 2586, 11], [-1052, 2726, 47.4], [-1067, 2732, 52.6], [-1180, 2732, 80]],
    { mat: 'concrete_floor', top: 340, paint: { h: 40, mat: 'plaster_wall#teal' } });
  K.box([-1485, 2628, 4], [-1460, 2665, 60], 'wood_crate');

  // B doors: thick frame with a timber lintel
  K.region('bdoors', zc([[-1334, 2112], [-1304, 2112], [-1304, 2306], [-1334, 2306]], 3),
    { mat: 'stone_block', ...stoneWall, ceil: 146, ceilMat: 'wood_planks', headerMat: 'stone_wall' });

  // ---- hall from B doors to CT mid: warped slope, low near CT, rising west to the doors and
  // north-west toward the window ramp. Built as a grid of cells sampling one height field.
  const Sx = (x) => (x >= -760 ? -128 : x <= -1130 ? 3 : -128 + (x + 760) / -370 * 131);
  const Nx = (x) => (x >= -780 ? -82 : x <= -1150 ? 42 : -82 + (x + 780) / -370 * 124);
  const H = (x, y) => {
    const t = Math.min(1, Math.max(0, (y - 2300) / 286));
    return Sx(x) + (Nx(x) - Sx(x)) * t;
  };
  const hz = (pts) => pts.map(([x, y]) => [x, y, Math.round(H(x, y) * 10) / 10]);
  const hall = { mat: 'concrete_floor', paint: { h: 44, mat: 'plaster_wall#ochre' }, cornice: {} };
  const XS = [-1304, -1150, -1052, -900, -742, -600, -316], YS = [2072, 2300, 2400, 2500, 2586];
  for (let i = 0; i < XS.length - 1; i++) for (let j = 0; j < YS.length - 1; j++) {
    const x0 = XS[i], x1 = XS[i + 1], y0 = YS[j], y1 = YS[j + 1];
    const top = x1 <= -900 ? 300 : x1 <= -600 ? 250 : 200;
    K.region(`bh_${i}_${j}`, hz([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), { ...hall, top });
  }
  // shallow alcoves along the south wall
  K.region('bh_alc1', hz([[-1248, 2043], [-1150, 2043], [-1150, 2072], [-1248, 2072]]), { ...hall, top: 300 });
  K.region('bh_alc2', hz([[-1150, 2043], [-1032, 2043], [-1032, 2072], [-1150, 2072]]), { ...hall, top: 300 });
  K.region('bh_alc3', hz([[-876, 2043], [-742, 2043], [-742, 2072], [-876, 2072]]), { ...hall, top: 250 });
}
