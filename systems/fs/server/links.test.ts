import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRunner } from './commands.ts';
import { AeyeDocuments } from './documents.ts';
import { FileService } from './files.ts';
import { RootGuard, fileUri } from './paths.ts';
import { FsProblem } from './problem.ts';
import { FsResources } from './resources.ts';
import { DiskSnapshots } from './snapshots.ts';
import { FakeShell, tempFolder } from './testing.ts';

/** Link a folder: a junction on Windows (no admin rights needed), a symlink elsewhere. */
function linkFolder(target: string, path: string): Promise<void> {
  return symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

async function code(work: Promise<unknown>): Promise<string | undefined> {
  try { await work; } catch (error) { if (error instanceof FsProblem) { return error.code; } throw error; }
  return undefined;
}

describe('links', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let root: string;
  let guard: RootGuard;
  let files: FileService;
  let resources: FsResources;

  beforeEach(async () => {
    tmp = await tempFolder();
    root = `${tmp.path}/root`;
    await mkdir(`${root}/real`, { recursive: true });
    await mkdir(`${tmp.path}/secret`);
    await writeFile(`${root}/real/a.txt`, 'inside\n');
    await writeFile(`${tmp.path}/secret/key.txt`, 'outside\n');
    await linkFolder(`${root}/real`, `${root}/alias`);
    await linkFolder(`${tmp.path}/secret`, `${root}/escape`);
    guard = new RootGuard([{ path: root, name: 'root', writable: true, index: 'all' }]);
    files = new FileService(new DiskSnapshots(`${tmp.path}/.snapshots`), { readLines: 100, fileMax: 10_000, listLimit: 100, ignore: [] });
    resources = new FsResources({
      guard: () => guard,
      files,
      documents: new AeyeDocuments(createDefaultResourceRegistry()),
      limits: { page: 50, textMax: 10_000, ignore: [], debounce: 10 },
      watch: () => () => undefined,
    });
  });
  afterEach(() => tmp.cleanup());

  it('lets fns through a link that stays inside the roots, and refuses one that leads out', async () => {
    expect((await files.read(guard.resolve('alias/a.txt', { write: false }))).text).toBe('inside');
    expect(() => guard.resolve('escape/key.txt', { write: false })).toThrow(FsProblem);
    expect(() => guard.resolve('escape', { write: true })).toThrow(/outside/);
  });

  it('treats a linked folder as a folder for reading, writing and cd', async () => {
    expect(await code(files.read(guard.resolve('alias', { write: false })))).toBe('not-a-file');
    expect(await code(files.write(guard.resolve('alias', { write: true }), 'x'))).toBe('not-a-file');
    const runner = new CommandRunner(new FakeShell(), files, { timeout: 1_000, maxTimeout: 1_000, safe: [] });
    expect(await runner.folder(guard, 'alias', undefined)).toBe(`${root}/alias`);
  });

  it('serves a link inside the roots as what it leads to, and hides one that leads out', async () => {
    const listed = await resources.list(fileUri(root));
    expect(listed.items.map((item) => [item.name, item.type])).toEqual([['real', 'folder'], ['alias', 'folder']]);
    expect(await resources.stat(fileUri(`${root}/escape/key.txt`))).toBeUndefined();
    await expect(resources.read(fileUri(`${root}/escape/key.txt`), ['text'])).rejects.toThrow(/isn't under/);
    const read = await resources.read(fileUri(`${root}/alias/a.txt`), ['text']);
    expect(read.text).toEqual({ inline: 'inside\n' });
  });
});
