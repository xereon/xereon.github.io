// Headless viewmodel smoke test: every weapon x every animation, checks for exceptions / NaNs
// and that muzzle/eject points project sensibly.  node --import ./tools/three-resolve.mjs tools/vmlab_test.mjs
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { Viewmodel, buildWorldModel } from '../src/weapons/viewmodel.js';
import { VM_CFG } from '../src/weapons/models/index.js';

const scene = new THREE.Scene(), vs = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(74, 16 / 9, 1, 12000), vc = new THREE.PerspectiveCamera(54, 16 / 9, 0.5, 400);
cam.position.set(100, 64, 50); cam.updateMatrixWorld();
World.scene = scene; World.camera = cam; World.viewScene = vs; World.viewCamera = vc;
vs.add(new THREE.HemisphereLight());
const vm = new Viewmodel(vs, vc);
const ent = { team: 'CT', yaw: 90, pitch: 0, velocity: new THREE.Vector3(200, 0, 0), onGround: true, duckAmount: 0, aimPunch: { pitch: -1, yaw: 0.5 } };
const ANIMS = ['draw', 'idle', 'fire', 'fire_last', 'reload', 'reload_empty', 'inspect', 'melee', 'melee_heavy', 'pin', 'throw', 'zoom_in', 'zoom_out', 'silencer_off', 'silencer_on', 'plant', 'idle'];
const keys = process.argv.slice(2).length ? process.argv.slice(2) : [...Object.keys(VM_CFG).filter((k) => !k.startsWith('knife_')), 'knife'];
let fails = 0;
const bad = (v) => !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z);
const m = new THREE.Vector3(), e = new THREE.Vector3(), ndc = new THREE.Vector3();
for (const team of ['CT', 'T']) {
  ent.team = team;
  for (const k of keys) {
    try {
      vm.setWeapon(k);
      for (const a of ANIMS) {
        vm.play(a);
        for (let i = 0; i < 40; i++) { ent.yaw += 0.3; vm.update(1 / 30, ent); }
        vm.muzzleWorld(m); vm.ejectWorld(e);
        if (bad(m) || bad(e)) throw new Error(`NaN point after ${a}`);
        let nan = false;
        vm.root.traverse((o) => { if (o.isObject3D && (bad(o.position) || !Number.isFinite(o.quaternion.w))) nan = true; });
        if (nan) throw new Error(`NaN transform after ${a}`);
      }
      vm.play('idle'); for (let i = 0; i < 30; i++) vm.update(1 / 30, ent);
      vm.muzzleWorld(m);
      ndc.copy(m).project(cam);
      if (team === 'CT') console.log(k.padEnd(13), 'muzzle ndc', ndc.x.toFixed(2), ndc.y.toFixed(2), 'dist', m.distanceTo(cam.position).toFixed(1), 'tris', vm.triangles);
      const wm = buildWorldModel(k);
      if (!wm.children.length) throw new Error('empty world model');
    } catch (err) { fails++; console.log('FAIL', team, k, err.stack.split('\n').slice(0, 3).join(' | ')); }
  }
}
console.log(fails ? `${fails} failures` : 'all ok');
process.exit(fails ? 1 : 0);
