import { describe, it, expect, vi } from 'vitest';
import { uploadScreenshot, createUploader } from '../../src/utils/upload.js';

const openAsBlobImpl = vi.fn().mockResolvedValue(new Blob(['png']));
const okRes = (body = '') => vi.fn(async () => new Response(body, { status: 200 }));

describe('uploadScreenshot', () => {
  it('returns null when no URL is configured', async () => {
    const fetchImpl = vi.fn();
    expect(await uploadScreenshot('/tmp/a.png', { url: '', fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to the URL with field name and headers', async () => {
    const fetchImpl = okRes();
    const url = await uploadScreenshot('/tmp/shot.png', {
      url: 'https://files.example/upload', field: 'files',
      headers: '{"Authorization":"Bearer t"}', fetchImpl, openAsBlobImpl,
    });
    expect(url).toBe('https://files.example/upload');
    const [target, init] = fetchImpl.mock.calls[0];
    expect(target).toBe('https://files.example/upload');
    expect(init.headers).toEqual({ Authorization: 'Bearer t' });
    expect((init.body as FormData).get('files')).toHaveProperty('name', 'shot.png');
    expect(openAsBlobImpl).toHaveBeenCalledWith('/tmp/shot.png', { type: 'image/png' });
  });

  it('sends text files with their MIME type', async () => {
    const fetchImpl = okRes();
    await uploadScreenshot('/out/DESIGN.md', { url: 'https://h/up', fetchImpl, openAsBlobImpl });
    await uploadScreenshot('/out/theme.css', { url: 'https://h/up', fetchImpl, openAsBlobImpl });
    expect(openAsBlobImpl).toHaveBeenCalledWith('/out/DESIGN.md', { type: 'text/markdown' });
    expect(openAsBlobImpl).toHaveBeenCalledWith('/out/theme.css', { type: 'text/css' });
    await uploadScreenshot('/out/manifest.json', { url: 'https://h/up', fetchImpl, openAsBlobImpl });
    expect(openAsBlobImpl).toHaveBeenCalledWith('/out/manifest.json', { type: 'application/json' });
  });

  it('defaults field to "file" and returns a URL from the response body', async () => {
    const fetchImpl = okRes('https://host/abc.png\n');
    const url = await uploadScreenshot('/tmp/a.png', { url: 'https://host/upload', fetchImpl, openAsBlobImpl });
    expect(url).toBe('https://host/abc.png');
    expect((fetchImpl.mock.calls[0][1].body as FormData).has('file')).toBe(true);
  });

  it('retries transient failures, then throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await expect(uploadScreenshot('/tmp/a.png', { url: 'https://s/up', fetchImpl, openAsBlobImpl, retryDelaysMs: [0, 0] }))
      .rejects.toThrow('HTTP 500');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a network error', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(new Response('https://host/x.png'));
    await expect(uploadScreenshot('/tmp/a.png', { url: 'https://s/up', fetchImpl, openAsBlobImpl, retryDelaysMs: [0] }))
      .resolves.toBe('https://host/x.png');
  });

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    await expect(uploadScreenshot('/tmp/a.png', { url: 'https://s/up', fetchImpl, openAsBlobImpl, retryDelaysMs: [0] }))
      .rejects.toThrow('HTTP 403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createUploader', () => {
  it('uploads in queue order in the background and reports each outcome', async () => {
    const order: string[] = [];
    const upload = vi.fn(async (dest: string) => {
      await new Promise(r => setTimeout(r, dest.includes('slow') ? 20 : 0));
      order.push(dest);
      if (dest.includes('bad')) throw new Error('HTTP 500');
      return 'https://h/up';
    });
    const lines: string[] = [];
    const u = createUploader(l => lines.push(l), upload);
    u.add('/out/slow.png');
    u.add('/out/fast.png');
    expect(order).toEqual([]); // add() does not block
    u.add('/out/bad.md');
    const r = await u.finish('Saved 3 files');
    expect(order).toEqual(['/out/slow.png', '/out/fast.png', '/out/bad.md']); // one after another, in order
    expect(lines).toEqual(['Uploaded slow.png: https://h/up', 'Uploaded fast.png: https://h/up', 'Upload error (/out/bad.md): HTTP 500']);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(['Saved 3 files', ...lines].join('\n'));
  });

  it('is a no-op without an upload URL', async () => {
    const u = createUploader(undefined, async () => null);
    u.add('/out/a.png');
    const r = await u.finish('Saved 1 files');
    expect(r).toEqual({ content: [{ type: 'text', text: 'Saved 1 files' }] });
  });
});
