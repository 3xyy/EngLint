// Renders the EngLint icon sources (design/icon/*.svg) to the PNGs the manifest ships (public/icon/<size>.png).
// The small-size source has chunkier marks so the squiggle and check survive at toolbar size.
// Run: node scripts/render-icons.mjs
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const SOURCES = { 16: 'englint-small.svg', 32: 'englint-small.svg', 48: 'englint.svg', 128: 'englint.svg' };

const browser = await chromium.launch();
for (const [size, file] of Object.entries(SOURCES)) {
  const svg = readFileSync(new URL(`../design/icon/${file}`, import.meta.url), 'utf8')
    .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  const page = await browser.newPage({ viewport: { width: Number(size), height: Number(size) }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${svg}</body>`);
  await page.screenshot({
    path: new URL(`../public/icon/${size}.png`, import.meta.url).pathname,
    omitBackground: true,
    clip: { x: 0, y: 0, width: Number(size), height: Number(size) },
  });
  await page.close();
}
await browser.close();
console.log('rendered', Object.keys(SOURCES).map((s) => `icon/${s}.png`).join(' '));
