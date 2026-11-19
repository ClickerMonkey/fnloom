/**
 * The Claude pages and their state over a page host (item 8/9): the fleet reads the person's sessions from the hub
 * under the URL's filters and starts a session as the person's run in a chat made for it; a session's page reads its
 * record, transcript and waiting runs, draws the transcript as the chat's conversation, and sends, interrupts and
 * answers as the person's runs in the session's own chat. A send counts as sent only when its run settled done (what
 * the host's runs resolve with), never because the hub said `done` first.
 */
import { ApprovalId, InstanceName, RunId, type Approval } from '@harness/core';
import { PAGE_HOST } from '@harness/sdk';
import { ClientRuntime } from '@harness/sdk/client';
import claudeClient from './index.ts';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_PAGES } from '../shared/index.ts';
import { fakeHost, fakeHub, fakeInbox, fakeRuns, SESSION, sessionRecord, sessionValue, T0 } from './fakes.ts';
import { CLAUDE_FNS } from './logic.ts';
import { ClaudeFleet, ClaudeSessionStore, ClaudeStarter } from './state.ts';

const machine = InstanceName.parse('main');
const ref = { instance: machine, session: SESSION };

function approval(overrides: Partial<Approval> & Pick<Approval, 'run'>): Approval {
  return { id: ApprovalId.parse(`apr_${overrides.run}`), fn: 'claude/permit', approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: T0, preview: { title: 'Claude wants to use Bash', parts: [], irreversible: false }, ...overrides };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('the fleet store', () => {
  it('shows a page of sessions and reads more under them, the filters in the hub’s query', async () => {
    let cursor: string | undefined = 'c2';
    const { hub, calls } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue())], ...(cursor === undefined ? {} : { cursor }) }) });
    const fleet = new ClaudeFleet(hub);
    await fleet.show({ status: 'waiting' });
    expect(fleet.items.value).toHaveLength(1);
    expect(fleet.hasMore.value).toBe(true);
    expect(calls.records[0]?.query?.filters).toEqual([{ field: 'status', op: 'is', value: 'waiting' }]);
    cursor = undefined;
    await fleet.more();
    expect(calls.records[1]?.query?.cursor).toBe('c2');
    expect(fleet.items.value).toHaveLength(2);
    expect(fleet.hasMore.value).toBe(false);
  });

  it('says why the hub could not answer', async () => {
    const { hub } = fakeHub({ records: () => { throw new Error('The hub is busy.'); } });
    const fleet = new ClaudeFleet(hub);
    await fleet.show({});
    expect(fleet.problem.value).toContain('The hub is busy.');
  });
});

describe('starting a session', () => {
  it('says what is missing without running, then runs start_session in a chat made for it on the machine picked', async () => {
    const runs = fakeRuns(() => ({ ok: true, output: { instance: 'laptop', session: SESSION, status: 'working' } }));
    const starter = new ClaudeStarter(runs.make);
    expect(await starter.start({ machine: '', folder: '', prompt: '', title: '', mode: '' })).toBeUndefined();
    expect(Object.keys(starter.problems.value)).toEqual(['folder', 'prompt']);
    expect(runs.calls.runs).toHaveLength(0);
    const started = await starter.start({ machine: 'laptop', folder: 'C:/code/shop', prompt: 'Fix checkout', title: '', mode: '' });
    expect(started).toEqual({ instance: 'laptop', session: SESSION });
    expect(runs.calls.made).toEqual(['Claude: shop']);
    expect(runs.calls.runs[0]).toEqual({ fn: CLAUDE_FNS.start, args: { folder: 'C:/code/shop', prompt: 'Fix checkout', wait: false }, on: 'laptop' });
    starter.close();
    expect(runs.calls.closed).toBe(1);
  });

  it('says why a start did not go through', async () => {
    const runs = fakeRuns(() => ({ ok: false, problem: 'Declined by Ada' }));
    const starter = new ClaudeStarter(runs.make);
    expect(await starter.start({ machine: '', folder: 'C:/code/shop', prompt: 'Fix checkout', title: '', mode: '' })).toBeUndefined();
    expect(starter.problem.value).toBe('Declined by Ada');
  });
});

describe('a session’s state', () => {
  const page = { items: [{ type: 'assistant', uuid: 'a1', text: 'Working on it.' }], offset: 70, end: 71 };

  it('reads its record, the newest transcript page and its waiting runs, and answers a card from the inbox', async () => {
    const { hub, calls } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue())] }), readFn: () => page });
    const waiting = approval({ run: RunId.parse('run_w1') });
    const inbox = fakeInbox([waiting]);
    const store = new ClaudeSessionStore({ hub, runs: fakeRuns().make, inbox: inbox.inbox }, ref);
    await store.open();
    expect(store.record.value?.value.title).toBe('Fix checkout');
    expect(calls.readFn[0]).toEqual({ fn: CLAUDE_FNS.transcript, args: { instance: 'main', session: SESSION, offset: 0, limit: 50, fromEnd: true } });
    expect(store.older.value).toBe(true);
    await store.more();
    expect(calls.readFn[1]?.args).toMatchObject({ offset: 20, limit: 50, fromEnd: false });
    expect(inbox.loaded).toEqual([['run_w1']]);
    const [card] = store.waiting.value;
    expect(card?.inChat).toBe(false);
    if (card === undefined) { throw new Error('no card'); }
    expect(await store.decide(card, true, 'once', '', { answer: 'Postgres' })).toBe(true);
    expect(inbox.decided).toEqual([{ id: card.approval.id, approve: true, answer: { answer: 'Postgres' } }]);
    store.close();
  });

  it('puts its chat’s approvals about this session first, once each', async () => {
    const { hub } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue({ chat: 'ses_1', waiting: ['run_w1'] }))] }) });
    const runs = fakeRuns();
    const inChat = approval({ run: RunId.parse('run_w1'), createdAt: T0 + 1 });
    const other = approval({ run: RunId.parse('run_x'), createdAt: T0 });
    runs.state.approvals = [inChat, other];
    runs.state.args.set(inChat.run, { instance: 'main', session: SESSION });
    runs.state.args.set(other.run, { instance: 'main', session: 'someone-else' });
    const store = new ClaudeSessionStore({ hub, runs: runs.make, inbox: fakeInbox([inChat]).inbox }, ref);
    await store.open();
    expect(runs.calls.attached).toEqual(['ses_1']);
    expect(store.waiting.value.map((card) => [card.approval.run, card.inChat])).toEqual([['run_w1', true]]);
    store.close();
  });

  it('sends on the session’s machine, sent only once its run settled done', async () => {
    const { hub } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue({ chat: 'ses_1', waiting: [] }))] }), readFn: () => page });
    let outcome: { ok: true; output: null } | { ok: false; problem: string } = { ok: true, output: null };
    const runs = fakeRuns(() => outcome);
    const store = new ClaudeSessionStore({ hub, runs: runs.make, inbox: fakeInbox().inbox }, ref);
    await store.open();
    expect(await store.send('  Also add a test  ')).toBe(true);
    expect(runs.calls.runs[0]).toEqual({ fn: CLAUDE_FNS.send, args: { instance: 'main', session: SESSION, text: 'Also add a test', wait: false }, on: 'main' });
    expect(store.problem.value).toBe('');
    outcome = { ok: false, problem: 'The machine is offline.' };
    expect(await store.send('Again')).toBe(false);
    expect(store.problem.value).toBe('The machine is offline.');
    expect(await store.control('interrupt')).toBe(false);
    outcome = { ok: true, output: null };
    expect(await store.control('mode', 'plan')).toBe(true);
    expect(runs.calls.runs.at(-1)?.args).toEqual({ instance: 'main', session: SESSION, action: 'mode', mode: 'plan' });
    store.close();
  });

  it('adds new transcript entries while it works, read on from the newest stored message', async () => {
    let transcript = { items: [{ type: 'assistant', uuid: 'a1', text: 'Working on it.' }, { type: 'thinking', uuid: 'a1n', text: 'Edited a file.' }], offset: 0, end: 1 };
    const { hub, calls } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue({ status: 'working', waiting: [] }))] }), readFn: () => transcript });
    const store = new ClaudeSessionStore({ hub, runs: fakeRuns().make, inbox: fakeInbox().inbox }, ref);
    await store.open();
    transcript = { items: [{ type: 'assistant', uuid: 'a2', text: 'Done.' }], offset: 1, end: 2 };
    await store.refresh();
    expect(calls.readFn[1]?.args).toMatchObject({ offset: 1, fromEnd: false });
    expect(store.items.value.map((item) => item.uuid)).toEqual(['a1', 'a1n', 'a2']);
    store.close();
  });

  it('says when it is missing', async () => {
    const { hub } = fakeHub({ records: () => ({ items: [] }) });
    const store = new ClaudeSessionStore({ hub, runs: fakeRuns().make, inbox: fakeInbox().inbox }, ref);
    await store.open();
    expect(store.missing.value).toBe(true);
  });
});

/** The claude client build, loaded into the SDK's runtime as the app loads it. */
const runtime = new ClientRuntime({
  online: () => true, act: () => Promise.reject(new Error('no actions here')), invoke: () => Promise.reject(new Error('no runs here')),
  submit: () => Promise.reject(new Error('no forms here')), follow: () => Promise.reject(new Error('no deliveries here')),
});
runtime.register(claudeClient);

/** Mount one of the claude pages through the runtime with its host, as the app's page host does. */
function mountPage(page: string, path: readonly string[], made: ReturnType<typeof fakeHost>) {
  const found = runtime.pageView('claude', page, { path, host: made.host });
  if (found === undefined) { throw new Error(`the claude build has no page ${page}`); }
  return mount(found.component, { props: found.props, global: { provide: { [PAGE_HOST]: made.host } }, attachTo: document.body });
}

describe('the fleet page', () => {
  it('reads the sessions under the URL’s filters and links each to its page', async () => {
    const { hub, calls } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue())] }) });
    const made = fakeHost({ hub, query: { status: 'waiting', machine: 'main' } });
    const view = mountPage(CLAUDE_PAGES.fleet, [], made);
    await flushPromises();
    expect(calls.records[0]).toMatchObject({ type: 'claude/Session', query: { filters: [{ field: 'instance', op: 'is', value: 'main' }, { field: 'status', op: 'is', value: 'waiting' }] } });
    const row = view.get('[data-testid="claude-session-row"]');
    expect(row.attributes('href')).toBe(`/s/claude/session/main/${SESSION}`);
    expect(row.text()).toContain('1 waiting for you');
    await row.trigger('click', { button: 0 });
    expect(made.moves).toEqual([{ page: CLAUDE_PAGES.session, path: ['main', SESSION] }]);
    // a filter changed in the URL reads again
    made.query['status'] = 'idle';
    await flushPromises();
    expect(calls.records.at(-1)?.query?.filters).toContainEqual({ field: 'status', op: 'is', value: 'idle' });
  });

  it('opens New session in the URL and starts it, then goes to the session', async () => {
    const { hub } = fakeHub({ records: () => ({ items: [] }) });
    const runs = fakeRuns(() => ({ ok: true, output: { instance: 'main', session: SESSION, status: 'working' } }));
    const made = fakeHost({ hub, runs, query: { new: '1', folder: 'C:/code/shop' } });
    const view = mountPage(CLAUDE_PAGES.fleet, [], made);
    await flushPromises();
    expect(view.find('[data-testid="claude-new-form"]').exists()).toBe(true);
    // the folder in the URL is the new session's folder
    expect(view.get('[data-testid="claude-folder"]').attributes('data-value')).toBe('"C:/code/shop"');
    await view.get('[data-testid="claude-prompt"] input').setValue('Fix checkout');
    view.get('[data-testid="claude-start"]').element.dispatchEvent(new Event('click'));
    await flushPromises();
    expect(runs.calls.runs[0]?.fn).toBe(CLAUDE_FNS.start);
    expect(made.notes).toEqual([{ tone: 'ok', title: 'Session started', detail: undefined }]);
    expect(made.moves.at(-1)).toEqual({ page: CLAUDE_PAGES.session, path: ['main', SESSION], query: {} });
  });
});

describe('the session page', () => {
  const transcript = {
    items: [
      { type: 'user', uuid: 'u1', text: 'Fix the test' },
      { type: 'tool-use', uuid: 'a1', id: 'tu1', tool: 'Bash', input: { command: 'npm test' } },
      { type: 'tool-result', uuid: 'r1', id: 'tu1', ok: true, text: 'ok' },
      { type: 'assistant', uuid: 'a2', text: 'Fixed.' },
    ],
    offset: 0, end: 2,
  };

  it('draws the transcript as the chat’s conversation and sends from the composer', async () => {
    const { hub } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue({ chat: 'ses_1', waiting: [], status: 'idle' }))] }), readFn: () => transcript });
    const runs = fakeRuns();
    const made = fakeHost({ hub, runs });
    const view = mountPage(CLAUDE_PAGES.session, ['main', SESSION], made);
    await flushPromises();
    const conversation = view.get('[data-testid="claude-transcript"]');
    const entries: unknown = JSON.parse(conversation.attributes('data-entries') ?? '[]');
    expect(entries).toEqual([
      { kind: 'user', key: 'u1', text: 'Fix the test' },
      { kind: 'answer', key: 'a1', pieces: [{ kind: 'call', call: { key: 'a1', name: 'Bash', args: { command: 'npm test' }, status: 'done', output: 'ok' } }, { kind: 'text', text: 'Fixed.' }] },
    ]);
    expect(view.get('[data-testid="claude-facts"]').text()).toContain('$0.12');
    expect(view.get('[data-testid="claude-chat"]').attributes('href')).toBe('/c/ses_1');
    const composer = view.get('[data-testid="claude-composer"] [data-part="Composer"]');
    await composer.get('textarea').setValue('Also add a test');
    await composer.get('[data-action="send"]').trigger('click');
    await flushPromises();
    expect(runs.calls.runs[0]).toEqual({ fn: CLAUDE_FNS.send, args: { instance: 'main', session: SESSION, text: 'Also add a test', wait: false }, on: 'main' });
    // sent: the box clears, and nothing says it failed
    expect(made.notes.filter((note) => note.tone === 'error')).toEqual([]);
    expect(composer.get('textarea').element.value).toBe('');
    await composer.get('[data-action="stop"]').trigger('click');
    await flushPromises();
    expect(runs.calls.runs.at(-1)?.args).toMatchObject({ action: 'interrupt' });
  });

  it('keeps the text and says why when a send did not go through', async () => {
    const { hub } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue({ waiting: [], status: 'idle' }))] }), readFn: () => transcript });
    const made = fakeHost({ hub, runs: fakeRuns(() => ({ ok: false, problem: 'The machine is offline.' })) });
    const view = mountPage(CLAUDE_PAGES.session, ['main', SESSION], made);
    await flushPromises();
    const composer = view.get('[data-testid="claude-composer"] [data-part="Composer"]');
    await composer.get('textarea').setValue('Hello');
    await composer.get('[data-action="send"]').trigger('click');
    await flushPromises();
    expect(made.notes).toEqual([{ tone: 'error', title: "Couldn't send it", detail: 'The machine is offline.' }]);
    expect(composer.get('textarea').element.value).toBe('Hello');
  });

  it('shows a subagent’s transcript without a composer, and says when the session is not the person’s', async () => {
    const { hub, calls } = fakeHub({ records: () => ({ items: [sessionRecord(sessionValue({ waiting: [] }))] }), readFn: () => transcript });
    const made = fakeHost({ hub, query: { task: 'ag1' } });
    const view = mountPage(CLAUDE_PAGES.session, ['main', SESSION], made);
    await flushPromises();
    expect(calls.readFn[0]?.args).toMatchObject({ agent: 'ag1' });
    expect(view.find('[data-testid="claude-task-banner"]').exists()).toBe(true);
    expect(view.find('[data-testid="claude-composer"]').exists()).toBe(false);
    const missing = mountPage(CLAUDE_PAGES.session, ['main', SESSION], fakeHost({ hub: fakeHub({ records: () => ({ items: [] }) }).hub }));
    await flushPromises();
    expect(missing.find('[data-part="Empty"]').exists()).toBe(true);
  });
});
