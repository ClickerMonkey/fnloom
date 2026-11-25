import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { ginBundle, mintId, type ApprovalPreview, type HookInput } from '@harness/core';
import type { TypesOf } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LENIENT } from '@aeye/schema';
import { COMMAND_TIMEOUT_MIN, fs } from '../shared/index.ts';
import { AeyeDocuments } from './documents.ts';
import { fsEnv } from './env.ts';
import { createFsImpl, type FsServer } from './impl.ts';
import type { CommandRun, FsConfig } from './index.ts';
import { DiskSnapshots } from './snapshots.ts';
import {
  FakeChanges, FakeGit, FakeOpener, NO_IGNORES, FakeRestarter, FakeShell, configFor, doneResult, failure, fnCtx, memoryState, systemCtx, tempFolder, undoCtx,
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
      changes: new FakeChanges(),
      ignores: NO_IGNORES,
      now: () => 0,
      baseEnv: process.env,
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

  it('claims the file a write, an edit or a delete changes by its full path, so two spellings of one file clash', async () => {
    const { fns } = server.impl;
    const call = { ...systemCtx({ config }), caller: mintId('run') };
    const file = `file:${root}/a.txt`;
    expect(await fns.write.claims?.({ path: 'a.txt', text: 'x' }, call)).toEqual([file]);
    expect(await fns.edit.claims?.({ path: './a.txt', find: 'alpha', replace: 'beta' }, call)).toEqual([file]);
    expect(await fns.remove.claims?.({ path: `${root}/a.txt` }, call)).toEqual([file]);
    expect(await fns.write.claims?.({ path: 'src/b.ts', text: 'x' }, call)).toEqual([`file:${root}/src/b.ts`]);
    // a path outside the roots claims nothing: its run is refused before it touches anything
    expect(await fns.write.claims?.({ path: '../outside.txt', text: 'x' }, call)).toEqual([]);
  });

  it('flags sensitive files before a run, leaves them out of listings and searches, and refuses what a rule refuses', async () => {
    await writeFile(`${root}/.env`, 'TOKEN=abc // TODO\n');
    const { fns } = server.impl;
    const preview = { ...systemCtx({ config }), run: mintId('run') };
    expect(await fns.read.flags?.({ path: '.env' }, preview)).toEqual([expect.objectContaining({ path: '.env', kind: 'env', access: 'read', action: 'ask', certain: true })]);
    expect(await fns.write.flags?.({ path: 'a.txt', text: 'x' }, preview)).toEqual([]);
    expect(await fns.bash.flags?.({ command: 'cat .env > copy.txt && rm ~/.ssh/id_rsa' }, preview)).toEqual([
      expect.objectContaining({ path: '.env', access: 'read', certain: false }),
      expect.objectContaining({ path: '~/.ssh/id_rsa', kind: 'key', access: 'write', certain: false }),
    ]);
    expect(await fns.grep.flags?.({ pattern: 'x', glob: '*.pem' }, preview)).toEqual([expect.objectContaining({ path: '*.pem', kind: 'key' })]);
    expect(await fns.read.flags?.({ path: '../outside' }, preview)).toEqual([]);

    const listed = doneResult(await fns.list.run({ path: '' }, fnCtx<TypesOf<Fns['list']>>(none(), { config }).ctx));
    expect(listed).toMatchObject({ hidden: 1 });
    expect(listed.entries.map((e) => e.path)).not.toContain(`${root}/.env`);
    const grep = fnCtx<TypesOf<Fns['grep']>>({ ...none(), progress: { set: () => undefined } }, { config });
    expect(doneResult(await fns.grep.run({ pattern: 'TODO' }, grep.ctx))).toMatchObject({ matches: [{ path: `${root}/src/b.ts` }], hidden: 1 });
    // an approval for another reason (auto mode asking) unhides nothing; one whose card showed the flag does
    const grepOn = (parts: ApprovalPreview['parts']) => fnCtx<TypesOf<Fns['grep']>>({ ...none(), progress: { set: () => undefined } }, { config, approved: { by: mintId('actor'), preview: { title: 'Search', parts, irreversible: false } } }).ctx;
    expect(doneResult(await fns.grep.run({ pattern: 'TODO' }, grepOn([{ type: 'text', text: 'Auto mode asks you about fs/grep.' }])))).toMatchObject({ hidden: 1 });
    const flags = await fns.grep.flags?.({ pattern: 'TODO', glob: '.env*' }, preview) ?? [];
    expect(flags).toEqual([expect.objectContaining({ path: '.env*', certain: false })]);
    const seen = doneResult(await fns.grep.run({ pattern: 'TODO', glob: '.env*' }, grepOn([{ type: 'flags', flags: [...flags] }])));
    expect(seen.matches.map((match) => match.path)).toEqual([`${root}/.env`]);

    const strict: FsConfig = { ...config, sensitive: [{ name: 'no-env', kind: 'env', match: { type: 'glob', glob: '.env' }, read: 'refuse', write: 'refuse', why: 'Never.' }] };
    const refused = await fns.read.run({ path: '.env' }, fnCtx<TypesOf<Fns['read']>>(none(), { config: strict }).ctx);
    expect(refused).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ message: 'Reads .env (env: Never.)' }] } });
  });

  it('returns the files a command changed with its output', async () => {
    const changed = { source: 'git' as const, cwd: root, files: [{ path: 'a.txt', root: 'root', status: 'modified' as const, diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1, certain: true }], ignored: 0, truncated: false };
    const capture = new FakeChanges(() => changed);
    const withChanges = createFsImpl({ settings, shell: new FakeShell(), opener, restarter, git: new FakeGit(new Map()), snapshots: new DiskSnapshots(`${tmp.path}/s`), documents: new AeyeDocuments(createDefaultResourceRegistry()), watch: () => () => undefined, changes: capture, ignores: NO_IGNORES, now: () => 0, baseEnv: process.env });
    const made = fnCtx<TypesOf<Fns['bash']>>({ handlers: { confirm: () => Promise.resolve(true) }, progress: { set: () => undefined }, fns: {}, form: undefined, state: memoryState() }, { config });
    expect(doneResult(await withChanges.impl.fns.bash.run({ command: 'npm run fmt' }, made.ctx))).toMatchObject({ exitCode: 0, changes: changed });
    expect(capture.started).toEqual([root]);
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
    server = createFsImpl({ settings: small, shell, opener, restarter, git: new FakeGit(new Map()), snapshots: new DiskSnapshots(`${tmp.path}/s`), documents: new AeyeDocuments(createDefaultResourceRegistry()), watch: () => () => undefined, changes: new FakeChanges(), ignores: NO_IGNORES, now: () => 0, baseEnv: process.env });
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

    it('flags sensitive files after a cd, behind a glob, by name when missing, and in the session folder at run time', async () => {
      await mkdir(`${root}/sub`, { recursive: true });
      await writeFile(`${root}/sub/.env`, 'X=1\n');
      const preview = { ...systemCtx({ config }), run: mintId('run') };
      const flagged = async (command: string) => (await server.impl.fns.bash.flags?.({ command }, preview) ?? []).map((flag) => [flag.path, flag.rule]);
      expect(await flagged('cd sub && cat .env')).toEqual([['.env', 'env-files']]);
      expect(await flagged('cat sub/.e*')).toEqual([['sub/.env', 'env-files']]);
      expect(await flagged('cat */.env')).toEqual([['sub/.env', 'env-files']]);
      expect(await flagged('cat nowhere/.env')).toEqual([['nowhere/.env', 'env-files']]);
      expect(await flagged('cd "$DIR" && cat .env')).toEqual([['.env', 'env-files']]);
      expect(await flagged('cat src/*.ts')).toEqual([]);

      // the preview judged `cat notes.txt` at the root, where there is none; the run is in sub, where it holds a password
      await writeFile(`${root}/sub/notes.txt`, 'password = "hunter2hunter2"\n');
      expect(await flagged('cat notes.txt')).toEqual([]);
      const reasons: string[] = [];
      const state = memoryState<Cwd>({ cwd: `${root}/sub` });
      const asked = bashCtx(state, { confirm: (input) => { reasons.push(input.reason); return Promise.resolve(false); } });
      expect((await server.impl.fns.bash.run({ command: 'cat notes.txt' }, asked.ctx)).status).toBe('invalid-input');
      expect(reasons).toEqual(['May read notes.txt (secret-content: It has a password or secret written out in it.)']);
      expect(shell.calls).toHaveLength(0);
      expect((await server.impl.fns.bash.run({ command: 'cat notes.txt' }, bashCtx(state).ctx)).status).toBe('invalid-input');
      expect((await server.impl.fns.bash.run({ command: 'cat notes.txt' }, bashCtx(state, { confirm: () => Promise.resolve(true) }).ctx)).status).toBe('done');
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
      const schema = JSON.stringify(ginBundle(fs.fns.bash.args, { includeDocs: 'all' }).bind(fs.fns.bash.args.registry).render(LENIENT).jsonSchema);
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
      // a command the person confirmed runs git as they have it set up
      expect(shell.calls[0]?.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    });

    it('asks before a safe command that reaches outside the roots, through a variable or ~, or writes through git', async () => {
      const defaults = createFsImpl({
        settings: { ...settings, FS_SAFE_COMMANDS: fsEnv.parse().FS_SAFE_COMMANDS }, shell, opener, restarter, git: new FakeGit(new Map()), snapshots: new DiskSnapshots(`${tmp.path}/s`),
        documents: new AeyeDocuments(createDefaultResourceRegistry()), watch: () => () => undefined, changes: new FakeChanges(), ignores: NO_IGNORES, now: () => 0, baseEnv: process.env,
      });
      await writeFile(`${tmp.path}/secret.txt`, 'outside\n');
      await writeFile(`${root}/.env`, 'OPENROUTER_API_KEY=sk-or-secret\n');
      const asked: string[] = [];
      const run = (command: string, settings?: Record<string, unknown>) => defaults.impl.fns.bash.run({ command }, bashCtx(memoryState<Cwd>(), { confirm: (input) => { asked.push(input.command); return Promise.resolve(false); }, ...(settings === undefined ? {} : { settings }) }).ctx);
      for (const command of ['cat a.txt', 'git diff --stat', 'git log -3 --format=%h', 'git branch -a']) {
        expect((await run(command)).status).toBe('done');
      }
      expect(asked).toEqual([]);
      const echoing = { 'fs/shell': { allowed: true, safe: ['echo', 'cat'] } };
      const risky = ['cat ../secret.txt', `cat ${tmp.path}/secret.txt`, 'cat $PWD/.env', 'cat ~/.ssh/id_rsa', 'cat .en?', 'git diff --output=../x', 'git log --ext-diff', 'git branch -D main', 'git branch new', 'npm test', 'npx vitest'];
      for (const command of risky) { expect(failure(await run(command)).code).toBe('denied'); }
      expect(failure(await run('echo $OPENROUTER_API_KEY', echoing)).code).toBe('denied');
      expect(asked).toEqual([...risky, 'echo $OPENROUTER_API_KEY']);
      expect(shell.calls).toHaveLength(4);
      // what runs without asking also runs git without the programs a repository's config names
      expect(shell.calls.map((call) => call.env['GIT_CONFIG_KEY_0'])).toEqual(['core.fsmonitor', 'core.fsmonitor', 'core.fsmonitor', 'core.fsmonitor']);

      // the hub is told too, so it asks the person even where fs's own check would not
      const preview = { ...systemCtx({ config }), run: mintId('run') };
      const flagged = async (command: string) => (await defaults.impl.fns.bash.flags?.({ command }, preview) ?? []).map((flag) => [flag.path, flag.kind, flag.action]);
      expect(await flagged('cat ../secret.txt')).toEqual([['../secret.txt', 'unknown-path', 'ask']]);
      expect(await flagged('cat $PWD/.env')).toEqual([['$PWD/.env', 'env', 'ask']]);
      expect(await flagged('echo $OPENROUTER_API_KEY')).toEqual([['$OPENROUTER_API_KEY', 'unknown-path', 'ask']]);
      expect(await flagged('ls ~')).toEqual([['~', 'unknown-path', 'ask']]);
      // a glob too costly to expand is not expanded, and asks
      const bomb = '{a,b}'.repeat(20);
      expect(await flagged(`ls ${bomb}`)).toEqual([[bomb, 'unknown-path', 'ask']]);
      expect(await flagged('cat a.txt 2>/dev/null')).toEqual([]);
    });

    it('starts commands with the basics and the admin\'s env names only', async () => {
      process.env['OPENROUTER_API_KEY'] = 'sk-or-planted';
      process.env['HARNESS_TEST_ALLOWED'] = 'yes';
      try {
        const withEnv = createFsImpl({
          settings, shell, opener, restarter, git: new FakeGit(new Map()), snapshots: new DiskSnapshots(`${tmp.path}/s`),
          documents: new AeyeDocuments(createDefaultResourceRegistry()), watch: () => () => undefined, changes: new FakeChanges(), ignores: NO_IGNORES, now: () => 0, baseEnv: process.env,
        });
        const allowing = { ...config, commandEnv: ['HARNESS_TEST_ALLOWED'] };
        const made = fnCtx<TypesOf<Fns['bash']>>({ handlers: { confirm: undefined }, progress: { set: () => undefined }, fns: {}, form: undefined, state: memoryState() }, { config: allowing });
        expect((await withEnv.impl.fns.bash.run({ command: 'ls' }, made.ctx)).status).toBe('done');
        const env = shell.calls[0]?.env ?? {};
        expect(Object.keys(env).some((name) => name.toUpperCase() === 'PATH')).toBe(true);
        expect(env['HARNESS_TEST_ALLOWED']).toBe('yes');
        expect(env).not.toHaveProperty('OPENROUTER_API_KEY');
      } finally {
        delete process.env['OPENROUTER_API_KEY'];
        delete process.env['HARNESS_TEST_ALLOWED'];
      }
    });

    it('asks before writes that lead to running code, even under an admin\'s own rules', async () => {
      const { fns } = server.impl;
      const preview = { ...systemCtx({ config }), run: mintId('run') };
      const writes = async (path: string, on: FsConfig = config) => (await fns.write.flags?.({ path, text: 'x' }, { ...preview, config: on }) ?? []).map((flag) => [flag.kind, flag.action]);
      for (const path of ['.git/config', '.git/hooks/pre-commit', 'package.json', 'package-lock.json', 'vitest.config.ts', 'src/vite.config.mjs', 'tsconfig.json', '.husky/pre-commit', '.githooks/post-checkout', '.claude/settings.json', '.vscode/tasks.json', '.github/workflows/ci.yml']) {
        expect(await writes(path), path).toEqual([['runs-code', 'ask']]);
      }
      expect(await writes('src/b.ts')).toEqual([]);
      // reading one is fine: its flag passes
      expect((await fns.read.flags?.({ path: 'package.json' }, preview) ?? []).map((flag) => flag.action)).toEqual(['allow']);
      expect(await writes('.git/config', { ...config, sensitive: [] })).toEqual([['runs-code', 'ask']]);
      // where the file system finds names without case, another spelling is the same file
      if (process.platform === 'win32' || process.platform === 'darwin') {
        for (const path of ['.GIT/config', '.Git/hooks/pre-commit', 'PACKAGE.JSON', 'Vitest.Config.ts']) { expect(await writes(path), path).toEqual([['runs-code', 'ask']]); }
        expect(await writes('.GIT/config', { ...config, sensitive: [] })).toEqual([['runs-code', 'ask']]);
      }
      expect((await fns.bash.flags?.({ command: 'echo "[core] fsmonitor = x" >> .git/config' }, preview) ?? []).map((flag) => [flag.path, flag.kind, flag.access])).toEqual([['.git/config', 'runs-code', 'write']]);
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
