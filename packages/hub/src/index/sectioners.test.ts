import { ResourceUri, type ResourceStat } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { globToRegExp, hubSectioners, matchScore, type Sectioner } from './sectioners.ts';

const stat = (uri: string, extra: Partial<ResourceStat> = {}): ResourceStat => ({ uri: ResourceUri.parse(uri), name: uri.split('/').at(-1) ?? uri, type: 'file', version: 'v1', ...extra });

function sectioner(local: string): Sectioner {
  const found = hubSectioners().find((s) => s.name === `hub/${local}`);
  if (found === undefined) { throw new Error(`no hub/${local}`); }
  return found;
}

/** Each section's key and its text. */
function cut(local: string, text: string, uri = 'file:///a.md') {
  return sectioner(local).sections(text, stat(uri)).map((s) => [s.key, text.slice(s.start, s.end)]);
}

describe('the hub sectioners', () => {
  it('cuts markdown by heading path, keeping the preamble and ignoring headings in code fences', () => {
    const text = 'intro\n# Guide\nhello\n```\n# not a heading\n```\n## Usage\nrun it\n# Guide\nagain\n';
    expect(cut('headings', text)).toEqual([
      ['(root)', 'intro\n'],
      ['Guide', '# Guide\nhello\n```\n# not a heading\n```\n'],
      ['Guide > Usage', '## Usage\nrun it\n'],
      ['Guide ~2', '# Guide\nagain\n'],
    ]);
  });

  it('keys survive content moving', () => {
    const before = cut('headings', '# A\none\n# B\ntwo\n').map(([key]) => key);
    const after = cut('headings', 'new intro\n# B\ntwo, longer\n# A\none\n').map(([key]) => key);
    expect(after).toEqual(['(root)', ...before.slice().reverse()]);
  });

  it('cuts code at top-level symbols', () => {
    const text = "import x from 'x';\n\nexport function read() {\n  return 1;\n}\nclass Store {}\nexport const LIMIT = 3;\n";
    expect(cut('symbols', text, 'file:///a.ts').map(([key]) => key)).toEqual(['(root)', 'read', 'Store', 'LIMIT']);
  });

  it('cuts pages, paragraphs and the whole', () => {
    expect(cut('pages', 'one\ftwo')).toEqual([['Page 1', 'one'], ['Page 2', 'two']]);
    expect(cut('paragraphs', 'First one here.\nStill first.\n\nSecond.\n')).toEqual([['First one here. Still first.', 'First one here.\nStill first.'], ['Second.', 'Second.']]);
    expect(cut('paragraphs', '')).toEqual([['(root)', '']]);
    expect(cut('whole', 'all of it')).toEqual([['(root)', 'all of it']]);
  });
});

describe('matching sectioners to resources', () => {
  it('turns globs into patterns over URIs', () => {
    expect(globToRegExp('**/*.{ts,md}').test('file:///repo/src/a.ts')).toBe(true);
    expect(globToRegExp('**/*.{ts,md}').test('file:///repo/src/a.tsx')).toBe(false);
    expect(globToRegExp('docs/*.md').test('file:///repo/docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('file:///repo/docs/deep/a.md')).toBe(false);
    expect(globToRegExp('a?.txt').test('file:///ab.txt')).toBe(true);
  });

  it('scores a match by how much it pins down', () => {
    const md = stat('file:///a.md', { format: 'markdown', mime: 'text/markdown' });
    expect(matchScore({}, md)).toBe(0);
    expect(matchScore({ format: 'markdown' }, md)).toBe(1);
    expect(matchScore({ format: 'markdown', mime: 'text/markdown', glob: '*.md' }, md)).toBe(3);
    expect(matchScore({ format: 'pdf' }, md)).toBeUndefined();
    expect(matchScore({ mime: 'text/plain' }, md)).toBeUndefined();
    expect(matchScore({ glob: '*.txt' }, md)).toBeUndefined();
  });
});
