// Small allocation-free helpers shared by the FX recipes.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { sunDirW } from './lighting.js';

const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
export const MASK_VISIBLE = 1;

/** Random unit vector within a cone of half-angle ~acos(1 - spread) around dir. */
export function randCone(dir, spread, rand, out) {
  if (Math.abs(dir.y) < 0.9) _u.set(0, 1, 0).cross(dir).normalize(); else _u.set(1, 0, 0).cross(dir).normalize();
  _v.crossVectors(dir, _u);
  const z = 1 - rand() * spread;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = rand() * Math.PI * 2;
  return out.copy(dir).multiplyScalar(z).addScaledVector(_u, r * Math.cos(phi)).addScaledVector(_v, r * Math.sin(phi));
}

/** Height of the floor below p (within `range`), or -1e6. */
export function floorBelow(p, range = 256) {
  const col = World.collision;
  if (!col) return 0;
  _a.copy(p); _a.y += 1;
  _b.copy(p); _b.y -= range;
  const tr = col.rayTrace(_a, _b, MASK_VISIBLE);
  return tr.fraction < 1 && tr.normal.y > 0.5 ? tr.endpos.y : -1e6;
}

/** 1 when p sees the sun, ~0.12 in shadow (one trace). */
export function sunVisibility(p) {
  const col = World.collision;
  if (!col) return 1;
  _b.copy(p).addScaledVector(sunDirW, 4000);
  return col.rayTrace(p, _b, MASK_VISIBLE).fraction < 1 ? 0.12 : 1;
}

/** First world hit along a ray; returns fraction and fills outP / outN. */
export function traceWorld(from, dir, dist, outP, outN) {
  const col = World.collision;
  if (!col) return 1;
  _b.copy(from).addScaledVector(dir, dist);
  const tr = col.rayTrace(from, _b, MASK_VISIBLE);
  if (tr.fraction < 1) { outP.copy(tr.endpos); outN.copy(tr.normal); }
  return tr.fraction;
}

const _inv = new THREE.Matrix4(), _l = new THREE.Vector3();
/** World position -> viewScene position (for viewmodel-attached effects). */
export function worldToView(p, out) {
  const cam = World.camera, vc = World.viewCamera;
  if (!cam || !vc) return out.copy(p);
  _inv.copy(cam.matrixWorld).invert();
  return out.copy(p).applyMatrix4(_inv).applyMatrix4(vc.matrixWorld);
}
export function dirWorldToView(d, out) {
  const cam = World.camera, vc = World.viewCamera;
  if (!cam || !vc) return out.copy(d);
  _inv.copy(cam.matrixWorld).invert();
  return out.copy(d).transformDirection(_inv).transformDirection(vc.matrixWorld);
}
/**
 * A viewmodel point (given in world space via the shared camera frame) re-projected so it
 * lands on the same screen pixel through the *world* camera (FOV differs from the viewmodel
 * camera). Use for world-space smoke/tracers that must start at the on-screen muzzle.
 */
export function viewmodelToWorldMatched(p, out) {
  const cam = World.camera, vc = World.viewCamera;
  if (!cam || !vc) return out.copy(p);
  _inv.copy(cam.matrixWorld).invert();
  _l.copy(p).applyMatrix4(_inv);          // camera-local (shared by both cameras)
  const z = _l.z;
  if (z > -0.5) return out.copy(p);
  const pv = vc.projectionMatrix.elements, pw = cam.projectionMatrix.elements;
  const ndcX = (pv[0] * _l.x + pv[8] * z) / -z, ndcY = (pv[5] * _l.y + pv[9] * z) / -z;
  _l.x = (ndcX * -z - pw[8] * z) / pw[0];
  _l.y = (ndcY * -z - pw[9] * z) / pw[5];
  return out.copy(_l).applyMatrix4(cam.matrixWorld);
}

/** Queue a GPU upload range on a (possibly interleaved) buffer; ranges accumulate until three uploads them. */
export function queueRange(buf, start, count) {
  const r = buf.updateRanges;
  if (r.length >= 24) { r.length = 0; buf.addUpdateRange(0, buf.array.length); }
  else if (!(r.length === 1 && r[0].start === 0 && r[0].count === buf.array.length)) buf.addUpdateRange(start, count);
  buf.needsUpdate = true;
}
