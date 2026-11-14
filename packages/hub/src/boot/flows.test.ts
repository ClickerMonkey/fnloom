/**
 * Flows the owner has described, run the way a chat model runs them: a scripted model's tool calls in chat turns on
 * the hub with every real module (an in-memory database). Records of a stored type are saved, changed and listed with
 * the hub's data fns, and the shapes models send wrongly are refused as invalid input with their path before anyone is
 * asked to approve; a write waits for its approval, and a decline's reason reaches the model; a fn switched off is
 * neither loaded nor run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorId, QualifiedName, mintId, type Json, type Manifest, type SessionId, type TurnId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingPush, testSettings } from '../api/testing/rig.ts';
import { manifestFor, shop } from '../catalog/fixtures.ts';
import { memoryLog } from '../testing.ts';
import { SCRIPTED_AS, ScriptedProvider, TEST_MODEL, calls, says, type ScriptedReply } from '../execution/testing.ts';
import type { RunningHub } from './index.ts';
import { hubModules } from './modules.ts';
import { startHub } from './start.ts';

const dir = mkdtempSync(join(tmpdir(), 'harness-flows-'));
let running: RunningHub;
const provider = new ScriptedProvider();
const ADA = ActorId.parse(mintId('actor'));
const TASK = 'shop/Task';

beforeAll(async () => {
  const base = testSettings();
  running = await startHub({
    port: 0, log: memoryLog().log, pushSender: recordingPush(), signals: false,
    keyMaker: { secret: () => 'k'.repeat(48), vapid: () => ({ publicKey: 'pub', privateKey: 'priv' }) },
    settings: {
      ...base,
      hubEnv: { ...base.hubEnv, HARNESS_DB_FILE: ':memory:', HARNESS_KEYS_FILE: join(dir, 'keys.json'), HARNESS_FILES_DIR: join(dir, 'files'), HARNESS_SYSTEMS_DIR: join(dir, 'systems') },
      logEnv: { ...base.logEnv, HARNESS_LOG_FILES: false },
    },
    modules: hubModules({ llm: () => ({ providers: { [SCRIPTED_AS]: provider }, models: [TEST_MODEL] }) }),
  });
  await running.services.store.table('actors').insert({ id: ADA, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 1, disabled: false });
  // a stored type of the shop's: tasks the hub keeps as records
  const shopManifest = await manifestFor(shop);
  const manifest: Manifest = {
    ...shopManifest,
    types: [...shopManifest.types, {
      name: 'Task', description: 'A task someone keeps.', display: { label: 'Task', title: 'title' }, methods: [],
      def: { name: 'obj', props: { title: { type: { name: 'text' } }, stars: { type: { name: 'num' } }, done: { type: { name: 'bool' } } } },
      records: { shape: 'table', owner: 'shared', search: { text: ['title'], embed: false } },
    }],
  };
  expect((await running.services.catalog.importManifest(manifest)).refused).toEqual([]);
});

afterAll(async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** How a pending approval is answered while a turn runs. */
type Answer = { readonly approve: boolean; readonly reason?: string };

/**
 * Send a message and run its turn to the end with the model's scripted `replies`, answering the approvals it waits on
 * with `answers`, in order. Gives the turn and what the model was sent back for each of its tool calls.
 */
async function chat(text: string, replies: ScriptedReply[], answers: Answer[] = [], session?: SessionId): Promise<{ session: SessionId; turn: TurnId; results: string[] }> {
  const { chat: service, store, execution } = running.services;
  const id = session ?? (await service.sessions.create({ owner: ADA })).id;
  const from = provider.requests.length;
  provider.script(...replies);
  const sent = await service.turns.send({ session: id, author: ADA, parts: [{ type: 'text', text }], client: { timeZone: 'UTC', locale: 'en', now: 0 } });
  const left = [...answers];
  for (let i = 0; i < 1_000; i += 1) {
    if ((await store.table('turns').get(sent.turn))?.status !== 'running') { break; }
    const pending = (await store.table('approvals').find({ where: { status: 'pending' }, limit: 1 })).items[0];
    const answer = pending === undefined ? undefined : left.shift();
    if (pending !== undefined && answer !== undefined) {
      await execution.policies.answer(pending.id, { by: ADA, approve: answer.approve, remember: 'once', ...(answer.reason === undefined ? {} : { reason: answer.reason }) });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const pending = (await store.table('approvals').find({ where: { status: 'pending' }, limit: 5 })).items.map((approval) => approval.fn);
  expect({ status: (await store.table('turns').get(sent.turn))?.status, pending }).toEqual({ status: 'done', pending: [] });
  // the model's script was used up: every reply was asked for
  expect(provider.replies).toEqual([]);
  const last = provider.requests.at(-1);
  expect(provider.requests.length).toBeGreaterThan(from);
  const results = (last?.messages ?? []).filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
  return { session: id, turn: sent.turn, results };
}

/** The runs of a turn, oldest first, as fn and status. */
async function runsOf(turn: TurnId): Promise<Array<{ fn: string; status: string }>> {
  const runs = (await running.services.store.table('runs').find({ where: { turn }, limit: 50 })).items;
  return runs.filter((run) => run.fn !== 'hub/chat').sort((a, b) => a.createdAt - b.createdAt).map((run) => ({ fn: run.fn, status: run.status }));
}

/** How many approvals were ever asked for. */
async function approvals(): Promise<number> {
  return running.services.store.table('approvals').count({});
}

/** The stored tasks' values. */
async function tasks(): Promise<Json[]> {
  return (await running.services.store.table('records').find({ where: { type: QualifiedName.parse(TASK) }, limit: 50 })).items.map((record) => record.value);
}

describe('records from chat', () => {
  it('refuses values that don\'t fit the type before anyone is asked, then saves once approved', async () => {
    const asked = await approvals();
    const { turn, results } = await chat('Add a task to pay the rent', [
      calls([['hub__load_fns', { fns: ['hub/record_save', 'hub/record_update', 'hub/records_table'] }]]),
      // the shapes models send wrongly: a number as words, the value as a JSON string, a field the type doesn't have
      calls([['hub__record_save', { type: TASK, value: { title: 'Pay rent', stars: 'many', done: false } }]]),
      calls([['hub__record_save', { type: TASK, value: '{"title":"Pay rent","stars":3,"done":false}' }]]),
      calls([['hub__record_save', { type: TASK, value: { title: 'Pay rent', stars: 3, done: false, due: 'friday' } }]]),
      calls([['hub__record_save', { type: 'shop/Nothing', value: { title: 'Pay rent' } }]]),
      calls([['hub__record_save', { type: TASK, value: { title: 'Pay rent', stars: 3, done: false } }]]),
      says('Added.'),
    ], [{ approve: true }]);
    // each wrong call was refused with the path of what is wrong, and only the right one was put to Ada
    expect(results[0]).toContain('"loaded"');
    expect(results[1]).toContain('value.stars');
    expect(results[2]).toMatch(/value\b/);
    expect(results[3]).toContain('due');
    expect(results[4]).toContain('no stored type shop/Nothing');
    expect(await runsOf(turn)).toEqual([
      { fn: 'hub/load_fns', status: 'done' },
      { fn: 'hub/record_save', status: 'invalid-input' },
      { fn: 'hub/record_save', status: 'invalid-input' },
      { fn: 'hub/record_save', status: 'invalid-input' },
      { fn: 'hub/record_save', status: 'invalid-input' },
      { fn: 'hub/record_save', status: 'done' },
    ]);
    expect(await approvals()).toBe(asked + 1);
    expect(await tasks()).toEqual([{ title: 'Pay rent', stars: 3, done: false }]);
  });

  it('changes a record\'s fields, refusing a wrong field or value by its path, and lists the records', async () => {
    const id = (await running.services.store.table('records').find({ where: { type: QualifiedName.parse(TASK) }, limit: 1 })).items[0]?.id ?? '';
    const asked = await approvals();
    const { turn, results } = await chat('Mark the rent task done', [
      calls([['hub__load_fns', { fns: ['hub/record_update', 'hub/records_table'] }]]),
      calls([['hub__record_update', { type: TASK, id, set: { done: 'yes' } }]]),
      calls([['hub__record_update', { type: TASK, id, set: { finished: true } }]]),
      calls([['hub__record_update', { type: TASK, id, set: { done: true } }]]),
      calls([['hub__records_table', { type: TASK }]]),
      says('Done.'),
    ], [{ approve: true }]);
    expect(results[1]).toContain('set.done');
    expect(results[2]).toContain('set.finished');
    expect(results[2]).toContain('has no field finished');
    expect(results[4]).toContain('Pay rent');
    expect((await runsOf(turn)).map((run) => run.status)).toEqual(['done', 'invalid-input', 'invalid-input', 'done', 'done']);
    expect(await approvals()).toBe(asked + 1);
    expect(await tasks()).toEqual([{ title: 'Pay rent', stars: 3, done: true }]);
  });

  it('tells the model why a person declined a write, and keeps nothing', async () => {
    const before = await tasks();
    const { turn, results } = await chat('Add a task to call mum', [
      calls([['hub__load_fns', { fns: ['hub/record_save'] }]]),
      calls([['hub__record_save', { type: TASK, value: { title: 'Call mum', stars: 1, done: false } }]]),
      says('Fine, I left it.'),
    ], [{ approve: false, reason: 'I did it already' }]);
    expect(results[1]).toContain('I did it already');
    expect(await runsOf(turn)).toEqual([{ fn: 'hub/load_fns', status: 'done' }, { fn: 'hub/record_save', status: 'cancelled' }]);
    expect(await tasks()).toEqual(before);
  });

  // records have `type` and `value` keys; gin once read them as value envelopes (fixed in gin's parseValue)
  it('lists the records with hub/records_find', async () => {
    const { results } = await chat('List my tasks', [
      calls([['hub__load_fns', { fns: ['hub/records_find'] }]]),
      calls([['hub__records_find', { type: TASK }]]),
      says('One task.'),
    ]);
    expect(results[1]).toContain('Pay rent');
  });
});

describe('a fn switched off', () => {
  it('is refused when the chat loads it and when it calls it, and runs again once switched back on', async () => {
    const { link } = running.services;
    const find = QualifiedName.parse('hub/records_table');
    await link.admin.switchItem({ section: 'fns', name: find, on: false }, ADA);
    const off = await chat('What tasks are there?', [
      calls([['hub__load_fns', { fns: ['hub/records_table'] }]]),
      calls([['hub__records_table', { type: TASK }]]),
      says('I can\'t list them now.'),
    ]);
    expect(off.results[0]).toContain('"refused"');
    expect(off.results[0]).toContain('hub/records_table');
    expect(off.results[0]).not.toMatch(/"loaded":\["hub\/records_table"\]/);
    expect(off.results[1]).toMatch(/turned off|switched off|unavailable|not/i);
    // nothing of it ran
    expect((await runsOf(off.turn)).filter((run) => run.fn === find && run.status === 'done')).toEqual([]);

    await link.admin.switchItem({ section: 'fns', name: find, on: true }, ADA);
    const on = await chat('What tasks are there now?', [
      calls([['hub__load_fns', { fns: ['hub/records_table'] }]]),
      calls([['hub__records_table', { type: TASK }]]),
      says('One task.'),
    ]);
    expect(on.results[0]).toMatch(/"loaded":\["hub\/records_table"\]/);
    expect(on.results[1]).toContain('Pay rent');
  });
});

describe('the hub\'s own fns as the chat calls them', () => {
  // each group of hub fns reaches its module through the lazy accessors `registerHubContract` gives it
  it('runs a fn of every module the chat can call, each answered by the module that owns it', async () => {
    const names = ['fns_search', 'inspect', 'model_limits', 'resource_list', 'budgets_list', 'explore_roots', 'search_resources', 'remember', 'load', 'context_get'];
    const { turn, results } = await chat('Remember that rent is due on the 1st, and show me what you can do', [
      calls([['hub__load_fns', { fns: names.map((name) => `hub/${name}`) }]]),
      calls([
        ['hub__fns_search', { text: 'records of tasks' }],
        ['hub__inspect', { name: 'shop/Task' }],
        ['hub__model_limits', {}],
        ['hub__resource_list', { limit: 5 }],
        ['hub__budgets_list', {}],
        ['hub__explore_roots', { system: 'shop' }],
        ['hub__search_resources', { query: 'rent' }],
      ]),
      calls([['hub__remember', { text: 'Rent is due on the 1st.', scope: 'user', title: 'Rent day' }]]),
      calls([['hub__load', { names: ['shop/guide'] }], ['hub__context_get', { name: 'shop/guide' }]]),
      says('Noted.'),
      // a memory for the person is a write: it may wait for Ada's approval
    ], [{ approve: true }]);
    expect(results[0]).toContain('"refused":[]');
    for (const result of results) { expect(result).not.toMatch(/has no implementation|not-implemented/); }
    // every call was answered, each from the module behind it: the catalog, the contextor, the models, the reads, the
    // person and admin reads, the index and the memories
    expect(await runsOf(turn)).toEqual(['load_fns', ...names].map((name) => ({ fn: `hub/${name}`, status: 'done' })));
    expect(results[1]).toMatch(/^\{"items":\[/);
    expect(results[2]).toContain('type shop/Task = obj{title: text, stars: num, done: bool}');
    expect(results[3]).toContain(TEST_MODEL.id);
    expect(results[8]).toContain('memory/rent-day');
    expect(results[9]).toContain('"loaded":["shop/guide"]');
    // the memory is kept as context, and the shop's guide reads with its text
    expect((await running.services.store.table('context').find({ limit: 50 })).items.some((item) => item.name.startsWith('memory/rent-day'))).toBe(true);
    expect(results.at(-1)).toContain('How the shop works');
  });
});
