import { describe, it, expect } from 'vitest';
import { buildDesign, flatten, contrast, type CapturedPage } from '../../src/utils/design-md.js';
import type { DomNode, RawStyles } from '../../src/utils/design-collect.js';

const styles = (over: Partial<RawStyles> = {}): RawStyles => ({
  title: 'Acme', description: 'Acme tools', lang: 'en', pageBg: '#ffffff',
  textColors: { '#111827': 900, '#6b7280': 100 },
  bgColors: { '#ffffff': 50000, '#0000000d': 9000, '#2563eb': 2000 },
  borderColors: { '#e5e7eb': 20 },
  fonts: { Inter: 1000 },
  typography: {
    h1: { 'Inter|48|700|1.1|-0.02em': 30 },
    body: { 'Inter|16|400|1.5|': 800 },
    button: { 'Inter|14|600||': 20 },
  },
  radii: { '8px': 10, '4px': 3, '9999px': 2 },
  shadows: { 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px': 4 },
  spacing: { '16px': 40, '8px': 30, '24px': 10 },
  maxWidths: { '1200px': 3 },
  breakpoints: { '768': 5, '1024': 3 },
  colorVars: { '#2563eb': '--color-brand' },
  fontLinks: [],
  components: {
    button: {
      // A frequent translucent chip must not win over the solid CTA
      [JSON.stringify({ backgroundColor: '#0000000d', textColor: '#111827', rounded: '9999px', padding: '4px 8px', height: '24px' })]: 9,
      [JSON.stringify({ backgroundColor: '#2563eb', textColor: '#ffffff', rounded: '8px', padding: '12px 24px', height: '44px' })]: 2,
    },
  },
  ...over,
});

const inh = (color: string, same: boolean) => ({
  font: ['font-[family-name:Inter]', false], size: ['text-base', true], weight: ['font-normal', true], leading: ['leading-[1.5]', true],
  tracking: ['tracking-normal', true], transform: ['normal-case', true], align: ['text-left', true], color: [color, same],
} as Record<string, [string, boolean]>);
const tree = (width: number): DomNode => ({
  tag: 'body', path: '0', nat: 'block', props: { bg: 'bg-[#ffffff]' }, inh: inh('text-[#111827]', false),
  children: [{
    tag: 'a', path: '0.0', nat: 'inline', inline: true, inh: inh('text-[#ffffff]', false),
    props: { bg: 'bg-[#2563eb]', rounded: 'rounded-[8px]', shadow: 'shadow-[rgba(0,_0,_0,_0.1)_0px_1px_2px_0px]', maxW: 'max-w-[1200px]', padding: width < 768 ? 'p-2' : 'p-4' },
    children: ['Go'],
  }],
});
const page = (prefix: string, s = styles()): CapturedPage => ({
  url: `https://acme.test/${prefix}`, prefix, screenshots: [`/out/${prefix}-desktop.png`], styles: s,
  trees: [{ width: 402, tree: tree(402) }, { width: 1920, tree: tree(1920) }],
});

describe('buildDesign', () => {
  const out = buildDesign([page('00-home')], 'https://acme.test/', { date: new Date('2026-01-02') });
  const front = out.designMd.split('\n---\n')[0];

  it('picks color roles: solid CTA as primary, page background as surface, top text as on-surface', () => {
    expect(front).toContain('  primary: "#2563eb"');
    expect(front).toContain('  surface: "#ffffff"');
    expect(front).toContain('  on-surface: "#111827"');
    expect(front).toContain('  on-primary: "#ffffff"');
    expect(front).toContain('  outline: "#e5e7eb"');
    expect(front).not.toMatch(/"#[0-9a-f]{8}"/); // translucent colors are flattened over the surface
  });

  it('writes components with token references', () => {
    expect(front).toMatch(/button-primary:\n {4}backgroundColor: "\{colors\.primary\}"\n {4}textColor: "\{colors\.on-primary\}"\n {4}typography: "\{typography\.label-md\}"\n {4}rounded: "\{rounded\.md\}"/);
  });

  it('follows the DESIGN.md section order', () => {
    const order = ['## Overview', '## Colors', '## Typography', '## Layout', '## Elevation & Depth', '## Shapes', '## Components', "## Do's and Don'ts"];
    const idx = order.map(h => out.designMd.indexOf(`\n${h}\n`));
    expect(idx.every(i => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(out.designMd).toMatch(/^---\nversion: alpha\nname: Acme\n/);
    expect(out.designMd).not.toMatch(/\n## [^\n]*\n[\s\S]*\{colors\./); // no raw token refs in prose
  });

  it('rewrites arbitrary values to theme tokens in page HTML', () => {
    const doc = out.htmlDocs['00-home'];
    // HTML class rewriting has no context, so a shared value maps to the first token (surface)
    expect(doc).toContain('<a class="p-2 max-w-page bg-primary rounded-md shadow-elevation-1 font-inter text-surface 2xl:p-4">Go</a>');
    expect(doc).toContain('<body data-source="https://acme.test/00-home" class="bg-surface font-inter text-on-surface">');
    expect(doc).toContain('@tailwindcss/browser@4.3.3');
  });

  it('emits a Tailwind v4 theme', () => {
    expect(out.themeCss).toMatch(/^@import "tailwindcss";/);
    for (const line of ['--color-primary: #2563eb;', '--font-inter: "Inter"', '--text-headline-display: 48px;',
      '--text-headline-display--letter-spacing: -0.02em;', '--radius-md: 8px;', '--radius-full: 9999px;',
      '--container-page: 1200px;', '--breakpoint-bp1: 768px;']) {
      expect(out.themeCss).toContain(line);
    }
  });
});

describe('color helpers', () => {
  it('flattens alpha over a background', () => {
    expect(flatten('#00000080', '#ffffff')).toBe('#7f7f7f');
    expect(flatten('#123456', '#ffffff')).toBe('#123456');
  });
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
  });
});
