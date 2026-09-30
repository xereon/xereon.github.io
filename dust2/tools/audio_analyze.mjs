// Offline audio analysis helpers for tools/audiotest.mjs: stats, spectrogram PNG, WAV export.
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---- FFT (radix-2, in place) ----------------------------------------------------------------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const db = (v) => 20 * Math.log10(Math.max(1e-12, v));

export function mono(chs) {
  if (chs.length === 1) return chs[0];
  const o = new Float32Array(chs[0].length);
  for (const c of chs) for (let i = 0; i < o.length; i++) o[i] += c[i] / chs.length;
  return o;
}

/** 4x windowed-sinc upsampled peak (approximate ITU true peak). */
export function truePeak(chs) {
  const taps = 16, os = 4;
  const kern = [];
  for (let p = 0; p < os; p++) {
    const k = [];
    for (let t = -taps; t <= taps; t++) {
      const x = t - p / os;
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * x / (taps + 1));
      k.push(s * w);
    }
    kern.push(k);
  }
  let pk = 0;
  for (const c of chs) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > pk) pk = a;
      if (a < pk * 0.5) continue; // inter-sample overs only matter near peaks
      for (let p = 1; p < os; p++) {
        let v = 0;
        const k = kern[p];
        for (let t = -taps; t <= taps; t++) { const j = i + t; if (j >= 0 && j < c.length) v += c[j] * k[t + taps]; }
        if (Math.abs(v) > pk) pk = Math.abs(v);
      }
    }
  }
  return pk;
}

export function stats(chs, sr) {
  const m = mono(chs);
  const n = m.length;
  let pk = 0, sum = 0, pkI = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(m[i]); if (a > pk) { pk = a; pkI = i; } sum += m[i] * m[i]; }
  let chPk = 0; for (const c of chs) for (let i = 0; i < c.length; i++) chPk = Math.max(chPk, Math.abs(c[i]));
  const rmsAll = Math.sqrt(sum / n);
  // loudest 50 ms window RMS
  const W = Math.round(0.05 * sr);
  let acc = 0, best = 0;
  for (let i = 0; i < n; i++) { acc += m[i] * m[i]; if (i >= W) acc -= m[i - W] * m[i - W]; best = Math.max(best, acc); }
  const rms50 = Math.sqrt(best / Math.min(W, n));
  // envelope (5 ms RMS) for attack/decay
  const E = Math.round(0.005 * sr);
  const env = [];
  for (let i = 0; i < n; i += E) { let s = 0; for (let j = i; j < Math.min(n, i + E); j++) s += m[j] * m[j]; env.push(Math.sqrt(s / E)); }
  let ePk = 0, ePkI = 0; env.forEach((v, i) => { if (v > ePk) { ePk = v; ePkI = i; } });
  let d40 = env.length - 1;
  for (let i = ePkI; i < env.length; i++) if (env[i] < ePk * 0.01) { d40 = i; break; }
  // spectrum
  const N = 2048, win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const pow = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let off = 0; off < n; off += N / 2) {
    for (let i = 0; i < N; i++) { re[i] = (m[off + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
  }
  // centroid of the first 150 ms (the part that defines a transient's character)
  let cenA = 0, totA = 0;
  {
    const NA = 8192; const ra = new Float64Array(NA), ia = new Float64Array(NA);
    const L = Math.min(n, Math.round(0.15 * sr));
    for (let i = 0; i < NA; i++) { ra[i] = i < L ? m[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / L)) : 0; ia[i] = 0; }
    fft(ra, ia);
    for (let k = 1; k < NA / 2; k++) { const p = ra[k] * ra[k] + ia[k] * ia[k]; totA += p; cenA += p * k * sr / NA; }
  }
  let tot = 0, cen = 0;
  const bands = { sub: 0, low: 0, mid: 0, himid: 0, high: 0 };
  for (let k = 1; k < N / 2; k++) {
    const f = k * sr / N, p = pow[k];
    tot += p; cen += p * f;
    if (f < 100) bands.sub += p; else if (f < 500) bands.low += p; else if (f < 2000) bands.mid += p; else if (f < 6000) bands.himid += p; else bands.high += p;
  }
  for (const k in bands) bands[k] = Math.round(100 * bands[k] / Math.max(1e-20, tot));
  return {
    dur: +(n / sr).toFixed(3),
    peakDb: +db(chPk).toFixed(1),
    rmsDb: +db(rmsAll).toFixed(1),
    rms50Db: +db(rms50).toFixed(1),
    crestDb: +(db(pk) - db(rms50)).toFixed(1),
    centroidHz: Math.round(cen / Math.max(1e-20, tot)),
    centroid150Hz: Math.round(cenA / Math.max(1e-20, totA)),
    attackMs: +((pkI / sr) * 1000).toFixed(1),
    decay40Ms: Math.round((d40 - ePkI) * 5),
    bands,
  };
}

// ---- PNG ------------------------------------------------------------------------------------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 5x7 bitmap font (subset)
const FONT = {
  'A': '0111010001100011111110001100011000110001', 'B': '1111010001100011111010001100011000111110', 'C': '0111010001100001000010000100001000101110',
  'D': '1111010001100011000110001100011000111110', 'E': '1111110000100001111010000100001000011111', 'F': '1111110000100001111010000100001000010000',
  'G': '0111010001100001011110001100011000101111', 'H': '1000110001100011111110001100011000110001', 'I': '0111000100001000010000100001000010001110',
  'J': '0011100010000100001000010100101001001100', 'K': '1000110010101001100010100100101000110001', 'L': '1000010000100001000010000100001000011111',
  'M': '1000111011101011000110001100011000110001', 'N': '1000110001110011010110011100011000110001', 'O': '0111010001100011000110001100011000101110',
  'P': '1111010001100011111010000100001000010000', 'Q': '0111010001100011000110101100100110101101', 'R': '1111010001100011111010100100101000110001',
  'S': '0111110000100000111000001000010000111110', 'T': '1111100100001000010000100001000010000100', 'U': '1000110001100011000110001100011000101110',
  'V': '1000110001100011000110001100010101000100', 'W': '1000110001100011000110101101011010101010', 'X': '1000110001010100010001010100011000110001',
  'Y': '1000110001010100010000100001000010000100', 'Z': '1111100001000100010001000100001000011111',
  '0': '0111010001100111010111001100011000101110', '1': '0010001100001000010000100001000010001110', '2': '0111010001000010001000100010001000011111',
  '3': '1111000001000010111000001000010000111110', '4': '0001000110010101001011111000100001000010', '5': '1111110000111100000100001000011000101110',
  '6': '0011001000100001111010001100011000101110', '7': '1111100001000100010001000010000100001000', '8': '0111010001100010111010001100011000101110',
  '9': '0111010001100010111100001000010001001100', ' ': '0000000000000000000000000000000000000000', '.': '0000000000000000000000000000000110001100',
  '-': '0000000000000001111100000000000000000000', '_': '0000000000000000000000000000000000011111', ':': '0000001100011000000000000011000110000000',
  '/': '0000100010000100010001000010001000010000', '%': '1100011001000100010001000100010011000110', '(': '0001000100010000100001000001000001000010',
  ')': '0100000100000100001000010001000100010000', ',': '0000000000000000000000000001100010001000', '+': '0000000100001001111100100001000000000000',
  '=': '0000000000111110000011111000000000000000',
};
function drawText(img, w, h, x0, y0, str, col = [230, 230, 230], scale = 1) {
  let x = x0;
  for (const ch of String(str).toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 5; c++) {
      if (g[r * 5 + c] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px = x + c * scale + sx, py = y0 + r * scale + sy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2];
      }
    }
    x += 6 * scale;
  }
}
// magma-ish colormap
const CMAP = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
function cmap(u) {
  if (!(u >= 0)) u = 0; u = Math.min(1, u) * (CMAP.length - 1);
  const i = Math.min(CMAP.length - 2, Math.floor(u)), f = u - i;
  return CMAP[i].map((v, k) => Math.round(v + (CMAP[i + 1][k] - v) * f));
}

/** Draw waveform + log-frequency spectrogram into an RGB buffer at (ox, oy) with size (w, h). */
function drawPanel(img, IW, IH, ox, oy, w, h, chs, sr, title, { maxDur = null, dbRange = 90 } = {}) {
  const m = mono(chs);
  const dur = Math.min(maxDur ?? m.length / sr, m.length / sr);
  const PADL = 46, PADT = 18, PADB = 26;
  const WH = Math.round((h - PADT - PADB) * 0.27), SH = h - PADT - PADB - WH - 8;
  const set = (x, y, c) => { x += ox; y += oy; if (x < ox || y < oy || x >= ox + w || y >= oy + h || x >= IW || y >= IH) return; const o = (y * IW + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, [14, 14, 18]);
  const plotW = w - PADL - 8;
  const n = Math.max(1, Math.round(dur * sr));
  const mid = PADT + WH / 2;
  for (let x = 0; x < plotW; x++) set(PADL + x, Math.round(mid), [60, 60, 70]);
  for (let x = 0; x < plotW; x += 3) { set(PADL + x, Math.round(mid - 0.891 * WH / 2), [120, 40, 40]); set(PADL + x, Math.round(mid + 0.891 * WH / 2), [120, 40, 40]); }
  chs.forEach((c, ci) => {
    const col = ci ? [240, 170, 90] : [110, 200, 255];
    for (let x = 0; x < plotW; x++) {
      const a = Math.floor(x * n / plotW), b = Math.max(a + 1, Math.floor((x + 1) * n / plotW));
      let lo = 0, hi = 0;
      for (let i = a; i < b && i < c.length; i++) { if (c[i] < lo) lo = c[i]; if (c[i] > hi) hi = c[i]; }
      const y0 = Math.round(mid - hi * WH / 2), y1 = Math.round(mid - lo * WH / 2);
      for (let y = y0; y <= y1; y++) set(PADL + x, y, col);
    }
  });
  const N = dur < 0.9 ? 512 : dur < 2.5 ? 1024 : 2048;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const top = PADT + WH + 8;
  const fmin = 30, fmax = Math.min(20000, sr / 2);
  const rowF = new Float64Array(SH);
  for (let y = 0; y < SH; y++) rowF[y] = fmin * Math.pow(fmax / fmin, 1 - y / (SH - 1));
  let gmax = -300;
  const cols = [];
  for (let x = 0; x < plotW; x++) {
    const c0 = Math.floor(x * n / plotW) - N / 4;
    for (let i = 0; i < N; i++) { const j = c0 + i; re[i] = (j >= 0 && j < n ? m[j] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    const col = new Float32Array(SH);
    for (let y = 0; y < SH; y++) {
      const fb = rowF[y] * N / sr;
      const k0 = Math.max(1, Math.floor(fb)), k1 = Math.min(N / 2 - 1, k0 + 1), fr = fb - k0;
      const v = 10 * Math.log10((re[k0] * re[k0] + im[k0] * im[k0]) * (1 - fr) + (re[k1] * re[k1] + im[k1] * im[k1]) * fr + 1e-20);
      col[y] = v; if (v > gmax) gmax = v;
    }
    cols.push(col);
  }
  for (let x = 0; x < plotW; x++) for (let y = 0; y < SH; y++) set(PADL + x, top + y, cmap(1 + (cols[x][y] - gmax) / dbRange));
  const text = (x, y, str, col) => drawText(img, IW, IH, ox + x, oy + y, str, col);
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > fmax) continue;
    const y = Math.round((1 - Math.log(f / fmin) / Math.log(fmax / fmin)) * (SH - 1));
    for (let x = 0; x < plotW; x += 4) set(PADL + x, top + y, [90, 90, 100]);
    text(2, top + y - 3, f >= 1000 ? `${f / 1000}K` : `${f}`, [170, 170, 180]);
  }
  const step = dur > 3 ? 0.5 : dur > 1.2 ? 0.25 : dur > 0.4 ? 0.1 : 0.05;
  for (let t = 0; t <= dur + 1e-9; t += step) {
    const x = PADL + Math.round(t / dur * (plotW - 1));
    for (let y = PADT; y < top + SH; y += 3) set(x, y, [70, 70, 80]);
    text(x - 8, top + SH + 6, `${+t.toFixed(2)}`, [170, 170, 180]);
  }
  text(PADL, 4, title, [255, 230, 160]);
  text(w - 60, top + SH + 16, 'SEC', [120, 120, 130]);
}

/** Waveform + log-frequency spectrogram PNG with labels. */
export function spectrogramPNG(chs, sr, path, title = '', { maxDur = null, w = 900, dbRange = 90 } = {}) {
  const H = 542;
  const img = Buffer.alloc(w * H * 3, 0);
  drawPanel(img, w, H, 0, 0, w, H, chs, sr, title, { maxDur, dbRange });
  fs.writeFileSync(path, encodePNG(w, H, img));
}

/** Grid of panels: items = [{ chs, sr, title, maxDur }] */
export function montagePNG(items, path, { cols = 2, pw = 700, ph = 380 } = {}) {
  const rows = Math.ceil(items.length / cols);
  const W = cols * pw, H = rows * ph;
  const img = Buffer.alloc(W * H * 3, 0);
  items.forEach((it, i) => drawPanel(img, W, H, (i % cols) * pw, Math.floor(i / cols) * ph, pw - 4, ph - 4, it.chs, it.sr, it.title, { maxDur: it.maxDur }));
  fs.writeFileSync(path, encodePNG(W, H, img));
}

/** 16-bit PCM WAV */
export function writeWav(path, chs, sr) {
  const n = chs[0].length, C = chs.length;
  const buf = Buffer.alloc(44 + n * C * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * C * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(C, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * C * 2, 28); buf.writeUInt16LE(C * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * C * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) { const v = Math.max(-1, Math.min(1, chs[c][i])); buf.writeInt16LE(Math.round(v * 32767), o); o += 2; }
  fs.writeFileSync(path, buf);
}

// ---- loudness (ITU-R BS.1770-style, simplified) -----------------------------------------------
function biquadRun(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function kWeight(x, sr) {
  // pre-filter (high shelf ~+4 dB above 1.5 kHz) + RLB high-pass, bilinear designs at sr
  const f0 = 1681.97, G = 3.99984, Q = 0.7071752;
  const K = Math.tan(Math.PI * f0 / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  let y = biquadRun(x, (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  const f1 = 38.13547, Q1 = 0.5003270373238773, K1 = Math.tan(Math.PI * f1 / sr);
  const a01 = 1 + K1 / Q1 + K1 * K1;
  y = biquadRun(y, 1, -2, 1, 2 * (K1 * K1 - 1) / a01, (1 - K1 / Q1 + K1 * K1) / a01);
  return y;
}
/** Integrated loudness (LUFS), momentary max, short-term max for mono/stereo channels. */
export function loudness(chs, sr) {
  const kw = chs.map((c) => kWeight(c, sr));
  const n = kw[0].length;
  const blk = (len, hop) => {
    const out = [];
    for (let s = 0; s + len <= n; s += hop) {
      let e = 0;
      for (const c of kw) { let q = 0; for (let i = s; i < s + len; i++) q += c[i] * c[i]; e += q / len; }
      out.push(e);
    }
    return out;
  };
  const L = (e) => -0.691 + 10 * Math.log10(Math.max(1e-12, e));
  const m = blk(Math.round(0.4 * sr), Math.round(0.1 * sr));
  const abs = m.filter((e) => L(e) > -70);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rel = L(mean(abs)) - 10;
  const gated = abs.filter((e) => L(e) > rel);
  const st = blk(Math.round(3 * sr), Math.round(0.5 * sr));
  return {
    integrated: abs.length ? +L(mean(gated)).toFixed(1) : -Infinity,
    momentaryMax: m.length ? +L(Math.max(...m)).toFixed(1) : -Infinity,
    shortTermMax: st.length ? +L(Math.max(...st)).toFixed(1) : -Infinity,
  };
}
