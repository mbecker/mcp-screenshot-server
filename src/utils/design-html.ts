// ============================================================================
// Merge per-viewport DOM trees into one HTML document with mobile-first
// Tailwind variants (sm:, md:, lg:, xl:, 2xl:).
// ============================================================================

import type { DomNode } from './design-collect.js';

/** Tailwind's default breakpoints, widest first. */
const BREAKPOINTS: [string, number][] = [['2xl', 1536], ['xl', 1280], ['lg', 1024], ['md', 768], ['sm', 640]];

/** Variant prefix a viewport of this width falls under ('' = base, below sm). */
export const tierPrefix = (width: number): string => BREAKPOINTS.find(([, min]) => width >= min)?.[0] ?? '';

/** Class that restores each non-inherited property to its preflight default. '' = nothing to reset. */
const RESET: Record<string, string> = {
  flexDir: 'flex-row', wrap: 'flex-nowrap', justify: 'justify-start', items: 'items-stretch', gap: 'gap-0',
  cols: 'grid-cols-none', col: 'col-auto', row: 'row-auto', self: 'self-auto', grow: 'grow-0', shrink: 'shrink',
  position: 'static', inset: 'inset-auto', z: 'z-auto', w: 'w-auto', padding: 'p-0', margin: 'm-0', maxW: 'max-w-none',
  decoration: 'no-underline', list: 'list-none', bg: 'bg-transparent', bgImage: 'bg-none',
  bgSize: 'bg-auto', bgPos: 'bg-top-left', bgRepeat: 'bg-repeat', border: 'border-0',
  borderColor: '', rounded: 'rounded-none', shadow: 'shadow-none', opacity: 'opacity-100',
  overflow: 'overflow-visible', objectFit: 'object-fill',
};
const INHERITED = ['font', 'size', 'weight', 'leading', 'tracking', 'transform', 'align', 'color'];
const VOID = new Set(['img', 'input', 'br', 'hr']);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Tiers = (DomNode | undefined)[];

/**
 * Mobile-first classes for one element seen at each tier (undefined = no data at that width).
 * A property is emitted at a tier only when its effective value changes from the tier below.
 */
export function responsiveClasses(nodes: Tiers, prefixes: string[]): string[] {
  const out: string[] = [];
  const current: Record<string, string | null> = {}; // null = default / inherited from parent
  nodes.forEach((n, t) => {
    if (!n) return;
    const pre = prefixes[t] ? `${prefixes[t]}:` : '';
    const emit = (key: string, want: string | null, reset: string) => {
      if (want === (current[key] ?? null)) return;
      const cls = want ?? reset;
      if (cls) out.push(...cls.split(' ').map(c => pre + c));
      current[key] = want;
    };
    if (n.hidden) { emit('display', 'hidden', ''); return; }
    emit('display', n.props?.display ?? null, n.nat ?? 'block');
    for (const key of Object.keys(RESET)) emit(key, n.props?.[key] ?? null, RESET[key]);
    for (const key of INHERITED) {
      const v = n.inh?.[key];
      if (v) emit(key, v[1] ? null : v[0], v[0]); // back to inherited → pin the explicit value
    }
  });
  return out;
}

function render(nodes: Tiers, prefixes: string[], depth: number, compact: boolean): string {
  const first = nodes.find(n => n && !n.hidden);
  if (!first) return ''; // hidden at every captured width
  const pad = compact ? '' : '  '.repeat(depth);
  const nl = compact ? '' : '\n';
  const cls = responsiveClasses(nodes, prefixes);
  const classAttr = cls.length ? ` class="${cls.join(' ')}"` : '';

  if (first.raw) {
    // Keep the SVG's own classes (often its size), ours go first
    const own = first.raw.match(/^<svg[^>]*?\sclass="([^"]*)"/)?.[1];
    const merged = [...cls, ...(own ? [own] : [])].join(' ');
    const svg = first.raw.replace(/^<svg([^>]*?)\sclass="[^"]*"/, '<svg$1');
    return pad + (merged ? svg.replace(/^<svg/, `<svg class="${merged}"`) : svg) + nl;
  }
  const attrs = Object.entries(first.attrs || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const open = `<${first.tag}${classAttr}${attrs}>`;
  if (VOID.has(first.tag)) return `${pad}${open}${nl}`;

  // Children by path at every tier, in the order of the first visible tier
  const byPath = nodes.map(n => new Map((n?.children || []).filter((c): c is DomNode => typeof c !== 'string').map(c => [c.path, c])));
  const kids = first.children || [];
  const ownText = kids.some(c => typeof c === 'string' && c.trim());
  const inlineKids = compact || !!first.pre || ownText || !!first.inline;
  let inner = '';
  for (const c of kids) {
    if (typeof c === 'string') {
      if (first.pre || inlineKids) inner += esc(c);
      else if (c.trim()) inner += `${pad}  ${esc(c.trim())}\n`;
    } else {
      inner += render(byPath.map(m => m.get(c.path)), prefixes, depth + 1, inlineKids);
    }
  }
  // Unwrap class-less wrappers with a single child to cut noise
  const elementKids = kids.filter(c => typeof c !== 'string');
  if (!compact && !cls.length && !attrs && !ownText && (first.tag === 'div' || first.tag === 'span') && elementKids.length === 1) {
    return inner.split('\n').map(l => l.replace(/^ {2}/, '')).join('\n');
  }
  if (!inner.trim()) return cls.length || attrs ? `${pad}${open}</${first.tag}>${nl}` : '';
  if (inlineKids && !compact) return `${pad}${open}${first.pre ? inner : inner.trim()}</${first.tag}>\n`;
  return compact ? `${open}${inner}</${first.tag}>` : `${pad}${open}\n${inner}${pad}</${first.tag}>\n`;
}

/**
 * Render the <body> of a page from trees captured at several widths.
 * Widths that fall under the same breakpoint keep only the narrowest.
 */
export function renderResponsive(trees: { width: number; tree: DomNode | null }[]): string {
  const tiers = [...trees].sort((a, b) => a.width - b.width)
    .filter((t, i, all) => all.findIndex(o => tierPrefix(o.width) === tierPrefix(t.width)) === i);
  // The narrowest capture is the unprefixed base: it also covers every smaller width
  const prefixes = tiers.map((t, i) => (i === 0 ? '' : tierPrefix(t.width)));
  return render(tiers.map(t => t.tree ?? undefined), prefixes, 0, false);
}
