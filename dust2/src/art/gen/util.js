// Helpers for authoring material GLSL from JS.

// '#rrggbb' (sRGB) -> GLSL linear vec3 literal. Colours are authored as seen, stored linear.
export function C(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const f = (v) => lin(v).toFixed(4);
  return `vec3(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

// Template tag: ${C('#fff')} works inline; plain strings pass through.
export const glsl = (s, ...v) => s.reduce((a, str, i) => a + str + (i < v.length ? v[i] : ''), '');
