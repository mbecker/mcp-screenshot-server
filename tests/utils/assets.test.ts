import { describe, it, expect } from 'vitest';
import { assetPath, buildFontsCss, localizeUrls, recordAssets } from '../../src/utils/assets.js';

describe('assetPath', () => {
  it('is stable, safe and typed by content-type', () => {
    const a = assetPath('https://x.test/img/Hero Image@2x.webp?v=3', 'image/webp');
    expect(a).toMatch(/^assets\/hero-image-2x-[0-9a-f]{8}\.webp$/);
    expect(assetPath('https://x.test/img/Hero Image@2x.webp?v=3', 'image/webp')).toBe(a);
    expect(assetPath('https://x.test/img/Hero Image@2x.webp?v=4', 'image/webp')).not.toBe(a); // different URL, different file
    expect(assetPath('https://x.test/font', 'font/woff2; charset=binary')).toMatch(/^assets\/font-[0-9a-f]{8}\.woff2$/);
    expect(assetPath('https://x.test/../../etc/passwd')).toMatch(/^assets\/passwd-[0-9a-f]{8}\.bin$/);
  });
});

describe('buildFontsCss', () => {
  const css = new Map([
    ['https://x.test/css/site.css', `
      @font-face { font-family: "Inter"; src: url(../fonts/inter.woff2) format("woff2"); font-weight: 100 900; }
      @font-face { font-family: Unused; src: url(/u.woff2); }
      body { color: red }`],
    ['https://fonts.example/css2', `@font-face { font-family: 'Plex Mono'; src: url(https://fonts.example/plex.woff2); }`],
  ]);
  it('keeps used families and points captured files at local copies', () => {
    const out = buildFontsCss(css, ['inter', 'Plex Mono'], new Map([['https://x.test/fonts/inter.woff2', 'assets/inter-1.woff2']]));
    expect(out).toContain('src: url("assets/inter-1.woff2") format("woff2")');
    expect(out).toContain('url("https://fonts.example/plex.woff2")'); // not captured → absolute
    expect(out).not.toContain('Unused');
    expect(out).not.toContain('body');
  });
});

describe('localizeUrls', () => {
  it('replaces plain, HTML-escaped and Tailwind-escaped URLs', () => {
    const local = new Map([
      ['https://x.test/a.png?w=1&h=2', 'assets/a-1.png'],
      ['https://x.test/bg_hero.jpg', 'assets/bg-hero-2.jpg'],
    ]);
    expect(localizeUrls('<img src="https://x.test/a.png?w=1&amp;h=2"> <div class="bg-[url(https://x.test/bg\\_hero.jpg)]">', local))
      .toBe('<img src="assets/a-1.png"> <div class="bg-[url(assets/bg-hero-2.jpg)]">');
  });
});

describe('recordAssets', () => {
  it('gives up on a body read that never resolves', async () => {
    let handler: (r: unknown) => void = () => {};
    const store = recordAssets({ on: ((_e: string, h: typeof handler) => { handler = h; }) as never }, 50);
    handler({
      url: () => 'https://x.test/stuck.png', ok: () => true, request: () => ({ resourceType: () => 'image' }),
      headers: () => ({}), buffer: () => new Promise(() => {}),
    });
    const start = Date.now();
    await store.settle();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(store.files.size).toBe(0);
  });

  it('keeps images, fonts and stylesheet text from successful responses', async () => {
    let handler: (r: unknown) => void = () => {};
    const store = recordAssets({ on: ((_e: string, h: typeof handler) => { handler = h; }) as never });
    const res = (url: string, type: string, ok = true, body = 'data') => ({
      url: () => url, ok: () => ok, request: () => ({ resourceType: () => type }),
      headers: () => ({ 'content-type': type === 'font' ? 'font/woff2' : 'image/png' }),
      buffer: async () => Buffer.from(body), text: async () => body,
    });
    handler(res('https://x.test/a.png', 'image'));
    handler(res('https://x.test/f.woff2', 'font'));
    handler(res('https://x.test/s.css', 'stylesheet', true, '@font-face{}'));
    handler(res('https://x.test/app.js', 'script'));
    handler(res('https://x.test/missing.png', 'image', false));
    handler(res('data:image/png;base64,AA', 'image'));
    await store.settle();
    expect([...store.files.keys()]).toEqual(['https://x.test/a.png', 'https://x.test/f.woff2']);
    expect(store.files.get('https://x.test/f.woff2')!.path).toMatch(/\.woff2$/);
    expect(store.css.get('https://x.test/s.css')).toBe('@font-face{}');
  });
});
