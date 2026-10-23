import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { join, dirname } from 'path';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { Browser } from 'puppeteer';
import { puppeteerSemaphore, defaultOutDir } from '../config/runtime.js';
import { ALLOWED_OUTPUT_DIRS, MAX_CONCURRENT_SCREENSHOTS, ALLOW_LOCAL } from '../config/index.js';
import { DEVICE_PRESETS, type DevicePresetName } from '../config/device-presets.js';
import { validateUrl } from '../validators/url.js';
import { validateOutputPath } from '../validators/path.js';
import { launchGuardedPage } from '../utils/browser.js';
import { ok, err } from '../utils/helpers.js';
import { diffImages } from '../utils/image-diff.js';
import { MANIFEST, type Manifest } from '../utils/handoff.js';

/** Names taken from manifest.json end up in file paths, so they must be plain file names. */
const SAFE_NAME = /^[\w.-]+$/;
const BANDS = 10;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function registerCompareScreenshots(server: McpServer): void {
  server.registerTool(
    'compare_screenshots',
    {
      description:
        'Compare a local re-implementation with a capture from take_page_screenshots. Screenshots every captured page path on baseUrl ' +
        'with the same device presets, pixel-diffs against the originals and reports mismatch per page and preset, which vertical ' +
        'bands differ most, and writes <captureDir>/compare/*-actual.png and *-diff.png (differences in red). ' +
        'Opening localhost requires the server to run with ALLOW_LOCAL=true.',
      inputSchema: z.object({
        captureDir: z.string().describe('Folder written by take_page_screenshots (absolute, or relative to the screenshot output directory)'),
        baseUrl: z.string().describe('Base URL of the local build, e.g. http://localhost:3000; each captured path is appended'),
        pages: z.array(z.string()).optional().describe('Only these page prefixes (e.g. "01-docs") or paths (e.g. "/docs")'),
        presets: z.array(z.string()).optional().describe('Only these presets (default: all captured)'),
      }),
    },
    async ({ captureDir, baseUrl, pages: onlyPages, presets: onlyPresets }) => {
      const manifestPath = await validateOutputPath(join(captureDir, MANIFEST), MANIFEST, { allowedOutputDirs: ALLOWED_OUTPUT_DIRS, defaultOutDir });
      if (!manifestPath.valid) return err(`captureDir: ${manifestPath.error}`);
      const dir = dirname(manifestPath.path!);
      let manifest: Manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath.path!, 'utf8'));
      } catch {
        return err(`No readable ${MANIFEST} in ${dir}. Capture with take_page_screenshots (extractDesign: true) first.`);
      }

      const urlValidation = await validateUrl(baseUrl, { allowLocal: ALLOW_LOCAL });
      if (!urlValidation.valid) {
        const hint = /localhost|127\.|::1|loopback/i.test(`${baseUrl} ${urlValidation.error}`) && !ALLOW_LOCAL
          ? ' Start the MCP server with ALLOW_LOCAL=true to compare against a local dev server.' : '';
        return err(`URL validation failed: ${urlValidation.error}.${hint}`);
      }

      const pages = manifest.pages.filter(p => !onlyPages || onlyPages.includes(p.prefix) || onlyPages.includes(p.path));
      const presets = manifest.presets.filter(p => !onlyPresets || onlyPresets.includes(p.name));
      if (!pages.length || !presets.length) return err('No pages or presets match the filter.');

      if (!puppeteerSemaphore.tryAcquire()) {
        return err(`Concurrent screenshot limit reached (max ${MAX_CONCURRENT_SCREENSHOTS}). Please wait for existing screenshots to complete.`);
      }
      let browser: Browser | undefined;
      try {
        let page;
        ({ browser, page } = await launchGuardedPage(baseUrl, urlValidation));
        const diffPage = await browser.newPage();
        const outDir = join(dir, 'compare');
        mkdirSync(outDir, { recursive: true });

        const results: { prefix: string; preset: string; path: string; mismatch?: number; bands?: number[]; note?: string; diff?: string; actual?: string }[] = [];
        for (const p of pages) {
          for (const preset of presets) {
            const original = p.screenshots[preset.name];
            const r: (typeof results)[number] = { prefix: p.prefix, preset: preset.name, path: p.path };
            results.push(r);
            if (!original || ![p.prefix, preset.name, original].every(n => SAFE_NAME.test(n)) || !(preset.name in DEVICE_PRESETS)) {
              r.note = 'skipped: no usable original screenshot or unknown preset';
              continue;
            }
            try {
              await page.emulate(DEVICE_PRESETS[preset.name as DevicePresetName]);
              await page.goto(new URL(p.path, baseUrl).href, { waitUntil: 'networkidle2', timeout: 30000 });
              // The diff tab steals focus; a background tab stops producing frames and the screenshot hangs
              await page.bringToFront();
              const actual = Buffer.from(await page.screenshot({ fullPage: manifest.fullPage }));
              const d = await diffImages(diffPage, readFileSync(join(dir, original)), actual);
              r.actual = join('compare', `${p.prefix}-${preset.name}-actual.png`);
              r.diff = join('compare', `${p.prefix}-${preset.name}-diff.png`);
              writeFileSync(join(dir, r.actual), actual);
              writeFileSync(join(dir, r.diff), d.diffPng);
              r.mismatch = d.mismatch;
              r.bands = d.bands;
              if (d.sizeA.join() !== d.sizeB.join()) r.note = `size differs: original ${d.sizeA.join('×')}, local ${d.sizeB.join('×')}`;
            } catch (e) {
              r.note = `failed: ${e instanceof Error ? e.message : e}`;
            }
          }
        }
        writeFileSync(join(outDir, 'report.json'), JSON.stringify({ baseUrl, comparedAt: new Date().toISOString(), results }, null, 2));

        const done = results.filter(r => r.mismatch !== undefined).sort((a, b) => b.mismatch! - a.mismatch!);
        const avg = done.reduce((s, r) => s + r.mismatch!, 0) / (done.length || 1);
        const lines = done.map(r => {
          const worst = r.bands!.map((v, k) => [v, k] as const).filter(([v]) => v > 0.05).sort((a, b) => b[0] - a[0]).slice(0, 3)
            .map(([v, k]) => `${k * BANDS}–${(k + 1) * BANDS}% down: ${pct(v)}`);
          return `${pct(r.mismatch!).padStart(6)}  ${r.prefix} @ ${r.preset}${worst.length ? `  (${worst.join(', ')})` : ''}${r.note ? `  [${r.note}]` : ''}  → ${r.diff}`;
        });
        const problems = results.filter(r => r.mismatch === undefined).map(r => `  ${r.prefix} @ ${r.preset}: ${r.note}`);
        return ok([
          `Compared ${done.length} screenshot(s) of ${baseUrl} with ${manifest.source}: average mismatch ${pct(avg)} (worst first).`,
          ...lines,
          ...(problems.length ? ['Not compared:', ...problems] : []),
          `Diff images (differences in red) and report.json in ${outDir}`,
        ].join('\n'));
      } catch (e) {
        return err(`Compare error: ${e instanceof Error ? e.message : e}`);
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* browser may already be dead */ }
        }
        puppeteerSemaphore.release();
      }
    }
  );
}
