/**
 * Runs the in-page collector in real Chromium against a known page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { collectPage, type PageExtract } from '../../src/utils/design-collect.js';
import { renderResponsive } from '../../src/utils/design-html.js';

const PAGE = `<!doctype html><html lang="de"><head><title>Acme</title>
<meta name="description" content="Acme tools"><meta property="og:title" content="Acme OG">
<style>
  :root { --color-brand: #2563eb; }
  body { margin: 0; background: #fafafa; color: #111827; font: 16px/1.5 Arial, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px; display: grid; grid-template-columns: 200px 1fr; gap: 24px; }
  h1 { font-size: 48px; font-weight: 700; margin: 0; grid-column: 1 / span 2; }
  .cta { align-self: start; display: inline-flex; background: var(--color-brand); color: #fff; padding: 12px 24px; border-radius: 8px; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.1), 0 0 0 0 rgba(0,0,0,0); }
  .card { position: relative; width: 300px; height: 100px; }
  .badge { position: absolute; top: 8px; right: 12px; width: 40px; height: 20px; }
  .stack { display: flex; flex-direction: column; align-items: flex-start; }
  .stack .wide { width: 100%; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; }
  pre span { display: block; }
  @media (min-width: 768px) { main { padding: 48px; } }
</style></head><body>
<main>
  <h1>Build <em>faster</em></h1>
  <a class="cta" href="/start">Get started</a>
  <div class="card"><p>Card text</p><b class="badge">New</b></div>
  <div class="stack"><button class="wide">Wide</button><button>Narrow</button></div>
  <span class="sr">Screen reader only</span>
  <pre><span>npm i</span><span>  npm run dev</span></pre>
  <div hidden>Invisible</div>
  <form action="/subscribe" method="post"><label for="em">Email</label><input id="em" name="email" type="email"><input type="hidden" name="t" value="x"><button>Join</button></form>
  <p class="long">Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text Long text </p>
</main>
</body></html>`;

let browser: Browser;
let result: PageExtract;
let mobile: PageExtract;
let html: string;

beforeAll(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setContent(PAGE);
  result = await page.evaluate(collectPage, 500);
  html = renderResponsive([{ width: 1280, tree: result.tree }]);
  await page.setViewport({ width: 402, height: 800 });
  mobile = await page.evaluate(collectPage, 500);
}, 30_000);

afterAll(async () => { await browser?.close(); });

describe('collectPage', () => {
  it('collects tokens from computed styles', () => {
    const s = result.styles;
    expect(s.title).toBe('Acme');
    expect(s.lang).toBe('de');
    expect(s.pageBg).toBe('#fafafa');
    expect(Object.keys(s.textColors)).toContain('#111827');
    expect(s.colorVars['#2563eb']).toBe('--color-brand');
    expect(s.radii['8px']).toBe(2);
    expect(Object.keys(s.shadows)).toEqual(['rgba(0, 0, 0, 0.1) 0px 1px 2px 0px']); // transparent layer dropped
    expect(s.breakpoints['768']).toBe(1);
    expect(s.maxWidths['960px']).toBe(1);
    expect(Object.keys(s.typography.h1)[0]).toBe('Arial|48|700|1.5|');
    const button = JSON.parse(Object.keys(s.components.button).find(k => k.includes('#2563eb'))!);
    expect(button).toMatchObject({ backgroundColor: '#2563eb', textColor: '#ffffff', rounded: '8px', padding: '12px 24px' });
  });

  it('emits simplified HTML with Tailwind classes', () => {
    const h = html;
    // p-12: the min-width 768px media query applies at 1280px
    expect(h).toContain('<main class="grid gap-6 grid-cols-[200px_736px] p-12 mx-auto mt-0 mb-0 max-w-[960px]">');
    expect(h).toContain('<h1 class="col-[1_/_span_2] text-5xl font-bold">Build <em>faster</em></h1>');
    // inline-flex grid items are blockified to flex by the browser; preflight makes links inherit decoration
    expect(h).toContain('<a class="flex self-start px-6 py-3 underline bg-[#2563eb] rounded-[8px] text-[#ffffff]" href="/start">Get started</a>');
    expect(h).toContain('border border-[#e5e7eb] rounded-[8px] shadow-[rgba(0,_0,_0,_0.1)_0px_1px_2px_0px]');
    // <pre> keeps its whitespace exactly; block spans get "block"
    expect(h).toContain('<span class="block">npm i</span><span class="block">  npm run dev</span>');
    // absolute: all four measured insets (300 - 12 - 40 = 248, 100 - 8 - 20 = 72)
    expect(h).toContain('<b class="block absolute top-2 right-3 bottom-18 left-62 font-bold">New</b>');
    // full-width item in a non-stretching flex column
    expect(h).toMatch(/<button class="[^"]*w-full[^"]*">Wide<\/button>/);
    expect(h).toMatch(/<button class="(?![^"]*w-full)[^"]*">Narrow<\/button>/);
    expect(h).not.toContain('Screen reader only');
    expect(h).not.toContain('Invisible');
  });

  it('extracts content: meta, headings, full text, links, forms', () => {
    const c = result.content;
    expect(c.meta).toMatchObject({ description: 'Acme tools', 'og:title': 'Acme OG' });
    expect(c.headings).toEqual([{ level: 1, text: 'Build faster' }]);
    expect(c.text).toContain('Card text');
    expect(c.text).not.toContain('Invisible');
    expect(c.links).toEqual([{ text: 'Get started', href: expect.stringMatching(/\/start$/) }]);
    expect(c.forms).toEqual([{ action: expect.stringMatching(/\/subscribe$/), method: 'post', fields: [
      { tag: 'input', type: 'email', name: 'email', label: 'Email' },
      { tag: 'button', type: 'submit', name: '', label: 'Join' },
    ] }]);
    // long text is no longer cut in the HTML
    expect(html).toContain('Long text '.repeat(40).trim());
    expect(result.truncated).toBe(false);
  });

  it('adds responsive variants from a second width', () => {
    const r = renderResponsive([{ width: 1280, tree: result.tree }, { width: 402, tree: mobile.tree }]);
    // 402px: below the media query → p-8, and max-w doesn't bind → no auto margin.
    // 1280px falls under xl: 48px padding, centered, grid track re-measured.
    expect(r).toMatch(/<main class="grid gap-6 grid-cols-\[200px_\d+px\] p-8 max-w-\[960px\] xl:grid-cols-\[200px_736px\] xl:p-12 xl:mx-auto xl:mt-0 xl:mb-0">/);
    // unchanged elements carry no variants
    expect(r).toContain('<h1 class="col-[1_/_span_2] text-5xl font-bold">');
  });
});
