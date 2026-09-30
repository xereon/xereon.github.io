// Analytic desert sky: saturated zenith, pale/cream horizon haze, Mie glow around the sun,
// sun disc (HDR, drives bloom) and faint high cirrus. The same GLSL is used by the sky dome,
// the GI bake (rays that escape), the atmosphere pass (fog colour) and the PMREM env map, so
// sky, ambient light and aerial perspective always agree.
import * as THREE from 'three';

// Shared uniform objects. Every shader that includes SKY_GLSL references these by identity.
export const skyUniforms = {
  rpSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() }, // unit vector TO the sun
  rpSkyZenith: { value: new THREE.Color() },   // radiance at zenith (linear HDR)
  rpSkyHorizon: { value: new THREE.Color() },  // radiance at the horizon
  rpSkyHaze: { value: new THREE.Color() },     // warm dust band right at the horizon / fog colour
  rpSkyGround: { value: new THREE.Color() },   // below-horizon radiance (distant terrain haze)
  rpSunGlow: { value: new THREE.Color() },     // Mie forward-scatter strength (radiance units)
  rpSunDisc: { value: new THREE.Color() },     // sun disc radiance
  rpSunCos: { value: Math.cos(0.65 * Math.PI / 180) },
  rpCirrus: { value: 0.55 },
  rpSkyTime: { value: 0 },
};

export const SKY_GLSL = /* glsl */`
uniform vec3 rpSunDir;
uniform vec3 rpSkyZenith, rpSkyHorizon, rpSkyHaze, rpSkyGround, rpSunGlow, rpSunDisc;
uniform float rpSunCos, rpCirrus, rpSkyTime;

float rpHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rpVNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rpHash12(i), b = rpHash12(i + vec2(1, 0)), c = rpHash12(i + vec2(0, 1)), d = rpHash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float rpFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * rpVNoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
// Henyey-Greenstein lobe normalised to 1 at mu = 1 (artist units)
float rpPhaseHG(float mu, float g) {
  float g2 = g * g;
  return pow((1.0 - g) * (1.0 - g) / max(1.0 + g2 - 2.0 * g * mu, 1e-5), 1.5);
}
// Sky radiance along a unit direction. disc: 1 = include the sun disc + cirrus (visible sky),
// 0 = smooth sky only (lighting / env).
vec3 rpSkyRadiance(vec3 d, float disc) {
  float y = d.y;
  float yh = max(y, 0.0);
  float mu = dot(d, rpSunDir);
  // Rayleigh-ish gradient: deep blue overhead, paler toward the horizon
  float g = pow(1.0 - yh, 2.6);
  vec3 col = mix(rpSkyZenith, rpSkyHorizon, g);
  // warm dust haze band hugging the horizon
  float haze = exp(-yh * 7.0);
  col = mix(col, rpSkyHaze, haze * 0.8);
  // Mie forward scatter: broad aureole + tight glow near the sun, stronger through haze
  col += rpSunGlow * (0.18 * rpPhaseHG(mu, 0.55) + 0.06 * rpPhaseHG(mu, 0.93)) * (0.55 + 0.45 * haze);
  // below the horizon: distant terrain / dust
  if (y < 0.0) col = mix(rpSkyHaze, rpSkyGround, 1.0 - exp(y * 5.0));
  if (disc > 0.0) {
    // high thin cirrus, streaked along one axis, fades toward the horizon
    if (y > 0.015 && rpCirrus > 0.0) {
      vec2 uv = d.xz / (y + 0.12);
      vec2 q = vec2(uv.x * 0.9 + uv.y * 0.4, uv.y * 2.6 - uv.x * 0.5) * 1.1 + rpSkyTime * vec2(0.002, 0.0007);
      float n = rpFbm(q);
      float w = rpFbm(q * 3.1 + n * 1.7);
      float c = smoothstep(0.52, 0.86, n * 0.75 + w * 0.35) * smoothstep(0.015, 0.22, y) * rpCirrus;
      vec3 cloudCol = rpSkyHorizon * 1.25 + rpSunGlow * 0.08 * rpPhaseHG(mu, 0.6);
      col = mix(col, cloudCol, c * 0.55);
    }
    // sun disc with limb darkening + a soft 1-2px rim so it antialiases
    float edge = smoothstep(rpSunCos - 0.000012, rpSunCos + 0.000008, mu);
    float r = clamp((1.0 - mu) / max(1.0 - rpSunCos, 1e-6), 0.0, 1.0);
    col += rpSunDisc * edge * (1.0 - 0.45 * r * r);
  }
  return col;
}
`;

// Sky dome: unit cube pinned to the far plane, drawn after all opaques (only sky pixels shade).
// Writes alpha 0 so the AO composite leaves it alone.
export function createSkyDome() {
  const mat = new THREE.ShaderMaterial({
    name: 'rp.sky',
    uniforms: { ...skyUniforms },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: SKY_GLSL + /* glsl */`
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        gl_FragColor = vec4(rpSkyRadiance(d, 1.0), 0.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  mesh.name = 'rp.skydome';
  mesh.frustumCulled = false;
  mesh.renderOrder = 100000;
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.rpSkip = true;
  return mesh;
}

// Env map for subtle IBL specular. Rendered from a private scene holding one sky dome
// without the disc (the sun's specular comes from the direct light).
export class SkyEnv {
  constructor(renderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene = new THREE.Scene();
    const dome = createSkyDome();
    dome.material = dome.material.clone();
    dome.material.uniforms = { ...skyUniforms };
    dome.material.fragmentShader = SKY_GLSL + /* glsl */`
      varying vec3 vDir;
      void main() { gl_FragColor = vec4(rpSkyRadiance(normalize(vDir), 0.0), 1.0); }`;
    this.scene.add(dome);
    this.rt = null;
  }
  update() {
    const old = this.rt;
    this.rt = this.pmrem.fromScene(this.scene, 0, 0.1, 10);
    old?.dispose();
    return this.rt.texture;
  }
  get texture() { return this.rt?.texture || null; }
}

// Fill skyUniforms from physical-ish inputs. E = sun irradiance (map intensity * cvar),
// sky = sky_intensity multiplier. All radiances are relative to E so exposure stays stable.
export function setSkyParams({ sunDir, sunColor, E, sky = 1 }) {
  const u = skyUniforms;
  u.rpSunDir.value.copy(sunDir).normalize();
  const elev = Math.max(0.05, u.rpSunDir.value.y);
  const k = E * sky;
  // Colours chosen to read as CS2 Dust II noon: pale-to-medium blue overhead, milky cream
  // horizon, warm dust at the very bottom.
  u.rpSkyZenith.value.setRGB(0.050, 0.108, 0.235).multiplyScalar(k);
  u.rpSkyHorizon.value.setRGB(0.150, 0.180, 0.215).multiplyScalar(k);
  u.rpSkyHaze.value.setRGB(0.205, 0.195, 0.175).multiplyScalar(k);
  u.rpSkyGround.value.setRGB(0.120, 0.105, 0.085).multiplyScalar(k);
  u.rpSunGlow.value.copy(sunColor).multiplyScalar(k * (0.9 + 0.6 * (1 - elev)));
  u.rpSunDisc.value.copy(sunColor).multiplyScalar(E * 60);
}
