import type { ConvertedVersion } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { capTables, LIBRARY_CONVERTER, RegistryConverters, tableRowCounts } from './converters.ts';
import { bytes } from './testing.ts';

const converters = new RegistryConverters({ maxRows: 3 });

describe('converting with @aeye/resources', () => {
  it('makes markdown of an html page, with the converter that made it', async () => {
    const html = '<html><head><title>Guide</title></head><body><nav>menu</nav><main><h1>Guide</h1><p>Read <a href="/a">this</a>.</p><h2>Usage</h2><p>Run it.</p></main></body></html>';
    const made = await converters.convert({ bytes: bytes(html), type: 'html', location: 'https://site.dev/guide', name: 'guide' });
    expect(made?.version.kind).toBe('markdown');
    expect(made?.version.kind === 'markdown' ? made.version.text : '').toContain('## Usage');
    expect(made?.version.kind === 'markdown' ? made.version.text : '').not.toContain('menu');
    expect(made?.converter.startsWith(`${LIBRARY_CONVERTER}:`)).toBe(true);
    expect(converters.current('html')).toContain(made?.converter);
  });

  it('makes tables of a csv, capped, with the real row count kept', async () => {
    const csv = 'name,qty\na,1\nb,2\nc,3\nd,4\ne,5\n';
    const made = await converters.convert({ bytes: bytes(csv), type: 'csv', location: 'file://laptop/t.csv', name: 't.csv' });
    expect(made?.version.kind).toBe('table');
    if (made?.version.kind !== 'table') { return; }
    expect(made.version.tables[0]?.rows).toHaveLength(3);
    expect(tableRowCounts(made.version)).toEqual([5]);
  });

  it('leaves raw text formats alone', async () => {
    expect(await converters.convert({ bytes: bytes('# Hi\n'), type: 'markdown', location: 'file:///a.md', name: 'a.md' })).toBeUndefined();
    expect(converters.current('markdown')).toEqual([]);
    expect(converters.current('typescript')).toEqual([]);
  });

  it('detects types and sections versions with their form', () => {
    expect(converters.typeOf('report.pdf')).toBe('pdf');
    expect(converters.typeOf('x', 'text/html')).toBe('html');
    // a generic text mime says less than the name does
    expect(converters.typeOf('hub://resources/uploads/a.ts', 'text/typescript')).toBe('typescript');
    expect(converters.typeOf('notes.txt', 'text/plain')).toBe('text');
    const sections = converters.sections({ kind: 'markdown', converter: 'c', from: 'html', text: '# A\none\n# B\ntwo\n' });
    expect(sections.map((s) => [s.key, s.form])).toEqual([['A', 'markdown'], ['B', 'markdown']]);
  });

  it('caps only tables over the limit and leaves other versions as they are', () => {
    const small = { kind: 'table', converter: 'c', from: 'csv', tables: [{ headers: ['a'], rows: [['1']] }] } satisfies ConvertedVersion;
    expect(capTables(small, 3)).toBe(small);
    const text: ConvertedVersion = { kind: 'text', converter: 'c', from: 'x', text: 'hi' };
    expect(capTables(text, 3)).toBe(text);
    expect(tableRowCounts(small)).toEqual([1]);
  });
});
