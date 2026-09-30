// Top-down SVG of a collision world + nav graph + overlays (debug aid for AI work).
// Brushes are drawn as their XZ AABBs shaded by top height; nav nodes coloured by clearance.
export function mapSvg(cw, nav, o = {}) {
  const b = o.bounds || (() => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < nav.count; i++) { x0 = Math.min(x0, nav.px[i]); x1 = Math.max(x1, nav.px[i]); z0 = Math.min(z0, nav.pz[i]); z1 = Math.max(z1, nav.pz[i]); }
    return { x0: x0 - 150, x1: x1 + 150, z0: z0 - 150, z1: z1 + 150 };
  })();
  const W = o.width || 1400, S = W / (b.x1 - b.x0), H = Math.round((b.z1 - b.z0) * S);
  const X = (x) => ((x - b.x0) * S).toFixed(1), Z = (z) => ((z - b.z0) * S).toFixed(1);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#1b1b1f"/>`];
  const floorY = o.floorY ?? 0;
  const brushes = cw.brushes.filter((br) => br.max.x - br.min.x < 3000 || br.max.z - br.min.z < 3000);
  brushes.sort((a, c) => a.max.y - c.max.y);
  for (const br of brushes) {
    if (br.max.y < floorY + 4 && br.max.x - br.min.x > 2000) continue;
    const h = Math.max(0, Math.min(1, (br.max.y - floorY) / 200));
    const c = Math.round(60 + h * 120);
    out.push(`<rect x="${X(br.min.x)}" y="${Z(br.min.z)}" width="${((br.max.x - br.min.x) * S).toFixed(1)}" height="${((br.max.z - br.min.z) * S).toFixed(1)}" fill="rgb(${c},${c - 10},${c - 25})" opacity="0.85"/>`);
  }
  if (nav && o.nodes !== false) {
    const col = ['#e05050', '#e0a040', '#b0d050', '#50c070', '#40a0e0'];
    for (let i = 0; i < nav.count; i++) out.push(`<rect x="${X(nav.px[i] - 4)}" y="${Z(nav.pz[i] - 4)}" width="${(8 * S).toFixed(1)}" height="${(8 * S).toFixed(1)}" fill="${col[nav.clear[i]]}" opacity="0.5"/>`);
  }
  for (const L of o.lines || []) {
    out.push(`<polyline fill="none" stroke="${L.color || '#fff'}" stroke-width="${L.width || 2}" points="${L.pts.map((p) => `${X(p.x)},${Z(p.z)}`).join(' ')}" opacity="${L.opacity ?? 0.9}"/>`);
  }
  for (const P of o.points || []) {
    out.push(`<circle cx="${X(P.x)}" cy="${Z(P.z)}" r="${P.r || 5}" fill="${P.color || '#ff0'}" stroke="#000" stroke-width="1"/>`);
    if (P.label) out.push(`<text x="${+X(P.x) + 7}" y="${+Z(P.z) - 6}" fill="${P.color || '#ff0'}" font-size="12" font-family="monospace">${P.label}</text>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

/** Render an SVG string to PNG with Playwright. */
export async function svgToPng(svg, file) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: +m[1], height: +m[2] } });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: file });
  await browser.close();
}
