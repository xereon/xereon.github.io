// Persisted player settings (localStorage, all access guarded) + application to engine.
import { World } from '../core/world.js';

const KEY = 'dust2.settings.v1';

export const CROSSHAIR_PRESETS = {
  default: { style: 'classic', size: 3.4, thickness: 0.7, gap: -0.8, outline: true, outlineThickness: 1, dot: false, color: [80, 250, 160], alpha: 235, tStyle: false, dynamic: true },
  static: { style: 'static', size: 3.4, thickness: 0.7, gap: -0.8, outline: true, outlineThickness: 1, dot: false, color: [80, 250, 160], alpha: 235, tStyle: false, dynamic: false },
  dot: { style: 'static', size: 0, thickness: 1.2, gap: 0, outline: true, outlineThickness: 1, dot: true, color: [255, 255, 255], alpha: 255, tStyle: false, dynamic: false },
  large: { style: 'classic', size: 5, thickness: 1, gap: 1, outline: true, outlineThickness: 1, dot: false, color: [0, 255, 0], alpha: 200, tStyle: false, dynamic: true },
};

export const CROSSHAIR_COLORS = [
  ['Green', [0, 255, 0]], ['Cyan', [80, 250, 160]], ['Aqua', [0, 255, 255]], ['Yellow', [255, 255, 0]],
  ['Red', [255, 50, 50]], ['Magenta', [255, 0, 255]], ['White', [255, 255, 255]],
];

const DEFAULTS = {
  name: 'Player',
  sensitivity: 2.0,
  zoomRatio: 1.0,
  fov: 90,
  quality: 'high',
  volume: 0.8,
  radarScale: 0.8,
  radarRotate: true,
  showFps: false,
  difficulty: 'normal',
  teamSize: 5,
  crosshair: { ...CROSSHAIR_PRESETS.default },
};

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] === undefined) continue;
      if (k === 'crosshair' && typeof saved.crosshair === 'object') Object.assign(s.crosshair, saved.crosshair);
      else if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
    }
  }
  return s;
}

export const Settings = load();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(Settings)); } catch { /* private mode / blocked */ }
}

export function resetSettings() {
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k of Object.keys(d)) Settings[k] = d[k];
  saveSettings();
  applySettings();
}

const setCvar = (name, v) => {
  if (!(name in World.cvar)) return false;
  const cv = (typeof window !== 'undefined' && window.cv) || World.cvar;
  cv[name] = v;
  return true;
};

/** Push settings into cvars / renderer / audio. Safe to call any time (feature-detected). */
export function applySettings(which = null) {
  const all = !which;
  if (all || which === 'sensitivity') setCvar('sensitivity', Settings.sensitivity);
  if (all || which === 'zoomRatio') setCvar('zoom_sensitivity_ratio', Settings.zoomRatio);
  if (all || which === 'fov') {
    if (!setCvar('fov_desired', Settings.fov) && !setCvar('fov', Settings.fov) && !setCvar('r_fov', Settings.fov)) {
      World.fovDesired = Settings.fov;
    }
  }
  // a ?quality= URL override wins over the saved preset on boot
  if ((which === 'quality' || (all && !World.params?.get?.('quality'))) && !World.harness) {
    try { World.renderer?.setQuality?.(Settings.quality); World.quality = Settings.quality; } catch (e) { console.warn('[settings] setQuality', e); }
  }
  if (all || which === 'volume') {
    const a = World.audio;
    if (!setCvar('volume', Settings.volume) && !setCvar('snd_volume', Settings.volume)) {
      try {
        if (a?.setVolume) a.setVolume(Settings.volume);
        else if (a?.setMasterVolume) a.setMasterVolume(Settings.volume);
        else if (a?.master?.gain) a.master.gain.value = Settings.volume;
      } catch { /* audio not ready */ }
    }
  }
  World.emit('settings', { which });
}
