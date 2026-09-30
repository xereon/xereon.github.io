// First-person camera for the local player. Runs at render rate:
//  * position = tick-interpolated origin + interpolated view offset (duck), World.alpha
//  * angles   = raw mouse angles from World.input (never tick-quantised) + view/aim punch
//  * Source SmoothViewOnStairs (150 u/s, max 18u lag), optional landing dip / bob
//  * Hor+ FOV: cvar `fov` (renderer) is horizontal at 4:3 like CS, converted to vertical
import { World } from '../core/world.js';
import { defCvar } from '../core/cvars.js';
import { applyViewAngles, DEG, RAD, clamp } from '../core/mathx.js';

defCvar('view_recoil_tracking', 0.45, 0, 1, 'how much of the aim punch the view follows');
defCvar('cl_smoothstairs', 1, 0, 1, 'smooth the view over stair steps');
defCvar('cl_landdip', 1, 0, 4, 'landing view dip scale (0 = off)');
defCvar('cl_bob', 0, 0, 1, 'view bob amount (CS: effectively off)');
defCvar('cl_bobcycle', 0.98, 0.1, 2, 'bob cycle length (s at 250 u/s)');
defCvar('cl_viewinterp', 1, 0, 1, 'interpolate the view between simulation ticks');

const STAIR_SPEED = 150; // C_BasePlayer::SmoothViewOnStairs
const STEP = 18;
const DEAD_VIEWHEIGHT = 14;

export const vfovFromHfov43 = (h) => 2 * Math.atan(Math.tan(h * 0.5 * DEG) * 0.75) * RAD;

export class FirstPersonCamera {
  constructor() {
    this.oldY = null;        // stair smoothing state
    this.dip = 0; this.dipVel = 0;
    this.landSerial = 0;
    this.bobTime = 0;
    this.fov = null;
    this.deadT = 0;
    this.pitch = 0; this.yaw = 0; this.roll = 0;
    this.eyeY = 0;
  }

  reset() { this.oldY = null; this.dip = 0; this.dipVel = 0; this.deadT = 0; }

  update(p, dt, alpha) {
    const cam = World.camera;
    if (!cam) return;
    const cv = World.cvar;
    const ov = World.cameraOverride;
    if (ov) {
      cam.position.copy(ov.eye);
      applyViewAngles(cam, ov.pitch ?? 0, ov.yaw ?? 0, 0);
      this._setFov(cam, ov.fov ?? vfovFromHfov43(cv.fov ?? 90), true);
      this.reset();
      this.landSerial = p.landSerial;
      return;
    }
    if (!(dt > 0)) dt = 0;
    const a = cv.cl_viewinterp ? clamp(alpha ?? 1, 0, 1) : 1;

    // --- position ---
    const o = p.origin, po = p.prevOrigin;
    const x = po.x + (o.x - po.x) * a;
    const y = po.y + (o.y - po.y) * a;
    const z = po.z + (o.z - po.z) * a;
    let eye = p.prevEyeHeight + (p.eyeHeight - p.prevEyeHeight) * a;

    // SmoothViewOnStairs: only while grounded; the view lags sudden steps at 150 u/s
    let stairOfs = 0;
    if (cv.cl_smoothstairs && p.onGround && p.moveType === 'walk' && this.oldY !== null && p.alive) {
      const dir = y > this.oldY ? 1 : y < this.oldY ? -1 : 0;
      if (dir !== 0) {
        this.oldY += dt * STAIR_SPEED * dir;
        if (dir > 0) { if (this.oldY > y) this.oldY = y; if (y - this.oldY > STEP) this.oldY = y - STEP; }
        else { if (this.oldY < y) this.oldY = y; if (y - this.oldY < -STEP) this.oldY = y + STEP; }
      }
      stairOfs = this.oldY - y;
    } else this.oldY = y;

    // landing dip: critically damped spring kicked by fall speed
    if (p.landSerial !== this.landSerial) {
      this.landSerial = p.landSerial;
      const k = clamp((p.landSpeed - 120) / 460, 0, 1.2);
      this.dipVel -= k * 70 * cv.cl_landdip;
    }
    if (this.dip !== 0 || this.dipVel !== 0) {
      const w = 18; // rad/s, critically damped
      const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n; // substep: stable on frame hitches
      for (let i = 0; i < n; i++) {
        this.dipVel += (-w * w * this.dip - 2 * w * this.dipVel) * h;
        this.dip += this.dipVel * h;
      }
      if (Math.abs(this.dip) < 1e-3 && Math.abs(this.dipVel) < 1e-2) { this.dip = 0; this.dipVel = 0; }
    }

    // optional bob (cl_bob 0 by default like CS)
    let bob = 0;
    if (cv.cl_bob > 0 && p.onGround) {
      const spd = Math.hypot(p.velocity.x, p.velocity.z);
      this.bobTime += dt * (spd / 250);
      bob = Math.sin(this.bobTime * 2 * Math.PI / cv.cl_bobcycle) * cv.cl_bob * 2 * Math.min(1, spd / 250);
    }

    // death: view sinks to the floor and tilts (CS:S style)
    let deadRoll = 0;
    if (!p.alive) {
      this.deadT = Math.min(1, this.deadT + dt / 0.45);
      const t = this.deadT * this.deadT * (3 - 2 * this.deadT);
      eye = eye + (DEAD_VIEWHEIGHT - eye) * t;
      deadRoll = 14 * t;
    } else this.deadT = 0;

    this.eyeY = y + eye + stairOfs + this.dip + bob;
    cam.position.set(x, this.eyeY, z);

    // --- angles: mouse at render rate + interpolated punch ---
    const inp = World.input;
    const vp = p.viewPunch, pvp = p.prevViewPunch, ap = p.aimPunch, pap = p.prevAimPunch;
    const tr = cv.view_recoil_tracking;
    const punchP = (pvp.pitch + (vp.pitch - pvp.pitch) * a) + tr * (pap.pitch + (ap.pitch - pap.pitch) * a);
    const punchY = (pvp.yaw + (vp.yaw - pvp.yaw) * a) + tr * (pap.yaw + (ap.yaw - pap.yaw) * a);
    const punchR = (pvp.roll || 0) + ((vp.roll || 0) - (pvp.roll || 0)) * a;
    const basePitch = p.alive && inp ? inp.pitch : p.pitch;
    const baseYaw = p.alive && inp ? inp.yaw : p.yaw;
    this.pitch = clamp(basePitch + punchP, -89, 89);
    this.yaw = baseYaw + punchY;
    this.roll = punchR + deadRoll;
    applyViewAngles(cam, this.pitch, this.yaw, this.roll);

    // --- FOV (Hor+), smoothed so scope zooms are not a hard cut ---
    const target = vfovFromHfov43(p.fov ?? cv.fov ?? 90);
    if (this.fov === null) this.fov = target;
    else this.fov += (target - this.fov) * (1 - Math.exp(-(p.fovRate ?? 40) * dt));
    this._setFov(cam, this.fov, false);
  }

  _setFov(cam, f, snap) {
    if (snap) this.fov = f;
    if (Math.abs(cam.fov - f) > 1e-4) { cam.fov = f; cam.updateProjectionMatrix(); }
  }
}
