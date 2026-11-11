/** Build 6: the pieces without a rig of their own: the auto mode gate and approval fns, the link's models and reads, and the Systems page's calls to a host. */
import { reject } from '@ayepi/core';
import { ApprovalId, InstanceName, MAIN_INSTANCE, QualifiedName, RunId, SectionKey, SystemName, noFnStats, type FnRecord, type RunSettled, type LinkSession, type ModelRoleView, type Session } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { SessionModeGate } from '../fns/gate.ts';
import { linkModels } from '../models/create.ts';
import { linkReadHandlers } from '../link/reads.ts';
import { viaHost } from '../api/admin-ops.ts';
import type { RunInput } from '../execution/index.ts';
import { linkPayload, testStore } from '../testing.ts';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../execution/testing.ts';

const FS = SystemName.parse('fs');

/** A fn record of fs with an optional approval. */
function fnRecord(name: string, approval?: FnRecord['decl']['approval']): FnRecord {
  return {
    name: QualifiedName.parse(`fs/${name}`), system: FS, version: 'v1', origin: 'contract', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0,
    decl: {
      name, description: name, kind: 'native', args: { name: 'obj', props: {} }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [],
      ...(approval === undefined ? {} : { approval }),
    },
  };
}

describe('auto mode and fns that always ask', () => {
  it('never asks the classifier about a fn with an approval: its approver answers', async () => {
    const asked: string[] = [];
    const gate = new SessionModeGate(
      () => ({ modes: (names) => Promise.resolve(new Map(names.map((n) => [n, 'write' as const]))), registry: (names) => Promise.resolve(new Map(names.map((n) => [n, []]))) }),
      () => ({ classify: (input) => { asked.push(input.fn.name); return Promise.resolve({ allow: true, reason: 'fine' }); } }),
    );
    const session = { fnMode: 'auto' } as const satisfies Pick<Session, 'fnMode'>;
    const check = (fn: FnRecord) => gate.check({ session: { ...sessionRow(), ...session }, fn, args: {}, run: RunId.parse('run_1') });
    expect(await check(fnRecord('install_system', { preview: true, remember: false, approver: 'admins' }))).toEqual({ effect: 'pass' });
    expect(await check(fnRecord('write'))).toEqual({ effect: 'allow', reason: 'fine' });
    expect(asked).toEqual(['fs/write']);
  });
});

/** A session row for the gate. */
function sessionRow(): Session {
  return {
    id: 'ses_1', title: 'T', owner: ALICE, agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript: [],
    createdAt: 0, updatedAt: 0, archived: false,
  } as const satisfies Session;
}

describe('the models a system\'s aeye sees (`models` on the link)', () => {
  it('gives each model its tier, output cap and the roles it fills now', () => {
    const roles: ModelRoleView[] = [
      { role: 'chat', from: 'setting', resolved: { model: 'qwen2.5:3b', provider: 'ollama' } },
      { role: 'describe', from: 'none' },
    ];
    const listed = linkModels([
      { id: 'qwen2.5:3b', provider: 'ollama', name: 'Qwen', capabilities: ['chat'], tier: 'efficient', maxOutputTokens: 2048 },
      { id: 'gpt-x', provider: 'openai', name: 'X', capabilities: ['chat', 'vision'] },
    ], roles);
    expect(listed).toEqual([
      { id: 'qwen2.5:3b', provider: 'ollama', name: 'Qwen', capabilities: ['chat'], tier: 'efficient', maxOutputTokens: 2048, roles: ['chat'] },
      { id: 'gpt-x', provider: 'openai', name: 'X', capabilities: ['chat', 'vision'], tier: 'efficient', roles: [] },
    ]);
  });
});

describe('link reads as the run\'s person', () => {
  it('reads a resource as the run\'s person, refuses another system\'s run, and hides what the person may not see', async () => {
    const store = await testStore();
    await store.table('turns').insert({ id: 'trn_1', actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0, errors: 'feed-back', createdAt: 0 });
    await store.table('runs').insert({
      id: RunId.parse('run_1'), fn: QualifiedName.parse('fs/read'), fnVersion: 'v1', kind: 'native', system: FS, root: RunId.parse('run_1'), turn: 'trn_1', key: 'k', actor: ALICE, caller: ALICE,
      args: {}, status: 'running', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
    });
    const readers: string[] = [];
    const handlers = linkReadHandlers({
      store: () => store,
      access: (actor) => { readers.push(actor); return Promise.resolve({ ...openScope(actor), seesUri: (uri: string) => !uri.includes('private') }); },
      router: () => ({ read: (uri) => Promise.resolve({ stat: { uri, name: 'a', type: 'file', version: 'v1' }, text: { inline: 'whole' } }) }),
      reader: () => ({
        read: (args) => Promise.resolve({ uri: args.uri, form: 'raw', text: `section ${args.section ?? ''}`, offset: 0, total: 9, truncated: false, forms: [], offers: [] }),
        outline: () => Promise.resolve([]),
      }),
      pairing: () => ({ grant: () => Promise.reject(reject(403, 'NO', 'no')) }),
    });
    const fs: LinkSession = { system: FS, instance: MAIN_INSTANCE, boot: 'b' };
    const call = <T>(data: T, link: LinkSession = fs) => linkPayload(data, link);
    const read = await handlers.resource(call({ uri: 'file:///work/a.md', want: ['text' as const], run: RunId.parse('run_1'), sections: [SectionKey.parse('Intro'), SectionKey.parse('Usage')] }));
    expect(read.text).toEqual({ inline: 'section Intro\n\nsection Usage' });
    expect(readers).toEqual([ALICE]);
    await expect(handlers.resource(call({ uri: 'file:///private/b.md', want: ['text' as const], run: RunId.parse('run_1') }))).rejects.toMatchObject({ status: 404 });
    await expect(handlers.resourceSections(call({ uri: 'file:///work/a.md', run: RunId.parse('run_1') }, { ...fs, system: SystemName.parse('web') }))).rejects.toMatchObject({ status: 403 });
    // a run on another instance of the system, or one that has settled with nothing left to undo, reads as nobody
    await store.table('runs').update(RunId.parse('run_1'), { instance: InstanceName.parse('laptop') });
    await expect(handlers.resourceSections(call({ uri: 'file:///work/a.md', run: RunId.parse('run_1') }))).rejects.toMatchObject({ status: 403, code: 'NOT_YOUR_RUN' });
    await store.table('runs').update(RunId.parse('run_1'), { instance: MAIN_INSTANCE, status: 'done' });
    await expect(handlers.resourceSections(call({ uri: 'file:///work/a.md', run: RunId.parse('run_1') }))).rejects.toMatchObject({ status: 403, code: 'RUN_SETTLED' });
    await store.table('runs').update(RunId.parse('run_1'), { undo: { file: 'a.md' } });
    expect(await handlers.resourceSections(call({ uri: 'file:///work/a.md', run: RunId.parse('run_1') }))).toEqual([]);
  });
});

describe('a hosted instance from the Systems page', () => {
  it('goes to the host instance that runs it, naming the instance, and leaves an unhosted one to the supervisor', async () => {
    const store = await testStore();
    await store.table('actors').insert({ id: ALICE, kind: 'user', name: 'Alice', about: '', email: 'alice@example.com', role: 'admin', createdAt: 0, disabled: false });
    const notes = SystemName.parse('notes');
    const laptop = InstanceName.parse('laptop');
    const host = { system: FS, instance: InstanceName.parse('lab') };
    await store.table('instances').put({
      system: notes, instance: laptop, description: '', status: 'connected', keyFingerprint: 'k', publicKey: 'p', version: '1', manifestHash: 'm',
      host: { host, path: '/systems/notes', bundleHash: 'b', approval: ApprovalId.parse('apr_1') },
    });
    const started: RunInput[] = [];
    const hub = {
      store, clock: () => 5,
      execution: {
        limits: { resolve: () => Promise.resolve(OPEN_LIMITS) },
        runs: { start: (input: RunInput) => { started.push(input); return Promise.resolve({ run: RunId.parse('run_host'), settled: Promise.resolve<RunSettled>({ status: 'done', result: {} }) }); } },
      },
    };
    expect(await viaHost(hub, { system: notes, instance: laptop }, 'restart_system', ALICE, 'stuck')).toEqual({ ok: true });
    expect(await viaHost(hub, { system: notes, instance: laptop }, 'stop_system', ALICE)).toEqual({ ok: true });
    expect(started.map((input) => ({ fn: input.fn, args: input.args, on: input.on }))).toEqual([
      { fn: 'fs/restart_system', args: { system: 'notes', instance: 'laptop', reason: 'stuck' }, on: 'lab' },
      { fn: 'fs/stop_system', args: { system: 'notes', instance: 'laptop' }, on: 'lab' },
    ]);
    expect(await viaHost(hub, { system: notes }, 'stop_system', ALICE)).toBeUndefined();
  });
});
