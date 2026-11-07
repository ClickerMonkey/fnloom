import { mkdir, writeFile } from 'node:fs/promises';
import { UserInfo, mintId } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileService } from './files.ts';
import type { Document, Documents } from './index.ts';
import { FileMentions, PathIndex, rank, score } from './mentions.ts';
import { RootGuard, fileUri } from './paths.ts';
import { DiskSnapshots } from './snapshots.ts';
import { tempFolder } from './testing.ts';
import type { WalkEntry } from './walk.ts';

const entry = (relative: string): WalkEntry => ({ path: `/r/${relative}`, relative, name: relative.split('/').pop() ?? relative, type: 'file', depth: relative.split('/').length });

class StaticDocuments implements Documents {
  format(path: string): string | undefined {
    return path.endsWith('.md') ? 'markdown' : undefined;
  }

  read(): Promise<Document> {
    return Promise.resolve({ format: undefined, text: '', links: [] });
  }
}

describe('ranking', () => {
  it('prefers exact names, then prefixes, then name and path matches, shorter first', () => {
    expect(score('a.md', entry('docs/a.md'))).toBe(0);
    expect(score('har', entry('docs/harness.md'))).toBe(1);
    expect(score('ness', entry('docs/harness.md'))).toBe(2);
    expect(score('docs/h', entry('docs/harness.md'))).toBe(3);
    expect(score('zzz', entry('docs/harness.md'))).toBeUndefined();
    const root = new RootGuard([{ path: '/r', name: 'r', writable: true, index: 'all' }]).roots[0];
    if (root === undefined) { throw new Error('no root'); }
    const found = ['src/deep/harness.ts', 'harness.md', 'docs/the-harness.md', 'x/y'].map((r) => ({ root, entry: entry(r) }));
    expect(rank('harness', found, 10).map((f) => f.entry.relative)).toEqual(['harness.md', 'src/deep/harness.ts', 'docs/the-harness.md']);
    expect(rank('', found, 10).map((f) => f.entry.relative)).toEqual(['harness.md']);
  });
});

describe('PathIndex', () => {
  it('reuses a root\'s walk until it is older than its ttl, or cleared', async () => {
    const tmp = await tempFolder();
    try {
      let now = 0;
      const index = new PathIndex({ ttl: 1_000, max: 100, ignore: [] }, () => now);
      const root = new RootGuard([{ path: tmp.path, name: 'r', writable: true, index: 'all' }]).roots[0];
      if (root === undefined) { throw new Error('no root'); }
      expect(await index.paths(root)).toHaveLength(0);
      await writeFile(`${tmp.path}/a.txt`, 'a');
      expect(await index.paths(root)).toHaveLength(0);
      now = 1_000;
      expect(await index.paths(root)).toHaveLength(1);
      await writeFile(`${tmp.path}/b.txt`, 'b');
      index.clear();
      expect(await index.paths(root)).toHaveLength(2);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('FileMentions', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let guard: RootGuard;
  let mentions: FileMentions;
  const user = UserInfo.parse({ id: mintId('actor'), name: 'Ada', email: 'a@x.io', role: 'admin', groups: [], timeZone: 'UTC', locale: 'en-US' });

  beforeEach(async () => {
    tmp = await tempFolder();
    await mkdir(`${tmp.path}/docs`);
    await writeFile(`${tmp.path}/docs/guide.md`, '# Guide\none\ntwo\nthree\n');
    guard = new RootGuard([{ path: tmp.path, name: 'work', writable: true, index: 'all' }]);
    const files = new FileService(new DiskSnapshots(`${tmp.path}/.s`), { readLines: 100, fileMax: 10_000, listLimit: 100, ignore: ['.s'] });
    mentions = new FileMentions({ index: new PathIndex({ ttl: 0, max: 100, ignore: ['.s'] }, () => 0), files, documents: new StaticDocuments(), limits: { results: 5, previewLines: 2 } });
  });
  afterEach(() => tmp.cleanup());

  it('searches names across roots with a hint saying where', async () => {
    expect(await mentions.search(guard, 'guide')).toEqual([{ label: 'guide.md', hint: 'work · docs', icon: 'file', target: { root: 'work', path: 'docs/guide.md' } }]);
    expect((await mentions.search(guard, ''))[0]).toEqual({ label: 'docs/', hint: 'work', icon: 'folder', target: { root: 'work', path: 'docs' } });
  });

  it('draws a hover card with fields, a preview and the Entry value', async () => {
    const card = await mentions.hover(guard, { root: 'work', path: 'docs/guide.md' }, user);
    expect(card).toMatchObject({
      title: 'guide.md',
      subtitle: 'work/docs/guide.md',
      body: '```markdown\n# Guide\none\n…\n```',
      open: { resource: fileUri(`${tmp.path}/docs/guide.md`) },
      value: { path: `${tmp.path}/docs/guide.md`, type: 'file', size: 22 },
    });
    expect(card?.fields?.map((f) => f.label)).toEqual(['Type', 'Size', 'Modified']);
    expect(card?.fields?.[1]?.value).toBe('22 B');
  });

  it('has no card for something gone, outside, or in an unknown root', async () => {
    expect(await mentions.hover(guard, { root: 'work', path: 'nope.md' }, user)).toBeUndefined();
    expect(await mentions.hover(guard, { root: 'work', path: '../../etc/passwd' }, user)).toBeUndefined();
    expect(await mentions.hover(guard, { root: 'other', path: 'docs' }, user)).toBeUndefined();
  });

  it('tells the LLM what and where a mention is, and how to read it', async () => {
    expect(await mentions.llm(guard, { root: 'work', path: 'docs/guide.md' })).toBe(`File ${tmp.path}/docs/guide.md in the fs root "work" (22 B). Read it with fs/read { "path": "${tmp.path}/docs/guide.md" }.`);
    expect(await mentions.llm(guard, { root: 'work', path: 'docs' })).toContain('List it with fs/list');
    expect(await mentions.llm(guard, { root: 'work', path: 'gone' })).toContain('no longer exists');
  });
});
