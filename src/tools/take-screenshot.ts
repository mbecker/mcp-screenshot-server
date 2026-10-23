import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Browser, Page } from 'puppeteer';
import { puppeteerSemaphore, defaultOutDir, ensureDefaultDirectory } from '../config/runtime.js';
import { ALLOWED_OUTPUT_DIRS, MAX_CONCURRENT_SCREENSHOTS, ALLOW_LOCAL } from '../config/index.js';
import { validateUrl } from '../validators/url.js';
import { launchGuardedPage } from '../utils/browser.js';
import { validateOutputPath } from '../validators/path.js';
import { ok, err, timestamp, ensureDir } from '../utils/helpers.js';
import { withUpload } from '../utils/upload.js';

// Semaphore protects expensive Puppeteer operations

export function registerTakeScreenshot(server: McpServer): void {
  server.registerTool(
    'take_screenshot',
    {
      description: 'Capture web page or element via headless browser. Saves to ~/Documents/screenshots by default (configurable via SCREENSHOT_OUTPUT_DIR env var).',
      inputSchema: z.object({
        url: z.string().describe('URL to capture'),
        width: z.number().min(1).max(3840).optional().describe('Viewport width'),
        height: z.number().min(1).max(2160).optional().describe('Viewport height'),
        fullPage: z.boolean().optional().describe('Capture full page'),
        selector: z.string().optional().describe('CSS selector for element'),
        waitForSelector: z.string().optional().describe('Wait for selector'),
        waitForTimeout: z.number().min(0).max(30000).optional().describe('Delay in ms'),
        outputPath: z.string().optional().describe('Absolute path, or relative to home dir'),
      }),
    },
    async ({ url, width, height, fullPage, selector, waitForSelector, waitForTimeout, outputPath: custom }) => {
      ensureDefaultDirectory(); // Ensure the default directory exists

      // Security: Validate URL before making request (SSRF prevention)
      // Now async to support DNS resolution for DNS rebinding protection (SEC-001)
      const urlValidation = await validateUrl(url, { allowLocal: ALLOW_LOCAL });
      if (!urlValidation.valid) {
        return err(`URL validation failed: ${urlValidation.error}`);
      }

      // Security: Validate output path (path traversal prevention)
      // SEC-004: Now async to resolve symlinks before validation
      const pathValidation = await validateOutputPath(custom, `screenshot-${timestamp()}.png`, { allowedOutputDirs: ALLOWED_OUTPUT_DIRS, defaultOutDir });
      if (!pathValidation.valid) {
        return err(`Output path validation failed: ${pathValidation.error}`);
      }
      const dest = pathValidation.path!;

      // SEC-005: DoS Protection - Limit concurrent Puppeteer instances
      // Try to acquire a permit without waiting. If at capacity, reject immediately
      // rather than queuing (which would still allow memory exhaustion via queued requests).
      // Each browser instance consumes 100-500MB, so we limit to MAX_CONCURRENT_SCREENSHOTS.
      if (!puppeteerSemaphore.tryAcquire()) {
        return err(
          `Concurrent screenshot limit reached (max ${MAX_CONCURRENT_SCREENSHOTS}). ` +
          `Please wait for existing screenshots to complete.`
        );
      }

      // Declare browser outside try block to ensure cleanup in finally
      let browser: Browser | undefined;
      let page: Page;
      try {
        ({ browser, page } = await launchGuardedPage(url, urlValidation));
        if (width && height) await page.setViewport({ width, height });

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: 30000 });
        if (waitForTimeout) await new Promise(r => setTimeout(r, waitForTimeout));

        ensureDir(dest);

        if (selector) {
          const el = await page.$(selector);
          if (!el) { return err(`Element not found: ${selector}`); }
          await el.screenshot({ path: dest });
        } else {
          await page.screenshot({ path: dest, fullPage: fullPage || false });
        }
        return await withUpload(`Screenshot saved: ${dest}`, [dest]);
      } catch (e) {
        return err(`Screenshot error: ${e instanceof Error ? e.message : e}`);
      } finally {
        // Ensure browser is always closed to prevent resource leaks
        // Close browser BEFORE releasing semaphore to avoid briefly exceeding concurrency limit
        if (browser) {
          try { await browser.close(); } catch { /* browser may already be dead */ }
        }
        // SEC-005: Always release permit to prevent deadlock, even on error
        puppeteerSemaphore.release();
      }
    }
  );
}
