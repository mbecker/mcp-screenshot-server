import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { join, basename, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import type { Browser, ElementHandle, Viewport } from 'puppeteer';
import { puppeteerSemaphore, defaultOutDir, ensureDefaultDirectory } from '../config/runtime.js';
import { MAX_CONCURRENT_SCREENSHOTS, ALLOW_LOCAL } from '../config/index.js';
import { DEVICE_PRESETS, DEVICE_PRESET_NAMES } from '../config/device-presets.js';
import { validateUrl } from '../validators/url.js';
import { launchGuardedPage } from '../utils/browser.js';
import { err, timestamp } from '../utils/helpers.js';
import { createUploader } from '../utils/upload.js';
import { dismissCookieBanner, removeElements } from '../utils/consent.js';
import { collectPage, loadLazyContent, type PageContent } from '../utils/design-collect.js';
import { buildDesign, type CapturedPage } from '../utils/design-md.js';
import { recordAssets, buildFontsCss, localizeUrls } from '../utils/assets.js';
import { buildAgentsMd, MANIFEST, type Manifest } from '../utils/handoff.js';

/** Time for scroll-triggered effects (e.g. a shrinking sticky header) to finish animating. */
const SCROLL_SETTLE_MS = 800;

/** How long the first page may take to show its cookie banner. */
const CONSENT_WAIT_MS = 4000;

/** Cap on elements serialized per page, keeps the HTML readable for agents. */
const MAX_HTML_NODES = 5000;

/** Same site, ignoring a leading "www." (e.g. aok.de redirecting to www.aok.de). */
export const sameSite = (a: URL, b: URL): boolean =>
  a.protocol === b.protocol && a.port === b.port && a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');

/** Progress goes to stderr: stdout carries the MCP protocol. */
const log = (msg: string) => console.error(`[take_page_screenshots] ${msg}`);

/** Filename-safe slug of a URL path, e.g. /docs/install → docs-install. */
export const pathSlug = (u: URL): string =>
  (u.pathname + u.search).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'home';

export function registerTakePageScreenshots(server: McpServer): void {
  server.registerTool(
    'take_page_screenshots',
    {
      description:
        `Capture a web page and its sub-pages on several device presets (${DEVICE_PRESET_NAMES.join(', ')}). ` +
        'Follows same-origin links breadth-first up to `depth` levels (0 = only the given page), capped at `maxPages`. ' +
        'With extractDesign (default true) the folder becomes a rebuild package: DESIGN.md (google-labs-code/design.md format), ' +
        'Tailwind v4 theme.css, fonts.css, assets/ (images and fonts the pages loaded), per page a standalone .html with mobile-first ' +
        'Tailwind classes and a .content.json with full text, links, images and forms, plus manifest.json and AGENTS.md (how to rebuild ' +
        'and verify with compare_screenshots). Saves into a new folder under the default output directory.',
      inputSchema: z.object({
        url: z.string().describe('Start URL'),
        presets: z.array(z.enum(DEVICE_PRESET_NAMES)).min(1).optional().describe('Device presets (default: all)'),
        depth: z.number().int().min(0).max(5).optional().describe('Link levels to follow from the start page (default 0)'),
        maxPages: z.number().int().min(1).max(100).optional().describe('Maximum pages to capture (default 20)'),
        fullPage: z.boolean().optional().describe('Capture the full scrollable page, top to bottom (lazy content is loaded first), instead of the viewport'),
        waitForTimeout: z.number().min(0).max(30000).optional().describe('Delay in ms after each load, before the screenshot'),
        extractDesign: z.boolean().optional().describe('Write the rebuild package: design files, assets, page HTML and content, manifest, AGENTS.md (default true)'),
        clickStates: z.array(z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/).describe('Lowercase name used in file names, e.g. "menu"'),
          selector: z.string().min(1).max(500).describe('CSS selector of the element to click, e.g. button:has([data-icon="menu"])'),
        })).max(10).optional()
          .describe('Extra screenshots (and scroll shots) per preset after clicking an element, e.g. a mobile menu button; skipped where it is not visible'),
        scrollOffsets: z.array(z.number().int().min(1).max(50000)).max(10).optional()
          .describe('Extra viewport screenshots after scrolling down this many px each, e.g. [100] to capture a header that shrinks on scroll'),
        removeSelectors: z.array(z.string().min(1).max(500)).max(50).optional()
          .describe('CSS selectors of elements to delete before each screenshot and before extraction, e.g. ["[role=\\"alert\\"]", ".promo"]'),
        cookieBanner: z.enum(['accept', 'reject', 'keep']).optional().describe('Click "accept all" or "reject" on cookie/consent banners before each screenshot, or keep them (default accept)'),
      }),
    },
    async ({ url, presets = DEVICE_PRESET_NAMES, depth = 0, maxPages = 20, fullPage = false, waitForTimeout, extractDesign = true, cookieBanner = 'accept', removeSelectors = [], scrollOffsets = [], clickStates = [] }, ctx) => {
      // Also send MCP progress notifications so clients can reset their request timeout on long crawls
      const token = ctx?.mcpReq?._meta?.progressToken;
      let step = 0;
      const progress = (msg: string) => {
        log(msg);
        if (token !== undefined) {
          ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message: msg } }).catch(() => {});
        }
      };
      ensureDefaultDirectory();

      const urlValidation = await validateUrl(url, { allowLocal: ALLOW_LOCAL });
      if (!urlValidation.valid) {
        return err(`URL validation failed: ${urlValidation.error}`);
      }
      const start = new URL(url);
      start.hash = '';

      // Generated under the default dir from a sanitized hostname, so no path validation needed
      const outDir = join(defaultOutDir, `page-${start.hostname.replace(/[^a-z0-9.-]/gi, '-')}-${timestamp()}`);

      if (!puppeteerSemaphore.tryAcquire()) {
        return err(
          `Concurrent screenshot limit reached (max ${MAX_CONCURRENT_SCREENSHOTS}). ` +
          `Please wait for existing screenshots to complete.`
        );
      }

      let browser: Browser | undefined;
      // Files are uploaded as soon as they exist (no-op unless SCREENSHOT_UPLOAD_URL is set)
      const uploader = createUploader(process.env.SCREENSHOT_UPLOAD_URL ? progress : undefined);
      try {
        let page;
        ({ browser, page } = await launchGuardedPage(url, urlValidation));
        mkdirSync(outDir, { recursive: true });
        const assets = extractDesign ? recordAssets(page) : undefined;

        // BFS over same-origin links. Navigations to the pinned host skip the DNS
        // re-check; any other origin (e.g. the www. host the start page redirects to)
        // is re-validated by launchGuardedPage on every navigation.
        const queue: { href: string; level: number }[] = [{ href: start.href, level: 0 }];
        const seen = new Set([start.href]);
        const origins = new Set([start.origin]);
        let consentClicked: string | null = null;
        let removedTotal = 0;
        const invalidSelectors = new Set<string>();
        const removeUnwanted = async () => {
          const r = await removeElements(page, removeSelectors);
          removedTotal += r.removed;
          r.invalid.forEach(sel => invalidSelectors.add(sel));
        };
        let consentChecked = false;
        const files: string[] = [];
        const report: string[] = [];
        const captured: CapturedPage[] = [];
        type StateShots = Record<string, { screenshots: Record<string, string>; scrolled?: Record<string, Record<string, string>> }>;
        const extras = new Map<string, { content: PageContent; truncated: boolean; shots: Record<string, string>; scrolled: Record<string, Record<string, string>>; states: StateShots }>();
        const stateSkipped = new Map<string, Set<string>>(); // state → presets where the element was not visible
        const stateInvalid = new Set<string>();
        const designPreset = presets.reduce((a, b) => (DEVICE_PRESETS[b].viewport.width > DEVICE_PRESETS[a].viewport.width ? b : a));

        for (let n = 0; n < queue.length && n < maxPages; n++) {
          const { href, level } = queue[n];
          const prefix = `${String(n).padStart(2, '0')}-${pathSlug(new URL(href))}`;
          const screenshots: string[] = [];
          const trees: CapturedPage['trees'] = [];
          let designStyles: CapturedPage['styles'] | undefined;
          const shots: Record<string, string> = {};
          const scrolled: Record<string, Record<string, string>> = {}; // preset → offset → file
          const states: StateShots = {}; // state → preset → file (+ scroll shots)
          try {
            for (const [i, name] of presets.entries()) {
              progress(`[${n + 1}/${Math.min(queue.length, maxPages)}] ${href} @ ${name}`);
              await page.emulate(DEVICE_PRESETS[name]);
              await page.goto(href, { waitUntil: 'networkidle2', timeout: 30000 });
              if (waitForTimeout) await new Promise(r => setTimeout(r, waitForTimeout));
              // Wait for a banner only on the first load; consent is then stored for the run,
              // and pages without a banner only cost one quick check
              const clicked = await dismissCookieBanner(page, cookieBanner, consentChecked ? 0 : CONSENT_WAIT_MS);
              consentChecked = true;
              if (clicked) {
                consentClicked ??= clicked;
                progress(`cookie banner: clicked "${clicked}"`);
              }
              await removeUnwanted();
              if (n === 0 && i === 0) {
                // Follow links on the host the start page redirected to, if it is the same site
                const landed = new URL(page.url());
                landed.hash = '';
                if (sameSite(landed, start)) { origins.add(landed.origin); seen.add(landed.href); }
              }

              // Scroll once so lazy images/sections load and scripts re-insert what they will
              const loadLazy = async () => {
                await page.evaluate(loadLazyContent, 40);
                await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => { /* busy page: go on anyway */ });
                await removeUnwanted();
              };
              // A full-page shot shows everything below the fold, so load it first; a viewport
              // shot is taken before scrolling so it shows the page as first loaded
              if (fullPage) await loadLazy();

              const settle = () => new Promise(r => setTimeout(r, SCROLL_SETTLE_MS));
              const shoot = async (base: string, full: boolean) => {
                const dest = join(outDir, `${base}.png`);
                await page.screenshot({ path: dest, fullPage: full });
                screenshots.push(dest);
                uploader.add(dest);
                return basename(dest);
              };
              // Scrolled viewport shots show scroll effects such as a shrinking header
              const scrollShots = async (base: string) => {
                const out: Record<string, string> = {};
                for (const y of scrollOffsets) {
                  await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), y);
                  await settle();
                  out[String(y)] = await shoot(`${base}-scroll${y}`, false);
                }
                if (scrollOffsets.length) {
                  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                  await settle();
                }
                return out;
              };

              shots[name] = await shoot(`${prefix}-${name}`, fullPage);
              const sc = await scrollShots(`${prefix}-${name}`);
              if (Object.keys(sc).length) scrolled[name] = sc;
              if (extractDesign) {
                if (!fullPage) await loadLazy();
                const { styles, tree, content, truncated } = await page.evaluate(collectPage, MAX_HTML_NODES);
                trees.push({ width: DEVICE_PRESETS[name].viewport.width, tree });
                if (name === designPreset) {
                  designStyles = styles;
                  extras.set(prefix, { content, truncated, shots, scrolled, states });
                }
              }

              if (i === 0 && level < depth) {
                const links = await page.$$eval('a[href]', as => as.map(a => (a as HTMLAnchorElement).href));
                for (const link of links) {
                  const u = new URL(link);
                  u.hash = '';
                  if (origins.has(u.origin) && !seen.has(u.href)) {
                    seen.add(u.href);
                    queue.push({ href: u.href, level: level + 1 });
                  }
                }
              }

              // Click states (e.g. an open mobile menu): reload for a clean start, click, shoot
              for (const state of clickStates) {
                progress(`[${n + 1}] ${href} @ ${name}: ${state.name}`);
                await page.goto(href, { waitUntil: 'networkidle2', timeout: 30000 });
                await dismissCookieBanner(page, cookieBanner, 0);
                await removeUnwanted();
                let target: ElementHandle<Element> | undefined;
                try {
                  for (const h of await page.$$(state.selector)) if (await h.isVisible()) { target = h; break; }
                } catch {
                  stateInvalid.add(`${state.name}: ${state.selector}`);
                  continue;
                }
                if (!target) {
                  if (!stateSkipped.has(state.name)) stateSkipped.set(state.name, new Set());
                  stateSkipped.get(state.name)!.add(name);
                  continue;
                }
                // Real mouse click so frameworks react; fall back to a DOM click if it is covered
                await target.click().catch(() => target!.evaluate(el => (el as HTMLElement).click()));
                await page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => {});
                await settle();
                const base = `${prefix}-${name}-${state.name}`;
                const entry = (states[state.name] ||= { screenshots: {} });
                entry.screenshots[name] = await shoot(base, fullPage);
                const ssc = await scrollShots(base);
                if (Object.keys(ssc).length) (entry.scrolled ||= {})[name] = ssc;
              }
            }
            if (designStyles) captured.push({ url: href, prefix, screenshots, styles: designStyles, trees });
            report.push(`${href} → ${prefix}-*.png`);
          } catch (e) {
            report.push(`${href} → failed: ${e instanceof Error ? e.message : e}`);
          }
          files.push(...screenshots);
        }

        if (captured.length && assets) {
          // Local copies of every image/font the pages loaded
          progress(`writing rebuild package (${assets.files.size} assets)`);
          await assets.settle();
          const local = new Map([...assets.files].map(([u, a]) => [u, a.path]));
          for (const a of assets.files.values()) {
            mkdirSync(dirname(join(outDir, a.path)), { recursive: true });
            writeFileSync(join(outDir, a.path), a.data);
          }
          const families = [...new Set(captured.flatMap(p => Object.keys(p.styles.fonts)))];
          const fontsCss = buildFontsCss(assets.css, families, local);

          const { designMd, themeCss, htmlDocs } = buildDesign(captured, start.href, { fontsCss: !!fontsCss });
          const written: [string, string][] = [
            ['DESIGN.md', designMd],
            ['theme.css', themeCss],
            ...(fontsCss ? [['fonts.css', fontsCss] as [string, string]] : []),
          ];
          const manifest: Manifest = {
            version: 1,
            source: start.href,
            capturedAt: new Date().toISOString(),
            fullPage,
            presets: presets.map(name => {
              const v: Viewport = DEVICE_PRESETS[name].viewport;
              return { name, width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor ?? 1, isMobile: !!v.isMobile };
            }),
            pages: [],
            files: { agents: 'AGENTS.md', design: 'DESIGN.md', theme: 'theme.css', ...(fontsCss ? { fonts: 'fonts.css' } : {}) },
            assets: Object.fromEntries(local),
          };
          for (const p of captured) {
            const { content, truncated, shots, scrolled, states } = extras.get(p.prefix)!;
            const images = content.images.map(i => ({ ...i, local: local.get(i.src) }));
            written.push([`${p.prefix}.html`, localizeUrls(htmlDocs[p.prefix], local)]);
            written.push([`${p.prefix}.content.json`, JSON.stringify({ ...content, images }, null, 2)]);
            const u = new URL(p.url);
            manifest.pages.push({
              url: p.url, path: u.pathname + u.search, prefix: p.prefix, screenshots: shots,
              ...(scrollOffsets.length ? { scrolled } : {}),
              ...(Object.keys(states).length ? { states } : {}),
              html: `${p.prefix}.html`, content: `${p.prefix}.content.json`, ...(truncated ? { truncated } : {}),
            });
          }
          written.push([MANIFEST, JSON.stringify(manifest, null, 2)], ['AGENTS.md', buildAgentsMd(manifest)]);
          for (const [name, content] of written) {
            const dest = join(outDir, name);
            writeFileSync(dest, content);
            files.push(dest);
            uploader.add(dest); // assets/ stays local
          }
          report.push(`Rebuild package: AGENTS.md, ${MANIFEST}, DESIGN.md, theme.css${fontsCss ? ', fonts.css' : ''}, ` +
            `${captured.length} page(s) .html + .content.json, ${assets.files.size} asset(s) in assets/`);
        }

        if (process.env.SCREENSHOT_UPLOAD_URL) progress('waiting for remaining uploads');
        for (const state of clickStates) {
          const skipped = stateSkipped.get(state.name);
          report.push(`State "${state.name}" (${state.selector})` + (skipped ? `: not visible on ${[...skipped].join(', ')}` : ': captured on all presets'));
        }
        if (stateInvalid.size) report.push(`Invalid click selector: ${[...stateInvalid].join('; ')}`);
        if (removeSelectors.length) {
          report.push(`Removed ${removedTotal} element(s) matching ${removeSelectors.join(', ')}` +
            (invalidSelectors.size ? ` (invalid selector: ${[...invalidSelectors].join(', ')})` : ''));
        }
        if (cookieBanner !== 'keep') {
          report.push(consentClicked ? `Cookie banner: clicked "${consentClicked}"` : 'Cookie banner: none found');
        }
        const skipped = queue.length - Math.min(queue.length, maxPages);
        return await uploader.finish(
          `Saved ${files.length} files to ${outDir}\n${report.join('\n')}` +
            (skipped ? `\n${skipped} more linked pages not captured (maxPages=${maxPages})` : '')
        );
      } catch (e) {
        // Still wait for uploads already queued, so nothing in flight is lost
        const r = await uploader.finish(`Screenshot error: ${e instanceof Error ? e.message : e}`);
        return { ...r, isError: true };
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* browser may already be dead */ }
        }
        puppeteerSemaphore.release();
      }
    }
  );
}
