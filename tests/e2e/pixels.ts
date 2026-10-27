import { inflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';

/** One screen pixel, from a 1×1 screenshot (PNG: any filter predicts 0 for a lone pixel, so its bytes follow the filter byte). */
export async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1]!, raw[2]!, raw[3]!];
}

/** The pixel at the middle of an underline's bar is its red (#E5483A): it is painted, not covered. */
export async function underlinePainted(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<boolean> {
  const [r, g, b] = await pixelAt(page, Math.round(box.x + box.width / 2), Math.floor(box.y + box.height / 2));
  return r > 180 && g < 120 && b < 120;
}
