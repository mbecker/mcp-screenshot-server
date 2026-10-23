import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSemaphore = { tryAcquire: vi.fn(), release: vi.fn() };

vi.mock('../../src/config/runtime.js', () => ({
  defaultOutDir: '/home/user/Documents/screenshots',
  ensureDefaultDirectory: vi.fn(),
  puppeteerSemaphore: {
    tryAcquire: () => mockSemaphore.tryAcquire(),
    release: () => mockSemaphore.release(),
  },
}));

vi.mock('../../src/config/index.js', () => ({ MAX_CONCURRENT_SCREENSHOTS: 3, ALLOW_LOCAL: false }));
vi.mock('../../src/validators/url.js', () => ({ validateUrl: vi.fn() }));
// Every queued upload, in order, plus what the page had loaded when it was queued
const queued: { file: string; gotoCalls: number }[] = [];
vi.mock('../../src/utils/upload.js', () => ({
  createUploader: () => ({
    add: (dest: string) => { queued.push({ file: dest.split('/').pop()!, gotoCalls: mockPage.goto.mock.calls.length }); },
    finish: async (msg: string) => ({ content: [{ type: 'text', text: msg }] }),
  }),
}));
vi.mock('fs', () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock('../../src/utils/design-md.js', () => ({
  buildDesign: vi.fn((pages: { prefix: string }[]) => ({
    designMd: '# d', themeCss: '', htmlDocs: Object.fromEntries(pages.map(p => [p.prefix, `<img src="https://example.com/logo.png">`])),
  })),
}));
vi.mock('../../src/utils/assets.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/assets.js')>()),
  recordAssets: vi.fn(() => ({
    files: new Map([['https://example.com/logo.png', { path: 'assets/logo-1234abcd.png', data: Buffer.from('png') }]]),
    css: new Map(), settle: async () => {},
  })),
}));

vi.mock('../../src/utils/consent.js', () => ({
  dismissCookieBanner: vi.fn(async () => null),
  removeElements: vi.fn(async () => ({ removed: 0, invalid: [] })),
}));

const mockPage = { emulate: vi.fn(), goto: vi.fn(), $$eval: vi.fn(), screenshot: vi.fn(), evaluate: vi.fn(), on: vi.fn(), waitForNetworkIdle: vi.fn(async () => {}), url: vi.fn(() => 'https://example.com/'), $$: vi.fn(async () => []) };
const mockBrowser = { close: vi.fn() };
vi.mock('../../src/utils/browser.js', () => ({
  launchGuardedPage: vi.fn(async () => ({ browser: mockBrowser, page: mockPage })),
}));

let capturedHandler: Function;
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(_name: string, _schema: unknown, handler: Function) {
      capturedHandler = handler;
    }
  },
}));

import { validateUrl } from '../../src/validators/url.js';
import { dismissCookieBanner, removeElements } from '../../src/utils/consent.js';
import { writeFileSync } from 'fs';
import { buildDesign } from '../../src/utils/design-md.js';
import { DEVICE_PRESETS } from '../../src/config/device-presets.js';
import { registerTakePageScreenshots } from '../../src/tools/take-page-screenshots.js';
import { McpServer } from '@modelcontextprotocol/server';

registerTakePageScreenshots(new McpServer({ name: 'test', version: '1.0.0' } as any));

/** Run fn with fake timers, advancing the clock until it settles (the tool pauses for animations). */
const withFastTimers = async <T,>(fn: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  let done = false;
  const p = fn().finally(() => { done = true; });
  try {
    while (!done) await vi.advanceTimersByTimeAsync(500);
  } finally {
    vi.useRealTimers();
  }
  return p;
};

describe('take-page-screenshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queued.length = 0;
    mockSemaphore.tryAcquire.mockReturnValue(true);
    mockPage.evaluate.mockImplementation(async (fn: { name: string }) => fn.name === 'loadLazyContent' ? undefined : ({
      styles: { fonts: {} }, tree: null, truncated: false,
      content: { url: '', title: 't', lang: 'en', meta: {}, headings: [], text: 'Hello', links: [], forms: [],
        images: [{ src: 'https://example.com/logo.png', alt: 'Logo', width: 10, height: 10 }] },
    }));
    vi.mocked(validateUrl).mockResolvedValue({ valid: true, resolvedIp: '1.2.3.4', hostname: 'example.com' });
  });

  it('rejects invalid URLs without launching', async () => {
    vi.mocked(validateUrl).mockResolvedValueOnce({ valid: false, error: 'blocked' });
    const result = await capturedHandler({ url: 'http://10.0.0.1' });
    expect(result.isError).toBe(true);
    expect(mockSemaphore.tryAcquire).not.toHaveBeenCalled();
  });

  it('follows same-origin links breadth-first up to depth and maxPages', async () => {
    const links: Record<string, string[]> = {
      'https://example.com/': ['https://example.com/a#top', 'https://example.com/b', 'https://other.com/x', 'https://example.com/'],
      'https://example.com/a': ['https://example.com/a/deep', 'https://example.com/b'],
      'https://example.com/b': ['https://example.com/b/deep'],
    };
    let current = '';
    mockPage.goto.mockImplementation(async (href: string) => { current = href; });
    mockPage.url.mockImplementation(() => current);
    mockPage.$$eval.mockImplementation(async () => links[current] ?? []);

    const result = await capturedHandler({ url: 'https://example.com/', presets: ['iphone-17', 'desktop'], depth: 1, maxPages: 10 });

    expect(result.isError).toBeUndefined();
    // depth 1: start page + its two same-origin links, no level-2 pages; other.com skipped
    const shots = mockPage.screenshot.mock.calls.map(c => c[0].path.split('/').pop());
    expect(shots).toEqual([
      '00-home-iphone-17.png', '00-home-desktop.png',
      '01-a-iphone-17.png', '01-a-desktop.png',
      '02-b-iphone-17.png', '02-b-desktop.png',
    ]);
    expect(mockPage.emulate).toHaveBeenCalledWith(DEVICE_PRESETS['iphone-17']);
    // links are collected once per page (first preset only)
    expect(mockPage.$$eval).toHaveBeenCalledTimes(1);
    // DOM collected at every preset (for responsive variants)
    expect(mockPage.evaluate).toHaveBeenCalledTimes(12); // lazy-load pass + collect, per page and preset
    expect(vi.mocked(buildDesign).mock.calls[0][0].map(p => [p.prefix, p.screenshots.length, p.trees.map(t => t.width)]))
      .toEqual([['00-home', 2, [402, 1920]], ['01-a', 2, [402, 1920]], ['02-b', 2, [402, 1920]]]);
    const written = Object.fromEntries(vi.mocked(writeFileSync).mock.calls.map(c => [String(c[0]).split('/').slice(-2).join('/'), String(c[1])]));
    const packageFiles = ['DESIGN.md', 'theme.css', '00-home.html', '00-home.content.json', '01-a.html', '01-a.content.json',
      '02-b.html', '02-b.content.json', 'manifest.json', 'AGENTS.md'];
    expect(Object.keys(written).map(k => k.split('/').pop())).toEqual(['logo-1234abcd.png', ...packageFiles]);
    expect(Object.keys(written)[0]).toBe('assets/logo-1234abcd.png');
    // page HTML and content point at the local asset copy
    expect(written[Object.keys(written).find(k => k.endsWith('00-home.html'))!]).toBe('<img src="assets/logo-1234abcd.png">');
    expect(JSON.parse(written[Object.keys(written).find(k => k.endsWith('00-home.content.json'))!]).images[0].local).toBe('assets/logo-1234abcd.png');
    const manifest = JSON.parse(written[Object.keys(written).find(k => k.endsWith('manifest.json'))!]);
    expect(manifest.pages.map((p: { path: string; screenshots: object }) => [p.path, p.screenshots])).toEqual([
      ['/', { 'iphone-17': '00-home-iphone-17.png', desktop: '00-home-desktop.png' }],
      ['/a', { 'iphone-17': '01-a-iphone-17.png', desktop: '01-a-desktop.png' }],
      ['/b', { 'iphone-17': '02-b-iphone-17.png', desktop: '02-b-desktop.png' }],
    ]);
    expect(manifest.presets.map((p: { name: string; width: number }) => [p.name, p.width])).toEqual([['iphone-17', 402], ['desktop', 1920]]);
    // screenshots are queued for upload as soon as they are taken, the package (not assets/) at the end
    expect(queued.map(q => q.file)).toEqual([
      '00-home-iphone-17.png', '00-home-desktop.png', '01-a-iphone-17.png', '01-a-desktop.png',
      '02-b-iphone-17.png', '02-b-desktop.png', ...packageFiles,
    ]);
    expect(queued[0].gotoCalls).toBe(1); // first screenshot queued before the next page load
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(mockSemaphore.release).toHaveBeenCalled();
  });

  it('follows links on the www. host the start page redirects to, but not other sites', async () => {
    const run = async (landedOn: string) => {
      vi.clearAllMocks();
      mockSemaphore.tryAcquire.mockReturnValue(true);
      mockPage.goto.mockResolvedValue(undefined);
      mockPage.url.mockReturnValue(landedOn);
      mockPage.$$eval.mockResolvedValue([`${new URL(landedOn).origin}/a`, 'https://example.com/b']);
      await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], depth: 1, extractDesign: false });
      return mockPage.goto.mock.calls.map(c => c[0]);
    };
    // aok.de → www.aok.de style redirect: both hosts count as the site; the landing page is not re-visited
    expect(await run('https://www.example.com/')).toEqual(['https://example.com/', 'https://www.example.com/a', 'https://example.com/b']);
    // redirect to an unrelated domain does not widen the crawl
    expect(await run('https://login.other.test/')).toEqual(['https://example.com/', 'https://example.com/b']);
  });

  it('dismisses cookie banners, waiting only on the first load, and reports the click', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue(['https://example.com/a']);
    vi.mocked(dismissCookieBanner).mockResolvedValueOnce('Alle akzeptieren');
    const result = await capturedHandler({ url: 'https://example.com/', presets: ['iphone-17', 'desktop'], depth: 1, extractDesign: false, cookieBanner: 'reject' });
    const calls = vi.mocked(dismissCookieBanner).mock.calls;
    expect(calls).toHaveLength(4); // 2 pages × 2 presets, each before its screenshot
    expect(calls.map(c => [c[1], c[2]])).toEqual([['reject', 4000], ['reject', 0], ['reject', 0], ['reject', 0]]);
    expect(result.content[0].text).toContain('Cookie banner: clicked "Alle akzeptieren"');
  });

  it('removes elements by selector before each screenshot and before extraction, and reports them', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue([]);
    vi.mocked(removeElements).mockResolvedValue({ removed: 1, invalid: ['!!'] });
    const result = await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], removeSelectors: ['[role="alert"]', '!!'] });
    expect(vi.mocked(removeElements).mock.calls).toEqual([
      [mockPage, ['[role="alert"]', '!!']], // before the screenshot
      [mockPage, ['[role="alert"]', '!!']], // after the lazy-load pass, before collecting
    ]);
    expect(result.content[0].text).toContain('Removed 2 element(s) matching [role="alert"], !! (invalid selector: !!)');
  });

  it('loads lazy content before a full-page screenshot, but after a viewport screenshot', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue([]);
    const order: string[] = [];
    mockPage.screenshot.mockImplementation(async () => { order.push('screenshot'); });
    const evalImpl = mockPage.evaluate.getMockImplementation()!;
    mockPage.evaluate.mockImplementation(async (fn: { name: string }, ...a: unknown[]) => { order.push(fn.name); return evalImpl(fn, ...a); });

    await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], fullPage: true });
    expect(order).toEqual(['loadLazyContent', 'screenshot', 'collectPage']);
    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));

    order.length = 0;
    await capturedHandler({ url: 'https://example.com/', presets: ['desktop'] });
    expect(order).toEqual(['screenshot', 'loadLazyContent', 'collectPage']);

    order.length = 0;
    await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], fullPage: true, extractDesign: false });
    expect(order).toEqual(['loadLazyContent', 'screenshot']); // still loads lazy content without extraction
  });

  it('takes extra viewport screenshots at scroll offsets, then returns to the top', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue([]);
    const scrolls: unknown[] = [];
    const evalImpl = mockPage.evaluate.getMockImplementation()!;
    mockPage.evaluate.mockImplementation(async (fn: { name: string }, ...a: unknown[]) => {
      if (fn.name !== 'loadLazyContent' && String(fn).includes('scrollTo')) { scrolls.push(a[0] ?? 0); return undefined; }
      return evalImpl(fn, ...a);
    });
    await withFastTimers(() => capturedHandler({ url: 'https://example.com/', presets: ['desktop'], scrollOffsets: [100, 400], fullPage: true }));

    expect(mockPage.screenshot.mock.calls.map(c => [c[0].path.split('/').pop(), !!c[0].fullPage])).toEqual([
      ['00-home-desktop.png', true],
      ['00-home-desktop-scroll100.png', false], // scrolled shots are always the viewport
      ['00-home-desktop-scroll400.png', false],
    ]);
    expect(scrolls).toEqual([100, 400, 0]); // back to the top before extraction
    expect(queued.slice(0, 3).map(q => q.file)).toEqual(['00-home-desktop.png', '00-home-desktop-scroll100.png', '00-home-desktop-scroll400.png']);
    const manifest = JSON.parse(String(vi.mocked(writeFileSync).mock.calls.find(c => String(c[0]).endsWith('manifest.json'))![1]));
    expect(manifest.pages[0].scrolled).toEqual({ desktop: { 100: '00-home-desktop-scroll100.png', 400: '00-home-desktop-scroll400.png' } });
    expect(manifest.pages[0].screenshots).toEqual({ desktop: '00-home-desktop.png' }); // compare_screenshots input unchanged
  });

  it('captures click states per preset after a reload, skipping presets where the element is hidden', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue([]);
    let preset = '';
    mockPage.emulate.mockImplementation(async (d: { viewport: { width: number } }) => { preset = d.viewport.width < 768 ? 'mobile' : 'desktop'; });
    const click = vi.fn(async () => {});
    // The menu button exists on both, but is only visible on mobile (like "1000:hidden")
    mockPage.$$.mockImplementation(async () => [{ isVisible: async () => preset === 'mobile', click }]);

    const result = await withFastTimers(() => capturedHandler({
      url: 'https://example.com/', presets: ['iphone-17', 'desktop'], scrollOffsets: [100],
      clickStates: [{ name: 'menu', selector: 'button:has([data-icon="menu"])' }],
    }));

    expect(mockPage.$$).toHaveBeenCalledWith('button:has([data-icon="menu"])');
    expect(click).toHaveBeenCalledTimes(1); // mobile only
    expect(mockPage.goto).toHaveBeenCalledTimes(4); // per preset: load + reload for the state
    expect(mockPage.screenshot.mock.calls.map(c => c[0].path.split('/').pop())).toEqual([
      '00-home-iphone-17.png', '00-home-iphone-17-scroll100.png',
      '00-home-iphone-17-menu.png', '00-home-iphone-17-menu-scroll100.png',
      '00-home-desktop.png', '00-home-desktop-scroll100.png',
    ]);
    const manifest = JSON.parse(String(vi.mocked(writeFileSync).mock.calls.find(c => String(c[0]).endsWith('manifest.json'))![1]));
    expect(manifest.pages[0].states).toEqual({
      menu: { screenshots: { 'iphone-17': '00-home-iphone-17-menu.png' }, scrolled: { 'iphone-17': { 100: '00-home-iphone-17-menu-scroll100.png' } } },
    });
    expect(result.content[0].text).toContain('State "menu" (button:has([data-icon="menu"])): not visible on desktop');
  });

  it('reports an invalid click selector instead of failing the page', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue([]);
    mockPage.$$.mockRejectedValue(new Error('is not a valid selector'));
    const result = await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], extractDesign: false, clickStates: [{ name: 'menu', selector: '!!' }] });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Invalid click selector: menu: !!');
    expect(result.content[0].text).toContain('https://example.com/ → 00-home-*.png');
  });

  it('caps at maxPages and reports the rest', async () => {
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.$$eval.mockResolvedValue(['https://example.com/1', 'https://example.com/2', 'https://example.com/3']);
    const result = await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], depth: 2, maxPages: 2 });
    expect(mockPage.screenshot).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain('2 more linked pages not captured');
  });

  it('skips design files when extractDesign is false', async () => {
    mockPage.$$eval.mockResolvedValue([]);
    await capturedHandler({ url: 'https://example.com/', presets: ['desktop'], extractDesign: false });
    expect(mockPage.evaluate).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
