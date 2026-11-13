import { QualifiedName, ResourceUri, RunId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { allRows } from '../store/rows.ts';
import { ALICE, bytes, resourcesRig, statOf } from './testing.ts';

const who = { actor: ALICE };
/** Every resource visible. */
const all = (): boolean => true;
const PAGE = '<html><head><title>Docs page</title></head><body><main><h1>Docs</h1><p>Words.</p></main></body></html>';

describe('hub resources', () => {
  it('keeps an upload under today\'s folder, converted, and announces it', async () => {
    const r = await resourcesRig();
    const content = await r.content.put(bytes('<p>hello</p>'), 'text/html');
    const record = await r.library.import({ content, name: 'hello.html' }, who);
    expect(record.uri).toBe('hub://resources/uploads/2026-11-07/hello.html');
    expect(record).toMatchObject({ system: 'hub', source: { from: 'upload', by: ALICE }, raw: content, primary: 'markdown', forms: ['markdown'] });
    expect(record.stat).toMatchObject({ name: 'hello.html', format: 'html', mime: 'text/html', version: content.hash, type: 'file' });
    expect(r.bus.of('resources.changed')).toEqual([
      { system: 'hub', changes: [{ uri: record.uri, change: 'added', version: content.hash }] },
    ]);
  });

  it('keeps the same content once, and other content under a taken name beside it', async () => {
    const r = await resourcesRig();
    const one = await r.content.put(bytes('one'), 'text/plain');
    const two = await r.content.put(bytes('two'), 'text/plain');
    const a = await r.library.import({ content: one, name: 'n.txt', path: 'notes' }, who);
    const again = await r.library.import({ content: one, name: 'n.txt', path: 'notes' }, who);
    const b = await r.library.import({ content: two, name: 'n.txt', path: 'notes' }, who);
    expect(again.uri).toBe(a.uri);
    expect(a.uri).toBe('hub://resources/notes/n.txt');
    expect(b.uri).toBe(`hub://resources/notes/n-${two.hash.slice(0, 8)}.txt`);
  });

  it('refuses content that was never uploaded, and paths that climb out', async () => {
    const r = await resourcesRig();
    await expect(r.library.import({ content: { hash: 'a'.repeat(64), size: 1, mime: 'text/plain' }, name: 'x' }, who)).rejects.toMatchObject({ status: 404 });
    const content = await r.content.put(bytes('x'), 'text/plain');
    const record = await r.library.import({ content, name: '../../etc/passwd', path: '../../up' }, who);
    expect(record.uri.startsWith('hub://resources/up/')).toBe(true);
    expect(record.uri.split('/')).not.toContain('..');
    expect(record.uri.split('/')).toHaveLength(5);
  });

  it('imports a URL under its host, without credentials in what it shows, and fetches it again in place', async () => {
    const r = await resourcesRig();
    const url = 'https://user:pw@site.dev/docs/page?token=secret&x=1';
    r.fetcher.pages.set(url, { bytes: bytes(PAGE), mime: 'text/html', finalUrl: 'https://site.dev/docs/page?token=secret&x=1', rendered: true, title: 'Docs page' });
    const record = await r.library.import({ url }, who);
    expect(record.uri).toMatch(/^hub:\/\/resources\/web\/site\.dev\/docs\/page~[0-9a-f]{8}$/);
    expect(record.stat).toMatchObject({ name: 'Docs page', type: 'page', format: 'html' });
    expect(record.source).toMatchObject({ from: 'web', url: 'https://site.dev/docs/page?x=1', rendered: true });
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(record.primary).toBe('markdown');
    r.fetcher.pages.set(url, { bytes: bytes(PAGE.replace('Words', 'New words')), mime: 'text/html', finalUrl: 'https://site.dev/docs/page?x=1', rendered: false });
    const again = await r.library.import({ url }, who);
    expect(again.uri).toBe(record.uri);
    expect(again.raw?.hash).not.toBe(record.raw?.hash);
    // a crawl names a folder, which keeps its pages under one root (and can't climb out of web/)
    const crawled = await r.library.import({ url, folder: '../crawls/site.dev-20261108-1200' }, who);
    expect(crawled.uri.startsWith('hub://resources/web/crawls/site.dev-20261108-1200/site.dev/docs/page~')).toBe(true);
  });

  it('keeps a fn\'s output under its run', async () => {
    const r = await resourcesRig();
    const content = await r.content.put(bytes('an image, say'), 'image/png');
    const record = await r.library.keep({ content, name: 'out.png', run: RunId.parse('run_1'), fn: QualifiedName.parse('art/draw') });
    expect(record.uri).toBe('hub://resources/runs/run_1/out.png');
    expect(record.source).toEqual({ from: 'run', run: 'run_1', fn: 'art/draw' });
  });

  it('renames and deletes hub resources only, refusing a delete while context still points at it', async () => {
    const r = await resourcesRig();
    const content = await r.content.put(bytes('# Title\ntext\n'), 'text/markdown');
    const record = await r.library.import({ content, name: 'a.md' }, who);
    expect((await r.library.rename(record.uri, '  Better name ', who)).stat.name).toBe('Better name');
    await expect(r.library.rename(ResourceUri.parse('file://main/a.md'), 'x', who)).rejects.toMatchObject({ status: 403 });
    await r.context.fromResource({ uri: record.uri, copy: 'live' }, who);
    expect(await r.library.remove(record.uri, who)).toEqual({ deleted: false, referencedBy: 2 });
    for (const item of await allRows(r.store.table('context'))) { await r.store.table('context').remove(item.name); }
    expect(await r.library.remove(record.uri, who)).toEqual({ deleted: true, referencedBy: 0 });
    expect(await r.store.table('resources').get(record.uri)).toBeUndefined();
    await expect(r.library.remove(record.uri, who)).rejects.toMatchObject({ status: 404 });
  });
});

describe('browsing', () => {
  async function filled() {
    const r = await resourcesRig();
    const put = async (name: string, text: string, mime: string) => r.library.import({ content: await r.content.put(bytes(text), mime), name, path: 'docs' }, who);
    await put('a.md', '# A\n', 'text/markdown');
    await put('b.html', '<p>b</p>', 'text/html');
    await put('c.csv', 'x,y\n1,2\n', 'text/csv');
    const fs = ResourceUri.parse('file://main/src/x.ts');
    r.raw.serve({ stat: statOf(fs, { format: 'typescript', mime: 'text/plain' }), bytes: bytes('export const x = 1;\n') });
    await r.forms.snapshot(fs, who);
    return r;
  }

  it('groups by type with counts, and narrows to one group', async () => {
    const r = await filled();
    const page = await r.library.browse({ group: 'type' }, who, all);
    expect(page.items).toHaveLength(4);
    expect(page.facets).toEqual([
      { value: 'document', label: 'Documents', count: 1 }, { value: 'code', label: 'Code', count: 1 }, { value: 'table', label: 'Tables', count: 1 },
      { value: 'web', label: 'Web pages', count: 1 },
    ]);
    const tables = await r.library.browse({ group: 'type', in: 'table' }, who, all);
    expect(tables.items.map((i) => i.stat.name)).toEqual(['c.csv']);
    expect(tables.facets).toHaveLength(4);
  });

  it('groups by source and by folder, and filters by forms', async () => {
    const r = await filled();
    const bySource = await r.library.browse({ group: 'source' }, who, all);
    expect(bySource.facets).toEqual([{ value: 'upload', label: 'Uploads', count: 3 }, { value: 'system:fs', label: 'fs', count: 1 }]);
    // what the asker can't see is out of the counts and the page, not only the items
    const hidden = await r.library.browse({ group: 'source', limit: 2 }, who, (uri) => !uri.startsWith('file://'));
    expect(hidden.facets).toEqual([{ value: 'upload', label: 'Uploads', count: 3 }]);
    expect(hidden.items).toHaveLength(2);
    expect(hidden.cursor).toBe('2');
    const folders = await r.library.browse({ group: 'path', under: 'hub://resources/' }, who, all);
    expect(folders.facets).toEqual([{ value: 'hub://resources/docs/', label: 'docs', count: 3 }]);
    expect((await r.library.browse({ form: 'table' }, who, all)).items.map((i) => i.stat.name)).toEqual(['c.csv']);
    expect((await r.library.browse({ missing: 'markdown', source: 'upload' }, who, all)).items.map((i) => i.stat.name).sort()).toEqual(['a.md', 'c.csv']);
    expect((await r.library.browse({ search: 'B.HT' }, who, all)).items.map((i) => i.stat.name)).toEqual(['b.html']);
    expect((await r.library.browse({ family: 'code' }, who, all)).items.map((i) => i.uri)).toEqual(['file://main/src/x.ts']);
  });

  it('pages with a cursor', async () => {
    const r = await filled();
    const first = await r.library.browse({ limit: 3 }, who, all);
    expect(first.items).toHaveLength(3);
    const rest = await r.library.browse({ limit: 3, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) }, who, all);
    expect(rest.items).toHaveLength(1);
    expect(rest.cursor).toBeUndefined();
  });
});
