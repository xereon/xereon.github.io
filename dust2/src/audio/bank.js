// Sound bank: schedules synthesis (Worker, or main-thread idle fallback) and stores the
// results as AudioBuffers. Priority order at boot, lazy on-demand for everything else.
import { Dbg } from '../core/debug.js';

export class Bank {
  /** @param {BaseAudioContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.buffers = new Map();   // name -> { vars: AudioBuffer[], loop, sr, next }
    this.pending = new Set();   // queued or rendering
    this.meta = null;           // catalog module (main thread) for names/tiers
    this.worker = null;
    this.fallbackQueue = [];
    this.renderMs = 0;
    this.t0 = performance.now();
    this.firstReady = new Map(); // name -> ms since start (for diagnostics)
    this.listeners = new Set();
    this.failed = false;
  }

  async init() {
    try { this.meta = await import('./synth/catalog.js'); }
    catch (err) { console.error('[audio] catalog failed to load', err); this.failed = true; return; }
    try {
      this.worker = new Worker(new URL('./synth/worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => {
        Dbg.warn('[audio] synth worker failed, falling back to main thread', e?.message);
        e?.preventDefault?.();
        this._toFallback();
      };
    } catch (err) {
      Dbg.warn('[audio] no module worker, main-thread synthesis', err?.message);
      this.worker = null;
    }
  }

  /** Queue names in priority order (duplicates ignored). */
  queue(names) {
    const add = names.filter((n) => !this.buffers.has(n) && !this.pending.has(n) && this.meta?.soundDef(n));
    if (!add.length) return;
    for (const n of add) this.pending.add(n);
    if (this.worker) this.worker.postMessage({ type: 'queue', names: add });
    else { this.fallbackQueue.push(...add); this._pumpFallback(); }
  }

  /** Move names to the front of the queue (queueing them if needed). */
  bump(names) {
    const want = names.filter((n) => !this.buffers.has(n) && this.meta?.soundDef(n));
    if (!want.length) return;
    for (const n of want) this.pending.add(n);
    if (this.worker) this.worker.postMessage({ type: 'bump', names: want });
    else {
      for (const n of [...want].reverse()) { const i = this.fallbackQueue.indexOf(n); if (i >= 0) this.fallbackQueue.splice(i, 1); this.fallbackQueue.unshift(n); }
      this._pumpFallback();
    }
  }

  has(name) { return this.buffers.has(name); }

  /** Pick a variation (round-robin with a random start, never the same twice in a row). */
  pick(name, variant = -1) {
    const e = this.buffers.get(name);
    if (!e) return null;
    const n = e.vars.length;
    if (variant >= 0) return e.vars[variant % n];
    if (n === 1) return e.vars[0];
    let i = Math.floor(Math.random() * n);
    if (i === e.last) i = (i + 1) % n;
    e.last = i;
    return e.vars[i];
  }

  /** Get-or-request: returns null (and bumps the render) when not ready yet. */
  need(name) {
    if (this.buffers.has(name)) return true;
    if (!this.meta?.soundDef(name)) return false;
    this.bump([name]);
    return false;
  }

  onReady(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _store(name, sr, loop, vars) {
    const bufs = [];
    for (const chs of vars) {
      let b;
      try { b = new AudioBuffer({ length: chs[0].length, numberOfChannels: chs.length, sampleRate: sr }); }
      catch { if (!this.ctx) { this.pending.delete(name); return; } b = this.ctx.createBuffer(chs.length, chs[0].length, sr); } // very old browsers need the context
      chs.forEach((c, i) => b.copyToChannel(c, i));
      bufs.push(b);
    }
    this.buffers.set(name, { vars: bufs, loop, sr, last: -1 });
    this.pending.delete(name);
    this.firstReady.set(name, performance.now() - this.t0);
    for (const fn of this.listeners) { try { fn(name); } catch (err) { console.error(err); } }
  }

  _onMessage(m) {
    if (m.type === 'sound') { this.renderMs += m.ms; this._store(m.name, m.sr, m.loop, m.vars); }
    else if (m.type === 'error') { this.pending.delete(m.name); console.error(`[audio] synth "${m.name}" failed: ${m.message}`); }
  }

  _toFallback() {
    if (!this.worker) return;
    try { this.worker.terminate(); } catch {}
    this.worker = null;
    this.fallbackQueue.push(...[...this.pending].filter((n) => !this.fallbackQueue.includes(n)));
    this._pumpFallback();
  }

  _pumpFallback() {
    if (this._fbRunning || !this.meta) return;
    this._fbRunning = true;
    const ric = self.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 16));
    const step = (dl) => {
      // render at least one sound per idle slot; more if there is time left
      do {
        const name = this.fallbackQueue.shift();
        if (!name) { this._fbRunning = false; return; }
        try {
          const r = this.meta.renderSound(name);
          if (r) { this.renderMs += r.ms; this._store(r.name, r.sr, r.loop, r.vars); }
        } catch (err) { this.pending.delete(name); console.error(`[audio] synth "${name}" failed`, err); }
      } while (dl.timeRemaining() > 12);
      ric(step, { timeout: 250 });
    };
    ric(step, { timeout: 250 });
  }

  stats() {
    let bytes = 0, n = 0;
    for (const e of this.buffers.values()) for (const b of e.vars) { bytes += b.length * b.numberOfChannels * 4; n++; }
    return { sounds: this.buffers.size, buffers: n, mb: +(bytes / 1e6).toFixed(1), pending: this.pending.size, renderMs: Math.round(this.renderMs) };
  }
}
