// Live-tweakable variables. See CONTRACT.md §9.
import { World } from './world.js';

const defs = new Map();

export function defCvar(name, value, min = -Infinity, max = Infinity, help = '') {
  if (defs.has(name)) return World.cvar[name];
  defs.set(name, { value, min, max, help });
  World.cvar[name] = value;
  return value;
}

export const cvarDefs = () => defs;

// Proxy so `cv.exposure = 1.3` in the console / screenshot harness clamps and applies.
const proxy = new Proxy(World.cvar, {
  set(target, key, val) {
    const d = defs.get(key);
    if (d && typeof val === 'number') val = Math.min(d.max, Math.max(d.min, val));
    target[key] = val;
    World.emit('cvar', { name: key, value: val });
    return true;
  },
});

if (typeof window !== 'undefined') window.cv = proxy;
export const cv = proxy;
