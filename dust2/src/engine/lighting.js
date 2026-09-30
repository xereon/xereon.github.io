// Material lighting patch. Every lit material in the world goes through patchShader():
//   * sun: light 0 gets our cascaded shadow term (csm.js); the zero-intensity cascade
//     lights 1..N-1 are skipped entirely;
//   * ambient: the hemisphere/probe/env diffuse is replaced by the baked irradiance volume
//     (gi.js): sky visibility + multi-bounce sun, sampled per fragment with an L1 SH;
//   * specular IBL is occluded by the same volume so metal in a tunnel doesn't mirror the sky;
//   * opaque surfaces write (indirect / total) luminance into alpha, so the post AO pass
//     darkens ambient light only and leaves direct sunlight untouched.
// Viewmodel materials (RP_VIEWMODEL) sample the volume at the world camera position with
// normals rotated into world space, and take a CPU-traced sun visibility.
import * as THREE from 'three';
import { SHADOW_GLSL, shadowUniforms, shadowConfig } from './csm.js';

export const lightUniforms = {
  rpSunDir: null, // bound to skyUniforms.rpSunDir by the pipeline
  rpGI0: { value: null }, rpGI1: { value: null }, rpGI2: { value: null },
  rpGIMin: { value: new THREE.Vector3() },
  rpGIInvSize: { value: new THREE.Vector3(1, 1, 1) },
  rpGIBias: { value: 32 },
  rpGIOn: { value: 0 },
  rpAmbSky: { value: new THREE.Color(0.35, 0.42, 0.55) },     // fallback when no volume
  rpAmbGround: { value: new THREE.Color(0.30, 0.24, 0.17) },
  rpSpecRef: { value: 1 },   // luminance of open-sky irradiance (specular occlusion reference)
  rpIndirect: { value: 1 },  // debug / global ambient multiplier
  rpVMRot: { value: new THREE.Matrix3() },
  rpVMPos: { value: new THREE.Vector3() },
  rpVMSun: { value: 1 },
  rpDebug: { value: 0 },
};

const COMMON_GLSL = /* glsl */`
uniform vec3 rpSunDir;
uniform highp sampler3D rpGI0, rpGI1, rpGI2;
uniform vec3 rpGIMin, rpGIInvSize, rpAmbSky, rpAmbGround;
uniform float rpGIBias, rpGIOn, rpSpecRef, rpIndirect, rpDebug;
vec3 rpGIEval(vec3 wp, vec3 wn) {
  if (rpGIOn < 0.5) return mix(rpAmbGround, rpAmbSky, wn.y * 0.5 + 0.5);
  vec3 uvw = (wp - rpGIMin) * rpGIInvSize;
  vec4 t0 = texture(rpGI0, uvw), t1 = texture(rpGI1, uvw), t2 = texture(rpGI2, uvw);
  vec3 a = t0.rgb;
  vec3 e = a + vec3(t0.a, t1.rg) * wn.x + vec3(t1.ba, t2.r) * wn.y + t2.gba * wn.z;
  // L1 can ring negative opposite a strong source; keep a floor of the average
  return max(e, a * 0.2);
}
`;

const VM_GLSL = /* glsl */`
uniform mat3 rpVMRot;
uniform vec3 rpVMPos;
uniform float rpVMSun;
`;

const BASE_LFB = THREE.ShaderChunk.lights_fragment_begin;
const BASE_LFM = THREE.ShaderChunk.lights_fragment_maps;

function buildLightsBegin(vm) {
  const a = BASE_LFB.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = BASE_LFB.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
  if (a < 0 || b < 0) return null;
  const pre = /* glsl */`
vec3 rpWP = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz + cameraPosition;
vec3 rpGN = normalize((vec4(nonPerturbedNormal, 0.0) * viewMatrix).xyz);
float rpSunVis = 1.0;
${vm ? 'rpSunVis = rpVMSun;' : `
#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
  rpSunVis = rpSunShadow( rpWP, rpGN, vViewPosition.z, rpSunDir );
#endif`}
`;
  const dir = /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
  DirectionalLight directionalLight;
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    #if ( UNROLLED_LOOP_INDEX == 0 ) || ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )
    directionalLight = directionalLights[ i ];
    getDirectionalLightInfo( directionalLight, directLight );
    #if ( UNROLLED_LOOP_INDEX == 0 )
    directLight.color *= rpSunVis;
    #endif
    RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    #endif
  }
  #pragma unroll_loop_end
#endif
`;
  const post = /* glsl */`
#if defined( RE_IndirectDiffuse )
  {
    vec3 rpWN = normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz);
    ${vm ? 'irradiance = rpGIEval(rpVMPos, normalize(rpVMRot * rpWN));'
         : 'irradiance = rpGIEval(rpWP + rpGN * rpGIBias, rpWN);'}
    irradiance *= rpIndirect;
  }
#endif
`;
  // geometryPosition etc. are declared at the top of the stock chunk, so inject after them
  const head = BASE_LFB.slice(0, a);
  const tail = BASE_LFB.slice(b);
  return head + pre + dir + tail + post;
}

const LFB_WORLD = buildLightsBegin(false);
const LFB_VM = buildLightsBegin(true);

// Drop env diffuse (the volume already holds occluded sky light), occlude env specular.
const LFM = BASE_LFM.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '') + /* glsl */`
#if defined( RE_IndirectSpecular ) && defined( STANDARD )
  {
    float rpSO = clamp(dot(irradiance, vec3(0.2126, 0.7152, 0.0722)) / rpSpecRef, 0.0, 1.0);
    float rpR2 = clamp(material.roughness * material.roughness, 0.0, 1.0);
    radiance = mix(radiance * rpSO * rpSO, irradiance * RECIPROCAL_PI, rpR2 * 0.85);
  }
#endif
`;

const ALPHA_OUT = /* glsl */`
#include <opaque_fragment>
#ifdef OPAQUE
  {
    const vec3 rpLW = vec3(0.2126, 0.7152, 0.0722);
    vec3 rpInd = reflectedLight.indirectDiffuse + reflectedLight.indirectSpecular;
    gl_FragColor.a = clamp(dot(rpInd, rpLW) / max(dot(outgoingLight, rpLW), 1e-5), 0.0, 1.0);
    if (rpDebug > 0.5) {
      if (rpDebug < 1.5) gl_FragColor.rgb = rpInd;                 // 1: indirect only
      else if (rpDebug < 2.5) gl_FragColor.rgb = vec3(rpSunVis);   // 2: sun visibility
      else if (rpDebug < 3.5) gl_FragColor.rgb = irradiance * 0.3; // 3: raw irradiance
    }
  }
#endif
`;

/** Patch a compiled-shader object in place. Returns false if the material isn't lit. */
export function patchShader(shader, vm) {
  if (!LFB_WORLD || !shader.fragmentShader.includes('#include <lights_fragment_begin>')) return false;
  const U = shader.uniforms;
  for (const k in lightUniforms) if (lightUniforms[k]) U[k] = lightUniforms[k];
  if (!vm) for (const k in shadowUniforms) U[k] = shadowUniforms[k];
  const pcf = shadowConfig.pcf;
  let fs = shader.fragmentShader;
  const pars = `#define RP_PCF ${pcf}\n` + COMMON_GLSL + (vm ? VM_GLSL : SHADOW_GLSL);
  fs = fs.replace('#include <common>', '#include <common>\n' + pars);
  fs = fs.replace('#include <lights_fragment_begin>', vm ? LFB_VM : LFB_WORLD);
  fs = fs.replace('#include <lights_fragment_maps>', LFM);
  if (!vm) fs = fs.replace('#include <opaque_fragment>', ALPHA_OUT);
  shader.fragmentShader = fs;
  return true;
}

const LIT = (m) => m && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial);

/**
 * Hook a material so its shader gets patched. Composes with existing onBeforeCompile
 * (including TextureLib's chaining setter) and keeps program cache keys distinct.
 */
export function setupMaterial(m, vm = false, version = 1) {
  if (!LIT(m)) return false;
  const tag = `${vm ? 'vm' : 'w'}${version}`;
  const cur = m.userData.rpPatched;
  if (cur === tag) return false;
  // a material seen in the viewmodel stays a viewmodel material (never flip back and forth)
  if (cur && cur.startsWith('vm') && !vm) return false;
  const already = !!cur;
  m.userData.rpPatched = tag;
  const desc = Object.getOwnPropertyDescriptor(m, 'onBeforeCompile');
  if (!already) {
    const prevKey = m.customProgramCacheKey;
    const protoKey = THREE.Material.prototype.customProgramCacheKey;
    if (desc && desc.set) {
      // TextureLib-style chaining property: assigning appends us after the owner's patch
      const base = prevKey === protoKey ? '' : prevKey.call(m);
      m.onBeforeCompile = function (s, r) { (m.userData.rpPatched?.startsWith('vm') ? patchVM : patchWorld)(s, r); };
      m.customProgramCacheKey = () => `${base}|rp:${m.userData.rpPatched}|${shadowConfig.pcf}`;
    } else {
      const prev = typeof m.onBeforeCompile === 'function' && m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
        ? m.onBeforeCompile : null;
      const base = prevKey === protoKey ? (prev ? prev.toString() : '') : prevKey.call(m);
      m.onBeforeCompile = function (s, r) {
        if (prev) prev.call(this, s, r);
        (m.userData.rpPatched?.startsWith('vm') ? patchVM : patchWorld)(s, r);
      };
      m.customProgramCacheKey = () => `${base}|rp:${m.userData.rpPatched}|${shadowConfig.pcf}`;
    }
  }
  m.needsUpdate = true;
  return true;
}

function patchWorld(shader) { patchShader(shader, false); }
function patchVM(shader) { patchShader(shader, true); }

/** Traverse an object tree and hook every lit material. Returns count of new materials. */
export function setupTree(root, vm = false, version = 1) {
  let n = 0;
  root.traverse((o) => {
    if (o.userData?.rpSkip) return;
    const mat = o.material;
    if (!mat) return;
    if (Array.isArray(mat)) { for (const m of mat) if (setupMaterial(m, vm, version)) n++; }
    else if (setupMaterial(mat, vm, version)) n++;
  });
  return n;
}
