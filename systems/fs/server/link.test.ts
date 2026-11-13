/**
 * The fs system end to end over the SDK's real link runtime: `serve` connects to an in-memory hub (`FakeHub`), sends
 * the manifest, gets its config, and every call below crosses the link as JSON and is checked against the contract on
 * both sides. Only the shell, git and file manager are fakes; files are real, in a temp folder.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { mintId, type Json, type OutcomeWire } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub, TEST_USER } from '@harness/sdk/server/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fs } from '../shared/index.ts';
import { AeyeDocuments } from './documents.ts';
import { fsEnv } from './env.ts';
import { createFsImpl } from './impl.ts';
import { fileUri } from './paths.ts';
import { DiskSnapshots } from './snapshots.ts';
import { FakeChanges, FakeGit, NO_IGNORES, FakeOpener, FakeRestarter, FakeShell, configFor, tempFolder } from './testing.ts';

const settings = { ...fsEnv.parse(), FS_SAFE_COMMANDS: ['ls'], FS_COMMAND_TIMEOUT: 1_000 };

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

describe('fs over the link', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let root: string;
  let hub: FakeHub;
  let shell: FakeShell;
  let running: RunningSystem<'fs'> | undefined;

  beforeEach(async () => {
    tmp = await tempFolder();
    root = `${tmp.path}/root`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(`${root}/a.txt`, 'alpha\nbeta\n');
    shell = new FakeShell((input) => ({ exitCode: 0, stdout: `ran ${input.command} in ${input.cwd}\n`, stderr: '', ended: 'exit' }));
    const server = createFsImpl({
      settings, shell,
      git: new FakeGit(new Map([[root, { branch: 'main', tracking: undefined, changes: ['M a.txt'] }]])),
      opener: new FakeOpener(),
      snapshots: new DiskSnapshots(`${tmp.path}/state/snapshots`),
      documents: new AeyeDocuments(createDefaultResourceRegistry()),
      restarter: new FakeRestarter(),
      watch: () => () => undefined,
      changes: new FakeChanges(),
      ignores: NO_IGNORES,
      now: () => 0,
    });
    hub = new FakeHub({ config: configFor(root) });
    running = await serve(fs, server.impl, { hub: 'ws://hub.test/link', state: `${tmp.path}/state`, version: '0.0.0' }, hub.host());
    await running.ready();
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
    await tmp.cleanup();
  });

  it('sends a manifest with every fn, the Entry type, the mention and the git hook', () => {
    const manifest = hub.manifests[0];
    expect(manifest?.name).toBe('fs');
    const text = JSON.stringify(manifest);
    for (const name of ['read', 'write', 'edit', 'list', 'glob', 'grep', 'cd', 'bash', 'remove', 'restart', 'explore', 'Entry', 'files', 'git', 'tree', 'guide']) {
      expect(text).toContain(`"${name}"`);
    }
  });

  it('reads, writes with a diff attachment, and undoes the write', async () => {
    expect(done(await hub.run('fs/read', { path: 'a.txt' }))).toEqual({ text: 'alpha\nbeta', lines: 2, truncated: false });
    const run = hub.runInfo('fs/write');
    const written = await hub.run('fs/write', { path: 'a.txt', text: 'gamma\n' }, { run });
    expect(done(written)).toEqual({ created: false });
    expect(hub.attachments.at(-1)).toMatchObject({ run: run.id, item: { attachment: 'fs/diff', title: 'Wrote a.txt', data: { before: 'alpha\nbeta\n', after: 'gamma\n' } } });
    expect(await readFile(`${root}/a.txt`, 'utf8')).toBe('gamma\n');
    const payload = written.status === 'done' ? written.undo : undefined;
    expect(payload).toMatchObject({ path: `${root}/a.txt`, previous: { mime: 'text/plain; charset=utf-8' } });
    const undone = await hub.peer().call('undo', { run, fn: 'write', kind: 'native', payload: payload ?? null });
    expect(undone.status).toBe('undone');
    expect(await readFile(`${root}/a.txt`, 'utf8')).toBe('alpha\nbeta\n');
  });

  it('fails a path outside the roots as the caller\'s problem, with its code', async () => {
    const outcome = await hub.run('fs/read', { path: `${tmp.path}/state/x` });
    expect(outcome).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'outside' } });
  });

  it('keeps cd in session state and runs bash there, asking the hub to confirm unsafe commands', async () => {
    const run = hub.runInfo('fs/cd');
    expect(done(await hub.run('fs/cd', { path: 'src' }, { run }))).toEqual({ cwd: `${root}/src` });
    expect(hub.state.get(`run:${run.id}`)?.values).toEqual({ cwd: `${root}/src` });

    hub.onHandle = () => Promise.resolve({ ok: true, value: true });
    const bash = await hub.run('fs/bash', { command: 'npm run build' }, { run: { ...hub.runInfo('fs/bash'), session: run.session }, handlers: ['confirm'] });
    expect(bash.status).toBe('done');
    expect(hub.handled.at(-1)).toMatchObject({ handler: 'confirm', args: { command: 'npm run build' } });
    expect(shell.calls.at(-1)?.command).toBe('npm run build');
  });

  it('serves the roots as resources and answers mentions and the git hook', async () => {
    const peer = hub.peer();
    expect((await peer.call('roots', undefined)).map((r) => r.name)).toEqual(['work']);
    const read = await peer.call('read', { uri: fileUri(`${root}/a.txt`), want: ['text'] });
    expect(read.text).toEqual({ inline: 'alpha\nbeta\n' });
    const time = { now: 0, timeZone: 'UTC', local: '1970-01-01T00:00:00Z' };
    const asker = { session: 'ses_1' as never, actor: TEST_USER.id, user: TEST_USER, time }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- a test session id
    const options = await peer.call('mentions', { ...asker, provider: 'files', query: 'a.t', request: mintId('mentionRequest') });
    expect(options[0]).toMatchObject({ label: 'a.txt', target: { root: 'work', path: 'a.txt' } });
    const blocks = await peer.call('hook', { hook: 'git', message: { session: asker.session, turn: 'trn_1', text: 'hi', user: TEST_USER, time } });
    expect(JSON.stringify(blocks)).toContain('branch main');
  });

  it('serves a root that is never indexed live, for the file explorer: listed and read on request, nothing reported or kept', async () => {
    await hub.configure(configFor(root, { index: 'none' }));
    const peer = hub.peer();
    const roots = await peer.call('roots', undefined);
    expect(roots).toMatchObject([{ name: 'work', index: 'none' }]);
    const uri = roots[0]?.uri;
    if (uri === undefined) { throw new Error('no root'); }
    const listed = await peer.call('list', { uri });
    expect(listed.items.map((item) => item.name).sort()).toEqual(['a.txt', 'src']);
    const file = listed.items.find((item) => item.name === 'a.txt');
    if (file === undefined) { throw new Error('no a.txt'); }
    const read = await peer.call('read', { uri: file.uri, want: ['text'] });
    expect(JSON.stringify(read)).toContain('alpha');
    expect(hub.changes).toEqual([]);
  });

  it('brings every file fn with its guide, and gives each fn instructions, examples and what it does to data', () => {
    const manifest = hub.manifests[0];
    expect(manifest?.context.find((item) => item.name === 'guide')?.fns.sort()).toEqual(['fs/bash', 'fs/cd', 'fs/edit', 'fs/glob', 'fs/grep', 'fs/list', 'fs/read', 'fs/remove', 'fs/write']);
    for (const decl of manifest?.fns ?? []) {
      expect(decl.instructions, decl.name).toBeTruthy();
      expect(decl.examples?.length ?? 0, decl.name).toBeGreaterThan(0);
    }
    expect(manifest?.fns.find((item) => item.name === 'read')?.effects).toEqual({ mode: 'read', free: true });
    expect(manifest?.fns.find((item) => item.name === 'remove')?.effects).toEqual({ mode: 'delete', free: true });
  });
});
