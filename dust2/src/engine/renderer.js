// Render pipeline. See CONTRACT.md §8.
//
//   world (HDR, half float) ── GTAO ──> atmosphere composite (AO on ambient only + height fog)
//     ──> viewmodel (same buffer, depth cleared) ──> bloom ──> tonemap + grade LUT + vignette
//     ──> SMAA (display space) ──> grain + dither ──> canvas
//
// Lighting: sun with 3 fitted cascades + a static whole-map cascade (csm.js), a baked
// irradiance volume for sky + multi-bounce sun (gi.js), all injected into every lit material
// by lighting.js. The sky model (sky.js) feeds the dome, the GI bake, the fog and the env map.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { Dbg } from '../core/debug.js';
import { skyUniforms, createSkyDome, SkyEnv, setSkyParams } from './sky.js';
import { SunShadows, STATIC_SLOT, shadowUniforms } from './csm.js';
import { lightUniforms, setupMaterial, setupTree } from './lighting.js';
import { GIVolume } from './gi.js';
import { GTAO } from './post/ao.js';
import { AtmospherePass } from './post/atmosphere.js';
import { Bloom } from './post/bloom.js';
import { TonemapPass, buildGradeLUT } from './post/tonemap.js';
import { FinalPass } from './post/final.js';
import { makeRT } from './post/common.js';

const CV = {
  exposure: [1.0, 0.05, 8, 'scene exposure (pre-tonemap multiplier)'],
  bloom_strength: [0.05, 0, 1, 'bloom mix'],
  bloom_threshold: [1.6, 0, 20, 'bloom luminance threshold (exposed HDR)'],
  ao_intensity: [1.5, 0, 4, 'GTAO power (0 = off)'],
  ao_radius: [42, 4, 200, 'GTAO world radius (units)'],
  fog_density: [1.0, 0, 10, 'height fog density (multiplier)'],
  sun_intensity: [1.0, 0, 4, 'sun intensity (x map value)'],
  sky_intensity: [1.0, 0, 4, 'sky light intensity (x) — rebakes GI'],
  bounce_intensity: [1.0, 0, 3, 'bounce light (x) — rebakes GI'],
  saturation: [0.96, 0, 2, 'grade saturation'],
  contrast: [1.0, 0.3, 2, 'grade S-curve (1 = neutral)'],
  grain: [0.15, 0, 3, 'film grain amount'],
  vignette: [0.22, 0, 1, 'vignette strength'],
  shadow_bias: [1.0, 0, 5, 'shadow bias (x)'],
  fov: [90, 50, 130, 'field of view (CS horizontal @4:3)'],
  warmth: [0.0, -1, 1, 'white balance: + warmer, - cooler'],
  r_tonemap: [0, 0, 1, '0 = ACES fitted, 1 = AgX'],
  r_ao: [1, 0, 1, 'ambient occlusion'],
  r_bloom: [1, 0, 1, 'bloom'],
  r_smaa: [1, 0, 1, 'SMAA'],
  r_gi: [1, 0, 1, 'irradiance volume (0 = flat hemisphere)'],
  r_shadows: [1, 0, 1, 'sun shadows'],
  r_debugview: [0, 0, 4, '1 indirect, 2 sun vis, 3 irradiance, 4 AO'],
  r_static_cache: [0, 0, 1, 'reuse the world render when nothing moved (on in the harness)'],
};
for (const [k, [v, a, b, h]] of Object.entries(CV)) defCvar(k, k === 'r_static_cache' && World.harness ? 1 : v, a, b, h);

const QUALITY = {
  low:    { pr: 0.8, ao: 0.5, aniso: 2, bloomLevels: 5 },
  medium: { pr: 1.0, ao: 0.5, aniso: 4, bloomLevels: 6 },
  high:   { pr: 1.0, ao: 1.0, aniso: 8, bloomLevels: 6 },
  ultra:  { pr: 2.0, ao: 1.0, aniso: 16, bloomLevels: 6 },
};

// Source fov (horizontal at 4:3) -> three vertical fov
export const vfov = (hfov) => 2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * 0.75) * (180 / Math.PI);

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _q3 = new THREE.Quaternion();

// ---- composer passes ------------------------------------------------------------------
class WorldPass extends Pass {
  constructor(p) { super(); this.p = p; this.needsSwap = false; }
  render(renderer) {
    const p = this.p;
    if (this.skip) return; // static frame: sceneRT + AO from last frame are still valid
    renderer.setRenderTarget(p.sceneRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(p._scene, p._camera);
    if (p.aoOn) p.gtao.render(renderer, p.sceneRT.depthTexture, p._camera);
  }
}

class AtmoPass extends Pass {
  constructor(p) { super(); this.p = p; this.quad = new FullScreenQuad(p.atmo.material); }
  render(renderer, writeBuffer) {
    const u = this.p.atmo.material.uniforms;
    u.tColor.value = this.p.sceneRT.texture;
    u.tDepth.value = this.p.sceneRT.depthTexture;
    renderer.setRenderTarget(writeBuffer);
    this.quad.render(renderer);
  }
}

class ViewmodelPass extends Pass {
  constructor(p) { super(); this.p = p; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) {
    if (!World.cvar.r_drawviewmodel) return;
    const vs = this.p._viewScene;
    if (vs.children.length <= this.p._vmBaseChildren) return;
    renderer.setRenderTarget(readBuffer);
    renderer.clear(false, true, false);
    renderer.render(vs, this.p._viewCamera);
  }
}

class BloomPass extends Pass {
  constructor(p) { super(); this.p = p; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) { this.p.bloom.render(renderer, readBuffer.texture); }
  setSize(w, h) { this.p.bloom.setSize(w, h); }
}

class ShaderStagePass extends Pass {
  constructor(material, input = 'tColor') { super(); this.material = material; this.input = input; this.quad = new FullScreenQuad(material); }
  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms[this.input].value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

// ---------------------------------------------------------------------------------------
export class RenderPipeline {
  constructor(canvas) {
    this.canvas = canvas;
    const r = this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = World.cvar.exposure ?? 1;
    r.autoClear = false;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    this.gl = r;
    // software rasterisers (SwiftShader in the screenshot harness) get cheaper filtering
    // settings that keep the same look; a real GPU never takes this path
    let gpu = '';
    try {
      const ctx = r.getContext();
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      gpu = String(ctx.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : ctx.RENDERER));
    } catch { /* ignore */ }
    this.gpu = gpu;
    this.software = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
    this.frame = 0;
    this._cvarEpoch = 0;
    this.quality = 'high';
    this.q = QUALITY.high;
    this.map = null;

    // scenes / cameras
    this._scene = new THREE.Scene();
    this._scene.name = 'world';
    this._camera = new THREE.PerspectiveCamera(vfov(World.cvar.fov ?? 90), 16 / 9, 1, 12000);
    this._viewScene = new THREE.Scene();
    this._viewScene.name = 'viewmodel';
    this._viewCamera = new THREE.PerspectiveCamera(vfov(68), 16 / 9, 0.5, 400);

    // sky + sun
    this.sky = createSkyDome();
    this._scene.add(this.sky);
    this.shadows = new SunShadows(this._scene);
    this.shadows.software = this.software;
    lightUniforms.rpSunDir = skyUniforms.rpSunDir;
    this.hemi = new THREE.HemisphereLight(0x9fb8d8, 0x8a6a45, 0.9); // unpatched materials only
    this.hemi.userData.rpSkip = true;
    this._scene.add(this.hemi);
    this.env = new SkyEnv(r);
    this.gi = new GIVolume(r);

    // viewmodel light rig: sun matching the world direction + soft key so guns read in shade
    this.vmSun = new THREE.DirectionalLight(0xffffff, 3);
    this.vmKey = new THREE.DirectionalLight(0xfff2e0, 0.35);
    this.vmHemi = new THREE.HemisphereLight(0x9fb8d8, 0x8a6a45, 0.8);
    for (const l of [this.vmSun, this.vmKey, this.vmHemi]) { l.userData.rpSkip = true; this._viewScene.add(l); }
    this._viewScene.add(this.vmSun.target, this.vmKey.target);
    this._vmBaseChildren = this._viewScene.children.length;
    this.vmSunVis = 1;

    // sun defaults until a map arrives
    this.sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
    this.sunColor = new THREE.Color(1, 0.95, 0.86);
    this.sunBase = 3;
    this.fogTint = new THREE.Color(1, 1, 1);

    // post
    this.sceneRT = makeRT(1, 1, {
      type: THREE.HalfFloatType, depth: true, name: 'rp.scene',
      depthTexture: Object.assign(new THREE.DepthTexture(1, 1), { type: THREE.UnsignedIntType }),
    });
    this.gtao = new GTAO();
    this.atmo = new AtmospherePass();
    this.atmo.material.uniforms.tAO.value = this.gtao.texture;
    this.atmo.material.uniforms.tAOZ.value = this.gtao.depthTexture;
    this.bloom = new Bloom(6);
    this.tonemap = new TonemapPass();
    this.tonemap.material.uniforms.tBloom.value = this.bloom.texture;
    this.final = new FinalPass();

    const crt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
    crt.texture.name = 'rp.composer';
    this.composer = new EffectComposer(r, crt);
    this.passWorld = new WorldPass(this);
    this.passAtmo = new AtmoPass(this);
    this.passVM = new ViewmodelPass(this);
    this.passBloom = new BloomPass(this);
    this.passTone = new ShaderStagePass(this.tonemap.material);
    this.passSMAA = new SMAAPass();
    this.passFinal = new ShaderStagePass(this.final.material);
    for (const p of [this.passWorld, this.passAtmo, this.passVM, this.passBloom, this.passTone, this.passSMAA, this.passFinal]) this.composer.addPass(p);

    this.tinyRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });

    this._applyCvars(true);
    this.setQuality(World.quality || 'high');
    this.resize();
    addEventListener('resize', () => this.resize());
    World.on('cvar', (e) => this._onCvar(e?.name));
    World.on('spawn', () => { this._matsDirty = true; });
  }

  get scene() { return this._scene; }
  get camera() { return this._camera; }
  get viewScene() { return this._viewScene; }
  get viewCamera() { return this._viewCamera; }
  get anisotropy() { return Math.min(this.q.aniso, this.renderer.capabilities.getMaxAnisotropy()); }

  // ---- quality ------------------------------------------------------------------------
  setQuality(q) {
    if (!QUALITY[q]) q = 'high';
    this.quality = q;
    this.q = QUALITY[q];
    World.quality = q;
    const changed = this.shadows.setQuality(q);
    this.gi.setQuality(q);
    this.gtao.setScale(this.software ? Math.min(0.5, this.q.ao) : this.q.ao);
    this.aoOn = (World.cvar.r_ao ?? 1) > 0 && (World.cvar.ao_intensity ?? 1) > 0;
    if (changed) this._recompileAll();
    this.resize();
    if (this.map) { this._giDirty = true; this._applyAniso(this.map.root); }
  }

  _recompileAll() {
    const bump = (o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) if (m.userData?.rpPatched) m.needsUpdate = true;
    };
    this._scene.traverse(bump);
    this._viewScene.traverse(bump);
  }

  resize(w = innerWidth, h = innerHeight) {
    const r = this.renderer;
    const pr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, this.q.pr);
    const prr = this.q.pr < 1 ? this.q.pr : pr;
    r.setPixelRatio(prr);
    r.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this._camera.aspect = this._viewCamera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._viewCamera.updateProjectionMatrix();
    const W = Math.max(1, Math.round(w * prr)), H = Math.max(1, Math.round(h * prr));
    this.sceneRT.setSize(W, H);
    this.gtao.setSize(W, H);
    this.composer.setPixelRatio(prr);
    this.composer.setSize(w, h);
    const a = this.atmo.material.uniforms;
    a.uAOTexel.value.set(1 / this.gtao.w, 1 / this.gtao.h);
    a.uAOHalf.value = this.gtao.scale < 0.99 ? 1 : 0;
    this.tonemap.material.uniforms.uAspect.value.set(w / Math.max(w, h) * 1.6, h / Math.max(w, h) * 1.6);
    this.size = { w, h, W, H };
  }

  // ---- map / lighting -----------------------------------------------------------------
  async setMap(map) {
    this.map = map;
    const t0 = performance.now();
    if (map.sun?.dir) this.sunDir.copy(map.sun.dir).negate().normalize();
    if (map.sun?.color) this.sunColor.copy(map.sun.color);
    if (map.sun?.intensity) this.sunBase = map.sun.intensity;
    if (map.fog?.color) {
      // haze tint relative to a neutral cream so the map can push it warmer/cooler
      const ref = new THREE.Color(0xd8c8a8);
      this.fogTint.setRGB(map.fog.color.r / ref.r, map.fog.color.g / ref.g, map.fog.color.b / ref.b);
    }
    // shadow flags: if the map manages castShadow itself, respect it; otherwise everything
    // opaque casts. (Receiving is unconditional in the patched shaders.)
    let managed = false;
    map.root.traverse((o) => { if (o.isMesh && o.castShadow) managed = true; });
    map.root.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = true;
      if (managed) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const opaque = mats.every((m) => m && !m.transparent && m.colorWrite !== false);
      if (opaque && !o.userData?.noShadow) o.castShadow = true;
    });
    setupTree(map.root, false);
    this._applyAniso(map.root);
    this.shadows.staticRoot = map.root;
    this.shadows.invalidate();
    this.bounds = GIVolume.bounds(map);
    this.shadows.setBounds(this.bounds);
    this._applySun();
    this.env.update();
    this._scene.environment = this.env.texture;
    this._scene.environmentIntensity = 0.6;
    this._viewScene.environment = this.env.texture;
    this._viewScene.environmentIntensity = 0.5;
    this._bakeGI();
    Dbg.log('[renderer] setMap', Math.round(performance.now() - t0), 'ms', this.gi.stats);
  }

  _sunE() { return this.sunBase * (World.cvar.sun_intensity ?? 1); }

  _applySun() {
    const E = this._sunE();
    const sky = World.cvar.sky_intensity ?? 1;
    setSkyParams({ sunDir: this.sunDir, sunColor: this.sunColor, E, sky });
    this.shadows.setSun(this.sunDir, this.sunColor, E);
    const u = skyUniforms;
    // fallback ambient (GI off / unpatched materials)
    const skyE = new THREE.Color().copy(u.rpSkyZenith.value).lerp(u.rpSkyHorizon.value, 0.5).multiplyScalar(Math.PI * 0.85);
    const gndE = this.sunColor.clone().multiplyScalar(E * 0.42 * 0.45 * this.sunDir.y);
    lightUniforms.rpAmbSky.value.copy(skyE);
    lightUniforms.rpAmbGround.value.copy(gndE).add(skyE.clone().multiplyScalar(0.25));
    this.hemi.color.copy(skyE); this.hemi.groundColor.copy(lightUniforms.rpAmbGround.value); this.hemi.intensity = 1;
    this.vmHemi.color.copy(skyE); this.vmHemi.groundColor.copy(lightUniforms.rpAmbGround.value); this.vmHemi.intensity = 1;
    this.vmSun.color.copy(this.sunColor); this.vmSun.intensity = E;
  }

  _primeShadows() {
    // one throwaway render populates every shadow map (static cascade included)
    this.shadows.lights[STATIC_SLOT].shadow.needsUpdate = true;
    this._camera.updateMatrixWorld();
    this.shadows.update(this._camera);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.tinyRT);
    r.render(this._scene, this._camera);
    r.setRenderTarget(prev);
  }

  _bakeGI() {
    this._giDirty = false;
    if (!this.map) return;
    try {
      this._primeShadows();
      const st = this.shadows.lights[STATIC_SLOT].shadow;
      const E = this._sunE();
      const u = skyUniforms;
      const guess = new THREE.Color().copy(u.rpSkyZenith.value).lerp(u.rpSkyHorizon.value, 0.5).multiplyScalar(Math.PI * 0.55)
        .add(this.sunColor.clone().multiplyScalar(E * 0.12));
      const cam = st.camera;
      this.gi.bake({
        map: this.map, bounds: this.bounds,
        sunMat: st.matrix, sunDepth: st.map.depthTexture, sunBias: 6 / (cam.far - cam.near),
        sunE: this.sunColor.clone().multiplyScalar(E), bounce: World.cvar.bounce_intensity ?? 1,
        openSkyGuess: guess,
      });
      lightUniforms.rpGIOn.value = (World.cvar.r_gi ?? 1) > 0 ? 1 : 0;
    } catch (e) {
      console.warn('[renderer] GI bake failed, using flat ambient', e);
      lightUniforms.rpGIOn.value = 0;
    }
  }

  _applyAniso(root) {
    const a = this.anisotropy;
    const seen = new Set();
    root.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
        const t = m[k];
        if (!t || seen.has(t)) continue;
        seen.add(t);
        if (t.isRenderTargetTexture || t.anisotropy === a) continue;
        const img = t.image;
        if (!img || !(img.data || img.width)) continue;
        t.anisotropy = a;
        t.needsUpdate = true;
      }
    });
  }

  /** Hook any material added after load (characters, props, FX). */
  setupMaterial(m, viewmodel = false) { return setupMaterial(m, viewmodel); }

  /** CPU ambient irradiance at a point (for FX/HUD tinting). */
  ambientAt(pos, n = _v2.set(0, 1, 0), out) { return this.gi.ambientAt(pos, n, out); }

  // ---- cvars ----------------------------------------------------------------------------
  _onCvar(name) {
    if (!name || !(name in CV)) return;
    this._cvarEpoch = (this._cvarEpoch || 0) + 1;
    if (name === 'sun_intensity' || name === 'sky_intensity') {
      this._applySun();
      if (this.map) { this.env.update(); this._giDirty = true; }
    } else if (name === 'bounce_intensity') this._giDirty = true;
    else if (name === 'r_gi') lightUniforms.rpGIOn.value = World.cvar.r_gi > 0 && this.gi.ready ? 1 : 0;
    else if (name === 'saturation' || name === 'contrast') this._buildLUT();
    else if (name === 'shadow_bias') this.shadows.setBias(World.cvar.shadow_bias);
    else if (name === 'fov') { this._camera.fov = vfov(World.cvar.fov); this._camera.updateProjectionMatrix(); }
    this._applyCvars(false);
  }

  _applyCvars(init) {
    const c = World.cvar;
    this.renderer.toneMappingExposure = c.exposure;
    const T = this.tonemap.material.uniforms;
    T.uExposure.value = c.exposure;
    T.uBloom.value = c.r_bloom ? c.bloom_strength : 0;
    T.uVignette.value = c.vignette;
    T.uTonemap.value = c.r_tonemap;
    const w = c.warmth;
    T.uWB.value.set(1 + 0.08 * w, 1 + 0.01 * w, 1 - 0.08 * w);
    this.bloom.threshold = c.bloom_threshold;
    this.bloom.exposure = c.exposure;
    this.passBloom.enabled = !!c.r_bloom;
    this.gtao.radius = c.ao_radius;
    this.gtao.power = Math.max(0.01, c.ao_intensity);
    this.aoOn = c.r_ao > 0 && c.ao_intensity > 0;
    const A = this.atmo.material.uniforms;
    A.uAOOn.value = this.aoOn ? 1 : 0;
    A.uFog.value.x = 1.15e-4 * c.fog_density;
    A.uFogTint.value.copy(this.fogTint);
    A.uDebug.value = c.r_debugview === 4 ? 1 : 0;
    lightUniforms.rpDebug.value = c.r_debugview < 4 ? c.r_debugview : 0;
    shadowUniforms.rpShadowOn.value = c.r_shadows ? 1 : 0;
    this.passSMAA.enabled = !!c.r_smaa;
    this.final.material.uniforms.uGrain.value = c.grain;
    if (init) {
      this._buildLUT();
      this._camera.fov = vfov(c.fov);
      this._camera.updateProjectionMatrix();
    }
  }

  _buildLUT() {
    const c = World.cvar;
    const lut = buildGradeLUT({
      contrast: c.contrast, saturation: c.saturation,
      shadowTint: [-0.010, 0.002, 0.014], highlightTint: [0.018, 0.008, -0.016],
      lift: 0.004, gain: 0.995,
    });
    this.tonemap.setLUT(lut, 32);
  }

  // ---- per frame ----------------------------------------------------------------------
  _updateViewmodelLighting(dt) {
    const cam = this._camera, vc = this._viewCamera;
    vc.updateMatrixWorld();
    // rotation taking viewScene-world vectors to world: R_cam * R_vc^-1
    cam.getWorldQuaternion(_q);
    vc.getWorldQuaternion(_q2).invert();
    const rot = _q.multiply(_q2);
    lightUniforms.rpVMRot.value.setFromMatrix4(_m4.makeRotationFromQuaternion(rot));
    cam.getWorldPosition(lightUniforms.rpVMPos.value);
    // sun direction in viewScene space
    _q3.copy(rot).invert();
    _v.copy(this.sunDir).applyQuaternion(_q3);
    this.vmSun.position.copy(_v).multiplyScalar(100);
    this.vmSun.target.position.set(0, 0, 0);
    // key light from upper-left of the view
    vc.getWorldQuaternion(_q2);
    this.vmKey.position.set(-0.55, 0.65, 0.5).applyQuaternion(_q2).multiplyScalar(100);
    // sun visibility at the eye (one ray per frame, smoothed)
    const col = World.collision;
    let vis = 1;
    if (col?.rayTrace && this.map) {
      _v.copy(lightUniforms.rpVMPos.value);
      _v2.copy(_v).addScaledVector(this.sunDir, 6000);
      const tr = col.rayTrace(_v, _v2, 1);
      vis = tr && tr.fraction < 1 ? 0 : 1;
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 10) : 1;
    this.vmSunVis += (vis - this.vmSunVis) * k;
    lightUniforms.rpVMSun.value = this.vmSunVis;
    this.vmKey.intensity = 0.25 + 0.35 * (1 - this.vmSunVis);
  }

  render(dt = 0) {
    const r = this.renderer;
    r.info.reset();
    this.frame++;
    if (this._giDirty && this.map) this._bakeGI();
    if (this._matsDirty || this.frame % 20 === 1) {
      this._matsDirty = false;
      setupTree(this._scene, false);
      setupTree(this._viewScene, true);
    }
    const cam = this._camera;
    cam.updateMatrixWorld();
    this.shadows.update(cam);
    // static-frame cache (harness): identical camera + scene -> skip the world pass
    const ce = cam.matrixWorld.elements, pe = cam.projectionMatrix.elements;
    const sig = ce[0] * 1.7 + ce[1] * 2.9 + ce[2] * 3.1 + ce[4] * 4.3 + ce[5] * 5.3 + ce[6] * 6.1 + ce[12] * 0.71 + ce[13] * 0.83 +
      ce[14] * 0.97 + pe[0] * 7.3 + pe[5] * 8.9 + (this.shadows.sceneHash || 0) + this._cvarEpoch * 13.7 + this.gi.epoch * 17.1 +
      (this.size?.W || 0) * 0.19 + (this.size?.H || 0) * 0.23;
    this.passWorld.skip = !!World.cvar.r_static_cache && sig === this._lastSig && !this.profile;
    this._lastSig = sig;
    this.atmo.update(cam);
    skyUniforms.rpSkyTime.value += dt;
    this.final.material.uniforms.uTime.value = (this.final.material.uniforms.uTime.value + dt) % 1000;
    if (this.profile) this._profileRender(dt);
    else this.composer.render(dt);
  }

  // Debug: run each pass with a GPU sync after it and record CPU-side ms (SwiftShader-safe).
  _profileRender(dt) {
    const r = this.renderer, gl = r.getContext();
    const px = new Uint8Array(4);
    this._syncRT ??= new THREE.WebGLRenderTarget(1, 1);
    const sync = () => { const prev = r.getRenderTarget(); r.setRenderTarget(this._syncRT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); r.setRenderTarget(prev); };
    const t = {};
    const comp = this.composer;
    let now = performance.now();
    sync();
    t.pre = performance.now() - now;
    const names = ['world', 'atmo', 'vm', 'bloom', 'tone', 'smaa', 'final'];
    // split the world pass: shadows+scene vs AO
    const aoOn = this.aoOn;
    this.aoOn = false;
    comp.passes.forEach((p, i) => {
      if (!p.enabled) return;
      now = performance.now();
      p.renderToScreen = comp.isLastEnabledPass(i);
      p.render(r, comp.writeBuffer, comp.readBuffer, dt, false);
      if (p.needsSwap) comp.swapBuffers();
      sync();
      t[names[i] || i] = +(performance.now() - now).toFixed(1);
      if (i === 0 && aoOn) {
        now = performance.now();
        this.gtao.render(r, this.sceneRT.depthTexture, this._camera);
        sync();
        t.ao = +(performance.now() - now).toFixed(1);
      }
    });
    this.aoOn = aoOn;
    this.lastProfile = t;
  }

  async precompile() {
    setupTree(this._scene, false);
    setupTree(this._viewScene, true);
    const r = this.renderer;
    try {
      await r.compileAsync(this._scene, this._camera);
      await r.compileAsync(this._viewScene, this._viewCamera);
    } catch (e) { Dbg.warn('[renderer] compileAsync failed', e); }
    this.render(0); // warms every post shader
  }

  stats() {
    return { quality: this.quality, gi: this.gi.stats, shadowTexels: this.shadows.texels(), size: this.size };
  }
}
