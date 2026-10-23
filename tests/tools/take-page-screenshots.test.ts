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
const uploaded: string[][] = [];
vi.mock('../../src/utils/upload.js', () => ({
  withUpload: async (msg: string, files: string[]) => { uploaded.push(files); return { content: [{ type: 'text', text: msg }] }; },
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

const mockPage = { emulate: vi.fn(), goto: vi.fn(), $$eval: vi.fn(), screenshot: vi.fn(), evaluate: vi.fn(), on: vi.fn(), waitForNetworkIdle: vi.fn(async () => {}) };
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
import { writeFileSync } from 'fs';
import { buildDesign } from '../../src/utils/design-md.js';
import { DEVICE_PRESETS } from '../../src/config/device-presets.js';
import { registerTakePageScreenshots } from '../../src/tools/take-page-screenshots.js';
import { McpServer } from '@modelcontextprotocol/server';

registerTakePageScreenshots(new McpServer({ name: 'test', version: '1.0.0' } as any));

describe('take-page-screenshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // the package (not assets/) is uploaded together with the screenshots
    expect(uploaded.at(-1)!.map(f => f.split('/').pop())).toEqual([
      '00-home-iphone-17.png', '00-home-desktop.png', '01-a-iphone-17.png', '01-a-desktop.png',
      '02-b-iphone-17.png', '02-b-desktop.png', ...packageFiles,
    ]);
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(mockSemaphore.release).toHaveBeenCalled();
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
