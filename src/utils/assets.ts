// ============================================================================
// Local copies of what the browser loaded (images, fonts) and a fonts.css
// built from the site's @font-face rules.
// ============================================================================

import { createHash } from 'crypto';
import { extname } from 'path';
import type { HTTPResponse, Page } from 'puppeteer';

/** Per-file and total caps so a media-heavy site cannot fill the disk. */
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;

const EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff2': '.woff2', 'application/font-woff': '.woff', 'application/x-font-ttf': '.ttf',
};

/** Stable, filesystem-safe local name: assets/<basename>-<hash>.<ext> */
export function assetPath(url: string, contentType = ''): string {
  const u = new URL(url);
  const urlExt = extname(u.pathname).toLowerCase();
  const ext = EXT[contentType.split(';')[0].trim()] || (/^\.[a-z0-9]{2,5}$/.test(urlExt) ? urlExt : '.bin');
  let file = u.pathname.split('/').pop()!;
  try { file = decodeURIComponent(file); } catch { /* keep encoded */ }
  const base = file.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `assets/${base}-${hash}${ext}`;
}

export interface AssetStore {
  /** original URL → { local path relative to the output dir, bytes } */
  files: Map<string, { path: string; data: Buffer }>;
  /** stylesheet URL → CSS text (kept in memory for @font-face extraction) */
  css: Map<string, string>;
  /** Resolves once every response seen so far has been read. */
  settle(): Promise<void>;
}

/** Record images, fonts and stylesheets as the page loads them. */
export function recordAssets(page: Pick<Page, 'on'>): AssetStore {
  const store: AssetStore = { files: new Map(), css: new Map(), settle: async () => { await Promise.allSettled(pending); } };
  const pending: Promise<unknown>[] = [];
  let total = 0;
  page.on('response', (res: HTTPResponse) => {
    const type = res.request().resourceType();
    const url = res.url();
    if (!['image', 'font', 'stylesheet'].includes(type) || !/^https?:/.test(url) || !res.ok()) return;
    if (type === 'stylesheet' ? store.css.has(url) : store.files.has(url)) return;
    pending.push((async () => {
      if (type === 'stylesheet') { store.css.set(url, await res.text()); return; }
      const data = await res.buffer();
      if (data.length > MAX_ASSET_BYTES || total + data.length > MAX_TOTAL_ASSET_BYTES) return;
      total += data.length;
      store.files.set(url, { path: assetPath(url, res.headers()['content-type']), data });
    })().catch(() => { /* body unavailable (redirect, aborted) */ }));
  });
  return store;
}

/**
 * Collect the @font-face rules for the given families from all stylesheets,
 * pointing url()s at local copies where the font file was captured.
 */
export function buildFontsCss(css: Map<string, string>, families: string[], local: Map<string, string>): string {
  const wanted = new Set(families.map(f => f.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [sheetUrl, text] of css) {
    for (const rule of text.match(/@font-face\s*{[^}]*}/g) || []) {
      const family = rule.match(/font-family\s*:\s*(['"]?)([^;'"]+)\1/)?.[2].trim().toLowerCase();
      if (!family || !wanted.has(family)) continue;
      const fixed = rule.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, _q, ref: string) => {
        if (ref.startsWith('data:')) return m;
        const abs = new URL(ref, sheetUrl).href;
        return `url("${local.get(abs) ?? abs}")`;
      });
      if (!seen.has(fixed)) { seen.add(fixed); out.push(fixed); }
    }
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

/** Replace original asset URLs (plain and HTML-escaped) with local paths. */
export function localizeUrls(text: string, local: Map<string, string>): string {
  // Longest first so a URL that prefixes another is not replaced inside it
  for (const url of [...local.keys()].sort((a, b) => b.length - a.length)) {
    const to = local.get(url)!;
    text = text.split(url).join(to);
    const escaped = url.replace(/&/g, '&amp;');
    if (escaped !== url) text = text.split(escaped).join(to);
    const tw = url.replace(/_/g, '\\_'); // as written inside Tailwind arbitrary values
    if (tw !== url) text = text.split(tw).join(to);
  }
  return text;
}
