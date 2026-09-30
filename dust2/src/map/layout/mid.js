// Middle: top-mid courtyard, the mid lane (down to lower mid), catwalk (raised walkway on the
// east of mid, turning east to short), short stairs, lower tunnels + tunnel stairs, mid doors
// and CT mid.
import { zx, zy, zc } from './util.js';

export function build(K) {
  const ochre = { h: 48, mat: 'plaster_wall#ochre' };
  const teal = { h: 40, mat: 'plaster_wall#teal' };

  // ---- top mid courtyard ---------------------------------------------------------------------
  K.region('tmid_court', zc([
    [-693, 190], [-520, 190], [-378, 190], [-378, 227], [-318, 287], [52, 287], [113, 287], [469, 287],
    [469, 300], [479, 312], [479, 494], [-68, 494], [-124, 558], [-648, 558], [-648, 527], [-752, 527],
    [-754, 510], [-706, 257], [-701, 222],
  ], 0), { mat: 'concrete_floor', top: 340, tops: { 3: 260, 4: 260, 5: 260, 11: 360, 12: 360 }, paint: ochre, cornice: {} });
  K.region('mid_top', zc([[-648, 558], [-124, 558], [-124, 737], [-250, 737], [-275, 737], [-521, 737], [-648, 737]], 0),
    { mat: 'concrete_floor', top: 330, tops: { 3: 32 }, paint: ochre, cornice: {} });

  // ---- mid lane (east side is the low wall to catwalk, top z 32) ------------------------------
  K.region('mid_a', zc([[-521, 737], [-275, 737], [-275, 760], [-521, 760]], 0),
    { mat: 'sand_floor', top: 330, tops: { e: 32 }, paint: ochre, cornice: {} });
  K.region('mid_b', zy([[-521, 760], [-275, 760], [-275, 1260], [-518, 1260], [-518, 1136], [-554, 1136], [-554, 872], [-521, 872]], 760, 0, 1260, -125),
    { mat: 'sand_floor', top: 320, tops: { 1: 32 }, paint: ochre, cornice: {} });
  K.region('mid_c', zc([[-518, 1260], [-275, 1260], [-275, 1546], [-316, 1546], [-518, 1546]], -125),
    { mat: 'sand_floor', top: 230, tops: { 1: 32, 2: 240 }, paint: teal, cornice: {} });
  K.region('mid_d', zc([[-518, 1546], [-316, 1546], [-316, 1646], [-518, 1646]], -128),
    { mat: 'sand_floor', top: 230, paint: teal, cornice: {} });
  K.region('ctmid', zc([[-602, 1646], [-518, 1646], [-316, 1646], [-316, 1718], [-254, 1718], [-254, 1806], [-316, 1806], [-316, 2072], [-602, 2072]], -128),
    { mat: 'concrete_floor', top: 210, paint: teal, cornice: {} });

  // ---- catwalk + short ------------------------------------------------------------------------
  K.region('cat', zc([
    [-250, 737], [-124, 737], [-124, 1265], [-62, 1328], [287, 1328], [287, 1342], [513, 1342], [513, 1760],
    [395, 1760], [395, 1655], [239, 1655], [239, 1550], [74, 1550], [74, 1610], [-145, 1610], [-145, 1546], [-250, 1546],
  ], 0), { mat: 'concrete_floor', top: 300, tops: { 16: 32, 1: 330, 2: 300, 3: 300, 4: 300 }, paint: ochre, cornice: {} });
  K.stairs('short_st', [[239, 1655], [395, 1655], [395, 1800], [239, 1800]], 0, 96, 12,
    { mat: 'stone_block', top: 360 });

  // ---- lower tunnels + tunnel stairs ------------------------------------------------------------
  const tun = { mat: 'concrete_floor', wallMat: 'plaster_wall', ceilMat: 'wood_planks', paint: { h: 36, mat: 'plaster_wall#dark' }, dark: 0.05 };
  K.region('ltun', zc([
    [-1234, 1320], [-1135, 1320], [-1014, 1320], [-1014, 1309], [-548, 1309], [-548, 1363], [-548, 1498],
    [-548, 1552], [-1190, 1552], [-1204, 1544], [-1234, 1544],
  ], -112), { ...tun, ceil: 16, beams: { dir: 'y', step: 110 } });
  K.region('ltun_door', zc([[-548, 1363], [-518, 1363], [-518, 1498], [-548, 1498]], -116),
    { ...tun, arch: { spring: -36, crown: 14 }, ceilTop: 230, dark: 0 });
  K.region('tst_exit', zc([[-1135, 1230], [-1014, 1230], [-1014, 1320], [-1135, 1320]], -104),
    { ...tun, ceil: 182 });
  K.stairs('tst_a', [[-1293, 1020], [-1293, 1180], [-1175, 1180], [-1175, 1020]], 32, -8, 5,
    { ...tun, mat: 'stone_block', ceil: 182 });
  // landing over the stairwell (the stairs wind down below it); inner edge follows the stair core
  const cx = -1175, cy = 1230, arc = [];
  for (let k = 0; k <= 12; k++) { const a = (270 + 90 * k / 12) * Math.PI / 180; arc.push([cx + 40 * Math.cos(a), cy + 50 * Math.sin(a)]); }
  K.region('tst_land', zc([[-1293, 1180], ...arc, [-1135, 1298], [-1293, 1298]], 32), { ...tun, mat: 'concrete_floor', ceil: 182 });
  // stone balustrade where the landing overlooks the winding stairs
  for (let k = 0; k < arc.length - 1; k++) K.slab(arc[k], arc[k + 1], 32, 70, 8, 'stone_block', { side: 'left' });
  K.slab([-1135, 1230], [-1135, 1298], 32, 70, 8, 'stone_block', { side: 'left' });
  K.curvedStairs('tst_b', [-1175, 1230], [40, 50], [161, 210], 270, 360, 0, -104, 13,
    { ...tun, mat: 'stone_block', ceil: 182 });
}
