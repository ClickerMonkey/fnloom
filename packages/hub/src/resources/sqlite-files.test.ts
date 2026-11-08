import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileStore } from '@ayepi/files';
import { fsFiles } from '@ayepi/files/fs';
import { afterAll, describe, expect, it } from 'vitest';
import { FileContentStore } from '../api/files.ts';
import { SqliteFiles } from './sqlite-files.ts';
import { openContentFiles } from './storage.ts';
import { fakePresign } from './testing.ts';

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) { await rm(folder, { recursive: true, force: true }); } });

async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'harness-files-'));
  folders.push(made);
  return made;
}

const text = (body: Uint8Array) => new TextDecoder().decode(body);

/** The `FileStore` contract both content stores keep. */
const stores: Array<[string, () => Promise<FileStore>]> = [
  ['fsFiles', async () => fsFiles({ dir: await folder() })],
  ['SqliteFiles', () => Promise.resolve(new SqliteFiles({ file: ':memory:', busyTimeout: 1_000, clock: () => 1_000 }))],
];

describe.each(stores)('the FileStore contract: %s', (_name, make) => {
  it('stores, reads back, overwrites and deletes an object', async () => {
    const files = await make();
    const info = await files.put('content/a', 'hello', { contentType: 'text/plain', metadata: { by: 'test' } });
    expect(info).toMatchObject({ key: 'content/a', size: 5, contentType: 'text/plain' });
    const got = await files.get('content/a');
    expect(got === undefined ? undefined : await got.text()).toBe('hello');
    expect(await files.head('content/a')).toMatchObject({ size: 5, contentType: 'text/plain', metadata: { by: 'test' } });
    await files.put('content/a', new Uint8Array([1, 2, 3]));
    const again = await files.get('content/a');
    expect(again === undefined ? undefined : [...await again.bytes()]).toEqual([1, 2, 3]);
    expect(await files.delete('content/a')).toBe(true);
    expect(await files.delete('content/a')).toBe(false);
    expect(await files.get('content/a')).toBeUndefined();
    expect(await files.head('content/a')).toBeUndefined();
  });

  it('takes streams and blobs and streams bodies back', async () => {
    const files = await make();
    await files.put('s', new Blob(['from a blob']));
    const blob = await files.get('s');
    expect(blob === undefined ? undefined : await blob.text()).toBe('from a blob');
    await files.put('t', new Response('from a stream').body ?? '');
    const streamed = await files.get('t');
    expect(streamed === undefined ? undefined : text(new Uint8Array(await new Response(streamed.stream()).arrayBuffer()))).toBe('from a stream');
  });

  it('lists by prefix in key order, page by page', async () => {
    const files = await make();
    for (const key of ['b/2', 'a/1', 'b/1', 'b/3', 'c/1']) { await files.put(key, key); }
    const first = await files.list('b/', { limit: 2 });
    expect(first.files.map((f) => f.key)).toEqual(['b/1', 'b/2']);
    expect(first.cursor).toBeDefined();
    const second = await files.list('b/', { limit: 2, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) });
    expect(second.files.map((f) => f.key)).toEqual(['b/3']);
    expect(second.cursor).toBeUndefined();
  });

  it('refuses keys that would leave the store', async () => {
    const files = await make();
    await expect(files.put('../x', 'no')).rejects.toThrow();
    await expect(files.put('a//b', 'no')).rejects.toThrow();
  });

  it('backs the hub content store: same bytes stored once, read in chunks', async () => {
    const files = await make();
    const content = new FileContentStore({ files, presign: fakePresign, maxUpload: 1_000, presignTtl: 60_000, clock: () => 0 });
    const ref = await content.put(new TextEncoder().encode('abcdef'), 'text/plain');
    expect(await content.put(new TextEncoder().encode('abcdef'), 'text/plain')).toEqual(ref);
    expect(text(await content.read(ref, 2, 3))).toBe('cde');
    expect(await content.has(ref)).toBe(true);
  });
});

describe('choosing the content store', () => {
  it('opens files by default and the database when asked', async () => {
    const dir = await folder();
    const onDisk = openContentFiles({ at: 'files', dir, database: ':memory:', busyTimeout: 1_000, clock: () => 0 });
    await onDisk.files.put('k', 'v');
    expect((await onDisk.files.head('k'))?.size).toBe(1);
    const inDb = openContentFiles({ at: 'database', dir, database: join(dir, 'hub.db'), busyTimeout: 1_000, clock: () => 0 });
    expect(inDb.files).toBeInstanceOf(SqliteFiles);
    await inDb.files.put('k', 'value');
    expect((await inDb.files.head('k'))?.size).toBe(5);
    inDb.close();
    onDisk.close();
  });
});
