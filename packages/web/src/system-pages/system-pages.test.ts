/**
 * System pages (item 9) in the app: the nav lists the live systems' pages and drops them when the hub stops listing
 * them; `/s/<system>/<page>/<path…>` mounts the page's component from the system's client build with its host (the
 * person, the hub client, the URL query bound two ways, links, the shared components) and its system's client; a stale
 * link keeps its URL and says the system isn't installed, and draws the page again once the system is back.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { ActorId, SystemName, SystemPageView, type UserView } from '@harness/core';
import { client, PAGE_HOST, system, type PageViewOf } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { defineComponent, h, inject } from 'vue';
import App from '../app/App.vue';
import { navEntries } from '../app/nav.ts';
import { createAppRouter } from '../app/router.ts';
import { resyncOnReconnect } from '../app/wire.ts';
import { links, ROUTES } from '../app/routes.ts';
import { STORES } from '../state/stores.ts';
import { fakePages, fakeStores } from '../test/fakes.ts';
import { missingPage, pageAddress, pageHost, pageNav, queryValues, type PageHere } from './logic.ts';
import { PAGE_FORMAT, SHARED_COMPONENTS } from './shared.ts';

const CREW = SystemName.parse('crew');

/** A page as the hub lists it. */
function listed(segment: string, extra: Partial<SystemPageView> = {}): SystemPageView {
  return SystemPageView.parse({
    system: CREW, segment, title: segment === 'roster' ? 'Crew' : `Crew ${segment}`, component: segment === 'roster' ? 'RosterPage' : 'MemberPage',
    client: { url: '/clients/crew/h1/index.js', hash: 'h1' }, ...extra,
  });
}
const ROSTER = listed('roster', { icon: 'users' });
const MEMBER = listed('member', { nav: 'hidden' });

// the system's contract and client build, as its bundle would export them
const crew = system('crew', {
  description: 'A crew.',
  pages: [{ segment: 'roster', title: 'Crew', icon: 'users', component: 'RosterPage' }, { segment: 'member', title: 'Crew member', nav: 'hidden', component: 'MemberPage' }],
});
const RosterPage = defineComponent({
  props: ['page', 'path', 'host', 'system'],
  setup(props: PageViewOf<typeof crew>) {
    const q = props.host.query.bind('q');
    const injected = inject(PAGE_HOST);
    return () => h('section', { 'data-testid': 'roster' }, [
      h('p', { 'data-testid': 'who' }, `${props.host.user.name} on ${props.page}`),
      h('p', { 'data-testid': 'q' }, q.value),
      h('p', { 'data-testid': 'same-host' }, String(injected === props.host)),
      h('a', { 'data-testid': 'member-link', href: props.host.href({ page: 'member', path: ['main', 'ada'] }) }, 'Ada'),
      h('button', { 'data-testid': 'search', onClick: () => { q.value = 'cook'; } }, 'Search'),
      h('button', { 'data-testid': 'open', onClick: () => { props.host.go({ page: 'member', path: ['main', 'ada'] }); } }, 'Open'),
    ]);
  },
});
const MemberPage = defineComponent({
  props: ['page', 'path', 'host', 'system'],
  setup(props: PageViewOf<typeof crew>) {
    return () => h('section', { 'data-testid': 'member' }, props.path.join('/'));
  },
});
const Broken = defineComponent({
  props: ['page', 'path', 'host', 'system'],
  setup(_props: PageViewOf<typeof crew>) { return () => { throw new Error('the roster lost its crew'); }; },
});

/** Mount the app, signed in as an admin, at a path, with the hub listing these pages and the crew build loadable. */
async function visit(path: string, pages: readonly SystemPageView[], roster = RosterPage) {
  const fakes = fakeStores({ signedIn: true, pages });
  fakes.chat.chat.renderers.runtime.register(client(crew, { pages: { RosterPage: roster, MemberPage } }));
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, router, app };
}

const byTest = (id: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('system page logic', () => {
  it('puts the main pages in the nav with an icon the app has', () => {
    expect(pageNav([ROSTER, MEMBER, listed('odd', { icon: 'no-such-icon' })])).toEqual([
      { system: CREW, segment: 'roster', title: 'Crew', icon: 'users' },
      { system: CREW, segment: 'odd', title: 'Crew odd', icon: 'layers' },
    ]);
  });

  it('reads the address and query of a page URL', () => {
    expect(pageAddress({ system: 'crew', page: 'member', path: ['main', 'ada'] })).toEqual({ system: CREW, page: 'member', path: ['main', 'ada'] });
    expect(pageAddress({ system: 'crew', page: 'roster', path: '' })).toEqual({ system: CREW, page: 'roster', path: [] });
    expect(pageAddress({ system: 'Not A System', page: 'x' })).toBeUndefined();
    expect(queryValues({ q: 'ada', tag: ['a', 'b'], empty: null })).toEqual({ q: 'ada', tag: 'a' });
  });

  it('says whether the system is missing or only the page', () => {
    expect(missingPage({ system: CREW, page: 'roster', path: [] }, []).title).toBe('crew isn’t installed');
    expect(missingPage({ system: CREW, page: 'gone', path: [] }, [ROSTER]).title).toBe('No such page');
  });

  it('gives a host whose query, links and moves stay on the system’s pages', () => {
    let here: PageHere = { system: CREW, page: 'roster', path: [], query: { q: 'ada', tab: 'all' } };
    const moves: Array<{ to: unknown; replace: boolean }> = [];
    const user: UserView = { id: ActorId.parse('act_ada'), kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'member' };
    const host = pageHost({
      here: () => here, navigate: (to, replace) => { moves.push({ to, replace }); }, resolve: (to) => JSON.stringify(to), user: () => user,
      hub: fakePages().pages.hub, components: SHARED_COMPONENTS, openChat: () => Promise.resolve(), chatHref: (session) => `/c/${session}`, goChat: () => undefined,
      runs: () => { throw new Error('no runs in this test'); }, inbox: { byRun: () => undefined, load: () => Promise.resolve(), decide: () => Promise.resolve(false), problem: '' },
      notify: { ok: () => undefined, error: () => undefined }, format: PAGE_FORMAT, live: () => undefined,
    });
    expect(host.user.name).toBe('Ada');
    expect(host.query.values).toEqual({ q: 'ada', tab: 'all' });
    expect(host.query.get('q')).toBe('ada');
    host.query.set({ q: 'cook', tab: undefined });
    expect(moves.at(-1)).toEqual({ to: links.systemPage(CREW, 'roster', [], { q: 'cook' }), replace: true });
    host.query.set({ tab: 'new' }, { push: true });
    expect(moves.at(-1)?.replace).toBe(false);
    const tab = host.query.bind('tab', 'all');
    expect(tab.value).toBe('all');
    tab.value = 'all';
    // the fallback is not written into the URL
    expect(moves.at(-1)?.to).toEqual(links.systemPage(CREW, 'roster', [], { q: 'ada' }));
    here = { ...here, page: 'member', path: ['main', 'ada'], query: {} };
    expect(host.href({ query: { open: '1' } })).toBe(JSON.stringify(links.systemPage(CREW, 'member', ['main', 'ada'], { open: '1' })));
    expect(host.href({ page: 'roster' })).toBe(JSON.stringify(links.systemPage(CREW, 'roster')));
    host.go({ page: 'roster' }, { replace: true });
    expect(moves.at(-1)).toEqual({ to: links.systemPage(CREW, 'roster'), replace: true });
    expect(host.components.Markdown).toBe(SHARED_COMPONENTS.Markdown);
  });
});

describe('system pages store and nav', () => {
  it('lists the main pages after Context, marks the current one, and keeps its system’s entry lit on a hidden page', () => {
    const user = fakeStores({ signedIn: true }).stores.session.user.value;
    const pages = pageNav([ROSTER, MEMBER]);
    const entries = navEntries({ name: ROUTES.systemPage, params: { system: 'crew', page: 'roster' } }, user, { inbox: 0, admin: 0 }, [], pages);
    const ids = entries.map((e) => e.id);
    expect(ids.indexOf('page-crew-roster')).toBe(ids.indexOf('context') + 1);
    expect(entries.find((e) => e.active)?.id).toBe('page-crew-roster');
    expect(entries.find((e) => e.id === 'page-crew-roster')).toMatchObject({ label: 'Crew', icon: 'users', to: links.systemPage(CREW, 'roster') });
    const onMember = navEntries({ name: ROUTES.systemPage, params: { system: 'crew', page: 'member' } }, user, { inbox: 0, admin: 0 }, [], pages);
    expect(onMember.find((e) => e.active)?.id).toBe('page-crew-roster');
    expect(navEntries({ name: ROUTES.chat }, user, { inbox: 0, admin: 0 }, [], pages).find((e) => e.id === 'page-crew-roster')?.active).toBe(false);
  });

  it('reads the pages again when the hub says what is offered changed, so a page leaves the nav with its system', async () => {
    const { pages, systemPages, events, answer } = fakePages([ROSTER, MEMBER]);
    pages.start();
    await pages.load();
    expect(pages.nav.value.map((p) => p.segment)).toEqual(['roster']);
    expect(pages.page(CREW, 'member')?.title).toBe('Crew member');
    answer.list = [];
    events.push({ type: 'capabilities' });
    await flushPromises();
    expect(systemPages.calls).toHaveLength(2);
    expect(pages.nav.value).toEqual([]);
    expect(pages.page(CREW, 'roster')).toBeUndefined();
    pages.clear();
    expect(pages.list.value.value).toBeUndefined();
    events.push({ type: 'capabilities' });
    expect(systemPages.calls).toHaveLength(2);
  });

  it('reads the pages again after a reconnect, since a system may have left while the hub was unreachable', async () => {
    const fakes = fakeStores({ signedIn: true, pages: [ROSTER] });
    await fakes.stores.pages.load();
    expect(fakes.stores.pages.nav.value).toHaveLength(1);
    const stop = resyncOnReconnect(fakes.stores);
    fakes.pages.answer.list = [];
    fakes.connection.set('offline');
    fakes.connection.set('online');
    await flushPromises();
    expect(fakes.pages.systemPages.calls).toHaveLength(2);
    expect(fakes.stores.pages.nav.value).toEqual([]);
    stop();
  });
});

describe('the system page host', () => {
  it('mounts the page with its host and puts it in the nav', async () => {
    const { app, stores } = await visit('/s/crew/roster?q=ada', [ROSTER, MEMBER]);
    expect(byTest('who')?.textContent).toBe(`${stores.session.user.value?.name ?? ''} on roster`);
    expect(byTest('q')?.textContent).toBe('ada');
    expect(byTest('same-host')?.textContent).toBe('true');
    expect(byTest('member-link')?.getAttribute('href')).toBe('/s/crew/member/main/ada');
    const nav = [...document.body.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/s/crew/roster');
    expect(nav?.textContent).toContain('Crew');
    app.unmount();
  });

  it('binds the URL query two ways and moves between the system’s pages', async () => {
    const { app, router } = await visit('/s/crew/roster', [ROSTER, MEMBER]);
    byTest('search')?.click();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ q: 'cook' });
    expect(byTest('q')?.textContent).toBe('cook');
    byTest('open')?.click();
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/s/crew/member/main/ada');
    expect(byTest('member')?.textContent).toBe('main/ada');
    app.unmount();
  });

  it('keeps a stale link’s URL and says the system isn’t installed, then draws the page once it is back', async () => {
    const { app, router, pages } = await visit('/s/crew/roster?q=ada', []);
    expect(router.currentRoute.value.fullPath).toBe('/s/crew/roster?q=ada');
    expect(byTest('system-page-missing')?.textContent).toContain('crew isn’t installed');
    expect(byTest('roster')).toBeNull();
    expect([...document.body.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/s/crew/roster')).toBe(false);
    pages.answer.list = [ROSTER];
    pages.events.push({ type: 'capabilities' });
    await flushPromises();
    expect(byTest('roster')).not.toBeNull();
    expect(byTest('q')?.textContent).toBe('ada');
    app.unmount();
  });

  it('takes the page away when its system leaves while it is open', async () => {
    const { app, pages } = await visit('/s/crew/roster', [ROSTER]);
    expect(byTest('roster')).not.toBeNull();
    pages.answer.list = [];
    pages.events.push({ type: 'capabilities' });
    await flushPromises();
    expect(byTest('roster')).toBeNull();
    expect(byTest('system-page-missing')).not.toBeNull();
    app.unmount();
  });

  it('says a page the system no longer has is missing, not the system', async () => {
    const { app } = await visit('/s/crew/gone', [ROSTER]);
    expect(byTest('system-page-missing')?.textContent).toContain('No such page');
    app.unmount();
  });

  it('shows a page that fails while drawing as a problem, not a broken app', async () => {
    const { app } = await visit('/s/crew/roster', [ROSTER], Broken);
    expect(byTest('system-page-crashed')?.textContent).toContain('the roster lost its crew');
    expect(document.body.querySelector('nav')).not.toBeNull();
    app.unmount();
  });
});
