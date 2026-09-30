// GPU particle shaders. All motion is analytic in the vertex shader; the CPU only writes a
// particle's birth record once. See particles.js for the attribute layout.
export const PF = {
  LIT: 1, ADD: 2, STRETCH: 4, AXIS: 8, FLAT: 16, BOUNCE: 32, FIRE: 64, FIREBALL: 128,
  SOFT: 256, NEARFADE: 512, TURB: 1024, MINPX: 2048, CAMFACE: 4096,
};

export const ATLAS_GLSL = /* glsl */`
vec2 spriteOrigin(float s) {
  if (s < 16.0) return vec2(mod(s, 4.0), floor(s / 4.0)) * 0.125;
  if (s < 32.0) { float f = s - 16.0; return vec2(0.5, 0.0) + vec2(mod(f, 4.0), floor(f / 4.0)) * 0.125; }
  float m = s - 32.0;
  return vec2(0.0, 0.5) + vec2(mod(m, 8.0), floor(m / 8.0)) * 0.125;
}
vec3 fireRamp(float T) {
  vec3 c = vec3(1.0, 0.22, 0.03) * smoothstep(0.0, 0.3, T)
         + vec3(0.0, 0.42, 0.1) * smoothstep(0.22, 0.65, T)
         + vec3(0.15, 0.28, 0.42) * smoothstep(0.6, 1.0, T);
  return c * (0.35 + T * T * 5.0);
}
`;

export const PARTICLE_VERT = /* glsl */`
precision highp float;
precision highp int;
attribute vec2 corner;
attribute vec4 a0; // pos.xyz, t0
attribute vec4 a1; // vel.xyz (or axis / plane normal), life
attribute vec4 a2; // size0, size1, rot0, rotVel
attribute vec4 a3; // gravity scale, drag, floorY, restitution (FIREBALL: heat fraction)
attribute vec4 a4; // color0 rgba
attribute vec4 a5; // color1 rgba
attribute vec4 a6; // sprite, frames, flags, stretch
attribute vec4 a7; // fadeIn, fadeOutStart, sunVis, seed
uniform float uTime;
uniform vec2 uViewport;
uniform float uAtlasTexel;
uniform mat4 uCamWorld;
varying vec2 vLocal;
varying vec4 vUvAB;
varying float vBlend;
varying vec4 vColor;
varying vec4 vColor1;
varying float vFlags;
varying vec3 vWorld;
varying vec3 vViewPos;
varying float vFloorY;
varying vec2 vRot;
varying float vSun;
varying float vSize;
varying float vHeat;
#include <fog_pars_vertex>
${ATLAS_GLSL}

const int F_LIT = 1, F_ADD = 2, F_STRETCH = 4, F_AXIS = 8, F_FLAT = 16, F_BOUNCE = 32;
const int F_FIREBALL = 128, F_TURB = 1024, F_MINPX = 2048, F_CAMFACE = 4096;

void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  if (age < 0.0 || age >= life || life <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  int flags = int(a6.z + 0.5);
  float x = age / life;
  vec3 pos = a0.xyz;
  vec3 vel = a1.xyz;
  float g = a3.x * 800.0;
  float k = a3.y;
  bool staticMode = (flags & (F_AXIS | F_FLAT)) != 0;
  if (!staticMode) {
    if ((flags & F_BOUNCE) != 0) {
      // horizontal: linear drag; vertical: ballistic with up to 3 floor bounces
      float fy = a3.z, e = a3.w;
      vec2 hv = vel.xz;
      vec2 hp = vec2(0.0);
      float y0 = pos.y, vy = vel.y, t = age;
      bool resting = false;
      for (int i = 0; i < 3; i++) {
        if (y0 < fy - 0.5) break;
        float A = 0.5 * g, B = -vy, C = fy - y0;
        float disc = B * B - 4.0 * A * C;
        if (disc < 0.0 || A <= 0.0) break;
        float th = (-B + sqrt(disc)) / (2.0 * A);
        if (th > t) break;
        float sh = k > 1e-4 ? (1.0 - exp(-k * th)) / k : th;
        hp += hv * sh;
        hv *= (k > 1e-4 ? exp(-k * th) : 1.0) * 0.55;
        float vi = vy - g * th;
        vy = -vi * e;
        y0 = fy; t -= th;
        if (vy < 25.0) { resting = true; break; }
      }
      float sh = k > 1e-4 ? (1.0 - exp(-k * t)) / k : t;
      if (resting) { hv *= 0.25; vy = 0.0; }
      hp += hv * sh;
      float y = resting ? fy : y0 + vy * t - 0.5 * g * t * t;
      pos = vec3(pos.x + hp.x, y, pos.z + hp.y);
      vel = vec3(hv.x * (k > 1e-4 ? exp(-k * t) : 1.0), resting ? 0.0 : vy - g * t, hv.y * (k > 1e-4 ? exp(-k * t) : 1.0));
    } else if (k > 1e-4) {
      float e = exp(-k * age);
      vec3 term = vec3(0.0, -g / k, 0.0);
      pos = pos + term * age + (vel - term) * (1.0 - e) / k;
      vel = term + (vel - term) * e;
    } else {
      pos = pos + vel * age + vec3(0.0, -0.5 * g * age * age, 0.0);
      vel = vel + vec3(0.0, -g * age, 0.0);
    }
    if ((flags & F_TURB) != 0) {
      float sd = a7.w * 6.2831;
      vec3 tb = vec3(sin(age * 1.3 + sd), 0.5 * sin(age * 0.9 + sd * 1.7), cos(age * 1.1 + sd * 2.3));
      pos += tb * max(a2.x, a2.y) * 0.22 * min(age, 1.5);
    }
  }
  float size = mix(a2.x, a2.y, 1.0 - (1.0 - x) * (1.0 - x));
  float rot = a2.z + a2.w * age;
  vec4 col = mix(a4, a5, x);
  float fade = smoothstep(0.0, max(a7.x, 1e-4), x) * (1.0 - smoothstep(a7.y, 1.0, x));
  col.a *= fade;

  vec4 mvCenter = modelViewMatrix * vec4(pos, 1.0);
  vec3 viewDir = normalize(mvCenter.xyz);
  vec3 ax, ay;
  vec3 center = mvCenter.xyz;
  vec2 rcs = vec2(1.0, 0.0);
  if ((flags & F_STRETCH) != 0) {
    vec3 vv = mat3(modelViewMatrix) * vel;
    vec3 vp = vv - dot(vv, viewDir) * viewDir;
    float vl = length(vp);
    vec3 dir = vl > 1e-3 ? vp / vl : vec3(0.0, 1.0, 0.0);
    float len = size + vl * a6.w;
    ay = dir * len * 0.5;
    ax = normalize(cross(dir, viewDir)) * size * 0.5;
    center -= dir * (len * 0.5 - size * 0.5);
  } else if ((flags & F_AXIS) != 0) {
    vec3 av = normalize(mat3(modelViewMatrix) * vel);
    float len = size * a6.w;
    vec3 side = cross(av, viewDir);
    float sl = length(side);
    col.a *= smoothstep(0.08, 0.45, sl);
    ay = av * len * 0.5;
    ax = (sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0)) * size;
    // random roll about the axis is implicit; flip width with rotation sign for variety
    ax *= rot >= 0.0 ? 1.0 : -1.0;
    center += av * len * 0.5;
  } else if ((flags & F_FLAT) != 0) {
    vec3 n = normalize(vel);
    vec3 t1 = normalize(abs(n.y) < 0.95 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(n, t1);
    float c = cos(rot), s = sin(rot);
    vec3 w1 = t1 * c + t2 * s, w2 = -t1 * s + t2 * c;
    ax = mat3(modelViewMatrix) * w1 * size;
    ay = mat3(modelViewMatrix) * w2 * size;
  } else {
    float c = cos(rot), s = sin(rot);
    rcs = vec2(c, s);
    if ((flags & F_CAMFACE) != 0) {
      // face the camera position (not the view plane): stable for huge sprites near the eye
      vec3 up = abs(viewDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 r0 = normalize(cross(viewDir, up)), u0 = cross(r0, viewDir);
      ax = (r0 * c + u0 * s) * size;
      ay = (-r0 * s + u0 * c) * size;
    } else {
      ax = vec3(c, s, 0.0) * size;
      ay = vec3(-s, c, 0.0) * size;
    }
  }
  if ((flags & F_MINPX) != 0) {
    // keep tiny additive sprites >= ~1.3 px wide; trade size for brightness
    float px = length(ax) * uViewport.y * projectionMatrix[1][1] * 0.5 / max(-center.z, 1.0);
    float m = 1.3 / max(px, 1e-3);
    if (m > 1.0) { ax *= m; if ((flags & F_STRETCH) == 0) ay *= m; col.a /= m; }
  }
  vec3 vpos = center + ax * corner.x + ay * corner.y;
  gl_Position = projectionMatrix * vec4(vpos, 1.0);
  vViewPos = vpos;
  vWorld = (uCamWorld * vec4(vpos, 1.0)).xyz;
  vLocal = corner;
  // flipbook
  float frames = max(a6.y, 1.0);
  float f = min(x * frames, frames - 0.001);
  float fa = floor(f);
  vBlend = frames > 1.0 ? f - fa : 0.0;
  vec2 cuv = (corner * 0.5 + 0.5) * (0.125 - 2.0 * uAtlasTexel) + uAtlasTexel;
  vUvAB = vec4(spriteOrigin(a6.x + fa) + cuv, spriteOrigin(a6.x + min(fa + 1.0, frames - 1.0)) + cuv);
  vColor = col;
  vColor1 = a5;
  vFlags = a6.z;
  vFloorY = a3.z;
  vRot = rcs;
  vSun = a7.z;
  vSize = size;
  vHeat = (flags & F_FIREBALL) != 0 ? 1.0 - smoothstep(0.0, max(a3.w, 1e-3), x) : 0.0;
  vec4 mvPosition = vec4(vpos, 1.0);
  #include <fog_vertex>
}
`;

export const PARTICLE_FRAG = /* glsl */`
precision highp float;
precision highp int;
uniform sampler2D uAtlas;
uniform vec3 uSunDirV;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform vec2 uDepthRes;
uniform vec2 uNearFar;
uniform vec2 uNearFade;
uniform float uEmissive;
varying vec2 vLocal;
varying vec4 vUvAB;
varying float vBlend;
varying vec4 vColor;
varying vec4 vColor1;
varying float vFlags;
varying vec3 vWorld;
varying vec3 vViewPos;
varying float vFloorY;
varying vec2 vRot;
varying float vSun;
varying float vSize;
varying float vHeat;
#include <fog_pars_fragment>
${ATLAS_GLSL}
const float PI = 3.14159265;
const int F_LIT = 1, F_ADD = 2, F_FIRE = 64, F_FIREBALL = 128, F_SOFT = 256, F_NEARFADE = 512;

float linDepth(float d) {
  float n = uNearFar.x, f = uNearFar.y;
  float z = d * 2.0 - 1.0;
  return 2.0 * n * f / (f + n - z * (f - n));
}

void main() {
  int flags = int(vFlags + 0.5);
  vec4 t = mix(texture2D(uAtlas, vUvAB.xy), texture2D(uAtlas, vUvAB.zw), vBlend);
  float a = t.r * vColor.a;
  if (a < 0.003) discard;
  vec3 col;
  float addMix = (flags & F_ADD) != 0 ? 1.0 : 0.0;
  if ((flags & F_FIRE) != 0) {
    float T = clamp(t.a * vColor.r, 0.0, 1.0);
    col = fireRamp(T) * uEmissive * vColor.g;
    a = t.r * vColor.a * smoothstep(0.02, 0.25, T);
  } else {
    vec3 n = vec3(t.g * 2.0 - 1.0, t.b * 2.0 - 1.0, 0.0) * 0.7;
    n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
    n.xy = vec2(vRot.x * n.x - vRot.y * n.y, vRot.y * n.x + vRot.x * n.y);
    if ((flags & (F_LIT | F_FIREBALL)) != 0) {
      float ndl = dot(n, uSunDirV);
      float diff = max(0.0, (ndl + 0.55) / 1.55);
      vec3 V = normalize(-vViewPos);
      // forward scattering through thin edges when looking toward the sun
      float fwd = pow(max(0.0, dot(-V, uSunDirV)), 6.0) * (1.0 - t.r) * 1.5;
      vec3 nW = (vec4(n, 0.0) * viewMatrix).xyz;
      vec3 amb = mix(uGroundCol, uSkyCol, clamp(nW.y * 0.5 + 0.5, 0.0, 1.0));
      float ao = mix(0.6, 1.0, t.a);
      vec3 albedo = (flags & F_FIREBALL) != 0 ? vColor1.rgb : vColor.rgb;
      col = albedo * (uSunCol * (diff + fwd) * vSun + amb * ao) / PI;
      if ((flags & F_FIREBALL) != 0) {
        float T = clamp(vHeat * (0.35 + 0.9 * t.a) * (0.4 + 0.8 * t.r), 0.0, 1.0);
        col += fireRamp(T) * uEmissive * vColor.rgb * vHeat;
        addMix = vHeat * 0.6;
      }
    } else {
      col = vColor.rgb * (0.25 + 0.75 * t.a) * uEmissive;
    }
  }
  // soft intersection with the scene depth
  if ((flags & F_SOFT) != 0) {
    if (uHasDepth > 0.5) {
      float sd = linDepth(texture2D(uDepth, gl_FragCoord.xy / uDepthRes).r);
      a *= clamp((sd - (-vViewPos.z)) / max(vSize * 0.45, 2.0), 0.0, 1.0);
    }
    if (vFloorY > -1e5) a *= smoothstep(vFloorY, vFloorY + max(vSize * 0.4, 1.0), vWorld.y);
  }
  if ((flags & F_NEARFADE) != 0) a *= smoothstep(uNearFade.x, uNearFade.y, -vViewPos.z);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor * (1.0 - addMix), fogF);
  #endif
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= a;
  gl_FragColor.a = a * (1.0 - addMix);
}
`;
