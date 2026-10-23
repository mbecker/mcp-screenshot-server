/**
 * Consent-banner clicking in real Chromium against typical banner shapes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { clickConsentButton, dismissCookieBanner, removeElements } from '../../src/utils/consent.js';

let browser: Browser;
let page: Page;

// Records which button was clicked in window.clicked (reset per page: setContent keeps the window)
const rec = `<script>window.clicked = null; document.addEventListener('click', e => { window.clicked = (e.composedPath()[0].dataset.id || ''); }, true)</script>`;

const AOK_STYLE = `${rec}
<main><h1>Willkommen</h1></main>
<div role="dialog" class="modal"><p>Datenschutzhinweis: Die Seite nutzt Cookies. Wir bitten um Ihre Zustimmung.</p>
  <button data-id="settings">Individuelle Einstellungen</button>
  <button data-id="reject">Optionale Cookies ablehnen</button>
  <button data-id="accept">Alle akzeptieren</button>
</div>`;

beforeAll(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => { await browser?.close(); });

const clickedIn = (p: Page | import('puppeteer').Frame) => p.evaluate(() => (window as unknown as { clicked?: string }).clicked ?? null);

describe('clickConsentButton', () => {
  it('accepts or rejects a custom dialog by button text', async () => {
    await page.setContent(AOK_STYLE);
    expect(await page.evaluate(clickConsentButton, 'accept')).toBe('Alle akzeptieren');
    expect(await clickedIn(page)).toBe('accept');
    await page.setContent(AOK_STYLE);
    expect(await page.evaluate(clickConsentButton, 'reject')).toBe('Optionale Cookies ablehnen');
    expect(await clickedIn(page)).toBe('reject');
  });

  it('finds known consent-platform buttons inside shadow DOM', async () => {
    await page.setContent(`${rec}<div id="usercentrics-root"></div><script>
      const root = document.getElementById('usercentrics-root').attachShadow({ mode: 'open' });
      root.innerHTML = '<div><button data-testid="uc-deny-all-button" data-id="deny">Deny</button><button data-testid="uc-accept-all-button" data-id="ok">OK</button></div>';
    </script>`);
    expect(await page.evaluate(clickConsentButton, 'accept')).toBe('OK');
    expect(await clickedIn(page)).toBe('ok');
  });

  it('ignores accept-like buttons that are not part of a consent banner', async () => {
    // "Datenschutz" only in the footer: must not make an unrelated button qualify
    await page.setContent(`${rec}<form><p>Bitte bestätigen Sie die Teilnahmebedingungen.</p><button data-id="terms">Akzeptieren</button></form>
      <footer><a href="/datenschutz">Datenschutz</a> · <a href="/impressum">Impressum</a></footer>`);
    expect(await page.evaluate(clickConsentButton, 'accept')).toBeNull();
    expect(await clickedIn(page)).toBeNull();
  });

  it('ignores hidden banners', async () => {
    await page.setContent(AOK_STYLE.replace('class="modal"', 'class="modal" style="display:none"'));
    expect(await page.evaluate(clickConsentButton, 'accept')).toBeNull();
  });
});

describe('dismissCookieBanner', () => {
  it('waits for a late banner and handles iframes', async () => {
    await page.setContent(`<iframe id="f" srcdoc="${`${rec}<div class='cookie-consent'><p>We use cookies</p><button data-id='all'>Accept all</button></div>`.replace(/"/g, '&quot;')}"></iframe>`);
    await page.waitForSelector('iframe');
    const start = Date.now();
    expect(await dismissCookieBanner(page, 'accept', 3000)).toBe('Accept all');
    expect(Date.now() - start).toBeLessThan(3000);
    const frame = page.frames().find(f => f !== page.mainFrame())!;
    expect(await clickedIn(frame)).toBe('all');
  });

  it('returns null quickly when there is no banner, and does nothing in keep mode', async () => {
    await page.setContent(`${rec}<p>No banner</p>`);
    const start = Date.now();
    expect(await dismissCookieBanner(page, 'accept', 0)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
    await page.setContent(AOK_STYLE);
    expect(await dismissCookieBanner(page, 'keep', 1000)).toBeNull();
    expect(await clickedIn(page)).toBeNull();
  });
});

describe('removeElements', () => {
  it('removes matches in the document, shadow DOM and iframes, and reports invalid selectors', async () => {
    await page.setContent(`<div role="alert">Wichtiges Sicherheits-Update</div><p class="keep">Content</p>
      <div id="host"></div><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<div class="promo">Sale</div>';</script>
      <iframe srcdoc="<div class='promo'>Frame promo</div><p>stays</p>"></iframe>`);
    await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.promo'));
    const r = await removeElements(page, ['[role="alert"]', '.promo', '!!']);
    expect(r).toEqual({ removed: 3, invalid: ['!!'] });
    expect(await page.evaluate(() => [
      document.querySelectorAll('[role="alert"]').length,
      document.getElementById('host')!.shadowRoot!.querySelectorAll('.promo').length,
      document.querySelector('iframe')!.contentDocument!.querySelectorAll('.promo, p').length,
      document.querySelectorAll('.keep').length,
    ])).toEqual([0, 0, 1, 1]); // only the iframe's <p> and the main .keep remain
  });
});
