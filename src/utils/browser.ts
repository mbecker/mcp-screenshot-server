// ============================================================================
// SSRF-guarded Puppeteer launch shared by the web screenshot tools
// ============================================================================

import puppeteer, { type Browser, type Page } from 'puppeteer';
import { ALLOW_LOCAL } from '../config/index.js';
import { validateUrl } from '../validators/url.js';
import type { UrlValidationResult } from '../types/index.js';

/**
 * Launch headless Chromium pinned to the pre-resolved IP, with navigation
 * requests re-validated. `url` must already have passed validateUrl().
 * Caller owns closing the browser.
 */
export async function launchGuardedPage(
  url: string,
  urlValidation: UrlValidationResult
): Promise<{ browser: Browser; page: Page }> {
  // SEC-001: IP pinning to protect against DNS rebinding attacks
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ];
  if (urlValidation.resolvedIp && urlValidation.hostname) {
    // Chromium requires bracket notation for IPv6 addresses in host-resolver-rules
    const pinnedIp = urlValidation.resolvedIp.includes(':')
      ? `[${urlValidation.resolvedIp}]`
      : urlValidation.resolvedIp;
    browserArgs.push(`--host-resolver-rules=MAP ${urlValidation.hostname} ${pinnedIp}`);
  }
  const browser = await puppeteer.launch({ headless: true, args: browserArgs });
  try {
    const page = await browser.newPage();

    // SEC-001: Intercept requests to prevent SSRF via HTTP redirects.
    // page.goto() follows redirects by default; a 302 to an internal host
    // would bypass the initial URL validation and --host-resolver-rules pin.
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        // Only validate navigation requests (initial load + redirects).
        // Subresource requests (images, scripts, etc.) are allowed through
        // since blocking them would break most pages, and the primary SSRF
        // threat is navigation-level redirects to internal services.
        if (req.isNavigationRequest()) {
          const reqUrl = req.url();
          // Allow the original validated URL, and any URL on the pinned hostname
          // (--host-resolver-rules forces it to the validated IP), without a new DNS lookup
          if (reqUrl === url || (urlValidation.resolvedIp && new URL(reqUrl).hostname === urlValidation.hostname)) {
            req.continue();
            return;
          }
          // Validate redirect target against SSRF rules
          const redirectValidation = await validateUrl(reqUrl, { allowLocal: ALLOW_LOCAL });
          if (!redirectValidation.valid) {
            req.abort('blockedbyclient');
            return;
          }
          req.continue();
        } else {
          req.continue();
        }
      } catch {
        // If validation throws unexpectedly, abort the request rather than
        // leaving it dangling (which would hang page navigation until timeout).
        try { req.abort('failed'); } catch { /* request may already be handled */ }
      }
    });
    return { browser, page };
  } catch (e) {
    try { await browser.close(); } catch { /* already dead */ }
    throw e;
  }
}
