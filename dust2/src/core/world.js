// Service locator + tiny event bus. See CONTRACT.md §2.
// Modules must read World fields lazily (inside functions), never at import time.

const listeners = new Map();

export const World = {
  time: 0,
  frame: 0,
  dt: 0,
  tickInterval: 1 / 128,

  renderer: null,
  scene: null,
  camera: null,
  viewScene: null,
  viewCamera: null,

  collision: null,
  map: null,
  nav: null,

  input: null,
  local: null,
  entities: [],
  get players() { return this.entities; },

  weapons: null,
  fx: null,
  audio: null,
  match: null,
  hud: null,

  quality: 'high',
  paused: false,
  cvar: {},

  on(name, fn) {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  },

  emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); }
      catch (err) { console.error(`[World] listener for "${name}" threw`, err); }
    }
  },
};

if (typeof window !== 'undefined') window.World = World;
