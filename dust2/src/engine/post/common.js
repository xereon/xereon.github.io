// Small helpers shared by the post passes.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export function fsMaterial({ name, uniforms, fragmentShader, defines = {}, blending = THREE.NoBlending }) {
  return new THREE.ShaderMaterial({
    name, uniforms, defines, fragmentShader, vertexShader: FS_VERT,
    depthTest: false, depthWrite: false, blending, toneMapped: false,
  });
}

export function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: opts.type ?? THREE.HalfFloatType,
    format: opts.format ?? THREE.RGBAFormat,
    minFilter: opts.filter ?? THREE.LinearFilter,
    magFilter: opts.filter ?? THREE.LinearFilter,
    depthBuffer: !!opts.depth,
    stencilBuffer: false,
    depthTexture: opts.depthTexture || null,
    generateMipmaps: false,
  });
  rt.texture.name = opts.name || 'rp.rt';
  return rt;
}

export class Blitter {
  constructor() { this.quad = new FullScreenQuad(null); }
  draw(renderer, material, target) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }
  dispose() { this.quad.dispose(); }
}

// Linear view depth from a hardware depth sample (perspective).
export const DEPTH_GLSL = /* glsl */`
uniform vec2 uNearFar;
float rpLinearDepth(float d) {
  float n = uNearFar.x, f = uNearFar.y;
  return (n * f) / (f - d * (f - n));
}
`;

export const NOISE_GLSL = /* glsl */`
float rpIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float rpHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
