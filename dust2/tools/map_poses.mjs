// Regenerates tools/poses.json from Source-space pose specs: the floor under each spot is found
// with a ray against the map collision so every eye sits exactly 64u above the floor.
//   node --import ./tools/three-resolve.mjs tools/map_poses.mjs [--check]
import fs from 'node:fs';
import * as THREE from 'three';
import { buildDust2 } from '../src/map/dust2.js';

// name: [source x, source y, yaw, pitch, desc, (optional absolute eye z)]
const SPECS = {
  overview: [-150, -1900, 90, 48, 'High oblique over T spawn looking north across the whole map', 2364],
  t_spawn: [-742, -860, 0, 2, 'T spawn looking east down the road toward outside long (same spot as the CS:GO reference frame)'],
  outside_long: [330, -300, 62, 1, 'Outside long looking north-east up the street to the long doors'],
  long_doors: [636, 130, 90, 0, 'In front of long doors looking north through both door frames'],
  long_a: [1420, 880, 90, 0, 'Long corner looking north up Long A toward the ramp and A'],
  pit: [1400, 960, 280, 14, 'Bottom of long looking south down into the pit, side pit on the left'],
  a_site_from_long: [1480, 2160, 128, 2, 'Top of long (A car / cross) looking NW up the ramp onto A site'],
  a_site_from_ct: [420, 2560, 0, 4, 'A short / top of short looking east across A site'],
  goose: [1215, 2755, 225, 6, 'Goose corner looking back SW across the site to short and CT'],
  catwalk: [-430, 1180, 38, -6, 'Lower mid looking NE up at catwalk and xbox, short beyond'],
  mid_from_t: [-420, 420, 90, 1, 'Top mid looking north down mid to the mid doors'],
  xbox: [-440, 1260, 55, 2, 'Lower mid looking at xbox and the catwalk ledge'],
  mid_doors: [-460, 1960, 270, 2, 'CT mid looking south at the mid doors gap'],
  lower_tunnels: [-1120, 1440, 0, 2, 'Lower tunnels looking east to the mid exit'],
  upper_tunnels: [-1660, 1080, 133, 2, 'Upper tunnels looking NW toward the exit to B'],
  b_site: [-1985, 1880, 55, 4, 'B tunnel exit looking NE across B site'],
  b_from_window: [-1372, 2665, 200, 12, 'B window ledge looking into B site'],
  b_doors: [-1000, 2300, 180, 2, 'Mid-to-B hall looking west at B doors'],
  ct_spawn: [160, 2300, 205, 2, 'CT spawn looking SW toward CT mid'],
};

const map = await buildDust2({ textures: null, props: null, decor: false });
const out = {};
let bad = 0;
for (const [name, [x, y, yaw, pitch, desc, zAbs]] of Object.entries(SPECS)) {
  let eyeZ = zAbs;
  if (eyeZ == null) {
    // lowest open floor at this spot (rays start in free space so tunnel ceilings are skipped)
    let floor = Infinity;
    for (let h = -250; h <= 700; h += 20) {
      const tr = map.collision.rayTrace(new THREE.Vector3(x, h, -y), new THREE.Vector3(x, h - 60, -y), 1);
      if (!tr.startSolid && tr.fraction < 1 && tr.normal.y > 0.7) floor = Math.min(floor, tr.endpos.y);
    }
    if (!isFinite(floor)) { console.log(`no floor under ${name}`); bad++; continue; }
    eyeZ = Math.round((floor + 64) * 10) / 10;
  }
  out[name] = { eye: [x, eyeZ, -y], pitch, yaw, desc };
}
if (!process.argv.includes('--check')) fs.writeFileSync(new URL('./poses.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${Object.keys(out).length} poses${bad ? `, ${bad} without floor` : ''}`);
