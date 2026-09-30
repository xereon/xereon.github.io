// Layout helpers (Source coordinates). Polygons are [[x, y, z?], ...].
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** Assign z by linear ramp along x between (xa, za) and (xb, zb), clamped. */
export const zx = (pts, xa, za, xb, zb) => pts.map(([x, y]) => [x, y, za + (zb - za) * clamp((x - xa) / (xb - xa), 0, 1)]);
/** Assign z by linear ramp along y between (ya, za) and (yb, zb), clamped. */
export const zy = (pts, ya, za, yb, zb) => pts.map(([x, y]) => [x, y, za + (zb - za) * clamp((y - ya) / (yb - ya), 0, 1)]);
export const zc = (pts, z) => pts.map(([x, y]) => [x, y, z]);
