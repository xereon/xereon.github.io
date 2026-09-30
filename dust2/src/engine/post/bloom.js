// Physically-based bloom: luminance threshold with soft knee + Karis average on the first
// downsample (no fireflies), 13-tap downsample chain, 9-tap tent upsample accumulation.
// Only genuinely hot pixels (sun disc, muzzle flash, specular glints) contribute.
import * as THREE from 'three';
import { fsMaterial, makeRT, Blitter } from './common.js';

const DOWN_FS = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uPrefilter, uThreshold, uKnee, uExposure;
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float kw(vec3 c) { return 1.0 / (1.0 + lum(c)); }
void main() {
  vec2 t = uTexel;
  vec3 a = texture(tSrc, vUv + t * vec2(-2, 2)).rgb, b = texture(tSrc, vUv + t * vec2(0, 2)).rgb, c = texture(tSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture(tSrc, vUv + t * vec2(-2, 0)).rgb, e = texture(tSrc, vUv).rgb, f = texture(tSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture(tSrc, vUv + t * vec2(-2, -2)).rgb, h = texture(tSrc, vUv + t * vec2(0, -2)).rgb, i = texture(tSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture(tSrc, vUv + t * vec2(-1, 1)).rgb, k = texture(tSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture(tSrc, vUv + t * vec2(-1, -1)).rgb, m = texture(tSrc, vUv + t * vec2(1, -1)).rgb;
  vec3 o;
  if (uPrefilter > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    // Karis average: luma-weighted so one hot texel can't flicker a whole bloom tile
    float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
    o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    o *= uExposure;
    float br = lum(o);
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = rq * rq / (4.0 * uKnee + 1e-4);
    o *= max(rq, br - uThreshold) / max(br, 1e-4);
    o = min(o, vec3(200.0));
  } else {
    o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(o, 1.0);
}`;

const UP_FS = /* glsl */`
uniform sampler2D tLow, tHigh;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tLow, vUv).rgb * 4.0;
  s += (texture(tLow, vUv + vec2(-t.x, 0)).rgb + texture(tLow, vUv + vec2(t.x, 0)).rgb +
        texture(tLow, vUv + vec2(0, -t.y)).rgb + texture(tLow, vUv + vec2(0, t.y)).rgb) * 2.0;
  s += texture(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture(tLow, vUv + vec2(t.x, -t.y)).rgb +
       texture(tLow, vUv + vec2(-t.x, t.y)).rgb + texture(tLow, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(texture(tHigh, vUv).rgb + s / 16.0, 1.0);
}`;

export class Bloom {
  constructor(levels = 6) {
    this.levels = levels;
    this.threshold = 1.4;
    this.knee = 0.5;
    this.exposure = 1;
    this.blit = new Blitter();
    this.down = []; this.up = [];
    for (let i = 0; i < levels; i++) {
      this.down.push(makeRT(1, 1, { name: `rp.bloomD${i}` }));
      if (i < levels - 1) this.up.push(makeRT(1, 1, { name: `rp.bloomU${i}` }));
    }
    this.downMat = fsMaterial({ name: 'rp.bloom.down', fragmentShader: DOWN_FS, uniforms: {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 },
      uThreshold: { value: 1 }, uKnee: { value: 0.5 }, uExposure: { value: 1 },
    } });
    this.upMat = fsMaterial({ name: 'rp.bloom.up', fragmentShader: UP_FS, uniforms: {
      tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 },
    } });
  }
  get texture() { return (this.up[0] || this.down[0]).texture; }
  setSize(w, h) {
    let cw = w, ch = h;
    for (let i = 0; i < this.levels; i++) {
      cw = Math.max(1, Math.ceil(cw / 2)); ch = Math.max(1, Math.ceil(ch / 2));
      this.down[i].setSize(cw, ch);
      if (i < this.levels - 1) this.up[i].setSize(cw, ch);
    }
    this.srcW = w; this.srcH = h;
  }
  render(renderer, src) {
    const D = this.downMat.uniforms;
    D.uThreshold.value = this.threshold; D.uKnee.value = this.knee; D.uExposure.value = this.exposure;
    let input = src, iw = this.srcW, ih = this.srcH;
    for (let i = 0; i < this.levels; i++) {
      D.tSrc.value = input;
      D.uTexel.value.set(1 / iw, 1 / ih);
      D.uPrefilter.value = i === 0 ? 1 : 0;
      this.blit.draw(renderer, this.downMat, this.down[i]);
      input = this.down[i].texture; iw = this.down[i].width; ih = this.down[i].height;
    }
    const U = this.upMat.uniforms;
    let low = this.down[this.levels - 1];
    for (let i = this.levels - 2; i >= 0; i--) {
      U.tLow.value = low.texture; U.tHigh.value = this.down[i].texture;
      U.uTexel.value.set(1 / low.width, 1 / low.height);
      U.uRadius.value = 1;
      this.blit.draw(renderer, this.upMat, this.up[i]);
      low = this.up[i];
    }
  }
}
