// HDR -> display: exposure, bloom composite, white balance, filmic tonemap (ACES fitted or
// AgX), sRGB encode, 3D colour-grade LUT (built on the CPU from the grade cvars), vignette.
// Output is display-referred sRGB, so SMAA and the final dither run in display space.
import * as THREE from 'three';
import { fsMaterial } from './common.js';

const FS = /* glsl */`
precision highp sampler3D;
uniform sampler2D tColor, tBloom;
uniform sampler3D tLUT;
uniform float uExposure, uBloom, uVignette, uTonemap, uLUTSize;
uniform vec3 uWB;
uniform vec2 uAspect;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c = IN * (c / 0.6);
  c = RRTAndODTFit(c);
  return clamp(OUT * c, 0.0, 1.0);
}
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 c) {
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  c = inset * (toRec2020 * c);
  c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  c = agxContrast(c);
  c = pow(max(outset * c, 0.0), vec3(2.2));
  return clamp(fromRec2020 * c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec3 c = texture(tColor, vUv).rgb;
  c += texture(tBloom, vUv).rgb * uBloom;
  c = max(c * uExposure * uWB, 0.0);
  c = uTonemap > 0.5 ? agx(c) : acesFitted(c);
  c = toSRGB(c);
  float s = (uLUTSize - 1.0) / uLUTSize, o = 0.5 / uLUTSize;
  c = texture(tLUT, c * s + o).rgb;
  // vignette: gentle, aspect-correct, darkens toward the corners only
  vec2 v = (vUv - 0.5) * uAspect;
  float vig = 1.0 - uVignette * smoothstep(0.35, 1.05, length(v));
  c *= vig;
  gl_FragColor = vec4(c, 1.0);
}`;

export class TonemapPass {
  constructor() {
    this.lut = null;
    this.material = fsMaterial({
      name: 'rp.tonemap', fragmentShader: FS,
      uniforms: {
        tColor: { value: null }, tBloom: { value: null }, tLUT: { value: null },
        uExposure: { value: 1 }, uBloom: { value: 0.05 }, uVignette: { value: 0.25 }, uTonemap: { value: 0 },
        uLUTSize: { value: 32 }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uAspect: { value: new THREE.Vector2(1, 1) },
      },
    });
  }
  setLUT(tex, size) {
    this.lut?.dispose();
    this.lut = tex;
    this.material.uniforms.tLUT.value = tex;
    this.material.uniforms.uLUTSize.value = size;
  }
}

// ---- grade LUT --------------------------------------------------------------------------
// Operates on display (sRGB-encoded) values after the tonemapper.
//   contrast: S-curve amount (1 = none, <1 flattens, >1 punchier; endpoints fixed)
//   saturation: luma-preserving
//   split tone: cool-neutral shadows, warm highlights
//   lift / gain: black and white points
export function buildGradeLUT(p, size = 32) {
  const data = new Uint16Array(size * size * size * 4);
  const toH = THREE.DataUtils.toHalfFloat;
  const S = (x) => x * x * (3 - 2 * x);
  const sh = p.shadowTint, hi = p.highlightTint;
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    let R = r / (size - 1), G = g / (size - 1), B = b / (size - 1);
    // contrast S-curve on each channel around mid grey (pivot 0.5 in display space)
    const k = p.contrast - 1;
    R = R + k * (S(R) - R); G = G + k * (S(G) - G); B = B + k * (S(B) - B);
    // saturation
    let L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    R = L + (R - L) * p.saturation; G = L + (G - L) * p.saturation; B = L + (B - L) * p.saturation;
    // split tone weighted by luma
    L = Math.min(1, Math.max(0, 0.2126 * R + 0.7152 * G + 0.0722 * B));
    const ws = (1 - L) * (1 - L), wh = L * L;
    R += sh[0] * ws + hi[0] * wh; G += sh[1] * ws + hi[1] * wh; B += sh[2] * ws + hi[2] * wh;
    // lift / gain
    R = p.lift + R * (p.gain - p.lift); G = p.lift + G * (p.gain - p.lift); B = p.lift + B * (p.gain - p.lift);
    data[i++] = toH(Math.min(1, Math.max(0, R)));
    data[i++] = toH(Math.min(1, Math.max(0, G)));
    data[i++] = toH(Math.min(1, Math.max(0, B)));
    data[i++] = toH(1);
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat; tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
