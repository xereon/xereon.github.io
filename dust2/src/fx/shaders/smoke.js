// Smoke-grenade volume shaders (sorted billboard set, see smoke.js).
import { ATLAS_GLSL } from './particle.js';

export const SMOKE_VERT = /* glsl */`
precision highp float;
attribute vec2 corner;
attribute vec4 s0; // target.xyz, revealT
attribute vec4 s1; // start.xyz, fadeStart
attribute vec4 s2; // size, rot0, rotSpeed, seed
attribute vec4 s3; // sunVis, ambVis, alpha, floorY
uniform float uTime;
uniform vec4 uBlast[4];
uniform float uAtlasTexel;
uniform mat4 uCamWorld;
varying vec4 vUvAB;
varying float vBlend;
varying float vAlpha;
varying vec3 vViewPos;
varying vec3 vWorld;
varying vec2 vRot;
varying vec2 vLight;
varying float vFloorY;
varying float vSize;
#include <fog_pars_vertex>
${ATLAS_GLSL}
void main() {
  float age = uTime - s0.w;
  float fadeT = uTime - s1.w;
  if (age < 0.0 || fadeT > 2.6) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float m = 1.0 - exp(-age * 4.2);
  float sd = s2.w * 6.2831;
  vec3 pos = mix(s1.xyz, s0.xyz, m);
  float drift = min(age, 20.0);
  pos += vec3(sin(uTime * 0.21 + sd), 0.4 * sin(uTime * 0.16 + sd * 1.3), cos(uTime * 0.18 + sd * 0.7)) * 4.5 * m;
  pos.y += drift * 0.35;
  float fp = smoothstep(0.0, 2.4, fadeT);
  float size = s2.x * mix(0.3, 1.0, m) * (1.0 + 0.35 * fp);
  float alpha = s3.z * smoothstep(0.0, 0.3, age) * (1.0 - smoothstep(0.0, 2.0, fadeT));
  for (int i = 0; i < 4; i++) {
    vec4 b = uBlast[i];
    float bt = uTime - b.w;
    if (bt > 0.0 && bt < 5.0) {
      vec3 d = pos - b.xyz;
      float dl = length(d);
      float infl = 1.0 - smoothstep(50.0, 230.0, dl);
      float rec = 1.0 - smoothstep(1.2, 5.0, bt);
      pos += (d / max(dl, 1.0)) * infl * (1.0 - exp(-bt * 7.0)) * 110.0 * rec;
      alpha *= 1.0 - infl * 0.9 * rec;
    }
  }
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec3 viewDir = normalize(mv.xyz);
  float rot = s2.y + s2.z * uTime;
  float c = cos(rot), s = sin(rot);
  // face the eye (not the view plane): stable when huge sprites surround the camera
  vec3 up = abs(viewDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 r0 = normalize(cross(viewDir, up)), u0 = cross(r0, viewDir);
  vec3 ax = (r0 * c + u0 * s) * size, ay = (-r0 * s + u0 * c) * size;
  vec3 vpos = mv.xyz + ax * corner.x + ay * corner.y;
  gl_Position = projectionMatrix * vec4(vpos, 1.0);
  vViewPos = vpos;
  vWorld = (uCamWorld * vec4(vpos, 1.0)).xyz;
  vRot = vec2(c, s);
  // flipbook: dense frames 0-7 churn slowly; dissipation walks into the wispy frames
  float f = mod(uTime * 0.3 + s2.w * 8.0, 14.0);
  f = f > 7.0 ? 14.0 - f : f;
  f = mix(f, 7.0 + fp * 7.99, fp);
  float fa = floor(f);
  vBlend = f - fa;
  vec2 cuv = (corner * 0.5 + 0.5) * (0.125 - 2.0 * uAtlasTexel) + uAtlasTexel;
  vUvAB = vec4(spriteOrigin(fa) + cuv, spriteOrigin(min(fa + 1.0, 15.0)) + cuv);
  vAlpha = alpha;
  vLight = s3.xy;
  vFloorY = s3.w;
  vSize = size;
  vec4 mvPosition = vec4(vpos, 1.0);
  #include <fog_vertex>
}`;

export const SMOKE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uSunDirV;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
uniform vec3 uAlbedo;
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform vec2 uDepthRes;
uniform vec2 uNearFar;
uniform vec2 uNearFade;
varying vec4 vUvAB;
varying float vBlend;
varying float vAlpha;
varying vec3 vViewPos;
varying vec3 vWorld;
varying vec2 vRot;
varying vec2 vLight;
varying float vFloorY;
varying float vSize;
#include <fog_pars_fragment>
const float PI = 3.14159265;
float linDepth(float d) {
  float n = uNearFar.x, f = uNearFar.y;
  return 2.0 * n * f / (f + n - (d * 2.0 - 1.0) * (f - n));
}
void main() {
  vec4 t = mix(texture2D(uAtlas, vUvAB.xy), texture2D(uAtlas, vUvAB.zw), vBlend);
  float a = t.r * vAlpha;
  if (a < 0.003) discard;
  vec3 n = vec3(t.g * 2.0 - 1.0, t.b * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  n.xy = vec2(vRot.x * n.x - vRot.y * n.y, vRot.y * n.x + vRot.x * n.y);
  // sprite plane faces the eye: rebuild view-space normal around the view ray
  vec3 V = normalize(-vViewPos);
  vec3 up = abs(V.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 r0 = normalize(cross(-V, up)), u0 = cross(r0, -V);
  vec3 nv = normalize(r0 * n.x + u0 * n.y + V * n.z);
  float ndl = dot(nv, uSunDirV);
  float sunVis = vLight.x;
  // wrapped diffuse, darker core where the puff is thick; self-shadow from the volume march
  float diff = max(0.0, (ndl + 0.3) / 1.3);
  float thick = mix(1.0, 0.65, t.r);
  float fwd = pow(max(0.0, dot(-V, uSunDirV)), 5.0) * (1.0 - t.r) * 1.2;
  vec3 nW = (vec4(nv, 0.0) * viewMatrix).xyz;
  vec3 amb = mix(uGroundCol, uSkyCol, clamp(nW.y * 0.5 + 0.6, 0.0, 1.0)) * vLight.y;
  float cav = mix(0.7, 1.0, t.a);
  vec3 col = uAlbedo * (uSunCol * (diff * thick + fwd) * sunVis + amb * cav) / PI;
  if (uHasDepth > 0.5) {
    float sd = linDepth(texture2D(uDepth, gl_FragCoord.xy / uDepthRes).r);
    a *= clamp((sd + vViewPos.z) / max(vSize * 0.5, 4.0), 0.0, 1.0);
  }
  a *= smoothstep(vFloorY, vFloorY + vSize * 0.3, vWorld.y);
  a *= smoothstep(uNearFade.x, uNearFade.y, -vViewPos.z);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor, fogF);
  #endif
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= a;
}`;

// Full-screen smoke fog when the eye is inside a volume.
export const FOG_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
export const FOG_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uAspect;
varying vec2 vUv;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), f.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 q = vec2(vUv.x * uAspect, vUv.y) * 3.0;
  float n = vn(q + vec2(uTime * 0.07, uTime * 0.04)) * 0.55 + vn(q * 2.3 - vec2(uTime * 0.05, 0.0)) * 0.3 + vn(q * 5.1) * 0.15;
  // brighter toward the top of the view (sky light filtering in), churning grain
  vec3 col = uColor * (0.82 + 0.3 * n) * mix(0.9, 1.1, vUv.y);
  gl_FragColor = vec4(col, uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= uAlpha;
}`;
