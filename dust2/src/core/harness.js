// In-page side of tools/shot.mjs. Only loaded with ?harness.
// Places the camera at a named pose, freezes gameplay, and exposes hooks for the driver.
import * as THREE from 'three';
import { World } from './world.js';
import { applyViewAngles } from './mathx.js';

export async function setupHarness() {
  const p = World.params;
  let poses = {};
  try { poses = await (await fetch('./tools/poses.json', { cache: 'no-store' })).json(); }
  catch (e) { console.warn('[harness] no poses.json'); }
  World.harnessPoses = poses;

  World.harnessFixedDt = 1 / 60;
  if (!p.has('live')) World.bots && (World.bots.frozen = true);
  if (p.get('viewmodel') === '0') World.cvar.r_drawviewmodel = 0;

  const api = {
    poses,
    applyPose(pose) {
      if (typeof pose === 'string') {
        const name = pose;
        pose = poses[name];
        if (!pose) throw new Error(`[harness] unknown pose "${name}". Known: ${Object.keys(poses).join(', ')}`);
      }
      const eye = new THREE.Vector3(...pose.eye);
      const pitch = pose.pitch ?? 0, yaw = pose.yaw ?? 0;
      if (World.local?.setPose) World.local.setPose(eye, pitch, yaw);
      World.cameraOverride = { eye, pitch, yaw, fov: pose.fov ?? null };
      const cam = World.camera;
      cam.position.copy(eye);
      applyViewAngles(cam, pitch, yaw, 0);
      if (pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
      if (World.input) { World.input.pitch = pitch; World.input.yaw = yaw; }
    },
    frames(n = 1) {
      return new Promise((res) => {
        let left = n;
        const step = () => { if (--left <= 0) res(); else requestAnimationFrame(step); };
        requestAnimationFrame(step);
      });
    },
    probe(frames = 60) {
      return new Promise((res) => {
        const times = [];
        let lastT = performance.now(), left = frames;
        const step = () => {
          const t = performance.now(); times.push(t - lastT); lastT = t;
          if (--left <= 0) {
            const r = World.renderer.renderer || World.renderer.gl;
            const info = r?.info || {};
            times.sort((a, b) => a - b);
            res({
              frameMsMedian: times[times.length >> 1],
              frameMsP95: times[Math.floor(times.length * 0.95)],
              calls: info.render?.calls, triangles: info.render?.triangles,
              geometries: info.memory?.geometries, textures: info.memory?.textures,
              programs: info.programs?.length,
              entities: World.entities.length,
              sceneObjects: (() => { let c = 0; World.scene.traverse(() => c++); return c; })(),
              bootFailures: World.bootFailures,
            });
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
  };
  window.__harness = api;

  const pose = p.get('pose');
  if (pose) api.applyPose(pose);
  else if (p.get('eye')) {
    api.applyPose({ eye: p.get('eye').split(',').map(Number), pitch: +p.get('pitch') || 0, yaw: +p.get('yaw') || 0 });
  }
}
