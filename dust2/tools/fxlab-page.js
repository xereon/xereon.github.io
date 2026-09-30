// In-page side of the FX lab (tools/fxlab.html).
//   ?mode=atlas[&view=particles|dalbedo|dnormal|dorm]   texture atlases
//   (default)                                           courtyard + scripted shots
//   &pipe=game                                          use src/engine/renderer.js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World } from '../src/core/world.js';
import { applyViewAngles, angleVectors } from '../src/core/mathx.js';
import { CollisionWorld } from '../src/player/collision.js';
import { buildAtlases } from '../src/fx/atlas.js';

const params = new URLSearchParams(location.search);
const frames = (n) => new Promise((r) => { let k = n; const s = () => (--k <= 0 ? r() : requestAnimationFrame(s)); requestAnimationFrame(s); });

export async function boot() {
  if (params.get('mode') === 'atlas') return bootAtlas();
  return bootScene();
}

// ---------------------------------------------------------------------------------------
async function bootAtlas() {
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  const A = buildAtlases(renderer, { size: +params.get('size') || 2048 });
  const view = params.get('view') || 'particles';
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(0, innerWidth, innerHeight, 0, -1, 1);
  const tex = view === 'particles' ? A.particles : view === 'dnormal' ? A.decalNormal : view === 'dorm' ? A.decalOrm : A.decalAlbedo;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uView: { value: view === 'particles' ? 0 : view === 'dalbedo' ? 3 : 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D uTex; uniform int uView; varying vec2 vUv;
      void main(){
        vec4 t = texture2D(uTex, vUv);
        vec3 bg = mix(vec3(0.18,0.2,0.25), vec3(0.3,0.32,0.36), step(0.5, fract((floor(gl_FragCoord.x/16.0)+floor(gl_FragCoord.y/16.0))*0.5)));
        vec3 c;
        if (uView == 0) {
          vec3 n = vec3(t.g*2.0-1.0, t.b*2.0-1.0, 0.0); n.z = sqrt(max(0.0, 1.0-dot(n.xy,n.xy)));
          float l = clamp(dot(n, normalize(vec3(-0.5, 0.6, 0.6))), 0.0, 1.0) * 0.8 + 0.25;
          vec3 col = vec3(l) * (0.6 + 0.4*t.a);
          if (vUv.x > 0.5 && vUv.y < 0.5) { float T = t.a; col = vec3(1.0,0.35,0.05)*T*2.0 + vec3(1.0,0.8,0.4)*pow(T,3.0)*3.0; col = col/(1.0+col); }
          c = mix(bg, col, t.r);
        } else if (uView == 3) c = mix(bg, t.rgb, t.a);
        else c = t.rgb;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const s = Math.min(innerWidth, innerHeight);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), mat);
  m.position.set(innerWidth / 2, innerHeight / 2, 0);
  scene.add(m);
  renderer.render(scene, cam);
  window.__fxlab = { frames: async (n) => { renderer.render(scene, cam); await frames(n); } };
  window.__FXLAB_READY = true;
}

// ---------------------------------------------------------------------------------------
const L = {};   // lab state

async function bootScene() {
  const canvas = document.getElementById('game');
  let pipe;
  if (params.get('pipe') === 'game') {
    const R = await import('../src/engine/renderer.js');
    pipe = new R.RenderPipeline(canvas);
    pipe.setQuality?.(params.get('quality') || 'high');
  } else {
    pipe = new LabPipeline(canvas);
  }
  World.renderer = pipe;
  World.scene = pipe.scene; World.camera = pipe.camera;
  World.viewScene = pipe.viewScene; World.viewCamera = pipe.viewCamera;
  World.harness = true;

  let T = null;
  try { T = (await import('../src/art/textures.js')).TextureLib; await T.ready; } catch (e) { console.warn('[fxlab] no TextureLib', e); }
  World.textures = T;
  buildCourtyard(T);
  await pipe.setMap?.(World.map);

  const { FX } = await import('../src/fx/index.js');
  World.fx = new FX();
  L.fx = World.fx;
  setupEntities();
  buildViewGun();
  await pipe.precompile?.();
  L.probeDepth = probeDepth;
  window.__fxlab = { run, list: () => Object.keys(SHOTS), frames, L };
  window.__FXLAB_READY = true;
}

class LabPipeline {
  constructor(canvas) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(1);
    r.setSize(innerWidth, innerHeight, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = +params.get('exposure') || 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9ec3e6);
    this.camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 1, 12000);
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(54, innerWidth / innerHeight, 0.5, 400);
    const comp = this.composer = new EffectComposer(r);
    comp.addPass(new RenderPass(this.scene, this.camera));
    const vp = new RenderPass(this.viewScene, this.viewCamera);
    vp.clear = false; vp.clearDepth = true;
    comp.addPass(vp);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.6, 1.1);
    comp.addPass(this.bloom);
    comp.addPass(new OutputPass());
  }
  render() { this.renderer.info.autoReset = false; this.renderer.info.reset(); this.composer.render(); }
}

function buildCourtyard(T) {
  const scene = World.scene;
  const col = new CollisionWorld();
  const mat = (k, c) => T?.material?.(k) || new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 });
  const group = new THREE.Group();
  const box = (min, max, key, surf, color) => {
    const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    // world-scale UVs so textures don't stretch
    const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (min[0] + max[0]) / 2, y = pos.getY(i) + (min[1] + max[1]) / 2, z = pos.getZ(i) + (min[2] + max[2]) / 2;
      const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
      if (ny > 0.5) uv.setXY(i, x / 128, z / 128); else if (nx > 0.5) uv.setXY(i, z / 128, y / 128); else uv.setXY(i, x / 128, y / 128);
    }
    const m = new THREE.Mesh(g, mat(key, color));
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    col.addBox(new THREE.Vector3(...min), new THREE.Vector3(...max), surf);
  };
  box([-1400, -16, -1400], [1400, 0, 1400], 'sand_floor', 'sand', 0xcbb285);
  // back wall with a doorway into a corridor (x -64..64)
  box([-520, 0, -420], [-64, 260, -380], 'plaster_wall', 'plaster', 0xd9c49c);
  box([64, 0, -420], [520, 260, -380], 'plaster_wall', 'plaster', 0xd9c49c);
  box([-64, 200, -420], [64, 260, -380], 'plaster_wall', 'plaster', 0xd9c49c);
  // corridor
  box([-96, 0, -1100], [-64, 260, -420], 'concrete_wall', 'concrete', 0xb9ad98);
  box([64, 0, -1100], [96, 260, -420], 'concrete_wall', 'concrete', 0xb9ad98);
  // side walls
  box([-560, 0, -420], [-520, 260, 500], 'concrete_wall', 'concrete', 0xb9ad98);
  box([520, 0, -420], [560, 260, 500], 'brick_tan', 'brick', 0xc0976a);
  // metal door panel on the back wall
  box([220, 0, -380], [340, 200, -376], 'metal_door', 'metaldoor', 0x5b6f78);
  // crate, pillar, step, glass
  box([200, 0, -230], [264, 64, -166], 'wood_crate', 'crate', 0x9b7447);
  box([-280, 0, -180], [-232, 220, -132], 'concrete_wall', 'concrete', 0xb9ad98);
  box([-200, 0, -330], [-80, 24, -270], 'concrete_floor', 'concrete', 0xa89c88);
  box([-470, 30, 40], [-380, 130, 42], 'glass', 'glass', 0x88a0a8);
  col.build();
  scene.add(group);

  const sunDir = new THREE.Vector3(-0.45, -0.78, -0.43).normalize();
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
  sun.position.copy(sunDir).multiplyScalar(-2500);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1300, right: 1300, top: 1300, bottom: -1300, near: 10, far: 6000 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 1.5;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x9a7a55, 1.25);
  scene.add(hemi);
  scene.fog = new THREE.FogExp2(0xd8c8a8, 0.00012);
  World.viewScene.add(hemi.clone());
  const vsun = sun.clone(); vsun.castShadow = false; World.viewScene.add(vsun);

  World.collision = col;
  World.map = {
    root: group, collision: col,
    sun: { dir: sunDir, color: new THREE.Color(0xfff0d8), intensity: 3.2 },
    ambient: { sky: new THREE.Color(0xbfd6ff), ground: new THREE.Color(0x9a7a55), intensity: 1.25 },
    fog: { color: new THREE.Color(0xd8c8a8), density: 0.00012 },
    spawns: { T: [], CT: [] }, callouts: {},
  };
}

function setupEntities() {
  const mk = (name, x, y, z, pitch, yaw, isLocal) => ({
    name, alive: true, isLocal, origin: new THREE.Vector3(x, y, z), eyeHeight: 64, pitch, yaw,
    viewPunch: { pitch: 0, yaw: 0 },
    eyePos(out) { return out.set(this.origin.x, this.origin.y + 64, this.origin.z); },
  });
  L.local = mk('local', 0, 0, 400, 0, 90, true);
  L.bots = [mk('facing', -300, 0, 300, 0, 60), mk('side', 300, 0, 300, 0, 180), mk('behind', 0, 0, 700, 0, 270)];
  World.local = L.local;
  World.entities.length = 0;
  World.entities.push(L.local, ...L.bots);
}

// A crude stand-in gun in the view scene so viewmodel flashes have context.
function buildViewGun() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4526, roughness: 0.7 });
  const add = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };
  add(new THREE.BoxGeometry(2.2, 3.2, 16), dark, 0, 0, 0);
  add(new THREE.CylinderGeometry(0.45, 0.45, 12, 10).rotateX(Math.PI / 2), dark, 0, 0.6, -13);
  add(new THREE.BoxGeometry(2.0, 2.8, 8), wood, 0, -0.4, -9);
  add(new THREE.BoxGeometry(1.6, 5, 2.4), dark, 0, -3.5, 2);
  g.position.set(7.5, -8.5, -16);
  g.rotation.y = 0.05;
  World.viewScene.add(g);
  L.gun = g;
  L.muzzleLocal = new THREE.Vector3(7.5 - 0.95, -8.5 + 0.6, -16 - 19.4);
  g.visible = false;
}

// ---------------------------------------------------------------------------------------
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
function setCam(eye, pitch, yaw, fov = 74) {
  const cam = World.camera;
  cam.position.copy(eye);
  applyViewAngles(cam, pitch, yaw, 0);
  cam.fov = fov; cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  World.viewCamera.position.set(0, 0, 0); World.viewCamera.quaternion.identity();
  World.viewCamera.updateMatrixWorld(true);
  L.local.origin.set(eye.x, eye.y - 64, eye.z); L.local.pitch = pitch; L.local.yaw = yaw;
}
function muzzleWorld(out) { return out.copy(L.muzzleLocal).applyMatrix4(World.camera.matrixWorld); }
function camForward() { return new THREE.Vector3(0, 0, -1).transformDirection(World.camera.matrixWorld); }

// Deterministic spray: 30 impacts on the plaster wall.
function sprayOnWall(fx, t0, n, x0, y0, z, surf, spread = 70) {
  const acts = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996, r = spread * Math.sqrt((i + 0.5) / n);
    acts.push([t0 + i * 0.1, () => fx.impact(v3(x0 + Math.cos(a) * r, y0 + Math.sin(a) * r * 0.8, z), v3(0, 0, 1), surf)]);
  }
  return acts;
}

const SHOTS = {
  muzzle_rifle_side: {
    cam: [v3(-10, 70, 90), 4, 90 - 12], t: 0.017,
    acts: (fx) => [[0, () => fx.muzzleFlash(v3(-40, 64, 0), v3(1, 0, 0), 'ak47')]],
  },
  muzzle_classes: {
    cam: [v3(40, 64, 170), 0, 90], t: 0.017,
    acts: (fx) => [[0, () => {
      ['glock', 'ak47', 'nova', 'awp', 'usp'].forEach((k, i) => fx.muzzleFlash(v3(-160 + i * 80, 64, 0), v3(1, 0, -0.15).normalize(), k));
    }]],
  },
  muzzle_viewmodel: {
    cam: [v3(0, 64, 300), 2, 90], t: 0.017, gun: true,
    acts: (fx) => [[0, () => fx.muzzleFlash(muzzleWorld(new THREE.Vector3()), camForward(), 'ak47', { viewmodel: true })]],
  },
  muzzle_viewmodel_smoke: {
    cam: [v3(0, 64, 300), 2, 90], t: 0.9, gun: true,
    acts: (fx) => {
      const a = [];
      for (let i = 0; i < 8; i++) a.push([i * 0.1, () => fx.muzzleFlash(muzzleWorld(new THREE.Vector3()), camForward(), 'ak47', { viewmodel: true })]);
      return a;
    },
  },
  wall_impacts: {
    cam: [v3(0, 110, -140), 8, 90], t: 3.05,
    acts: (fx) => sprayOnWall(fx, 0, 30, -240, 120, -380, 'plaster'),
  },
  wall_decals: {
    cam: [v3(-240, 120, -300), 0, 90], t: 8,
    acts: (fx) => sprayOnWall(fx, 0, 30, -240, 120, -380, 'plaster'),
  },
  concrete_edge_decals: {
    cam: [v3(-130, 70, -200), 25, 110], t: 3,
    acts: (fx) => {
      const a = [];
      // hits along the step edge and the pillar corner: decals must not overhang
      for (let i = 0; i < 8; i++) a.push([i * 0.05, () => fx.impact(v3(-196 + i * 15, 24, -300 + (i % 3) * 8), v3(0, 1, 0), 'concrete')]);
      for (let i = 0; i < 6; i++) a.push([0.5 + i * 0.05, () => fx.impact(v3(-200 + i * 20, 12 + (i % 2) * 6, -270), v3(0, 0, 1), 'concrete')]);
      for (let i = 0; i < 6; i++) a.push([0.8 + i * 0.05, () => fx.impact(v3(-233 + (i % 2), 60 + i * 12, -134 - (i % 3)), v3(0, 0, 1), 'concrete')]);
      return a;
    },
  },
  metal_sparks: {
    cam: [v3(280, 100, -260), 10, 90], t: 0.47,
    acts: (fx) => sprayOnWall(fx, 0.1, 4, 280, 110, -376, 'metaldoor', 30),
  },
  wood_glass: {
    cam: [v3(160, 70, -40), 8, 55], t: 0.33,
    acts: (fx) => [...sprayOnWall(fx, 0, 3, 232, 36, -166, 'crate', 18)],
  },
  sand_impacts: {
    cam: [v3(0, 90, 260), 25, 90], t: 0.37,
    acts: (fx) => [0, 1, 2, 3].map((i) => [i * 0.1, () => fx.impact(v3(-60 + i * 40, 0, 60 + (i % 2) * 20), v3(0, 1, 0), 'sand')]),
  },
  tracers: {
    cam: [v3(300, 64, 200), 0, 150], t: 0.05,
    acts: (fx) => {
      const a = [];
      for (let i = 0; i < 6; i++) a.push([i * 0.01, () => fx.tracer(v3(-400, 60, 300), v3(400, 60 + i * 12, -380), 'ak47')]);
      return a;
    },
  },
  shells: {
    cam: [v3(60, 40, 120), 20, 120], t: 1.8,
    acts: (fx) => {
      const a = [];
      for (let i = 0; i < 12; i++) a.push([i * 0.1, () => fx.shell(v3(0, 60, 60), v3(20, 140 + (i % 3) * 20, 90 + (i % 4) * 10), i % 5 === 4 ? 'nova' : 'ak47')]);
      return a;
    },
  },
  blood: {
    cam: [v3(-60, 70, -150), 5, 60], t: 0.12,
    acts: (fx) => [[0, () => { fx.blood(v3(-20, 60, -300), v3(0, 0, -1), 1); fx.blood(v3(10, 52, -290), v3(0.2, -0.1, -1), 1); }]],
  },
  blood_after: {
    cam: [v3(-60, 70, -150), 5, 60], t: 3,
    acts: (fx) => [[0, () => { fx.blood(v3(-20, 60, -300), v3(0, 0, -1), 1); fx.blood(v3(10, 52, -290), v3(0.2, -0.1, -1), 1); }]],
  },
  smoke_0_5s: { cam: [v3(0, 90, 520), 5, 90], t: 0.5, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_1s: { cam: [v3(0, 90, 520), 5, 90], t: 1.0, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_3s: { cam: [v3(0, 90, 520), 5, 90], t: 3, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_15s: { cam: [v3(0, 90, 520), 5, 90], t: 15, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_17s: { cam: [v3(0, 90, 520), 5, 90], t: 17, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_backlit: { cam: [v3(-300, 70, -300), -8, 45 - 180 + 20], t: 3, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_edge: { cam: [v3(0, 64, 200), 0, 90], t: 3, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_inside: { cam: [v3(20, 64, 30), 0, 90], t: 3, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, 0)); }]] },
  smoke_corridor: { cam: [v3(300, 420, 60), 45, 120], t: 3, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, -440)); }]] },
  smoke_top: { cam: [v3(0, 900, 10), 89, 90], t: 3, acts: (fx) => [[0, () => { L.smoke = fx.smoke(v3(0, 2, -440)); }]] },
  flash: { cam: [v3(0, 64, 350), 0, 90], t: 0.03, acts: (fx) => [[0, () => fx.flash(v3(0, 90, 0))]] },
  flash_after: { cam: [v3(0, 64, 350), 0, 90], t: 2.6, acts: (fx) => [[0, () => fx.flash(v3(0, 90, 0))]] },
  he_fireball: { cam: [v3(0, 80, 420), 3, 90], t: 0.1, acts: (fx) => [[0, () => fx.explosion(v3(0, 2, 0))]] },
  he_0_4s: { cam: [v3(0, 80, 420), 3, 90], t: 0.4, acts: (fx) => [[0, () => fx.explosion(v3(0, 2, 0))]] },
  he_2s: { cam: [v3(0, 80, 420), 3, 90], t: 2.0, acts: (fx) => [[0, () => fx.explosion(v3(0, 2, 0))]] },
  molotov_1s: { cam: [v3(0, 110, 330), 12, 90], t: 1.0, acts: (fx) => [[0, () => { L.fire = fx.fire(v3(0, 1, 0), v3(0, 1, 0)); }]] },
  molotov_4s: { cam: [v3(0, 110, 330), 12, 90], t: 4.0, acts: (fx) => [[0, () => { L.fire = fx.fire(v3(0, 1, 0), v3(0, 1, 0)); }]] },
  molotov_wall: { cam: [v3(200, 130, -60), 25, 120], t: 3.0, acts: (fx) => [[0, () => { L.fire = fx.fire(v3(-10, 1, -330), v3(0, 1, 0)); }]] },
  molotov_smoked: { cam: [v3(0, 110, 330), 12, 90], t: 3.0, acts: (fx) => [[0, () => { L.fire = fx.fire(v3(0, 1, 0), v3(0, 1, 0)); }], [1.0, () => { L.smoke = fx.smoke(v3(30, 2, 20)); }]] },
};

async function run(name) {
  const S = SHOTS[name];
  if (!S) throw new Error(`unknown shot ${name}`);
  const fx = L.fx;
  fx.reset(true);
  fx.reseed(1337);
  World.paused = false;
  L.gun.visible = !!S.gun;
  const [eye, pitch, yaw, fov] = S.cam;
  setCam(eye, pitch, yaw, fov);
  const acts = S.acts(fx).sort((a, b) => a[0] - b[0]);
  const dt = 1 / 60;
  const t0 = fx.now;
  let ai = 0;
  const steps = Math.round(S.t / dt);
  const w0 = performance.now();
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    while (ai < acts.length && acts[ai][0] <= t + 1e-6) acts[ai++][1]();
    if (i < steps) fx.update(dt);
  }
  const simMs = performance.now() - w0;
  World.renderer.render(dt);
  await frames(2);
  const info = World.renderer.renderer?.info?.render || {};
  const out = { t: +(fx.now - t0).toFixed(3), simMs: Math.round(simMs), calls: info.calls, tris: info.triangles,
    parts: fx.pool.used, decals: fx.decals.count, depth: fx.depth.failed ? 'failed' : fx.depth.rt ? 'ok' : 'none' };
  if (L.smoke) out.smoke = { cells: L.smoke.nfilled, particles: L.smoke.np, maxD: Math.round(L.smoke.maxD), occ: +fx.smokeOcclusion(v3(0, 64, 400), v3(0, 64, -300)).toFixed(3), inside: +fx.smokes.inside.toFixed(2) };
  if (name.startsWith('flash')) out.blind = World.entities.map((e) => `${e.name}:${fx.blindAmount(e).toFixed(2)}`).join(' ');
  L.smoke = null;
  return out;
}

// Debug: sample the FX depth capture at a few screen points (raw depth values).
function probeDepth() {
  const d = L.fx.depth;
  if (!d.rt) return { err: 'no rt', failed: d.failed };
  const r = World.renderer.renderer;
  const rt = new THREE.WebGLRenderTarget(4, 1, { type: THREE.FloatType });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { t: { value: d.rt.depthTexture } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D t; void main(){ float x = (gl_FragCoord.x - 0.5) / 3.0; gl_FragColor = vec4(texture2D(t, vec2(0.1 + x * 0.8, 0.3)).r, texture2D(t, vec2(0.1 + x * 0.8, 0.7)).r, 0.0, 1.0); }',
  }));
  const sc = new THREE.Scene(); sc.add(m);
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt); r.render(sc, new THREE.Camera()); r.setRenderTarget(prev);
  const px = new Float32Array(16);
  r.readRenderTargetPixels(rt, 0, 0, 4, 1, px);
  return { key: d.key, failed: d.failed, px: Array.from(px).map((v) => +v.toFixed(5)), has: L.fx.depth.enabled };
}
