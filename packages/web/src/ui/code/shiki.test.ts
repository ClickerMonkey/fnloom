import { describe, expect, it } from 'vitest';
import { BUNDLED_SHIKI, kindOf, ShikiHighlighter, tokensOf } from './shiki.ts';
import { BUILTIN_HIGHLIGHTER } from './highlighter.ts';
import { MermaidRenderer, sizedSvg } from '../markdown/mermaid.ts';

describe('Shiki tokens', () => {
  it('read scopes into the app’s token kinds, innermost first', () => {
    expect(kindOf(['source.ts', 'comment.line.double-slash.ts'])).toBe('comment');
    expect(kindOf(['source.ts', 'string.quoted.single.ts'])).toBe('string');
    expect(kindOf(['source.ts', 'constant.numeric.decimal.ts'])).toBe('number');
    expect(kindOf(['source.ts', 'storage.type.ts'])).toBe('keyword');
    expect(kindOf(['source.ts', 'keyword.operator.assignment.ts'])).toBe('plain');
    expect(kindOf(['source.ts', 'constant.language.boolean.true.ts'])).toBe('literal');
    expect(kindOf(['source.ts', 'variable.other.ts'])).toBe('plain');
  });

  it('draw each scoped part of a token, merge neighbours of a kind, and join lines', () => {
    const token = (content: string, scope: string) => ({ content, offset: 0, explanation: [{ content, scopes: [{ scopeName: scope, themeMatches: [] }] }] });
    expect(tokensOf([[token('const', 'storage.type'), token(' ', 'source'), token('a', 'variable')], [token('// x', 'comment.line')]])).toEqual([
      { kind: 'keyword', text: 'const' }, { kind: 'plain', text: ' a\n' }, { kind: 'comment', text: '// x' },
    ]);
  });
});

describe('the Shiki highlighter', () => {
  it('answers with the built-in highlighter until a grammar loads, then with Shiki', async () => {
    const shiki = new ShikiHighlighter();
    const code = 'const answer = 42; // the answer';
    expect(shiki.tokens(code, 'typescript')).toEqual(BUILTIN_HIGHLIGHTER.tokens(code, 'typescript'));
    expect(await shiki.prepare('typescript')).toBe(true);
    expect(await shiki.prepare('typescript')).toBe(false);
    const tokens = shiki.tokens(code, 'typescript');
    expect(tokens.map((t) => t.text).join('')).toBe(code);
    expect(tokens).toEqual(expect.arrayContaining([{ kind: 'keyword', text: 'const' }, { kind: 'number', text: '42' }]));
    expect(tokens.find((t) => t.kind === 'comment')?.text).toContain('the answer');
    expect(shiki.knows('typescript')).toBe(true);
  });

  it('knows a grammar by its alias, and leaves a language it has none for to the built-in one', async () => {
    const shiki = new ShikiHighlighter(BUNDLED_SHIKI);
    expect(await shiki.prepare('sh')).toBe(true);
    expect(shiki.tokens('echo "hi"', 'sh').some((t) => t.kind === 'string')).toBe(true);
    expect(await shiki.prepare('no-such-language')).toBe(false);
    expect(shiki.tokens('x', 'no-such-language')).toEqual(BUILTIN_HIGHLIGHTER.tokens('x', 'no-such-language'));
  });
});

describe('the mermaid renderer', () => {
  it('gives the SVG the size of its viewBox, so an image of it has one', () => {
    expect(sizedSvg('<svg id="m" width="100%" style="max-width: 345px;" viewBox="0 0 345.5 234"><g/></svg>'))
      .toBe('<svg width="345.5" height="234" id="m" style="max-width: 345px;" viewBox="0 0 345.5 234"><g/></svg>');
    expect(sizedSvg('<svg><g/></svg>')).toBe('<svg><g/></svg>');
  });

  it('draws strictly, in the theme asked for, one at a time, and reports source it can’t draw', async () => {
    const configs: unknown[] = [];
    const renderer = new MermaidRenderer(() => Promise.resolve({
      initialize: (config) => { configs.push(config); },
      render: (id: string, source: string) => (source === 'bad' ? Promise.reject(new Error('Parse error')) : Promise.resolve({ svg: `<svg id="${id}"></svg>`, diagramType: 'flowchart' })),
    }));
    expect(await renderer.render('graph TD; A-->B', 'mermaid', true)).toEqual({ ok: true, svg: '<svg id="harness-diagram-1"></svg>' });
    expect(await renderer.render('bad', 'mermaid', false)).toEqual({ ok: false, problem: 'Parse error' });
    expect(configs).toMatchObject([{ securityLevel: 'strict', theme: 'dark' }, { securityLevel: 'strict', theme: 'default' }]);
  });
});
