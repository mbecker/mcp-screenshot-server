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
  /** Waits before each retry of a transient failure (network error, 429, 5xx). */
  retryDelaysMs?: number[];
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.md': 'text/markdown', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
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
    retryDelaysMs = [1000, 5000, 15000],
  }: UploadOptions = {}
): Promise<string | null> {
  if (!url) return null;

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = new FormData();
      fd.append(field, await openAsBlobImpl(filePath, { type }), basename(filePath));
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: headers ? JSON.parse(headers) : undefined,
        body: fd,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw Object.assign(new Error(`Upload failed: HTTP ${res.status}`), { status: res.status });
      const body = (await res.text()).trim();
      return /^https?:\/\/\S+$/.test(body) ? body : url;
    } catch (e) {
      // Network errors ("fetch failed", timeouts), 429 and 5xx are transient; other 4xx and bad headers JSON are not
      const status = (e as { status?: number }).status;
      const transient = status === undefined ? !(e instanceof SyntaxError) : status === 429 || status >= 500;
      if (!transient || attempt >= retryDelaysMs.length) throw e;
      await new Promise(r => setTimeout(r, retryDelaysMs[attempt]));
    }
  }
}

export interface Uploader {
  /** Queue a saved file; uploads run one after another in the background. */
  add(dest: string): void;
  /** Wait for queued uploads and append each outcome to the message (error if any failed). */
  finish(msg: string): Promise<McpToolResponse>;
}

/**
 * Upload files as soon as they exist instead of all at the end, so long captures
 * show results early and a run that dies halfway keeps what it already sent.
 * `onLine` receives each outcome as it happens (e.g. for progress output).
 */
export function createUploader(onLine?: (line: string) => void, upload = uploadScreenshot): Uploader {
  const lines: string[] = [];
  let failed = false;
  let chain = Promise.resolve();
  const record = (line: string) => { lines.push(line); onLine?.(line); };
  return {
    add(dest) {
      chain = chain.then(async () => {
        try {
          const url = await upload(dest);
          if (url) record(`Uploaded ${basename(dest)}: ${url}`);
        } catch (e) {
          failed = true;
          record(`Upload error (${dest}): ${e instanceof Error ? e.message : e}`);
        }
      });
    },
    async finish(msg) {
      await chain;
      const text = [msg, ...lines].join('\n');
      return failed ? err(text) : ok(text);
    },
  };
}

/** Upload the saved files if configured and append each outcome to the message. */
export async function withUpload(msg: string, dests: string[]): Promise<McpToolResponse> {
  const uploader = createUploader();
  dests.forEach(d => uploader.add(d));
  return uploader.finish(msg);
}
