// Debug logging that stays out of hot paths unless enabled with ?debug
const enabled = typeof location !== 'undefined' && /[?&]debug\b/.test(location.search);
export const Dbg = {
  enabled,
  log: (...a) => { if (enabled) console.log('[dbg]', ...a); },
  warn: (...a) => console.warn('[dust2]', ...a),
};
