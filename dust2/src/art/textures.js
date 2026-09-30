// Procedural PBR material library. See CONTRACT.md §5.
//
//   await TextureLib.ready                       // bakes every material on the GPU (once)
//   TextureLib.material('plaster_wall')          // cached MeshStandardMaterial, mesh uvs
//   TextureLib.material('plaster_wall', { world: true })   // world-space box projection:
//        no uvs needed, texel density = TextureLib.info(key).world units per tile
//   opts: { repeat: n | [x,y], offset: [x,y], tint: color, world: bool | unitsPerTile,
//           scale: k (multiplies world tile size), antiTile: bool, macro: number,
//           side, alphaTest }
//   TextureLib.maps(key) -> { map, normalMap, roughnessMap, metalnessMap, aoMap }
//        roughness/metalness/ao share one ORM texture (R=AO, G=rough, B=metal, glTF style)
//   TextureLib.decal(type) -> Texture (RGBA, sRGB) with .normalMap (and .userData.normalMap)
//   TextureLib.detailNormal() -> tiling high-frequency normal map
//
// Every map comes from one height field + masks per material (src/art/gen/*.js), so
// albedo, normal, roughness and AO correlate. Baked into render targets on the game's
// WebGLRenderer (zero copy); with no renderer available it bakes on a private context
// and reads back into DataTextures; in Node it degrades to flat colours.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { Dbg } from '../core/debug.js';
import { Baker } from './gpu.js';
import { installPatch, atNoiseTexture } from './antitile.js';
import { DEFS, DECALS, DETAIL, FALLBACK } from './gen/index.js';
import { LIB, LIB_GROUND, LIB_WOOD } from './gen/lib.js';

const state = {
  renderer: null,
  promise: null,
  baked: new Map(),       // key -> { map, normalMap, orm, target }
  decals: new Map(),
  detail: null,
  mats: new Map(),        // cacheKey -> material
  byKey: new Map(),       // key -> Set(material) for late binding
  stats: { ms: 0, perKey: {}, mode: 'none' },
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function qualityScale() {
  const q = World.quality || 'high';
  return q === 'low' ? 0.5 : 1;
}

function resolveRenderer() {
  if (state.renderer) return state.renderer;
  const r = World.renderer;
  if (r?.renderer?.isWebGLRenderer) return r.renderer;
  if (r?.isWebGLRenderer) return r;
  return null;
}

function drawCanvas(def, size) {
  if (!def.canvas || typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  def.canvas(ctx, size);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;     // sampled as raw data inside the bake shader
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

// Private-context path: bake, read back to DataTextures usable on any renderer.
function readBack(r, baked, size, def) {
  const out = {};
  const names = ['map', 'normalMap', 'orm'];
  baked.target.textures.forEach((tex, i) => {
    const buf = new Uint8Array(size * size * 4);
    r.readRenderTargetPixels(baked.target, 0, 0, size, size, buf, undefined, i);
    const t = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = tex.wrapS;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = tex.anisotropy;
    t.colorSpace = i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.name = tex.name;
    t.needsUpdate = true;
    out[names[i]] = t;
  });
  baked.target.dispose();
  return out;
}

// ---- baking ------------------------------------------------------------------------------
// ready: sets up the baker and compiles every material's field shader in parallel
// (KHR_parallel_shader_compile where available). Materials, decals and the detail normal
// are baked lazily on first material()/maps()/decal()/detailNormal() request, synchronously (GPU work is queued, not waited on), so
// GPU time is only spent on surfaces the map actually uses. ?texeager bakes everything.

function initBaker() {
  if (state.baker || state.stats.mode === 'flat') return state.baker;
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') { state.stats.mode = 'flat'; return null; }
  let r = resolveRenderer();
  let own = false;
  if (!r) {
    try {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
      r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
      own = true;
    } catch (e) {
      Dbg.warn('TextureLib: no WebGL, using flat colours', e);
      state.stats.mode = 'flat';
      return null;
    }
  }
  state.stats.mode = own ? 'readback' : 'gpu';
  state.own = own;
  state.r = r;
  const baker = new Baker(r);
  baker.profile = !!state.profile;
  const q = World.quality || 'high';
  state.aniso = own ? 8 : Math.min(baker.maxAniso, q === 'low' ? 2 : q === 'medium' ? 8 : 16);
  state.qs = qualityScale();
  state.jobs = new Map();
  const add = (kind, key, def) => state.jobs.set(key, { kind, key, def });
  for (const [key, def] of Object.entries(DEFS)) add('mat', key, def);
  for (const [key, def] of Object.entries(DECALS)) add('decal', key, def);
  add('detail', 'detail_normal', DETAIL);
  for (const j of state.jobs.values()) {
    j.def.key = j.key;
    j.def.lib = LIB + LIB_GROUND + LIB_WOOD;
    j.size = Math.max(64, Math.round((j.def.size || (j.def.hero ? 1024 : 512)) * state.qs));
  }
  state.baker = baker;
  return baker;
}

function prepare(j) {
  if (!j.fieldMat) {
    j.canvasTex = drawCanvas(j.def, j.size);
    j.fieldMat = state.baker.fieldMaterial(j.def, j.size, j.canvasTex);
  }
  return j.fieldMat;
}

function bakeJob(j) {
  if (j.done) return;
  j.done = true;
  const baker = state.baker, r = state.r;
  const tk = performance.now();
  let baked = null;
  try {
    baked = baker.bake(j.def, j.size, prepare(j), j.def.aniso === false ? 1 : state.aniso);
    if (state.profile) {   // force GPU completion for honest per-material timings
      const px = new Uint8Array(4);
      r.readRenderTargetPixels(baked.target, 0, 0, 1, 1, px);
    }
    if (state.own) baked = readBack(r, baked, j.size, j.def);
  } catch (e) {
    console.error(`[TextureLib] bake failed for ${j.key}`, e);
    baked = null;
  }
  j.fieldMat?.dispose();
  j.canvasTex?.dispose();
  j.fieldMat = j.canvasTex = null;
  if (baked) {
    if (j.kind === 'mat') { state.baked.set(j.key, baked); bindLate(j.key); }
    else if (j.kind === 'decal') state.decals.set(j.key, finishDecal(baked, j.def));
    else state.detail = baked.normalMap;
  }
  state.stats.perKey[j.key] = +(performance.now() - tk).toFixed(1);
  state.stats.baked = (state.stats.baked || 0) + 1;
}

// Bake one key now if possible (no-op before ready has set up the baker, or in Node).
function ensure(key) {
  if (state.baked.has(key) || !state.baker) return;
  const j = state.jobs.get(key);
  if (j) bakeJob(j);
}

async function generateAll() {
  const t0 = performance.now();
  const baker = initBaker();
  if (!baker) return;
  const eager = World.params?.has?.('texeager') || state.eager;
  const jobs = [...state.jobs.values()];
  await baker.precompile(jobs.filter((j) => j.kind === 'mat').map(prepare));
  if (eager) for (const j of jobs) bakeJob(j);
  // anything requested before ready (e.g. material() at import time) bakes now
  for (const key of state.byKey.keys()) ensure(key);
  state.stats.ms = +(performance.now() - t0).toFixed(1);
  Dbg.log('[TextureLib] ready in', state.stats.ms, 'ms', state.stats.mode);
}

function finishDecal(baked, def) {
  const map = baked.map;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.normalMap = baked.normalMap;
  map.userData.normalMap = baked.normalMap;
  map.userData.orm = baked.orm;
  map.userData.size = def.worldSize || 4;
  return map;
}

// ---- materials ---------------------------------------------------------------------------

function normOpts(opts) {
  const o = {};
  if (opts.repeat != null) {
    const r = opts.repeat;
    o.repeat = typeof r === 'number' ? [r, r] : r.isVector2 ? [r.x, r.y] : [r[0], r[1] ?? r[0]];
  }
  if (opts.offset != null) o.offset = opts.offset.isVector2 ? [opts.offset.x, opts.offset.y] : opts.offset;
  if (opts.tint != null) o.tint = new THREE.Color(opts.tint).getHex();
  if (opts.world) o.world = opts.world === true ? 1 : opts.world;
  if (opts.scale != null) o.scale = opts.scale;
  if (opts.antiTile != null) o.antiTile = !!opts.antiTile;
  if (opts.macro != null) o.macro = opts.macro;
  if (opts.side != null) o.side = opts.side;
  if (opts.alphaTest != null) o.alphaTest = opts.alphaTest;
  return o;
}

function applyMaps(m, key) {
  const b = state.baked.get(key);
  const def = DEFS[key];
  if (!b || !def) return;
  m.map = b.map;
  m.normalMap = b.normalMap;
  m.roughnessMap = b.orm;
  m.aoMap = b.orm;
  m.metalnessMap = def.metal ? b.orm : null;
  m.color.setHex(m.userData.tint ?? 0xffffff);
  m.needsUpdate = true;
}

function bindLate(key) {
  const set = state.byKey.get(key);
  if (set) for (const m of set) applyMaps(m, key);
}

function createMaterial(key, o) {
  const def = DEFS[key];
  const Ctor = def?.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const params = {
    color: o.tint ?? (state.baked.has(key) ? 0xffffff : (FALLBACK[key] ?? 0xff00ff)),
    roughness: 1,
    metalness: def?.metal ? 1 : 0,
    aoMapIntensity: def?.aoIntensity ?? 1,
    ...(def?.mat || {}),
  };
  if (o.side != null) params.side = o.side;
  if (o.alphaTest != null) params.alphaTest = o.alphaTest;
  const m = new Ctor(params);
  m.name = `tex:${key}`;
  m.userData.textureKey = key;
  m.userData.tint = o.tint;
  if (def) {
    const world = o.world ? (o.world === 1 ? def.world : o.world) * (o.scale ?? 1) : 0;
    installPatch(m, {
      antiTile: (o.antiTile ?? !!def.antiTile) && World.quality !== 'low',   // 2 extra taps/map
      macro: o.macro != null ? [o.macro, o.macro * 0.4] : def.macro,
      macroScale: def.macroScale,
      blendDepth: def.blendDepth,
      world,
      repeat: o.repeat,
      offset: o.offset,
    });
    applyMaps(m, key);
  }
  if (def?.normalScale) m.normalScale.set(def.normalScale, def.normalScale);
  if (!state.byKey.has(key)) state.byKey.set(key, new Set());
  state.byKey.get(key).add(m);
  return m;
}

export const TextureLib = {
  /** Resolves once every material/decal is baked. Accessing it starts the bake. */
  get ready() {
    if (!state.promise) {
      state.promise = generateAll().catch((e) => {
        console.error('[TextureLib] generation failed', e);
      });
    }
    return state.promise;
  },

  /** Optional: bake on this WebGLRenderer instead of World.renderer.renderer. */
  setRenderer(r) { state.renderer = r?.isWebGLRenderer ? r : r?.renderer || null; },
  /** Debug: sync the GPU after every bake so stats().perKey is real GPU time. */
  setProfile(on) { state.profile = !!on; },
  /** Bake every material during ready instead of on first use (labs, benchmarks). */
  setEager(on) { state.eager = !!on; },
  /** Bake these keys now (e.g. during a loading screen) so first use never hitches. */
  preload(keys) { for (const k of keys) ensure(k); },

  keys() { return Object.keys(DEFS); },

  material(key, opts = {}) {
    ensure(key);
    const o = normOpts(opts);
    const ck = key + JSON.stringify(o);
    let m = state.mats.get(ck);
    if (!m) { m = createMaterial(key, o); state.mats.set(ck, m); }
    return m;
  },

  maps(key) {
    ensure(key);
    const b = state.baked.get(key);
    if (!b) return {};
    return {
      map: b.map, normalMap: b.normalMap, roughnessMap: b.orm, aoMap: b.orm,
      metalnessMap: DEFS[key]?.metal ? b.orm : null, orm: b.orm,
    };
  },

  /** Authoring hints: world units covered by one tile, surface key, hero resolution. */
  info(key) {
    const d = DEFS[key];
    return d ? { world: d.world, surface: d.surface, hero: !!d.hero, metal: !!d.metal, alpha: !!d.mat?.alphaTest || !!d.mat?.transparent } : null;
  },

  decal(type) { ensure(type); return state.decals.get(type) || null; },
  decalTypes() { return Object.keys(DECALS); },
  detailNormal() { ensure('detail_normal'); return state.detail; },
  stats() { if (state.baker?.stages) state.stats.stages = state.baker.stages; return state.stats; },
};
