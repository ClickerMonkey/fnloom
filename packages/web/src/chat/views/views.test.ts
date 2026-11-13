import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../../app/App.vue';
import { createAppRouter } from '../../app/router.ts';
import { STORES } from '../../state/stores.ts';
import { fakeStores } from '../../test/fakes.ts';
import { message } from '../test/fakes.ts';
import { hashMessage } from '../url.ts';

function screen(width: number): void {
  const happyDOM: unknown = Reflect.get(window, 'happyDOM');
  const setViewport: unknown = typeof happyDOM === 'object' && happyDOM !== null ? Reflect.get(happyDOM, 'setViewport') : undefined;
  if (typeof setViewport !== 'function') { throw new Error('happy-dom has no setViewport'); }
  Reflect.apply(setViewport, happyDOM, [{ width, height: 900 }]);
}

const mounted: { unmount: () => void }[] = [];

async function start(path: string, width = 1440) {
  screen(width);
  const fakes = fakeStores({ signedIn: true });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  mounted.push(app);
  await flushPromises();
  return { ...fakes, router, app, api: fakes.chat.api };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => {
  for (const app of mounted.splice(0)) { app.unmount(); }
  screen(1440);
});

describe('ChatView', () => {
  it('opens a session from the URL: list beside the thread, starters on an empty chat', async () => {
    const { app, api } = await start('/chat/ses_1');
    expect(app.find('[data-testid=session-list]').exists()).toBe(true);
    expect(app.get('[data-testid=chat-title]').text()).toBe('Refactor the router');
    expect(app.find('[data-testid=starters]').exists()).toBe(true);
    expect(api.session.calls[0]?.[0]).toEqual({ session: 'ses_1' });
    expect(api.capabilities.calls.at(-1)?.[0]).toEqual({ session: 'ses_1' });
    expect(app.get('[data-testid=composer-input]').attributes('placeholder')).toContain('@ to mention');
  });

  it('sends what is typed and shows it', async () => {
    const { app, api } = await start('/chat/ses_1');
    const input = app.get('[data-testid=composer-input]');
    await input.setValue('Hello there');
    await app.get('[data-testid=send]').trigger('click');
    await flushPromises();
    expect(api.send.calls[0]?.[0]).toMatchObject({ session: 'ses_1', parts: [{ type: 'text', text: 'Hello there' }] });
    expect(app.findAll('[data-testid=user-message]')).toHaveLength(1);
    const area = input.element;
    expect(area instanceof HTMLTextAreaElement ? area.value : undefined).toBe('');
  });

  it('ties panels to the URL: a run opens from ?run= and closes back to the session', async () => {
    const { app, router, api } = await start('/chat/ses_1?run=run_9');
    expect(app.get('[data-testid=chat-panel]').text()).toContain('Read file');
    expect(api.run.calls.some((c) => c[0].run === 'run_9')).toBe(true);
    await app.get('[data-testid=panel-close]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query['run']).toBeUndefined();
    expect(router.currentRoute.value.params['session']).toBe('ses_1');
  });

  it('shows a turn’s tree at its own URL', async () => {
    const { app } = await start('/chat/ses_1/turn/trn_1/tree');
    expect(app.find('[data-testid=turn-tree]').exists()).toBe(true);
    expect(app.findAll('[data-testid=tree-node]')).toHaveLength(1);
  });

  it('opens chat settings and saves a notify choice', async () => {
    const { app, api } = await start('/chat/ses_1?panel=settings');
    expect(app.find('[data-testid=session-settings]').exists()).toBe(true);
    await app.findAll('[data-testid=session-notify] [role=radio]')[1]?.trigger('click');
    await flushPromises();
    expect(api.updateSession.calls.at(-1)?.[0]).toEqual({ session: 'ses_1', notify: 'replies' });
    await app.findAll('[data-testid=session-priority] [role=radio]')[0]?.trigger('click');
    await flushPromises();
    expect(api.updateSession.calls.at(-1)?.[0]).toEqual({ session: 'ses_1', priority: 'urgent' });
  });

  it('on a phone shows only the thread, with the list in a drawer', async () => {
    const { app } = await start('/chat/ses_1', 390);
    expect(app.find('[data-testid=session-list]').exists()).toBe(false);
    await app.get('[data-testid=open-sessions]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid=session-list]')).not.toBeNull();
  });

  it('lists chats as the page at /chat on a phone, and offers one New chat on a desktop', async () => {
    const phone = await start('/chat', 390);
    expect(phone.app.find('[data-testid=session-list]').exists()).toBe(true);
    const desktop = await start('/chat');
    expect(desktop.app.find('[data-testid=chat-home]').exists()).toBe(true);
    // the list beside the empty chat has New chat, so the empty state has none of its own (build 8)
    expect(desktop.app.findAll('button').filter((b) => b.text() === 'New chat')).toHaveLength(1);
    await desktop.app.get('[data-testid=new-chat]').trigger('click');
    await flushPromises();
    expect(desktop.router.currentRoute.value.params['session']).toBe('ses_new');
  });

  it('opens the shortcuts with ?', async () => {
    await start('/chat/ses_1');
    if (document.activeElement instanceof HTMLElement) { document.activeElement.blur(); }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[data-testid=shortcuts]')).not.toBeNull();
  });

  it('reads a deep link to a message', () => {
    expect(hashMessage(`#m-${message({ id: 'msg_7' }).id}`)).toBe('msg_7');
    expect(hashMessage('#elsewhere')).toBeUndefined();
  });
});
