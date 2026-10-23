import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSemaphore = { tryAcquire: vi.fn(), release: vi.fn() };
vi.mock('../../src/config/runtime.js', () => ({
  defaultOutDir: '/home/user/Documents/screenshots',
  puppeteerSemaphore: { tryAcquire: () => mockSemaphore.tryAcquire(), release: () => mockSemaphore.release() },
}));
vi.mock('../../src/config/index.js', () => ({ ALLOWED_OUTPUT_DIRS: ['/home/user/Documents'], MAX_CONCURRENT_SCREENSHOTS: 3, ALLOW_LOCAL: false }));
vi.mock('../../src/validators/url.js', () => ({ validateUrl: vi.fn() }));
vi.mock('../../src/validators/path.js', () => ({ validateOutputPath: vi.fn() }));

const files: Record<string, string | Buffer> = {};
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }),
  writeFileSync: vi.fn((p: string, d: string | Buffer) => { files[p] = d; }),
}));

const mockPage = { emulate: vi.fn(), goto: vi.fn(), bringToFront: vi.fn(), screenshot: vi.fn(async () => new Uint8Array([1])) };
const mockBrowser = { newPage: vi.fn(async () => ({})), close: vi.fn() };
vi.mock('../../src/utils/browser.js', () => ({ launchGuardedPage: vi.fn(async () => ({ browser: mockBrowser, page: mockPage })) }));
vi.mock('../../src/utils/image-diff.js', () => ({ diffImages: vi.fn() }));

let handler: Function;
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class { registerTool(_n: string, _s: unknown, h: Function) { handler = h; } },
}));

import { validateUrl } from '../../src/validators/url.js';
import { validateOutputPath } from '../../src/validators/path.js';
import { diffImages } from '../../src/utils/image-diff.js';
import { registerCompareScreenshots } from '../../src/tools/compare-screenshots.js';
import { McpServer } from '@modelcontextprotocol/server';

registerCompareScreenshots(new McpServer({ name: 't', version: '1' } as any));

const DIR = '/home/user/Documents/screenshots/page-x';
const manifest = {
  version: 1, source: 'https://x.test/', capturedAt: '', fullPage: false, files: { agents: 'AGENTS.md' }, assets: {},
  presets: [{ name: 'iphone-17', width: 402, height: 874, deviceScaleFactor: 3, isMobile: true }, { name: 'desktop', width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false }],
  pages: [
    { url: 'https://x.test/', path: '/', prefix: '00-home', screenshots: { 'iphone-17': '00-home-iphone-17.png', desktop: '00-home-desktop.png' } },
    { url: 'https://x.test/docs?a=1', path: '/docs?a=1', prefix: '01-docs', screenshots: { 'iphone-17': '../../etc/passwd', desktop: '01-docs-desktop.png' } },
  ],
};
const diff = (mismatch: number, bands = new Array(10).fill(0)) => ({ mismatch, bands, width: 1, height: 1, sizeA: [1, 1], sizeB: [1, 1], diffPng: Buffer.from('d') });

describe('compare_screenshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(files)) delete files[k];
    files[`${DIR}/manifest.json`] = JSON.stringify(manifest);
    for (const f of ['00-home-iphone-17.png', '00-home-desktop.png', '01-docs-desktop.png']) files[`${DIR}/${f}`] = Buffer.from('png');
    mockSemaphore.tryAcquire.mockReturnValue(true);
    vi.mocked(validateOutputPath).mockResolvedValue({ valid: true, path: `${DIR}/manifest.json` });
    vi.mocked(validateUrl).mockResolvedValue({ valid: true, resolvedIp: '127.0.0.1', hostname: 'localhost' });
  });

  it('hints at ALLOW_LOCAL when localhost is blocked', async () => {
    vi.mocked(validateUrl).mockResolvedValueOnce({ valid: false, error: 'Loopback addresses are not allowed' });
    const r = await handler({ captureDir: 'page-x', baseUrl: 'http://localhost:3000' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ALLOW_LOCAL=true');
    expect(mockSemaphore.tryAcquire).not.toHaveBeenCalled();
  });

  it('errors without a manifest', async () => {
    delete files[`${DIR}/manifest.json`];
    const r = await handler({ captureDir: 'page-x', baseUrl: 'http://localhost:3000' });
    expect(r.content[0].text).toContain('No readable manifest.json');
  });

  it('screenshots each page path per preset, diffs, and reports worst first', async () => {
    const bands = new Array(10).fill(0); bands[0] = 0.6; bands[3] = 0.2;
    vi.mocked(diffImages).mockResolvedValueOnce(diff(0.02) as never).mockResolvedValueOnce(diff(0.3, bands) as never).mockResolvedValueOnce(diff(0.1) as never);
    const r = await handler({ captureDir: 'page-x', baseUrl: 'http://localhost:3000' });

    expect(r.isError).toBeUndefined();
    expect(mockPage.goto.mock.calls.map(c => c[0])).toEqual(['http://localhost:3000/', 'http://localhost:3000/', 'http://localhost:3000/docs?a=1']);
    const text: string = r.content[0].text;
    expect(text).toContain('Compared 3 screenshot(s)');
    const order = ['00-home @ desktop', '01-docs @ desktop', '00-home @ iphone-17'].map(s => text.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('30.0%  00-home @ desktop  (0–10% down: 60.0%, 30–40% down: 20.0%)');
    // unsafe file name from the manifest is never read
    expect(text).toContain('01-docs @ iphone-17: skipped');
    expect(Object.keys(files)).toContain(`${DIR}/compare/00-home-desktop-diff.png`);
    expect(Object.keys(files)).toContain(`${DIR}/compare/report.json`);
    expect(mockPage.bringToFront).toHaveBeenCalledTimes(3);
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(mockSemaphore.release).toHaveBeenCalled();
  });

  it('filters by page and preset', async () => {
    vi.mocked(diffImages).mockResolvedValue(diff(0) as never);
    await handler({ captureDir: 'page-x', baseUrl: 'http://localhost:3000', pages: ['/docs?a=1'], presets: ['desktop'] });
    expect(mockPage.goto).toHaveBeenCalledTimes(1);
    expect(mockPage.emulate).toHaveBeenCalledTimes(1);
  });
});
