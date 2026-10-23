import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { registerTakeScreenshot } from './tools/take-screenshot.js';
import { registerTakeSystemScreenshot } from './tools/take-system-screenshot.js';
import { registerTakePageScreenshots } from './tools/take-page-screenshots.js';
import { registerCompareScreenshots } from './tools/compare-screenshots.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: 'screenshot-server', version });
  registerTakeScreenshot(server);
  registerTakeSystemScreenshot(server);
  registerTakePageScreenshots(server);
  registerCompareScreenshots(server);
  return server;
}
