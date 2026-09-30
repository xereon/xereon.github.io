// Procedural C4 world model (dropped / planted) with a blinking LED synced to the beep.
import * as THREE from 'three';
import { World } from '../core/world.js';

let proto = null;
function buildProto() {
  const g = new THREE.Group();
  const mat = (color, rough = 0.8, metal = 0, emissive = 0x000000, ei = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei });
  const body = mat(0x6d6649, 0.85);
  const tape = mat(0x23221f, 0.6);
  const panel = mat(0x2d2f2c, 0.45, 0.3);
  const screen = mat(0x0f1a10, 0.3, 0, 0x6dff8a, 0.9);
  const wireR = mat(0x9b1c16, 0.5), wireB = mat(0x1c3d86, 0.5), wireY = mat(0xb89a24, 0.5);
  const add = (geo, m, x, y, z, ry = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.y = ry; o.castShadow = true; o.receiveShadow = true; g.add(o); return o; };
  // three charge blocks side by side
  for (let i = -1; i <= 1; i++) add(new THREE.BoxGeometry(11, 2.4, 2.1), body, 0, 1.2, i * 2.2);
  // tape wraps
  for (const x of [-3.6, 3.6]) add(new THREE.BoxGeometry(1.1, 2.6, 6.9), tape, x, 1.25, 0);
  // control panel + keypad + LCD
  add(new THREE.BoxGeometry(5.2, 0.9, 4.2), panel, 0.6, 2.75, 0);
  add(new THREE.BoxGeometry(2.6, 0.12, 1.1), screen, 0.9, 3.25, -0.9);
  const keyMat = mat(0x8a8d86, 0.6, 0.2);
  const keyGeo = new THREE.BoxGeometry(0.55, 0.18, 0.5);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) add(keyGeo, keyMat, -0.3 + c * 0.8, 3.27, 0.35 + r * 0.62);
  // wires
  const wire = (m, x0, z0, x1, z1) => {
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x0, 2.7, z0), new THREE.Vector3((x0 + x1) / 2, 3.6, (z0 + z1) / 2), new THREE.Vector3(x1, 2.3, z1)]);
    add(new THREE.TubeGeometry(curve, 8, 0.14, 5), m, 0, 0, 0);
  };
  wire(wireR, -1.8, -1.2, -4.8, -1.8); wire(wireB, -1.8, 0.2, -4.6, 0.9); wire(wireY, -1.8, 1.4, -4.4, 2.6);
  // LED
  const led = add(new THREE.SphereGeometry(0.28, 10, 8), mat(0x300000, 0.3, 0, 0xff2010, 0), 2.7, 3.3, 1.4);
  led.castShadow = false;
  g.userData.ledIndex = g.children.indexOf(led);
  proto = g;
}

export class BombModel {
  constructor() {
    this.obj = null;
    this.led = null;
    this.flash = 0;
  }
  ensure() {
    if (this.obj) return this.obj;
    if (!proto) buildProto();
    this.obj = proto.clone(true);
    // LED material is per-instance so it can blink. No PointLight: adding lights at runtime
    // would recompile every lit shader; the emissive LED + bloom reads as the blink.
    const led = this.obj.children[proto.userData.ledIndex];
    led.material = led.material.clone();
    this.led = led;
    return this.obj;
  }
  /** Add (parked far below the map) so renderer.precompile() warms its shaders at boot. */
  preload() {
    const o = this.ensure();
    if (!o.parent && World.scene) World.scene.add(o);
    o.position.set(0, -50000, 0);
    this.shown = false;
  }
  show(pos, yaw = 0) {
    const o = this.ensure();
    if (!o.parent && World.scene) World.scene.add(o);
    o.position.copy(pos);
    o.rotation.set(0, yaw * Math.PI / 180, 0);
    this.shown = true;
  }
  hide() { if (this.obj) this.obj.position.set(0, -50000, 0); this.shown = false; this.flash = 0; this._set(0); }
  blink() { this.flash = 1; }
  _set(v) {
    if (!this.led) return;
    this.led.material.emissiveIntensity = 0.3 + v * 8;
  }
  update(dt) {
    if (!this.shown) return;
    this.flash = Math.max(0, this.flash - dt * 7);
    this._set(this.flash);
  }
}
