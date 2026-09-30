// Renders every HUD/weapon icon to a PNG sheet for review:  node tools/game_iconsheet.mjs /tmp/hud/icons.png
import { createRequire } from 'node:module';
import { icon, WEAPON_ICON_KEYS, GLYPH_KEYS } from '../src/game/icons.js';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const out = process.argv[2] || '/tmp/hud/icons.png';
const cell = (k) => `<div class="c"><div class="i big">${icon(k)}</div><div class="i sm">${icon(k)}</div><div class="n">${k}</div></div>`;
const html = `<!doctype html><html><body style="margin:0;background:#20242a;color:#fff;font:12px Arial">
<style>.g{display:flex;flex-wrap:wrap;gap:10px;padding:12px}.c{background:#0008;padding:8px;border-radius:4px;min-width:120px}
.big{font-size:56px;line-height:1}.sm{font-size:20px;line-height:1;margin-top:6px}.n{opacity:.6;margin-top:4px}</style>
<div class="g">${WEAPON_ICON_KEYS.map(cell).join('')}</div><div class="g">${GLYPH_KEYS.map(cell).join('')}</div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.setContent(html);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('wrote', out);
