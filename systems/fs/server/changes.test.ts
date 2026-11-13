import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { ChangeSet, FileChange } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandChanges, parseStatusV2, patchStats, withHeader } from './changes.ts';
import type { WatchFolder } from './index.ts';
import { RootGuard } from './paths.ts';
import { DEFAULT_SENSITIVITY_RULES, GitIgnores, Sensitivity } from './sensitive.ts';
import { NodeExec } from './shell.ts';
import { NO_IGNORES, tempFolder } from './testing.ts';

const exec = new NodeExec({ outputMax: 1_000_000, progressEvery: 1_000 });
const realWatch: WatchFolder = (folder, listener) => {
  const watcher = watch(folder, { recursive: true }, (event, file) => { if (file !== null) { listener(event, file); } });
  return () => { watcher.close(); };
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd });

describe('parseStatusV2 and diffs', () => {
  it('reads ordinary, renamed, unmerged and untracked entries', () => {
    const z = [
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts', 'old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc both.ts',
      '? notes.md', '',
    ].join('\0');
    expect([...parseStatusV2(z)]).toEqual([
      ['src/a b.ts', { kind: 'tracked', xy: '.M' }],
      ['new.ts', { kind: 'renamed', xy: 'R.', from: 'old.ts' }],
      ['both.ts', { kind: 'unmerged', xy: 'UU' }],
      ['notes.md', { kind: 'untracked', xy: '??' }],
    ]);
  });

  it('names the file in the header and counts lines after the first hunk', () => {
    const raw = 'diff --git a/C:/tmp/0 b/C:/w/a.ts\nindex 1..2\n--- a/C:/tmp/0\n+++ b/C:/w/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n--- not a header\n same\n';
    const diff = withHeader(raw, 'a.ts', 'modified', undefined);
    expect(diff.split('\n').slice(0, 3)).toEqual(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts']);
    expect(patchStats(diff)).toEqual({ added: 1, removed: 2 });
    expect(withHeader('', 'b.ts', 'renamed', 'a.ts')).toBe('diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n--- a/a.ts\n+++ b/b.ts');
  });
});

describe('CommandChanges', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let repo: string;
  let guard: RootGuard;
  let changes: CommandChanges;
  const sensitivity = new Sensitivity(DEFAULT_SENSITIVITY_RULES, NO_IGNORES);
  const limits = { maxFiles: 50, diffMaxBytes: 2_000, diffTotalBytes: 100_000, gitTimeout: 20_000, settle: 150, ignore: ['node_modules'] };

  /** Run `work` as a command would, between start and finish. */
  const during = async (work: () => Promise<void>, cwd = repo): Promise<ChangeSet> => {
    const session = await changes.start({ cwd, guard, sensitivity });
    await work();
    return session.finish();
  };
  const byPath = (set: ChangeSet): Record<string, FileChange> => Object.fromEntries(set.files.map((file) => [file.path, file]));

  beforeEach(async () => {
    tmp = await tempFolder();
    repo = `${tmp.path}/repo`;
    await mkdir(`${repo}/src`, { recursive: true });
    guard = new RootGuard([{ path: repo, name: 'repo', writable: true, index: 'none' }, { path: `${tmp.path}/plain`, name: 'plain', writable: true, index: 'none' }]);
    changes = new CommandChanges({ exec, ignores: new GitIgnores(exec, 20_000), watch: realWatch, now: () => Date.now(), limits: { ...limits, scratch: `${tmp.path}/scratch` } });
    await writeFile(`${repo}/src/a.ts`, 'one\ntwo\nthree\n');
    await writeFile(`${repo}/src/b.ts`, 'keep\n');
    await writeFile(`${repo}/.gitignore`, 'dist/\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
  });
  afterEach(() => tmp.cleanup());

  it('diffs a clean file the call changed, lists a new one, and leaves files it did not touch', async () => {
    const set = await during(async () => {
      await writeFile(`${repo}/src/a.ts`, 'one\nTWO\nthree\n');
      await writeFile(`${repo}/src/new.ts`, 'hello\n');
    });
    expect(set).toMatchObject({ source: 'git', ignored: 0, truncated: false });
    const files = byPath(set);
    expect(Object.keys(files)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(files['src/a.ts']).toMatchObject({ root: 'repo', status: 'modified', added: 1, removed: 1, certain: true });
    expect(files['src/a.ts']?.diff).toContain('-two\n+TWO');
    expect(files['src/new.ts']).toMatchObject({ status: 'added', added: 1, removed: 0 });
    expect(files['src/new.ts']?.diff?.split('\n')[1]).toBe('--- /dev/null');
  });

  it('counts only what the call did to a file that was already changed, and skips one it left alone', async () => {
    await writeFile(`${repo}/src/a.ts`, 'one\ntwo\nthree\nfour\n');
    await writeFile(`${repo}/notes.md`, 'draft\n');
    const set = await during(async () => { await writeFile(`${repo}/src/a.ts`, 'one\ntwo\nthree\nfour\nfive\n'); });
    expect(set.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(set.files[0]).toMatchObject({ status: 'modified', added: 1, removed: 0 });
    expect(set.files[0]?.diff).toMatch(/\+five/);
    expect(set.files[0]?.diff).not.toMatch(/\+four/);
  });

  it('lists a rename, a deletion, a binary file and a sensitive one without leaking its text', async () => {
    const set = await during(async () => {
      git(repo, 'mv', 'src/b.ts', 'src/c.ts');
      await rm(`${repo}/src/a.ts`);
      await writeFile(`${repo}/logo.png`, new Uint8Array([137, 80, 78, 71, 0, 1, 2]));
      await writeFile(`${repo}/.env`, 'TOKEN=abc\n');
    });
    const files = byPath(set);
    expect(files['src/c.ts']).toMatchObject({ status: 'renamed', from: 'src/b.ts', added: 0, removed: 0 });
    expect(files['src/a.ts']).toMatchObject({ status: 'deleted', removed: 3 });
    expect(files['logo.png']).toMatchObject({ status: 'added', noDiff: 'binary' });
    expect(files['.env']).toMatchObject({ status: 'added', noDiff: 'sensitive', sensitive: 'env' });
    expect(files['.env']?.diff).toBeUndefined();
  });

  it('counts ignored files without listing them, and lists large files without a diff', async () => {
    const set = await during(async () => {
      await mkdir(`${repo}/dist/deep`, { recursive: true });
      await writeFile(`${repo}/dist/a.js`, 'x');
      await writeFile(`${repo}/dist/deep/b.js`, 'y');
      await writeFile(`${repo}/big.txt`, 'z'.repeat(5_000));
    });
    expect(set.files.map((f) => [f.path, f.noDiff])).toEqual([['big.txt', 'large']]);
    expect(set.ignored).toBeGreaterThanOrEqual(2);
  });

  it('sees a commit that moved HEAD, and marks changes uncertain when another call worked in the same tree', async () => {
    const committed = await during(async () => {
      await writeFile(`${repo}/src/b.ts`, 'changed\n');
      git(repo, 'commit', '-q', '-am', 'second');
    });
    expect(committed.files.map((f) => [f.path, f.status])).toEqual([['src/b.ts', 'modified']]);
    const outer = await changes.start({ cwd: repo, guard, sensitivity });
    const inner = await changes.start({ cwd: `${repo}/src`, guard, sensitivity });
    await writeFile(`${repo}/src/a.ts`, 'other\n');
    const [first, second] = await Promise.all([outer.finish(), inner.finish()]);
    expect(first.files.map((f) => f.certain)).toEqual([false]);
    expect(second.files.map((f) => f.certain)).toEqual([false]);
    const write = changes.busy(`${repo}/src/a.ts`);
    const busy = await during(async () => { await writeFile(`${repo}/src/a.ts`, 'again\n'); });
    write();
    expect(busy.files[0]?.certain).toBe(false);
    expect((await during(async () => { await writeFile(`${repo}/src/a.ts`, 'alone\n'); })).files[0]?.certain).toBe(true);
  });

  it('caps the list and says so', async () => {
    changes = new CommandChanges({ exec, ignores: new GitIgnores(exec, 20_000), watch: realWatch, now: () => Date.now(), limits: { ...limits, maxFiles: 2, scratch: `${tmp.path}/scratch` } });
    const set = await during(async () => { for (const n of [1, 2, 3]) { await writeFile(`${repo}/f${String(n)}.txt`, 'x\n'); } });
    expect(set.files).toHaveLength(2);
    expect(set.truncated).toBe(true);
  });

  it('outside git, lists what the watcher saw without diffs', async () => {
    const plain = `${tmp.path}/plain`;
    await mkdir(plain, { recursive: true });
    await writeFile(`${plain}/old.txt`, 'old\n');
    await writeFile(`${plain}/gone.txt`, 'bye\n');
    await new Promise((done) => { setTimeout(done, 100); });
    const set = await during(async () => {
      await writeFile(`${plain}/new.txt`, 'new\n');
      await writeFile(`${plain}/old.txt`, 'changed\n');
      await rename(`${plain}/gone.txt`, `${plain}/moved.txt`);
      await mkdir(`${plain}/node_modules`, { recursive: true });
      await writeFile(`${plain}/node_modules/x.js`, '');
    }, plain);
    expect(set.source).toBe('watcher');
    const files = byPath(set);
    expect(files['new.txt']).toMatchObject({ root: 'plain', status: 'added', noDiff: 'not-in-git', certain: true });
    expect(files['old.txt']).toMatchObject({ status: 'modified' });
    expect(files['gone.txt']).toMatchObject({ status: 'deleted' });
    expect(files['moved.txt']).toMatchObject({ status: 'added' });
    expect(files['new.txt']?.diff).toBeUndefined();
    expect(set.ignored).toBeGreaterThanOrEqual(1);
  });
});
