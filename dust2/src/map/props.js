// Procedural Dust II props — public factory API (owner: props agent).
//
// Every factory returns { object: THREE.Object3D, colliders } in the prop's LOCAL space:
// Three axes (Y-up), Source units (1u = 1 inch), sitting on y = 0, centred on x/z unless the
// factory says otherwise (wall-mounted props: origin on the wall face, prop extends to +Z).
// Colliders: Array<{min:[x,y,z], max:[x,y,z]} | {prism:[{x,z}...], y0, y1}>, each may carry
// an extra `surface` key (CONTRACT §4) and flags (`grate`, `ladder`, `noShot`).
//
// Geometry is cached per (factory, args): calling crate(64, 1) twice returns two Groups
// sharing the same BufferGeometries — do not dispose/mutate them. Use instanced() or
// crateStack() for repeated props to keep draw calls down.
//
// Local frames ("floor" = centred on x/z, base on y = 0; "opening" = hole x ∈ [-w/2, w/2],
// y ∈ [0, h], wall centre plane z = 0; "wall" = origin on the wall face, prop sticks out +z):
//   crate(size=64, variant=0)            floor   size number | [sx, sy(height), sz]; variants 0..3
//   crateStack(layout|'a_site'|'steps'|'tower'|'small')  floor, merged (≤3 draws)
//   tarpCrate(size=64, color='teal', variant=0)   floor   crate + roped canvas over the top
//   slatCrate(w=56, h=96, d=56)          floor   slatted timber crate / tower
//   barrel(variant=0..5)                 floor   Ø22.5 × 34.5 drum: galv, blue-grey, 2-tone, blue, red, olive
//   doubleDoor(w=112, h=108, open=0|[l,r], {depth=16, gap=1.4, paint})   opening, frame+leaves
//   bigDoorMetal(w=128, h=128, open=0, {depth=24, paint='teal', arch, sheet})   opening
//   shopShutter(w=96, h=100, open=0, color='grey')   wall (opening bottom-centre), roll box above h
//   windowShutters(w=40, h=60, open=1, color='green')   wall (window bottom-centre)
//   windowGrate(w=40, h=56)              wall (window bottom-centre), collider flagged grate
//   lamp()                               wall, origin at the bracket arm root; userData.lightPos
//   awning(w=96, d=40, {color, style:'stripe'|'solid', drop})   wall, origin on the attach line, hangs below y=0
//   electricBox(color='grey') / meterBox() / acUnit()   wall, body bottom at y = 0
//   satelliteDish({roof})                wall bracket (default) or roof tripod (floor)
//   hangingRope(len=48)                  wall, peg at y = 0, rope hangs to -len
//   ladder(h=120)                        floor against a wall at z = 0 (collider flagged ladder)
//   utilityPole(h=300)                   floor; userData.wireAttach = insulator tops (local)
//   palm(h=260, variant) / plant(0 agave pot | 1 dry shrub | 2 potted palm) / urn(0..2)   floor
//   rubble(radius=32)                    floor, walkable (no colliders)
//   car(variant 0 white | 1 blue | 2 sand | 3 red)   floor, 166 × 64 × 51, front toward +x
//   tire(standing=false) / tyreStack(n=4) / pallet(w=48, d=40) / bench(len=56) / stoneBench(len=48)
//   sandbags(len=96, rows=3) (along x) / plankFence(len=128, h=40) (along x, planks on +z)
//   stoneBlocks(w=48, d=40, layers=5) / metalCrate([L, H, D], variant 0..3) / jerrycan(variant 0..3)
//   woodenBeam(len=96, size=8) (along x) / archKeystone(w=14, h=16, depth=18)
//   wireSpan(a, b, sag=24, r=0.35) / wireSpans([{a,b,sag}]) / pipe(a, b, r=2)   PARENT space
import * as THREE from 'three';
import { mat, transformColliders, prismPlanes, DEG, merge } from './props/core.js';
import { material } from './props/tex.js';
import { crateProp, CRATE_VARIANTS } from './props/crate.js';
import * as P from './props/catalog.js';

const CACHE = new Map();
const BUILDERS = {
  crate: (size = 64, variant = 0, opts) => crateProp(size, variant, opts),
  ...P.BUILDERS,
};

function built(name, args) {
  const key = name + JSON.stringify(args, (k, v) => (v && v.isVector3 ? [v.x, v.y, v.z] : v));
  let b = CACHE.get(key);
  if (!b) {
    const fn = BUILDERS[name];
    if (!fn) throw new Error(`props: unknown prop '${name}'`);
    b = fn(...args);
    CACHE.set(key, b);
  }
  return b;
}

function toObject(name, b) {
  const group = new THREE.Group();
  group.name = 'prop:' + name;
  for (const [k, g] of b.parts) {
    const mesh = new THREE.Mesh(g, material(k));
    mesh.name = name + ':' + k;
    mesh.castShadow = k !== 'label' && k !== 'bulb';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData = { prop: name, ...(b.userData || {}) };
  return { object: group, colliders: b.colliders.map((c) => JSON.parse(JSON.stringify(c))) };
}

const make = (name) => (...args) => toObject(name, built(name, args));

// ---- factories -------------------------------------------------------------------------------
/** Wooden crate. size: 32/48/64/96/128 (any number, or [sx, sy, sz]). variant 0..3. */
export const crate = make('crate');
/** Weathered wooden double doors in a timber frame. See catalog.js doubleDoor for layout. */
export const doubleDoor = make('doubleDoor');
export const barrel = make('barrel');
export const lamp = make('lamp');
export const awning = make('awning');
export const tarp = make('tarp');
export const tarpCrate = make('tarpCrate');
export const rubble = make('rubble');
export const plant = make('plant');
export const electricBox = make('electricBox');
export const windowGrate = make('windowGrate');
export const palm = make('palm');
export const car = make('car');
export const ladder = make('ladder');
export const bench = make('bench');
export const sandbags = make('sandbags');
export const stoneBench = make('stoneBench');
export const woodenBeam = make('woodenBeam');
export const hangingRope = make('hangingRope');
export const jerrycan = make('jerrycan');
export const pallet = make('pallet');
export const tire = make('tire');
export const tyreStack = make('tyreStack');
export const metalCrate = make('metalCrate');
export const bigDoorMetal = make('bigDoorMetal');
export const archKeystone = make('archKeystone');
export const satelliteDish = make('satelliteDish');
export const utilityPole = make('utilityPole');
export const shopShutter = make('shopShutter');
export const windowShutters = make('windowShutters');
export const acUnit = make('acUnit');
export const urn = make('urn');
export const slatCrate = make('slatCrate');
export const plankFence = make('plankFence');
export const stoneBlocks = make('stoneBlocks');
export const meterBox = make('meterBox');

/** Sagging cable between a and b (Vector3 or [x,y,z], PARENT space). Not cached. */
export function wireSpan(a, b, sag = 24, radius = 0.35) { return toObject('wireSpan', P.BUILDERS.wireSpan(a, b, sag, radius)); }
/**
 * Many sagging cables merged into ONE mesh (one draw call). spans: [{a, b, sag, radius}] in
 * PARENT space (a/b = Vector3 or [x,y,z]).
 */
export function wireSpans(spans) {
  const list = spans.map((s) => P.BUILDERS.wireSpan(s.a, s.b, s.sag ?? 24, s.radius ?? 0.35).parts[0][1]);
  const g = merge(list); g.computeBoundingSphere(); g.computeBoundingBox();
  return toObject('wireSpans', { parts: [['plain:0.55', g]], colliders: [] });
}
/** Pipe from a to b (PARENT space) with collars/flanges. Not cached. */
export function pipe(a, b, r = 2) { return toObject('pipe', P.BUILDERS.pipe(a, b, r)); }

// ---- crate stacks --------------------------------------------------------------------------------
export const CRATE_STACKS = {
  // two 64s side by side with a 32 and a 48 on top (classic A-site pile)
  a_site: [{ x: -32, y: 0, z: 0, size: 64, variant: 0 }, { x: 34, y: 0, z: 2, size: 64, variant: 1, rot: 90 },
    { x: -30, y: 64, z: 4, size: 48, variant: 0, rot: 8 }, { x: 36, y: 64, z: -8, size: 32, variant: 3, rot: -12 }],
  // stepped pile you can climb (A ramp)
  steps: [{ x: 0, y: 0, z: 0, size: 64, variant: 1 }, { x: 0, y: 64, z: 0, size: 64, variant: 0, rot: 90 },
    { x: 60, y: 0, z: -6, size: 48, variant: 2 }, { x: 108, y: 0, z: -14, size: 32, variant: 3, rot: 15 }],
  tower: [{ x: 0, y: 0, z: 0, size: 64, variant: 0 }, { x: 0, y: 64, z: 0, size: 64, variant: 1, rot: 90 }, { x: 0, y: 128, z: 0, size: 48, variant: 0, rot: 5 }],
  small: [{ x: 0, y: 0, z: 0, size: 48, variant: 2 }, { x: 44, y: 0, z: 6, size: 32, variant: 3, rot: 20 }, { x: 4, y: 48, z: 2, size: 32, variant: 0, rot: -7 }],
};

/**
 * Merge several crates into one prop (≤ 3 draw calls). layout: array of
 * {x, y, z, size, variant, rot /* yaw degrees *\/} or a CRATE_STACKS preset name.
 */
export function crateStack(layout = 'a_site') {
  const L = typeof layout === 'string' ? CRATE_STACKS[layout] || CRATE_STACKS.a_site : layout;
  const buckets = new Map(), colliders = [];
  for (const e of L) {
    const b = built('crate', [e.size ?? 64, e.variant ?? 0]);
    const m = toMatrix(e);
    for (const [k, g] of b.parts) {
      const c = g.clone().applyMatrix4(m);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    }
    colliders.push(...transformColliders(b.colliders, m));
  }
  const parts = [...buckets].map(([k, list]) => { const g = merge(list); g.computeBoundingSphere(); g.computeBoundingBox(); return [k, g]; });
  return toObject('crateStack', { parts, colliders });
}

// ---- instancing ----------------------------------------------------------------------------------
/** Matrix from a transform: Matrix4 | {matrix} | {x,y,z | position, rot (yaw deg) | rotY (rad), scale}. */
export function toMatrix(t) {
  if (t.isMatrix4) return t;
  if (t.matrix) return t.matrix;
  const p = t.position ? (Array.isArray(t.position) ? t.position : [t.position.x, t.position.y, t.position.z]) : [t.x || 0, t.y || 0, t.z || 0];
  const yaw = t.rotY ?? (t.rot ?? t.yaw ?? 0) * DEG;
  return mat(p[0], p[1], p[2], 0, yaw, 0, t.scale ?? 1);
}

/**
 * InstancedMesh group for many copies of one prop. transforms: see toMatrix(); an entry may
 * override factory args with `args: [...]` (or `size` / `variant` for crates & barrels).
 * Returns an Object3D; its userData.colliders holds every instance's colliders in parent space.
 */
export function instanced(name, transforms, ...args) {
  const root = new THREE.Group();
  root.name = 'instanced:' + name;
  const groups = new Map();
  for (const t of transforms) {
    let a = t.args;
    if (!a && (t.size !== undefined || t.variant !== undefined)) {
      a = name === 'barrel' ? [t.variant ?? args[0] ?? 0] : [t.size ?? args[0] ?? 64, t.variant ?? args[1] ?? 0, ...args.slice(2)];
    }
    a = a || args;
    const key = JSON.stringify(a);
    if (!groups.has(key)) groups.set(key, { a, list: [] });
    groups.get(key).list.push(toMatrix(t));
  }
  const colliders = [];
  for (const { a, list } of groups.values()) {
    const b = built(name, a);
    for (const [k, g] of b.parts) {
      const im = new THREE.InstancedMesh(g, material(k), list.length);
      im.name = `${name}:${k}`;
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = k !== 'label' && k !== 'bulb';
      im.receiveShadow = true;
      im.computeBoundingSphere();
      im.computeBoundingBox?.();
      root.add(im);
    }
    for (const m of list) colliders.push(...transformColliders(b.colliders, m));
  }
  root.userData = { prop: name, colliders };
  return root;
}

// ---- collider helpers for the map ----------------------------------------------------------------
export { transformColliders };
/**
 * Add a prop's colliders to a CollisionWorld. matrix = the prop object's world matrix
 * (object.updateMatrixWorld() first) or null if colliders are already in world space.
 */
export function addColliders(collision, colliders, matrix = null, surface = 'default', flags) {
  const list = matrix ? transformColliders(colliders, matrix) : colliders;
  const ids = [];
  for (const c of list) {
    const s = c.surface || surface;
    const f = flags ?? (c.ladder ? 16 : c.grate ? 4 : 1);
    if (c.min) ids.push(collision.addBox(new THREE.Vector3(...c.min), new THREE.Vector3(...c.max), s, f));
    else ids.push(collision.addBrush(prismPlanes(c), s, f));
  }
  return ids;
}

export const PROP_LIST = Object.freeze([
  'crate', 'crateStack', 'barrel', 'doubleDoor', 'lamp', 'wireSpan', 'wireSpans', 'awning', 'tarp', 'tarpCrate', 'rubble', 'plant',
  'electricBox', 'meterBox', 'pipe', 'windowGrate', 'palm', 'car', 'ladder', 'bench', 'sandbags', 'stoneBench',
  'woodenBeam', 'hangingRope', 'jerrycan', 'pallet', 'tire', 'tyreStack', 'metalCrate', 'bigDoorMetal',
  'archKeystone', 'satelliteDish', 'utilityPole', 'shopShutter', 'windowShutters', 'acUnit', 'urn', 'slatCrate',
  'plankFence', 'stoneBlocks',
]);
export { CRATE_VARIANTS };
/** Materials used by props (for renderer setup such as CSM.setupMaterial). */
export function propMaterials() { return [...new Set([...CACHE.values()].flatMap((b) => b.parts.map(([k]) => material(k))))]; }
