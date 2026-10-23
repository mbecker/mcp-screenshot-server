#!/usr/bin/env node
// Command-line front end for take_page_screenshots. Calls the tool through the
// real MCP server (in-memory transport), so it behaves exactly like an MCP client.
// Requires a build: npm run build
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../build/server.js';
import { DEVICE_PRESET_NAMES } from '../build/config/device-presets.js';

const HELP = `Usage: capture.mjs --url <url> [options]

  --url <url>          Page to capture (or pass it as the first argument)
  --presets <list>     Comma-separated, default: all
                       (${DEVICE_PRESET_NAMES.join(', ')})
  --depth <n>          Same-origin link levels to follow, 0-5 (default 0)
  --max-pages <n>      Maximum pages, 1-100 (default 20)
  --full-page          Capture the full scrollable page instead of the viewport
  --wait <ms>          Extra delay after each load, 0-30000
  --scroll <px>        Extra screenshot after scrolling down <px>, e.g. 100 (repeatable)
  --click <n>=<sel>    Extra screenshots after clicking <sel>, named after <n>, e.g.
                       --click 'menu=button:has([data-icon="menu"])' (repeatable)
  --no-design          Screenshots only, skip the rebuild package
  --cookie-banner <m>  accept (default), reject or keep cookie/consent banners
  --remove <selector>  Delete matching elements before screenshots, e.g. '[role="alert"]'
                       (repeat for several)
  -h, --help           Show this help

Environment: SCREENSHOT_OUTPUT_DIR (relative to $HOME), ALLOW_LOCAL,
SCREENSHOT_UPLOAD_URL, SCREENSHOT_UPLOAD_FIELD, SCREENSHOT_UPLOAD_HEADERS`;

let opts;
try {
  opts = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      presets: { type: 'string' },
      depth: { type: 'string' },
      'max-pages': { type: 'string' },
      'full-page': { type: 'boolean' },
      wait: { type: 'string' },
      scroll: { type: 'string', multiple: true },
      click: { type: 'string', multiple: true },
      'no-design': { type: 'boolean' },
      'cookie-banner': { type: 'string' },
      remove: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}
const { values: v, positionals } = opts;
const url = v.url ?? positionals[0];
if (v.help || !url) {
  console.log(HELP);
  process.exit(v.help ? 0 : 2);
}

// Only pass what was given; the tool's schema validates ranges and preset names
const num = (s) => (s === undefined ? undefined : Number(s));
const args = Object.fromEntries(Object.entries({
  url,
  presets: v.presets?.split(',').map(p => p.trim()).filter(Boolean),
  depth: num(v.depth),
  maxPages: num(v['max-pages']),
  fullPage: v['full-page'],
  waitForTimeout: num(v.wait),
  scrollOffsets: v.scroll?.map(Number),
  // name=selector; the selector itself may contain "="
  clickStates: v.click?.map(c => ({ name: c.slice(0, c.indexOf('=')), selector: c.slice(c.indexOf('=') + 1) })),
  extractDesign: v['no-design'] ? false : undefined,
  cookieBanner: v['cookie-banner'],
  removeSelectors: v.remove,
}).filter(([, val]) => val !== undefined));

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: 'capture-cli', version: '1.0.0' });
await server.connect(serverTransport);
await client.connect(clientTransport);

console.error(`Capturing ${url} ${JSON.stringify(args)}`);
let result;
try {
  // Crawls can take hours: no total limit, only fail after 10 min without a progress notification
  result = await client.callTool({ name: 'take_page_screenshots', arguments: args }, {
    timeout: 10 * 60 * 1000, resetTimeoutOnProgress: true, onprogress: () => {},
  });
} finally {
  await client.close();
  await server.close();
}
for (const c of result.content) if (c.type === 'text') console.log(c.text);
process.exit(result.isError ? 1 : 0);
