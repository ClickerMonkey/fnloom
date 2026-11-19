/**
 * The open chat as people use it, through the whole app at a session's URL with fake stores: sending (and what a slow
 * or failed send shows), message and header actions, approvals, the failed-turn retry, the agent switch, files
 * dropped on the thread and type methods on a mention's card.
 */
import { ApiError } from '@ayepi/core/client';
import type { ChatMessage } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../../app/App.vue';
import { createAppRouter } from '../../app/router.ts';
import { STORES } from '../../state/stores.ts';
import { failingCaller, fakeCaller, fakeStores } from '../../test/fakes.ts';
import { AGENT, approval, message, session } from '../test/fakes.ts';

const mounted: { unmount: () => void }[] = [];

/** The thread of ses_1: your question, and the agent's answer that failed. */
function conversation(): ChatMessage[] {
  const asked = message({ id: 'msg_ask', turn: 'trn_1', parts: [{ type: 'text', text: 'Read the README' }] });
  const failed = message({ id: 'msg_ans', turn: 'trn_1', author: AGENT, role: 'assistant', status: 'failed', parts: [{ type: 'text', text: 'The model was busy.' }] });
  return [asked, failed];
}

async function start(prepare: (api: ReturnType<typeof fakeStores>['chat']['api']) => void = () => undefined) {
  const fakes = fakeStores({ signedIn: true });
  prepare(fakes.chat.api);
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push('/chat/ses_1');
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  mounted.push(app);
  await flushPromises();
  return { ...fakes, router, app, api: fakes.chat.api, toasts: () => fakes.stores.toasts.items.map((t) => t.title) };
}

/** A promise the test settles. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject; });
  return { promise, settle, fail };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { for (const app of mounted.splice(0)) { app.unmount(); } });

describe('sending', () => {
  it('shows your message at once while a slow send is on its way, then the stored one in its place', async () => {
    const slow = deferred<{ turn: ChatMessage['turn']; message: ChatMessage }>();
    const { app } = await start((api) => { api.send = fakeCaller<'send'>(() => slow.promise); });
    await app.get('[data-testid=composer-input]').setValue('Hello there');
    await app.get('[data-testid=send]').trigger('click');
    await flushPromises();
    expect(app.get('[data-testid=pending-message]').text()).toContain('Hello there');
    expect(app.get('[data-testid=pending-message]').text()).toContain('Sending');
    const stored = message({ session: 'ses_1', parts: [{ type: 'text', text: 'Hello there' }] });
    slow.settle({ turn: stored.turn, message: stored });
    await flushPromises();
    expect(app.find('[data-testid=pending-message]').exists()).toBe(false);
    expect(app.findAll('[data-testid=user-message]').map((m) => m.text())).toEqual([expect.stringContaining('Hello there')]);
  });

  it('puts a failed send back in the box exactly, and says so', async () => {
    const { app, toasts } = await start((api) => { api.send = failingCaller<'send'>(new ApiError(503, 'busy')); });
    await app.get('[data-testid=composer-input]').setValue('Try this');
    await app.get('[data-testid=send]').trigger('click');
    await flushPromises();
    const box = app.get('[data-testid=composer-input]').element;
    expect(box instanceof HTMLTextAreaElement ? box.value : undefined).toBe('Try this');
    expect(app.find('[data-testid=pending-message]').exists()).toBe(false);
    expect(toasts()).toContain("Couldn't send");
  });
});

describe('message actions', () => {
  it('replies to, edits, undoes and opens the tree of messages', async () => {
    const { app, api, router, toasts } = await start((a) => { a.messages = fakeCaller<'messages'>(() => Promise.resolve({ items: conversation() })); });
    await app.get('[data-testid=user-message] [data-action=reply]').trigger('click');
    expect(app.text()).toContain('Read the README');
    await app.get('[data-testid=user-message] [data-action=edit]').trigger('click');
    await flushPromises();
    const box = app.get('[data-testid=composer-input]').element;
    expect(box instanceof HTMLTextAreaElement ? box.value : undefined).toBe('Read the README');

    await app.get('[data-testid=assistant-answer] [data-action=undo]').trigger('click');
    await flushPromises();
    expect(api.undoTurn.calls.at(-1)?.[0]).toEqual({ turn: 'trn_1' });
    expect(toasts()).toContain('Turn undone');

    await app.get('[data-testid=assistant-answer] [data-action=tree]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/chat/ses_1/turn/trn_1/tree');
  });

  it('retries the failed turn once confirmed: undoes it and sends the question again', async () => {
    const { app, api } = await start((a) => { a.messages = fakeCaller<'messages'>(() => Promise.resolve({ items: conversation() })); });
    await app.get('[data-testid=assistant-answer] [data-action=retry]').trigger('click');
    await flushPromises();
    // Retry always asks first: nothing is undone until the person confirms
    expect(api.undoTurn.calls).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('[data-testid=confirm-retry] [data-testid=confirm]')?.click();
    await flushPromises();
    expect(api.undoTurn.calls.at(-1)?.[0]).toEqual({ turn: 'trn_1' });
    expect(api.send.calls.at(-1)?.[0]).toMatchObject({ session: 'ses_1', parts: [{ type: 'text', text: 'Read the README' }] });
  });

  it('says when undo is refused', async () => {
    const { app, toasts } = await start((a) => {
      a.messages = fakeCaller<'messages'>(() => Promise.resolve({ items: conversation() }));
      a.undoTurn = failingCaller<'undoTurn'>(new ApiError(409, 'busy'));
    });
    await app.get('[data-testid=assistant-answer] [data-action=undo]').trigger('click');
    await flushPromises();
    expect(toasts()).toContain("Couldn't undo");
  });
});

describe('the header and the meta row', () => {
  it('renames the chat, archives it from the menu, and switches who answers', async () => {
    const { app, api, toasts } = await start();
    await app.get('[data-testid=chat-title]').trigger('click');
    await flushPromises();
    await app.get('[data-testid=title-input]').setValue('Router plans');
    await app.get('[data-testid=title-input]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.updateSession.calls.some((c) => c[0].title === 'Router plans')).toBe(true);

    await app.get('[data-testid=chat-menu]').trigger('click');
    await flushPromises();
    const archive = [...document.body.querySelectorAll<HTMLElement>('[role=menuitem]')].find((item) => item.textContent.includes('Archive'));
    archive?.click();
    await flushPromises();
    expect(api.updateSession.calls.at(-1)?.[0]).toEqual({ session: 'ses_1', archived: true });
    expect(toasts()).toContain('Archived');

    await app.get('[data-testid=agent-picker]').trigger('click');
    await flushPromises();
    const explore = [...document.body.querySelectorAll<HTMLElement>('[role=menuitem]')].find((item) => item.textContent.includes('Explore'));
    explore?.click();
    await flushPromises();
    expect(api.updateSession.calls.at(-1)?.[0]).toEqual({ session: 'ses_1', agent: 'fs/explore' });
  });

  it('says when a change to the chat is refused', async () => {
    const { app, toasts } = await start((a) => { a.updateSession = failingCaller<'updateSession'>(new ApiError(500, 'boom')); });
    await app.get('[data-testid=chat-menu]').trigger('click');
    await flushPromises();
    [...document.body.querySelectorAll<HTMLElement>('[role=menuitem]')].find((item) => item.textContent.includes('Archive'))?.click();
    await flushPromises();
    expect(toasts()).toContain("Couldn't change that");
  });
});

describe('what waits on you', () => {
  it('approves a run from the tray, and says when the answer is refused', async () => {
    const waiting = approval({ id: 'apr_1', run: 'run_1' });
    const { app, api, toasts } = await start((a) => { a.waiting = fakeCaller<'waiting'>(() => Promise.resolve({ approvals: [waiting], handlers: [] })); });
    await app.get('[data-testid=approve]').trigger('click');
    await flushPromises();
    expect(api.approve.calls.at(-1)?.[0]).toMatchObject({ approval: 'apr_1', approve: true });

    const again = await start((a) => {
      a.waiting = fakeCaller<'waiting'>(() => Promise.resolve({ approvals: [approval({ id: 'apr_2', run: 'run_2' })], handlers: [] }));
      a.approve = failingCaller<'approve'>(new ApiError(409, 'gone'));
    });
    await again.app.get('[data-testid=approve]').trigger('click');
    await flushPromises();
    expect(again.toasts()).toContain("Couldn't send your answer");
    expect(toasts()).not.toContain("Couldn't send your answer");
  });
});

describe('files', () => {
  it('stages files dropped on the thread', async () => {
    const { app, api } = await start();
    const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    app.get('[data-testid=thread-pane]').element.dispatchEvent(drop);
    await flushPromises();
    expect(api.upload.calls.at(-1)?.[0]).toMatchObject({ name: 'notes.md' });
  });
});

describe('the record it opens', () => {
  it('names the chat from its record', async () => {
    const { app } = await start((a) => { a.session = fakeCaller<'session'>(({ session: id }) => Promise.resolve(session({ id, title: 'Named here' }))); });
    expect(app.get('[data-testid=chat-title]').text()).toBe('Named here');
  });
});
