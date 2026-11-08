import { ResourceUri, type ConvertedVersion, type ResourceStat } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { versionText } from '@aeye/resources/versions';
import { globToRegExp, hubSectioners, matchScore, TABLE_SECTION_ROWS, type Sectioner } from './sectioners.ts';

const stat = (uri: string, extra: Partial<ResourceStat> = {}): ResourceStat => ({ uri: ResourceUri.parse(uri), name: uri.split('/').at(-1) ?? uri, type: 'file', version: 'v1', ...extra });

function sectioner(local: string): Sectioner {
  const found = hubSectioners().find((s) => s.name === `hub/${local}`);
  if (found === undefined) { throw new Error(`no hub/${local}`); }
  return found;
}

/** Each section's key and its text. */
function cut(local: string, text: string, uri = 'file:///a.md') {
  return sectioner(local).sections({ text, stat: stat(uri) }).map((s) => [s.key, text.slice(s.start, s.end)]);
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

describe('sectioning forms', () => {
  const tableVersion = (rows: number): ConvertedVersion => ({
    kind: 'table', converter: 'test', from: 'excel',
    tables: [
      { name: 'Sales', sheetName: 'Sales', sheetIndex: 0, headers: ['region', 'total'], rows: [['north', '1'], ['south', '2']] },
      { name: 'Stock', sheetName: 'Stock', sheetIndex: 1, headers: ['item', 'count'], rows: Array.from({ length: rows }, (_, i) => [`item ${i + 1}`, String(i)]) },
    ],
  });

  it('gives a two-sheet workbook one section per table', () => {
    const version = tableVersion(3);
    const text = versionText(version);
    const sections = sectioner('tables').sections({ text, stat: stat('file:///book.xlsx', { format: 'excel' }), form: 'table', version });
    expect(sections.map((s) => [s.key, s.form])).toEqual([['Sales', 'table'], ['Stock', 'table']]);
    expect(text.slice(sections[1]?.start, sections[1]?.end)).toContain('item 3');
  });

  it('splits a large table into row groups with the header repeated in each', () => {
    const version = tableVersion(TABLE_SECTION_ROWS + 5);
    const text = versionText(version);
    const sections = sectioner('tables').sections({ text, stat: stat('file:///book.xlsx', { format: 'excel' }), form: 'table', version });
    expect(sections.map((s) => s.key)).toEqual(['Sales', `Stock > rows 1-${TABLE_SECTION_ROWS}`, `Stock > rows ${TABLE_SECTION_ROWS + 1}-${2 * TABLE_SECTION_ROWS}`]);
    const second = sections[2];
    expect(second?.embedText).toContain('| item | count |');
    expect(second?.embedText).toContain(`item ${TABLE_SECTION_ROWS + 5}`);
    expect(text.slice(second?.start, second?.end).startsWith(`| item ${TABLE_SECTION_ROWS + 1} |`)).toBe(true);
  });

  it('cuts a table form it was not given the version of as one whole section', () => {
    expect(sectioner('tables').sections({ text: 'a,b', stat: stat('file:///t.csv'), form: 'table' }).map((s) => s.key)).toEqual(['(root)']);
  });

  it('matches by the form a resource is read in', () => {
    const page = stat('https://site.dev/a', { format: 'html' });
    expect(matchScore({ format: 'markdown' }, page)).toBeUndefined();
    expect(matchScore({ format: 'markdown' }, page, 'markdown')).toBe(1);
    expect(matchScore({ format: 'html' }, page, 'markdown')).toBe(1);
    expect(matchScore({ form: 'table' }, page, 'markdown')).toBeUndefined();
    expect(matchScore({ form: 'table' }, stat('file:///b.xlsx', { format: 'excel' }), 'table')).toBe(1);
  });

  it('marks sections with the form they are of', () => {
    expect(sectioner('headings').sections({ text: '# A\nb\n', stat: stat('https://site.dev/a', { format: 'html' }), form: 'markdown' })[0]?.form).toBe('markdown');
    expect(sectioner('headings').sections({ text: '# A\nb\n', stat: stat('file:///a.md') })[0]?.form).toBeUndefined();
  });
});
