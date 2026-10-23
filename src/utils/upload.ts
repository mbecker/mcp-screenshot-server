// ============================================================================
// Generic HTTP multipart upload of saved screenshots
// ============================================================================

import { openAsBlob } from 'fs';
import { basename, extname } from 'path';
import { ok, err } from './helpers.js';
import type { McpToolResponse } from '../types/index.js';

export interface UploadOptions {
  /** Upload endpoint. Defaults to SCREENSHOT_UPLOAD_URL. */
  url?: string;
  /** Multipart field name for the file. Defaults to SCREENSHOT_UPLOAD_FIELD, then `file`. */
  field?: string;
  /** JSON object of extra request headers (e.g. auth). Defaults to SCREENSHOT_UPLOAD_HEADERS. */
  headers?: string;
  fetchImpl?: typeof fetch;
  openAsBlobImpl?: (path: string, options?: { type?: string }) => Promise<Blob>;
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.md': 'text/markdown', '.css': 'text/css', '.html': 'text/html',
};

/**
 * POST a file as multipart/form-data to the configured endpoint.
 * Returns null when no upload URL is configured. On success returns the
 * response body if it is a bare URL (common for file hosts), else the endpoint.
 * Throws on HTTP or I/O failure.
 */
export async function uploadScreenshot(
  filePath: string,
  {
    url = process.env.SCREENSHOT_UPLOAD_URL,
    field = process.env.SCREENSHOT_UPLOAD_FIELD || 'file',
    headers = process.env.SCREENSHOT_UPLOAD_HEADERS,
    fetchImpl = fetch,
    openAsBlobImpl = openAsBlob,
  }: UploadOptions = {}
): Promise<string | null> {
  if (!url) return null;

  const fd = new FormData();
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  fd.append(field, await openAsBlobImpl(filePath, { type }), basename(filePath));

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: headers ? JSON.parse(headers) : undefined,
    body: fd,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  const body = (await res.text()).trim();
  return /^https?:\/\/\S+$/.test(body) ? body : url;
}

/** Upload the saved files if configured and append each outcome to the message. */
export async function withUpload(msg: string, dests: string[]): Promise<McpToolResponse> {
  const lines = [msg];
  let failed = false;
  for (const dest of dests) {
    try {
      const url = await uploadScreenshot(dest);
      if (url) lines.push(`Uploaded ${basename(dest)}: ${url}`);
    } catch (e) {
      failed = true;
      lines.push(`Upload error (${dest}): ${e instanceof Error ? e.message : e}`);
    }
  }
  return failed ? err(lines.join('\n')) : ok(lines.join('\n'));
}
