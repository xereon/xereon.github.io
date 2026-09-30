// Keyframed viewmodel animation clips. A clip is { dur, loop?, ch: { name: keys }, ev: [[t, name]] }
// with normalised time t in [0, 1]. Keys are [t, value, ease] — `ease` shapes the segment
// that ENDS at that key. Values are numbers or arrays (lerped component-wise).
//
// Channels understood by the Viewmodel:
//   gp, gr    gun position (in) / rotation (deg XYZ) offset, applied about the weapon pivot
//   mp, mr    magazine offset from rest (in, deg) about the magazine pivot part
//   magVis    0/1 magazine visible        bolt   0..1 bolt / charging handle travel
//   slide     0..1 pistol slide travel    lhMag / lhBolt / lhFree / lhSil  left-hand targets
//   lhFreeP   [x,y,z] free left-hand palm target (gun space); lhFreeR [rx,ry,rz] extra rotation
//   lhPose    [presetA, presetB, t] finger blend (step keys)   rhPose likewise
//   rp, rr    right-hand offset from its grip anchor (knife / grenade), sil 0..1 silencer seated
//   silRot    silencer spin (deg), silP [x,y,z] silencer offset, vis 0/1 whole weapon visible
//   nade      0..1 grenade released (hidden), pin 0..1 pin pulled
export const EASE = {
  lin: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  back: (t) => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  out2: (t) => 1 - (1 - t) * (1 - t),
  in2: (t) => t * t,
  step: (t) => (t < 1 ? 0 : 1),
  hold: () => 0,
};

/** Sample channel keys at normalised time t into `out` (array) or return a number. */
export function sample(keys, t, out) {
  const n = keys.length;
  if (!n) return out;
  let i = 0;
  while (i < n - 1 && keys[i + 1][0] <= t) i++;
  const a = keys[i];
  if (i >= n - 1 || t <= a[0]) return copy(a[1], out);
  const b = keys[i + 1];
  const e = EASE[b[2] || 'io'] || EASE.io;
  const k = e(Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))));
  if (typeof a[1] === 'number') return a[1] + (b[1] - a[1]) * k;
  if (typeof a[1] === 'string' || !Array.isArray(a[1])) return k < 1 ? a[1] : b[1];
  for (let j = 0; j < a[1].length; j++) out[j] = a[1][j] + (b[1][j] - a[1][j]) * k;
  return out;
}
/** Finger-pose channel: keys hold [presetA, presetB, w]; w lerps, names switch at key times. */
export function samplePose(keys, t, out) {
  const n = keys.length;
  let i = 0;
  while (i < n - 1 && keys[i + 1][0] <= t) i++;
  const a = keys[i][1];
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  if (i >= n - 1 || t <= keys[i][0]) return out;
  const b = keys[i + 1][1];
  if (b[0] !== a[0] || b[1] !== a[1]) return out;
  const e = EASE[keys[i + 1][2] || 'io'] || EASE.io;
  out[2] = a[2] + (b[2] - a[2]) * e(Math.min(1, Math.max(0, (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]))));
  return out;
}
function copy(v, out) {
  if (Array.isArray(v) && out) { for (let j = 0; j < v.length; j++) out[j] = v[j]; return out; }
  return v;
}

const Z3 = [0, 0, 0];
// ---- generic building blocks -------------------------------------------------------------------
function draw(o = {}) {
  const tw = o.twist ?? 1;
  return {
    dur: o.dur ?? 0.9,
    ch: {
      gp: [[0, [1.5, -9, 4]], [0.45, [0.1, 0.4, -0.3], 'out'], [0.7, [0, -0.1, 0.1], 'io'], [1, Z3, 'io']],
      gr: [[0, [-38, 22 * tw, -35 * tw]], [0.45, [3, -1.5, 3], 'out'], [0.7, [-1, 0.5, -0.8], 'io'], [1, Z3, 'io']],
      ...(o.bolt ? { bolt: [[0, 0], [0.55, 0], [0.7, 1, 'io'], [0.8, 1], [0.88, 0, 'in']], lhBolt: [[0, 0], [0.42, 0], [0.55, 1, 'io'], [0.84, 1], [1, 0, 'io']] } : {}),
      ...(o.slide ? { slide: [[0, 0], [0.55, 0], [0.66, 1, 'io'], [0.74, 0, 'in']] } : {}),
    },
    ev: o.bolt ? [[0.7, 'bolt_back'], [0.88, 'bolt_fwd']] : o.slide ? [[0.66, 'slide_back'], [0.74, 'slide_fwd']] : [],
  };
}

// Rifle magazine reload. style 'rock' (AK: tilt forward about the front lug) or 'straight' (STANAG).
function rifleReload(cfg, empty, dur) {
  const rock = cfg.magPivot === 'rock';
  const out = rock ? [0, -2.7, -0.7] : [0, -4.5, 0.3];
  const outR = rock ? [26, 0, 0] : [3, 0, 0];
  const far = [2, -16, 7];
  const E = !!empty;
  const tIn = E ? 0.6 : 0.68, tSeat = E ? 0.66 : 0.76;
  const ch = {
    gp: [[0, Z3], [0.1, [-0.6, 0.9, 0.4], 'io'], [0.3, [-0.4, 0.4, 0.3], 'io'], [0.5, [-0.9, 1.1, 0.6], 'io'], [tSeat - 0.02, [-0.7, 1.2, 0.3], 'io'],
      [tSeat, [-0.7, 0.9, 0.6], 'out'], [tSeat + 0.06, [-0.6, 1.1, 0.4], 'io'], [1, Z3, 'io']],
    gr: [[0, Z3], [0.1, [8, 6, -22], 'io'], [0.3, [5, 5, -18], 'io'], [0.5, [10, 8, -26], 'io'], [tSeat - 0.02, [9, 7, -25], 'io'],
      [tSeat, [6.5, 7, -23], 'out'], [tSeat + 0.06, [8, 7, -24], 'io'], [1, Z3, 'io']],
    mp: [[0, Z3], [0.14, Z3], [0.2, [0, 0.15, -0.15], 'io'], [0.3, out, 'in'], [0.33, out], [0.34, far, 'step'], [0.5, far], [tIn, out, 'out'], [tSeat - 0.02, [0, 0.12, -0.12], 'io'], [tSeat, Z3, 'in']],
    mr: [[0, Z3], [0.14, Z3], [0.3, outR, 'io'], [0.33, outR], [0.34, [outR[0] + 20, 0, 0], 'step'], [0.5, [outR[0] + 20, 0, 0]], [tIn, outR, 'out'], [tSeat, Z3, 'io']],
    magVis: [[0, 1], [0.335, 0, 'step'], [0.49, 0], [0.5, 1, 'step']],
    lhMag: [[0, 0], [0.04, 0], [0.14, 1, 'io'], [tSeat + 0.03, 1], [tSeat + 0.12, 0, 'io']],
    lhFree: [[0, 0], [0.3, 0], [0.36, 1, 'in2'], [0.46, 1], [0.5, 0, 'io']],
    lhFreeP: [[0, [-1, -18, -2]]],
    lhPose: [[0, ['wrap', 'cup', 0]], [0.14, ['wrap', 'cup', 1], 'io'], [tSeat + 0.05, ['wrap', 'cup', 1]], [tSeat + 0.14, ['wrap', 'cup', 0], 'io']],
  };
  const ev = [[0.2, 'mag_release'], [0.33, 'mag_drop'], [tSeat, 'mag_in']];
  if (E) {
    const b0 = tSeat + 0.1, b1 = b0 + 0.07, b2 = b1 + 0.08;
    ch.lhMag = [[0, 0], [0.04, 0], [0.14, 1, 'io'], [tSeat + 0.02, 1], [b0, 0, 'io']];
    ch.lhBolt = [[0, 0], [tSeat + 0.02, 0], [b0, 1, 'io'], [b2 + 0.02, 1], [b2 + 0.12, 0, 'io']];
    ch.bolt = [[0, 0], [b0, 0], [b1, 1, 'io'], [b1 + 0.02, 1], [b2, 0, 'in']];
    ch.lhPose = [[0, ['wrap', 'cup', 0]], [0.14, ['wrap', 'cup', 1], 'io'], [tSeat + 0.02, ['wrap', 'cup', 1]], [b0, ['pinch', 'cup', 0], 'step'], [b2 + 0.04, ['pinch', 'cup', 0]], [b2 + 0.12, ['wrap', 'pinch', 0], 'step']];
    ch.gr = [[0, Z3], [0.1, [8, 6, -22], 'io'], [0.3, [5, 5, -18], 'io'], [0.5, [10, 8, -26], 'io'], [tSeat, [6.5, 7, -23], 'out'],
      [b0, [4, -4, 14], 'io'], [b1, [6, -5, 18], 'io'], [b2, [3, -4, 12], 'out'], [1, Z3, 'io']];
    ch.gp = [[0, Z3], [0.1, [-0.6, 0.9, 0.4], 'io'], [0.5, [-0.9, 1.1, 0.6], 'io'], [tSeat, [-0.7, 0.9, 0.6], 'out'], [b0, [-1.2, 0.8, 0.5], 'io'], [b1, [-1.1, 0.8, 1.3], 'io'], [b2, [-1.2, 0.8, 0.2], 'out'], [1, Z3, 'io']];
    ev.push([b1, 'bolt_back'], [b2, 'bolt_fwd']);
  }
  return { dur, ch, ev };
}

// Pistol reload: mag drops out of the grip, new one slapped in, slide release if empty.
function pistolReload(cfg, empty, dur) {
  const far = [0, -14, 3];
  const tIn = 0.62, tSeat = 0.68;
  const ch = {
    gp: [[0, Z3], [0.12, [-1.0, 1.4, 0.5], 'io'], [0.35, [-0.9, 1.6, 0.5], 'io'], [tSeat - 0.02, [-1.1, 1.5, 0.4], 'io'], [tSeat, [-1.0, 1.9, 0.6], 'out'], [tSeat + 0.06, [-1.0, 1.5, 0.5], 'io'], [1, Z3, 'io']],
    gr: [[0, Z3], [0.12, [14, 10, -24], 'io'], [0.35, [12, 9, -20], 'io'], [tSeat - 0.02, [16, 10, -26], 'io'], [tSeat, [12, 10, -24], 'out'], [1, Z3, 'io']],
    mp: [[0, Z3], [0.12, Z3], [0.2, [0, -4, 0.2], 'in2'], [0.3, [0, -12, 1], 'in'], [0.31, far, 'step'], [0.45, far], [tIn, [0, -1.5, 0.1], 'out'], [tSeat, Z3, 'in']],
    magVis: [[0, 1], [0.3, 0, 'step'], [0.44, 0], [0.45, 1, 'step']],
    lhMag: [[0, 0], [0.28, 0], [0.4, 1, 'io'], [tSeat + 0.03, 1], [tSeat + 0.14, 0, 'io']],
    lhFree: [[0, 0], [0.06, 1, 'io'], [0.28, 1], [0.4, 0, 'io']],
    lhFreeP: [[0, [-3, -12, 1]]],
    lhPose: [[0, ['cup', 'cup', 0]]],
  };
  const ev = [[0.15, 'mag_release'], [0.3, 'mag_drop'], [tSeat, 'mag_in']];
  if (empty) {
    ch.slide = [[0, 1], [0.8, 1], [0.84, 0, 'in']];
    ch.gr = [...ch.gr.slice(0, -1), [0.8, [4, 4, -10], 'io'], [0.84, [7, 5, -12], 'out'], [1, Z3, 'io']];
    ev.push([0.82, 'slide_fwd']);
  }
  return { dur, ch, ev };
}

// Shotgun: tilt, feed shells one by one into the loading port, pump if empty.
function shotgunReload(cfg, empty, dur) {
  const n = Math.max(2, Math.min(8, cfg.shells || 4));
  const ch = {
    gp: [[0, Z3], [0.08, [-0.8, 1.2, 0.5], 'io'], [0.92, [-0.8, 1.2, 0.5]], [1, Z3, 'io']],
    gr: [[0, Z3], [0.08, [6, 8, -30], 'io'], [0.92, [6, 8, -30]], [1, Z3, 'io']],
    lhFree: [[0, 0], [0.08, 1, 'io'], [0.9, 1], [1, 0, 'io']],
    lhFreeP: [[0, cfg.loadPort || [0.2, -2.6, -6]]],
    lhPose: [[0, ['pinch', 'pinch', 0]]],
    shell: [[0, 0]],
  };
  const P = cfg.loadPort || [0.2, -2.6, -6];
  const keys = [[0, P], [0.08, P]];
  const sk = [[0, 0], [0.08, 0]];
  const ev = [];
  for (let i = 0; i < n; i++) {
    const t0 = 0.1 + (i / n) * 0.8, t1 = t0 + 0.8 / n;
    keys.push([t0 + (t1 - t0) * 0.3, [P[0] - 1.5, P[1] - 5, P[2] + 1.5], 'io'], [t0 + (t1 - t0) * 0.75, [P[0], P[1] - 0.6, P[2]], 'io'], [t1, [P[0], P[1] + 0.1, P[2] + 0.3], 'in']);
    sk.push([t0 + (t1 - t0) * 0.3, 1, 'step'], [t1, 1], [t1 + 0.0001, 0, 'step']);
    ev.push([t1 - 0.02, 'shell_in']);
  }
  ch.lhFreeP = keys;
  ch.shell = sk;
  if (empty) { ch.pump = [[0, 0], [0.9, 0], [0.94, 1, 'io'], [0.98, 0, 'io']]; ev.push([0.94, 'pump_back'], [0.98, 'pump_fwd']); }
  return { dur, ch, ev };
}

// Bolt-action (AWP/SSG): lift handle, pull, push, lower — used both after each shot and in reloads.
function boltCycle(dur = 1.2) {
  return {
    dur,
    ch: {
      gp: [[0, Z3], [0.15, [-0.5, 0.6, 0.6], 'io'], [0.8, [-0.5, 0.6, 0.6]], [1, Z3, 'io']],
      gr: [[0, Z3], [0.15, [4, 4, -14], 'io'], [0.45, [3, 3, -12], 'io'], [0.8, [4, 4, -14], 'io'], [1, Z3, 'io']],
      boltLift: [[0, 0], [0.2, 0], [0.3, 1, 'io'], [0.68, 1], [0.76, 0, 'io']],
      bolt: [[0, 0], [0.32, 0], [0.45, 1, 'io'], [0.5, 1], [0.64, 0, 'io']],
      rhBolt: [[0, 0], [0.08, 1, 'io'], [0.8, 1], [0.95, 0, 'io']],
      rhPose: [[0, ['trigger', 'pinch', 0]], [0.12, ['trigger', 'pinch', 1], 'io'], [0.78, ['trigger', 'pinch', 1]], [0.95, ['trigger', 'pinch', 0], 'io']],
    },
    ev: [[0.3, 'bolt_up'], [0.45, 'bolt_back'], [0.64, 'bolt_fwd'], [0.76, 'bolt_down']],
  };
}
function boltReload(cfg, empty, dur) {
  const r = rifleReload({ ...cfg, magPivot: 'straight' }, false, dur);
  if (empty) {
    const bc = boltCycle(1);
    const s = (k) => k.map(([t, v, e]) => [0.72 + t * 0.26, v, e]);
    r.ch.boltLift = [[0, 0], ...s(bc.ch.boltLift)];
    r.ch.bolt = [[0, 0], ...s(bc.ch.bolt)];
    r.ch.rhBolt = [[0, 0], ...s(bc.ch.rhBolt)];
    r.ch.rhPose = [[0, ['trigger', 'pinch', 0]], ...s(bc.ch.rhPose)];
  }
  return r;
}

// LMG: open top cover, swap box, close cover.
function lmgReload(cfg, empty, dur) {
  const r = rifleReload({ ...cfg, magPivot: 'straight' }, false, dur);
  r.ch.cover = [[0, 0], [0.08, 0], [0.16, 1, 'io'], [0.78, 1], [0.86, 0, 'in']];
  r.ch.lhFree = [[0, 0], [0.04, 1, 'io'], [0.12, 1], [0.18, 0, 'io'], [0.3, 0], [0.36, 1, 'in2'], [0.46, 1], [0.5, 0, 'io'], [0.74, 0], [0.78, 1, 'io'], [0.86, 1], [0.94, 0, 'io']];
  r.ch.lhFreeP = [[0, cfg.coverGrab || [0, 2, -6]], [0.3, cfg.coverGrab || [0, 2, -6]], [0.31, [-1, -18, -2], 'step'], [0.5, [-1, -18, -2]], [0.51, cfg.coverGrab || [0, 2, -6], 'step']];
  r.ch.lhMag = [[0, 0], [0.18, 0], [0.24, 1, 'io'], [0.72, 1], [0.76, 0, 'io']];
  r.ev.push([0.16, 'cover_open'], [0.86, 'cover_close']);
  return r;
}

// CS2-style inspect: turn the weapon to show its right side, roll it back to the left, settle.
function inspect(o = {}) {
  const k = o.scale ?? 1;
  return {
    dur: o.dur ?? 5.2,
    ch: {
      gp: [[0, Z3], [0.12, [-2.4 * k, 2.0, 1.0], 'io'], [0.38, [-2.7 * k, 2.2, 1.2], 'sine'], [0.5, [-1.8 * k, 1.4, 0.4], 'io'], [0.72, [-2.2 * k, 1.6, 0.7], 'sine'], [0.84, [-1.0, 0.5, 0.3], 'io'], [1, Z3, 'io']],
      gr: [[0, Z3], [0.12, [14, 24, 62], 'io'], [0.38, [18, 28, 70], 'sine'], [0.5, [6, 14, -28], 'io'], [0.72, [9, 18, -36], 'sine'], [0.84, [3, 6, -6], 'io'], [1, Z3, 'io']],
      lhFree: o.hands === 1 ? [[0, 0]] : [[0, 0], [0.08, 1, 'io'], [0.44, 1], [0.54, 0, 'io']],
      lhFreeP: [[0, o.lhUnder || [0.5, -3.5, -8]]],
      lhPose: [[0, ['wrap', 'cup', 0]], [0.1, ['wrap', 'cup', 1], 'io'], [0.44, ['wrap', 'cup', 1]], [0.54, ['wrap', 'cup', 0], 'io']],
    },
    ev: [],
  };
}

function knifeInspect() {
  return {
    dur: 4.2,
    ch: {
      gp: [[0, Z3], [0.15, [-3.5, 2.2, 1.5], 'io'], [0.45, [-3.8, 2.4, 1.3], 'sine'], [0.6, [-2.5, 2.0, 1.0], 'io'], [0.82, [-2.2, 2.1, 1.2], 'sine'], [1, Z3, 'io']],
      gr: [[0, Z3], [0.15, [-10, 45, 80], 'io'], [0.45, [-12, 50, 88], 'sine'], [0.6, [-4, 30, -70], 'io'], [0.82, [-6, 34, -80], 'sine'], [1, Z3, 'io']],
    },
    ev: [],
  };
}
function melee(heavy) {
  if (heavy) {
    return {
      dur: 1.0,
      ch: {
        gp: [[0, Z3], [0.25, [-1.5, 2.5, 3.5], 'io'], [0.4, [-3.5, 0.8, -7], 'in'], [0.52, [-3.2, 0.9, -6.5], 'out'], [1, Z3, 'io']],
        gr: [[0, Z3], [0.25, [25, 5, 20], 'io'], [0.4, [-8, 10, 5], 'in'], [0.52, [-6, 9, 4]], [1, Z3, 'io']],
      },
      ev: [[0.4, 'hit']],
    };
  }
  return {
    dur: 0.5,
    ch: {
      gp: [[0, Z3], [0.18, [2.5, 1.8, 1.0], 'out2'], [0.45, [-6.5, -1.0, -3.5], 'in2'], [0.6, [-7, -1.4, -3], 'out'], [1, Z3, 'io']],
      gr: [[0, Z3], [0.18, [10, -30, -25], 'out2'], [0.45, [-10, 50, 30], 'in2'], [0.6, [-12, 55, 32]], [1, Z3, 'io']],
    },
    ev: [[0.42, 'hit']],
  };
}
function nadePin() {
  return {
    dur: 0.9,
    ch: {
      gp: [[0, Z3], [0.3, [-1, 0.8, 1], 'io'], [0.7, [-0.8, 0.8, 1]], [1, [0, 0.4, 0.5], 'io']],
      gr: [[0, Z3], [0.3, [10, 6, -10], 'io'], [1, [4, 2, -4], 'io']],
      pin: [[0, 0], [0.45, 0], [0.62, 1, 'in2']],
      lhFree: [[0, 0], [0.2, 1, 'io'], [0.62, 1], [1, 1]],
      lhFreeP: [[0, [-0.6, 0.9, -0.6]], [0.45, [-0.6, 0.9, -0.6]], [0.62, [-4, 2, 1], 'out'], [1, [-6, -4, 3], 'io']],
      lhPose: [[0, ['pinch', 'pinch', 0]]],
    },
    ev: [[0.55, 'pin_pull']],
  };
}
function nadeThrow() {
  return {
    dur: 0.8,
    ch: {
      gp: [[0, [0, 0.4, 0.5]], [0.3, [1.5, 3.5, 6], 'io'], [0.5, [-2, 2, -9], 'in2'], [0.62, [-3, -1, -11], 'out'], [1, [0, -12, 2], 'io']],
      gr: [[0, [4, 2, -4]], [0.3, [-35, 0, 10], 'io'], [0.5, [20, 5, -10], 'in2'], [1, [40, 0, 0], 'io']],
      nade: [[0, 0], [0.49, 0], [0.5, 1, 'step']],
      lhFree: [[0, 1]], lhFreeP: [[0, [-6, -4, 3]], [0.4, [-8, -2, -3], 'io'], [1, [-6, -14, 3], 'io']],
      lhPose: [[0, ['relaxed', 'relaxed', 0]]],
      pin: [[0, 1]],
    },
    ev: [[0.5, 'release']],
  };
}
function silencer(on, cfg, dur) {
  // screw on: bring suppressor from below-left, spin on. off: spin off, take away.
  const seat = on ? [[0, 0], [0.4, 0], [0.45, 0.3, 'in2'], [0.85, 1, 'lin']] : [[0, 1], [0.1, 1], [0.55, 0.3, 'lin'], [0.6, 0, 'lin']];
  const spin = on ? [[0, 0], [0.45, 0], [0.85, 720, 'lin']] : [[0, 720], [0.1, 720], [0.55, 0, 'lin']];
  const ch = {
    gp: [[0, Z3], [0.15, [-2.2, 1.5, 0.4], 'io'], [0.85, [-2.2, 1.5, 0.4]], [1, Z3, 'io']],
    gr: [[0, Z3], [0.15, [4, 20, -8], 'io'], [0.5, [5, 22, -10], 'sine'], [0.85, [4, 20, -8], 'sine'], [1, Z3, 'io']],
    sil: seat, silRot: spin,
    silVis: on ? [[0, 0], [0.18, 1, 'step']] : [[0, 1], [0.78, 0, 'step']],
    lhSil: on ? [[0, 0], [0.18, 1, 'io'], [0.86, 1], [1, 0, 'io']] : [[0, 0], [0.12, 1, 'io'], [0.65, 1], [0.78, 1]],
    lhFree: on ? [[0, 1], [0.18, 0, 'io']] : [[0, 0], [0.65, 0], [0.8, 1, 'io']],
    lhFreeP: [[0, [-3, -12, 0]]],
    lhPose: [[0, ['pinch', 'pinch', 0]]],
  };
  if (!on) ch.silP = [[0, Z3], [0.55, Z3], [0.78, [-1, -6, -2], 'in2']];
  else ch.silP = [[0, [-1, -6, -2]], [0.18, [-1, -6, -2]], [0.4, [0, 0, -0.8], 'out'], [0.45, Z3, 'io']];
  return { dur, ch, ev: [[on ? 0.85 : 0.1, on ? 'sil_on' : 'sil_off']] };
}
function zoomIn() {
  return {
    dur: 0.2, hold: true,
    ch: { gp: [[0, Z3], [0.7, [-4.5, 3.2, 3.5], 'out']], gr: [[0, Z3], [0.7, [4, -4, 0], 'out']], vis: [[0, 1], [0.99, 1], [1, 0, 'step']] },
    ev: [[1, 'scoped']],
  };
}
function zoomOut() {
  return { dur: 0.25, ch: { gp: [[0, [-2, 1.5, 2]], [1, Z3, 'out']], gr: [[0, [2, -2, 0]], [1, Z3, 'out']] }, ev: [] };
}
function c4Plant(dur = 3.2) {
  const ch = {
    gp: [[0, Z3], [0.1, [-1.5, -1, -1], 'io'], [0.9, [-1.5, -1, -1]], [1, [0, -6, 2], 'io']],
    gr: [[0, Z3], [0.1, [25, 0, 0], 'io'], [0.9, [25, 0, 0]], [1, [45, 0, 0], 'io']],
    rhFree: [[0, 0], [0.1, 1, 'io'], [0.9, 1], [1, 0, 'io']],
  };
  const keys = [[0, [0.3, 1.8, -1.8]]];
  const pads = [[-0.3, -1.6], [0, -1.8], [0.3, -1.6], [0, -2.0], [-0.3, -1.9], [0.3, -2.0], [0, -1.6]];
  pads.forEach(([x, z], i) => { const t = 0.15 + i * 0.1; keys.push([t, [x, 1.9, z], 'io'], [t + 0.04, [x, 1.65, z], 'in2'], [t + 0.08, [x, 1.9, z], 'out']); });
  ch.rhFreeP = keys;
  return { dur, ch, ev: pads.map((_, i) => [0.19 + i * 0.1, 'key']) };
}

/** Clip factory. family comes from the weapon config; def = registry entry (may be null). */
export function makeClip(anim, cfg, def) {
  const fam = cfg.family || 'rifle';
  const deployT = Math.min(1.1, Math.max(0.5, def?.deployTime || 1.0));
  switch (anim) {
    case 'draw':
      if (fam === 'knife') return draw({ dur: 0.8, twist: -1.2 });
      if (fam === 'grenade' || fam === 'c4') return draw({ dur: 0.7, twist: 0.5 });
      if (fam === 'pistol') return draw({ dur: deployT, slide: true });
      return draw({ dur: deployT, bolt: fam === 'rifle' || fam === 'smg' });
    case 'reload': case 'reload_empty': {
      const e = anim === 'reload_empty';
      const reloadT = (e && def?.reloadEmpty) || def?.reloadTime || cfg.reloadTime || 2.4;
      if (fam === 'pistol') return pistolReload(cfg, e, reloadT);
      if (fam === 'shotgun') return cfg.magFed ? rifleReload(cfg, e, reloadT) : shotgunReload(cfg, e, reloadT);
      if (fam === 'sniper') return cfg.bolt ? boltReload(cfg, e, reloadT) : rifleReload(cfg, e, reloadT);
      if (fam === 'lmg') return lmgReload(cfg, e, reloadT);
      return rifleReload(cfg, e, reloadT);
    }
    case 'inspect':
      if (fam === 'knife') return knifeInspect();
      if (fam === 'pistol') return inspect({ dur: 4.2, scale: 0.8, lhUnder: [0.2, -2.8, -3] });
      if (fam === 'grenade' || fam === 'c4') return inspect({ dur: 3.4, scale: 0.6, hands: 1 });
      return inspect({ lhUnder: cfg.inspectL });
    case 'melee': return melee(false);
    case 'melee_heavy': return melee(true);
    case 'pin': return nadePin();
    case 'throw': return nadeThrow();
    case 'zoom_in': return zoomIn();
    case 'zoom_out': return zoomOut();
    case 'bolt': return boltCycle(Math.max(0.9, (def?.cycleTime || 1.45) * 0.85));
    case 'silencer_on': return silencer(true, cfg, def?.silencerTime || 2.7);
    case 'silencer_off': return silencer(false, cfg, def?.silencerOffTime || def?.silencerTime || 2.2);
    case 'plant': return c4Plant(def?.plantTime || 3.2);
    default: return null;
  }
}
