// A side + CT: CT spawn, the underpass below short, short (the bridge up from the short
// stairs), A site with its retaining walls, the steps to the back platform, the A ramp, the
// ramp from CT spawn up to long ("under A"), long A, pit, side pit, the long hall, long doors
// and outside long.
import { zx, zy, zc } from './util.js';

export function build(K) {
  const ochre = { h: 48, mat: 'plaster_wall#ochre' };
  const teal = { h: 40, mat: 'plaster_wall#teal' };
  const white = { h: 36, mat: 'plaster_wall#dark' };

  // ---- CT spawn and the underpass below short ------------------------------------------------
  K.region('ct_spawn', zc([
    [-316, 1977], [-7, 1977], [96, 2040], [234, 2041], [234, 2087], [250, 2087], [250, 2574], [37, 2574],
    [37, 2399], [-43, 2318], [-316, 2318],
  ], -126), { mat: 'concrete_floor', top: 210, tops: { 6: 230, 7: 200, 8: 200, 9: 200 }, paint: teal, cornice: {} });
  K.region('ct_under', zc([[275, 2041], [489, 2041], [489, 2556], [250, 2556], [250, 2087], [275, 2087]], -122),
    { mat: 'concrete_floor', ceil: 36, ceilTop: 96, roof: false, ceilMat: 'plaster_wall', headerMat: 'stone_wall', paint: white });
  K.region('ct_under_mouth', zc([[489, 2042], [513, 2042], [513, 2404], [489, 2404]], -122),
    { mat: 'concrete_floor', arch: { spring: -40, crown: 36 }, ceilTop: 96, roof: false, wallMat: 'stone_wall', paint: white });

  // ---- short: bridge from the short stairs over the underpass to A --------------------------------
  K.region('short_br', zc([
    [239, 1800], [395, 1800], [395, 1760], [513, 1760], [513, 2042], [513, 2404], [513, 2420], [250, 2420], [250, 2087], [275, 2087], [275, 1922], [239, 1922],
  ], 96), { mat: 'concrete_floor', bottom: 36, top: 380, tops: { 5: 128 }, paint: ochre, cornice: {} });
  K.slab([250, 2087], [250, 2574], 96, 132, 12, 'plaster_wall', { side: 'left' });
  K.slab([513, 2404], [513, 2042], 96, 124, 14, 'plaster_wall', { side: 'left' });

  // ---- A site plateau (z 96) with its low retaining walls ---------------------------------------
  K.region('a_main', zc([
    [250, 2420], [513, 2420], [1040, 2420], [1040, 2330], [1245, 2330], [1245, 2780], [1001, 2780], [1001, 2794],
    [238, 2794], [238, 2718], [274, 2718], [274, 2574], [250, 2574],
  ], 96), { mat: 'concrete_floor', bottom: 36, top: 400, tops: { 1: 128, 2: 128, 3: 128, 4: 128 }, paint: ochre, cornice: {} });
  K.stairs('a_steps', [[1001, 2780], [1245, 2780], [1245, 2830], [1001, 2830]], 96, 120, 3, { mat: 'stone_block', tops: { e: 128, w: 400 } });
  K.region('a_north', zc([[1001, 2830], [1245, 2830], [1245, 2790], [1265, 2790], [1598, 2790], [1598, 3089], [1001, 3089]], 120),
    { mat: 'concrete_floor', top: 420, tops: { 1: 128, 2: 128 }, paint: ochre, cornice: {} });
  K.region('aramp', zy([[1265, 2297], [1629, 2297], [1629, 2790], [1265, 2790]], 2297, -2, 2790, 112),
    { base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, mat: 'concrete_floor', top: 420, tops: { w: 128 }, paint: teal, cornice: {} });

  // ---- under A: ramp from the underpass up to the top of long ------------------------------------
  K.region('undera_m', zx([[513, 2042], [882, 2042], [882, 2006], [960, 2006], [960, 2404], [513, 2404]], 540, -122, 960, 0),
    { mat: 'stone_block', top: 300, tops: { 4: 128 }, paint: white, cornice: {} });
  K.region('undera_e', zc([[960, 2006], [1228, 2006], [1228, 2314], [1024, 2314], [1024, 2404], [960, 2404]], 0),
    { mat: 'concrete_floor', top: 300, tops: { 2: 128, 3: 128, 4: 128 }, paint: teal, cornice: {} });

  // ---- long A ---------------------------------------------------------------------------------
  K.region('longa_n', zc([
    [1228, 1833], [1806, 1833], [1806, 2069], [1800, 2099], [1800, 2145], [1793, 2156], [1793, 2262], [1785, 2297],
    [1629, 2297], [1265, 2297], [1265, 2314], [1228, 2314],
  ], -2), { base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, mat: 'concrete_floor', top: 330, tops: { 10: 128, 11: 128 }, paint: teal, cornice: {} });
  K.region('longa_m', zc([
    [1228, 1230], [1598, 1230], [1598, 1397], [1612, 1412], [1612, 1668], [1673, 1784], [1729, 1784], [1729, 1833],
    [1228, 1833], [1228, 1806], [1210, 1801], [1210, 1537], [1228, 1532],
  ], -4), { base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, mat: 'concrete_floor', top: 330, paint: teal, cornice: {} });
  K.region('longhall', zc([
    [482, 784], [883, 784], [936, 731], [936, 810], [1245, 810], [1262, 810], [1588, 810], [1600, 810],
    [1790, 810], [1790, 1042], [1754, 1047], [1719, 1047], [1708, 1054], [1622, 1054], [1598, 1060], [1598, 1230],
    [1228, 1230], [718, 1230], [701, 1224], [482, 1185],
  ], 0), { mat: 'concrete_floor', top: 320, tops: { 4: 32, 6: 80 }, paint: ochre, cornice: {} });

  // ---- pit, side pit, the raised strip beside the pit -------------------------------------------
  K.region('ld_ledge', zy([[936, 196], [1245, 196], [1245, 315], [1245, 810], [936, 810]], 196, 14, 810, 2),
    { mat: 'sand_floor', top: 300, tops: { 2: 32 }, paint: teal, cornice: {} });
  K.region('pit_floor', zy([[1262, 160], [1588, 160], [1588, 300], [1262, 300]], 160, -194, 300, -186),
    { mat: 'sand_floor', top: 300, paint: white });
  K.region('pit_ramp', zy([[1262, 300], [1588, 300], [1588, 318], [1588, 810], [1262, 810], [1262, 315]], 300, -186, 810, -4),
    { mat: 'sand_floor', top: 300, tops: { 2: 80, 4: 32 }, paint: white });
  K.region('side', zc([[1600, 287], [1790, 287], [1790, 690], [1600, 690]], 56),
    { mat: 'concrete_floor', top: 360, tops: { w: 80 }, paint: teal, cornice: {} });
  K.stairs('side_st', [[1600, 690], [1790, 690], [1790, 810], [1600, 810]], 56, 0, 7, { mat: 'stone_block', tops: { w: 80, e: 360 } });

  // ---- long doors ---------------------------------------------------------------------------------
  K.region('ld_corr', zc([[507, 314], [550, 314], [722, 314], [772, 314], [772, 746], [723, 746], [550, 746], [507, 746]], 0),
    { mat: 'concrete_floor', top: 300, paint: ochre, cornice: {} });
  K.region('ld_door1', zc([[550, 272], [722, 272], [722, 314], [550, 314]], 0),
    { mat: 'concrete_floor', ceil: 136, ceilMat: 'wood_planks', headerMat: 'plaster_wall' });
  K.region('ld_door2', zc([[550, 746], [723, 746], [723, 784], [550, 784]], 0),
    { mat: 'concrete_floor', ceil: 136, ceilMat: 'wood_planks', headerMat: 'plaster_wall' });

  // ---- outside long ---------------------------------------------------------------------------------
  K.region('olong', zc([
    [82, -400], [388, -400], [388, -382], [529, -382], [529, -417], [776, -417], [776, 272], [722, 272], [550, 272],
    [469, 272], [469, 287], [113, 287], [113, -233], [82, -238],
  ], 0), { base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, mat: 'concrete_floor', top: 330, tops: { 11: 260, 12: 260, 13: 260 }, paint: teal, cornice: {} });
}
