import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import UiCodeBlock from '../UiCodeBlock.vue';
import UiDiagram from '../UiDiagram.vue';
import { HIGHLIGHTER, tokenLines, type Highlighter } from '../code/highlighter.ts';
import { DIAGRAMS, type DiagramRenderer } from './diagram.ts';
import { texToMath, type MathNode } from './math.ts';
import { parseInline } from './inline.ts';
import { parseMarkdown } from './parse.ts';
import UiMarkdown from './UiMarkdown.vue';

/** A tree as compact text: `mfrac(mi:a,mn:2)`. */
function show(nodes: readonly MathNode[]): string {
  return nodes.map((n) => ('text' in n ? `${n.tag}:${n.text}` : `${n.tag}(${show(n.children)})`)).join(',');
}

describe('TeX to MathML', () => {
  it('reads letters, numbers, operators, scripts and fractions', () => {
    expect(show(texToMath('x^2 + 1'))).toBe('msup(mi:x,mn:2),mo:+,mn:1');
    expect(show(texToMath('\\frac{a}{b_1}'))).toBe('mfrac(mi:a,msub(mi:b,mn:1))');
    expect(show(texToMath('\\sqrt[3]{x}'))).toBe('mroot(mi:x,mn:3)');
    expect(show(texToMath('a - b'))).toBe('mi:a,mo:−,mi:b');
  });

  it('reads Greek letters, symbols, functions, text and big operators with limits in display', () => {
    expect(show(texToMath('\\alpha \\leq \\infty'))).toBe('mi:α,mo:≤,mo:∞');
    expect(show(texToMath('\\sin x'))).toBe('mi:sin,mi:x');
    expect(show(texToMath('\\text{if } x'))).toBe('mtext:if ,mi:x');
    expect(show(texToMath('\\sum_{i=1}^n i', true))).toBe('munderover(mo:∑,mrow(mi:i,mo:=,mn:1),mi:n),mi:i');
    expect(show(texToMath('\\sum_{i=1}^n i', false))).toBe('msubsup(mo:∑,mrow(mi:i,mo:=,mn:1),mi:n),mi:i');
  });

  it('reads matrices and keeps an unknown command as its name', () => {
    expect(show(texToMath('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'))).toBe('mrow(mo:(,mtable(mtr(mtd(mi:a),mtd(mi:b)),mtr(mtd(mi:c),mtd(mi:d))),mo:))');
    expect(show(texToMath('\\nope'))).toBe('mtext:\\nope');
  });
});

describe('math and diagrams in markdown', () => {
  it('finds inline math but leaves prices as text', () => {
    expect(parseInline('so $x^2$ grows')).toEqual([{ type: 'text', text: 'so ' }, { type: 'math', tex: 'x^2' }, { type: 'text', text: ' grows' }]);
    expect(parseInline('costs $5 and $10')).toEqual([{ type: 'text', text: 'costs $5 and $10' }]);
    expect(parseInline('a \\$ sign')).toEqual([{ type: 'text', text: 'a $ sign' }]);
  });

  it('finds display formulas in $$ blocks and math fences, open ones too', () => {
    expect(parseMarkdown('$$\na + b\n$$\n\nafter')).toEqual([{ type: 'math', tex: 'a + b' }, { type: 'paragraph', children: [{ type: 'text', text: 'after' }] }]);
    expect(parseMarkdown('$$e = mc^2$$')).toEqual([{ type: 'math', tex: 'e = mc^2' }]);
    expect(parseMarkdown('```math\n\\pi\n```')).toEqual([{ type: 'math', tex: '\\pi' }]);
    expect(parseMarkdown('$$\nstill typing')).toEqual([{ type: 'math', tex: 'still typing' }]);
  });

  it('draws math as MathML and mermaid fences as diagrams', () => {
    const wrapper = mount(UiMarkdown, { props: { source: 'Area $\\pi r^2$\n\n```mermaid\ngraph TD; A-->B\n```' } });
    expect(wrapper.find('math.md-math').attributes('data-tex')).toBe('\\pi r^2');
    expect(wrapper.find('math msup').exists()).toBe(true);
    expect(wrapper.find('[data-testid="diagram"]').exists()).toBe(true);
  });
});

describe('diagrams', () => {
  it('shows the source when there is no renderer', () => {
    const wrapper = mount(UiDiagram, { props: { source: 'graph TD; A-->B' } });
    expect(wrapper.text()).toContain('graph TD');
    expect(wrapper.text()).toContain('shown as their source');
  });

  it('draws with the provided renderer as an image, and says why one fails', async () => {
    const calls: string[] = [];
    const renderer: DiagramRenderer = {
      languages: ['mermaid'],
      render: (source) => { calls.push(source); return Promise.resolve(source.includes('bad') ? { ok: false, problem: 'Parse error' } : { ok: true, value: '<svg/>' }); },
    };
    const good = mount(UiDiagram, { props: { source: 'graph TD; A-->B' }, global: { provide: { [DIAGRAMS]: renderer } } });
    await flushPromises();
    expect(good.find('img').exists()).toBe(true);
    const bad = mount(UiDiagram, { props: { source: 'bad' }, global: { provide: { [DIAGRAMS]: renderer } } });
    await flushPromises();
    expect(bad.text()).toContain("This diagram didn't draw: Parse error");
    expect(calls).toEqual(['graph TD; A-->B', 'bad']);
  });
});

describe('the highlighter', () => {
  it('splits tokens that span lines', () => {
    expect(tokenLines([{ kind: 'comment', text: '/* a\nb */' }, { kind: 'plain', text: ' x\n' }])).toEqual([
      [{ kind: 'comment', text: '/* a' }], [{ kind: 'comment', text: 'b */' }, { kind: 'plain', text: ' x' }],
    ]);
  });

  it('draws with the provided highlighter, again once its grammar has loaded', async () => {
    let ready = false;
    const highlighter: Highlighter = {
      tokens: (code) => [{ kind: ready ? 'keyword' : 'plain', text: code }],
      prepare: () => { ready = true; return Promise.resolve(true); },
      knows: () => true,
    };
    const Host = defineComponent({ setup: () => () => h(UiCodeBlock, { code: 'select', language: 'sql' }) });
    const wrapper = mount(Host, { global: { provide: { [HIGHLIGHTER]: highlighter } } });
    await flushPromises();
    expect(wrapper.find('.tok-keyword').text()).toBe('select');
  });
});
