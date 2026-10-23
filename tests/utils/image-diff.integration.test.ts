import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { diffImages } from '../../src/utils/image-diff.js';

let browser: Browser;
let page: Page;

/** Render a 200×100 PNG with an optional black box at the given top offset. */
const png = async (boxTop: number | null, height = 100) => {
  await page.setViewport({ width: 200, height });
  await page.setContent(`<body style="margin:0;background:#fff">${boxTop === null ? '' : `<div style="position:absolute;left:0;top:${boxTop}px;width:200px;height:10px;background:#000"></div>`}</body>`);
  return Buffer.from(await page.screenshot());
};

beforeAll(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => { await browser?.close(); });

describe('diffImages', () => {
  it('reports 0 for identical images', async () => {
    const a = await png(0);
    const d = await diffImages(page, a, a);
    expect(d.mismatch).toBe(0);
    expect(d.bands.every(b => b === 0)).toBe(true);
    expect(d.diffPng.subarray(1, 4).toString()).toBe('PNG');
  });

  it('locates a difference in the right band', async () => {
    // box only in the second image, rows 50–59 → band 5 of 10, fully different
    const d = await diffImages(page, await png(null), await png(50));
    expect(d.mismatch).toBeCloseTo(0.1, 2);
    expect(d.bands[5]).toBeCloseTo(1, 2);
    expect(d.bands.filter((_, i) => i !== 5).every(b => b === 0)).toBe(true);
  });

  it('counts area only one image covers as different', async () => {
    const d = await diffImages(page, await png(null, 100), await png(null, 200));
    expect(d.sizeA).toEqual([200, 100]);
    expect(d.sizeB).toEqual([200, 200]);
    expect(d.mismatch).toBeCloseTo(0.5, 2);
  });
});
