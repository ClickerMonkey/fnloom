import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { mintId, type HookInput } from '@harness/core';
import type { TypesOf } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMMAND_TIMEOUT_MIN, fs } from '../shared/index.ts';
import { AeyeDocuments } from './documents.ts';
import { fsEnv } from './env.ts';
import { createFsImpl, type FsServer } from './impl.ts';
import type { CommandRun, FsConfig } from './index.ts';
import { DiskSnapshots } from './snapshots.ts';
import {
  FakeGit, FakeOpener, FakeRestarter, FakeShell, configFor, doneResult, failure, fnCtx, memoryState, systemCtx, tempFolder, undoCtx,
} from './testing.ts';

type Fns = typeof fs.defs.fns;
type Cwd = { cwd: string };

const settings = { ...fsEnv.parse(), FS_SAFE_COMMANDS: ['ls', 'git status'], FS_COMMAND_TIMEOUT: 1_000, FS_COMMAND_TIMEOUT_MAX: 5_000 };

/** The context parts of a fn with no handlers, progress, deps, form or state. */
const none = () => ({ handlers: {}, progress: { type: 'none' as const }, fns: {}, form: undefined, state: memoryState() });

describe('the fs implementation', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let root: string;
  let config: FsConfig;
  let shell: FakeShell;
  let opener: FakeOpener;
  let restarter: FakeRestarter;
  let server: FsServer;

  const build = (answer?: (input: Parameters<FakeShell['run']>[0]) => CommandRun) => {
    shell = new FakeShell(answer);
    opener = new FakeOpener();
    restarter = new FakeRestarter();
    server = createFsImpl({
      settings, shell, opener, restarter,
      git: new FakeGit(new Map([[root, { branch: 'main', tracking: 'ahead 1', changes: ['M a.txt'] }]])),
      snapshots: new DiskSnapshots(`${tmp.path}/state/snapshots`),
      documents: new AeyeDocuments(createDefaultResourceRegistry()),
      watch: () => () => undefined,
      now: () => 0,
    });
  };

  beforeEach(async () => {
    tmp = await tempFolder();
    root = `${tmp.path}/root`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(`${root}/a.txt`, 'alpha\nbeta\n');
    await writeFile(`${root}/src/b.ts`, 'export const b = 1; // TODO\n');
    config = configFor(root);
    build();
  });
  afterEach(() => tmp.cleanup());

  it('reads, lists, globs and greps', async () => {
    const { fns } = server.impl;
    expect(doneResult(await fns.read.run({ path: 'a.txt' }, fnCtx<TypesOf<Fns['read']>>(none(), { config: config }).ctx))).toEqual({ text: 'alpha\nbeta', lines: 2, truncated: false });
    const listed = doneResult(await fns.list.run({ path: '' }, fnCtx<TypesOf<Fns['list']>>(none(), { config: config }).ctx));
    expect(listed.entries.map((e) => e.path)).toEqual([`${root}/src`, `${root}/a.txt`]);
    expect(doneResult(await fns.glob.run({ pattern: '*.ts' }, fnCtx<TypesOf<Fns['glob']>>(none(), { config: config }).ctx))).toEqual({ paths: [`${root}/src/b.ts`] });
    const progress: Array<[number, string | undefined]> = [];
    const grep = fnCtx<TypesOf<Fns['grep']>>({ handlers: {}, progress: { set: (f, m) => { progress.push([f, m]); } }, fns: {}, form: undefined, state: memoryState() }, { config });
    expect(doneResult(await fns.grep.run({ pattern: 'TODO' }, grep.ctx))).toEqual({ matches: [{ path: `${root}/src/b.ts`, line: 1, text: 'export const b = 1; // TODO' }] });
    expect(progress.at(-1)?.[0]).toBe(1);
  });

  it('says the hosting fns need @harness/build on an fs without it', async () => {
    const { fns } = server.impl;
    const previewed = await fns.install_system.preview?.({ path: 'sys' }, { ...systemCtx({ config }), run: mintId('run') });
    expect(previewed !== undefined && 'refused' in previewed ? previewed.refused : '').toContain('build systems');
    expect(failure(await fns.install_system.run({ path: 'sys' }, fnCtx<TypesOf<Fns['install_system']>>(none(), { config }).ctx)).code).toBe('no-hosting');
    expect(failure(await fns.system_status.run({}, fnCtx<TypesOf<Fns['system_status']>>(none(), { config }).ctx)).code).toBe('no-hosting');
    expect(failure(await fns.restart_system.run({ system: 'notes', reason: 'stuck' }, fnCtx<TypesOf<Fns['restart_system']>>(none(), { config }).ctx)).code).toBe('no-hosting');
    expect(failure(await fns.stop_system.run({ system: 'notes' }, fnCtx<TypesOf<Fns['stop_system']>>({ ...none(), handlers: { confirm: undefined } }, { config }).ctx)).code).toBe('no-hosting');
  });

  it('turns problems into caller failures with codes', async () => {
    const { fns } = server.impl;
    expect(failure(await fns.read.run({ path: '../outside.txt' }, fnCtx<TypesOf<Fns['read']>>(none(), { config: config }).ctx))).toMatchObject({ class: 'caller', code: 'outside' });
    expect(failure(await fns.read.run({ path: 'missing.txt' }, fnCtx<TypesOf<Fns['read']>>(none(), { config: config }).ctx)).code).toBe('not-found');
    const grep = fnCtx<TypesOf<Fns['grep']>>({ handlers: {}, progress: { set: () => undefined }, fns: {}, form: undefined, state: memoryState() }, { config });
    expect(failure(await fns.grep.run({ pattern: '[' }, grep.ctx)).code).toBe('bad-pattern');
    const readOnly = configFor(root, { writable: false });
    expect(failure(await fns.write.run({ path: 'x.txt', text: 'x' }, fnCtx<TypesOf<Fns['write']>>(none(), { config: readOnly }).ctx)).code).toBe('read-only');
    expect(failure(await fns.read.run({ path: 'a.txt' }, fnCtx<TypesOf<Fns['read']>>(none(), { config: { roots: [] } }).ctx)).code).toBe('no-roots');
  });

  it('writes with a diff and undoes back to nothing', async () => {
    const { fns } = server.impl;
    const run = fnCtx<TypesOf<Fns['write']>>(none(), { config: config });
    const outcome = await fns.write.run({ path: 'notes/new.md', text: '# New' }, run.ctx);
    expect(outcome).toMatchObject({ status: 'done', result: { created: true }, undo: { path: `${root}/notes/new.md`, previous: null } });
    expect(run.attachments).toEqual([{ name: 'fs/diff', data: { path: `${root}/notes/new.md`, before: '', after: '# New' }, title: 'Created notes/new.md' }]);
    if (outcome.status !== 'done' || outcome.undo === undefined) { throw new Error('no undo'); }
    expect((await fns.write.undo(outcome.undo, undoCtx({ config }).ctx)).status).toBe('undone');
    expect(failure(await fns.read.run({ path: 'notes/new.md' }, fnCtx<TypesOf<Fns['read']>>(none(), { config: config }).ctx)).code).toBe('not-found');
  });

  it('edits exactly and undoes back to the earlier text', async () => {
    const { fns } = server.impl;
    const run = fnCtx<TypesOf<Fns['edit']>>(none(), { config: config });
    const outcome = await fns.edit.run({ path: 'a.txt', find: 'beta', replace: 'gamma' }, run.ctx);
    expect(doneResult(outcome)).toEqual({ replacements: 1 });
    expect(run.attachments[0]?.data).toEqual({ path: `${root}/a.txt`, before: 'alpha\nbeta\n', after: 'alpha\ngamma\n' });
    if (outcome.status !== 'done' || outcome.undo === undefined) { throw new Error('no undo'); }
    await fns.edit.undo(outcome.undo, undoCtx({ config }).ctx);
    expect(await readFile(`${root}/a.txt`, 'utf8')).toBe('alpha\nbeta\n');
    expect(failure(await fns.edit.run({ path: 'a.txt', find: 'zeta', replace: 'x' }, fnCtx<TypesOf<Fns['edit']>>(none(), { config: config }).ctx)).code).toBe('no-match');
  });

  it('removes and undoes, and skips diffs too big to draw', async () => {
    const small = { ...settings, FS_DIFF_MAX: 3 };
    server = createFsImpl({ settings: small, shell, opener, restarter, git: new FakeGit(new Map()), snapshots: new DiskSnapshots(`${tmp.path}/s`), documents: new AeyeDocuments(createDefaultResourceRegistry()), watch: () => () => undefined, now: () => 0 });
    const run = fnCtx<TypesOf<Fns['remove']>>(none(), { config: config });
    const outcome = await server.impl.fns.remove.run({ path: 'a.txt' }, run.ctx);
    expect(doneResult(outcome)).toEqual({ removed: true });
    expect(run.attachments).toEqual([]);
    if (outcome.status !== 'done' || outcome.undo === undefined) { throw new Error('no undo'); }
    expect(await server.impl.fns.remove.undo(outcome.undo, undoCtx({ config }).ctx)).toEqual({ status: 'undone', summary: `Restored ${root}/a.txt.` });
  });

  describe('the shell', () => {
    const bashCtx = (state: ReturnType<typeof memoryState<Cwd>>, options: { confirm?: (input: { command: string; reason: string }) => Promise<boolean>; settings?: Record<string, unknown>; signal?: AbortSignal } = {}) => {
      const progress: Array<[number, string | undefined]> = [];
      const made = fnCtx<TypesOf<Fns['bash']>>(
        { handlers: { confirm: options.confirm }, progress: { set: (f, m) => { progress.push([f, m]); } }, fns: {}, form: undefined, state },
        { config, ...(options.settings === undefined ? {} : { settings: options.settings }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
      );
      return { ...made, progress };
    };

    it('cd sets the working folder in session state and bash runs there', async () => {
      const state = memoryState<Cwd>();
      const cd = fnCtx<TypesOf<Fns['cd']>>({ handlers: {}, progress: { type: 'none' }, fns: {}, form: undefined, state }, { config });
      expect(doneResult(await server.impl.fns.cd.run({ path: 'src' }, cd.ctx))).toEqual({ cwd: `${root}/src` });
      expect(state.value()).toEqual({ cwd: `${root}/src` });
      const run = bashCtx(state);
      expect(doneResult(await server.impl.fns.bash.run({ command: 'ls' }, run.ctx))).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' });
      expect(shell.calls[0]).toMatchObject({ command: 'ls', cwd: `${root}/src`, timeout: 1_000 });
      expect(run.progress).toEqual([[0.5, 'half way']]);
      expect(run.log.lines[0]).toMatchObject({ key: 'fs.bash.ran', fields: { cwd: `${root}/src`, exitCode: 0, ended: 'exit' } });
      expect(failure(await server.impl.fns.cd.run({ path: '../a.txt' }, cd.ctx)).code).toBe('not-a-folder');
    });

    it('falls back to the first root when the saved folder is gone, and honours an explicit cwd', async () => {
      await server.impl.fns.bash.run({ command: 'ls' }, bashCtx(memoryState<Cwd>({ cwd: `${root}/deleted` })).ctx);
      expect(shell.calls[0]?.cwd).toBe(root);
      await server.impl.fns.bash.run({ command: 'ls', cwd: 'src', timeout: 99_999 }, bashCtx(memoryState<Cwd>()).ctx);
      expect(shell.calls[1]).toMatchObject({ cwd: `${root}/src`, timeout: 5_000 });
    });

    it('refuses a timeout under the minimum as invalid input without running, and tells the LLM the unit', async () => {
      const refused = await server.impl.fns.bash.run({ command: 'ls', timeout: 30 }, bashCtx(memoryState<Cwd>()).ctx);
      expect(refused.status).toBe('invalid-input');
      const problems = refused.status === 'invalid-input' ? refused.invalid.problems : [];
      expect(problems.map((problem) => problem.path)).toEqual(['timeout']);
      expect(problems[0]?.message).toContain('milliseconds');
      expect(shell.calls).toHaveLength(0);
      await server.impl.fns.bash.run({ command: 'ls', timeout: COMMAND_TIMEOUT_MIN }, bashCtx(memoryState<Cwd>()).ctx);
      expect(shell.calls[0]).toMatchObject({ timeout: COMMAND_TIMEOUT_MIN });
      const schema = JSON.stringify(z.toJSONSchema(fs.fns.bash.args.toValueSchema({ includeDocs: 'all' })));
      expect(schema).toContain('in milliseconds');
    });

    it('asks before a command outside the safe list, and needs someone to ask', async () => {
      const asked: string[] = [];
      const yes = bashCtx(memoryState(), { confirm: (input) => { asked.push(input.command); return Promise.resolve(true); } });
      expect((await server.impl.fns.bash.run({ command: 'rm -rf build' }, yes.ctx)).status).toBe('done');
      expect(asked).toEqual(['rm -rf build']);
      const no = bashCtx(memoryState(), { confirm: () => Promise.resolve(false) });
      expect(failure(await server.impl.fns.bash.run({ command: 'rm -rf build' }, no.ctx)).code).toBe('denied');
      expect(failure(await server.impl.fns.bash.run({ command: 'rm -rf build' }, bashCtx(memoryState()).ctx)).code).toBe('needs-confirmation');
      expect(shell.calls).toHaveLength(1);
    });

    it('follows the user\'s shell setting over the default safe list', async () => {
      const allowed = { 'fs/shell': { allowed: true, safe: ['make'] } };
      expect((await server.impl.fns.bash.run({ command: 'make all' }, bashCtx(memoryState(), { settings: allowed }).ctx)).status).toBe('done');
      expect(failure(await server.impl.fns.bash.run({ command: 'ls' }, bashCtx(memoryState(), { settings: allowed }).ctx)).code).toBe('needs-confirmation');
      const off = { 'fs/shell': { allowed: false, safe: ['ls'] } };
      expect(failure(await server.impl.fns.bash.run({ command: 'ls' }, bashCtx(memoryState(), { settings: off }).ctx)).code).toBe('denied');
    });

    it('fails on a timeout with the output so far, and reports a cancel as cancelled', async () => {
      build(() => ({ exitCode: 124, stdout: 'partial', stderr: '', ended: 'timeout' }));
      const timedOut = failure(await server.impl.fns.bash.run({ command: 'ls' }, bashCtx(memoryState()).ctx));
      expect(timedOut).toMatchObject({ code: 'timeout', data: { stdout: 'partial', exitCode: 124 } });
      build(() => ({ exitCode: 130, stdout: 'some', stderr: '', ended: 'cancelled' }));
      expect(await server.impl.fns.bash.run({ command: 'ls' }, bashCtx(memoryState()).ctx)).toEqual({ status: 'cancelled', partial: { exitCode: 130, stdout: 'some', stderr: '' } });
    });
  });

  it('schedules a restart after answering', async () => {
    const run = fnCtx<TypesOf<Fns['restart']>>(none(), { config: config });
    expect(doneResult(await server.impl.fns.restart.run({ reason: 'new fn' }, run.ctx))).toEqual({ restarting: true });
    expect(restarter.reasons).toEqual(['new fn']);
  });

  it('reveals an entry in the file manager, inside the roots only', async () => {
    const reveal = server.impl.types.Entry.reveal;
    const ctx = () => fnCtx<TypesOf<(typeof fs.defs.types.Entry.methods)['reveal']>>(none(), { config }).ctx;
    const entry = { path: `${root}/a.txt`, type: 'file' as const, size: 11, modifiedAt: new Date(0) };
    expect(doneResult(await reveal.run(entry, {}, ctx()))).toBe(true);
    expect(opener.shown).toEqual([`${root}/a.txt`]);
    expect(failure(await reveal.run({ ...entry, path: `${tmp.path}/elsewhere` }, {}, ctx())).code).toBe('outside');
  });

  it('draws the tree context for all roots or one', async () => {
    const tree = server.impl.context.tree;
    expect(await tree({}, systemCtx({ config }))).toContain('├─ src/');
    expect(await tree({ root: 'work' }, systemCtx({ config }))).toContain(`work/ (${root})`);
    expect(await tree({ root: 'nope' }, systemCtx({ config }))).toBe('There is no root named "nope". The roots are: work.');
    expect(await tree({}, systemCtx({ config: { roots: [] } }))).toBe('No folders are configured yet.');
  });

  it('adds the branch and changes from the git hook', async () => {
    const ctx = systemCtx({ config });
    const input: HookInput = { session: ctx.session, turn: mintId('turn'), text: 'hi', user: ctx.user, time: ctx.time };
    expect(await server.impl.hooks.git(input, ctx)).toEqual([
      { type: 'text', tag: 'git', text: '"work": branch main (ahead 1), 1 changed: M a.txt.' },
    ]);
    expect(await server.impl.hooks.git(input, systemCtx({ config: configFor(`${root}/src`) }))).toEqual([]);
  });

  it('serves mentions through the request\'s config', async () => {
    const ctx = systemCtx({ config });
    const found = await server.impl.mentions.files.search('b.ts', ctx);
    expect(found[0]?.target).toEqual({ root: 'work', path: 'src/b.ts' });
    expect((await server.impl.mentions.files.hover({ root: 'work', path: 'src/b.ts' }, ctx))?.title).toBe('b.ts');
    expect(await server.impl.mentions.files.llm({ root: 'work', path: 'src/b.ts' }, ctx)).toContain('fs/read');
  });

  it('follows config changes for resources', async () => {
    expect(await server.resources.roots()).toEqual([]);
    const ctx = systemCtx({ config });
    await server.impl.lifecycle?.started?.(ctx);
    expect((await server.resources.roots()).map((r) => r.name)).toEqual(['work']);
    expect(server.config()).toBe(config);
    const next = configFor(`${root}/src`, { name: 'src' });
    await server.impl.lifecycle?.configured?.({ ...systemCtx({ config: next }), previous: config });
    expect((await server.resources.roots()).map((r) => r.name)).toEqual(['src']);
    await server.impl.lifecycle?.stopping?.({ ...ctx, reason: 'restart', timeout: 1_000 });
    expect(ctx.log.lines.map((l) => l.key)).toEqual(['fs.started', 'fs.stopping']);
  });

  it('takes its first config while running, when there is no previous one', async () => {
    const ctx = systemCtx({ config });
    await server.impl.lifecycle?.configured?.({ ...ctx, previous: undefined });
    expect((await server.resources.roots()).map((r) => r.name)).toEqual(['work']);
    expect(ctx.log.lines.find((l) => l.key === 'fs.configured')?.fields).toEqual({ roots: 1, before: 0 });
  });
});
