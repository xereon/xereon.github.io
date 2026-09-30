// Shared FX uniforms + discovery of the scene's sun / ambient so lit particles match the
// world's lighting (whatever the rendering agent set up). All FX materials reference the
// same uniform objects, so updating them here updates every material.
import * as THREE from 'three';
import { World } from '../core/world.js';

export const shared = {
  uTime: { value: 0 },
  uSunCol: { value: new THREE.Vector3(3, 2.8, 2.5) },
  uSkyCol: { value: new THREE.Vector3(0.9, 1.0, 1.2) },
  uGroundCol: { value: new THREE.Vector3(0.6, 0.5, 0.35) },
  uEmissive: { value: 1 },
  uDepth: { value: null },
  uHasDepth: { value: 0 },
  uDepthRes: { value: new THREE.Vector2(1, 1) },
  uNearFar: { value: new THREE.Vector2(1, 12000) },
};
export const sunDirW = new THREE.Vector3(0.5, 0.8, 0.3).normalize(); // toward the sun

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Color();
let _scanT = -1;

/** Rescan the scene lights (cheap; call every couple of seconds). */
export function scanLights(force = false) {
  const scene = World.scene;
  if (!scene) return;
  const now = performance.now();
  if (!force && now - _scanT < 2000) return;
  _scanT = now;
  let best = null, bestI = 0;
  let sky = _a.set(0, 0, 0), ground = _b.set(0, 0, 0), found = false;
  scene.traverseVisible((o) => {
    if (o.userData?.fx) return;
    if (o.isDirectionalLight) {
      const i = o.intensity * (o.color.r + o.color.g + o.color.b);
      if (i > bestI) { bestI = i; best = o; }
    } else if (o.isHemisphereLight) {
      sky.x += o.color.r * o.intensity; sky.y += o.color.g * o.intensity; sky.z += o.color.b * o.intensity;
      ground.x += o.groundColor.r * o.intensity; ground.y += o.groundColor.g * o.intensity; ground.z += o.groundColor.b * o.intensity;
      found = true;
    } else if (o.isAmbientLight) {
      const k = o.intensity;
      sky.x += o.color.r * k; sky.y += o.color.g * k; sky.z += o.color.b * k;
      ground.x += o.color.r * k; ground.y += o.color.g * k; ground.z += o.color.b * k;
      found = true;
    } else if (o.isLightProbe) {
      // Evaluate L0/L1 SH at +Y and -Y (three's irradiance convention).
      const sh = o.sh.coefficients, k = o.intensity;
      const c0 = 0.886227, c1 = 2.0 * 0.511664;
      sky.x += (sh[0].x * c0 + sh[1].x * c1) * k; sky.y += (sh[0].y * c0 + sh[1].y * c1) * k; sky.z += (sh[0].z * c0 + sh[1].z * c1) * k;
      ground.x += (sh[0].x * c0 - sh[1].x * c1) * k; ground.y += (sh[0].y * c0 - sh[1].y * c1) * k; ground.z += (sh[0].z * c0 - sh[1].z * c1) * k;
      found = true;
    }
  });
  const map = World.map;
  if (best) {
    best.updateMatrixWorld();
    best.target?.updateMatrixWorld?.();
    const lp = new THREE.Vector3().setFromMatrixPosition(best.matrixWorld);
    const tp = best.target ? new THREE.Vector3().setFromMatrixPosition(best.target.matrixWorld) : new THREE.Vector3();
    sunDirW.subVectors(lp, tp).normalize();
    shared.uSunCol.value.set(best.color.r, best.color.g, best.color.b).multiplyScalar(best.intensity);
  } else if (map?.sun) {
    sunDirW.copy(map.sun.dir).negate().normalize();
    shared.uSunCol.value.set(map.sun.color.r, map.sun.color.g, map.sun.color.b).multiplyScalar(map.sun.intensity);
  }
  if (!found && map?.ambient) {
    const a = map.ambient;
    sky.set(a.sky.r, a.sky.g, a.sky.b).multiplyScalar(a.intensity);
    ground.set(a.ground.r, a.ground.g, a.ground.b).multiplyScalar(a.intensity);
    found = true;
  }
  // Scene environment (IBL) adds roughly PI * env radiance of irradiance; approximate with
  // the ambient we have (if nothing else was found, pick a plausible desert sky).
  if (!found) { sky.set(0.9, 1.0, 1.15); ground.set(0.6, 0.5, 0.36); }
  else if (scene.environment) {
    const k = 1 + (scene.environmentIntensity ?? 1) * 0.5;
    sky.multiplyScalar(k); ground.multiplyScalar(k);
  }
  shared.uSkyCol.value.copy(sky);
  shared.uGroundCol.value.copy(ground);
}

/** Irradiance-weighted average ambient (for smoke fog overlays etc). */
export function ambientAvg(out) {
  return out.copy(shared.uSkyCol.value).multiplyScalar(0.6).addScaledVector(shared.uGroundCol.value, 0.4);
}
