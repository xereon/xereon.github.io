// Browser-side helper for tools/ailab.mjs: replaces the frame render with a top-down
// orthographic view of the map (height-shaded) + the bot nav graph + map intel overlay.
// Loaded through `shot.mjs --eval "import('/tools/ai_topdown.js').then(m => m.install())"`.
import * as THREE from 'three';

export function install(o = {}) {
  const W = window.World, nav = W.nav;
  if (!nav?.count) throw new Error('[ai_topdown] no nav');
  const r = W.renderer.renderer;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < nav.count; i++) {
    x0 = Math.min(x0, nav.px[i]); x1 = Math.max(x1, nav.px[i]);
    z0 = Math.min(z0, nav.pz[i]); z1 = Math.max(z1, nav.pz[i]);
    y0 = Math.min(y0, nav.py[i]); y1 = Math.max(y1, nav.py[i]);
  }
  const pad = o.pad ?? 150;
  x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
  if (o.region) [x0, z0, x1, z1] = o.region;
  const size = r.getSize(new THREE.Vector2());
  const aspect = size.x / size.y, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let hw = (x1 - x0) / 2, hh = (z1 - z0) / 2;
  if (hw / hh > aspect) hh = hw / aspect; else hw = hh * aspect;
  const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, 30000);
  cam.position.set(cx, (o.ceiling ?? y1 + 400), cz);
  cam.up.set(0, 0, -1);
  cam.lookAt(cx, y0 - 100, cz);
  cam.updateMatrixWorld();

  // height-shaded floors, darker walls; anything above `ceiling` is clipped away (roofs)
  const mat = new THREE.ShaderMaterial({
    uniforms: { y0: { value: y0 - 40 }, y1: { value: y1 + 60 }, yCut: { value: o.cut ?? y1 + 180 } },
    vertexShader: `varying float vy; varying float vny;
      void main() {
        vec4 p = vec4(position, 1.0); vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
        #endif
        vec4 wp = modelMatrix * p; vy = wp.y;
        vny = normalize(mat3(modelMatrix) * n).y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `uniform float y0, y1, yCut; varying float vy; varying float vny;
      void main() {
        if (vy > yCut) discard;
        float t = clamp((vy - y0) / (y1 - y0), 0.0, 1.0);
        vec3 c = mix(vec3(0.16, 0.15, 0.14), vec3(0.78, 0.72, 0.6), t);
        c *= 0.45 + 0.55 * abs(vny);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const mapScene = new THREE.Scene();
  mapScene.overrideMaterial = mat;
  mapScene.background = new THREE.Color(0x101014);

  const overlay = new THREE.Scene();
  const navObj = nav._debug ? nav._debug : nav.debugDraw(overlay);
  if (navObj.parent !== overlay) overlay.add(navObj);
  navObj.visible = true;
  navObj.traverse((m) => {
    if (m.material) { m.material.depthTest = false; m.material.transparent = true; }
    if (m.isPoints) { m.material.sizeAttenuation = false; m.material.size = o.pointSize ?? 3; m.material.opacity = 0.9; }
    if (m.isLineSegments) m.material.opacity = o.linkOpacity ?? 0.35;
  });
  if (o.intel !== false && W.bots?.intel?.ready) overlay.add(W.bots.intel.debugObject());
  // live bots: small team-coloured discs
  const botMarks = new THREE.Group();
  overlay.add(botMarks);
  const disc = new THREE.CircleGeometry(o.botSize ?? 28, 16).rotateX(-Math.PI / 2);
  const mats = { T: new THREE.MeshBasicMaterial({ color: 0xffb030, depthTest: false }), CT: new THREE.MeshBasicMaterial({ color: 0x4080ff, depthTest: false }) };

  const root = W.map.root;
  let draws = 0;
  window.__topdownRedraw = () => { draws = 0; };
  W.renderer.render = () => {
    // SwiftShader is slow: draw a couple of frames, then leave the canvas alone
    if (draws++ >= 2) return;
    botMarks.clear();
    for (const e of W.entities) {
      if (!e.alive || !e.team || e.spectator) continue;
      const m = new THREE.Mesh(disc, mats[e.team] || mats.T);
      m.position.set(e.origin.x, e.origin.y + 20, e.origin.z); m.renderOrder = 20;
      botMarks.add(m);
    }
    const parent = root.parent;
    mapScene.add(root);
    r.setRenderTarget(null);
    r.autoClear = true;
    r.render(mapScene, cam);
    r.autoClear = false;
    r.render(overlay, cam);
    if (parent) parent.add(root);
  };
  return { bounds: [x0, z0, x1, z1], nodes: nav.count };
}
