import { mkdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RootGuard, childPath, fileUri, inside, normalize, parentOf, uriPath } from './paths.ts';
import { FsProblem } from './problem.ts';
import { tempFolder } from './testing.ts';

describe('path helpers', () => {
  it('normalizes to forward slashes with no trailing slash', () => {
    const p = normalize('/tmp/x/');
    expect(p.endsWith('/x')).toBe(true);
    expect(p.includes('\\')).toBe(false);
  });

  it('tells what is inside a folder', () => {
    const root = normalize('/srv/work');
    expect(inside(root, root)).toBe('');
    expect(inside(root, `${root}/a/b.ts`)).toBe('a/b.ts');
    expect(inside(root, normalize('/srv/workshop'))).toBeUndefined();
    expect(inside(root, normalize('/srv'))).toBeUndefined();
  });

  it('round-trips file URIs', () => {
    const p = normalize('/srv/work/a b.md');
    const uri = fileUri(p);
    expect(uri.startsWith('file:///')).toBe(true);
    expect(uriPath(uri)).toBe(p);
    expect(uriPath('https://example.com/x')).toBeUndefined();
  });

  it('joins and splits paths', () => {
    expect(childPath('/a', 'b')).toBe('/a/b');
    expect(childPath('C:/', 'b')).toBe('C:/b');
    expect(parentOf('/a/b/c.ts')).toBe('/a/b');
    expect(parentOf('c.ts')).toBe('c.ts');
  });
});

describe('RootGuard', () => {
  let work: Awaited<ReturnType<typeof tempFolder>>;
  let docs: Awaited<ReturnType<typeof tempFolder>>;
  let guard: RootGuard;

  beforeEach(async () => {
    work = await tempFolder();
    docs = await tempFolder();
    await mkdir(`${work.path}/src`);
    guard = new RootGuard([
      { path: work.path, name: 'work', writable: true, index: 'all' },
      { path: docs.path, name: 'docs', writable: false, index: 'on-read' },
    ]);
  });
  afterEach(async () => { await work.cleanup(); await docs.cleanup(); });

  const problem = (run: () => unknown) => {
    try { run(); } catch (error) { if (error instanceof FsProblem) { return error.code; } throw error; }
    return undefined;
  };

  it('resolves relative paths against the first root', () => {
    expect(guard.resolve('src/a.ts', { write: true })).toMatchObject({ path: `${work.path}/src/a.ts`, relative: 'src/a.ts', root: { name: 'work' } });
  });

  it('resolves a path that starts with a root name in that root', () => {
    expect(guard.resolve('docs/readme.md', { write: false }).path).toBe(`${docs.path}/readme.md`);
  });

  it('resolves absolute paths and paths relative to a working folder', () => {
    expect(guard.resolve(`${docs.path}/x.md`, { write: false }).root.name).toBe('docs');
    expect(guard.resolve('b.ts', { write: false, cwd: `${work.path}/src` }).path).toBe(`${work.path}/src/b.ts`);
    expect(guard.resolve('', { write: false }).path).toBe(work.path);
  });

  it('refuses paths outside every root, however they are written', () => {
    expect(problem(() => guard.resolve('../escape.txt', { write: false }))).toBe('outside');
    expect(problem(() => guard.resolve(normalize('/'), { write: false }))).toBe('outside');
    expect(problem(() => guard.resolve('../../x', { write: false, cwd: `${work.path}/src` }))).toBe('outside');
  });

  it('refuses writes to a read-only root', () => {
    expect(problem(() => guard.resolve('docs/x.md', { write: true }))).toBe('read-only');
    expect(problem(() => guard.resolve('docs/x.md', { write: false }))).toBeUndefined();
  });

  it('says so when there are no roots', () => {
    expect(problem(() => new RootGuard([]).resolve('a', { write: false }))).toBe('no-roots');
  });

  it('picks the deepest root when roots nest', () => {
    const nested = new RootGuard([
      { path: work.path, name: 'work', writable: false, index: 'all' },
      { path: `${work.path}/src`, name: 'src', writable: true, index: 'all' },
    ]);
    expect(nested.locate(`${work.path}/src/a.ts`)?.root.name).toBe('src');
    expect(nested.resolve(`${work.path}/src/a.ts`, { write: true }).relative).toBe('a.ts');
    expect(nested.root('src')?.folder).toBe(`${work.path}/src`);
    expect(nested.root('nope')).toBeUndefined();
  });
});
