// Scene-depth capture for soft particles.
//
// The world pass writes depth into whatever render target the pipeline uses. Sampling that
// attachment while it is bound would be a feedback loop, so right before the first FX
// transparent draw (all opaque geometry is done by then) we blit its depth into our own
// DepthTexture with the exact same internal format. If anything doesn't line up (default
// framebuffer, log/reversed depth, a GL error on the first blit) we silently fall back to
// no depth softening. If the RenderPipeline exposes its own sample-safe `fxDepthTexture`,
// that is used instead.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { shared } from './lighting.js';

export class DepthCapture {
  constructor() {
    this.rt = null;
    this.key = '';
    this.failed = false;
    this.checked = false;
    this.frame = -1;
    this.enabled = true;
    // Invisible hook object: its onBeforeRender runs between opaque and transparent FX.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, colorWrite: false });
    this.hook = new THREE.Mesh(g, m);
    this.hook.frustumCulled = false;
    this.hook.renderOrder = 5;
    this.hook.userData.fx = true;
    this.hook.onBeforeRender = (renderer, scene, camera) => this.capture(renderer, camera);
  }

  capture(renderer, camera) {
    shared.uHasDepth.value = 0;
    if (!this.enabled || this.failed) return;
    if (camera !== World.camera && !camera.userData?.fxDepth) return;
    const ext = World.renderer?.fxDepthTexture;
    if (ext?.isTexture) {
      shared.uDepth.value = ext;
      shared.uDepthRes.value.set(ext.image?.width || 1, ext.image?.height || 1);
      shared.uNearFar.value.set(camera.near, camera.far);
      shared.uHasDepth.value = 1;
      return;
    }
    const caps = renderer.capabilities;
    if (caps.logarithmicDepthBuffer || caps.reversedDepthBuffer) return;
    const target = renderer.getRenderTarget();
    if (!target || !target.depthBuffer || target.isWebGLCubeRenderTarget || renderer.getActiveMipmapLevel?.() > 0) return;
    const w = target.width, h = target.height;
    const stencil = !!target.stencilBuffer;
    const dtype = target.depthTexture?.isDepthTexture ? target.depthTexture.type : THREE.UnsignedIntType;
    const key = `${w}x${h}:${stencil}:${dtype}`;
    const gl = renderer.getContext();
    if (key !== this.key) {
      this.rt?.dispose();
      const dt = new THREE.DepthTexture(w, h, stencil ? THREE.UnsignedInt248Type : dtype);
      dt.format = stencil ? THREE.DepthStencilFormat : THREE.DepthFormat;
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      this.rt = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: stencil, depthTexture: dt,
      });
      // Allocate GL objects now (must not disturb the in-flight render target).
      const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      renderer.initRenderTarget(this.rt);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
      this.key = key;
      this.checked = false;
    }
    const dst = renderer.properties.get(this.rt).__webglFramebuffer;
    if (!dst) return;
    const src = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, src);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    if (!this.checked) {
      this.checked = true;
      const err = gl.getError();
      if (err !== gl.NO_ERROR) { this.failed = true; return; }
    }
    shared.uDepth.value = this.rt.depthTexture;
    shared.uDepthRes.value.set(w, h);
    shared.uNearFar.value.set(camera.near, camera.far);
    shared.uHasDepth.value = 1;
  }

  dispose() { this.rt?.dispose(); }
}
