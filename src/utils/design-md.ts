// ============================================================================
// Turn collected page styles into DESIGN.md (google-labs-code/design.md spec,
// version alpha), a Tailwind v4 @theme, and standalone per-page HTML.
// ============================================================================

import type { Counts, DomNode, RawStyles } from './design-collect.js';
import { renderResponsive } from './design-html.js';

export interface CapturedPage {
  url: string;
  /** Styles measured at the widest captured preset */
  styles: RawStyles;
  /** The page's DOM at each captured viewport width */
  trees: { width: number; tree: DomNode | null }[];
  /** File prefix shared by this page's screenshots and HTML, e.g. 01-docs. */
  prefix: string;
  screenshots: string[];
}

export interface DesignOutput {
  designMd: string;
  themeCss: string;
  /** prefix → standalone HTML document */
  htmlDocs: Record<string, string>;
}

interface Typo { fontFamily: string; fontSize: string; fontWeight: number; lineHeight?: number; letterSpacing?: string }

const TAILWIND_BROWSER = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3';

// ---------------------------------------------------------------- helpers

const merge = (all: Counts[]): Counts => {
  const out: Counts = {};
  for (const c of all) for (const [k, v] of Object.entries(c)) out[k] = (out[k] || 0) + v;
  return out;
};
const ranked = (c: Counts): string[] => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k]) => k);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const saturation = (h: string) => {
  const [r, g, b] = rgb(h);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
};
const luminance = (h: string) => {
  const [r, g, b] = rgb(h).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const isOpaque = (h: string) => h.length === 7;
/** Composite a #rrggbbaa color over an opaque background → what the eye sees. */
export const flatten = (h: string, over: string) => {
  if (isOpaque(h)) return h;
  const a = parseInt(h.slice(7, 9), 16) / 255;
  const [f, b] = [rgb(h), rgb(over)];
  return '#' + f.map((v, i) => Math.round((v * a + b[i] * (1 - a)) * 255).toString(16).padStart(2, '0')).join('');
};
const flattenCounts = (c: Counts, over: string): Counts => merge(Object.entries(c).map(([k, v]) => ({ [flatten(k, over)]: v })));
const isAccent = (h: string) => isOpaque(h) && saturation(h) > 0.3 && luminance(h) > 0.02 && luminance(h) < 0.85;

const yamlStr = (v: string | number) => (typeof v === 'number' || /^[\w .-]+$/.test(v) && !/^[\d.]+$/.test(v) ? String(v) : JSON.stringify(v));

// ---------------------------------------------------------------- tokens

/** Pick role-named colors, then fill up with the most used remaining colors. */
function pickColors(s: RawStyles[], buttons: string[], surface: string): Record<string, string> {
  const text = flattenCounts(merge(s.map(p => p.textColors)), surface);
  const bg = flattenCounts(merge(s.map(p => p.bgColors)), surface);
  const border = flattenCounts(merge(s.map(p => p.borderColors)), surface);
  const vars = Object.assign({}, ...s.map(p => p.colorVars)) as Record<string, string>;
  const colors: Record<string, string> = {};
  const used = new Set<string>();
  const put = (name: string, hex?: string | null, allowDuplicate = false) => {
    if (hex && (allowDuplicate || !used.has(hex)) && !colors[name]) { colors[name] = hex; used.add(hex); }
  };

  const buttonBgs = buttons.map(b => JSON.parse(b).backgroundColor as string | null)
    .filter((h): h is string => !!h && isOpaque(h) && h !== surface);
  const accents = [...buttonBgs.filter(isAccent), ...ranked(merge([text, bg, border])).filter(isAccent)];

  // The main call-to-action defines primary; saturated accents fill secondary/tertiary
  put('primary', buttonBgs[0] || accents[0] || ranked(text)[0]);
  for (const name of ['secondary', 'tertiary']) put(name, accents.find(h => !used.has(h)));
  put('surface', surface);
  put('on-surface', ranked(text).find(h => !used.has(h)));
  const primaryButton = buttons.map(b => JSON.parse(b)).find(b => b.backgroundColor === colors.primary);
  put('on-primary', primaryButton && flatten(primaryButton.textColor, surface), true);
  put('outline', ranked(border).find(h => !used.has(h)));

  // Remaining frequent colors, named after the site's own CSS variables where possible
  const rest = [...ranked(text).slice(0, 6), ...ranked(bg).slice(0, 6), ...ranked(border).slice(0, 3)];
  let n = 1;
  for (const h of rest) {
    if (used.has(h)) continue;
    const name = vars[h] ? slug(vars[h].replace(/^--(color-)?/, '')) : `${isAccent(h) ? 'accent' : 'neutral'}-${n++}`;
    put(name, h);
  }
  return colors;
}

function pickTypography(s: RawStyles[]): Record<string, Typo> {
  const ROLES: [string, string][] = [
    ['h1', 'headline-display'], ['h2', 'headline-lg'], ['h3', 'headline-md'], ['h4', 'headline-sm'],
    ['body', 'body-md'], ['small', 'body-sm'], ['button', 'label-md'], ['link', 'label-link'],
  ];
  const out: Record<string, Typo> = {};
  const seen = new Set<string>();
  for (const [role, name] of ROLES) {
    const top = ranked(merge(s.map(p => p.typography[role] || {})))[0];
    if (!top || seen.has(top)) continue;
    seen.add(top);
    const [fontFamily, size, weight, lh, ls] = top.split('|');
    out[name] = { fontFamily, fontSize: `${size}px`, fontWeight: Number(weight) };
    if (lh) out[name].lineHeight = Number(lh);
    if (ls) out[name].letterSpacing = ls;
  }
  return out;
}

/** Most frequent values, re-sorted by size and named along a t-shirt scale. */
function scale(c: Counts, names: string[], max: number): Record<string, string> {
  const top = ranked(c).slice(0, max).sort((a, b) => parseFloat(a) - parseFloat(b));
  return Object.fromEntries(top.map((v, i) => [names[i], v]));
}

// ---------------------------------------------------------------- output

export interface DesignOptions {
  date?: Date;
  /** A fonts.css with the site's @font-face rules sits next to the output */
  fontsCss?: boolean;
}

export function buildDesign(pages: CapturedPage[], startUrl: string, { date = new Date(), fontsCss = false }: DesignOptions = {}): DesignOutput {
  const s = pages.map(p => p.styles);
  const surface = flatten(ranked(merge(s.map(p => ({ [p.pageBg]: 1 }))))[0], '#ffffff');
  // Solid buttons first: translucent ones are ghost/chip styles, not the main CTA
  const solid = (b: string) => { const bg = JSON.parse(b).backgroundColor; return bg && isOpaque(bg) && bg !== surface ? 0 : 1; };
  const buttons = ranked(merge(s.map(p => p.components.button || {}))).sort((a, b) => solid(a) - solid(b));
  const inputs = ranked(merge(s.map(p => p.components.input || {})));
  const colors = pickColors(s, buttons, surface);
  const typography = pickTypography(s);

  const radii = merge(s.map(p => p.radii));
  const full = Object.keys(radii).some(r => parseFloat(r) >= 999);
  for (const r of Object.keys(radii)) if (parseFloat(r) >= 999) delete radii[r];
  const rounded: Record<string, string> = { ...scale(radii, ['sm', 'md', 'lg', 'xl', '2xl'], 5), ...(full ? { full: '9999px' } : {}) };
  const spacing = scale(merge(s.map(p => p.spacing)), ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'], 8);
  const container = ranked(merge(s.map(p => p.maxWidths))).find(w => parseFloat(w) >= 600);
  if (container) spacing.container = container;
  const shadows = ranked(merge(s.map(p => p.shadows))).slice(0, 4);
  const breakpoints = ranked(merge(s.map(p => p.breakpoints))).slice(0, 5).map(Number).sort((a, b) => a - b);
  const fonts = ranked(merge(s.map(p => p.fonts))).slice(0, 4);
  const fontLinks = [...new Set(s.flatMap(p => p.fontLinks))];

  const ref = (group: Record<string, string>, groupName: string, v?: string | null, prefer?: string) => {
    const k = prefer && group[prefer] === v ? prefer : Object.keys(group).find(k => group[k] === v);
    return k ? `{${groupName}.${k}}` : v;
  };
  const component = (json: string | undefined, typo?: string) => {
    if (!json) return undefined;
    const b = JSON.parse(json);
    const out: Record<string, string> = {};
    if (b.backgroundColor) out.backgroundColor = ref(colors, 'colors', flatten(b.backgroundColor, surface))!;
    if (b.textColor) out.textColor = ref(colors, 'colors', flatten(b.textColor, surface), 'on-primary')!;
    if (typo && typography[typo]) out.typography = `{typography.${typo}}`;
    if (b.rounded && b.rounded !== '0px') out.rounded = ref(rounded, 'rounded', parseFloat(b.rounded) >= 999 || b.rounded === '50%' ? '9999px' : b.rounded)!;
    if (b.padding && b.padding !== '0px 0px') out.padding = b.padding;
    if (b.height) out.height = b.height;
    return out;
  };
  const components: Record<string, Record<string, string>> = {};
  const addComp = (name: string, c?: Record<string, string>) => { if (c && Object.keys(c).length) components[name] = c; };
  addComp('button-primary', component(buttons[0], 'label-md'));
  addComp('button-secondary', component(buttons.find((b, i) => i > 0 && JSON.parse(b).backgroundColor !== JSON.parse(buttons[0]).backgroundColor), 'label-md'));
  addComp('input-field', component(inputs[0], 'body-md'));
  const link = ranked(merge(s.map(p => p.components.link || {})))[0];
  if (link) addComp('link', { textColor: ref(colors, 'colors', flatten(JSON.parse(link).textColor, surface))! });

  // ---- Tailwind v4 theme
  const fontVar = (f: string) => `--font-${slug(f)}`;
  const themeLines = [
    ...Object.entries(colors).map(([k, v]) => `  --color-${k}: ${v};`),
    ...fonts.map(f => `  ${fontVar(f)}: ${JSON.stringify(f)}, ${/mono|code/i.test(f) ? 'ui-monospace, monospace' : 'ui-sans-serif, system-ui, sans-serif'};`),
    ...Object.entries(typography).flatMap(([k, t]) => [
      `  --text-${k}: ${t.fontSize};`,
      ...(t.lineHeight ? [`  --text-${k}--line-height: ${t.lineHeight};`] : []),
      ...(t.letterSpacing ? [`  --text-${k}--letter-spacing: ${t.letterSpacing};`] : []),
      `  --text-${k}--font-weight: ${t.fontWeight};`,
    ]),
    ...Object.entries(rounded).map(([k, v]) => `  --radius-${k}: ${v};`),
    ...Object.entries(spacing).filter(([k]) => k !== 'container').map(([k, v]) => `  --spacing-${k}: ${v};`),
    ...(container ? [`  --container-page: ${container};`] : []),
    ...shadows.map((v, i) => `  --shadow-elevation-${i + 1}: ${v};`),
    ...breakpoints.map((v, i) => `  --breakpoint-bp${i + 1}: ${v}px;`),
  ];
  const theme = `@theme {\n${themeLines.join('\n')}\n}\n`;
  const imports = [
    ...fontLinks.map(l => `@import url(${JSON.stringify(l)});`),
    ...(fontsCss ? ['@import "./fonts.css";'] : []),
  ];
  const themeCss = `@import "tailwindcss";\n${imports.map(i => i + '\n').join('')}\n${theme}`;

  // ---- per-page HTML: swap arbitrary values for theme tokens
  // First name wins for shared values (surface before on-primary)
  const colorName = Object.fromEntries(Object.entries(colors).reverse().map(([k, v]) => [v, k]));
  const radiusName = Object.fromEntries(Object.entries(rounded).map(([k, v]) => [v, k]));
  const shadowName = Object.fromEntries(shadows.map((v, i) => [v.replace(/\s+/g, '_'), `elevation-${i + 1}`]));
  const tokenize = (html: string) => html
    .replace(/\b(text|bg|border)-\[(#[0-9a-f]{6,8})\]/g, (m, p, h) => (colorName[h] ? `${p}-${colorName[h]}` : m))
    .replace(/\brounded-\[([\d.]+px)\]/g, (m, v) => (radiusName[v] ? `rounded-${radiusName[v]}` : m))
    .replace(/\bshadow-\[([^\]]+)\]/g, (m, v) => (shadowName[v] ? `shadow-${shadowName[v]}` : m))
    .replace(/\bfont-\[family-name:([^\]]+)\]/g, (m, f) => {
      const fam = f.replace(/_/g, ' ');
      return fonts.includes(fam) ? `font-${slug(fam)}` : m;
    })
    .replace(/\bmax-w-\[([\d.]+px)\]/g, (m, v) => (v === container ? 'max-w-page' : m));
  const htmlDocs: Record<string, string> = {};
  for (const p of pages) {
    const body = tokenize(renderResponsive(p.trees)).replace(/^<body/, `<body data-source="${p.url}"`);
    htmlDocs[p.prefix] = [
      '<!doctype html>',
      `<html lang="${p.styles.lang}">`,
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${p.styles.title.replace(/</g, '&lt;')}</title>`,
      ...fontLinks.map(l => `<link rel="stylesheet" href="${l}">`),
      ...(fontsCss ? ['<link rel="stylesheet" href="fonts.css">'] : []),
      `<script src="${TAILWIND_BROWSER}"></script>`,
      `<style type="text/tailwindcss">\n${theme}</style>`,
      '</head>',
      body.trimEnd(),
      '</html>',
      '',
    ].join('\n');
  }

  // ---- DESIGN.md
  const host = new URL(startUrl).hostname;
  const home = pages[0].styles;
  const dark = luminance(colors.surface || '#ffffff') < 0.2;
  const bodyFont = typography['body-md']?.fontFamily || fonts[0];
  const headFont = typography['headline-display']?.fontFamily || typography['headline-lg']?.fontFamily;
  const yaml = [
    '---',
    'version: alpha',
    `name: ${yamlStr(home.title || host)}`,
    `description: ${yamlStr(home.description || `Design system extracted from ${host}`)}`,
    'colors:',
    ...Object.entries(colors).map(([k, v]) => `  ${k}: "${v}"`),
    'typography:',
    ...Object.entries(typography).flatMap(([k, t]) => [
      `  ${k}:`,
      ...Object.entries(t).map(([p, v]) => `    ${p}: ${yamlStr(v)}`),
    ]),
    ...(Object.keys(rounded).length ? ['rounded:', ...Object.entries(rounded).map(([k, v]) => `  ${k}: ${v}`)] : []),
    ...(Object.keys(spacing).length ? ['spacing:', ...Object.entries(spacing).map(([k, v]) => `  ${k}: ${v}`)] : []),
    ...(Object.keys(components).length ? ['components:', ...Object.entries(components).flatMap(([k, c]) => [
      `  ${k}:`,
      ...Object.entries(c).map(([p, v]) => `    ${p}: ${JSON.stringify(v)}`),
    ])] : []),
    '---',
  ];

  const pct = (c: Counts, k: string) => {
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    return total ? Math.round((c[k] || 0) / total * 100) : 0;
  };
  const textC = merge(s.map(p => p.textColors));
  const bgC = merge(s.map(p => p.bgColors));
  const ratio = colors['on-surface'] && colors.surface ? contrast(colors['on-surface'], colors.surface) : 0;
  const pRatio = colors['on-primary'] && colors.primary ? contrast(colors['on-primary'], colors.primary) : 0;
  const bp = components['button-primary'];

  const md = [
    ...yaml,
    '',
    `# ${home.title || host}`,
    '',
    `> Extracted automatically from ${startUrl} (${pages.length} page${pages.length > 1 ? 's' : ''}) on ${date.toISOString().slice(0, 10)}. ` +
      'Token values are measured from computed styles; names and prose are heuristic, so review before treating them as intent.',
    '',
    '## Overview',
    '',
    `${home.description ? home.description + '\n\n' : ''}A ${dark ? 'dark' : 'light'} interface on a \`${colors.surface}\` surface. ` +
      `Body text is set in **${bodyFont}**${headFont && headFont !== bodyFont ? `, headlines in **${headFont}**` : ''}. ` +
      `${Object.keys(colors).filter(k => isAccent(colors[k])).length ? `Color accents come from \`${colors.primary}\`.` : 'The palette is essentially monochrome.'}`,
    '',
    '## Colors',
    '',
    ...Object.entries(colors).map(([k, v]) => `- **${k}** (\`${v}\`): ${pct(textC, v) ? `${pct(textC, v)}% of text` : ''}${pct(textC, v) && pct(bgC, v) ? ', ' : ''}${pct(bgC, v) ? `${pct(bgC, v)}% of painted background` : ''}${!pct(textC, v) && !pct(bgC, v) ? 'accents, borders and details' : ''}.`),
    '',
    '## Typography',
    '',
    `Font families in order of use: ${fonts.map(f => `**${f}**`).join(', ')}.${fontLinks.length ? ` Loaded from: ${fontLinks.map(l => `<${l}>`).join(', ')}.` : ''}`,
    '',
    ...Object.entries(typography).map(([k, t]) => `- **${k}**: ${t.fontFamily} ${t.fontSize}, weight ${t.fontWeight}${t.lineHeight ? `, line-height ${t.lineHeight}` : ''}${t.letterSpacing ? `, tracking ${t.letterSpacing}` : ''}.`),
    '',
    '## Layout',
    '',
    `${container ? `Content is constrained to a **${container}** max-width container (\`max-w-page\`). ` : ''}` +
      `Most frequent spacing values: ${Object.values(spacing).filter(v => v !== container).map(v => `\`${v}\``).join(', ')}.` +
      `${breakpoints.length ? ` Responsive breakpoints found in the stylesheets: ${breakpoints.map(b => `\`${b}px\``).join(', ')}.` : ''}`,
    '',
    '## Elevation & Depth',
    '',
    shadows.length
      ? `Shadows in use, most frequent first (\`shadow-elevation-N\` in the theme):\n\n${shadows.map((v, i) => `- elevation-${i + 1}: \`${v}\``).join('\n')}`
      : `Flat: no box shadows. Hierarchy comes from surface contrast${colors.outline ? ` and \`${colors.outline}\` borders` : ''}.`,
    '',
    '## Shapes',
    '',
    Object.keys(rounded).length
      ? `Corner radii in use: ${Object.entries(rounded).map(([k, v]) => `${k} \`${v}\``).join(', ')}.${bp?.rounded ? ` Primary buttons use ${bp.rounded}.` : ''}`
      : 'Square corners throughout; no border radius.',
    '',
    '## Components',
    '',
    ...(Object.keys(components).length
      ? Object.entries(components).map(([k, c]) => `- **${k}**: ${Object.entries(c).map(([p, v]) => `${p} \`${v}\``).join(', ')}.`)
      : ['No buttons or inputs detected.']),
    '',
    "## Do's and Don'ts",
    '',
    ...(bp?.backgroundColor ? [`- Do use ${bp.backgroundColor} for the main call to action, as the site does.`] : []),
    `- Do keep to ${fonts.length > 2 ? fonts.slice(0, 2).join(' and ') : fonts.join(' and ')}; don't introduce other font families.`,
    ...(Object.keys(rounded).length ? ["- Don't invent new corner radii; use the `rounded` scale."] : ["- Don't round corners."]),
    ...(ratio ? [`- ${ratio >= 4.5 ? 'Do' : "Don't"} rely on on-surface over surface for body text (contrast ${ratio.toFixed(1)}:1${ratio >= 4.5 ? ', passes WCAG AA' : ', below WCAG AA 4.5:1'}).`] : []),
    ...(pRatio ? [`- Button text on primary has ${pRatio.toFixed(1)}:1 contrast${pRatio >= 4.5 ? '' : '; darken or lighten it for small text'}.`] : []),
    '',
    '## Tailwind',
    '',
    '`theme.css` holds the same tokens as a Tailwind v4 `@theme` (e.g. `bg-primary`, `text-headline-lg`, `rounded-md`, `font-' + slug(bodyFont || 'sans') + '`). ' +
      'Each page below has an `.html` file with the simplified structure and mobile-first Tailwind classes derived from computed styles at every captured preset (`sm:`…`2xl:` variants where the layout changes); open it in a browser and resize to compare with the screenshots.',
    '',
    '## Pages',
    '',
    ...pages.map(p => `- ${p.url}\n  - structure: \`${p.prefix}.html\`\n  - screenshots: ${p.screenshots.map(f => `\`${f.split('/').pop()}\``).join(', ')}`),
    '',
  ].join('\n');

  // Token references are for YAML; in prose show them as plain names
  const [front, ...rest] = md.split('\n---\n');
  const prose = rest.join('\n---\n').replace(/\{(?:colors|rounded|typography)\.([\w-]+)\}/g, '**$1**');
  return { designMd: `${front}\n---\n${prose}`, themeCss, htmlDocs };
}
