/**
 * Build 9, the Claude fleet in the browser: the fleet's hub query, the transcript and task views, a new session's
 * args, the fleet and session stores over fake callers (the record and transcript reads, sends in the session's chat,
 * answers with a form), and the approval card's form.
 */
import { ApprovalId, ClaudeSession, DataRecord, InstanceName, Json, RunId, type ClaudeTask, type ClaudeTranscriptItem, type ProposalAsk } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { approval as sampleApproval } from '../chat/test/fakes.ts';
import { fakeChat, fakeChatApi } from '../chat/test/fakes.ts';
import ApprovalCard from '../components/approvals/ApprovalCard.vue';
import { approvableTogether } from '../components/approvals/rules.ts';
import { fakeDataApi } from '../data/test/fakes.ts';
import { DataStore } from '../data/state/data.ts';
import { fakeFnsApi } from '../fns/test/fakes.ts';
import { fakeCaller } from '../test/fakes.ts';
import { CLAUDE_FNS, fleetQuery, sessionsOf, startArgs, startDraft, taskTree, tasksLine, toolSummary, transcriptRows } from './logic/claude.ts';
import { ClaudeFleet, ClaudeStarter } from './state/fleet.ts';
import { ClaudeSessionStore } from './state/session.ts';

afterEach(() => { document.body.innerHTML = ''; });

const T0 = 1_762_000_000_000;
const SESSION = '0b6f3c1e-4a3e-4c55-9d5c-2f1e8a7b9c10';
const machine = InstanceName.parse('main');

function sessionValue(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return ClaudeSession.parse({
    instance: 'main', session: SESSION, folder: 'C:/code/shop', title: 'Fix checkout', status: 'waiting', owner: 'act_ada', permissionMode: 'default',
    waiting: ['run_w1'], asking: [], tasks: [], turns: 2, costUsd: 0.12, startedAt: T0, updatedAt: T0, ...overrides,
  });
}

function record(value: Json, id = 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0'): DataRecord {
  return DataRecord.parse({ id, type: 'claude/Session', value, title: 'Fix checkout', version: 1, createdAt: T0, updatedAt: T0 });
}

function task(overrides: Partial<ClaudeTask> & Pick<ClaudeTask, 'id'>): ClaudeTask {
  return { kind: 'agent', description: 'A task', status: 'done', startedAt: T0, updatedAt: T0, ...overrides };
}

describe('the fleet query and views', () => {
  it('filters by machine, folder and status, searches the words and sorts newest first', () => {
    expect(fleetQuery({ q: ' checkout ', machine: 'main', folder: 'C:/code/shop', status: 'waiting' }, 'c2')).toEqual({
      type: 'claude/Session', search: 'checkout',
      query: {
        limit: 30, cursor: 'c2', sort: [{ field: 'updatedAt', dir: 'desc' }],
        filters: [{ field: 'instance', op: 'is', value: 'main' }, { field: 'folder', op: 'is', value: 'C:/code/shop' }, { field: 'status', op: 'is', value: 'waiting' }],
      },
    });
    expect(fleetQuery({})).toEqual({ type: 'claude/Session', query: { limit: 30, sort: [{ field: 'updatedAt', dir: 'desc' }] } });
  });

  it('keeps only records that are sessions', () => {
    const found = sessionsOf([record(Json.parse(sessionValue())), record({ title: 'not a session' }, 'rec_01JABCDEFGHJKMNPQRSTVWXYZ1')]);
    expect(found.map((s) => s.value.title)).toEqual(['Fix checkout']);
  });

  it('pairs each tool use with its result and says what it does', () => {
    const items: ClaudeTranscriptItem[] = [
      { type: 'user', uuid: 'u1', text: 'Fix the test' },
      { type: 'thinking', uuid: 't1', text: '' },
      { type: 'tool-use', uuid: 'a1', id: 'tu1', tool: 'Bash', input: { command: 'npm test\nmore', description: 'Run tests' } },
      { type: 'tool-result', uuid: 'r1', id: 'tu1', ok: false, text: '1 failed' },
      { type: 'tool-result', uuid: 'r2', id: 'tu9', ok: true, text: 'orphan' },
      { type: 'assistant', uuid: 'a2', text: 'Fixed.' },
    ];
    expect(transcriptRows(items)).toEqual([
      { type: 'user', key: 'u1', text: 'Fix the test' },
      { type: 'tool', key: 'a1', tool: 'Bash', summary: 'npm test', input: { command: 'npm test\nmore', description: 'Run tests' }, result: { ok: false, text: '1 failed' } },
      { type: 'system', key: 'r2', text: 'orphan' },
      { type: 'assistant', key: 'a2', text: 'Fixed.' },
    ]);
    expect(toolSummary({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(toolSummary(['x'])).toBe('');
  });

  it('nests tasks under the one that started them, running first', () => {
    const tasks = [
      task({ id: 'w', kind: 'workflow', name: 'release', status: 'done', startedAt: T0 + 3 }),
      task({ id: 'a', parent: 'w', startedAt: T0 + 1 }),
      task({ id: 'b', parent: 'w', status: 'running', startedAt: T0 }),
      task({ id: 's', kind: 'shell', status: 'running', parent: 'gone' }),
    ];
    const tree = taskTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual(['s', 'w']);
    expect(tree[1]?.children.map((n) => n.task.id)).toEqual(['b', 'a']);
    expect(tasksLine(tasks)).toBe('2 tasks running');
    expect(tasksLine([task({ id: 'x' })])).toBe('1 task');
  });

  it('checks a new session and says what is missing', () => {
    expect(startArgs({ ...startDraft(), prompt: '  ' })).toEqual({ ok: false, problems: { folder: 'Pick the folder it works in.', prompt: 'Say what Claude should do.' } });
    expect(startArgs({ machine: '', folder: 'C:/code/shop', prompt: 'Fix it', title: '', mode: 'plan' })).toEqual({ ok: true, args: { folder: 'C:/code/shop', prompt: 'Fix it', permissionMode: 'plan', wait: false } });
    expect(startArgs({ ...startDraft('C:/code/shop', 'laptop'), prompt: 'Fix it' })).toMatchObject({ ok: true, on: 'laptop' });
  });
});

function dataStore(records: () => DataRecord[], transcript: Json | (() => Json) = { items: [], offset: 0, end: 0 }) {
  const api = fakeDataApi();
  const calls = { records: fakeCaller<'records'>(() => Promise.resolve({ items: records() })), readFn: fakeCaller<'readFn'>(() => Promise.resolve(typeof transcript === 'function' ? transcript() : transcript)) };
  return { store: new DataStore({ ...api, ...calls }, fakeFnsApi()), calls };
}

describe('the fleet store', () => {
  it('shows a page of sessions and reads more under them', async () => {
    let cursor: string | undefined = 'c2';
    const api = fakeDataApi();
    const records = fakeCaller<'records'>(() => Promise.resolve({ items: [record(Json.parse(sessionValue()))], ...(cursor === undefined ? {} : { cursor }) }));
    const fleet = new ClaudeFleet(new DataStore({ ...api, records }, fakeFnsApi()));
    await fleet.show({ status: 'waiting' });
    expect(fleet.items.value).toHaveLength(1);
    expect(fleet.hasMore.value).toBe(true);
    cursor = undefined;
    await fleet.more();
    expect(records.calls[1]?.[0].query?.cursor).toBe('c2');
    expect(fleet.items.value).toHaveLength(2);
    expect(fleet.hasMore.value).toBe(false);
  });
});

describe('starting a session', () => {
  it('says what is missing without running, and runs start_session in a chat made for it', async () => {
    const api = fakeChatApi();
    const { chat } = fakeChat({ api });
    const starter = new ClaudeStarter(chat);
    expect(await starter.start(startDraft())).toBeUndefined();
    expect(Object.keys(starter.problems.value)).toEqual(['folder', 'prompt']);
    expect(api.createSession.calls).toHaveLength(0);
    void starter.start({ ...startDraft('C:/code/shop'), prompt: 'Fix checkout' });
    await flushPromises();
    expect(api.createSession.calls[0]?.[0]).toMatchObject({ title: 'Claude: shop' });
    expect(api.invoke.calls[0]?.[0]).toMatchObject({ fn: CLAUDE_FNS.start, args: { folder: 'C:/code/shop', prompt: 'Fix checkout', wait: false } });
    expect(starter.busy.value).toBe(true);
    starter.close();
  });
});

describe('a session page', () => {
  const page: Json = { items: [{ type: 'assistant', uuid: 'a1', text: 'Working on it.' }], offset: 70, end: 71 };

  it('reads its record, the first transcript page, and its waiting runs', async () => {
    const { store: data, calls } = dataStore(() => [record(Json.parse(sessionValue()))], page);
    const { chat, api } = fakeChat();
    const store = new ClaudeSessionStore({ data, chat, desk: chat.approvals }, { instance: machine, session: SESSION });
    await store.open();
    expect(store.record.value?.value.title).toBe('Fix checkout');
    // the newest page first, then earlier ones above it
    expect(calls.readFn.calls[0]?.[0]).toEqual({ fn: CLAUDE_FNS.transcript, args: { instance: 'main', session: SESSION, offset: 0, limit: 50, fromEnd: true } });
    expect(store.items.value).toHaveLength(1);
    expect(store.older.value).toBe(true);
    await store.more();
    expect(calls.readFn.calls[1]?.[0].args).toMatchObject({ offset: 20, limit: 50, fromEnd: false });
    expect(api.approvals.calls[0]?.[0]).toEqual({ runs: ['run_w1'] });
    // the waiting run's approval (from the desk) is a card answered with its form's value
    const [card] = store.waiting.value;
    expect(card?.inThread).toBe(false);
    if (card === undefined) { throw new Error('no card'); }
    expect(await store.decide(card, true, 'once', '', { answer: 'Postgres' })).toBe(true);
    expect(api.approve.calls.at(-1)?.[0]).toMatchObject({ approval: card.approval.id, approve: true, answer: { answer: 'Postgres' } });
    store.close();
  });

  it('sends in the session\'s own chat', async () => {
    const { store: data } = dataStore(() => [record(Json.parse(sessionValue({ chat: 'ses_1', waiting: [] })))], page);
    const api = fakeChatApi();
    const { chat } = fakeChat({ api });
    const store = new ClaudeSessionStore({ data, chat, desk: chat.approvals }, { instance: machine, session: SESSION });
    await store.open();
    void store.send('Also add a test');
    await flushPromises();
    expect(api.createSession.calls).toHaveLength(0);
    expect(api.invoke.calls[0]?.[0]).toMatchObject({ session: 'ses_1', fn: CLAUDE_FNS.send, args: { instance: 'main', session: SESSION, text: 'Also add a test', wait: false } });
    store.close();
  });

  it('adds new transcript entries while it works, once read to the end', async () => {
    let transcript: Json = { items: [{ type: 'assistant', uuid: 'a1', text: 'Working on it.' }, { type: 'thinking', uuid: 'a1n', text: 'Edited a file.' }], offset: 0, end: 1 };
    const { store: data, calls } = dataStore(() => [record(Json.parse(sessionValue({ status: 'working', waiting: [] })))], () => transcript);
    const { chat } = fakeChat();
    const store = new ClaudeSessionStore({ data, chat, desk: chat.approvals }, { instance: machine, session: SESSION });
    await store.open();
    transcript = { items: [{ type: 'assistant', uuid: 'a2', text: 'Done.' }], offset: 1, end: 2 };
    await store.refresh();
    // read on from the stored message after the newest shown, not from the number of items it made
    expect(calls.readFn.calls[1]?.[0].args).toMatchObject({ offset: 1, fromEnd: false });
    expect(store.items.value.map((item) => item.uuid)).toEqual(['a1', 'a1n', 'a2']);
    store.close();
  });

  it('says when it is missing', async () => {
    const { store: data } = dataStore(() => []);
    const { chat } = fakeChat();
    const store = new ClaudeSessionStore({ data, chat, desk: chat.approvals }, { instance: machine, session: SESSION });
    await store.open();
    expect(store.missing.value).toBe(true);
  });
});

describe('an approval that asks', () => {
  const ask: ProposalAsk = { type: { name: 'obj', props: { answer: { type: { name: 'text' } } } }, into: 'answer' };

  it('waits for the form, then answers with its value', async () => {
    const card = mount(ApprovalCard, { props: { fn: 'claude/answer', description: '', args: undefined, ask, ident: 'apr_1' }, attachTo: document.body });
    await flushPromises();
    expect(card.get('[data-testid=approve]').text()).toBe('Answer');
    await card.get('[data-testid=approval-ask] input').setValue('Postgres');
    await card.get('[data-testid=approve]').trigger('click');
    expect(card.emitted('decide')?.[0]).toEqual([true, 'once', '', { answer: 'Postgres' }]);
  });

  it('approves a tool use with its optional "always" tick left alone', async () => {
    const always = { type: { name: 'optional', generic: { T: { name: 'bool' } } }, into: 'always' };
    const card = mount(ApprovalCard, { props: { fn: 'claude/permit', description: '', args: undefined, ask: always, ident: 'apr_3' }, attachTo: document.body });
    await flushPromises();
    expect(card.get('[data-testid=approve]').text()).toBe('Approve');
    await card.get('[data-testid=approve]').trigger('click');
    expect(card.emitted('decide')?.[0]?.[0]).toBe(true);
  });

  it('is never approved with others', () => {
    const plain = sampleApproval({ id: ApprovalId.parse('apr_2'), run: RunId.parse('run_2') });
    expect(approvableTogether([plain, { ...plain, ask }])).toEqual([plain]);
  });
});
