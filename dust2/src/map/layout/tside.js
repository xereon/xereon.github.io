// T side: T spawn plateau, T ramp down to outside tunnels, the road down to outside long,
// the suicide alley below the T-spawn ledge and the strip up to top mid.
import { rect, zx, zc } from './util.js';

export function build(K) {
  const ochre = { h: 44, mat: 'plaster_wall#ochre' };
  const teal = { h: 40, mat: 'plaster_wall#teal' };

  // ---- T spawn plateau (z 128) -----------------------------------------------------------
  K.region('tspawn', [
    [-2237, -1049], [-1815, -1049], [-1815, -1082], [-1021, -1082], [-1014, -1067], [-520, -1067],
    [-520, -620], [-950, -620], [-950, -142], [-1161, -142], [-1161, -239], [-1333, -239],
    [-1396, -174], [-1396, -144], [-1769, -144], [-1769, -650], [-2088, -650], [-2088, -485], [-2237, -627],
  ], {
    z: 128, mat: 'concrete_floor', base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, top: 420, tops: { 6: 372, 7: 360, 8: 350, 9: 340, 10: 340, 11: 352, 12: 352, 13: 160, 14: 160, 15: 160 },
    paint: ochre, cornice: {},
  });
  // T ramp: wide steps down to outside tunnels, hemmed by the L wall on the east
  K.stairs('tramp', [[-2088, -650], [-1792, -650], [-1792, -125], [-2088, -125]], 128, 6, 18,
    { mat: 'stone_block', tops: { e: 160, w: 400 }, wallMats: { w: 'plaster_wall' } });

  // ---- the road: slopes east from the plateau down to outside long ---------------------------
  K.region('road_slope', zx([[-520, -1067], [-337, -1067], [-337, -1180], [30, -1180], [30, -620], [-520, -620]], -520, 124, 30, 0),
    { base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, mat: 'concrete_floor', top: 380, tops: { 1: 330, 2: 300, 3: 300 }, paint: teal, cornice: {} });
  K.region('road_flat', zc([[30, -1180], [194, -1180], [194, -1015], [463, -1015], [463, -620], [388, -620], [30, -620]], 0),
    { base: { h: 6, out: 10, mat: 'concrete_floor', alt: { len: 56, mats: ['plaster_wall#red', 'plaster_wall#white'] } }, mat: 'concrete_floor', top: 300, paint: teal, cornice: {} });
  // wall along the suicide ledge: flush with the plateau at its west end (the drop Ts take into
  // the alley), rising above the sloping road further east as a parapet
  const zr = (x) => 124 * (30 - x) / 550;
  for (let i = 0; i < 5; i++) {
    const x0 = -390 + i * 58, x1 = x0 + 58;
    const t0 = 112 - (x0 + 390) * 0.17, t1 = 112 - (x1 + 390) * 0.17;
    K.slab([x0, -620], [x1, -620], Math.min(zr(x0), zr(x1)) - 2, (t0 + t1) / 2, 14, 'stone_block', { side: 'right' });
  }
  // ---- suicide alley and T-mid strip (z 0) -------------------------------------------------
  K.region('tsp_alley', zc([[-520, -620], [388, -620], [388, -400], [82, -400], [25, -458], [-60, -458], [-60, -428], [-520, -428]], 0),
    { mat: 'concrete_floor', top: 300, tops: { 3: 260, 4: 260, 5: 260 }, paint: ochre, cornice: {} });
  K.region('tmid_strip', zc([[-520, -428], [-305, -428], [-361, -367], [-361, -176], [-378, -172], [-378, 190], [-520, 190]], 0),
    { mat: 'concrete_floor', top: 320, tops: { 1: 260, 2: 260, 3: 260, 4: 260, 5: 280 }, paint: ochre, cornice: {} });

  // ---- outside tunnels ---------------------------------------------------------------------
  K.region('otun_low', zc([
    [-2088, -125], [-1396, -125], [-1396, -32], [-1339, 32], [-1245, 32], [-1237, 43], [-1237, 168],
    [-1290, 517], [-1290, 545], [-1580, 545], [-1580, 530], [-1830, 530], [-1830, 545], [-2072, 545],
    [-2072, 121], [-2057, 114], [-2057, -86], [-2088, -100],
  ], 6), { mat: 'sand_floor', top: 360, tops: { 0: 160, 8: 64, 12: 64 }, paint: teal, cornice: {} });
  K.stairs('otun_st', [[-1830, 530], [-1580, 530], [-1580, 578], [-1830, 578]], 6, 32, 3,
    { mat: 'stone_block', tops: { e: 64, w: 64 } });
  K.region('otun_up', zc([
    [-2072, 560], [-1830, 560], [-1830, 578], [-1580, 578], [-1580, 560], [-1290, 560], [-1290, 628],
    [-1391, 628], [-1391, 716], [-1588, 716], [-1736, 716], [-1932, 716], [-1932, 626], [-2072, 626],
  ], 32), { mat: 'sand_floor', top: 380, tops: { 0: 64, 4: 64 }, paint: teal, cornice: {} });
}
