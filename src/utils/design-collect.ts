// ============================================================================
// In-page design collector. Runs inside the browser via page.evaluate(), so
// collectPage() must stay self-contained: no imports, no outer references.
// ============================================================================

export type Counts = Record<string, number>;

export interface RawStyles {
  title: string;
  description: string;
  lang: string;
  pageBg: string;
  textColors: Counts;   // hex → visible characters
  bgColors: Counts;     // hex → painted area (px²)
  borderColors: Counts; // hex → elements
  fonts: Counts;        // family → characters
  typography: Record<string, Counts>; // role → "family|size|weight|lineHeight|letterSpacing" → characters
  radii: Counts;
  shadows: Counts;
  spacing: Counts;      // px value → occurrences (padding, gap, margin)
  maxWidths: Counts;
  breakpoints: Counts;  // px → media rules
  colorVars: Record<string, string>; // hex → CSS custom property name
  fontLinks: string[];  // stylesheet URLs of web-font providers
  components: Record<string, Counts>; // kind → JSON style → occurrences
}

/**
 * One element as rendered at one viewport width. Elements are matched across
 * widths by `path` (element-child indices from <body>), so hidden elements stay
 * in the tree as placeholders.
 */
export interface DomNode {
  tag: string;
  path: string;
  /** display:none, visibility:hidden or zero-size at this width */
  hidden?: true;
  /** Non-inherited properties that differ from the Tailwind-preflight default: key → class(es) */
  props?: Record<string, string>;
  /** Inherited properties: key → [class, same as parent] */
  inh?: Record<string, [string, boolean]>;
  /** Class that restores the tag's default display (block, inline, …) */
  nat?: string;
  attrs?: Record<string, string>;
  /** Inline SVG markup */
  raw?: string;
  /** Preformatted whitespace (pre, pre-wrap, …) */
  pre?: true;
  /** Inline-level display, children are serialized compactly */
  inline?: true;
  children?: (DomNode | string)[];
}

export interface PageContent {
  url: string;
  title: string;
  lang: string;
  /** description, canonical, og:*, twitter:* … */
  meta: Record<string, string>;
  headings: { level: number; text: string }[];
  /** Full visible text in reading order (innerText) */
  text: string;
  links: { text: string; href: string }[];
  images: { src: string; alt: string; width: number; height: number }[];
  forms: { action: string; method: string; fields: { tag: string; type: string; name: string; label: string }[] }[];
}

export interface PageExtract {
  styles: RawStyles;
  tree: DomNode | null;
  content: PageContent;
  /** The element cap was hit; tree and HTML are incomplete */
  truncated: boolean;
}

export function collectPage(maxNodes: number): PageExtract {
  // --- color normalization: computed styles may be rgb(), oklch(), color(), …
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const hexCache = new Map<string, string | null>();
  const hex = (c: string): string | null => {
    if (!c || c === 'transparent' || c === 'none') return null;
    if (hexCache.has(c)) return hexCache.get(c)!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#01020300'; // sentinel: invalid colors leave this in place
    ctx.fillStyle = c;
    if (ctx.fillStyle === '#01020300' && c !== '#01020300') { hexCache.set(c, null); return null; }
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const h2 = (n: number) => n.toString(16).padStart(2, '0');
    const out = a === 0 ? null : `#${h2(r)}${h2(g)}${h2(b)}${a < 255 ? h2(a) : ''}`;
    hexCache.set(c, out);
    return out;
  };
  const add = (m: Counts, k: string | null | undefined, n = 1) => { if (k) m[k] = (m[k] || 0) + n; };
  const px = (v: string) => parseFloat(v) || 0;
  const family = (f: string) => f.split(',')[0].replace(/["']/g, '').trim();
  // Drop fully transparent layers (e.g. Tailwind's unused ring/shadow slots)
  const shadow = (v: string) => v === 'none' ? '' : v.split(/,(?![^(]*\))/).map(l => l.trim())
    .filter(l => !/^rgba\(0, 0, 0, 0\)/.test(l) && !/\/ 0\)/.test(l)).join(', ');

  const styles: RawStyles = {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
    lang: document.documentElement.lang || 'en',
    pageBg: hex(getComputedStyle(document.body).backgroundColor) ||
      hex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff',
    textColors: {}, bgColors: {}, borderColors: {}, fonts: {}, typography: {},
    radii: {}, shadows: {}, spacing: {}, maxWidths: {}, breakpoints: {},
    colorVars: {}, fontLinks: [], components: {},
  };

  // --- CSS custom properties that hold colors (lets tokens reuse the site's names)
  const rootCs = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootCs.length; i++) {
    const name = rootCs[i];
    if (!name.startsWith('--')) continue;
    const h = hex(rootCs.getPropertyValue(name).trim());
    if (h && !styles.colorVars[h]) styles.colorVars[h] = name;
  }

  // --- breakpoints from readable stylesheets (cross-origin sheets throw)
  const scanRules = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        for (const m of rule.conditionText.matchAll(/(?:min-width|max-width|width\s*[<>]=?)\s*:?\s*([\d.]+)(px|rem|em)/g)) {
          add(styles.breakpoints, String(Math.round(m[2] === 'px' ? +m[1] : +m[1] * 16)));
        }
      }
      if ('cssRules' in rule) scanRules((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { scanRules(sheet.cssRules); } catch { /* cross-origin */ }
  }
  styles.fontLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map(l => l.href)
    .filter(h => /fonts\.(googleapis|bunny)\.|use\.typekit\.net|fonts\.cdnfonts/.test(h));

  // --- Tailwind class derivation
  const spaceCls = (prefix: string, v: number): string => {
    const neg = v < 0 ? '-' : '';
    const n = Math.abs(v);
    return (n * 2) % 4 === 0 ? `${neg}${prefix}-${n / 4}` : `${neg}${prefix}-[${n}px]`;
  };
  /** Box shorthand that always sets all four sides, so it can override at a breakpoint. */
  const box = (p: string, t: number, r: number, b: number, l: number): string =>
    t === r && r === b && b === l ? spaceCls(p, t)
      : l === r && t === b ? `${spaceCls(p + 'x', l)} ${spaceCls(p + 'y', t)}`
        : [spaceCls(p + 't', t), spaceCls(p + 'r', r), spaceCls(p + 'b', b), spaceCls(p + 'l', l)].join(' ');
  const SIZES: Record<number, string> = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
  const WEIGHTS: Record<string, string> = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
  const JUSTIFY: Record<string, string> = { center: 'center', 'space-between': 'between', 'flex-end': 'end', end: 'end', 'space-around': 'around', 'space-evenly': 'evenly' };
  const ALIGN: Record<string, string> = { center: 'center', 'flex-start': 'start', start: 'start', 'flex-end': 'end', end: 'end', baseline: 'baseline' };
  const DISPLAY: Record<string, string> = {
    block: 'block', inline: 'inline', 'inline-block': 'inline-block', flex: 'flex', 'inline-flex': 'inline-flex',
    grid: 'grid', 'inline-grid': 'inline-grid', contents: 'contents', 'flow-root': 'flow-root', 'list-item': 'list-item',
    table: 'table', 'table-row': 'table-row', 'table-cell': 'table-cell', 'table-row-group': 'table-row-group', 'table-header-group': 'table-header-group',
  };
  const arb = (v: string) => v.trim().replace(/\s+/g, '_');
  const INLINE_TAGS = new Set(['SPAN', 'A', 'CODE', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'LABEL', 'SMALL', 'ABBR', 'KBD', 'MARK', 'SUB', 'SUP', 'TIME', 'Q', 'CITE', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
  // Tailwind's preflight makes replaced elements block-level
  const naturalDisplay = (tag: string): string =>
    INLINE_TAGS.has(tag) ? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(tag) ? 'inline-block' : 'inline')
      : tag === 'LI' ? 'list-item' : tag === 'TABLE' ? 'table' : tag === 'TR' ? 'table-row'
        : tag === 'TD' || tag === 'TH' ? 'table-cell' : tag === 'TBODY' ? 'table-row-group' : tag === 'THEAD' ? 'table-header-group' : 'block';

  /** Non-inherited properties that differ from the preflight default. Keys are stable across widths. */
  const ownProps = (el: Element, cs: CSSStyleDeclaration, pcs: CSSStyleDeclaration): Record<string, string> => {
    const p: Record<string, string> = {};
    const d = cs.display;
    const display = DISPLAY[d] || 'block';
    if (display !== naturalDisplay(el.tagName)) p.display = display;
    const flex = d.includes('flex'), grid = d.includes('grid');
    if (flex && cs.flexDirection !== 'row') p.flexDir = `flex-${cs.flexDirection.replace('column', 'col')}`;
    if (flex && cs.flexWrap !== 'nowrap') p.wrap = `flex-${cs.flexWrap}`;
    if ((flex || grid) && JUSTIFY[cs.justifyContent]) p.justify = `justify-${JUSTIFY[cs.justifyContent]}`;
    if ((flex || grid) && ALIGN[cs.alignItems]) p.items = `items-${ALIGN[cs.alignItems]}`;
    if (flex || grid) {
      const rg = px(cs.rowGap), cg = px(cs.columnGap);
      if (rg || cg) p.gap = rg === cg ? spaceCls('gap', rg) : `${spaceCls('gap-x', cg)} ${spaceCls('gap-y', rg)}`;
    }
    if (grid && cs.gridTemplateColumns !== 'none') {
      // Equal tracks → grid-cols-N; otherwise the measured track sizes
      const tracks = cs.gridTemplateColumns.split(' ');
      p.cols = tracks.every(t => t === tracks[0]) ? `grid-cols-${tracks.length}` : `grid-cols-[${tracks.join('_')}]`;
    }
    if (pcs.display.includes('grid')) {
      if (cs.gridColumnStart !== 'auto' || cs.gridColumnEnd !== 'auto') p.col = `col-[${arb(cs.gridColumn)}]`;
      if (cs.gridRowStart !== 'auto' || cs.gridRowEnd !== 'auto') p.row = `row-[${arb(cs.gridRow)}]`;
    }
    if ((pcs.display.includes('flex') || pcs.display.includes('grid')) && ALIGN[cs.alignSelf]) p.self = `self-${ALIGN[cs.alignSelf]}`;
    if (pcs.display.includes('flex')) {
      if (cs.flexGrow !== '0') p.grow = cs.flexGrow === '1' ? 'grow' : `grow-[${cs.flexGrow}]`;
      if (cs.flexShrink === '0') p.shrink = 'shrink-0';
    }
    if (cs.position !== 'static') {
      p.position = cs.position;
      const inset = (side: string, v: string) => (v.endsWith('px') ? spaceCls(side, px(v)) : '');
      // absolute/fixed: all four resolved insets reproduce the measured box; sticky: its top offset
      if (cs.position === 'absolute' || cs.position === 'fixed') {
        p.inset = [inset('top', cs.top), inset('right', cs.right), inset('bottom', cs.bottom), inset('left', cs.left)].filter(Boolean).join(' ');
      } else if (cs.position === 'sticky' && cs.top !== 'auto') p.inset = inset('top', cs.top);
      if (cs.zIndex !== 'auto') p.z = `z-[${cs.zIndex}]`;
    }
    // Boxes that would not stretch on their own but fill their parent's content width
    const parent = el.parentElement;
    const flexParent = pcs.display.includes('flex');
    const shrinks = d.startsWith('inline') ||
      (flexParent && (!pcs.flexDirection.startsWith('column') || !['normal', 'stretch'].includes(pcs.alignItems)));
    if (parent && shrinks && cs.position !== 'absolute' && cs.position !== 'fixed') {
      const avail = parent.clientWidth - px(pcs.paddingLeft) - px(pcs.paddingRight);
      if (avail > 0 && Math.abs(el.getBoundingClientRect().width + px(cs.marginLeft) + px(cs.marginRight) - avail) < 1) p.w = 'w-full';
    }
    const pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
    if (pad.some(Boolean)) p.padding = box('p', pad[0], pad[1], pad[2], pad[3]);
    const [mt, mr, mb, ml] = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(px);
    if (cs.maxWidth !== 'none' && ml > 0 && Math.abs(ml - mr) < 1) p.margin = `mx-auto ${spaceCls('mt', mt)} ${spaceCls('mb', mb)}`;
    else if (mt || mr || mb || ml) p.margin = box('m', mt, mr, mb, ml);
    if (cs.maxWidth.endsWith('px')) p.maxW = `max-w-[${cs.maxWidth}]`;
    if (cs.textDecorationLine.includes('underline')) p.decoration = 'underline';
    else if (cs.textDecorationLine.includes('line-through')) p.decoration = 'line-through';
    if ((el.tagName === 'UL' || el.tagName === 'OL') && cs.listStyleType !== 'none') p.list = `list-${cs.listStyleType === 'decimal' ? 'decimal' : 'disc'}`;

    const bg = hex(cs.backgroundColor);
    if (bg) p.bg = `bg-[${bg}]`;
    const bgUrl = cs.backgroundImage.match(/^url\("?([^")]+)"?\)$/)?.[1];
    if (bgUrl && !bgUrl.startsWith('data:')) {
      // Underscores would turn into spaces inside a Tailwind arbitrary value
      p.bgImage = `bg-[url(${bgUrl.replace(/_/g, '\\_')})]`;
      if (['cover', 'contain'].includes(cs.backgroundSize)) p.bgSize = `bg-${cs.backgroundSize}`;
      if (cs.backgroundPosition === '50% 50%') p.bgPos = 'bg-center';
      if (cs.backgroundRepeat === 'no-repeat') p.bgRepeat = 'bg-no-repeat';
    } else if (cs.backgroundImage.includes('gradient') && cs.backgroundImage.length < 300) p.bgImage = `bg-[${arb(cs.backgroundImage)}]`;
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
    if (bw.some(Boolean)) { // computed width is 0 when border-style is none
      const side = (s: string, w: number) => (w === 1 ? `border${s}` : `border${s}-[${w}px]`).replace('-[0px]', '-0');
      p.border = bw.every(w => w === bw[0]) ? side('', bw[0]) : ['-t', '-r', '-b', '-l'].map((s, i) => side(s, bw[i])).join(' ');
      const bc = hex(cs.borderTopColor) || hex(cs.borderBottomColor);
      if (bc) p.borderColor = `border-[${bc}]`;
    }
    const r = cs.borderTopLeftRadius;
    if (r !== '0px' && r === cs.borderBottomRightRadius) p.rounded = r === '50%' || px(r) >= 999 ? 'rounded-full' : `rounded-[${r}]`;
    if (shadow(cs.boxShadow)) p.shadow = `shadow-[${arb(shadow(cs.boxShadow))}]`;
    if (cs.opacity !== '1') p.opacity = `opacity-[${cs.opacity}]`;
    if (cs.overflow !== 'visible' && ['hidden', 'auto', 'scroll', 'clip'].includes(cs.overflow)) p.overflow = `overflow-${cs.overflow}`;
    if (el.tagName === 'IMG' && cs.objectFit !== 'fill') p.objectFit = `object-${cs.objectFit}`;
    return p;
  };

  /** Inherited properties: always the explicit class, plus whether it equals the parent's value. */
  const inhProps = (cs: CSSStyleDeclaration, pcs: CSSStyleDeclaration): Record<string, [string, boolean]> => {
    const fs = px(cs.fontSize);
    const lh = (c: CSSStyleDeclaration) => c.lineHeight === 'normal' ? 'leading-normal' : `leading-[${+(px(c.lineHeight) / px(c.fontSize)).toFixed(2)}]`;
    const ls = (c: CSSStyleDeclaration) => c.letterSpacing === 'normal' || !px(c.letterSpacing) ? 'tracking-normal' : `tracking-[${+(px(c.letterSpacing) / px(c.fontSize)).toFixed(3)}em]`;
    const align = (a: string) => `text-${a === 'start' ? 'left' : a === 'end' ? 'right' : a}`;
    const out: Record<string, [string, boolean]> = {
      font: [`font-[family-name:${arb(family(cs.fontFamily))}]`, cs.fontFamily === pcs.fontFamily],
      size: [SIZES[fs] ? `text-${SIZES[fs]}` : `text-[${fs}px]`, cs.fontSize === pcs.fontSize],
      weight: [WEIGHTS[cs.fontWeight] ? `font-${WEIGHTS[cs.fontWeight]}` : `font-[${cs.fontWeight}]`, cs.fontWeight === pcs.fontWeight],
      leading: [lh(cs), lh(cs) === lh(pcs)],
      tracking: [ls(cs), ls(cs) === ls(pcs)],
      transform: [cs.textTransform === 'none' ? 'normal-case' : cs.textTransform, cs.textTransform === pcs.textTransform],
      align: [align(cs.textAlign), cs.textAlign === pcs.textAlign],
      color: [`text-[${hex(cs.color) || '#000000'}]`, cs.color === pcs.color],
    };
    return out;
  };

  // --- statistics for one visible element
  const record = (el: Element, cs: CSSStyleDeclaration, rect: DOMRect) => {
    let chars = 0;
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) chars += n.textContent!.trim().length;
    const fs = px(cs.fontSize);
    if (chars) {
      add(styles.textColors, hex(cs.color), chars);
      add(styles.fonts, family(cs.fontFamily), chars);
      const owner = el.closest('h1,h2,h3,h4,button,[role="button"],a,label,small,figcaption');
      const tag = owner?.tagName.toLowerCase();
      const role = !tag ? 'body' : tag === 'a' ? 'link' : /^h\d$/.test(tag) ? tag : ['label', 'small', 'figcaption'].includes(tag) ? 'small' : 'button';
      const lh = cs.lineHeight === 'normal' ? '' : String(+(px(cs.lineHeight) / fs).toFixed(2));
      const ls = cs.letterSpacing === 'normal' || !px(cs.letterSpacing) ? '' : `${+(px(cs.letterSpacing) / fs).toFixed(3)}em`;
      add(styles.typography[role] ||= {}, [family(cs.fontFamily), fs, cs.fontWeight, lh, ls].join('|'), chars);
    }
    add(styles.bgColors, hex(cs.backgroundColor), Math.round(Math.min(rect.width * rect.height, innerWidth * innerHeight)));
    if (px(cs.borderTopWidth) || px(cs.borderBottomWidth)) add(styles.borderColors, hex(cs.borderTopColor) || hex(cs.borderBottomColor));
    if (cs.borderTopLeftRadius !== '0px') add(styles.radii, cs.borderTopLeftRadius === '50%' ? '9999px' : cs.borderTopLeftRadius);
    add(styles.shadows, shadow(cs.boxShadow));
    for (const v of [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft, cs.rowGap, cs.columnGap, cs.marginTop, cs.marginBottom]) {
      if (px(v) > 0) add(styles.spacing, `${px(v)}px`);
    }
    if (cs.maxWidth.endsWith('px')) add(styles.maxWidths, cs.maxWidth);

    const bg = hex(cs.backgroundColor);
    const style = (extra: object) => JSON.stringify({
      backgroundColor: bg, textColor: hex(cs.color), rounded: cs.borderTopLeftRadius,
      padding: `${px(cs.paddingTop)}px ${px(cs.paddingLeft)}px`, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      height: `${Math.round(rect.height)}px`, ...extra,
    });
    if (el.matches('button,[role="button"],input[type="submit"],a') && (bg || px(cs.borderTopWidth)) && rect.height >= 24 && rect.height <= 80) {
      add(styles.components.button ||= {}, style({ borderColor: px(cs.borderTopWidth) ? hex(cs.borderTopColor) : null }));
    } else if (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]),textarea,select')) {
      add(styles.components.input ||= {}, style({ borderColor: hex(cs.borderTopColor) }));
    } else if (el.tagName === 'A' && chars) {
      add(styles.components.link ||= {}, JSON.stringify({ textColor: hex(cs.color), underline: cs.textDecorationLine.includes('underline') }));
    }
  };

  // --- single DOM walk: statistics + tree
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'IFRAME', 'OBJECT', 'HEAD']);
  const KEEP_ATTRS: Record<string, string[]> = { A: ['href'], IMG: ['src', 'alt', 'width', 'height'], INPUT: ['type', 'placeholder'], BUTTON: ['type'], TEXTAREA: ['placeholder'] };
  let nodes = 0;

  const walk = (el: Element, pcs: CSSStyleDeclaration, path: string, pre: boolean): DomNode | null => {
    if (SKIP.has(el.tagName) || ++nodes > maxNodes) return null;
    const tag = el.tagName.toLowerCase();
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 && rect.height <= 1 && cs.overflow === 'hidden' && cs.position === 'absolute') return null; // sr-only
    if (cs.display === 'none' || cs.visibility === 'hidden' ||
      (cs.display !== 'contents' && (rect.width === 0 || rect.height === 0) && cs.position !== 'fixed')) {
      return { tag, path, hidden: true };
    }
    record(el, cs, rect);

    const node: DomNode = { tag, path, props: ownProps(el, cs, pcs), inh: inhProps(cs, pcs), nat: naturalDisplay(el.tagName) };
    const attrs: Record<string, string> = {};
    for (const a of (KEEP_ATTRS[el.tagName] || []).concat('aria-label')) {
      const v = a === 'href' ? (el as HTMLAnchorElement).href : a === 'src' ? (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src : el.getAttribute(a);
      if (v) attrs[a] = v;
    }
    if (Object.keys(attrs).length) node.attrs = attrs;
    if (tag === 'svg') {
      const svg = el.outerHTML;
      node.raw = svg.length < 10000 ? svg.replace(/\s+/g, ' ')
        : `<svg class="w-[${Math.round(rect.width)}px] h-[${Math.round(rect.height)}px]" aria-hidden="true"></svg>`;
      return node;
    }
    const isPre = pre || cs.whiteSpace.startsWith('pre') || cs.whiteSpace === 'break-spaces';
    if (isPre) node.pre = true;
    if (cs.display.startsWith('inline')) node.inline = true;
    const children: (DomNode | string)[] = [];
    let i = 0;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        const t = isPre ? n.textContent! : n.textContent!.replace(/\s+/g, ' ');
        if (t) children.push(t);
      } else if (n.nodeType === 1) {
        const child = walk(n as Element, cs, `${path}.${i++}`, isPre);
        if (child) children.push(child);
      }
    }
    if (children.length) node.children = children;
    return node;
  };

  const tree = walk(document.body, getComputedStyle(document.documentElement), '0', false);

  // --- content: everything an agent needs to rebuild copy, links and forms
  const clean = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim();
  const meta: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll('meta[name],meta[property]'))) {
    const key = m.getAttribute('name') || m.getAttribute('property')!;
    if (/^(description|keywords|author|theme-color|og:|twitter:)/.test(key)) meta[key] = m.getAttribute('content') || '';
  }
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  if (canonical) meta.canonical = canonical;
  const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href;
  if (icon) meta.icon = icon;
  const labelFor = (el: Element) => clean(
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
    el.closest('label')?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder'));
  const content: PageContent = {
    url: location.href,
    title: document.title,
    lang: styles.lang,
    meta,
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map(h => ({ level: +h.tagName[1], text: clean((h as HTMLElement).innerText || h.textContent) })).filter(h => h.text),
    text: document.body.innerText,
    links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map(a => ({ text: clean(a.innerText || a.getAttribute('aria-label')), href: a.href })).filter(l => l.text || l.href),
    images: Array.from(document.images)
      .map(i => ({ src: i.currentSrc || i.src, alt: i.alt, width: i.naturalWidth, height: i.naturalHeight })).filter(i => i.src),
    forms: Array.from(document.forms).map(f => ({
      action: f.action || f.getAttribute('action') || '', method: f.method,
      fields: Array.from(f.querySelectorAll('input,select,textarea,button'))
        .filter(el => (el as HTMLInputElement).type !== 'hidden')
        .map(el => ({ tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type || '', name: el.getAttribute('name') || '', label: labelFor(el) || clean(el.textContent) })),
    })),
  };
  return { styles, tree, content, truncated: nodes > maxNodes };
}

/**
 * Make lazy content load before collecting: native lazy images become eager, and one
 * pass down the page triggers IntersectionObserver-based loaders. Ends at the top.
 * Runs in the page via page.evaluate(), so it must stay self-contained.
 */
export async function loadLazyContent(maxSteps: number): Promise<void> {
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]'))) img.loading = 'eager';
  const pause = () => new Promise(r => setTimeout(r, 150));
  for (let i = 0; i < maxSteps && window.scrollY + innerHeight < document.documentElement.scrollHeight; i++) {
    window.scrollBy(0, innerHeight);
    await pause();
  }
  window.scrollTo(0, 0);
  await pause();
}
