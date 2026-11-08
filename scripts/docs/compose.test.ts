/** Composing the guide from a hand-made API model: order, reference rendering, directives, and every refusal. */
import { describe, expect, it } from 'vitest';
import { anchor, composeGuide, fence, GuideProblems, pruneReached, regionOf, renderReached, type ComposeInput, type Topic } from './compose.ts';
import type { ApiItem, ApiModel } from './extract.ts';

const item = (name: string, extra: Partial<ApiItem> = {}): ApiItem => ({
  name, module: '@x/sdk', kinds: ['function'], docs: `Docs of ${name}.`, code: `function ${name}(): void;`, file: 'x/index.ts', reaches: [], ...extra,
});

const API: ApiModel = {
  exports: [item('make', { reaches: ['Point'] }), item('Thing', { kinds: ['interface'], code: 'interface Thing {}' }), item('secret', { reaches: ['Wire'] })],
  reached: [item('Point', { module: 'core/point.ts', kinds: ['type'], code: 'type Point = { x: number };' }), item('Wire', { module: 'core/wire.ts', kinds: ['type'], code: 'type Wire = {};' })],
  external: [item('Builder', { module: '@x/gin', kinds: ['interface'], code: 'interface Builder {}' })],
};

const INTRO: Topic = { id: 'intro', title: 'Start', exports: [] };
const MAKE: Topic = { id: 'make', title: 'Making things', exports: ['make', 'Thing'], external: ['Builder'] };
const INSIDE: Topic = { id: 'inside', title: 'Inside', exports: ['secret'], reach: false };
const OUTLINE: readonly Topic[] = [INTRO, MAKE, INSIDE];

const SOURCE = [
  'const a = 1;',
  '// #region part',
  '  const b = 2;',
  '  // #region inner',
  '  const c = 3;',
  '  // #endregion inner',
  '// #endregion part',
].join('\n');

function input(over: Partial<ComposeInput> = {}): ComposeInput {
  const prose: Record<string, string> = {
    intro: 'Hello.\n\n<!-- generate: hello -->',
    make: 'Make things.\n\n<!-- include: src/a.ts#part -->',
    inside: 'Inside.',
  };
  return {
    title: 'Guide',
    intro: 'What it is.',
    outline: OUTLINE,
    api: API,
    prose: (id) => prose[id],
    file: (path) => (path === 'src/a.ts' ? SOURCE : undefined),
    generators: { hello: () => 'Generated hello.\n' },
    ...over,
  };
}

function problemsOf(over: Partial<ComposeInput>): readonly string[] {
  try {
    composeGuide(input(over));
  } catch (error) {
    if (error instanceof GuideProblems) { return error.problems; }
    throw error;
  }
  return [];
}

describe('composeGuide', () => {
  it('writes the title, contents and numbered topics in outline order', () => {
    const text = composeGuide(input());
    expect(text.startsWith('# Guide\n\nWhat it is.\n\n## Contents\n\n1. [Start](#1-start)\n2. [Making things](#2-making-things)\n3. [Inside](#3-inside)\n')).toBe(true);
    expect(text.indexOf('## 1. Start')).toBeLessThan(text.indexOf('## 2. Making things'));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('expands generators and includes, regions without their markers', () => {
    const text = composeGuide(input());
    expect(text).toContain('Hello.\n\nGenerated hello.');
    expect(text).toContain('_From `src/a.ts`:_\n\n```ts\nconst b = 2;\nconst c = 3;\n```');
    expect(text).not.toContain('#region');
  });

  it('renders each placed export with its origin, docs, code and links to reached types', () => {
    const text = composeGuide(input());
    expect(text).toContain("### Reference: making things\n\n#### `make`\n\nfunction · `import { make } from '@x/sdk'`\n\nDocs of make.\n\n```ts\nfunction make(): void;\n```\n\nRefers to: [`Point`](#core-point).");
    expect(text).toContain('#### `Builder`');
    expect(text.indexOf('#### `make`')).toBeLessThan(text.indexOf('#### `Thing`'));
  });

  it('refuses an export no topic places, naming it', () => {
    expect(problemsOf({ outline: [INTRO, { ...MAKE, exports: ['make'] }, INSIDE] }))
      .toEqual(['exports no topic places (add each to a topic in scripts/docs/outline.ts): Thing']);
  });

  it('refuses a placed name that is not exported, and a name placed twice', () => {
    const outline: Topic[] = [...OUTLINE, { id: 'more', title: 'More', exports: ['gone', 'make'] }];
    const problems = problemsOf({ outline, prose: (id) => (id === 'more' ? '' : input().prose(id)) });
    expect(problems).toContain('more places gone, which is not exported (remove it from the outline)');
    expect(problems).toContain('make is placed in both make and more');
  });

  it('refuses a missing prose file, generator, include and region, and an unused generator', () => {
    const problems = problemsOf({
      prose: (id) => ({ intro: '<!-- generate: nope -->', make: '<!-- include: src/none.ts -->\n<!-- include: src/a.ts#missing -->' }[id]),
      generators: { hello: () => '', spare: () => '' },
    });
    expect(problems).toEqual([
      'intro asks for generator nope, which doesn\'t exist',
      'make includes src/none.ts, which doesn\'t exist',
      'make includes src/a.ts#missing, but src/a.ts has no region missing',
      'inside has no prose file (prose/inside.md)',
      'generators no prose uses (add <!-- generate: name --> or remove them): hello, spare',
    ]);
  });

  it('refuses an external name that was not extracted', () => {
    expect(problemsOf({ outline: [INTRO, { ...MAKE, external: ['Other'] }, INSIDE] })).toEqual(['make places external Other, which was not extracted']);
  });
});

describe('pruneReached', () => {
  it('keeps only the reached types that reaching topics refer to', () => {
    const pruned = pruneReached(API, OUTLINE);
    expect(pruned.reached.map((i) => i.name)).toEqual(['Point']);
    expect(pruned.exports.find((i) => i.name === 'secret')?.reaches).toEqual([]);
  });

  it('renders the reached types under their anchors', () => {
    expect(renderReached(pruneReached(API, OUTLINE))).toContain('#### <a id="core-point"></a>`Point`\n\ntype · declared in `x/index.ts`');
  });
});

describe('helpers', () => {
  it('makes anchors from headings', () => {
    expect(anchor('2. The `client`: renderers, inputs')).toBe('2-the-client-renderers-inputs');
    expect(anchor('23. Packaging: system.json, build')).toBe('23-packaging-systemjson-build');
    expect(anchor('core-RunInfo')).toBe('core-runinfo');
  });

  it('fences text with more backticks than it holds', () => {
    expect(fence('a ``` b\n\n', 'md')).toBe('````md\na ``` b\n````');
    expect(fence('plain', 'ts')).toBe('```ts\nplain\n```');
  });

  it('cuts regions, nested ones included, and whole files without markers', () => {
    expect(regionOf(SOURCE, 'inner')).toBe('const c = 3;');
    expect(regionOf(SOURCE, undefined)).toBe('const a = 1;\n  const b = 2;\n  const c = 3;');
    expect(regionOf('a\r\nb', undefined)).toBe('a\nb');
    expect(regionOf(SOURCE, 'none')).toBeUndefined();
  });
});
