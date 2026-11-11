/**
 * The connect pages: the rules (whose connection, the fn switches over the defaults, the nav entries), the store's
 * changes, and the page at its own address over the fake stores.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { ActorId, SystemName, type ConnectPage } from '@harness/core';
import App from '../app/App.vue';
import { navEntries } from '../app/nav.ts';
import { ROUTES } from '../app/routes.ts';
import { createAppRouter } from '../app/router.ts';
import { fakeChat, fakeChatApi } from '../chat/test/fakes.ts';
import { STORES } from '../state/stores.ts';
import { CALENDAR_DECL, calendarConnection, fakeConnectionsApi } from '../test/connections.ts';
import { fakeStores, tokens } from '../test/fakes.ts';
import { fakePickerApi } from '../test/pickers.ts';
import { connectNav, fnRows, pageConnections, pickedSettings, settingsPicks, withFnOption } from './logic.ts';
import { ConnectionsStore } from './store.ts';

const CALENDAR = SystemName.parse('calendar');
const page = (change: Partial<ConnectPage> = {}): ConnectPage => ({ system: CALENDAR, decl: CALENDAR_DECL, ready: true, connections: [], ...change });

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('connect rules', () => {
  it('tells the person’s own connection from the ones shared with them', () => {
    const mine = calendarConnection('act_me', { updatedAt: 5 });
    const old = calendarConnection('act_me', { id: calendarConnection('act_old').id, updatedAt: 1 });
    const bobs = calendarConnection('act_bob');
    const split = pageConnections(page({ connections: [old, bobs, mine] }), ActorId.parse('act_me'));
    expect(split.own).toBe(mine);
    expect(split.shared).toEqual([bobs]);
  });

  it('takes each fn’s default until the person changes it, and writes every fn on a change', () => {
    const rows = fnRows(page(), calendarConnection('act_me', { fns: { delete_event: { on: true, ask: true } } }));
    expect(rows.map((r) => [r.local, r.option.on, r.option.ask, r.changed])).toEqual([
      ['list_events', true, false, false], ['create_event', true, true, false], ['delete_event', true, true, true],
    ]);
    expect(withFnOption(rows, 'create_event', { ask: false })).toEqual({
      list_events: { on: true, ask: false }, create_event: { on: true, ask: false }, delete_event: { on: true, ask: true },
    });
  });

  it('adds a nav entry per page after Context, lit on its own page', () => {
    const user = tokens().user;
    const entries = navEntries({ name: ROUTES.connect, params: { system: 'calendar' } }, user, { inbox: 0, admin: 0 }, connectNav([page()]));
    expect(entries.map((e) => e.id)).toEqual(['chat', 'inbox', 'resources', 'context', 'connect-calendar', 'graph', 'admin', 'settings']);
    expect(entries.find((e) => e.active)?.id).toBe('connect-calendar');
    expect(entries.find((e) => e.id === 'connect-calendar')?.icon).toBe('calendar');
  });
});

const CALENDARS = [{ value: 'primary', label: 'Ada', hint: 'Primary' }, { value: 'team', label: 'Team' }];

describe('settings pickers', () => {
  const settings = { name: 'obj', props: {
    calendars: { type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'text' } } } } } },
    defaultCalendar: { type: { name: 'optional', generic: { T: { name: 'text' } } }, docs: 'Where new events go.' },
  } };

  it('picks each field from the account’s values, many for a list and one otherwise, only when every field has them', () => {
    const picks = settingsPicks(settings, { calendars: CALENDARS, defaultCalendar: CALENDARS });
    expect(picks?.map((pick) => [pick.key, pick.label, pick.many, pick.hint])).toEqual([['calendars', 'Calendars', true, ''], ['defaultCalendar', 'Default calendar', false, 'Where new events go.']]);
    expect(settingsPicks(settings, { calendars: CALENDARS })).toBeUndefined();
    expect(settingsPicks(settings, undefined)).toBeUndefined();
    if (picks === undefined) { throw new Error('no picks'); }
    expect(pickedSettings(picks, { calendars: ['primary', 'team'], defaultCalendar: ['team'] })).toEqual({ calendars: ['primary', 'team'], defaultCalendar: 'team' });
    expect(pickedSettings(picks, { calendars: [], defaultCalendar: [] })).toEqual({});
  });
});

describe('ConnectionsStore', () => {
  it('keeps the stored connection after a change, and drops it on disconnect', async () => {
    const api = fakeConnectionsApi({ connections: [calendarConnection('act_me')] });
    const store = new ConnectionsStore(api);
    await store.load();
    const own = store.page(CALENDAR)?.connections[0];
    if (own === undefined) { throw new Error('no connection'); }
    const done = await store.update({ connection: own.id, share: { visibility: 'public', with: [] } });
    expect(done.ok && done.value.share.visibility).toBe('public');
    expect(store.page(CALENDAR)?.connections[0]?.share.visibility).toBe('public');
    await store.disconnect(own.id);
    expect(store.page(CALENDAR)?.connections).toEqual([]);
    expect(api.disconnect.calls).toEqual([[{ connection: own.id }]]);
  });
});

/** Mount the app at a connect page, signed in as Ada, over a hub with `connect` as its one page. */
async function visit(connect: Partial<ConnectPage>, multiUser = false) {
  const fakes = fakeStores({ signedIn: true });
  const api = { ...fakeChatApi(), ...fakePickerApi(multiUser), ...fakeConnectionsApi(connect) };
  const { chat } = fakeChat({ api });
  const stores = { ...fakes.stores, chat };
  const router = createAppRouter(stores.session, createMemoryHistory());
  await router.push('/connect/calendar');
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: stores } } });
  await flushPromises();
  return { api, app };
}

const testid = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

describe('the connect page', () => {
  it('says when an admin hasn’t set it up, and can’t connect yet', async () => {
    const { app } = await visit({ ready: false });
    expect(testid('connect-not-ready')?.textContent).toContain('hasn\'t set up Calendar');
    expect(testid('connect-start')?.hasAttribute('disabled')).toBe(true);
    expect(testid('nav-connect-calendar')).not.toBeNull();
    app.unmount();
  });

  it('sends the person to the provider’s sign-in', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    const { api, app } = await visit({});
    testid('connect-start')?.click();
    await flushPromises();
    expect(api.connect.calls).toEqual([[{ system: CALENDAR }]]);
    expect(assign).toHaveBeenCalledWith('https://accounts.example.com/sign-in');
    app.unmount();
  });

  it('switches a fn and shows sharing only on a hub with several people', async () => {
    const own = calendarConnection('act_ada');
    const single = await visit({ connections: [own] });
    expect(testid('connection-account')?.textContent).toContain('act_ada@example.com');
    expect(testid('connection-sharing')).toBeNull();
    const deleteOn = document.querySelector<HTMLButtonElement>('[data-testid="connection-fn-delete_event"] [data-testid="fn-on"] button');
    deleteOn?.click();
    await flushPromises();
    expect(single.api.updateConnection.calls[0]?.[0].fns?.['delete_event']).toEqual({ on: true, ask: true });
    single.app.unmount();

    const multi = await visit({ connections: [own] }, true);
    expect(testid('connection-sharing')).not.toBeNull();
    multi.app.unmount();
  });

  it('picks the settings from the account’s own calendars and saves each pick', async () => {
    const own = calendarConnection('act_ada', { account: { label: 'ada@example.com', choices: { defaultCalendar: CALENDARS } } });
    const { api, app } = await visit({ connections: [own] });
    const box = testid('settings-defaultCalendar');
    expect(box).not.toBeNull();
    box?.querySelector('input')?.dispatchEvent(new Event('focus'));
    await flushPromises();
    const team = [...document.querySelectorAll<HTMLElement>('[data-testid="picker-option"]')].find((o) => o.textContent.includes('Team'));
    team?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(api.updateConnection.calls[0]?.[0].settings).toEqual({ defaultCalendar: 'team' });
    app.unmount();
  });
});
