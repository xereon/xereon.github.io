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
import { LIB } from './gen/lib.js';

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

async function generateAll() {
  const t0 = performance.now();
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    state.stats.mode = 'flat';
    return;
  }
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
      return;
    }
  }
  state.stats.mode = own ? 'readback' : 'gpu';
  const baker = new Baker(r);
  const q = World.quality || 'high';
  const maxA = baker.maxAniso;
  const aniso = own ? 8 : Math.min(maxA, q === 'low' ? 2 : q === 'medium' ? 8 : 16);
  const qs = qualityScale();

  // decals + detail normal are baked like materials (their own defs)
  const jobs = [];
  for (const [key, def] of Object.entries(DEFS)) jobs.push({ kind: 'mat', key, def });
  for (const [key, def] of Object.entries(DECALS)) jobs.push({ kind: 'decal', key, def });
  jobs.push({ kind: 'detail', key: 'detail_normal', def: DETAIL });

  for (const j of jobs) {
    j.def.key = j.key;
    j.def.lib = LIB;
    j.size = Math.max(64, Math.round((j.def.size || (j.def.hero ? 1024 : 512)) * qs));
    j.canvasTex = drawCanvas(j.def, j.size);
    j.fieldMat = baker.fieldMaterial(j.def, j.size, j.canvasTex);
  }
  await baker.precompile(jobs.map((j) => j.fieldMat));

  let i = 0;
  for (const j of jobs) {
    const tk = performance.now();
    let baked;
    try {
      baked = baker.bake(j.def, j.size, j.fieldMat, j.def.aniso === false ? 1 : aniso);
      if (own) baked = readBack(r, baked, j.size, j.def);
    } catch (e) {
      console.error(`[TextureLib] bake failed for ${j.key}`, e);
      baked = null;
    }
    j.fieldMat.dispose();
    j.canvasTex?.dispose();
    if (baked) {
      if (j.kind === 'mat') { state.baked.set(j.key, baked); bindLate(j.key); }
      else if (j.kind === 'decal') state.decals.set(j.key, finishDecal(baked, j.def));
      else state.detail = baked.normalMap;
    }
    state.stats.perKey[j.key] = +(performance.now() - tk).toFixed(1);
    // yield now and then so the boot overlay can paint
    if (++i % 6 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  baker.dispose();
  if (own) r.dispose();
  state.stats.ms = +(performance.now() - t0).toFixed(1);
  Dbg.log('[TextureLib] baked', jobs.length, 'maps in', state.stats.ms, 'ms', state.stats.mode);
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
      antiTile: o.antiTile ?? !!def.antiTile,
      macro: o.macro != null ? [o.macro, o.macro * 0.4] : def.macro,
      macroScale: def.macroScale,
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

  keys() { return Object.keys(DEFS); },

  material(key, opts = {}) {
    const o = normOpts(opts);
    const ck = key + JSON.stringify(o);
    let m = state.mats.get(ck);
    if (!m) { m = createMaterial(key, o); state.mats.set(ck, m); }
    return m;
  },

  maps(key) {
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

  decal(type) { return state.decals.get(type) || null; },
  decalTypes() { return Object.keys(DECALS); },
  detailNormal() { return state.detail; },
  stats() { return state.stats; },
};
