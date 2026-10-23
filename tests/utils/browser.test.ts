import { describe, it, expect, vi, beforeEach } from 'vitest';

let onRequest: (req: unknown) => Promise<void>;
const mockPage = {
  setRequestInterception: vi.fn(),
  on: vi.fn((_e: string, h: typeof onRequest) => { onRequest = h; }),
};
const mockLaunch = vi.fn(async (_opts: unknown) => ({ newPage: async () => mockPage, close: vi.fn() }));
vi.mock('puppeteer', () => ({ default: { launch: (o: unknown) => mockLaunch(o) } }));
vi.mock('../../src/config/index.js', () => ({ ALLOW_LOCAL: false }));
vi.mock('../../src/validators/url.js', () => ({ validateUrl: vi.fn() }));

import { validateUrl } from '../../src/validators/url.js';
import { launchGuardedPage } from '../../src/utils/browser.js';

const nav = (url: string) => ({ isNavigationRequest: () => true, url: () => url, continue: vi.fn(), abort: vi.fn() });

describe('launchGuardedPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await launchGuardedPage('https://example.com', { valid: true, resolvedIp: '93.184.216.34', hostname: 'example.com' });
  });

  it('pins the hostname to the validated IP', () => {
    expect(JSON.stringify(mockLaunch.mock.calls[0][0])).toContain('--host-resolver-rules=MAP example.com 93.184.216.34');
  });

  it('lets navigations on the pinned hostname through without re-validating', async () => {
    const req = nav('https://example.com/docs?x=1');
    await onRequest(req);
    expect(req.continue).toHaveBeenCalled();
    expect(validateUrl).not.toHaveBeenCalled();
  });

  it('re-validates navigations to other hosts and blocks unsafe ones', async () => {
    vi.mocked(validateUrl).mockResolvedValueOnce({ valid: false, error: 'private IP' });
    const evil = nav('http://internal.example.org/admin');
    await onRequest(evil);
    expect(evil.abort).toHaveBeenCalledWith('blockedbyclient');

    vi.mocked(validateUrl).mockResolvedValueOnce({ valid: true });
    const ok = nav('https://cdn.example.net/');
    await onRequest(ok);
    expect(ok.continue).toHaveBeenCalled();
  });

  it('validates another host once per browser, and never caches a failure', async () => {
    vi.mocked(validateUrl).mockResolvedValueOnce({ valid: false, error: 'DNS resolution failed' });
    const first = nav('https://www.example.com/a');
    await onRequest(first);
    expect(first.abort).toHaveBeenCalled(); // failure is not remembered…

    vi.mocked(validateUrl).mockResolvedValue({ valid: true });
    const second = nav('https://www.example.com/b');
    await onRequest(second); // …so this one is validated again
    expect(second.continue).toHaveBeenCalled();
    expect(validateUrl).toHaveBeenCalledTimes(2);

    const third = nav('https://www.example.com/c?x=1');
    await onRequest(third); // now remembered: no third lookup
    expect(third.continue).toHaveBeenCalled();
    expect(validateUrl).toHaveBeenCalledTimes(2);

    const otherScheme = nav('http://www.example.com/d');
    await onRequest(otherScheme); // different protocol is a different key
    expect(validateUrl).toHaveBeenCalledTimes(3);
  });

  it('does not treat a lookalike subdomain as the pinned host', async () => {
    vi.mocked(validateUrl).mockResolvedValueOnce({ valid: false, error: 'private IP' });
    const req = nav('https://example.com.attacker.test/');
    await onRequest(req);
    expect(validateUrl).toHaveBeenCalled();
    expect(req.abort).toHaveBeenCalled();
  });
});
