import { FormRecord, ResourceRecord, type FormKind, type ResourceStat } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { actionsFor, bulkActions, isMake, madeBy, webAddress } from './actions.ts';
import { crumbsOf, folderQuery, groupQuery, hubQuery, mergeFacets, nameOf, patchQuery, readQuery, sortRecords } from './browse.ts';
import { familyOfStat, languageOf } from './formats.ts';
import { matchPaths, parseJson, pathsTo, treeRows, valueAt } from './json-tree.ts';
import { delimiterOf, nextSort, parseDelimited, viewRows } from './tables.ts';
import { clockOf, lineAt, secondsOf, transcriptLines } from './transcript.ts';
import { modeOf, readKey, viewerFor } from './viewers.ts';

const stat = (format: string | undefined, mime?: string, type: ResourceStat['type'] = 'file'): Pick<ResourceStat, 'format' | 'mime' | 'type'> => ({
  type, ...(format === undefined ? {} : { format }), ...(mime === undefined ? {} : { mime }),
});
const ids = (format: string | undefined, forms: FormKind[] = [], mime?: string): string[] => viewerFor(stat(format, mime), forms).modes.map((m) => `${m.id}:${m.draws}`);

describe('viewerFor', () => {
  it('gives each common type its preview and source, then its forms, then info', () => {
    expect(ids('markdown')).toEqual(['preview:markdown', 'source:code', 'info:info']);
    expect(ids('typescript')).toEqual(['source:code', 'info:info']);
    expect(ids('ruby')).toEqual(['source:code', 'info:info']);
    expect(ids('image', ['description', 'ocr'], 'image/png')).toEqual(['preview:image', 'description:markdown', 'ocr:text', 'info:info']);
    expect(ids('svg', [], 'image/svg+xml')).toEqual(['preview:svg', 'source:code', 'info:info']);
    expect(ids('mermaid')).toEqual(['preview:diagram', 'source:code', 'info:info']);
    expect(ids('html', ['markdown'])).toEqual(['preview:html', 'source:code', 'markdown:markdown', 'info:info']);
    expect(ids('csv', ['table'])).toEqual(['preview:table', 'source:code', 'info:info']);
    expect(ids('markdown', ['markdown'])).toEqual(['preview:markdown', 'source:code', 'info:info']);
    expect(ids('excel', ['table'])).toEqual(['preview:table', 'info:info']);
    expect(ids('pdf', ['pages'])).toEqual(['preview:pdf', 'pages:pages', 'info:info']);
    expect(ids('docx', ['markdown'])).toEqual(['preview:markdown', 'info:info']);
    expect(ids('audio', ['transcript'], 'audio/wav')).toEqual(['preview:audio', 'transcript:text', 'info:info']);
    expect(ids(undefined, [], 'video/mp4')).toEqual(['preview:video', 'info:info']);
    expect(ids('json')).toEqual(['preview:json', 'source:code', 'info:info']);
    expect(ids('yaml')).toEqual(['source:code', 'info:info']);
    expect(ids('text')).toEqual(['source:text', 'info:info']);
    expect(ids('zip')).toEqual(['preview:folder', 'info:info']);
    expect(viewerFor(stat(undefined, undefined, 'folder'), []).modes[0]?.draws).toBe('folder');
    expect(ids('mystery')).toEqual(['preview:binary', 'info:info']);
  });

  it('says what each mode reads: raw text, bytes by URL, a form, or a converted version', () => {
    const md = viewerFor(stat('markdown'), []);
    expect(md.modes.map((m) => readKey(m.reads))).toEqual(['text:raw', 'text:raw', 'none']);
    expect(viewerFor(stat('excel'), ['table']).modes[0]?.reads).toEqual({ as: 'version', form: 'table' });
    expect(viewerFor(stat('docx'), ['markdown']).modes[0]?.reads).toEqual({ as: 'text', form: 'markdown' });
    expect(viewerFor(stat('pdf'), []).modes[0]?.reads).toEqual({ as: 'url' });
  });

  it('offers a form the preview needs, or one that could be made, and falls back to the binary card', () => {
    expect(ids('excel', [], undefined)).toEqual(['preview:binary', 'info:info']);
    expect(viewerFor(stat('excel'), [], [{ kind: 'table' }]).modes[0]).toMatchObject({ draws: 'offer', form: 'table' });
    expect(viewerFor(stat('image', 'image/png'), [], [{ kind: 'description', model: 'm' }]).modes.map((m) => `${m.id}:${m.draws}`)).toEqual(['preview:image', 'description:offer', 'info:info']);
  });

  it("lets systems' viewers replace the preview or add a tab", () => {
    const replaced = viewerFor(stat('markdown'), [], [], [{ system: 'notes', mode: 'replace', label: 'notes' }]);
    expect(replaced.modes[0]).toMatchObject({ id: 'preview', draws: 'system', system: 'notes' });
    const tabbed = viewerFor(stat('sql'), [], [], [{ system: 'db', mode: 'tab', label: 'Schema' }]);
    expect(tabbed.modes.map((m) => m.id)).toEqual(['source', 'system:db', 'info']);
    expect(modeOf(tabbed, 'system:db').label).toBe('Schema');
    expect(modeOf(tabbed, 'nonsense').id).toBe('source');
  });
});

describe('formats', () => {
  it('maps formats to languages and families, with code core does not list', () => {
    expect(languageOf('typescript')).toBe('ts');
    expect(languageOf('shell')).toBe('sh');
    expect(languageOf(undefined)).toBe('');
    expect(familyOfStat({ format: 'dart', type: 'file' })).toBe('code');
    expect(familyOfStat({ format: 'csv', type: 'file' })).toBe('table');
    expect(familyOfStat({ type: 'folder' })).toBe('folder');
  });
});

const record = (uri: string, name: string, extra: { size?: number; modifiedAt?: number; format?: string; forms?: FormKind[] } = {}): ResourceRecord => ResourceRecord.parse({
  uri, system: 'fs', links: [], seenAt: 1_000, ...(extra.forms === undefined ? {} : { forms: extra.forms }),
  stat: { uri, name, type: 'file', version: '1', ...(extra.size === undefined ? {} : { size: extra.size }), ...(extra.modifiedAt === undefined ? {} : { modifiedAt: extra.modifiedAt }), ...(extra.format === undefined ? {} : { format: extra.format }) },
});

describe('the browser URL', () => {
  it('reads the query, dropping keys that are wrong, and writes changes without the defaults', () => {
    expect(readQuery({ view: 'grid', group: 'nope', q: 'readme', uri: 'fs://work/a.md', page: '3', extra: 'x' })).toEqual({ view: 'grid', q: 'readme', uri: 'fs://work/a.md', page: '3' });
    expect(patchQuery({ view: 'grid', q: 'x' }, { view: 'list', in: 'code', q: '' })).toEqual({ in: 'code' });
    expect(patchQuery({}, { size: 'l', sort: 'seen' })).toEqual({ size: 'l' });
  });

  it("makes the hub's queries for the list, a group and the folders", () => {
    expect(hubQuery({ q: 'read', family: 'code', under: 'fs://work/', in: 'code' })).toEqual({ search: 'read', family: 'code', under: 'fs://work/', group: 'type', in: 'code' });
    expect(groupQuery({ view: 'groups', group: 'date' }, { value: 'today', label: 'Today', count: 2 })).toEqual({ group: 'date', in: 'today', limit: 6 });
    expect(folderQuery({ q: 'x', under: 'fs://work/', in: 'a' }, 'fs://work/docs/')).toEqual({ search: 'x', group: 'path', under: 'fs://work/docs/', limit: 1 });
  });

  it('makes the folder trail of a folder', () => {
    expect(crumbsOf('')).toEqual([{ label: 'All resources', under: '' }]);
    expect(crumbsOf('fs://work/docs/plans/')).toEqual([
      { label: 'All resources', under: '' }, { label: 'fs://work', under: 'fs://work/' }, { label: 'docs', under: 'fs://work/docs/' }, { label: 'plans', under: 'fs://work/docs/plans/' },
    ]);
  });

  it('sorts loaded rows and merges facets', () => {
    const rows = [record('fs://a/b.md', 'b.md', { size: 10, modifiedAt: 5 }), record('fs://a/a.md', 'a.md', { size: 30, modifiedAt: 1 }), record('fs://a/c.md', 'c.md')];
    expect(sortRecords(rows, 'name', false).map((r) => r.stat.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(sortRecords(rows, 'size', true).map((r) => r.stat.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(sortRecords(rows, 'seen', false).map((r) => r.stat.name)).toEqual(['b.md', 'a.md', 'c.md']);
    expect(mergeFacets([{ value: 'a', label: 'A', count: 1 }], [{ value: 'a', label: 'A', count: 3 }, { value: 'b', label: 'B', count: 1 }])).toEqual([{ value: 'a', label: 'A', count: 3 }, { value: 'b', label: 'B', count: 1 }]);
    expect(nameOf(record('fs://a/x/', ''))).toBe('x');
  });
});

describe('actions', () => {
  it('offers by family, renames and deletes only hub resources, and narrows bulk to what all allow', () => {
    const image = record('fs://work/a.png', 'a.png', { format: 'image', forms: ['description'] });
    const upload = record('hub://resources/uploads/b.wav', 'b.wav', { format: 'audio' });
    expect(actionsFor(image).map((a) => a.value)).toEqual(['open', 'download', 'copy', 'context', 'make:ocr']);
    expect(actionsFor(upload).map((a) => a.value)).toEqual(['open', 'download', 'copy', 'context', 'make:transcript', 'rename', 'delete']);
    expect(bulkActions([image, upload]).map((a) => a.value)).toEqual(['context']);
    expect(madeBy('make:ocr')).toBe('ocr');
    expect(madeBy('open')).toBeUndefined();
    expect(isMake('make:transcript')).toBe(true);
    expect(FormRecord.shape.kind.safeParse('ocr').success).toBe(true);
  });

  it('offers fetching again only for pages imported from the web, also in bulk', () => {
    const page = ResourceRecord.parse({ ...record('hub://resources/web/site.dev/guide', 'Guide', { format: 'html' }), source: { from: 'web', url: 'https://site.dev/guide', fetchedAt: 1_000, rendered: false } });
    const upload = record('hub://resources/uploads/b.md', 'b.md', { format: 'markdown' });
    expect(webAddress(page)).toBe('https://site.dev/guide');
    expect(webAddress(upload)).toBeUndefined();
    expect(actionsFor(page).map((a) => a.value)).toContain('refetch');
    expect(actionsFor(upload).map((a) => a.value)).not.toContain('refetch');
    expect(bulkActions([page, page]).map((a) => a.value)).toContain('refetch');
    expect(bulkActions([page, upload]).map((a) => a.value)).not.toContain('refetch');
  });
});

describe('tables', () => {
  it('reads csv and tsv with quotes, doubled quotes and line breaks in cells', () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\n"two\nlines",3\n', ',', 'n')).toEqual({ name: 'n', headers: ['a', 'b'], rows: [['x, y', 'say "hi"'], ['two\nlines', '3']] });
    expect(parseDelimited('a\tb\r\n1\t2', delimiterOf('tsv'))).toEqual({ headers: ['a', 'b'], rows: [['1', '2']] });
  });

  it('filters and sorts rows by column kind, keeping row numbers', () => {
    const table = { headers: ['name', 'age'], rows: [['Ada', '36'], ['Grace', '9'], ['Alan', '41']] };
    expect(viewRows(table, { filter: 'a', sort: { column: 1, descending: false } }).map((r) => r.number)).toEqual([2, 1, 3]);
    expect(viewRows(table, { filter: 'gr' }).map((r) => r.cells[0])).toEqual(['Grace']);
    expect(nextSort(undefined, 1)).toEqual({ column: 1, descending: false });
    expect(nextSort({ column: 1, descending: false }, 1)).toEqual({ column: 1, descending: true });
    expect(nextSort({ column: 1, descending: true }, 1)).toBeUndefined();
  });
});

describe('the JSON tree', () => {
  const parsed = parseJson('{"a":{"b":[1,2,{"c":"find me"}]},"odd key":true}', false);
  const root = parsed.ok ? parsed.value : null;

  it('shows the open rows, paths to copy and values at paths', () => {
    const rows = treeRows(root, { open: new Set(['', 'a']), shown: new Map(), search: '' });
    expect(rows.map((r) => (r.kind === 'value' ? `${r.depth}:${r.key}:${r.preview}` : 'more'))).toEqual(['0::{ 2 keys }', '1:a:{ 1 key }', '2:b:[ 3 items ]', '1:odd key:true']);
    expect(valueAt(root, 'a.b[2].c')).toBe('find me');
    expect(valueAt(root, '["odd key"]')).toBe(true);
    expect([...pathsTo(root, 2)]).toEqual(['', 'a']);
  });

  it('opens the way to search matches and pages long branches', () => {
    expect([...matchPaths(root, 'find')]).toEqual(['a.b[2].c']);
    const rows = treeRows(root, { open: new Set(['']), shown: new Map(), search: 'find' });
    expect(rows.filter((r) => r.kind === 'value' && r.match).map((r) => r.path)).toEqual(['a.b[2].c']);
    const long = treeRows(Array.from({ length: 150 }, (_, i) => i), { open: new Set(['']), shown: new Map(), search: '' });
    expect(long.at(-1)).toEqual({ kind: 'more', path: '', depth: 1, hidden: 50 });
  });

  it('reads JSON Lines, and says why text is not JSON', () => {
    expect(parseJson('{"a":1}\n{"a":2}\n', true)).toEqual({ ok: true, value: [{ a: 1 }, { a: 2 }] });
    expect(parseJson('{oops', false).ok).toBe(false);
  });
});

describe('transcripts', () => {
  it('reads stamped lines and SRT cues, and finds the line playing', () => {
    expect(transcriptLines('[0:01] Hello\nplain line\n1\n00:00:05,500 --> 00:00:07,000\nCue text')).toEqual([
      { at: 1, text: 'Hello' }, { at: undefined, text: 'plain line' }, { at: 5.5, text: 'Cue text' },
    ]);
    expect(secondsOf('1:02:03')).toBe(3723);
    expect(clockOf(3723)).toBe('1:02:03');
    expect(clockOf(65)).toBe('1:05');
    expect(lineAt([{ at: 0, text: 'a' }, { at: 5, text: 'b' }], 6)).toBe(1);
  });
});
