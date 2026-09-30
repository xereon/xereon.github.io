# dust2 — Engine Contract (READ ONLY for feature agents)

This file is the single source of truth for cross-module interfaces. **Do not edit it**
unless you are the lead. If you need a contract change, say so in your report instead of
editing, and code against what is written here.

---

## 0. Ground rules

* **Pure ES modules.** No bundler, no npm at runtime. `three` is vendored at
  `dust2/vendor/three/build/three.module.js` and imported via the importmap in
  `dust2/index.html` as `import * as THREE from 'three'`.
  Addons: `import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'`.
* **No external network requests at runtime.** No CDNs, no fetching textures or models.
  Every texture, mesh and sound is generated procedurally in code. This is both a
  licensing requirement (we ship no Valve assets) and a hard perf/offline requirement.
* **File ownership is exclusive.** Only edit the files assigned to you. If you need
  something from another module, code against the interface below; if it is not yet
  implemented, the stub returns something safe.
* **No `console.log` spam** in hot paths. Use `Dbg.log()` from `src/core/debug.js`.
* Target **144 fps on a desktop iGPU at 1080p** on `quality: 'high'`. Budget matters:
  keep draw calls under ~400 and avoid per-frame allocation. Reuse scratch vectors.

---

## 1. Units, axes, conventions

We use **Source engine units** (1 unit = 1 inch = 0.0254 m) with **Three.js Y-up**.

| Quantity | Value |
|---|---|
| Up axis | `+Y` |
| Horizontal plane | `XZ` |
| Gravity | `800` u/s² (`-Y`) |
| Max run speed | `250` u/s (scaled by weapon `maxSpeed`) |
| Jump impulse | `301.993` u/s (= `sqrt(2 * 800 * 57)`) |
| Player hull standing | mins `(-16, 0, -16)` maxs `(16, 72, 16)` |
| Player hull crouched | mins `(-16, 0, -16)` maxs `(16, 54, 16)` |
| Eye height standing / crouched | `64` / `46` |
| Step height | `18` |
| Max walkable slope | `45.573°` (`cos = 0.7`) |
| Camera near / far | `1` / `12000` |
| Default FOV | `90` (viewmodel FOV `68`) |

Angles: `yaw` is rotation about `+Y`, **degrees**, 0 = looking down `-Z`, increasing
counter-clockwise viewed from above. `pitch` is **degrees**, positive = looking **down**
(Source convention). Conversion helpers live in `src/core/mathx.js`:

```js
angleVectors(pitch, yaw) -> { forward: Vector3, right: Vector3, up: Vector3 }
applyViewAngles(camera, pitch, yaw, roll)   // sets camera.quaternion
```

---

## 2. Service locator — `src/core/world.js`

A single mutable object every module reads from. No circular imports: modules import
`World` and read fields lazily inside functions, never at module top level.

```js
import { World } from '../core/world.js';

World = {
  time: 0,              // seconds since match start (paused-aware)
  frame: 0,
  dt: 0,                // clamped frame delta, seconds
  tickInterval: 1/128,  // fixed simulation tick

  renderer,             // RenderPipeline   (engine/renderer.js)
  scene,                // THREE.Scene      world
  camera,               // THREE.PerspectiveCamera
  viewScene,            // THREE.Scene      viewmodel-only overlay
  viewCamera,           // THREE.PerspectiveCamera

  collision,            // CollisionWorld   (player/collision.js)
  map,                  // MapData          (map/dust2.js)
  nav,                  // NavMesh          (ai/navmesh.js)

  input,                // Input            (core/input.js)
  local,                // Player           the local player entity
  entities: [],         // all Player/Bot entities
  players: [],          // alias of entities that are Player-like

  weapons,              // WeaponSystem     (weapons/system.js)
  fx,                   // FX               (fx/index.js)
  audio,                // Audio            (audio/audio.js)
  match,                // MatchController  (game/rules.js)
  hud,                  // Hud              (game/hud.js)

  quality: 'high',
  paused: false,
  cvar: {},             // tweakables, see §9
}
```

`World.emit(name, payload)` / `World.on(name, fn)` — tiny event bus, already implemented.
Canonical events:

| Event | Payload |
|---|---|
| `spawn` | `{ ent }` |
| `damage` | `{ victim, attacker, amount, hitgroup, weapon, point, normal, penetrated }` |
| `death` | `{ victim, attacker, weapon, headshot }` |
| `fire` | `{ ent, weapon, seed }` |
| `impact` | `{ point, normal, surface, entity, weapon }` |
| `footstep` | `{ ent, surface, volume }` |
| `round_start` / `round_end` | `{ round, winner?, reason? }` |
| `bomb_planted` / `bomb_defused` / `bomb_exploded` | `{ site, ent? }` |
| `buy` | `{ ent, item }` |

---

## 3. Collision — `src/player/collision.js` (owner: physics agent)

Source-style brush world. A brush is a **convex volume defined by planes**; a point `p`
is inside when `dot(n, p) + d <= 0` for every plane.

```js
export class CollisionWorld {
  addBrush(planes, surface = 'default', flags = 0) -> id
  addBox(min, max, surface = 'default', flags = 0) -> id     // 6 axis planes
  addWedge(min, max, axis, dir, surface)                     // ramp / stair helper
  build()                                                    // build BVH, call once
  hullTrace(mins, maxs, start, end, mask = MASK_PLAYER) -> Trace
  rayTrace(start, end, mask = MASK_SHOT, skipEnt = null) -> Trace
  pointContents(p) -> number
}

// Trace = {
//   fraction,      // 0..1 along start->end
//   endpos,        // Vector3
//   normal,        // Vector3, surface normal at hit (zero if none)
//   plane,         // { n, d } or null
//   surface,       // string surface key, see §4
//   brush,         // brush id or -1
//   entity,        // hit entity or null (ray only)
//   startSolid,    // bool
//   allSolid,      // bool
//   hitgroup,      // for entity hits: 1 head, 2 chest, 3 stomach, 4/5 arms, 6/7 legs
// }
```

Masks: `MASK_PLAYER` (solid world + clip brushes), `MASK_SHOT` (solid world + players,
ignores player-clip), `MASK_VISIBLE` (solid world only, ignores grates/glass).
Flags: `CONTENTS_SOLID 1`, `CONTENTS_PLAYERCLIP 2`, `CONTENTS_GRATE 4` (shootable-through),
`CONTENTS_WATER 8`, `CONTENTS_LADDER 16`.

**Scratch discipline:** `hullTrace` and `rayTrace` fill and return a *pooled* Trace.
Copy anything you need to keep. Never hold the returned object across frames.

---

## 4. Surfaces — `src/core/surfaces.js`

Surface keys are shared by textures, footsteps, impact decals, particles and bullet
penetration. Canonical list (do not invent new keys without adding them here):

```
'default' 'sand' 'gravel' 'concrete' 'plaster' 'brick' 'wood' 'crate' 'metal'
'metalgrate' 'metaldoor' 'tile' 'cloth' 'rock' 'glass' 'water' 'dirt' 'rubber' 'flesh'
```

Each has `{ footstepPitch, impactSound, decal, dustColor, dustAmount, penetrationModifier,
hardness }` in `SURFACES`.

---

## 5. Texture / material library — `src/art/textures.js` (owner: texture agent)

Everything procedural, generated on an `OffscreenCanvas` or via GPU render-to-texture,
cached by key. Must produce a full PBR set.

```js
export const TextureLib = {
  ready: Promise<void>,
  material(key, opts = {}) -> THREE.MeshStandardMaterial   // cached; opts {repeat, tint, aniso}
  maps(key) -> { map, normalMap, roughnessMap, metalnessMap, aoMap, displacementMap? }
  keys() -> string[]
}
```

Required keys (map agent depends on these exact names):

```
sand_floor  sand_blend  gravel  concrete_wall  concrete_floor  plaster_wall  plaster_trim
brick_tan  brick_red  stone_block  stone_wall  rubble  wood_planks  wood_crate  wood_door
metal_door  metal_grate  metal_beam  metal_barrel  tile_floor  tile_wall  cloth_awning
cloth_tarp  rope  sandbag  arch_stone  roof_tile  window_frame  glass  poster  crate_label
```

Rules: **seamless tiling** (verify by tiling 3×3 and looking for a visible grid),
16-bit-ish normal precision (pack from a height field, don't hand-draw), roughness driven
by the same height/mask data so it correlates with the albedo, albedo **without baked
lighting** (no painted-on shadows other than fine cavity AO), and sRGB set correctly
(`map.colorSpace = THREE.SRGBColorSpace`; data maps stay linear).

---

## 6. Map — `src/map/dust2.js` (owner: map agent)

```js
export async function buildDust2() -> MapData

// MapData = {
//   root: THREE.Group,                     // all visual geometry, added to World.scene
//   collision: CollisionWorld,             // already built
//   spawns: { T: Spawn[], CT: Spawn[] },   // Spawn = { pos: Vector3, yaw: number }
//   bombsites: { A: Zone, B: Zone },
//   buyzones: { T: Zone, CT: Zone },
//   sun: { dir: Vector3, color: Color, intensity: number },
//   ambient: { sky: Color, ground: Color, intensity: number },
//   fog: { color: Color, density: number },
//   walkable: Float32Array,                // triangle soup of walkable surfaces for nav
//   callouts: { [name]: Zone },            // 'long', 'catwalk', 'mid', 'tunnels', ...
// }
// Zone = { min: Vector3, max: Vector3, name: string }
```

Scale reference (real de_dust2, Source units): T spawn to A site ≈ 2400u, Long A ≈ 1900u
of straight corridor, mid doors gap 128u wide, standard door frame 108u tall.

---

## 7. Weapons — `src/weapons/registry.js`, `src/weapons/system.js`

```js
export const WEAPONS = {
  ak47: {
    name: 'AK-47', team: 'T', slot: 'primary', price: 2700, killAward: 300,
    damage: 36, armorPen: 0.775, rangeModifier: 0.98, headshotMul: 4,
    cycleTime: 0.0968, mag: 30, reserve: 90, reloadTime: 2.4, deployTime: 1.0,
    maxSpeed: 215, penetration: 1.5,
    spread: 0.0,        inaccuracyStand: 6.9,  inaccuracyMove: 137.5,
    inaccuracyJump: 200, inaccuracyLand: 90,   inaccuracyCrouch: 5.86,
    recoilSeed: 'ak47', recoveryTime: 0.3675,
    fireMode: 'auto', tracerFreq: 3, zoom: null,
  },
  ...
}
```

Required weapons: `knife glock usp p250 deagle tec9 fiveseven dualberettas
mp9 mac10 mp5sd ump45 p90 nova xm1014 mag7 negev m249 galil famas ak47 m4a4 m4a1s
ssg08 aug sg553 awp g3sg1 scar20 taser`
plus equipment `hegrenade flashbang smokegrenade molotov incgrenade decoy
kevlar kevlarhelmet defusekit zeus`.

Recoil must use **authentic per-weapon spray patterns** (deterministic, seeded by shot
index) — not random cones. `recoilTable(weaponKey) -> Array<[x, y]>` in
`src/weapons/recoil.js`, values in degrees of view punch, index = shot number.

```js
export class WeaponSystem {
  update(dt)
  attack(ent, down)        // down=true on press for semi/burst
  secondary(ent)           // ADS / silencer / burst toggle
  reload(ent)
  switchTo(ent, key)
  drop(ent)
  currentInaccuracy(ent) -> degrees
}
```

Ballistics live in `src/weapons/ballistics.js`:

```js
fireBullet(ent, weapon, seed, shotIndex) // performs traces, applies damage,
                                         // emits 'impact', handles up to 4 penetrations
damageFalloff(dmg, dist, rangeModifier)
armorAbsorb(dmg, armorPen, armorValue) -> { health, armor }
```

Hitgroup multipliers: head `4.0`, chest/arms `1.0`, stomach `1.25`, legs `0.75`.

---

## 8. Rendering — `src/engine/renderer.js` (owner: rendering agent)

```js
export class RenderPipeline {
  constructor(canvas)
  setQuality(q)   // 'low' | 'medium' | 'high' | 'ultra'
  resize(w, h)
  render(dt)      // renders world, then viewmodel overlay, then applies post
  get scene(); get camera(); get viewScene(); get viewCamera();
}
```

Required stack, in order: HDR render target (`HalfFloatType`) → CSM directional shadows
(4 cascades) → GTAO → bloom (threshold on luminance, not RGB) → filmic tonemap
(ACES-ish) → colour grade LUT → SMAA → dither. Exposure via `renderer.toneMappingExposure`.
No `OutputPass` after SMAA — tonemap before AA so AA runs in display space.

Viewmodel is rendered by the **same composer** into the same buffer with depth cleared,
so it receives post-processing and never clips into walls.

---

## 9. Cvars — `src/core/cvars.js`

Live-tweakable numbers, exposed on `window.cv` and in the F1 debug panel. Add yours with
`defCvar('name', default, min, max, 'help')`. Anything a critic might want to tune
(exposure, bloom strength, fog density, recoil scale, view sway) **must** be a cvar.

---

## 10. Screenshot harness (use this to verify your own work)

```bash
node dust2/tools/shot.mjs --out /tmp/x.png --pose long_doors --w 1920 --h 1080
node dust2/tools/shot.mjs --out /tmp/y.png --eval "cv.exposure=1.4" --pose mid
node dust2/tools/shot.mjs --list-poses
```

Poses are named camera setups defined in `dust2/tools/poses.json` matching well-known
de_dust2 screenshots (T spawn, Long A, A site from Goose, Catwalk, Mid doors, B tunnels,
CT spawn, B site, Short, Pit). The harness fails loudly on any console error or
uncaught exception, so a green screenshot also means a clean console.

`--probe name` dumps JSON diagnostics instead of a PNG (draw calls, triangles, frame ms,
texture memory) so you can check budgets.
