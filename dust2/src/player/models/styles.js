// Team looks: paint functions (baked into the atlas) + gear geometry.
//   T  — CS2 Phoenix-style: olive knit balaclava (eye + mouth holes), plaid shirt with rolled
//        sleeves, cream mesh load-bearing vest, olive cargo pants, black gloves, dark boots.
//   CT — SAS/SEAL-style: high-cut helmet with NVG, ear-pro, goggles, black balaclava, cool
//        grey-green camo combat shirt + pants, ranger-green plate carrier, radio, knee pads.
import * as THREE from 'three';
import {
  fbm, vnoise, hex, set3, mix3, sstep, clamp01, stitch, folds,
  cloth, nylon, polymer, leather, skin, metal, flat,
} from './paint.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const HC = { x: 1.05, y: 66.4 };
const frac = (x) => x - Math.floor(x);

// colour constants (hoisted so paint loops do not allocate)
const C0 = [0.12, 0.08, 0.06];
const C1 = [0.62, 0.56, 0.5];
const C2 = [0.03, 0.03, 0.03];
const C3 = [0.52, 0.32, 0.28];
const C4 = [0.1, 0.05, 0.05];
const C5 = [0.74, 0.72, 0.68];
const C6 = [0.55, 0.2, 0.17];
const C7 = [0.28, 0.3, 0.38];
const C8 = [0.8, 0.78, 0.72];
const C9 = [0.2, 0.21, 0.19];
const C10 = [0.1, 0.1, 0.1];
const C11 = [0.06, 0.07, 0.08];

// ---- shared paint helpers -------------------------------------------------------------------
function headAngle(ctx) { return Math.atan2(-ctx.z, ctx.x - HC.x); }  // 0 front, + = left

const BI = { face: -1, s: 0, t: 0, e: 0 };
function boxInfo(ctx) {
  const is = ctx.island;
  BI.s = (ctx.u - is.u0) / Math.max(1e-6, is.u1 - is.u0); BI.t = (ctx.v - is.v0) / Math.max(1e-6, is.v1 - is.v0);
  BI.e = Math.min(ctx.u - is.u0, is.u1 - ctx.u, ctx.v - is.v0, is.v1 - ctx.v);
  BI.face = is.face ?? -1;
  return BI;
}

function knitPaint(color, o = {}) {
  const base = hex(color), skinC = hex(o.skin ?? 0xa87a5c);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 0.7, ctx.y * 0.7, ctx.z * 0.7, 3);
    const k = 1 + m * 0.14; ctx.r *= k; ctx.g *= k; ctx.b *= k;
    // knit ribs (vertical) + loop rows
    const rib = Math.sin((ctx.u / 0.42) * Math.PI * 2);
    const row = Math.sin((ctx.v / 0.3) * Math.PI * 2 + rib * 0.6);
    ctx.h += rib * 0.018 + row * 0.006 + vnoise(ctx.x * 5, ctx.y * 5, ctx.z * 5) * 0.008;
    const kk = 0.93 + rib * 0.05; ctx.r *= kk; ctx.g *= kk; ctx.b *= kk;
    ctx.rough = 0.95;
    if (o.holes) {
      const a = headAngle(ctx), y = ctx.y;
      const hole = (da, dy, ca, cy) => Math.hypot((a - ca) / da, (y - cy) / dy);
      const eL = hole(0.26, 0.5, 0.5, 66.75), eR = hole(0.26, 0.5, -0.5, 66.75);
      const mo = o.mouth ? hole(0.27, 0.42, 0, 63.6) : 9;
      const d = Math.min(eL, eR, mo);
      if (d < 1.0) {
        set3(ctx, skinC);
        const n = fbm(ctx.x * 1.5, ctx.y * 1.5, ctx.z * 1.5, 2);
        ctx.r *= 1 + n * 0.08; ctx.g *= 1 + n * 0.1; ctx.b *= 1 + n * 0.1;
        ctx.rough = 0.5; ctx.h = -0.05 * (1 - d);
        // skin in the opening is shadowed by the knit rim
        const sh = 0.72 + 0.28 * sstep(0.95, 0.45, d); ctx.r *= sh; ctx.g *= sh; ctx.b *= sh;
        if (d === eL || d === eR) {
          const ca = d === eL ? 0.5 : -0.5;
          const ed = Math.hypot((a - ca) / 0.16, (ctx.y - 66.72) / 0.19);
          if (ed < 1) {
            // eye: dark iris, thin sclera edges, glossy
            const ir = Math.hypot((a - ca) / 0.075, (ctx.y - 66.72) / 0.14);
            set3(ctx, ir < 1 ? C0 : C1);
            if (ir < 0.45) set3(ctx, C2);
            ctx.rough = 0.18; ctx.h = -0.06;
            ctx.occ = 0.75;
          } else if (ed < 1.35) { // lids
            ctx.r *= 0.72; ctx.g *= 0.65; ctx.b *= 0.62; ctx.h = -0.02;
          }
        } else {
          const lip = Math.hypot(headAngle(ctx) / 0.2, (ctx.y - 63.58) / 0.2);
          if (lip < 1) { mix3(ctx, C3, 0.65); ctx.rough = 0.4; }
          if (Math.abs(ctx.y - 63.58) < 0.035 && Math.abs(a) < 0.17) { set3(ctx, C4); ctx.h = -0.08; }
        }
      } else if (d < 1.28) {
        // rolled / hemmed rim around the opening
        const t = (d - 1.0) / 0.28;
        ctx.h += Math.sin(t * Math.PI) * 0.07;
        const k2 = 0.85 + 0.15 * Math.sin(t * Math.PI); ctx.r *= k2; ctx.g *= k2; ctx.b *= k2;
      }
    }
  };
}

const SOLE_DUST = hex(0xa38e6c), VEST_DUST = hex(0xb9a27c);
function rubberSole(color = 0x1f1d1b) {
  const base = hex(color);
  return (ctx) => {
    set3(ctx, base);
    ctx.rough = 0.92;
    if (ctx.ny < -0.6) { // underside: lug tread
      const lu = Math.floor(ctx.x / 0.9), lv = frac(ctx.z / 0.8 + (lu & 1) * 0.5);
      ctx.h += (frac(ctx.x / 0.9) < 0.6 && lv < 0.6 ? 1 : 0) * 0.08;
    } else {
      // side wall: moulded grooves, welt line, dust
      ctx.h += Math.sin(ctx.y * 11) * 0.012;
      if (ctx.y > 0.95) { ctx.r *= 1.25; ctx.g *= 1.2; ctx.b *= 1.15; }
      const d = clamp01(0.4 + fbm(ctx.x * 0.4, ctx.y, ctx.z * 0.4) * 0.8);
      mix3(ctx, SOLE_DUST, d * 0.35);
    }
  };
}

function bootPaint(color, o = {}) {
  const base = leather({ color, rough: o.rough ?? 0.6, dust: o.dust ?? 1 }), lace = hex(o.lace ?? 0x2a2622);
  return (ctx) => {
    base(ctx);
    // laces up the front of the shaft / instep
    const fwd = ctx.nx; // bind: boots face +X
    if (fwd > 0.55 && ctx.y > 3.2 && ctx.y < 9.3 && Math.abs(ctx.nz) < 0.6) {
      const k = frac(ctx.y / 0.62);
      const w = Math.abs(ctx.nz) < 0.45 ? 1 : 0;
      const zig = Math.abs(k - 0.5) * 2;
      if (w && Math.abs(Math.abs(ctx.nz) * 2.2 - zig) < 0.35) { set3(ctx, lace); ctx.h += 0.05; ctx.rough = 0.8; }
      else if (w) ctx.h -= 0.02;
    }
    // stitched welt near the sole
    if (ctx.y < 1.5) { stitch(ctx, Math.abs(ctx.y - 1.25), 0.05, 0.02); }
    // collar padding line
    if (ctx.y > 9.0) ctx.h += 0.02;
    // creasing at the ankle flex
    if (ctx.y > 3 && ctx.y < 5.5 && ctx.nx > 0.2) ctx.h += Math.sin(ctx.y * 7 + ctx.z * 1.5) * 0.012;
  };
}

function glovePaint(color, o = {}) {
  const base = leather({ color, rough: 0.72 });
  const pad = hex(o.pad ?? color);
  return (ctx) => {
    base(ctx);
    // synthetic palm grip texture + seams on fingers
    ctx.h += vnoise(ctx.u * 3.5, ctx.v * 3.5, 2.2) * 0.005;
    if (o.pad !== undefined && (ctx.island.face === 0 || ctx.island.face === 2)) mix3(ctx, pad, 0.6);
    const b = boxInfo(ctx);
    if (b.e < 0.12) ctx.h -= 0.01;
  };
}

// ---- T paints ---------------------------------------------------------------------------------
const T_OLIVE = hex(0x5e5f3f), T_OLIVE_D = hex(0x43442d), T_OLIVE_L = hex(0x74704f);
function tPantsPattern(ctx) {
  set3(ctx, T_OLIVE);
  const n = fbm(ctx.x * 0.11 + 3, ctx.y * 0.11, ctx.z * 0.11, 3);
  if (n > 0.08) mix3(ctx, T_OLIVE_D, sstep(0.08, 0.2, n) * 0.75);
  const n2 = fbm(ctx.x * 0.16 + 11, ctx.y * 0.16, ctx.z * 0.16 + 7, 3);
  if (n2 > 0.22) mix3(ctx, T_OLIVE_L, sstep(0.22, 0.32, n2) * 0.45);
}
function legWrinkles(ctx) {
  const k = ctx.part.data.kind;
  if (k === 'leg') {
    const side = ctx.part.data.side === 'L' ? -1 : 1;
    const back = ctx.nx < -0.2 ? 1 : 0;
    // irregular knee bunching (stronger at the back of the knee)
    folds(ctx, ctx.y - 20.5 + vnoise(ctx.u * 0.6, 1.3, side) * 1.2, 3.4, 0.05 + 0.03 * back, 0.85 + vnoise(ctx.u * 0.4, 7, side) * 0.25, 1.3);
    folds(ctx, ctx.y - 9.6, 1.5, 0.055, 1.6, 4.1);    // bunching above the boots
    // outer side seam
    if (ctx.nz * side > 0.9) stitch(ctx, (1 - ctx.nz * side) * 6, 0.1, 0.02);
    // inner seam
    if (-ctx.nz * side > 0.93) stitch(ctx, (1 + ctx.nz * side) * 6, 0.08, 0.015);
  } else if (k === 'hips') {
    const az = Math.abs(ctx.z);
    if (ctx.nx > 0.25) {
      // crotch whiskers radiating up and out from the fly
      const t = ctx.y - 33.5;
      if (t > -0.5 && t < 5.5 && az > 1.2) {
        const d = az * 0.75 - t * 0.55;
        const env = Math.sin(Math.min(1, Math.max(0, t / 5.5)) * Math.PI) * sstep(1.2, 2.2, az) * sstep(7.2, 5.5, az);
        ctx.h += Math.sin(d * 2.4 + vnoise(ctx.y * 0.5, az * 0.5, 1) * 1.5) * 0.045 * env;
      }
      // fly: J-stitch on the left of centre
      if (ctx.y > 34.2 && ctx.y < 40.3) {
        const fz = ctx.z + 0.55;
        const hook = ctx.y < 35.4 ? Math.hypot(fz + 0.55 - 0.55, (ctx.y - 35.4) * 1.0) : Math.abs(fz);
        stitch(ctx, Math.abs(hook - 0.55), 0.045, 0.02);
        if (Math.abs(ctx.z) < 0.08) ctx.h -= 0.03;
      }
      // slash pocket openings: curve from the waistband down to the side seam
      if (az > 2.6 && az < 7.4 && ctx.y > 35.2 && ctx.y < 40.5) {
        const a = (az - 2.9) / 3.8, curve = 40.4 - 4.6 * a * a;
        const d = Math.abs(ctx.y - curve);
        if (d < 0.12) { ctx.h -= 0.05; ctx.r *= 0.78; ctx.g *= 0.78; ctx.b *= 0.78; }
        else if (ctx.y < curve && d < 0.35) stitch(ctx, Math.abs(d - 0.25), 0.03, 0.015);
      }
    } else if (ctx.nx < -0.3 && ctx.y > 34.5 && ctx.y < 40.2) {
      // back pockets
      const pz = Math.abs(az - 3.3), py = ctx.y - 37.0;
      if (pz < 2.0 && Math.abs(py) < 2.4) {
        const e = Math.min(2.0 - pz, 2.4 - Math.abs(py));
        ctx.h += 0.02; if (e < 0.2) stitch(ctx, Math.abs(e - 0.1), 0.03, 0.015);
        if (Math.abs(py - 1.6) < 0.06) ctx.h -= 0.04;
      }
    }
    // centre seam front / back
    if (az < 0.25 && (ctx.nx < -0.3 || ctx.y < 34.2)) stitch(ctx, az, 0.06, 0.02);
    folds(ctx, ctx.y - 33.8, 1.6, 0.025, 1.1, 2.1);
  } else if (k === 'pocket') {
    const b = boxInfo(ctx);
    if (b.face === 0) {
      if (Math.abs(b.s - 0.72) < 0.03) { ctx.h -= 0.05; ctx.r *= 0.75; ctx.g *= 0.75; ctx.b *= 0.75; }
      else if (b.s > 0.72) ctx.h += 0.03;
      if (Math.abs(b.t - 0.5) < 0.06 && b.s > 0.2 && b.s < 0.66) ctx.h -= 0.03;   // box pleat
    }
    if (b.e < 0.25) stitch(ctx, Math.abs(b.e - 0.12), 0.03, 0.02);
  }
}
function plaid(ctx) {
  // grey/white shirt with dark and red checks
  const base = C5;
  set3(ctx, base);
  const pu = frac(ctx.u / 2.6), pv = frac(ctx.v / 2.6);
  const band = (p) => (p < 0.26 ? 1 : p > 0.5 && p < 0.56 ? 2 : p > 0.7 && p < 0.74 ? 3 : 0);
  const bu = band(pu), bv = band(pv);
  const apply = (b, k) => {
    if (b === 1) { ctx.r *= 0.5 * k + (1 - k); ctx.g *= 0.52 * k + (1 - k); ctx.b *= 0.58 * k + (1 - k); }
    else if (b === 2) mix3(ctx, C6, 0.55 * k);
    else if (b === 3) mix3(ctx, C7, 0.45 * k);
  };
  apply(bu, 0.8); apply(bv, 0.8);
  // twill diagonal on the dark bands
  if (bu === 1 || bv === 1) { const d = Math.sin((ctx.u + ctx.v) * 30); ctx.r *= 1 + d * 0.04; ctx.g *= 1 + d * 0.04; ctx.b *= 1 + d * 0.04; }
}
function shirtWrinkles(ctx) {
  const k = ctx.part.data.kind;
  if (k === 'torso') {
    folds(ctx, ctx.y - 41.2, 2.2, 0.05, 1.2, 3.3);  // blousing over the belt
    // button placket at the front
    if (ctx.nx > 0.93 && ctx.y > 41 && ctx.y < 59) {
      const d = Math.abs(ctx.z);
      stitch(ctx, Math.abs(d - 0.55), 0.05, 0.015);
      if (d < 0.2 && frac(ctx.y / 3.2) < 0.1) { set3(ctx, C8); ctx.h += 0.04; ctx.rough = 0.4; }
    }
  } else if (k === 'sleeve') {
    // rolled cuff band + folds; seam under the arm
    const d = ctx.v - ctx.island.v1;
    if (!ctx.part.data.full && d > -3.2) {
      ctx.h += Math.sin((d / 1.1) * Math.PI * 2) * 0.05;
      if (d > -2.9) { ctx.r *= 0.93; ctx.g *= 0.93; ctx.b *= 0.93; }
    }
    folds(ctx, ctx.v - ctx.island.v0 - 4, 3, 0.03, 0.9, 5.5);
  }
}
function forearmPaint() {
  const s = skin({ color: 0xa47658 });
  return (ctx) => {
    s(ctx);
    // arm hair / veins hint: subtle darker mottling toward the wrist
    const n = vnoise(ctx.x * 3, ctx.y * 3, ctx.z * 3);
    ctx.r *= 0.97 + n * 0.03; ctx.g *= 0.96 + n * 0.03;
  };
}
function meshVest(color, o = {}) {
  const base = hex(color), holeC = hex(o.hole ?? 0x6d6448), bind = hex(o.binding ?? 0x9d9170);
  return (ctx) => {
    set3(ctx, base);
    const m = fbm(ctx.x * 0.5, ctx.y * 0.5, ctx.z * 0.5, 2);
    const k = 1 + m * 0.1; ctx.r *= k; ctx.g *= k; ctx.b *= k;
    ctx.rough = 0.85;
    const is = ctx.island;
    const edge = Math.min(ctx.v - is.v0, is.v1 - ctx.v);
    const capU = Math.min(Math.abs(ctx.u - is.u0), Math.abs(ctx.u - is.u1));
    if (edge < 0.55 || (o.caps && capU < 0.5)) {
      // binding tape along the edges
      set3(ctx, bind); ctx.h += 0.03; stitch(ctx, Math.abs(edge - 0.5), 0.04, 0.012);
      return;
    }
    // open mesh: square holes
    const cu = frac(ctx.u / 0.5) - 0.5, cv = frac(ctx.v / 0.5) - 0.5;
    const hole = Math.max(Math.abs(cu), Math.abs(cv));
    if (hole < 0.3) {
      mix3(ctx, holeC, 0.75); ctx.h -= 0.05; ctx.occ = 0.7; ctx.rough = 0.95;
    } else ctx.h += 0.01;
    if (o.dust) mix3(ctx, VEST_DUST, clamp01(0.15 + m * 0.3) * 0.3);
  };
}
function tanNylon(color) {
  return nylon({
    color, detail: (ctx) => {
      const b = boxInfo(ctx);
      if (b.face >= 0) {
        if (b.e < 0.5) stitch(ctx, Math.abs(b.e - 0.18), 0.035, 0.015);
        // flap edge on the outward face
        if (b.face === 0 && Math.abs(b.s - 0.68) < 0.03) { ctx.h -= 0.05; ctx.r *= 0.7; ctx.g *= 0.7; ctx.b *= 0.7; }
        if (b.face === 0 && b.s > 0.68) ctx.h += 0.02;
      } else {
        const is = ctx.island;
        const e = Math.min(ctx.v - is.v0, is.v1 - ctx.v);
        if (e < 0.4) stitch(ctx, Math.abs(e - 0.15), 0.03, 0.012);
      }
    },
  });
}

// ---- CT paints ----------------------------------------------------------------------------------
const CT_CAMO = { base: hex(0x5d635a), dark: hex(0x363b35), mid: hex(0x7a7f70), brown: hex(0x4b4538), black: hex(0x232522) };
function ctCamo(ctx) {
  const s = 0.14;
  set3(ctx, CT_CAMO.base);
  const n1 = fbm(ctx.x * s, ctx.y * s * 0.8, ctx.z * s, 3);
  const n2 = fbm(ctx.x * s * 1.3 + 17, ctx.y * s, ctx.z * s * 1.3 + 3, 3);
  const n3 = fbm(ctx.x * s * 2.2 + 41, ctx.y * s * 2.2, ctx.z * s * 2.2, 2);
  const n4 = vnoise(ctx.x * 0.9, ctx.y * 0.9, ctx.z * 0.9);
  if (n2 > 0.18) mix3(ctx, CT_CAMO.mid, sstep(0.18, 0.24, n2) * 0.9);
  if (n1 > 0.12) mix3(ctx, CT_CAMO.dark, sstep(0.12, 0.18, n1) * 0.95);
  if (n3 > 0.3) mix3(ctx, CT_CAMO.brown, sstep(0.3, 0.36, n3) * 0.85);
  // thin dark branches
  const br = Math.abs(fbm(ctx.x * 0.3 + 5, ctx.y * 0.3, ctx.z * 0.3, 2));
  if (br < 0.03 && n4 > 0.05) mix3(ctx, CT_CAMO.black, 0.45 * sstep(0.03, 0.012, br));
}
function ctShirtDetail(ctx) {
  const k = ctx.part.data.kind;
  if (k === 'sleeve') {
    folds(ctx, ctx.v - ctx.island.v0 - 13.5, 2.5, 0.06, 1.2, 1.1);  // elbow
    // shoulder pocket with velcro flag patch on the upper sleeve (outer side)
    const out = Math.abs(ctx.nz);
    const dv = ctx.v - ctx.island.v0;
    if (out > 0.55 && dv > 3.2 && dv < 7.4 && ctx.ny > -0.5) {
      const e = Math.min(dv - 3.2, 7.4 - dv);
      ctx.h += 0.04; if (e < 0.25) stitch(ctx, Math.abs(e - 0.12), 0.03, 0.02);
      if (dv > 4.0 && dv < 6.0 && out > 0.8) { set3(ctx, C9); ctx.h += 0.03; ctx.rough = 0.95; }
    }
    // cuffs
    const de = ctx.island.v1 - ctx.v;
    if (de < 1.3) { ctx.h += 0.02; stitch(ctx, Math.abs(de - 1.1), 0.04, 0.02); }
  } else if (k === 'torso') {
    folds(ctx, ctx.y - 41.5, 2, 0.04, 1.3, 2.1);
    if (ctx.y > 55.5) { // raglan shoulder seams
      stitch(ctx, Math.abs(Math.abs(ctx.z) - 4.2) * 0.8, 0.06, 0.02);
    }
  }
}
function rangerNylon(color, o = {}) {
  const base = nylon({ color });
  return (ctx) => {
    base(ctx);
    const b = boxInfo(ctx);
    const is = ctx.island;
    if (o.molle) {
      // PALS webbing rows: 1" strips every 2", bar-tacks every 1.5"
      const ry = frac((ctx.y - 0.3) / 2.0);
      if (ry < 0.5) {
        ctx.h += 0.035; ctx.r *= 0.9; ctx.g *= 0.9; ctx.b *= 0.9;
        if (Math.abs(ry - 0.02) < 0.03 || Math.abs(ry - 0.48) < 0.03) ctx.h -= 0.02;
        if (frac((ctx.u - is.u0) / 1.5) < 0.05) { ctx.h -= 0.03; ctx.r *= 0.8; ctx.g *= 0.8; ctx.b *= 0.8; }
      }
    }
    const e = b.face >= 0 ? b.e : Math.min(ctx.v - is.v0, is.v1 - ctx.v);
    if (e < 0.45) stitch(ctx, Math.abs(e - 0.16), 0.03, 0.015);
    if (o.flap && b.face === 0) {
      if (Math.abs(b.s - o.flap) < 0.025) { ctx.h -= 0.05; ctx.r *= 0.7; ctx.g *= 0.7; ctx.b *= 0.7; }
      else if (b.s > o.flap) ctx.h += 0.025;
      // velcro/label patch
      if (o.label && b.s > 0.25 && b.s < 0.55 && b.t > 0.25 && b.t < 0.75) { ctx.r *= 0.82; ctx.g *= 0.82; ctx.b *= 0.82; ctx.rough = 0.95; }
    }
  };
}
function helmetPaint(color) {
  const base = polymer({ color, rough: 0.72, mottle: 0.1, grain: 0.012, wear: 0.3, wearColor: 0x8c8e80 });
  return (ctx) => {
    base(ctx);
    // velcro loop fields on the sides/back
    const a = Math.atan2(-ctx.z, ctx.x - 1.05);
    const topBand = ctx.y > 70.2 && Math.abs(a) > 1.9;
    const side = ctx.y > 68.6 && ctx.y < 70.8 && Math.abs(Math.abs(a) - 1.75) < 0.45;
    if (topBand || side) { ctx.r *= 0.86; ctx.g *= 0.86; ctx.b *= 0.86; ctx.rough = 0.97; ctx.h += vnoise(ctx.x * 12, ctx.y * 12, ctx.z * 12) * 0.01; }
    // bolt holes
    if (Math.abs(ctx.y - 68.1) < 0.18 && Math.abs(Math.abs(a) - 1.2) < 0.06) { set3(ctx, C10); ctx.h -= 0.05; }
  };
}
const LENS_FRAME = hex(0x1b1d1e), LENS = hex(0x5a6470);
function lensPaint() {
  return (ctx) => {
    const b = boxInfo(ctx);
    set3(ctx, LENS_FRAME); ctx.rough = 0.55;
    if (b.face === 0) {
      // smoked lens inside a rubber frame
      const inLens = b.s > 0.16 && b.s < 0.84 && b.t > 0.07 && b.t < 0.93 && Math.abs(b.t - 0.5) > 0.035;
      if (inLens) { set3(ctx, LENS); ctx.rough = 0.08; ctx.metal = 0.85; ctx.h += 0.02; }
      else ctx.h -= 0.01;
    }
  };
}

// ---- gear geometry helpers ----------------------------------------------------------------------
/** Closed slab over the torso between angles th0..th1 (0 = front, +left), heights by top/bot. */
function panel(mb, H, o) {
  const { th0, th1, offIn, offOut, nu = 20, nv = 8, skin } = o;
  const top = typeof o.top === 'function' ? o.top : () => o.top;
  const bot = typeof o.bot === 'function' ? o.bot : () => o.bot;
  const nArc = Math.round(nu * 0.42), nCap = Math.max(2, Math.round((nu - 2 * nArc) / 2));
  const total = 2 * nArc + 2 * nCap;
  const mid = (offIn + offOut) / 2, half = (offOut - offIn) / 2;
  const R = 7;
  const fn = (i, j, out) => {
    let th, off;
    if (i <= nArc) { th = th0 + (th1 - th0) * (i / nArc); off = offOut; }
    else if (i <= nArc + nCap) { const f = ((i - nArc) / nCap) * Math.PI; th = th1 + (Math.sin(f) * half) / R; off = mid + half * Math.cos(f); }
    else if (i <= 2 * nArc + nCap) { th = th1 - (th1 - th0) * ((i - nArc - nCap) / nArc); off = offIn; }
    else { const f = ((i - 2 * nArc - nCap) / nCap) * Math.PI; th = th0 - (Math.sin(f) * half) / R; off = mid - half * Math.cos(f); }
    const yb = bot(th), yt = top(th);
    let y, k = 1;
    const e = Math.min(0.3, (yt - yb) * 0.2);
    if (j === 0) { y = yb; k = 0; } else if (j === nv) { y = yt; k = 0; }
    else if (j === 1) { y = yb + e * 0.35; k = 0.8; } else if (j === nv - 1) { y = yt - e * 0.35; k = 0.8; }
    else y = yb + e + (yt - yb - 2 * e) * ((j - 1) / (nv - 2));
    const s = H.torsoSurf(y, th, mid + (off - mid) * k + (o.bulge ? o.bulge(th, y) : 0));
    out.copy(s.p);
  };
  return mb.surface(total, nv, fn, skin, {});
}
/** Pose a box on the torso surface. Returns [centre, quat]. Local +X = outward normal. */
function onTorso(H, y, th, off, hx) {
  const s = H.torsoSurf(y, th, off + hx);
  const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.atan2(-s.n.z, s.n.x));
  return [s.p, q];
}
function ringPts(y, rf, rb, rs, n, off, cnt, th0 = 0, th1 = Math.PI * 2, cx = 0) {
  const out = [];
  for (let k = 0; k < cnt; k++) {
    const th = th0 + ((th1 - th0) * k) / (th1 - th0 >= Math.PI * 2 - 1e-6 ? cnt : cnt - 1);
    const c = Math.cos(th), s = Math.sin(th), ex = 2 / n;
    const rx = c >= 0 ? rf : rb;
    const x = Math.sign(c) * Math.abs(c) ** ex * rx, z = -Math.sign(s) * Math.abs(s) ** ex * rs;
    const nn = V(x / (rx * rx), 0, z / (rs * rs)).normalize();
    out.push(V(x + cx, y, z).addScaledVector(nn, off));
  }
  return out;
}
function limbBox(mb, H, R, side, which, t, ang, off, h, skinFn, o = {}) {
  // box on a leg: which 't' thigh / 'c' calf, at fraction t, angle around (0 front, +90 outer)
  const L = side === 'L' ? H.LEG_L : H.LEG_R;
  const a = which === 't' ? L.hip : L.knee, b = which === 't' ? L.knee : L.ankle;
  const axis = b.clone().sub(a).normalize();
  const c = a.clone().lerp(b, t);
  const s = side === 'L' ? -1 : 1;
  const out = V(Math.cos(ang), 0, Math.sin(ang) * s);
  out.addScaledVector(axis, -out.dot(axis)).normalize();
  const up = axis.clone().negate();
  const zz = new THREE.Vector3().crossVectors(out, up);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(out, up, zz));
  const cen = c.addScaledVector(out, off + h.x);
  mb.rbox(cen, h, o.r ?? 0.35, q, skinFn(cen), { seg: R.boxSeg, bend: o.bend, mid: o.mid });
  return { cen, q, out, up };
}

// ---- T gear -------------------------------------------------------------------------------------
function tGear(mb, R, H) {
  const { BONE, torsoSkin, rigid } = H;
  const S = STYLE.T;
  const chestSkin = (p) => torsoSkin(V(p.x, Math.max(p.y, 49), p.z));
  // mesh vest: front + back panels with a V-neck, side panels below the armpits
  mb.part('vest', S.vest, { group: 'core', data: { kind: 'vest' } });
  const vtop = (th) => 56.6 - 5.0 * Math.max(0, 1 - Math.abs(th) / 0.42);   // V-neck
  panel(mb, H, { th0: -1.25, th1: 1.25, offIn: 0.25, offOut: 0.75, bot: 43.6, top: vtop, nu: R.torsoU, nv: 7, skin: torsoSkin });
  panel(mb, H, { th0: Math.PI - 1.25, th1: Math.PI + 1.25, offIn: 0.25, offOut: 0.75, bot: 43.6, top: 57.4, nu: R.torsoU, nv: 7, skin: torsoSkin });
  panel(mb, H, { th0: 1.1, th1: Math.PI - 1.1, offIn: 0.2, offOut: 0.6, bot: 43.6, top: 51.2, nu: 10, nv: 5, skin: torsoSkin });
  panel(mb, H, { th0: -Math.PI + 1.1, th1: -1.1, offIn: 0.2, offOut: 0.6, bot: 43.6, top: 51.2, nu: 10, nv: 5, skin: torsoSkin });
  // shoulder straps
  mb.part('vest_strap', S.webbing, { group: 'core' });
  for (const s of [-1, 1]) {
    const f = H.torsoSurf(56.0, 0.62 * -s, 0.9).p, b = H.torsoSurf(56.6, Math.PI + 0.55 * s, 0.9).p;
    const pts = [f, V(1.6, 58.6, 4.3 * s), V(0.0, 59.5, 4.6 * s), V(-1.8, 58.9, 4.4 * s), b];
    const sk = (p) => { const w = torsoSkin(V(p.x, 56, p.z)); return w; };
    mb.tube(pts, 0, 6, sk, { rect: [1.15, 0.22], n: 6, smooth: 3, up: V(0, 1, 0) });
  }
  // pouches: two mag pouches each side of the zip, a radio pouch left, admin pouch right
  mb.part('vest_pouch', S.pouch, { group: 'core' });
  for (const [th, y] of [[0.36, 48.8], [0.72, 48.9], [-0.36, 48.8], [-0.72, 48.9]]) {
    const h = V(0.7, 2.0, 1.2);
    const [c, q] = onTorso(H, y, th, 0.6, h.x);
    mb.rbox(c, h, 0.3, q, chestSkin(c), { seg: R.boxSeg, mid: 2 });
  }
  {
    const h = V(0.75, 1.5, 1.05);
    const [c, q] = onTorso(H, 53.6, 0.6, 0.65, h.x);
    mb.rbox(c, h, 0.3, q, chestSkin(c), { seg: R.boxSeg });
    // radio antenna stub
    mb.part('radio', S.polymerDark, { group: 'core' });
    const tip = c.clone().add(V(-0.2, 1.4, -0.3));
    mb.tube([tip, tip.clone().add(V(-0.1, 2.2, -0.1))], 0.16, 6, chestSkin(c), {});
  }
  mb.part('vest_pouch2', S.pouch, { group: 'core' });
  {
    const h = V(0.8, 1.3, 1.4);
    const [c, q] = onTorso(H, 45.8, -0.3, 0.65, h.x);
    mb.rbox(c, h, 0.32, q, torsoSkin(c), { seg: R.boxSeg });
  }
  // shirt collar (pointed, open at the throat)
  mb.part('collar', S.shirt, { group: 'core', data: { kind: 'collar' } });
  {
    const pts = ringPts(59.3, 3.2, 3.1, 3.2, 2, 0, 12, 0.5, Math.PI * 2 - 0.5, 0.3);
    const sk = (p) => [[BONE.chest, 0.6], [BONE.neck, 0.4]];
    mb.tube(pts, 0, 5, sk, { rect: [0.12, 0.75], n: 6, smooth: 2 });
    for (const s of [-1, 1]) {
      const c = V(2.75, 58.75, 1.2 * s);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35 * s, 0.35 * -s, -0.5, 'YXZ'));
      mb.rbox(c, V(0.1, 0.75, 0.55), 0.08, q, sk, { seg: 1 });
    }
  }
  // belt + buckle + hip pouch
  mb.part('belt', S.belt, { group: 'core' });
  const beltPts = ringPts(40.7, 4.62, 4.95, 7.15, 2.4, 0.06, 28);
  mb.tube(beltPts, 0, 4, (p) => [[BONE.pelvis, 1]], { rect: [0.1, 0.62], n: 10, closed: true });
  mb.part('buckle', S.metal, { group: 'core' });
  mb.rbox(V(4.95, 40.7, 0), V(0.18, 0.72, 1.0), 0.12, null, rigid('pelvis'), { seg: 1 });
  mb.part('hip_pouch', S.pouch, { group: 'core' });
  mb.rbox(V(-1.2, 38.4, 7.9), V(1.15, 2.1, 1.55), 0.4, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.35, 0.05)), rigid('pelvis'), { seg: R.boxSeg });
  // cargo pockets
  for (const side of ['L', 'R']) {
    mb.part('cargo_' + side, S.pants, { group: 'leg' + side, data: { kind: 'pocket' } });
    limbBox(mb, H, R, side, 't', 0.48, 1.35, 3.55, V(0.45, 2.6, 1.95), (c) => [[BONE['thigh_' + side], 1]], { r: 0.4, bend: 0.12 });
  }
  // drop-leg pouch on the right thigh (as in the CS2 reference)
  mb.part('thigh_pouch', S.pouch, { group: 'legR' });
  limbBox(mb, H, R, 'R', 't', 0.3, 1.2, 4.3, V(0.9, 2.2, 1.6), (c) => [[BONE.thigh_R, 1]], { r: 0.4 });
  // hanger strap from the belt to the drop-leg pouch
  mb.part('thigh_strap', S.belt, { group: 'legR' });
  mb.tube([V(-0.3, 40.2, 7.35), V(-0.25, 37.2, 7.75), V(-0.2, 34.2, 7.9)], 0, 4, [[BONE.thigh_R, 0.6], [BONE.pelvis, 0.4]], { rect: [0.08, 0.5], n: 8, up: V(1, 0, 0) });
}

// ---- CT gear ------------------------------------------------------------------------------------
function ctGear(mb, R, H) {
  const { BONE, torsoSkin, rigid } = H;
  const S = STYLE.CT;
  const chestSkin = (p) => torsoSkin(V(p.x, Math.max(p.y, 49.5), p.z));
  // plate carrier
  mb.part('plates', S.carrier, { group: 'core', data: { kind: 'plate' } });
  const ftop = (th) => 56.4 - 1.6 * Math.max(0, (Math.abs(th) - 0.35) / 0.55) ** 2;
  panel(mb, H, { th0: -0.92, th1: 0.92, offIn: 0.3, offOut: 1.75, bot: 45.3, top: ftop, nu: R.torsoU, nv: 8, skin: chestSkin });
  panel(mb, H, { th0: Math.PI - 0.95, th1: Math.PI + 0.95, offIn: 0.3, offOut: 1.6, bot: 45.6, top: (th) => 57.2 - 1.2 * Math.max(0, (Math.abs(Math.PI - Math.abs(th)) - 0.4) / 0.55) ** 2, nu: R.torsoU, nv: 8, skin: chestSkin });
  mb.part('cummerbund', S.carrierMolle, { group: 'core', data: { kind: 'cummer' } });
  panel(mb, H, { th0: 0.75, th1: Math.PI - 0.75, offIn: 0.2, offOut: 1.0, bot: 44.6, top: 50.4, nu: 12, nv: 6, skin: torsoSkin });
  panel(mb, H, { th0: -Math.PI + 0.75, th1: -0.75, offIn: 0.2, offOut: 1.0, bot: 44.6, top: 50.4, nu: 12, nv: 6, skin: torsoSkin });
  // shoulder straps (padded)
  mb.part('pc_strap', S.carrierStrap, { group: 'core' });
  for (const s of [-1, 1]) {
    const f = H.torsoSurf(55.4, 0.55 * -s, 1.5).p, b = H.torsoSurf(56.0, Math.PI + 0.55 * s, 1.4).p;
    const pts = [f, V(2.0, 58.6, 4.4 * s), V(0.1, 59.8, 4.8 * s), V(-2.0, 59.1, 4.5 * s), b];
    mb.tube(pts, 0, 6, (p) => torsoSkin(V(p.x, 56, p.z)), { rect: [1.25, 0.42], n: 5, smooth: 3, up: V(0, 1, 0) });
  }
  // front: 3 rifle mag pouches + mags, admin pouch
  mb.part('mag_pouch', S.pouch, { group: 'core' });
  const magTops = [];
  for (const th of [-0.38, 0, 0.38]) {
    const h = V(0.8, 2.0, 1.25);
    const [c, q] = onTorso(H, 47.9, th, 1.75, h.x);
    mb.rbox(c, h, 0.3, q, chestSkin(c), { seg: R.boxSeg, mid: 2 });
    magTops.push([c.clone().add(V(0, 2.1, 0)), q]);
  }
  mb.part('admin', S.pouchLabel, { group: 'core' });
  {
    const h = V(0.5, 1.45, 2.6);
    const [c, q] = onTorso(H, 53.4, 0, 1.75, h.x);
    mb.rbox(c, h, 0.3, q, chestSkin(c), { seg: R.boxSeg, bend: 0.03 });
  }
  mb.part('mags', S.polymerDark, { group: 'core' });
  for (const [c, q] of magTops) mb.rbox(c, V(0.55, 0.45, 0.95), 0.18, q, chestSkin(c), { seg: 1 });
  // radio on the left side + antenna, utility pouch on the right
  mb.part('radio_pouch', S.pouch, { group: 'core' });
  let radioTop;
  {
    const h = V(1.05, 2.3, 1.35);
    const [c, q] = onTorso(H, 48.4, 1.52, 1.0, h.x);
    mb.rbox(c, h, 0.35, q, chestSkin(c), { seg: R.boxSeg });
    radioTop = c.clone().add(V(0, h.y, 0));
    const [c2, q2] = onTorso(H, 48.0, -1.5, 1.0, 1.0);
    mb.rbox(c2, V(1.0, 1.7, 1.4), 0.35, q2, chestSkin(c2), { seg: R.boxSeg });
    const [c3, q3] = onTorso(H, 51.3, Math.PI, 1.6, 1.2);
    mb.rbox(c3, V(1.2, 4.0, 2.9), 0.55, q3, chestSkin(c3), { seg: R.boxSeg, bend: 0.02 });
  }
  mb.part('radio', S.polymerDark, { group: 'core' });
  {
    const c = radioTop.clone().add(V(0, 0.7, 0));
    mb.rbox(c, V(0.75, 0.9, 1.0), 0.25, null, chestSkin(c), { seg: 1 });
    const a0 = c.clone().add(V(-0.3, 0.8, 0.2));
    mb.tube([a0, a0.clone().add(V(-0.6, 4.0, -0.2)), a0.clone().add(V(-1.4, 9.5, -0.6))], (t) => 0.2 - 0.08 * t, 5, chestSkin(c), { smooth: 3 });
    // PTT cable to the chest
    const p1 = c.clone().add(V(0.6, 0.6, 0.6)), p2 = H.torsoSurf(55.5, 0.6, 1.9).p;
    mb.tube([p1, p1.clone().lerp(p2, 0.5).add(V(0.8, 1.5, 0)), p2], 0.12, 4, chestSkin(p2), { smooth: 3 });
  }
  // helmet
  mb.part('helmet', S.helmet, { group: 'head', data: { kind: 'helmet' } });
  const hc = V(1.05, 67.25, 0), rx = 4.95, ry = 5.25, rz = 4.65;
  const lat0 = (th) => 0.03 + 0.26 * Math.cos(th) + 0.24 * Math.sin(th) ** 2;
  const hpt = (th, la, out = V(0, 0, 0)) => out.set(hc.x + Math.cos(la) * Math.cos(th) * rx, hc.y + Math.sin(la) * ry, hc.z - Math.cos(la) * Math.sin(th) * rz);
  const hs = rigid('head');
  mb.surface(R.headU, 7, (i, j, out) => {
    const th = Math.PI + (i / R.headU) * Math.PI * 2;
    const l0 = lat0(th);
    const t = j / 7;
    hpt(th, l0 + (Math.PI / 2 - l0) * (1 - (1 - t) ** 1.3), out);
  }, hs, { wrap: true });
  // rim trim
  mb.part('helmet_rim', S.rubber, { group: 'head' });
  const rim = [];
  for (let k = 0; k < 32; k++) { const th = (k / 32) * Math.PI * 2; rim.push(hpt(th, lat0(th) + 0.01)); }
  mb.tube(rim, 0.32, 5, hs, { closed: true });
  // NVG shroud, mount and folded-up NVG; side rails
  mb.part('helmet_hw', S.polymerDark, { group: 'head' });
  {
    const la = 0.62, p = hpt(0, la);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, la, 'YXZ'));
    mb.rbox(p.clone().add(V(0.2, 0, 0)), V(0.3, 0.85, 1.1), 0.18, q, hs, { seg: 1 });
    const nv = p.clone().add(V(0.9, 1.25, 0));
    const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.95, 'YXZ'));
    mb.rbox(nv, V(0.75, 0.6, 1.35), 0.3, q2, hs, { seg: 1 });
    for (const s of [-1, 1]) {
      const e0 = nv.clone().add(V(0.35, 0.2, 0.72 * s));
      mb.tube([e0, e0.clone().add(V(0.75, 0.75, 0))], 0.4, 8, hs, {});
    }
    for (const s of [-1, 1]) {
      const pr = hpt(Math.PI / 2 * s * -1, 0.3);
      const q3 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.05, 'YXZ'));
      mb.rbox(pr.add(V(0.2, 0, 0.12 * s)), V(2.2, 0.32, 0.22), 0.1, q3, hs, { seg: 1, bend: 0.0 });
    }
  }
  // ear-pro cups
  mb.part('earpro', S.earpro, { group: 'head' });
  for (const s of [-1, 1]) {
    const c = V(0.95, 65.9, 3.95 * s);
    mb.ellipsoid(c, V(1.7, 2.05, 1.05), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.1)), R.limbU, 6, hs, {});
    mb.tube([c.clone().add(V(0.2, 1.7, 0.3 * s)), c.clone().add(V(0.2, 3.3, -0.2 * s))], 0.28, 5, hs, {});
  }
  // goggles over the eyes + strap around the helmet
  mb.part('goggles', S.goggles, { group: 'head', data: { kind: 'goggles' } });
  mb.rbox(V(5.3, 66.75, 0), V(0.42, 0.92, 3.2), 0.36, null, hs, { seg: R.boxSeg2, bend: 0.24, mid: 3 });
  mb.part('goggle_strap', S.strap, { group: 'head' });
  {
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const th = 1.25 + (k / 12) * (Math.PI * 2 - 2.5);
      const la = 0.02;
      pts.push(hpt(th, la).add(V(0, -0.3 - 0.4 * Math.cos(th), 0)).multiplyScalar(1).addScaledVector(V(Math.cos(th), 0, -Math.sin(th)), 0.12));
    }
    mb.tube(pts, 0, 4, hs, { rect: [0.08, 0.5], n: 8, smooth: 2 });
  }
  // belt, holster on right thigh, knee pads
  mb.part('belt', S.belt, { group: 'core' });
  mb.tube(ringPts(40.8, 4.7, 5.0, 7.25, 2.4, 0.3, 28), 0, 4, [[BONE.pelvis, 1]], { rect: [0.3, 0.9], n: 8, closed: true });
  mb.part('belt_pouch', S.pouch, { group: 'core' });
  mb.rbox(V(-2.8, 40.3, -7.3), V(1.0, 1.6, 1.4), 0.35, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -1.9, 0)), rigid('pelvis'), { seg: R.boxSeg });
  mb.part('holster', S.polymerDark, { group: 'legR' });
  limbBox(mb, H, R, 'R', 't', 0.28, 1.45, 4.25, V(0.85, 3.2, 1.6), () => [[BONE.thigh_R, 1]], { r: 0.45 });
  mb.part('cargo', S.pants, { group: 'legL', data: { kind: 'pocket' } });
  limbBox(mb, H, R, 'L', 't', 0.48, 1.35, 3.55, V(0.45, 2.6, 1.95), () => [[BONE.thigh_L, 1]], { r: 0.4, bend: 0.12 });
  mb.part('kneepad', S.kneepad, { group: 'legL', data: { kind: 'kneepad' } });
  for (const side of ['L', 'R']) {
    const L = side === 'L' ? H.LEG_L : H.LEG_R;
    const s = side === 'L' ? -1 : 1;
    const c = L.knee.clone().add(V(3.25, -0.9, 0.15 * s));
    mb.ellipsoid(c, V(0.95, 2.35, 2.05), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.06)), R.limbU, 6, [[BONE['calf_' + side], 1]], { lat0: -Math.PI / 2, lat1: Math.PI / 2 });
    const st = L.knee.clone().lerp(L.ankle, 0.17);
    const pts = ringPts(st.y, 3.35, 3.35, 3.05, 2, 0, 14, 0, Math.PI * 2);
    for (const p of pts) { p.x += st.x; p.z += st.z; }
    mb.tube(pts, 0, 4, [[BONE['calf_' + side], 1]], { rect: [0.1, 0.4], n: 8, closed: true });
  }
}

// ---- styles -------------------------------------------------------------------------------------
export const STYLE = {
  T: {
    sleeve: 'rolled',
    pantsBag: 0.55,
    pants: cloth({ color: 0x5e5f3f, pattern: tPantsPattern, wrinkle: legWrinkles, dust: 1.0, dustTop: 20 }),
    shirt: cloth({ color: 0xbdb8ae, pattern: plaid, wrinkle: shirtWrinkles, mottle: 0.08 }),
    neck: knitPaint(0x5a5b3c),
    head: knitPaint(0x5a5b3c, { holes: true, mouth: true, skin: 0xa77a5c }),
    skin: forearmPaint(),
    glove: glovePaint(0x1f1f1f),
    boot: bootPaint(0x3d3128, { dust: 0.45 }),
    sole: rubberSole(),
    vest: meshVest(0xc3b896, { hole: 0x7a7055, binding: 0xa49675, dust: true }),
    webbing: tanNylon(0xb0a37f),
    pouch: tanNylon(0xb8ab88),
    belt: nylon({ color: 0x3a3c3f }),
    metal: metal({ color: 0x5a5a58, rough: 0.35, metal: 0.9 }),
    polymerDark: polymer({ color: 0x252525, rough: 0.55 }),
    gear: tGear,
  },
  CT: {
    sleeve: 'full',
    pantsBag: 0.45,
    pants: cloth({ color: 0x5d635a, pattern: ctCamo, wrinkle: legWrinkles, dust: 0.7, dustTop: 14 }),
    shirt: cloth({ color: 0x5d635a, pattern: ctCamo, detail: ctShirtDetail }),
    neck: knitPaint(0x1f2022),
    head: knitPaint(0x1f2022, { holes: true, mouth: false, skin: 0x9a7058 }),
    skin: skin({ color: 0x9a7058 }),
    glove: glovePaint(0x2a2a2c, { pad: 0x3a3b36 }),
    boot: bootPaint(0x2a2826, { dust: 0.4, lace: 0x1a1a1a, rough: 0.55 }),
    sole: rubberSole(),
    carrier: rangerNylon(0x454b3c, { molle: true }),
    carrierMolle: rangerNylon(0x454b3c, { molle: true }),
    carrierStrap: rangerNylon(0x41473a),
    pouch: rangerNylon(0x4a503f, { flap: 0.7 }),
    pouchLabel: rangerNylon(0x4a503f, { flap: 0.8, label: true }),
    belt: rangerNylon(0x3c4135),
    helmet: helmetPaint(0x4a5045),
    rubber: flat(0x1c1c1c, 0.85),
    polymerDark: polymer({ color: 0x232426, rough: 0.5, wear: 0.2 }),
    earpro: polymer({ color: 0x3b4036, rough: 0.6, wear: 0.15 }),
    goggles: lensPaint(),
    strap: nylon({ color: 0x1e1f1d }),
    kneepad: polymer({ color: 0x222325, rough: 0.5, wear: 0.35, wearColor: 0x6e6a60 }),
    gear: ctGear,
  },
};
