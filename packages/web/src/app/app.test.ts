import { LlmInteractionId, MessageId, NotificationLink, QualifiedName, RunId, SessionId } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, type Router } from 'vue-router';
import { OFFLINE_AFTER } from '../state/connection.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores, notification } from '../test/fakes.ts';
import { INBOX_PAGE, InboxFilter } from '../state/inbox.ts';
import App from './App.vue';
import { navEntries } from './nav.ts';
import { createAppRouter } from './router.ts';
import { links, notificationTarget, ROUTES, safeNext } from './routes.ts';
import { useChatUrl } from '../chat/url.ts';
import { useParamChoice, useRouteQuery } from './url.ts';
import { resyncOnReconnect } from './wire.ts';
import { DesignSection } from './routes.ts';

/** Size the window as a phone or a desktop through happy-dom's own viewport; media queries follow it. */
function screen(compact: boolean): void {
  const happyDOM: unknown = Reflect.get(window, 'happyDOM');
  const setViewport: unknown = typeof happyDOM === 'object' && happyDOM !== null ? Reflect.get(happyDOM, 'setViewport') : undefined;
  if (typeof setViewport !== 'function') { throw new Error('happy-dom has no setViewport'); }
  Reflect.apply(setViewport, happyDOM, [{ width: compact ? 390 : 1440, height: 900 }]);
}

async function start(path: string, options: { signedIn?: boolean; compact?: boolean } = {}) {
  screen(options.compact === true);
  const fakes = fakeStores({ signedIn: options.signedIn ?? true });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, router, app };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { screen(false); });

describe('routes', () => {
  it('follows only paths inside the app after sign-in', () => {
    expect(safeNext('/chat/ses_1?run=r')).toBe('/chat/ses_1?run=r');
    expect(safeNext('//evil.example')).toBeUndefined();
    expect(safeNext('/\\evil.example')).toBeUndefined();
    expect(safeNext('https://evil.example')).toBeUndefined();
    expect(safeNext(['/chat'])).toBeUndefined();
  });

  it('sends each kind of notification to its place, and a run in a chat to that chat', async () => {
    const inChat = new Map([['run_chat', SessionId.parse('ses_9')]]);
    const at = (link: unknown) => notificationTarget(NotificationLink.parse(link), (run) => Promise.resolve(inChat.get(run)));
    expect(await at({ session: 'ses_1' })).toMatchObject({ name: ROUTES.session, params: { session: 'ses_1' } });
    expect(await at({ system: 'fs' })).toMatchObject({ name: ROUTES.system, params: { name: 'fs' } });
    expect(await at({ pairing: 'par_1' })).toEqual({ name: ROUTES.systems, query: { pairing: 'par_1' } });
    expect(await at({ approval: 'apr_1' })).toEqual({ name: ROUTES.runs, query: { q: 'status:awaiting-approval' } });
    expect(await at({ run: 'run_1' })).toEqual({ name: ROUTES.runs, query: { run: 'run_1' } });
    expect(await at({ run: 'run_chat' })).toEqual({ name: ROUTES.session, params: { session: 'ses_9' } });
    expect(await notificationTarget(NotificationLink.parse({ run: 'run_x' }), () => Promise.reject(new Error('gone')))).toEqual({ name: ROUTES.runs, query: { run: 'run_x' } });
  });

  it('writes only the keys a page declares, checked with their schemas', () => {
    expect(links.fnRuns(QualifiedName.parse('fs/read'))).toEqual({ name: ROUTES.runs, query: { q: 'fn:fs/read' } });
    expect(links.llmCalls({ call: LlmInteractionId.parse('llm_1') })).toEqual({ name: ROUTES.llmCalls, query: { call: 'llm_1' } });
    expect(links.systems()).toEqual({ name: ROUTES.systems });
    // @ts-expect-error a key the runs page doesn't read
    expect(() => links.runs({ approval: 'apr_1' })).not.toThrow();
  });

  it('opens a model call by its own address in the list', async () => {
    const router = createAppRouter(fakeStores({ signedIn: true }).stores.session, createMemoryHistory());
    await router.push('/admin/model-calls/mca_1?modality=chat');
    expect(router.currentRoute.value.name).toBe(ROUTES.modelCalls);
    expect(router.currentRoute.value.query).toEqual({ modality: 'chat', call: 'mca_1' });
  });

  it('leaves defaults out of links', () => {
    expect(links.inbox()).toEqual({ name: ROUTES.inbox });
    expect(links.inbox('unread')).toEqual({ name: ROUTES.inbox, query: { filter: 'unread' } });
    expect(links.signIn()).toEqual({ name: ROUTES.signIn });
  });
});

describe('resync on reconnect', () => {
  it('fetches the inbox, the chat and a loaded systems list again when the hub comes back, signed in only', async () => {
    const fakes = fakeStores({ signedIn: true });
    const { stores } = fakes;
    const inbox = vi.spyOn(stores.inbox, 'refresh').mockResolvedValue(undefined);
    const chat = vi.spyOn(stores.chat, 'refresh').mockResolvedValue(undefined);
    const systems = vi.spyOn(stores.admin.systems, 'load');
    const stop = resyncOnReconnect(stores);
    fakes.connection.set('offline');
    fakes.connection.set('online');
    expect(inbox).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledOnce();
    expect(systems).not.toHaveBeenCalled();

    await stores.admin.systems.load();
    systems.mockClear();
    fakes.connection.set('offline');
    fakes.connection.set('online');
    expect(systems).toHaveBeenCalledWith(true);

    stores.session.forget();
    fakes.connection.set('offline');
    fakes.connection.set('online');
    expect(chat).toHaveBeenCalledTimes(2);
    stop();
    fakes.connection.set('offline');
    fakes.connection.set('online');
    expect(inbox).toHaveBeenCalledTimes(2);
  });
});

describe('router guard', () => {
  let router: Router;
  it('sends the signed-out to sign-in and back, and the signed-in away from it', async () => {
    const fakes = fakeStores();
    router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/inbox?filter=unread');
    expect(router.currentRoute.value.name).toBe(ROUTES.signIn);
    expect(router.currentRoute.value.query['next']).toBe('/inbox?filter=unread');
    await router.push('/design/inputs');
    expect(router.currentRoute.value.name).toBe(ROUTES.design);

    fakes.stores.session.keep((await fakes.api.auth.signIn.call({ email: 'a@b.co', password: 'x' })));
    await router.push({ name: ROUTES.signIn, query: { next: '/settings/account' } });
    expect(router.currentRoute.value.fullPath).toBe('/settings/account');
    await router.push('/sign-in');
    expect(router.currentRoute.value.name).toBe(ROUTES.chat);
    await router.push('/settings');
    expect(router.currentRoute.value.fullPath).toBe('/settings/appearance');
    await router.push('/settings/nonsense');
    expect(router.currentRoute.value.name).toBe(ROUTES.notFound);
  });
});

describe('nav', () => {
  it('lists the entries for the user, marks the current one and counts the inbox', () => {
    const admin = fakeStores({ signedIn: true }).stores.session.user.value;
    const entries = navEntries({ name: ROUTES.session }, admin, { inbox: 4, admin: 2 });
    expect(entries.map((e) => e.id)).toEqual(['chat', 'inbox', 'resources', 'context', 'admin', 'settings']);
    expect(entries.find((e) => e.id === 'admin')?.count).toBe(2);
    expect(navEntries({ name: ROUTES.llmCalls }, admin, { inbox: 0, admin: 0 }).find((e) => e.active)?.id).toBe('admin');
    expect(navEntries({ name: ROUTES.resources }, admin, { inbox: 0, admin: 0 }).find((e) => e.active)?.id).toBe('resources');
    expect(entries.find((e) => e.active)?.id).toBe('chat');
    expect(entries.find((e) => e.id === 'inbox')?.count).toBe(4);
    const member = admin === undefined ? undefined : { ...admin, role: 'member' as const };
    expect(navEntries({ name: 'nowhere' }, member, { inbox: 0, admin: 3 }).map((e) => e.id)).toEqual(['chat', 'inbox', 'resources', 'context', 'settings']);
  });
});

describe('url state', () => {
  /** Mount a probe that runs `setup` inside a component on a router at `path`. */
  async function probe<T>(path: string, setup: () => T): Promise<{ router: Router; got: T }> {
    const fakes = fakeStores({ signedIn: true });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push(path);
    let got: T | undefined;
    mount(defineComponent({ setup() { got = setup(); return () => h('div'); } }), { global: { plugins: [router] } });
    if (got === undefined) { throw new Error('the probe did not run'); }
    return { router, got };
  }

  it('reads and writes a query choice and a param choice through their schemas', async () => {
    const { router, got } = await probe('/design/overlays?filter=bogus', () => ({ filter: useRouteQuery(ROUTES.inbox).choice('filter', InboxFilter, 'all'), section: useParamChoice('section', DesignSection, 'actions') }));
    expect(got.filter.value).toBe('all');
    expect(got.section.value).toBe('overlays');
    got.filter.value = 'unread';
    await flushPromises();
    expect(router.currentRoute.value.query['filter']).toBe('unread');
    got.filter.value = 'all';
    await flushPromises();
    expect(router.currentRoute.value.query['filter']).toBeUndefined();
    got.section.value = 'content';
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/design/content');
  });

  it('writes free text to the query, replacing the entry (or pushing one), and leaves empty text out', async () => {
    const { router, got } = await probe('/admin/runs?status=failed#top', () => ({ fn: useRouteQuery(ROUTES.runs).text('q'), open: useRouteQuery(ROUTES.runs).text('run', { push: true }) }));
    got.fn.value = 'bash';
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ status: 'failed', q: 'bash' });
    expect(router.currentRoute.value.hash).toBe('#top');
    got.fn.value = '';
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ status: 'failed' });
    got.open.value = 'run_1';
    await flushPromises();
    expect(got.open.value).toBe('run_1');
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.query['run']).toBeUndefined();
  });

  it('follows a typed draft into the URL once typing pauses, and the URL back into the draft', async () => {
    vi.useFakeTimers();
    try {
      const { router, got } = await probe('/resources?q=old', () => useRouteQuery(ROUTES.resources).draft('q', 300));
      expect(got.draft.value).toBe('old');
      got.draft.value = 'ne';
      await flushPromises();
      got.draft.value = ' new ';
      await flushPromises();
      await vi.advanceTimersByTimeAsync(299);
      expect(router.currentRoute.value.query['q']).toBe('old');
      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();
      expect(router.currentRoute.value.query['q']).toBe('new');
      expect(got.value.value).toBe('new');
      await router.replace({ query: { q: 'from a link' } });
      await flushPromises();
      expect(got.draft.value).toBe('from a link');
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the chat list's search and view in the URL, and points it at a message", async () => {
    const session = SessionId.parse('ses_1');
    const { router, got } = await probe(`/chat/${session}?run=run_1`, () => useChatUrl());
    got.setList({ search: '  deploy  ', archived: true });
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ run: 'run_1', q: 'deploy', chats: 'archived' });
    expect(got.search.value).toBe('deploy');
    expect(got.archived.value).toBe(true);
    got.showMessage(IDS_MESSAGE);
    await flushPromises();
    expect(router.currentRoute.value.hash).toBe(`#m-${IDS_MESSAGE}`);
    expect(got.message.value).toBe(IDS_MESSAGE);
    got.setList({ search: '', archived: false });
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ run: 'run_1' });
    // moving to another chat keeps the list's part of the query, and drops the panel
    got.setList({ search: 'x' });
    await flushPromises();
    got.go(SessionId.parse('ses_2'));
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/chat/ses_2?q=x');
  });

  it('closes the panel on top, going back when that is where it came from', async () => {
    const session = SessionId.parse('ses_1');
    const { router, got } = await probe(`/chat/${session}`, () => useChatUrl());
    got.open('run', RunId.parse('run_1'));
    await flushPromises();
    expect(got.top.value).toBe('run');
    got.open('llm', LlmInteractionId.parse('llm_1'));
    await flushPromises();
    expect(got.top.value).toBe('llm');
    got.close();
    await flushPromises();
    expect(got.top.value).toBe('run');
    // reached straight from a link: nothing to go back to, so it replaces
    await router.replace(`/chat/${session}?details=trn_1`);
    got.close();
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(`/chat/${session}`);
  });
});

const IDS_MESSAGE = MessageId.parse('msg_7');

describe('the shell', () => {
  it('shows the sidebar beside the page on wide screens, and collapses it', async () => {
    const { app, stores } = await start('/inbox');
    expect(app.find('nav[aria-label="Main"]').exists()).toBe(true);
    expect(app.find('[data-testid="open-nav"]').exists()).toBe(false);
    expect(app.get('[data-testid="nav-inbox"]').attributes('aria-current')).toBe('page');
    expect(document.title).toBe('Inbox · Harness');
    await app.get('[data-testid="toggle-sidebar"]').trigger('click');
    expect(stores.layout.collapsed).toBe(true);
    expect(app.get('.shell').classes()).toContain('collapsed');
    app.unmount();
  });

  it('uses a top bar and a drawer on phones', async () => {
    const { app, stores } = await start('/chat', { compact: true });
    expect(app.find('[data-testid="open-nav"]').exists()).toBe(true);
    await app.get('[data-testid="open-nav"]').trigger('click');
    await flushPromises();
    expect(stores.layout.drawerOpen.value).toBe(true);
    expect(document.querySelector('[role="dialog"][aria-label="Navigation"] nav')).not.toBeNull();
    app.unmount();
  });

  it('counts unread on the bell and in the tab, opens the inbox, and goes where a notification leads', async () => {
    const fakes = fakeStores({ signedIn: true });
    const waiting = notification({ title: 'Approve a write', reason: 'approval-needed', link: { session: 'ses_9' } });
    fakes.api.notifications.list.call = async () => ({ items: [waiting] });
    screen(false);
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/settings/appearance');
    const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    expect(fakes.stores.inbox.unread.value).toBe(1);
    expect(document.title).toBe('(1) Settings · Harness');
    expect(app.get('[data-testid="open-inbox"]').attributes('aria-label')).toBe('Notifications, 1 unread');

    fakes.events.push({ type: 'notification', notification: notification({ title: 'Live one' }) });
    await flushPromises();
    expect(document.title).toBe('(2) Settings · Harness');

    await app.get('[data-testid="open-inbox"]').trigger('click');
    await flushPromises();
    const row = document.querySelector<HTMLElement>(`[data-testid="notification-${waiting.id}"] button`);
    expect(row?.textContent).toContain('Approve a write');
    row?.click();
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/chat/ses_9');
    expect(fakes.api.notifications.markRead.calls[0]).toEqual([{ ids: [waiting.id] }]);
    app.unmount();
  });

  it('shows the connection banner while offline', async () => {
    const { app, connection } = await start('/chat');
    expect(app.find('[data-testid="connection-banner"]').exists()).toBe(false);
    connection.set('offline');
    await new Promise((resolve) => { setTimeout(resolve, OFFLINE_AFTER + 50); });
    await flushPromises();
    expect(app.get('[data-testid="connection-banner"]').text()).toContain('Reconnecting');
    connection.set('online');
    await flushPromises();
    expect(app.get('[data-testid="connection-banner"]').text()).toContain('Back online');
    app.unmount();
  });

  it('goes to sign-in when the session ends', async () => {
    const { app, stores, router } = await start('/inbox');
    stores.session.forget();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe(ROUTES.signIn);
    expect(router.currentRoute.value.query['next']).toBe('/inbox');
    expect(app.find('nav[aria-label="Main"]').exists()).toBe(false);
    app.unmount();
  });
});

describe('pages', () => {
  it('signs in and returns to the page that asked', async () => {
    const { app, router, api } = await start('/sign-in?next=/settings/account', { signedIn: false });
    expect(app.text()).toContain('Welcome back');
    await app.get('input[type="email"]').setValue('ada@example.com');
    await app.get('input[type="password"]').setValue('correct horse');
    await app.get('form').trigger('submit');
    await flushPromises();
    expect(api.auth.signIn.calls).toHaveLength(1);
    expect(router.currentRoute.value.fullPath).toBe('/settings/account');
    app.unmount();
  });

  it('shows the admin form on a new hub, with the hub checks per field', async () => {
    screen(false);
    const fakes = fakeStores();
    fakes.api.auth.setup.call = async () => ({ needsAdmin: true, name: 'New hub', version: '1' });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/sign-in');
    const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    expect(app.text()).toContain('Set up your hub');
    await app.get('form').trigger('submit');
    await flushPromises();
    expect(app.text()).toContain('Enter an email address.');
    expect(app.text()).toContain('At least 10 characters.');
    expect(fakes.api.auth.createAdmin.calls).toHaveLength(0);
    app.unmount();
  });

  it('keeps the inbox filter and search in the URL', async () => {
    const { app, router, api } = await start('/inbox?filter=unread');
    await flushPromises();
    expect(api.notifications.list.calls.some(([data]) => data?.unread === true && data.limit === 30)).toBe(true);
    expect(app.text()).toContain('Nothing unread');
    await app.get('[data-testid="inbox-filter"] [role="radio"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/inbox');
    await router.replace('/inbox?q=kind:approval');
    await flushPromises();
    expect(api.notifications.list.calls.at(-1)?.[0]?.query).toEqual({ filters: [{ field: 'kind', op: 'is', value: 'approval' }], limit: INBOX_PAGE });
    expect(app.text()).toContain('Nothing matches');
    app.unmount();
  });

  it('changes the theme from settings, and each section is its own URL', async () => {
    const { app, router, stores } = await start('/settings/appearance');
    const dark = app.findAll('[data-testid="theme-choice"] [role="radio"]').find((r) => r.text() === 'Dark');
    await dark?.trigger('click');
    expect(stores.theme.choice.value).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    await app.findAll('[role="tab"]')[1]?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/settings/notifications');
    expect(app.find('[data-testid=push-card]').text()).toContain('Notify this device');
    await app.get('[data-testid=push-switch] [role=switch]').trigger('click');
    await flushPromises();
    expect(stores.push.state.value).toBe('on');
    await app.findAll('[role="tab"]')[2]?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/settings/account');
    expect(app.text()).toContain('ada@example.com');
    expect(app.text()).toContain('Your account on this hub.');
    app.unmount();
  });

  it('shows the not-found page with a way back', async () => {
    const { app, router } = await start('/no/such/page');
    expect(app.text()).toContain('Nothing here');
    await app.get('.ui-empty button').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe(ROUTES.chat);
    app.unmount();
  });
});
