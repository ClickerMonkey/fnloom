import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineCount } from '../shared/format.ts';
import { FileService, occurrences, replaceText } from './files.ts';
import { RootGuard } from './paths.ts';
import { FsProblem } from './problem.ts';
import { DiskSnapshots } from './snapshots.ts';
import { tempFolder } from './testing.ts';
import { collect } from './walk.ts';

const limits = { readLines: 3, fileMax: 1_000, listLimit: 100, ignore: ['node_modules'] };

async function code(work: Promise<unknown>): Promise<string | undefined> {
  try { await work; } catch (error) { if (error instanceof FsProblem) { return error.code; } throw error; }
  return undefined;
}

describe('text helpers', () => {
  it('counts lines without the empty one after a final newline', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
  });

  it('replaces exact text with no $ patterns', () => {
    expect(replaceText('a $1 a', 'a', '$&', false)).toBe('$& $1 a');
    expect(replaceText('a a a', 'a', 'b', true)).toBe('b b b');
    expect(replaceText('abc', 'x', 'y', false)).toBe('abc');
    expect(occurrences('aaaa', 'aa')).toBe(2);
    expect(occurrences('abc', '')).toBe(0);
  });
});

describe('FileService', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let files: FileService;
  let guard: RootGuard;
  const at = (rel: string) => guard.resolve(rel, { write: true });

  beforeEach(async () => {
    tmp = await tempFolder();
    files = new FileService(new DiskSnapshots(`${tmp.path}/.snapshots`), limits);
    guard = new RootGuard([{ path: `${tmp.path}/root`, name: 'root', writable: true, index: 'all' }]);
    await mkdir(`${tmp.path}/root/src`, { recursive: true });
    await writeFile(`${tmp.path}/root/a.txt`, 'one\ntwo\nthree\nfour\nfive\n');
  });
  afterEach(() => tmp.cleanup());

  it('reads a slice by line and says when it is cut', async () => {
    expect(await files.read(at('a.txt'))).toEqual({
      text: 'one\ntwo\nthree', lines: 5, truncated: true,
      partial: 'Partial: lines 1–3 of 5 are here; 2 lines were left out. To get the rest, call fs/read again with the same path and offset: 3. Don\'t state what the left-out part says.',
    });
    expect(await files.read(at('a.txt'), 3, 10)).toMatchObject({ text: 'four\nfive', lines: 5, truncated: true, partial: expect.stringContaining('lines 4–5 of 5 are here; 3 lines were left out (all before this part)') });
    expect(await files.read(at('a.txt'), 0, 10)).toEqual({ text: 'one\ntwo\nthree\nfour\nfive', lines: 5, truncated: false });
  });

  it('refuses folders, missing, binary and oversized files', async () => {
    await writeFile(`${tmp.path}/root/b.bin`, new Uint8Array([1, 0, 2]));
    await writeFile(`${tmp.path}/root/big.txt`, 'x'.repeat(2_000));
    expect(await code(files.read(at('src')))).toBe('not-a-file');
    expect(await code(files.read(at('nope.txt')))).toBe('not-found');
    expect(await code(files.read(at('b.bin')))).toBe('binary');
    expect(await code(files.read(at('big.txt')))).toBe('too-large');
  });

  it('writes new files (making folders) and keeps what it overwrote', async () => {
    const created = await files.write(at('new/deep/c.md'), '# hi');
    expect(created).toMatchObject({ created: true, before: '', after: '# hi', previous: null });
    const again = await files.write(at('a.txt'), 'replaced');
    expect(again.created).toBe(false);
    expect(again.before).toContain('three');
    expect(again.previous?.mime).toContain('text/plain');
    expect(await code(files.write(at('src'), 'x'))).toBe('not-a-file');
  });

  it('edits exact text once, or everywhere with all', async () => {
    expect((await files.edit(at('a.txt'), 'two', '2', false)).replacements).toBe(1);
    expect(await readFile(`${tmp.path}/root/a.txt`, 'utf8')).toContain('one\n2\nthree');
    await writeFile(`${tmp.path}/root/r.txt`, 'x y x');
    expect(await code(files.edit(at('r.txt'), 'x', 'z', false))).toBe('ambiguous');
    expect((await files.edit(at('r.txt'), 'x', 'z', true)).replacements).toBe(2);
    expect(await readFile(`${tmp.path}/root/r.txt`, 'utf8')).toBe('z y z');
  });

  it('explains a miss, noticing whitespace', async () => {
    const miss = files.edit(at('a.txt'), ' two ', 'x', false);
    await expect(miss).rejects.toThrow(/without its leading or trailing whitespace/);
    await expect(files.edit(at('a.txt'), 'zebra', 'x', false)).rejects.toThrow(/copy the text exactly/);
  });

  it('removes files and puts them back on undo', async () => {
    const change = await files.remove(at('a.txt'));
    expect(await files.entry(`${tmp.path}/root/a.txt`)).toBeUndefined();
    const undone = await files.restore({ path: `${tmp.path}/root/a.txt`, previous: change.previous }, guard);
    expect(undone.status).toBe('undone');
    expect(await readFile(`${tmp.path}/root/a.txt`, 'utf8')).toBe('one\ntwo\nthree\nfour\nfive\n');
  });

  it('undoes a create by removing the file', async () => {
    await files.write(at('fresh.txt'), 'new');
    expect((await files.restore({ path: `${tmp.path}/root/fresh.txt`, previous: null }, guard)).status).toBe('undone');
    expect(await files.entry(`${tmp.path}/root/fresh.txt`)).toBeUndefined();
  });

  it('reports gone when a snapshot was lost, and a caller failure outside the roots', async () => {
    const lost = { hash: 'b'.repeat(64), size: 1, mime: 'text/plain' };
    expect(await files.restore({ path: `${tmp.path}/root/a.txt`, previous: lost }, guard)).toEqual({ status: 'gone' });
    const outside = await files.restore({ path: `${tmp.path}/elsewhere.txt`, previous: null }, guard);
    expect(outside).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'outside' } });
  });

  it('lists folders by depth, skipping ignored names', async () => {
    await mkdir(`${tmp.path}/root/node_modules/x`, { recursive: true });
    await writeFile(`${tmp.path}/root/src/b.ts`, 'export {}');
    const top = await files.list(at(''), 1);
    expect(top.map((e) => [e.path.slice(tmp.path.length), e.type])).toEqual([['/root/src', 'folder'], ['/root/a.txt', 'file']]);
    const deep = await files.list(at(''), 2);
    expect(deep.map((e) => e.path.slice(tmp.path.length + 6))).toEqual(['src', 'src/b.ts', 'a.txt']);
    expect(deep[2]?.size).toBe(24);
    expect(deep[2]?.modifiedAt).toBeInstanceOf(Date);
    expect(await code(files.list(at('a.txt'), 1))).toBe('not-a-folder');
    expect(await code(files.list(at('missing'), 1))).toBe('not-found');
  });

  it('walks in a stable order, to a depth and a limit', async () => {
    await writeFile(`${tmp.path}/root/src/z.ts`, '');
    await writeFile(`${tmp.path}/root/src/a.ts`, '');
    const all = await collect(`${tmp.path}/root`, { ignore: [] });
    expect(all.map((e) => e.relative)).toEqual(['src', 'src/a.ts', 'src/z.ts', 'a.txt']);
    expect((await collect(`${tmp.path}/root`, { ignore: [], limit: 2 })).length).toBe(2);
    expect((await collect(`${tmp.path}/root`, { ignore: ['src'] })).map((e) => e.relative)).toEqual(['a.txt']);
    expect(await collect(`${tmp.path}/missing`, { ignore: [] })).toEqual([]);
  });
});

describe('DiskSnapshots', () => {
  it('keeps bytes by hash, once, and refuses tampered copies', async () => {
    const tmp = await tempFolder();
    try {
      const snapshots = new DiskSnapshots(`${tmp.path}/s`);
      const bytes = new TextEncoder().encode('hello');
      const ref = await snapshots.save(bytes, 'text/plain');
      expect(ref).toEqual({ hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5, mime: 'text/plain' });
      expect(await snapshots.save(bytes, 'text/plain')).toEqual(ref);
      expect(new TextDecoder().decode(await snapshots.load(ref))).toBe('hello');
      await writeFile(`${tmp.path}/s/${ref.hash}`, 'tampered');
      expect(await snapshots.load(ref)).toBeUndefined();
      expect(await snapshots.load({ ...ref, hash: 'c'.repeat(64) })).toBeUndefined();
    } finally {
      await tmp.cleanup();
    }
  });
});
