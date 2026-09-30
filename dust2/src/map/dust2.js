// de_dust2 layout, rebuilt from the public radar/overview in Source coordinates. See
// CONTRACT.md §6. Geometry + collision come from the region kit (kit.js); each area lives in
// layout/*.js. Everything here is authored in SOURCE units (x east, y north, z up) and
// converted to Three space (x, z, -y) at emission time.
import * as THREE from 'three';
import { Kit } from './kit.js';
import { build as buildTSide } from './layout/tside.js';
import { build as buildMid } from './layout/mid.js';
import { build as buildBSide } from './layout/bside.js';
import { build as buildASide } from './layout/aside.js';
import { build as buildProps } from './layout/props.js';
import { decorate, decorateRoofs } from './layout/decor.js';

const S = (x, y, z) => new THREE.Vector3(x, z, -y);
/** Zone from a Source-space box. */
const zone = (name, x0, y0, z0, x1, y1, z1) => ({
  name,
  min: new THREE.Vector3(Math.min(x0, x1), Math.min(z0, z1), -Math.max(y0, y1)),
  max: new THREE.Vector3(Math.max(x0, x1), Math.max(z0, z1), -Math.min(y0, y1)),
});

export const CALLOUTS = [
  ['tspawn', -1400, -1082, 100, -520, -144, 260],
  ['t_ramp', -2088, -650, 0, -1769, -125, 260],
  ['suicide', -520, -620, -20, 0, -428, 160],
  ['top_mid', -754, 190, -20, 479, 737, 200],
  ['outside_long', 82, -417, -20, 776, 287, 200],
  ['long_doors', 507, 272, -20, 772, 784, 200],
  ['long_corner', 482, 784, -20, 1245, 1230, 200],
  ['blue', 900, 1080, -20, 1228, 1230, 200],
  ['pit', 1262, 160, -220, 1588, 810, 100],
  ['side_pit', 1600, 287, 0, 1790, 860, 200],
  ['long', 1210, 1060, -40, 1806, 2297, 200],
  ['a_car', 1500, 1850, -40, 1806, 2150, 200],
  ['a_ramp', 1265, 2297, -20, 1629, 2790, 250],
  ['a_site', 1001, 2330, 80, 1245, 2780, 300],
  ['goose', 1150, 2650, 80, 1245, 2780, 300],
  ['a_plat', 1001, 2790, 100, 1598, 3089, 320],
  ['short', 239, 1655, -20, 1001, 2794, 300],
  ['catwalk', -250, 737, -20, 513, 1760, 180],
  ['xbox', -340, 1380, -140, -275, 1480, 60],
  ['mid', -554, 737, -140, -275, 1546, 200],
  ['mid_doors', -522, 1546, -140, -316, 1700, 100],
  ['ct_mid', -602, 1646, -140, -316, 2072, 100],
  ['ct_spawn', -316, 1977, -140, 250, 2574, 100],
  ['under_a', 513, 2006, -140, 1228, 2404, 100],
  ['lower_tunnels', -1234, 1230, -130, -518, 1552, 40],
  ['tunnel_stairs', -1293, 1020, -120, -1014, 1320, 60],
  ['upper_tunnels', -2194, 716, 0, -1293, 1789, 200],
  ['outside_tunnels', -2088, -125, -20, -1237, 716, 200],
  ['b_site', -1715, 2442, -20, -1334, 2895, 200],
  ['b_plat', -2140, 2442, 0, -1735, 3172, 220],
  ['b_tunnel_exit', -2186, 1599, -20, -1544, 2000, 200],
  ['b_window', -1455, 2586, 60, -1110, 2732, 260],
  ['b_doors', -1361, 2070, -20, -1150, 2400, 200],
  ['mid_to_b', -1150, 2072, -140, -316, 2586, 120],
];

export async function buildDust2(opts = {}) {
  let textures = opts.textures;
  if (textures === undefined) {
    try { textures = (await import('../art/textures.js')).TextureLib || null; } catch { textures = null; }
  }
  let props = opts.props;
  if (props === undefined) {
    try { props = await import('./props.js'); } catch (err) { console.warn('[map] props.js unavailable:', err.message); props = null; }
  }
  const K = new Kit({ textures, props });
  buildTSide(K);
  buildMid(K);
  buildBSide(K);
  buildASide(K);
  try { buildProps(K); } catch (err) { console.warn('[map] prop placement failed:', err); }
  if (opts.decor !== false) { K.decorators.push(decorate); K.roofDecorators.push(decorateRoofs); }
  const out = K.finish();

  const callouts = {};
  for (const [name, ...b] of CALLOUTS) callouts[name] = zone(name, ...b);
  // aliases the rest of the game may look for
  callouts.tunnels = callouts.upper_tunnels;
  callouts.lower_mid = callouts.mid;
  callouts.b_window_ct = callouts.b_window;

  // Spawns: T on the plateau facing NE toward the road, CT in the CT spawn pocket facing SW.
  const T = [], CT = [];
  for (const [x, y] of [[-620, -740], [-700, -740], [-780, -740], [-860, -740], [-620, -830], [-700, -830],
    [-780, -830], [-860, -830], [-620, -920], [-700, -920], [-780, -920], [-860, -920], [-940, -780], [-940, -880]]) {
    T.push({ pos: S(x, y, 128), yaw: 55 });
  }
  for (const [x, y] of [[90, 2140], [150, 2140], [210, 2140], [90, 2200], [150, 2200], [210, 2200],
    [90, 2260], [150, 2260], [210, 2260], [110, 2490], [150, 2330], [210, 2330], [120, 2420], [190, 2420]]) {
    CT.push({ pos: S(x, y, -126), yaw: 235 });
  }

  const map = {
    root: out.root,
    collision: out.collision,
    spawns: { T, CT },
    bombsites: {
      A: zone('A', 1001, 2330, 80, 1245, 2780, 260),
      B: zone('B', -1715, 2460, -20, -1334, 2895, 200),
    },
    buyzones: {
      T: zone('T', -1000, -1000, 100, -400, -640, 260),
      CT: zone('CT', 37, 2087, -140, 250, 2574, 60),
    },
    // high, warm sun from the south-west; blue sky fill
    sun: { dir: new THREE.Vector3(0.42, -1.0, -0.5).normalize(), color: new THREE.Color(0xfff1d6), intensity: 3.2 },
    ambient: { sky: new THREE.Color(0xa9c8ef), ground: new THREE.Color(0xb49a72), intensity: 1.0 },
    fog: { color: new THREE.Color(0xdcd0b8), density: 0.00004 },
    walkable: out.walkable,
    callouts,
    // extras (debug / tooling)
    source: true,
    regions: K.regions.map((R) => ({ id: R.id, poly: R.pts.map((p) => [p.x, p.y, p.z]), ceil: R.ceil })),
    stats: { ...K.stats, decor: K.decorStats },
  };
  return map;
}
