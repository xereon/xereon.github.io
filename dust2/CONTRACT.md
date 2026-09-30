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

**Coordinates map 1:1 to real Source/Hammer coordinates** through a fixed rotation, so any
known de_dust2 `setpos x y z` / `setang p y r` can be used directly:

```
Three (x, y, z)  =  Source (x, z, -y)          // Source: x east, y north, z up
fromSource(x, y, z) -> Vector3,  toSource(v) -> [x, y, z]      (src/core/mathx.js)
```

Angles use **Source's convention exactly**: `yaw` in degrees about `+Y`, **0 = +X (east),
90 = -Z (north)**, increasing counter-clockwise from above. `pitch` in degrees, **positive
looks down**. So `setang 5 90 0` in CS is `{ pitch: 5, yaw: 90 }` here. Helpers in
`src/core/mathx.js`:

```js
angleVectors(pitch, yaw) -> { forward, right, up }   // forward(0,0) = +X
flatVectors(yaw, fwd, right)                          // horizontal only
applyViewAngles(camera, pitch, yaw, roll)             // sets camera.quaternion
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
| `freeze_end` | `{ round }` |
| `round_mvp` | `{ ent, reason }` |
| `reload` | `{ ent, weapon, time, empty, count }` |
| `weapon_shell_in` | `{ ent, weapon }` (shotgun shell-by-shell) |
| `jump` / `land` | `{ ent, surface, volume, fallSpeed }` |
| `grenade_bounce` | `{ pos, key, surface }` |
| `grenade_detonate` / `grenade_expire` | `{ pos, key, ent }` |
| `decoy_fire` | `{ pos, weapon }` |
| `bomb_beep` | `{ pos, timeLeft }` |
| `shell_land` | `{ pos, key, surface }` |
| `radio` | `{ ent, msg }` |
| `sound` | `{ name, pos? }` — generic one-shot for anything without a dedicated event |

`footstep` may also carry `kind` (`'step' | 'ladder' | 'wade'`). `World.map.soundEmitters`
(optional) is an array of `{ name, pos, radius }` for looping ambience the audio module places.

---

## 3. Collision — `src/player/collision.js` (owner: lead — tested; request changes, do not edit)

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
  give(ent, key)           // buy menu / spawn loadout; handles slots + replacing
  currentInaccuracy(ent) -> degrees
  viewmodel                // Viewmodel instance (§13), created by WeaponSystem
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

---

## 11. Entities — `src/player/player.js` (owner: movement agent)

Local player and bots are the **same class** running the **same movement code** (as in
Source). Bots differ only in where their usercmds come from.

```js
export class Player {
  // identity
  name, team /* 'T'|'CT' */, isBot, isLocal, id
  // state
  alive, health, armor, helmet, money, defuser
  origin /* feet */, velocity, pitch, yaw, onGround, ducking, duckAmount /* 0..1 */
  eyeHeight            // current (animated) eye height above origin
  eyePos(out) -> Vector3
  viewPunch, aimPunch  // {pitch, yaw}; WeaponSystem writes, Player decays + applies to view
  // weapons — WeaponSystem owns the contents
  inventory: { primary, secondary, knife, grenades: [], c4, taser }, active
  // third-person
  model                // CharacterModel from src/player/character.js (null for local 1P)

  setPose(eyePos, pitch, yaw)
  runCommand(cmd, dt)          // Source PlayerMove: friction, accel, airaccel, duck, stairs
  frame(dt, alpha)             // local: camera + bob + punch; remote: model.update
  takeDamage(info)             // info = { amount, hitgroup, attacker, weapon, point, dir, armorPen }
  die(info)
  respawn(spawn)
  rayHit(start, dir, maxDist)  // delegates to hitboxes -> { t, hitgroup, point, normal } | null
}

export function createPlayer({ team, isBot, name }) -> Player   // registers in World.entities
export function createLocalPlayer(team) -> Player
```

Camera: `Player.frame` for the local player sets `World.camera` from eye position, view
angles, `viewPunch` and landing/duck smoothing. If `World.cameraOverride` is set (harness),
it must place the player at the override pose and **still render the viewmodel**.

## 12. Characters — `src/player/character.js`, `src/player/hitboxes.js` (owner: character agent)

```js
export function createCharacterModel(team, variant) -> CharacterModel
// CharacterModel = {
//   root: THREE.Object3D,               // added to World.scene by the Player
//   update(ent, dt),                    // pose from ent: yaw, pitch (aim), velocity, ducking,
//                                       // onGround, active weapon, fire/reload events
//   worldHitboxes(ent) -> Hitbox[],     // posed this frame
//   ragdoll(impulseDir, force, hitgroup),
//   dispose(),
// }
export function rayVsHitboxes(hitboxes, start, dir, maxDist) -> { t, hitgroup, point, normal } | null
```

Hitboxes are **oriented capsules** that follow the animated skeleton (head sphere-capsule,
neck, chest, stomach, pelvis, upper/lower arms, upper/lower legs) — never a single AABB.

## 13. Viewmodel — `src/weapons/viewmodel.js` (owner: viewmodel agent)

```js
export class Viewmodel {
  constructor(viewScene, viewCamera)
  setWeapon(key)                      // builds/caches the procedural weapon+arms mesh
  play(anim)                          // 'draw' 'idle' 'fire' 'fire_last' 'reload' 'reload_empty'
                                      // 'inspect' 'melee' 'melee_heavy' 'pin' 'throw' 'zoom_in'
  update(dt, ent)                     // sway from mouse delta, bob from velocity, land kick,
                                      // crouch offset; reads ent.viewPunch
  muzzleWorld(out) -> Vector3         // muzzle position in WORLD space (for tracers/flash)
  ejectWorld(out) -> Vector3          // ejection port in WORLD space (for shells)
}
```

## 14. Effects — `src/fx/index.js` (owner: FX agent)

```js
export class FX {
  update(dt)
  muzzleFlash(worldPos, dir, key, opts = { viewmodel: false })
  tracer(from, to, key)
  impact(point, normal, surface)      // also triggered automatically by 'impact' events
  blood(point, dir, amount)
  shell(pos, vel, key)                // brass ejection with bounce + tink sound event
  decal(point, normal, type, size)
  smoke(pos) -> handle                // smoke grenade volume, ~18 s, blocks LOS
  flash(pos)                          // flashbang; computes blindness for every entity
  explosion(pos)                      // HE
  fire(pos, normal) -> handle         // molotov / incendiary pool, ~7 s
  blindAmount(ent) -> 0..1            // HUD whiteout + bot blindness
  smokeOcclusion(from, to) -> 0..1    // bots + audio use this for LOS
}
```

## 15. Audio — `src/audio/audio.js` (owner: audio agent)

```js
export class Audio {
  unlock()                            // call from a user gesture (menu click)
  play(name, opts)                    // 2D: UI, local-player weapon
  playAt(name, pos, opts)             // 3D HRTF, distance + occlusion (rayTrace MASK_VISIBLE)
  update(dt)                          // listener follows World.camera
}
```
Audio subscribes to World events (`fire`, `footstep`, `impact`, `damage`, `death`,
`bomb_*`, `round_*`, `buy`) itself — other modules just emit events. Sound names follow
`weapon_<key>_fire`, `footstep_<surface>`, `impact_<surface>`, `hit_head`, `bomb_beep`, etc.
Everything is synthesised with WebAudio (no sample files).
