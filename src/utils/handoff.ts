// ============================================================================
// manifest.json (machine-readable index of a capture) and AGENTS.md (how an
// agent should rebuild the site from it).
// ============================================================================

export interface ManifestPreset {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
}

export interface ManifestPage {
  url: string;
  /** Path + query, appended to a local base URL when comparing */
  path: string;
  prefix: string;
  /** preset name → screenshot file */
  screenshots: Record<string, string>;
  /** preset name → scroll offset (px) → viewport screenshot after scrolling that far */
  scrolled?: Record<string, Record<string, string>>;
  /** click state → screenshots after clicking (e.g. an open mobile menu), plus its scroll shots */
  states?: Record<string, { screenshots: Record<string, string>; scrolled?: Record<string, Record<string, string>> }>;
  html?: string;
  content?: string;
  /** The element cap was hit, so the HTML is incomplete (content JSON still has all text) */
  truncated?: boolean;
}

export interface Manifest {
  version: 1;
  source: string;
  capturedAt: string;
  fullPage: boolean;
  presets: ManifestPreset[];
  pages: ManifestPage[];
  files: { agents: string; design?: string; theme?: string; fonts?: string };
  /** original URL → local file */
  assets: Record<string, string>;
}

export const MANIFEST = 'manifest.json';

export function buildAgentsMd(m: Manifest): string {
  const design = !!m.files.design;
  const presetList = m.presets.map(p => `\`${p.name}\` (${p.width}×${p.height}${p.isMobile ? ', mobile' : ''})`).join(', ');
  const pageRows = m.pages.map(p =>
    `| ${p.url} | ${p.html ? `\`${p.html}\`${p.truncated ? ' (truncated)' : ''}` : '—'} | ${p.content ? `\`${p.content}\`` : '—'} | ${Object.values(p.screenshots).map(s => `\`${s}\``).join(' ')} |`);
  const fontsNote = m.files.fonts
    ? `- \`${m.files.fonts}\`: the site's \`@font-face\` rules, pointing at files in \`assets/\` where they were captured.`
    : '';

  return [
    `# Rebuild ${m.source}`,
    '',
    `Captured ${m.capturedAt.slice(0, 10)} from ${m.source}: ${m.pages.length} page(s) at ${m.presets.length} viewport(s): ${presetList}.`,
    'This folder is everything you need to re-implement the site locally. Only reproduce sites you own or have permission to copy; text, images and fonts carry their own licenses.',
    '',
    '## Files',
    '',
    ...(design ? [
      `- \`${m.files.design}\`: design system (colors, typography, spacing, radii, components, rules) in the DESIGN.md format. Treat its tokens as the source of truth.`,
      `- \`${m.files.theme}\`: the same tokens as a Tailwind v4 \`@theme\`. Import it instead of hand-writing colors and sizes.`,
    ] : []),
    ...(fontsNote ? [fontsNote] : []),
    `- \`assets/\`: ${Object.keys(m.assets).length} images, icons and fonts the original pages loaded. The page HTML already points at these.`,
    '- `<nn>-<page>.html`: reference structure per page with mobile-first Tailwind classes measured from the live site (`md:`, `xl:` … where layout changes). Opens standalone in a browser. Use it to understand layout; build clean components rather than copying it verbatim.',
    '- `<nn>-<page>.content.json`: the full text, heading outline, links, images and form fields of each page. Use this for copy, the HTML may abbreviate.',
    '- `<nn>-<page>-<preset>.png`: screenshots of the original, the visual target.',
    ...(m.pages.some(p => p.states) ? ['- `<nn>-<page>-<preset>-<state>.png` (and `…-<state>-scroll<N>.png`): the page after clicking an element, e.g. an open mobile menu. `manifest.json` lists them under `states`; rebuild these interactions too.'] : []),
    ...(m.pages.some(p => p.scrolled) ? ['- `<nn>-<page>-<preset>-scroll<N>.png`: the same viewport after scrolling N px down. Compare with the unscrolled shot for scroll effects such as a shrinking or sticky header.'] : []),
    `- \`${MANIFEST}\`: machine-readable index of all of the above.`,
    '',
    '## Pages',
    '',
    '| URL | Structure | Content | Screenshots |',
    '|---|---|---|---|',
    ...pageRows,
    '',
    '## Suggested workflow',
    '',
    '1. Set up a project with Tailwind CSS v4, copy `assets/`' + (design ? ` and import \`${m.files.theme}\`` : '') + '.',
    '2. Build the shared layout first (header, navigation, footer appear on several pages), then each page. Take text from the `.content.json` files.',
    '3. Start your dev server and compare with the MCP tool `compare_screenshots`:',
    '',
    '   ```json',
    `   { "captureDir": "<this folder>", "baseUrl": "http://localhost:3000" }`,
    '   ```',
    '',
    '   It screenshots your build at the same viewports and paths, and reports per page and viewport how many pixels differ, which vertical bands differ most, and writes diff images to `compare/`. The MCP server needs `ALLOW_LOCAL=true` to open localhost.',
    '4. Fix the worst page/viewport first and repeat until the mismatch is small. Some difference is expected from dynamic content and font rendering.',
    '',
    '## Not captured',
    '',
    '- Hover, focus and active states, transitions and animations.',
    '- JavaScript behavior (menus, tabs, dialogs, carousels) beyond the default state shown in the screenshots.',
    '- Content generated by CSS `::before`/`::after`.',
    '- Data loaded after the page settled, and anything behind a login.',
    '',
  ].join('\n');
}
