// ============================================================================
// Pixel diff of two PNGs, run inside Chromium (which decodes and encodes the
// images), so no image libraries are needed.
// ============================================================================

import type { Page } from 'puppeteer';

export interface DiffResult {
  width: number;
  height: number;
  /** Share of differing pixels, 0..1 (areas only one image covers count as different) */
  mismatch: number;
  /** Mismatch per horizontal band, top to bottom */
  bands: number[];
  sizeA: [number, number];
  sizeB: [number, number];
  /** Original faded to light gray, differing pixels in red */
  diffPng: Buffer;
}

/** Runs in the page via page.evaluate(), so it must stay self-contained. */
export async function diffInPage(a: string, b: string, tolerance: number, bandCount: number) {
  const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = src;
  });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.naturalWidth, ib.naturalWidth);
  const h = Math.max(ia.naturalHeight, ib.naturalHeight);
  const canvas = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const pixels = (img: HTMLImageElement) => {
    const ctx = canvas().getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const pa = pixels(ia), pb = pixels(ib);
  const out = canvas();
  const octx = out.getContext('2d')!;
  const od = octx.createImageData(w, h);
  const bandH = Math.ceil(h / bandCount);
  const bandDiff = new Array<number>(bandCount).fill(0);
  let diff = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const covered = x < ia.naturalWidth && y < ia.naturalHeight && x < ib.naturalWidth && y < ib.naturalHeight;
      const d = covered ? (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3 : 255;
      if (d > tolerance) {
        diff++;
        bandDiff[Math.floor(y / bandH)]++;
        od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 0;
      } else {
        const gray = 255 - (255 - (pa[i] * 0.3 + pa[i + 1] * 0.59 + pa[i + 2] * 0.11)) * 0.25;
        od.data[i] = od.data[i + 1] = od.data[i + 2] = gray;
      }
      od.data[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return {
    width: w, height: h,
    mismatch: diff / (w * h),
    bands: bandDiff.map((d, k) => d / (w * Math.max(1, Math.min(bandH, h - k * bandH)))),
    sizeA: [ia.naturalWidth, ia.naturalHeight] as [number, number],
    sizeB: [ib.naturalWidth, ib.naturalHeight] as [number, number],
    diffPng: out.toDataURL('image/png').split(',')[1],
  };
}

/**
 * Compare two PNGs. `tolerance` is the mean per-channel difference (0-255)
 * below which pixels count as equal, absorbing anti-aliasing noise.
 */
export async function diffImages(page: Page, a: Buffer, b: Buffer, tolerance = 32, bands = 10): Promise<DiffResult> {
  const url = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;
  const r = await page.evaluate(diffInPage, url(a), url(b), tolerance, bands);
  return { ...r, diffPng: Buffer.from(r.diffPng, 'base64') };
}
