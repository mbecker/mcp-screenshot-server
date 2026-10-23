# Universal Screenshot MCP

[![npm version](https://img.shields.io/npm/v/universal-screenshot-mcp.svg)](https://www.npmjs.com/package/universal-screenshot-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.sethbang%2Fscreenshot--server-blue)](https://registry.modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that provides AI assistants with screenshot capabilities — both web page capture via [Puppeteer](https://pptr.dev/) and cross-platform system screenshots using native OS tools.

## Features

- **Web Page Screenshots** — Capture any public URL using a headless Chromium browser
- **Cross-Platform System Screenshots** — Fullscreen, window, or region capture using native OS tools (macOS `screencapture`, Linux `maim`/`scrot`/`gnome-screenshot`/etc., Windows PowerShell+.NET)
- **Security-First Design** — SSRF prevention, path traversal protection, DNS rebinding defense, command injection prevention, and DoS limiting
- **MCP Native** — Integrates directly with Claude Desktop, Cursor, and any MCP-compatible client

## Requirements

- **Node.js** >= 18.0.0
- **Chromium** is downloaded automatically by Puppeteer on first run

### Platform-Specific Requirements for `take_system_screenshot`

| Platform | Required Tools | Notes |
|----------|---------------|-------|
| **macOS** | `screencapture` (built-in) | No additional installation needed |
| **Linux** | One of: `maim`, `scrot`, `gnome-screenshot`, `spectacle`, `grim`, or `import` (ImageMagick) | `maim` or `scrot` recommended for full feature support. For window-by-name capture, also install `xdotool`. |
| **Windows** | `powershell` (built-in) | Uses .NET `System.Drawing` — no additional installation needed |

#### Linux Installation Examples

```bash
# Ubuntu/Debian (recommended)
sudo apt install maim xdotool

# Fedora
sudo dnf install maim xdotool

# Arch Linux
sudo pacman -S maim xdotool

# Wayland (Sway, etc.)
sudo apt install grim
```

After installing, you can verify your setup with:

```bash
npx universal-screenshot-mcp --doctor
```

This probes the host and prints copy-pasteable install commands for any missing tools, tailored to your detected distro.

## Quick Start

### Install from npm

```bash
npm install -g universal-screenshot-mcp
```

Or run directly with `npx`:

```bash
npx universal-screenshot-mcp
```

### Install from Source

```bash
git clone https://github.com/sethbang/mcp-screenshot-server.git
cd mcp-screenshot-server
npm install
npm run build
```

### Configure Your MCP Client

Add the server to your MCP client configuration. For **Claude Desktop**, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "screenshot-server": {
      "command": "npx",
      "args": ["-y", "universal-screenshot-mcp"]
    }
  }
}
```

Or if installed from source:

```json
{
  "mcpServers": {
    "screenshot-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-screenshot-server/build/index.js"]
    }
  }
}
```

For **Claude Code**, register the server with the `claude mcp add` command:

```bash
# Project scope (current directory only)
claude mcp add screenshot-server -- npx -y universal-screenshot-mcp

# User scope (available across all projects)
claude mcp add --scope user screenshot-server -- npx -y universal-screenshot-mcp
```

Or if installed from source:

```bash
claude mcp add screenshot-server -- node /absolute/path/to/mcp-screenshot-server/build/index.js
```

Verify the server registered with `claude mcp list`, or check live status from inside a session with `/mcp`.

For **Cursor** or other MCP clients, consult their documentation for the equivalent configuration.

## Tools

The server exposes four MCP tools:

### `take_screenshot`

Captures a web page (or a specific element) via a headless Puppeteer browser.

| Parameter         | Type    | Required | Description                                      |
|-------------------|---------|----------|--------------------------------------------------|
| `url`             | string  | ✅       | URL to capture (http/https only)                 |
| `width`           | number  | —        | Viewport width (1–3840)                          |
| `height`          | number  | —        | Viewport height (1–2160)                         |
| `fullPage`        | boolean | —        | Capture the full scrollable page                 |
| `selector`        | string  | —        | CSS selector to capture a specific element        |
| `waitForSelector` | string  | —        | Wait for this selector before capturing          |
| `waitForTimeout`  | number  | —        | Delay in milliseconds (0–30000)                  |
| `outputPath`      | string  | —        | Output file path (default: `~/Documents/screenshots`) |

**Example prompt:**
> Take a screenshot of https://example.com at 1920x1080

### `take_page_screenshots`

Captures a web page and its sub-pages on several device presets. Starting from `url`, it follows links to the same origin breadth-first up to `depth` levels, capped at `maxPages`, and screenshots every page on every preset. Files go into a new `page-<host>-<timestamp>/` folder in the output directory, named `<nn>-<path>-<preset>.png` (e.g. `01-docs-iphone-17.png`).

| Preset        | Viewport (CSS px) | Scale |
|---------------|-------------------|-------|
| `iphone-17`   | 402 × 874         | 3×    |
| `galaxy-s24`  | 360 × 780         | 3×    |
| `ipad-pro-11` | 834 × 1210        | 2×    |
| `laptop`      | 1440 × 900        | 1×    |
| `desktop`     | 1920 × 1080       | 1×    |

Mobile presets also set touch, mobile mode and a matching user agent. Presets live in `src/config/device-presets.ts`.

| Parameter        | Type     | Required | Description                                          |
|------------------|----------|----------|------------------------------------------------------|
| `url`            | string   | ✅       | URL to capture (http/https only)                     |
| `presets`        | string[] | —        | Presets to capture (default: all)                    |
| `depth`          | number   | —        | Link levels to follow (0–5, default 0 = only `url`)  |
| `maxPages`       | number   | —        | Maximum pages to capture (1–100, default 20)         |
| `fullPage`       | boolean  | —        | Capture the full scrollable page, top to bottom; lazy-loaded content is loaded first |
| `scrollOffsets`  | number[] | —        | Extra viewport screenshots after scrolling down by each value (px), named `…-scroll<N>.png`, e.g. `[100]` for a header that shrinks on scroll |
| `clickStates`    | object[] | —        | `[{ "name": "menu", "selector": "button:has([data-icon=\"menu\"])" }]`: per preset, reload, click the element and take extra screenshots (plus scroll shots), named `…-<name>.png`; skipped where the element is not visible |
| `extractDesign`  | boolean  | —        | Write the design files below (default `true`)          |
| `cookieBanner`   | string   | —        | `accept` (default) or `reject` cookie/consent banners before each screenshot, or `keep` them |
| `removeSelectors` | string[] | —       | CSS selectors of elements to delete before each screenshot and extraction, e.g. `["[role=\"alert\"]", ".promo"]` |
| `waitForTimeout` | number   | —        | Delay in ms after each load, before the screenshot   |

**Cookie banners.** Before each screenshot the tool clicks "accept all" (or, with `cookieBanner: "reject"`, the reject / necessary-only button) on consent banners: known platforms (OneTrust, Cookiebot, Usercentrics, Didomi, consentmanager, TrustArc, Google) by selector, others by button text in DE/EN/FR/ES/IT/NL. It searches shadow DOM and iframes, and only clicks buttons inside an element that is about cookies or privacy. Consent persists for the run, so only the first page waits (up to 4 s) for a banner. The result reports which button was clicked.

Other overlays (notice bars, promos, chat widgets) can be removed with `removeSelectors`: matching elements are deleted in every frame and open shadow root before each screenshot, and again before the structure is collected, so they stay out of the rebuild HTML as well.

**Rebuild package.** With `extractDesign` (default), the capture folder becomes everything an AI agent needs to re-implement the site locally. For every page the tool reads the rendered DOM at each chosen preset and writes, next to the screenshots:

| File | Contents |
|------|----------|
| `DESIGN.md` | Design system in the [DESIGN.md format](https://github.com/google-labs-code/design.md): YAML tokens (`colors`, `typography`, `rounded`, `spacing`, `components`) plus Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts, and a list of pages |
| `theme.css` | The same tokens as a Tailwind v4 `@theme` (`bg-primary`, `text-headline-lg`, `rounded-md`, …) |
| `fonts.css` | The site's `@font-face` rules, pointing at the font files in `assets/` |
| `assets/` | Every image, icon and font the pages loaded (lazy content is triggered before collecting), referenced by the page HTML |
| `<nn>-<path>.html` | Standalone page with the simplified HTML structure and mobile-first Tailwind classes derived from computed styles, using the theme tokens. Where the layout differs between presets it gets `sm:`/`md:`/`lg:`/`xl:`/`2xl:` variants (e.g. `hidden md:flex`, `flex-col md:flex-row`). Open it in a browser and resize to compare with the screenshots |

| `<nn>-<path>.content.json` | Full text, meta/Open Graph tags, heading outline, links, images (with local copies) and form fields |
| `manifest.json` | Machine-readable index: presets, pages, screenshots, assets |
| `AGENTS.md` | Build guide for the agent: what each file is for, suggested order, how to verify with `compare_screenshots` |

Values are measured from computed styles; token names and prose are heuristics, so review them. Responsive variants use Tailwind's default breakpoints and are exact at the captured widths; the narrowest preset is the unprefixed base. Pseudo-elements (`::before`/`::after`) and self-hosted web fonts are not reproduced. Check a result with `npx @google/design.md lint DESIGN.md`.

**Example prompt:**
> Screenshot https://example.com and the pages it links to on iPhone 17 and desktop, and extract the design

### `compare_screenshots`

Checks a local re-implementation against a capture. It screenshots every captured page path on `baseUrl` with the same presets, pixel-diffs against the originals and reports the mismatch per page and preset (worst first), which vertical bands differ most, and writes `compare/*-actual.png`, `compare/*-diff.png` (differences in red) and `compare/report.json` into the capture folder.

| Parameter    | Type     | Required | Description |
|--------------|----------|----------|-------------|
| `captureDir` | string   | ✅       | Folder written by `take_page_screenshots` (absolute, or relative to the output directory) |
| `baseUrl`    | string   | ✅       | Base URL of the local build, e.g. `http://localhost:3000` |
| `pages`      | string[] | —        | Only these page prefixes or paths |
| `presets`    | string[] | —        | Only these presets |

Comparing against `localhost` requires the server to run with `ALLOW_LOCAL=true`.

**Example prompt:**
> Compare my local build at http://localhost:3000 with the capture in page-example.com-2026-10-23T09-00-00-000Z

### `take_system_screenshot`

Captures the desktop, a specific application window, or a screen region using native OS tools. Works on **macOS**, **Linux**, and **Windows**.

| Parameter       | Type    | Required | Description                                              |
|-----------------|---------|----------|----------------------------------------------------------|
| `mode`          | enum    | ✅       | `fullscreen`, `window`, or `region`                      |
| `windowId`      | number  | —        | Window ID for window mode                                |
| `windowName`    | string  | —        | App name (e.g. `"Safari"`, `"Firefox"`) for window mode  |
| `region`        | object  | —        | `{ x, y, width, height }` for region mode                |
| `display`       | number  | —        | Display number for multi-monitor setups                  |
| `includeCursor` | boolean | —        | Include the mouse cursor in the capture                  |
| `format`        | enum    | —        | `png` (default) or `jpg`                                 |
| `delay`         | number  | —        | Capture delay in seconds (0–10)                          |
| `outputPath`    | string  | —        | Output file path (default: `~/Documents/screenshots`)    |

#### Cross-Platform Feature Support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Fullscreen | ✅ | ✅ | ✅ |
| Region | ✅ | ✅ (maim, scrot, grim, import) | ✅ |
| Window by name | ✅ | ⚠️ X11 + xdotool | ⚠️ best-effort |
| Window by ID | ✅ | ✅ X11 only | ⚠️ HWND |
| Multi-display | ✅ | ⚠️ tool-dependent | ✅ |
| Include cursor | ✅ | ⚠️ tool-dependent | ⚠️ |
| Delay | ✅ | ✅ | ✅ |

**Example prompt:**
> Take a system screenshot of the Safari window

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCREENSHOT_OUTPUT_DIR` | `Documents/screenshots` | Default output directory relative to `~` |
| `ALLOW_LOCAL` | `false` | Set to `true` to allow screenshotting `localhost`/`127.x.x.x`/`[::1]` (useful for local dev servers) |
| `SCREENSHOT_UPLOAD_URL` | — | If set, every saved screenshot is also POSTed as `multipart/form-data` to this URL. |
| `SCREENSHOT_UPLOAD_FIELD` | `file` | Multipart field name for the file |
| `SCREENSHOT_UPLOAD_HEADERS` | — | JSON object of extra headers, e.g. `{"Authorization":"Bearer …"}` |

### Uploading Screenshots

Any endpoint that accepts a multipart file upload works. Every file a tool saves is uploaded, one request per file with its MIME type: screenshots and, for `take_page_screenshots`, also `DESIGN.md`, `theme.css` and the page `.html` files. If the response body is a bare URL (as many file hosts return), it is reported back; otherwise the endpoint URL is. Network errors, timeouts, 429 and 5xx responses are retried 3 times (after 1, 5 and 15 s) before a file is reported as failed.

```json
"env": {
  "SCREENSHOT_UPLOAD_URL": "https://files.example.com/upload",
  "SCREENSHOT_UPLOAD_FIELD": "files"
}
```

### Output Directories

Screenshots are saved to `~/Documents/screenshots` by default (configurable via `SCREENSHOT_OUTPUT_DIR`). Custom output paths must resolve to one of these allowed directories:

| Directory              | Description              |
|------------------------|--------------------------|
| `~/Documents/screenshots` | Default output location (configurable) |
| `~/Desktop/Screenshots`| Original default location |
| `~/Downloads`          | User downloads folder    |
| `~/Documents`          | User documents folder    |
| `/tmp`                 | System temp directory    |

## Security

This server implements multiple layers of security hardening:

| ID      | Threat                | Mitigation                                                                                  |
|---------|-----------------------|---------------------------------------------------------------------------------------------|
| SEC-001 | SSRF / DNS rebinding  | URLs validated against blocked IP ranges; DNS resolved pre-request with IP pinning via `--host-resolver-rules`; navigation redirects re-validated |
| SEC-003 | Command injection     | All subprocesses use `execFile` (no shell); app names validated against `SAFE_APP_NAME_PATTERN` |
| SEC-004 | Path traversal        | Output paths validated with `fs.realpath()` symlink resolution; restricted to allowed directories |
| SEC-005 | Denial of service     | Concurrent Puppeteer instances limited to 3 via semaphore                                   |

For full details, see [`docs/security.md`](docs/security.md).

## Development

### Scripts

| Command              | Description                            |
|----------------------|----------------------------------------|
| `npm run build`      | Compile TypeScript to `build/`         |
| `npm run watch`      | Recompile on file changes              |
| `npm test`           | Unit tests (fast, fully mocked)        |
| `npm run test:integration` | Integration tests (real DNS/filesystem) |
| `npm run test:e2e`   | E2E tests (real Puppeteer/native tools)|
| `npm run test:all`   | All test tiers together                |
| `npm run test:linux` | Linux e2e via Docker (requires Docker) |
| `npm run test:capture -- --url <url> …` | Capture a site in Docker into `./captures` (see below) |
| `npm run test:watch` | Run tests in watch mode                |
| `npm run test:coverage` | Run tests with coverage report      |
| `npm run lint`       | Lint source with ESLint                |
| `npm run inspector`  | Launch MCP Inspector for debugging     |

### Project Structure

```
src/
├── index.ts                 # Entry point — stdio transport
├── server.ts                # MCP server factory
├── config/
│   ├── index.ts             # Static constants (limits, allowed dirs)
│   └── runtime.ts           # Singleton semaphore, default directory
├── tools/
│   ├── take-screenshot.ts   # Web page capture tool
│   └── take-system-screenshot.ts  # macOS system capture tool
├── types/
│   └── index.ts             # Shared TypeScript interfaces
├── utils/
│   ├── helpers.ts           # Response builders, file utilities
│   ├── screenshot-provider.ts # Cross-platform provider interface + factory
│   ├── macos-provider.ts    # macOS: screencapture wrapper
│   ├── linux-provider.ts    # Linux: maim/scrot/gnome-screenshot/etc.
│   ├── windows-provider.ts  # Windows: PowerShell + .NET System.Drawing
│   ├── macos.ts             # Window ID lookup via CoreGraphics
│   └── semaphore.ts         # Async concurrency limiter
└── validators/
    ├── path.ts              # Output path validation (SEC-004)
    └── url.ts               # URL/SSRF validation (SEC-001)
```

### Testing

Tests use [Vitest](https://vitest.dev/) in three tiers:

- **Unit** (`npm test`) — Full dependency injection, no real I/O. Fast feedback loop.
- **Integration** (`npm run test:integration`) — Real DNS resolution, real filesystem with temp directories, real Puppeteer against a local HTTP server.
- **E2E** (`npm run test:e2e`) — Real native screenshot tools. macOS tests run natively; Linux tests run in Docker via `npm run test:linux`.

```bash
npm test                 # Unit tests (~300ms)
npm run test:linux       # Linux provider tests in Docker
npm run test:all         # Everything
```

### Capturing a Site from the Command Line

`npm run test:capture` builds a Docker image (`Dockerfile.capture`, Chromium included) and runs `take_page_screenshots` for a URL. Results land in a local folder:

```bash
npm run test:capture -- --url https://example.com
npm run test:capture -- --url https://example.com --presets iphone-17,desktop --depth 1 --max-pages 5
npm run test:capture -- --url https://example.com --out ~/captures --full-page --no-design
```

| Option | Description |
|--------|-------------|
| `--url <url>` | Page to capture |
| `--presets <list>` | Comma-separated presets (default: all) |
| `--depth <n>` / `--max-pages <n>` | Follow same-origin links |
| `--full-page` | Whole page top to bottom instead of the first screen |
| `--wait <ms>` | Extra delay after each load |
| `--scroll <px>` | Extra screenshot after scrolling down `<px>` (repeatable), e.g. `--scroll 100` |
| `--click <name>=<selector>` | Extra screenshots after clicking, e.g. `--click 'menu=button:has([data-icon="menu"])'` (repeatable) |
| `--no-design` | Screenshots only, no rebuild package |
| `--cookie-banner <m>` | `accept` (default), `reject` or `keep` cookie banners |
| `--remove <selector>` | Delete matching elements before screenshots, e.g. `--remove '[role="alert"]'` (repeatable) |
| `--out <dir>` | Host folder for results (default `./captures`) |
| `--no-build` | Reuse the existing image |

`SCREENSHOT_UPLOAD_*` and `ALLOW_LOCAL` are passed into the container when set. Files are written as your user. Without Docker, `npm run build && node scripts/capture.mjs --url …` does the same on the host (output in `~/Documents/screenshots`).

### Debugging with MCP Inspector

```bash
npm run inspector
```

This launches the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) connected to your built server, allowing you to invoke tools interactively.

## License

[Apache-2.0](LICENSE) — Copyright 2026 Seth Bang
