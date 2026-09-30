// Last pass (after SMAA): fine animated film grain + triangular dither to kill 8-bit banding
// in the sky gradient. Writes straight to the canvas.
import * as THREE from 'three';
import { fsMaterial, NOISE_GLSL } from './common.js';

const FS = NOISE_GLSL + /* glsl */`
uniform sampler2D tColor;
uniform float uGrain, uTime;
varying vec2 vUv;
void main() {
  vec3 c = texture(tColor, vUv).rgb;
  vec2 p = gl_FragCoord.xy;
  float t = fract(uTime * 7.31) * 97.0;
  // grain: luma-weighted (mid-tones), roughly Gaussian from two uniforms
  float n = rpHash(p + t) + rpHash(p * 1.37 + t + 17.0) - 1.0;
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += n * uGrain * (0.35 + L * (1.0 - L) * 2.6) * 0.12;
  // triangular-PDF dither at 1 LSB
  float d = rpHash(p + t * 1.7 + 3.1) + rpHash(p.yx + t * 0.7 + 9.2) - 1.0;
  c += d / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

export class FinalPass {
  constructor() {
    this.material = fsMaterial({ name: 'rp.final', fragmentShader: FS, uniforms: {
      tColor: { value: null }, uGrain: { value: 0.3 }, uTime: { value: 0 },
    } });
  }
}
