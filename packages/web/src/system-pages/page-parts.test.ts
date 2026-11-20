/**
 * What a system page reaches through its host besides the hub (item 8/9), on the app's real code: runs in a chat of
 * the person's (`ChatRuns` over a real `ThreadStore`), resolving only once the run settled with its outcome (the
 * regression for the Claude page's false "send failed"); the inbox's approvals; a conversation drawn with the chat's own
 * parts; the chat's composer; the approval card; and the old `/claude` URLs redirecting to the claude system's pages.
 */
import { ApprovalId, InstanceName, RunId, SessionId, type ProposalAsk } from '@harness/core';
import type { ConversationEntry } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '../app/router.ts';
import { LONG_PRESS_MS } from '../ui/index.ts';
import { ROUTES } from '../app/routes.ts';
import { approval as sampleApproval, fakeChat, fakeChatApi, run as sampleRun } from '../chat/test/fakes.ts';
import { approvableTogether } from '../components/approvals/rules.ts';
import { STORES } from '../state/stores.ts';
import { fakeCaller, fakeStores } from '../test/fakes.ts';
import { callRun, conversationItems, NO_TIME, PAGE_AGENT } from './conversation.ts';
import PageApproval from './PageApproval.vue';
import PageComposer from './PageComposer.vue';
import PageConversation from './PageConversation.vue';
import { ChatRuns, pageInbox } from './runs.ts';

const SEND = 'claude/send' as const;
const S1 = SessionId.parse('ses_1');

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('a page’s runs in a chat (host.runs)', () => {
  it('makes a chat for its runs on first use, named by the page', async () => {
    const api = fakeChatApi();
    const { chat } = fakeChat({ api });
    const runs = new ChatRuns(chat, { title: () => 'Claude: shop' });
    void runs.run(SEND, { text: 'hi' });
    await flushPromises();
    expect(api.createSession.calls[0]?.[0]).toMatchObject({ title: 'Claude: shop' });
    expect(api.invoke.calls[0]?.[0]).toMatchObject({ fn: SEND, args: { text: 'hi' } });
    runs.close();
  });

  it('runs in an attached chat on the instance named, without making one', async () => {
    const api = fakeChatApi();
    const { chat } = fakeChat({ api });
    const runs = new ChatRuns(chat, { title: () => 'unused' });
    runs.attach(S1);
    void runs.run(SEND, { text: 'hi' }, { on: InstanceName.parse('laptop') });
    await flushPromises();
    expect(api.createSession.calls).toHaveLength(0);
    expect(api.invoke.calls[0]?.[0]).toMatchObject({ session: 'ses_1', fn: SEND, on: 'laptop' });
    runs.close();
  });

  it('counts a run as done when the done event comes before its outcome (no false "It ended done.")', async () => {
    const api = fakeChatApi();
    let recorded = sampleRun({ id: 'run_inv', fn: SEND, status: 'running' });
    api.run = fakeCaller<'run'>(() => Promise.resolve(recorded));
    const { chat, sessionEvents } = fakeChat({ api });
    const runs = new ChatRuns(chat, { title: () => 'Claude' });
    runs.attach(S1);
    let outcome: unknown;
    void runs.run(SEND, { text: 'hi' }).then((o) => { outcome = o; });
    await flushPromises();
    // the hub says done before the run's record (with the outcome) is read
    recorded = sampleRun({ id: 'run_inv', fn: SEND, status: 'done', outcome: { status: 'done', result: { status: 'working' } } });
    sessionEvents.push(S1, { type: 'run', run: RunId.parse('run_inv'), fn: SEND, update: { type: 'status', status: 'done' } });
    expect(outcome).toBeUndefined();
    await flushPromises();
    expect(outcome).toEqual({ ok: true, output: { status: 'working' } });
    expect(runs.problem).toBe('');
    runs.close();
  });

  it('says why a declined run did not finish', async () => {
    const api = fakeChatApi();
    const declined = { class: 'caller' as const, code: 'denied', message: 'Declined by Ada: not now' };
    api.run = fakeCaller<'run'>(() => Promise.resolve(sampleRun({ id: 'run_inv', fn: SEND, status: 'cancelled', outcome: { status: 'cancelled', error: declined }, errors: [{ attempt: 1, at: 0, error: declined, cost: 0 }] })));
    const { chat, sessionEvents } = fakeChat({ api });
    const runs = new ChatRuns(chat, { title: () => 'Claude' });
    runs.attach(S1);
    let waited = false;
    const outcome = runs.run(SEND, { text: 'hi' }, { waiting: () => { waited = true; } });
    await flushPromises();
    sessionEvents.push(S1, { type: 'run', run: RunId.parse('run_inv'), fn: SEND, update: { type: 'status', status: 'cancelled' } });
    expect(await outcome).toEqual({ ok: false, problem: 'Declined by Ada: not now' });
    expect(waited).toBe(false);
    runs.close();
  });

  it('gives its chat’s approvals and their runs’ args, and answers one there', async () => {
    const api = fakeChatApi();
    const waiting = sampleApproval({ id: ApprovalId.parse('apr_w'), run: RunId.parse('run_w'), fn: 'claude/permit' });
    api.waiting = fakeCaller<'waiting'>(() => Promise.resolve({ approvals: [waiting], handlers: [] }));
    api.run = fakeCaller<'run'>(() => Promise.resolve(sampleRun({ id: 'run_w', fn: 'claude/permit', status: 'awaiting-approval', args: { session: 'abc' } })));
    const { chat } = fakeChat({ api });
    const runs = new ChatRuns(chat, { title: () => 'Claude' });
    expect(runs.approvals).toEqual([]);
    runs.attach(S1);
    await flushPromises();
    runs.refresh();
    await flushPromises();
    expect(runs.approvals.map((a) => a.id)).toEqual(['apr_w']);
    expect(runs.argsOf(RunId.parse('run_w'))).toEqual({ session: 'abc' });
    expect(await runs.approve(waiting, true, 'once', '', undefined)).toBe(true);
    expect(api.approve.calls.at(-1)?.[0]).toMatchObject({ approval: 'apr_w', approve: true });
    runs.close();
  });
});

describe('the inbox’s approvals (host.inbox)', () => {
  it('reads the approvals of some runs and answers one with its form’s value', async () => {
    const api = fakeChatApi();
    const { chat } = fakeChat({ api });
    const inbox = pageInbox(chat.approvals);
    await inbox.load([RunId.parse('run_w1')]);
    expect(api.approvals.calls[0]?.[0]).toEqual({ runs: ['run_w1'] });
    const found = inbox.byRun(RunId.parse('run_w1'));
    if (found === undefined) { throw new Error('no approval'); }
    expect(await inbox.decide(found, true, '', { answer: 'Postgres' })).toBe(true);
    expect(api.approve.calls.at(-1)?.[0]).toMatchObject({ approval: found.id, approve: true, answer: { answer: 'Postgres' } });
  });
});

const ENTRIES: readonly ConversationEntry[] = [
  { kind: 'user', key: 'u1', text: 'Fix the checkout test' },
  {
    kind: 'answer', key: 'a1', pieces: [
      { kind: 'reasoning', text: 'Look at the test first.' },
      { kind: 'call', call: { key: 'c1', name: 'Bash', args: { command: 'npm test' }, status: 'failed', output: '1 failed' } },
      { kind: 'call', call: { key: 'c2', name: 'Read', args: { file_path: 'src/cart.ts' }, status: 'done', output: 'export const total = …' } },
      { kind: 'text', text: 'The total skips the **delivery fee**.' },
    ],
  },
  { kind: 'note', key: 'n1', text: 'Session resumed.' },
];

describe('a conversation drawn with the chat’s parts (components.Conversation)', () => {
  it('maps messages, answers and calls to what the chat’s parts take', () => {
    const items = conversationItems(ENTRIES, { system: 'claude', me: PAGE_AGENT, streaming: true });
    expect(items.map((item) => item.kind)).toEqual(['user', 'answer', 'note']);
    const answer = items[1];
    if (answer?.kind !== 'answer') { throw new Error('no answer'); }
    expect(answer.message.status).toBe('streaming');
    expect(answer.message.createdAt).toBe(NO_TIME);
    // reasoning, then one stretch of calls, then the words: in the order the agent made them
    expect(answer.segments.map((s) => s.kind)).toEqual(['reasoning', 'runs', 'text']);
    expect(answer.runs.map((run) => [run.fn, run.status])).toEqual([['claude/Bash', 'failed'], ['claude/Read', 'done']]);
    expect(callRun('claude', { key: 'c3', name: 'Grep', args: {}, status: 'running' }).outcome).toBeUndefined();
    expect(callRun('claude', { key: 'c4', name: 'Grep', args: {}, status: 'failed' }).outcome).toMatchObject({ error: { message: 'It failed.' } });
  });

  it('draws the person’s bubble, the answer with its run fold and markdown, and the note, with no made-up times', async () => {
    const { stores } = fakeStores({ signedIn: true });
    const view = mount(PageConversation, { props: { entries: ENTRIES, agent: 'Claude', system: 'claude' }, global: { provide: { [STORES]: stores } }, attachTo: document.body });
    await flushPromises();
    expect(view.get('[data-testid="user-message"]').text()).toContain('Fix the checkout test');
    const answer = view.get('[data-testid="assistant-answer"]');
    expect(answer.text()).toContain('Claude');
    expect(answer.get('[data-testid="answer-text"] strong').text()).toBe('delivery fee');
    // two calls in a row fold into one section, which opens to the chat's run cards
    const group = answer.get('[data-testid="run-group"]');
    expect(group.attributes('data-runs')).toBe('2');
    await group.get('[data-testid="run-group-toggle"]').trigger('click');
    expect(answer.findAll('[data-testid="run-card"]').map((card) => card.attributes('data-fn'))).toEqual(['claude/Bash', 'claude/Read']);
    expect(view.get('[data-testid="note"]').text()).toContain('Session resumed.');
    expect(view.findAll('time')).toHaveLength(0);
  });
});

describe('the chat’s composer on a page (components.Composer)', () => {
  it('edits the page’s text, sends it, and stops what runs at once with Stop', async () => {
    const composer = mount(PageComposer, { props: { modelValue: '', running: true }, attachTo: document.body });
    await composer.get('textarea').setValue('Also add a test');
    expect(composer.emitted('update:modelValue')?.at(-1)).toEqual(['Also add a test']);
    await composer.setProps({ modelValue: 'Also add a test' });
    await composer.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(composer.emitted('send')).toHaveLength(1);
    await composer.get('[data-testid="stop"]').trigger('click');
    await flushPromises();
    // no panel in between: one press stops it
    expect(composer.emitted('stop')).toHaveLength(1);
    expect(document.body.querySelector('[data-testid="run-control"]')).toBeNull();
    composer.unmount();
  });

  it('opens the run-control panel from the menu beside Stop, and its Cancel stops too', async () => {
    const composer = mount(PageComposer, { props: { modelValue: '', running: true }, attachTo: document.body });
    const menu = composer.get('[data-testid="stop-menu"]');
    expect(menu.attributes('aria-label')).toBe('Stop options');
    expect(menu.attributes('aria-expanded')).toBe('false');
    await menu.trigger('click');
    await flushPromises();
    expect(menu.attributes('aria-expanded')).toBe('true');
    expect(composer.emitted('stop')).toBeUndefined();
    document.body.querySelector<HTMLButtonElement>('[data-testid="run-control"] [data-verb="cancel"]')?.click();
    await flushPromises();
    expect(composer.emitted('stop')).toHaveLength(1);
    expect(menu.attributes('aria-expanded')).toBe('false');
    composer.unmount();
  });

  it('opens the panel on a long press or a right-click on Stop, without stopping', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const composer = mount(PageComposer, { props: { modelValue: '', running: true }, attachTo: document.body });
      const stop = composer.get('[data-testid="stop"]');
      const menu = composer.get('[data-testid="stop-menu"]');
      // a short press is a plain Stop
      await stop.trigger('pointerdown', { button: 0 });
      vi.advanceTimersByTime(LONG_PRESS_MS - 100);
      await stop.trigger('pointerup');
      await stop.trigger('click', { detail: 1 });
      expect(composer.emitted('stop')).toHaveLength(1);
      // held: the panel opens, and the click the press ends in does not stop
      await stop.trigger('pointerdown', { button: 0 });
      vi.advanceTimersByTime(LONG_PRESS_MS);
      await flushPromises();
      expect(menu.attributes('aria-expanded')).toBe('true');
      await stop.trigger('pointerup');
      await stop.trigger('click', { detail: 1 });
      expect(composer.emitted('stop')).toHaveLength(1);
      // a touch long-press that also reports a context menu opens it once and keeps the page's menu away
      await menu.trigger('click');
      await stop.trigger('pointerdown', { button: 0 });
      vi.advanceTimersByTime(LONG_PRESS_MS);
      const touchMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      stop.element.dispatchEvent(touchMenu);
      await flushPromises();
      expect(touchMenu.defaultPrevented).toBe(true);
      expect(menu.attributes('aria-expanded')).toBe('true');
      await menu.trigger('click');
      // a right-click opens it, and the next keyboard press of Stop still stops
      await stop.trigger('pointerdown', { button: 2 });
      await stop.trigger('contextmenu');
      await flushPromises();
      expect(menu.attributes('aria-expanded')).toBe('true');
      await stop.trigger('click', { detail: 0 });
      expect(composer.emitted('stop')).toHaveLength(2);
      composer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing while it is empty or turned off', async () => {
    const composer = mount(PageComposer, { props: { modelValue: '  ', disabled: false }, attachTo: document.body });
    await composer.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(composer.emitted('send')).toBeUndefined();
  });
});

describe('an approval on a page (components.Approval)', () => {
  const ask: ProposalAsk = { type: { name: 'obj', props: { answer: { type: { name: 'text' } } } }, into: 'answer' };

  it('waits for the form, then answers with its value', async () => {
    const card = mount(PageApproval, { props: { approval: sampleApproval({ fn: 'claude/answer', ask }) }, attachTo: document.body });
    await flushPromises();
    expect(card.get('[data-testid=approve]').text()).toBe('Answer');
    await card.get('[data-testid=approval-ask] input').setValue('Postgres');
    await card.get('[data-testid=approve]').trigger('click');
    expect(card.emitted('decide')?.[0]).toEqual([true, 'once', '', { answer: 'Postgres' }]);
  });

  it('offers to remember an answer only in a chat', async () => {
    const plain = sampleApproval({ fn: 'claude/permit' });
    const inbox = mount(PageApproval, { props: { approval: plain }, attachTo: document.body });
    const inChat = mount(PageApproval, { props: { approval: plain, inChat: true }, attachTo: document.body });
    await flushPromises();
    expect(inbox.text()).not.toContain('This chat');
    expect(inChat.text()).toContain('This chat');
  });

  it('is never approved with others', () => {
    const plain = sampleApproval({ id: ApprovalId.parse('apr_2'), run: RunId.parse('run_2') });
    expect(approvableTogether([plain, { ...plain, ask }])).toEqual([plain]);
  });
});

describe('the old Claude URLs', () => {
  it('go to the claude system’s pages, keeping the query', async () => {
    const { stores } = fakeStores({ signedIn: true });
    const router = createAppRouter(stores.session, createMemoryHistory());
    await router.push('/claude?q=checkout&status=waiting&new=1');
    expect(router.currentRoute.value.name).toBe(ROUTES.systemPage);
    expect(router.currentRoute.value.fullPath).toBe('/s/claude/sessions?q=checkout&status=waiting&new=1');
    await router.push('/claude/laptop/0b6f3c1e-4a3e-4c55-9d5c-2f1e8a7b9c10?task=ag1');
    expect(router.currentRoute.value.fullPath).toBe('/s/claude/session/laptop/0b6f3c1e-4a3e-4c55-9d5c-2f1e8a7b9c10?task=ag1');
  });
});
