import { describe, expect, it } from 'vitest';
import { BUNDLED_SHIKI, kindOf, ShikiHighlighter, tokensOf } from './shiki.ts';
import { BUILTIN_HIGHLIGHTER, type Highlighter } from './highlighter.ts';
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
  }, 30_000); // loading the grammar and its wasm engine is slow when the whole suite runs at once

  it('answers with the built-in highlighter when Shiki throws mid-tokenize (a pass that stopped early)', async () => {
    let throws = false;
    const fallback: Highlighter = {
      tokens: (code) => [{ kind: 'plain', text: `fallback: ${code}` }],
      prepare: () => Promise.resolve(false),
      knows: () => false,
    };
    const shiki = new ShikiHighlighter({
      async core() {
        const real = await BUNDLED_SHIKI.core();
        return {
          loadLanguage: (...langs) => real.loadLanguage(...langs),
          // a fixed pass, not the real one: under a loaded full run the real first pass can pass its time limit too
          codeToTokensBase: (code) => {
            if (throws) { throw new TypeError("Cannot read properties of undefined (reading 'startIndex')"); }
            return [[{ content: code, offset: 0, explanation: [{ content: 'const', scopes: [{ scopeName: 'storage.type', themeMatches: [] }] }] }]];
          },
        };
      },
      languages: () => BUNDLED_SHIKI.languages(),
    }, fallback);
    const code = 'const answer = 42;';
    expect(await shiki.prepare('typescript')).toBe(true);
    expect(shiki.tokens(code, 'typescript')).toContainEqual({ kind: 'keyword', text: 'const' });
    throws = true;
    expect(shiki.tokens(code, 'typescript')).toEqual([{ kind: 'plain', text: 'fallback: const answer = 42;' }]);
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
    expect(await renderer.render('graph TD; A-->B', 'mermaid', true)).toEqual({ ok: true, value: '<svg id="harness-diagram-1"></svg>' });
    expect(await renderer.render('bad', 'mermaid', false)).toEqual({ ok: false, problem: 'Parse error' });
    expect(configs).toMatchObject([{ securityLevel: 'strict', theme: 'dark' }, { securityLevel: 'strict', theme: 'default' }]);
  });

  it('draws in the app’s own font and colours when it can read them', async () => {
    const configs: unknown[] = [];
    const look = { font: 'system-ui', background: '#fafafa', surface: '#f0f0f0', border: '#cccccc', text: '#222222', muted: '#666666', accent: '#3355ff' };
    const renderer = new MermaidRenderer(() => Promise.resolve({
      initialize: (config) => { configs.push(config); },
      render: (id: string) => Promise.resolve({ svg: `<svg id="${id}"></svg>`, diagramType: 'flowchart' }),
    }), () => look);
    await renderer.render('graph TD; A-->B', 'mermaid', true);
    expect(configs).toMatchObject([{ securityLevel: 'strict', theme: 'base', fontFamily: 'system-ui', themeVariables: { darkMode: true, primaryColor: '#f0f0f0', nodeBorder: '#cccccc', lineColor: '#666666' } }]);
  });
});
