import { describe, it, expect } from 'vitest';
import { responsiveClasses, renderResponsive, tierPrefix } from '../../src/utils/design-html.js';
import type { DomNode } from '../../src/utils/design-collect.js';

const inh = (over: Record<string, [string, boolean]> = {}): DomNode['inh'] => ({
  font: ['font-[family-name:Inter]', true], size: ['text-base', true], weight: ['font-normal', true],
  leading: ['leading-[1.5]', true], tracking: ['tracking-normal', true], transform: ['normal-case', true],
  align: ['text-left', true], color: ['text-[#111111]', true], ...over,
});
const el = (path: string, props: Record<string, string> = {}, over: Partial<DomNode> = {}): DomNode =>
  ({ tag: 'div', path, props, inh: inh(), nat: 'block', ...over });
const hidden = (path: string): DomNode => ({ tag: 'div', path, hidden: true });

describe('tierPrefix', () => {
  it('maps preset widths to Tailwind breakpoints', () => {
    expect([360, 402, 640, 834, 1024, 1440, 1920].map(tierPrefix)).toEqual(['', '', 'sm', 'md', 'lg', 'xl', '2xl']);
  });
});

describe('responsiveClasses', () => {
  const P = ['', 'md', 'xl'];

  it('emits base classes once and only changes at higher tiers', () => {
    expect(responsiveClasses([
      el('0', { display: 'flex', flexDir: 'flex-col', padding: 'p-4' }),
      el('0', { display: 'flex', padding: 'p-8' }),
      el('0', { display: 'flex', padding: 'p-8' }),
    ], P)).toEqual(['flex', 'flex-col', 'p-4', 'md:flex-row', 'md:p-8']);
  });

  it('resets a property that disappears to its default', () => {
    expect(responsiveClasses([el('0', { bg: 'bg-[#ff0000]', shadow: 'shadow-[x]' }), el('0'), el('0')], P))
      .toEqual(['bg-[#ff0000]', 'shadow-[x]', 'md:bg-transparent', 'md:shadow-none']);
  });

  it('shows and hides across breakpoints', () => {
    // desktop nav: hidden on mobile
    expect(responsiveClasses([hidden('0'), el('0', { display: 'flex' }), el('0', { display: 'flex' })], P))
      .toEqual(['hidden', 'md:flex']);
    // mobile menu button: hidden from md up, natural display restored nowhere else
    expect(responsiveClasses([el('0'), hidden('0'), hidden('0')], P)).toEqual(['md:hidden']);
    // hidden on mobile, natural display at md
    expect(responsiveClasses([hidden('0'), el('0'), el('0')], P)).toEqual(['hidden', 'md:block']);
  });

  it('emits inherited text props only where they differ from the parent', () => {
    expect(responsiveClasses([
      el('0', {}, { inh: inh({ size: ['text-3xl', false] }) }),
      el('0', {}, { inh: inh({ size: ['text-5xl', false] }) }),
      el('0', {}, { inh: inh({ size: ['text-base', true] }) }), // back to parent's size
    ], P)).toEqual(['text-3xl', 'md:text-5xl', 'xl:text-base']);
  });

  it('skips tiers without data', () => {
    expect(responsiveClasses([undefined, el('0', { padding: 'p-2' }), el('0', { padding: 'p-2' })], P)).toEqual(['md:p-2']);
  });
});

describe('renderResponsive', () => {
  const tree = (w: number, nav: DomNode): DomNode =>
    el('0', w < 768 ? {} : { padding: 'px-8' }, { tag: 'body', children: [nav, el('0.1', {}, { tag: 'p', children: ['Hello ', el('0.1.0', {}, { tag: 'em', nat: 'inline', inline: true, children: ['world'] })] })] });

  it('merges widths into one mobile-first document', () => {
    const html = renderResponsive([
      { width: 1920, tree: tree(1920, el('0.0', { display: 'flex' }, { tag: 'nav', children: ['Menu'] })) },
      { width: 402, tree: tree(402, hidden('0.0')) },
      { width: 360, tree: tree(360, hidden('0.0')) }, // same tier as 402: narrowest wins
      { width: 834, tree: tree(834, el('0.0', { display: 'flex' }, { tag: 'nav', children: ['Menu'] })) },
    ]);
    expect(html).toBe([
      '<body class="md:px-8">',
      '  <nav class="hidden md:flex">Menu</nav>',
      '  <p>Hello <em>world</em></p>',
      '</body>',
      '',
    ].join('\n'));
  });

  it('drops elements hidden at every width', () => {
    expect(renderResponsive([{ width: 400, tree: tree(400, hidden('0.0')) }])).not.toContain('nav');
  });
});

describe('renderResponsive base tier', () => {
  it('treats the narrowest capture as unprefixed even above sm', () => {
    const t: DomNode = { tag: 'body', path: '0', nat: 'block', props: { padding: 'p-4' }, inh: inh() };
    expect(renderResponsive([{ width: 1920, tree: t }])).toBe('<body class="p-4"></body>\n');
  });
});
