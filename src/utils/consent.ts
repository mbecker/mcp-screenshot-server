// ============================================================================
// Clear what covers the page before a screenshot: accept or reject cookie/consent
// banners, and remove elements the caller names by CSS selector.
// ============================================================================

import type { Frame, Page } from 'puppeteer';

export type ConsentMode = 'accept' | 'reject' | 'keep';

/**
 * Runs in a frame via frame.evaluate(), so it must stay self-contained.
 * Clicks the best consent button for `mode` and returns its label, or null.
 */
export function clickConsentButton(mode: 'accept' | 'reject'): string | null {
  // Common consent platforms: exact buttons, most reliable
  const KNOWN: Record<string, string[]> = {
    accept: [
      '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept', '[data-testid="uc-accept-all-button"]', '#didomi-notice-agree-button',
      '.cmpboxbtnyes', '#truste-consent-button', 'button.fc-cta-consent', '[data-cookiefirst-action="accept"]',
    ],
    reject: [
      '#onetrust-reject-all-handler', '#CybotCookiebotDialogBodyButtonDecline', '[data-testid="uc-deny-all-button"]',
      '#didomi-notice-disagree-button', '.cmpboxbtnno', '#truste-consent-required', 'button.fc-cta-do-not-consent',
      '[data-cookiefirst-action="reject"]',
    ],
  };
  // Button labels, best match first (DE, EN, FR, ES, IT, NL)
  const LABELS: Record<string, RegExp[]> = {
    accept: [
      /^(alle[sn]? (cookies )?)?(akzeptieren|annehmen|zulassen|erlauben)$|^accept all( cookies)?$|^allow all( cookies)?$|^tout accepter$|^aceptar todo$|^accetta tutto$|^alles accepteren$/,
      /^(cookies )?(akzeptieren|zustimmen|einverstanden|annehmen)$|^(i )?(accept|agree)( cookies)?$|^allow( cookies)?$|^accepter$|^aceptar$|^accetta$|^accepteren$|^akzeptieren und (weiter|schließen)$/,
    ],
    reject: [
      /^(alle[sn]? )?(optionale |nicht notwendige )?(cookies )?ablehnen$|^reject all( cookies)?$|^decline all$|^tout refuser$|^rechazar todo$|^rifiuta tutto$|^alles weigeren$/,
      /^nur (notwendige|essenzielle|erforderliche|technisch notwendige)( cookies)?( (akzeptieren|zulassen|verwenden))?$|^(use |accept )?(only )?(necessary|essential|required)( cookies)?( only)?$|^(reject|decline|deny|refuse)( cookies)?$|^continuer sans accepter$|^weigeren$/,
    ],
  };
  // A text match only counts inside something that is about cookies/consent
  const CONTEXT = /cookie|consent|datenschutz|privacy|privatsphäre|zustimmung|einwilligung|tracking|rgpd|gdpr|confidentialité|privacidad/i;

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0;
  };
  const label = (el: Element) =>
    ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  // Elements in the document and all open shadow roots
  const all = (root: Document | ShadowRoot, selector: string): Element[] => {
    const out = Array.from(root.querySelectorAll(selector));
    for (const host of Array.from(root.querySelectorAll('*'))) {
      if (host.shadowRoot) out.push(...all(host.shadowRoot, selector));
    }
    return out;
  };
  // Climb to the banner container; stop below <body>, whose footer text would match on any site
  const inConsentContext = (el: Element) => {
    let node: Element | null = el;
    for (let depth = 0; node && depth < 12 && !['BODY', 'HTML'].includes(node.tagName); depth++) {
      if (CONTEXT.test(`${node.id} ${node.getAttribute('class') || ''} ${node.getAttribute('aria-label') || ''}`)) return true;
      const text = depth > 0 ? (node as HTMLElement).innerText || '' : '';
      if (text.length < 5000 && CONTEXT.test(text)) return true;
      node = node.parentElement || ((node.getRootNode() as ShadowRoot).host ?? null);
    }
    return false;
  };
  const click = (el: Element) => { (el as HTMLElement).click(); return label(el) || el.id || el.tagName.toLowerCase(); };

  for (const sel of KNOWN[mode]) {
    const el = all(document, sel).find(visible);
    if (el) return click(el);
  }
  const buttons = all(document, 'button, [role="button"], input[type="button"], input[type="submit"], a').filter(visible);
  for (const re of LABELS[mode]) {
    const el = buttons.find(b => re.test(label(b).toLowerCase()) && inConsentContext(b));
    if (el) return click(el);
  }
  return null;
}

/**
 * Look for a consent banner in every frame for up to `waitMs` and click accept/reject.
 * Returns the clicked label (null when none was found or mode is "keep").
 */
export async function dismissCookieBanner(page: Page, mode: ConsentMode, waitMs: number): Promise<string | null> {
  if (mode === 'keep') return null;
  const deadline = Date.now() + waitMs;
  do {
    for (const frame of page.frames() as Frame[]) {
      const clicked = await frame.evaluate(clickConsentButton, mode).catch(() => null); // detached/navigating frame
      if (clicked) {
        // Banners animate out; some sites reload after consent
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        return clicked;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return null;
}

/**
 * Runs in a frame via frame.evaluate(), so it must stay self-contained.
 * Removes every element matching the selectors (document and open shadow roots).
 */
export function removeMatching(selectors: string[]): { removed: number; invalid: string[] } {
  let removed = 0;
  const invalid: string[] = [];
  const roots = (root: Document | ShadowRoot): (Document | ShadowRoot)[] => [
    root, ...Array.from(root.querySelectorAll('*')).flatMap(el => (el.shadowRoot ? roots(el.shadowRoot) : [])),
  ];
  const all = roots(document);
  for (const sel of selectors) {
    try {
      for (const root of all) for (const el of Array.from(root.querySelectorAll(sel))) { el.remove(); removed++; }
    } catch {
      invalid.push(sel);
    }
  }
  return { removed, invalid };
}

/** Remove matching elements in every frame. Invalid selectors are reported, not thrown. */
export async function removeElements(page: Page, selectors: string[]): Promise<{ removed: number; invalid: string[] }> {
  let removed = 0;
  const invalid = new Set<string>();
  if (!selectors.length) return { removed, invalid: [] };
  for (const frame of page.frames() as Frame[]) {
    const r = await frame.evaluate(removeMatching, selectors).catch(() => null); // detached/navigating frame
    if (!r) continue;
    removed += r.removed;
    r.invalid.forEach(s => invalid.add(s));
  }
  return { removed, invalid: [...invalid] };
}
