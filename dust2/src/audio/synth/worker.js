// Synthesis worker: renders catalog sounds off the main thread, in priority order.
// Protocol: in  {type:'queue', names[]} | {type:'bump', names[]}
//           out {type:'sound', name, sr, loop, vars, ms} (buffers transferred) | {type:'error', name, message}
import { renderSound } from './catalog.js';

const queue = [];
let running = false;

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'queue') { for (const n of m.names) if (!queue.includes(n)) queue.push(n); }
  else if (m.type === 'bump') {
    for (const n of [...m.names].reverse()) { const i = queue.indexOf(n); if (i >= 0) queue.splice(i, 1); queue.unshift(n); }
  }
  if (!running) { running = true; setTimeout(step, 0); }
};

function step() {
  const name = queue.shift();
  if (!name) { running = false; return; }
  try {
    const r = renderSound(name);
    if (r) {
      const transfer = new Set();
      for (const chs of r.vars) for (const c of chs) transfer.add(c.buffer);
      self.postMessage({ type: 'sound', name: r.name, sr: r.sr, loop: r.loop, vars: r.vars, ms: r.ms }, [...transfer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', name, message: String(err && err.stack || err) });
  }
  setTimeout(step, 0); // yield so 'bump' messages are seen between sounds
}
