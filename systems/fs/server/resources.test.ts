import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { ResourceChange } from '@harness/core';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AeyeDocuments, toResourceLink } from './documents.ts';
import { FileService } from './files.ts';
import { RootGuard, fileUri } from './paths.ts';
import { FsResources, versionOf } from './resources.ts';
import { DiskSnapshots } from './snapshots.ts';
import { tempFolder } from './testing.ts';

type Listener = (event: 'rename' | 'change', file: string) => void;

describe('FsResources', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let resources: FsResources;
  const listeners = new Map<string, Listener>();

  beforeEach(async () => {
    tmp = await tempFolder();
    await mkdir(`${tmp.path}/docs`);
    await mkdir(`${tmp.path}/node_modules`);
    await writeFile(`${tmp.path}/docs/guide.md`, '# Guide\n\nSee [the code](../src/a.ts) and [site](https://example.com).\n');
    await mkdir(`${tmp.path}/src`);
    await writeFile(`${tmp.path}/src/a.ts`, "import { b } from './b.ts';\nimport { z } from 'zod';\nexport const a = b;\n");
    for (const n of [1, 2, 3]) { await writeFile(`${tmp.path}/f${n}.txt`, `file ${n}`); }
    const guard = new RootGuard([{ path: tmp.path, name: 'work', writable: false, index: 'on-read' }]);
    const files = new FileService(new DiskSnapshots(`${tmp.path}/../.s`), { readLines: 100, fileMax: 10_000, listLimit: 100, ignore: ['node_modules'] });
    resources = new FsResources({
      guard: () => guard,
      files,
      documents: new AeyeDocuments(createDefaultResourceRegistry()),
      limits: { page: 2, textMax: 1_000, ignore: ['node_modules'], debounce: 50 },
      watch: (folder, listener) => { listeners.set(folder, listener); return () => { listeners.delete(folder); }; },
    });
  });
  afterEach(() => tmp.cleanup());

  it('serves each root with its index mode', async () => {
    expect(await resources.roots()).toEqual([{
      uri: fileUri(tmp.path), name: 'work', description: `Files under ${tmp.path} (read-only).`, index: 'on-read', ignore: ['**/node_modules/**'], watch: true,
    }]);
  });

  it('lists folders by page with a cursor, leaving out ignored folders', async () => {
    const first = await resources.list(fileUri(tmp.path));
    expect(first.items.map((s) => s.name)).toEqual(['docs', 'src']);
    expect(first.cursor).toBe('2');
    const second = await resources.list(fileUri(tmp.path), first.cursor);
    expect(second.items.map((s) => s.name)).toEqual(['f1.txt', 'f2.txt']);
    const last = await resources.list(fileUri(tmp.path), second.cursor);
    expect(last.items.map((s) => s.name)).toEqual(['f3.txt']);
    expect(last.cursor).toBeUndefined();
  });

  it('stats files with a format, size and version, and the root by its name', async () => {
    const stat = await resources.stat(fileUri(`${tmp.path}/docs/guide.md`));
    expect(stat).toMatchObject({ name: 'guide.md', type: 'file', format: 'markdown', size: 70 });
    expect(stat?.version).toMatch(/^\d+-70$/);
    expect((await resources.stat(fileUri(tmp.path)))?.name).toBe('work');
    expect(await resources.stat(fileUri(`${tmp.path}/missing`))).toBeUndefined();
    expect(await resources.stat('https://example.com/x')).toBeUndefined();
    expect(versionOf(new Date(5), 3)).toBe('5-3');
  });

  it('reads a folder as its children', async () => {
    const read = await resources.read(fileUri(`${tmp.path}/src`), ['links', 'text']);
    expect(read.links).toEqual([{ uri: fileUri(`${tmp.path}/src/a.ts`), raw: 'a.ts', kind: 'child', title: 'a.ts' }]);
    expect(read.text).toEqual({ inline: 'a.ts' });
    expect((await resources.read(fileUri(`${tmp.path}/src`), [])).links).toBeUndefined();
  });

  it('reads markdown with its links resolved to file URIs', async () => {
    const read = await resources.read(fileUri(`${tmp.path}/docs/guide.md`), ['text', 'links']);
    expect(read.text !== undefined && 'inline' in read.text ? read.text.inline : '').toContain('# Guide');
    expect(read.links).toContainEqual({ raw: '../src/a.ts', kind: 'link', uri: fileUri(`${tmp.path}/src/a.ts`), title: 'the code' });
    expect(read.links?.some((l) => l.kind === 'external' && l.raw.startsWith('https://example.com'))).toBe(true);
  });

  it('reads code with its imports', async () => {
    const read = await resources.read(fileUri(`${tmp.path}/src/a.ts`), ['links']);
    expect(read.links).toContainEqual({ raw: './b.ts', kind: 'import', uri: fileUri(`${tmp.path}/src/b.ts`) });
    expect(read.links).toContainEqual({ raw: 'zod', kind: 'import' });
  });

  it('refuses URIs outside the roots and reads only the stat when nothing else is wanted', async () => {
    await expect(resources.read('file:///definitely/elsewhere.txt', ['text'])).rejects.toThrow(/isn't under/);
    await expect(resources.read(fileUri(`${tmp.path}/gone.txt`), ['text'])).rejects.toThrow(/doesn't exist/);
    expect(Object.keys(await resources.read(fileUri(`${tmp.path}/f1.txt`), ['bytes']))).toEqual(['stat']);
  });

  it('reports watched changes once per path after the debounce, skipping ignored folders', async () => {
    vi.useFakeTimers();
    try {
      const seen: ResourceChange[][] = [];
      const stop = resources.watch([fileUri(`${tmp.path}/docs`)], (changes) => { seen.push(changes); });
      const listener = listeners.get(tmp.path);
      if (listener === undefined) { throw new Error('not watching'); }
      await writeFile(`${tmp.path}/docs/new.md`, 'new');
      listener('rename', 'docs/new.md');
      listener('change', 'docs/new.md');
      listener('change', 'docs/guide.md');
      listener('change', 'src/a.ts');
      listener('change', 'node_modules/x.js');
      await rm(`${tmp.path}/docs/guide.md`);
      await vi.advanceTimersByTimeAsync(60);
      await vi.waitFor(() => { expect(seen).toHaveLength(1); });
      expect(seen[0]?.map((c) => [c.uri.slice(-6), c.change])).toEqual([['new.md', 'added'], ['ide.md', 'removed']]);
      stop();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('toResourceLink', () => {
  it('keeps URLs, resolves relative paths and leaves packages raw', () => {
    const from = '/srv/work/src/a.ts';
    expect(toResourceLink({ value: 'https://x.io/a', kind: 'external' }, from, 'markdown')).toEqual({ raw: 'https://x.io/a', kind: 'external', uri: 'https://x.io/a' });
    expect(toResourceLink({ value: 'mailto me', kind: 'external' }, from, undefined)).toEqual({ raw: 'mailto me', kind: 'external' });
    expect(toResourceLink({ value: '#top', kind: 'resource', title: 'Top' }, from, 'markdown')).toEqual({ raw: '#top', kind: 'link', title: 'Top' });
    expect(toResourceLink({ value: 'react', kind: 'resource' }, from, 'typescript')).toEqual({ raw: 'react', kind: 'import' });
  });
});
