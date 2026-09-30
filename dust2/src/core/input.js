// Keyboard/mouse -> usercmd. Pointer lock, raw deltas, CS default binds.
import { World } from './world.js';
import { defCvar } from './cvars.js';

export const IN_ATTACK = 1 << 0;
export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
export const IN_USE = 1 << 5;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;
export const IN_ATTACK2 = 1 << 11;
export const IN_RELOAD = 1 << 13;
export const IN_SPEED = 1 << 17; // walk (shift)
export const IN_SCORE = 1 << 16;
export const IN_INSPECT = 1 << 20;

const BINDS = {
  KeyW: IN_FORWARD, KeyS: IN_BACK, KeyA: IN_MOVELEFT, KeyD: IN_MOVERIGHT,
  Space: IN_JUMP, ControlLeft: IN_DUCK, ControlRight: IN_DUCK, KeyC: IN_DUCK,
  ShiftLeft: IN_SPEED, ShiftRight: IN_SPEED, KeyE: IN_USE, KeyR: IN_RELOAD,
  Tab: IN_SCORE, KeyF: IN_INSPECT,
};

// One-shot actions (not held buttons)
const IMPULSES = {
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5',
  KeyQ: 'lastinv', KeyG: 'drop', KeyB: 'buymenu', Escape: 'menu', KeyM: 'teammenu',
  F1: 'debug', Backquote: 'console',
};

defCvar('sensitivity', 2.0, 0.05, 20, 'mouse sensitivity (CS scale)');
defCvar('m_yaw', 0.022, 0.001, 1, 'degrees per count');
defCvar('m_pitch', 0.022, 0.001, 1, 'degrees per count');
defCvar('zoom_sensitivity_ratio', 1.0, 0.1, 3, 'sensitivity multiplier when scoped');

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.buttons = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.impulses = [];
    this.locked = false;
    this.enabled = true;
    this.pitch = 0;
    this.yaw = 0;
    this.sensScale = 1;

    const held = new Set();
    this.held = held;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Tab' || e.code === 'F1' || (this.locked && e.code === 'Space')) e.preventDefault();
      if (BINDS[e.code] !== undefined) { held.add(e.code); this.buttons |= BINDS[e.code]; }
      if (!e.repeat && IMPULSES[e.code]) this.impulses.push(IMPULSES[e.code]);
    });
    addEventListener('keyup', (e) => {
      if (BINDS[e.code] === undefined) return;
      held.delete(e.code);
      // recompute (two keys can map to the same bit)
      let b = this.buttons & (IN_ATTACK | IN_ATTACK2);
      for (const k of held) b |= BINDS[k];
      this.buttons = b;
    });
    addEventListener('blur', () => { held.clear(); this.buttons = 0; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.buttons |= IN_ATTACK;
      if (e.button === 2) this.buttons |= IN_ATTACK2;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.buttons &= ~IN_ATTACK;
      if (e.button === 2) this.buttons &= ~IN_ATTACK2;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.impulses.push(e.deltaY > 0 ? 'invnext' : 'invprev');
    }, { passive: true });

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Chrome occasionally reports a huge spurious delta on lock; drop it.
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { held.clear(); this.buttons = 0; }
      World.emit('pointerlock', { locked: this.locked });
    });
  }

  lock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    // unadjustedMovement is unsupported on some platforms; fall back.
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  /** Consume mouse deltas into view angles. Call once per render frame. */
  applyMouse() {
    const cv = World.cvar;
    const s = cv.sensitivity * this.sensScale;
    this.yaw -= this.mouseDX * s * cv.m_yaw;
    this.pitch += this.mouseDY * s * cv.m_pitch;
    this.pitch = Math.max(-89, Math.min(89, this.pitch));
    this.yaw = ((this.yaw % 360) + 360) % 360;
    this.mouseDX = 0; this.mouseDY = 0;
  }

  /** Build a usercmd for one simulation tick. */
  buildCmd(cmd) {
    const b = this.buttons;
    const speed = 450; // cl_forwardspeed / cl_sidespeed (clamped by movement code)
    cmd.forwardmove = ((b & IN_FORWARD) ? speed : 0) - ((b & IN_BACK) ? speed : 0);
    cmd.sidemove = ((b & IN_MOVERIGHT) ? speed : 0) - ((b & IN_MOVELEFT) ? speed : 0);
    cmd.upmove = 0;
    cmd.buttons = b;
    cmd.pitch = this.pitch;
    cmd.yaw = this.yaw;
    return cmd;
  }

  takeImpulses() { const i = this.impulses; this.impulses = []; return i; }
}

export const newCmd = () => ({ forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0, pitch: 0, yaw: 0 });
