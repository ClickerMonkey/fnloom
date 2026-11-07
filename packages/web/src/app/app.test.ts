import { NotificationLink } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, type Router } from 'vue-router';
import { OFFLINE_AFTER } from '../state/connection.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores, notification } from '../test/fakes.ts';
import { InboxFilter } from '../state/inbox.ts';
import App from './App.vue';
import { navEntries } from './nav.ts';
import { createAppRouter } from './router.ts';
import { links, notificationTarget, ROUTES, safeNext } from './routes.ts';
import { useParamChoice, useQueryChoice } from './url.ts';
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

  it('sends each kind of notification to its place', () => {
    const at = (link: unknown) => notificationTarget(NotificationLink.parse(link));
    expect(at({ session: 'ses_1' })).toMatchObject({ name: ROUTES.session, params: { session: 'ses_1' } });
    expect(at({ system: 'fs' })).toMatchObject({ name: ROUTES.system, params: { name: 'fs' } });
    expect(at({ pairing: 'pr_1' })).toEqual({ name: ROUTES.systems, query: { pairing: 'pr_1' } });
    expect(at({ approval: 'apr_1' })).toEqual({ name: ROUTES.inbox, query: { approval: 'apr_1' } });
    expect(at({ run: 'run_1' })).toEqual({ name: ROUTES.runs, query: { run: 'run_1' } });
  });

  it('leaves defaults out of links', () => {
    expect(links.inbox()).toEqual({ name: ROUTES.inbox });
    expect(links.inbox('unread')).toEqual({ name: ROUTES.inbox, query: { filter: 'unread' } });
    expect(links.signIn()).toEqual({ name: ROUTES.signIn });
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
    expect(entries.map((e) => e.id)).toEqual(['chat', 'inbox', 'admin', 'settings']);
    expect(entries.find((e) => e.id === 'admin')?.count).toBe(2);
    expect(navEntries({ name: ROUTES.llmCalls }, admin, { inbox: 0, admin: 0 }).find((e) => e.active)?.id).toBe('admin');
    expect(entries.find((e) => e.active)?.id).toBe('chat');
    expect(entries.find((e) => e.id === 'inbox')?.count).toBe(4);
    const member = admin === undefined ? undefined : { ...admin, role: 'member' as const };
    expect(navEntries({ name: 'nowhere' }, member, { inbox: 0, admin: 3 }).map((e) => e.id)).toEqual(['chat', 'inbox', 'settings']);
  });
});

describe('url state', () => {
  it('reads and writes a query choice and a param choice through their schemas', async () => {
    const fakes = fakeStores({ signedIn: true });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/design/overlays?filter=bogus');
    let filter: ReturnType<typeof useQueryChoice<typeof InboxFilter>> | undefined;
    let section: ReturnType<typeof useParamChoice<typeof DesignSection>> | undefined;
    const Probe = defineComponent({ setup() { filter = useQueryChoice('filter', InboxFilter, 'all'); section = useParamChoice('section', DesignSection, 'actions'); return () => h('div'); } });
    mount(Probe, { global: { plugins: [router] } });
    expect(filter?.value).toBe('all');
    expect(section?.value).toBe('overlays');
    if (filter) { filter.value = 'unread'; }
    await flushPromises();
    expect(router.currentRoute.value.query['filter']).toBe('unread');
    if (filter) { filter.value = 'all'; }
    await flushPromises();
    expect(router.currentRoute.value.query['filter']).toBeUndefined();
    if (section) { section.value = 'content'; }
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/design/content');
  });
});

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

  it('keeps the inbox filter in the URL', async () => {
    const { app, router, api } = await start('/inbox?filter=unread');
    await flushPromises();
    expect(api.notifications.list.calls.some(([data]) => data?.unread === true && data.limit === 30)).toBe(true);
    expect(app.text()).toContain('Nothing unread');
    const all = app.findAll('[role="tab"]')[0];
    await all?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/inbox');
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
    expect(router.currentRoute.value.fullPath).toBe('/settings/account');
    expect(app.text()).toContain('ada@example.com');
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
