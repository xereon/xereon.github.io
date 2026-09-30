// BASELINE STUB — rendering agent replaces this. See CONTRACT.md §8.
import * as THREE from 'three';

export class RenderPipeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.autoClear = false;
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x9ec3e6);
    this._camera = new THREE.PerspectiveCamera(74, 1, 1, 12000);
    this._viewScene = new THREE.Scene();
    this._viewCamera = new THREE.PerspectiveCamera(54, 1, 0.1, 200);
    const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x8a6a45, 1.2);
    this._scene.add(hemi);
    this._viewScene.add(hemi.clone());
    const sun = new THREE.DirectionalLight(0xfff0d0, 3);
    sun.position.set(1000, 2000, 600);
    this._scene.add(sun);
    this._viewScene.add(sun.clone());
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  get scene() { return this._scene; }
  get camera() { return this._camera; }
  get viewScene() { return this._viewScene; }
  get viewCamera() { return this._viewCamera; }
  setQuality() {}
  setMap() {}
  resize(w = innerWidth, h = innerHeight) {
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this._camera.aspect = this._viewCamera.aspect = w / h;
    this._camera.updateProjectionMatrix(); this._viewCamera.updateProjectionMatrix();
  }
  render() {
    const r = this.renderer;
    r.clear();
    r.render(this._scene, this._camera);
    r.clearDepth();
    r.render(this._viewScene, this._viewCamera);
  }
}
