// Third-person agents (CONTRACT.md §12).
//  * procedural skinned mesh per team (one draw call per LOD, shared geometry + material),
//  * procedural animation from entity state (models/pose.js),
//  * third-person weapon in the right hand (viewmodel's buildWorldModel or a stand-in),
//  * CS-style capsule hitboxes that follow the pose (hitboxes.js),
//  * verlet ragdoll with world collision (models/ragdoll.js).
import * as THREE from 'three';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { buildSkeleton, BONE, HAND_R } from './models/skeleton.js';
import { buildAgent } from './models/agents.js';
import { layoutAtlas, bakeAtlasAsync, vertexPaint } from './models/paint.js';
import { Animator, HOLDS, holdKind } from './models/pose.js';
import { makeHeldItem, vmAvailable } from './models/weapon.js';
import { Ragdoll } from './models/ragdoll.js';
import { createHitboxSet, poseHitboxes, debugDrawHitboxes, rayVsHitboxes } from './hitboxes.js';
export { rayVsHitboxes };

defCvar('r_drawhitboxes', 0, 0, 1, 'draw character hitbox capsules');
defCvar('r_character_lod_dist', 1500, 200, 8000, 'distance where agents switch to the low LOD');

const DEG = Math.PI / 180;
const IDENT = new THREE.Matrix4();
const cache = new Map();   // team -> assets

function flatTex(r, g, b, srgb) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Shared per-team assets. Geometry is built synchronously (~50 ms); the texture atlas bakes
 * time-sliced in the background. Until it lands, the material shows per-vertex paint through
 * 1x1 placeholder maps (same shader program, so swapping maps later doesn't recompile).
 */
function teamAssets(team) {
  const key = team === 'CT' ? 'CT' : 'T';
  let a = cache.get(key);
  if (a) return a;
  const mb0 = buildAgent(key, 0), mb1 = buildAgent(key, 1);
  const layout = layoutAtlas(mb0, 1024);
  layout.remap(mb1);
  const geo = [mb0.build(), mb1.build()];
  const vcol = vertexPaint(mb0);
  geo[0].setAttribute('color', new THREE.BufferAttribute(vcol, 3));
  // LOD1 has different vertices: sample LOD0 colours by nearest bind position per island
  geo[1].setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo[1].attributes.position.count * 3).fill(0.35), 3));
  const material = new THREE.MeshStandardMaterial({
    map: flatTex(255, 255, 255, true), normalMap: flatTex(128, 128, 255), roughnessMap: null, metalnessMap: null, aoMap: null,
    roughness: 0.9, metalness: 0, vertexColors: true,
  });
  const orm = flatTex(255, 235, 0);
  material.roughnessMap = orm; material.metalnessMap = orm; material.aoMap = orm;
  material.roughness = 1; material.metalness = 1;
  material.name = `agent_${key}`;
  // hook the renderer's lighting patch now so the first visible frame doesn't recompile
  try { World.renderer?.setupMaterial?.(material); } catch (err) { /* renderer without hooks */ }
  a = { geo, material, tris: geo.map((g) => g.index.count / 3), ready: null, baked: false };
  a.ready = bakeAtlasAsync(mb0, layout).then(({ maps }) => {
    material.map = maps.map; material.normalMap = maps.normalMap;
    material.roughnessMap = maps.ormMap; material.metalnessMap = maps.ormMap; material.aoMap = maps.ormMap;
    for (const g of geo) { g.attributes.color.array.fill(1); g.attributes.color.needsUpdate = true; }
    a.baked = true;
  }).catch((err) => console.error('[character] atlas bake failed', err));
  cache.set(key, a);
  return a;
}
/** Resolves when the team's texture atlas has been baked. */
export function characterReady(team) { return teamAssets(team).ready; }
/** Start building both teams' assets early (e.g. during loading). */
export function preloadCharacters() { teamAssets('T'); teamAssets('CT'); return Promise.all([characterReady('T'), characterReady('CT')]); }
export function characterAssets(team) { return teamAssets(team); }

// one global 'fire' listener -> the shooter's model
let fireHooked = false;
function hookEvents() {
  if (fireHooked || !World.on) return;
  fireHooked = true;
  const agent = (e) => { const m = e?.ent?.model; return m && m._isAgent ? m : null; };
  World.on('fire', (e) => agent(e)?.anim.fire(e));
  World.on('grenade_pin', (e) => agent(e)?.anim.pin());
  World.on('grenade_throw', (e) => agent(e)?.anim.throwNade());
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _rootQ = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);

class CharacterModel {
  constructor(team, variant) {
    hookEvents();
    const A = teamAssets(team);
    this._isAgent = true;
    this.team = team === 'CT' ? 'CT' : 'T';
    this.variant = variant | 0;
    this.root = new THREE.Group();
    this.root.name = `agent_${this.team}`;
    const { bones, skeleton, root } = buildSkeleton();
    this.bones = bones; this.skeleton = skeleton;
    this.root.add(root);
    this.meshes = A.geo.map((g, lod) => {
      const m = new THREE.SkinnedMesh(g, A.material);
      m.bind(skeleton, IDENT);
      m.castShadow = true; m.receiveShadow = true;
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 36, 0), 52);
      m.visible = lod === 0;
      m.name = `agent_${this.team}_lod${lod}`;
      this.root.add(m);
      return m;
    });
    this.lod = 0;
    this.anim = new Animator();
    this.hitboxes = createHitboxSet(this.team);
    this.held = null; this.heldKey = null; this.heldKind = null;
    this.rag = null;
    this.posed = false;
    this.dbg = null;
    this.rootQuat = new THREE.Quaternion();
  }

  onFire(e) { this.anim.fire(e); }

  _syncHeld(ent) {
    const kind = holdKind(ent);
    const key = ent?.active?.key || ent?.active?.def?.key || (kind === 'rifle' ? (this.team === 'CT' ? 'm4a4' : 'ak47') : kind);
    const vm = vmAvailable();
    if (key === this.heldKey && kind === this.heldKind && vm === this.heldVM) return;
    this.heldVM = vm;
    if (this.held) { this.held.removeFromParent(); }
    this.held = makeHeldItem(kind, key, this.team);
    this.heldKey = key; this.heldKind = kind;
    this.bones[BONE.hand_R].add(this.held);
    const ud = this.held.userData;
    this.anim.setHeld(kind, ud.butt, ud.lGrip);
  }

  update(ent, dt) {
    if (this.rag) {
      this.rag.step(dt);
      this.rag.apply(this);
      this._finish();
      return;
    }
    this._syncHeld(ent);
    const a = this.anim.update(ent, dt);
    a.apply(this.bones);
    this.root.position.copy(a.rootPos);
    this.root.rotation.set(0, a.rootYaw * DEG, 0);
    this.rootQuat.setFromAxisAngle(_Y, a.rootYaw * DEG);
    // weapon rigidly attached to the right hand (hand-local offset)
    if (this.held) {
      const hq = a.Qm[BONE.hand_R];
      _q.copy(hq).invert().multiply(a.weaponQuat);            // weapon rotation in hand space
      const rGrip = HOLDS[this.heldKind]?.rGrip;
      _v.copy(rGrip || _v.set(0, 0, 0)).applyQuaternion(_q).negate().add(HAND_R.grip);
      this.held.position.copy(_v);
      this.held.quaternion.copy(_q);
    }
    this.posed = true;
    this._finish();
  }

  _finish() {
    // LOD by camera distance (hysteresis)
    const cam = World.camera;
    if (cam) {
      const d = cam.position.distanceTo(this.root.position);
      const L = World.cvar.r_character_lod_dist || 1500;
      const want = this.lod === 0 ? (d > L * 1.05 ? 1 : 0) : (d < L * 0.95 ? 0 : 1);
      if (want !== this.lod) { this.lod = want; this.meshes[0].visible = want === 0; this.meshes[1].visible = want === 1; }
    }
    if (World.cvar.r_drawhitboxes) {
      poseHitboxes(this.hitboxes, this._Qm(), this._Pm(), this.root.position, this._rq());
      this.dbg = debugDrawHitboxes(World.scene || this.root.parent, this.hitboxes, this.dbg);
      this.dbg.visible = true;
    } else if (this.dbg) this.dbg.visible = false;
  }

  _Qm() { return this.rag ? this.rag.Qm : this.anim.Qm; }
  _Pm() { return this.rag ? this.rag.Pm : this.anim.Pm; }
  _rq() { return this.rag ? this.rag.rootQuat : this.rootQuat; }

  /** Hitboxes posed for the last rendered frame (what the shooter saw). */
  worldHitboxes(ent) {
    if (!this.posed && !this.rag && ent) this.update(ent, 0);
    return poseHitboxes(this.hitboxes, this._Qm(), this._Pm(), this.root.position, this._rq());
  }

  ragdoll(dir, force = 1, hitgroup = 0) {
    if (this.rag) { this.rag.impulse(dir, force, hitgroup); return; }
    if (!this.posed) return;
    this.rag = new Ragdoll(this);
    this.rag.impulse(dir, force, hitgroup);
    for (const m of this.meshes) m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 12, 0), 60);
    // drop the weapon out of the hand
    if (this.held) { this.held.removeFromParent(); this.held = null; this.heldKey = null; }
  }

  dispose() {
    this.root.removeFromParent();
    if (this.dbg) this.dbg.removeFromParent();
    this.skeleton.dispose?.();
  }
}

export function createCharacterModel(team = 'T', variant = 0) {
  return new CharacterModel(team, variant);
}
