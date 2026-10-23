import { describe, it, expect, vi } from 'vitest';
import { uploadScreenshot } from '../../src/utils/upload.js';

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

  it('throws on HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await expect(uploadScreenshot('/tmp/a.png', { url: 'https://s/up', fetchImpl, openAsBlobImpl })).rejects.toThrow('HTTP 500');
  });
});
