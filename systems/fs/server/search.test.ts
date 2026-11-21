import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileService } from './files.ts';
import { RootGuard } from './paths.ts';
import { FsProblem } from './problem.ts';
import { compilePattern, globMatcher, globPaths, grepFiles, searchBases } from './search.ts';
import { DiskSnapshots } from './snapshots.ts';
import { tempFolder } from './testing.ts';
import { drawTree, renderTree } from './tree.ts';
import type { WalkEntry } from './walk.ts';

const limits = { scanMax: 1_000, lineMax: 20, ignore: ['node_modules'], grepTimeout: 10_000, testMax: 10_000 };
const signal = new AbortController().signal;
const entry = (relative: string, depth = relative.split('/').length, type: WalkEntry['type'] = 'file'): WalkEntry =>
  ({ path: `/r/${relative}`, relative, name: relative.split('/').pop() ?? relative, type, depth });

describe('globMatcher', () => {
  it('matches names at any depth when the pattern has no slash, else the path', () => {
    expect(globMatcher('*.ts')(entry('src/deep/a.ts'))).toBe(true);
    expect(globMatcher('src/*.ts')(entry('src/deep/a.ts'))).toBe(false);
    expect(globMatcher('src/**/*.ts')(entry('src/deep/a.ts'))).toBe(true);
    expect(globMatcher('*.md')(entry('src/a.ts'))).toBe(false);
  });

  it('refuses a glob whose brace lists, ranges or groups would hold fs up, at once', () => {
    const started = performance.now();
    for (const pattern of ['{a,b}'.repeat(20), '{1..2000000}', '*(*(a))b', '+(a|aa)+(a|aa)b']) {
      expect(() => globMatcher(pattern), pattern).toThrow(expect.objectContaining({ code: 'bad-pattern' }));
    }
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(globMatcher('*.{ts,tsx,js}')(entry('src/a.tsx'))).toBe(true);
  });

  it('refuses an invalid regular expression with a message', () => {
    expect(() => compilePattern('(')).toThrow(FsProblem);
    expect(compilePattern('a.c').test('abc')).toBe(true);
  });
});

describe('searching a root', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let guard: RootGuard;
  let files: FileService;

  beforeEach(async () => {
    tmp = await tempFolder();
    await mkdir(`${tmp.path}/src/lib`, { recursive: true });
    await mkdir(`${tmp.path}/node_modules/pkg`, { recursive: true });
    await writeFile(`${tmp.path}/src/a.ts`, 'const answer = 42;\nexport { answer };\n');
    await writeFile(`${tmp.path}/src/lib/b.ts`, `// TODO: tidy ${'x'.repeat(50)}\n`);
    await writeFile(`${tmp.path}/README.md`, 'TODO: write me\r\n');
    await writeFile(`${tmp.path}/node_modules/pkg/index.ts`, 'TODO hidden');
    await writeFile(`${tmp.path}/blob.bin`, new Uint8Array([0, 1, 2]));
    guard = new RootGuard([{ path: tmp.path, name: 'work', writable: true, index: 'all' }]);
    files = new FileService(new DiskSnapshots(`${tmp.path}/.s`), { readLines: 100, fileMax: 10_000, listLimit: 100, ignore: limits.ignore });
  });
  afterEach(() => tmp.cleanup());

  it('starts from every root, a named root, or a path', () => {
    expect(searchBases(guard, undefined).map((b) => b.path)).toEqual([tmp.path]);
    expect(searchBases(guard, 'work')[0]?.path).toBe(tmp.path);
    expect(searchBases(guard, 'src')[0]?.path).toBe(`${tmp.path}/src`);
    expect(() => searchBases(new RootGuard([]), undefined)).toThrow(/No folders/);
  });

  it('finds paths by glob, skipping ignored folders, up to a limit', async () => {
    const paths = await globPaths(searchBases(guard, undefined), '*.ts', 10, limits, signal);
    expect(paths.map((p) => p.slice(tmp.path.length))).toEqual(['/src/lib/b.ts', '/src/a.ts']);
    expect(await globPaths(searchBases(guard, undefined), '*.ts', 1, limits, signal)).toHaveLength(1);
    expect(await globPaths(searchBases(guard, undefined), '*.md', 10, { ...limits, scanMax: 2 }, signal)).toHaveLength(0);
  });

  it('greps text files with line numbers, cut lines and progress', async () => {
    const progress: Array<[number, string]> = [];
    const matches = await grepFiles(files, searchBases(guard, undefined), { pattern: /TODO/, glob: undefined, limit: 10 }, limits, signal, (f, m) => { progress.push([f, m]); });
    expect(matches.map((m) => [m.path.slice(tmp.path.length), m.line, m.text])).toEqual([
      ['/src/lib/b.ts', 1, '// TODO: tidy xxxxxx'],
      ['/README.md', 1, 'TODO: write me'],
    ]);
    expect(progress[progress.length - 1]).toEqual([1, '2 matches in 4 files']);
    const filtered = await grepFiles(files, searchBases(guard, undefined), { pattern: /answer/, glob: 'src/*.ts', limit: 1 }, limits, signal, () => undefined);
    expect(filtered).toEqual([{ path: `${tmp.path}/src/a.ts`, line: 1, text: 'const answer = 42;' }]);
  });

  it('stops a catastrophic pattern at its deadline instead of hanging fs', async () => {
    await writeFile(`${tmp.path}/slow.txt`, `${'a'.repeat(40)}b\n`);
    const started = performance.now();
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    try {
      const search = grepFiles(files, searchBases(guard, undefined), { pattern: compilePattern('^(a+)+$'), glob: 'slow.txt', limit: 10 }, { ...limits, grepTimeout: 400 }, signal, () => undefined);
      await expect(search).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      clearInterval(ticker);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    // the event loop kept running while the pattern was being matched
    expect(ticks).toBeGreaterThan(5);
  });

  it('cancels a slow pattern mid-file, and tests only the start of a very long line', async () => {
    await writeFile(`${tmp.path}/slow.txt`, `${'a'.repeat(40)}b\n`);
    const controller = new AbortController();
    const search = grepFiles(files, searchBases(guard, undefined), { pattern: compilePattern('^(a+)+$'), glob: 'slow.txt', limit: 10 }, limits, controller.signal, () => undefined);
    setTimeout(() => { controller.abort(new Error('cancelled')); }, 100);
    await expect(search).rejects.toThrow('cancelled');
    await writeFile(`${tmp.path}/long.txt`, `${'x'.repeat(50)}NEEDLE\n`);
    const cut = await grepFiles(files, searchBases(guard, undefined), { pattern: /NEEDLE/, glob: 'long.txt', limit: 10 }, { ...limits, testMax: 50 }, signal, () => undefined);
    expect(cut).toEqual([]);
  });

  it('stops when the run is cancelled', async () => {
    await expect(globPaths(searchBases(guard, undefined), '*', 10, limits, AbortSignal.abort())).rejects.toThrow();
  });

  it('draws the tree of a root', async () => {
    const tree = await renderTree(guard.roots[0] ?? guard.resolve('', { write: false }).root, { depth: 2, entries: 3, ignore: limits.ignore });
    expect(tree.split('\n')).toEqual([
      `work/ (${tmp.path})`,
      '├─ src/',
      '│  ├─ lib/',
      '│  └─ a.ts',
      '… more entries not shown (the first 3, 2 levels deep). Use fs/list or fs/glob for the rest.',
    ]);
  });
});

describe('drawTree', () => {
  it('draws siblings, last children and open ancestors', () => {
    const lines = drawTree([
      entry('a', 1, 'folder'), entry('a/x', 2, 'folder'), entry('a/x/1', 3), entry('a/y', 2), entry('b', 1),
    ]);
    expect(lines).toEqual(['├─ a/', '│  ├─ x/', '│  │  └─ 1', '│  └─ y', '└─ b']);
  });
});
