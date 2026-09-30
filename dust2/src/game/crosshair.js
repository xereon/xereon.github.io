// CS-style crosshair: classic lines with gap/size/thickness/outline/dot/T-style, drawn to a
// small canvas pixel-snapped so it stays crisp. Sizes follow CS's 480-line virtual scale.

/**
 * Draw a crosshair centred in ctx's canvas.
 * @param ctx      2D context (canvas must be square, even-sized)
 * @param c        crosshair settings (see settings.js)
 * @param screenH  the viewport height the crosshair represents (for YRES scaling)
 * @param spreadPx extra gap from weapon inaccuracy (dynamic styles only)
 */
export function drawCrosshair(ctx, c, screenH, spreadPx = 0) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const yres = screenH / 480;
  const len = Math.max(0, Math.round(c.size * yres));
  const th = Math.max(1, Math.round(c.thickness * yres));
  let gap = Math.round((4 + c.gap) * (screenH / 1080) * 1.2);
  if (c.dynamic && spreadPx > 0) gap += Math.round(spreadPx);
  gap = Math.max(th % 2 === 0 ? 0 : 0, gap);
  const ol = c.outline ? Math.max(1, Math.round(c.outlineThickness * (screenH / 1080))) : 0;
  const cx = W >> 1, cy = H >> 1;
  // Odd thickness centres on a pixel; even thickness straddles the centre line.
  const o = Math.floor(th / 2);
  const rects = [];
  if (len > 0) {
    rects.push([cx + gap, cy - o, len, th]);                 // right
    rects.push([cx - gap - len, cy - o, len, th]);           // left
    rects.push([cx - o, cy + gap, th, len]);                 // bottom
    if (!c.tStyle) rects.push([cx - o, cy - gap - len, th, len]); // top
  }
  if (c.dot) rects.push([cx - o, cy - o, th, th]);
  if (ol) {
    ctx.fillStyle = `rgba(0,0,0,${(c.alpha / 255) * 0.9})`;
    for (const r of rects) ctx.fillRect(r[0] - ol, r[1] - ol, r[2] + ol * 2, r[3] + ol * 2);
  }
  const [R, G, B] = c.color;
  ctx.fillStyle = `rgba(${R},${G},${B},${c.alpha / 255})`;
  for (const r of rects) ctx.fillRect(r[0], r[1], r[2], r[3]);
}

/** Inaccuracy (degrees, cone half-angle) -> pixels at the given vertical FOV. */
export function spreadToPx(inaccDeg, vfovDeg, screenH) {
  if (!(inaccDeg > 0)) return 0;
  const t = Math.tan(Math.min(inaccDeg, 30) * Math.PI / 180);
  return (t / Math.tan(vfovDeg * Math.PI / 360)) * (screenH / 2);
}
