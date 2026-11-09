/**
 * Fake connection callers: one per-person system (`calendar`, an OAuth flow) whose page the test sets up, ready or
 * not. `connect` answers a sign-in address; changes and disconnecting edit the page in memory.
 */
import { ActorId, ConnectDecl, ConnectionId, SystemName, type ConnectionView, type ConnectPage } from '@harness/core';
import { fakeCaller } from './fakes.ts';

/** The fake system's declaration: three fns, one off and two that ask first. */
export const CALENDAR_DECL: ConnectDecl = ConnectDecl.parse({
  title: 'Calendar',
  description: 'Connect your calendar.',
  icon: 'calendar',
  how: { flow: 'oauth' },
  settings: { name: 'obj', props: { defaultCalendar: { type: { name: 'optional', generic: { T: { name: 'text' } } } } } },
  fns: { list_events: { on: true, ask: false }, create_event: { on: true, ask: true }, delete_event: { on: false, ask: true } },
});

/** A connection of the fake system, connected and owned by `owner`. */
export function calendarConnection(owner = 'act_me', change: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: ConnectionId.parse(`cnx_${owner}`), system: SystemName.parse('calendar'), owner: ActorId.parse(owner), status: 'connected',
    account: { label: `${owner}@example.com` }, settings: {}, fns: {}, share: { visibility: 'private', with: [] },
    createdAt: 1_000, updatedAt: 1_000, ...change,
  };
}

/** Fake `connectPages`, `connect`, `updateConnection` and `disconnect`, over one page. */
export function fakeConnectionsApi(page: Partial<ConnectPage> = {}) {
  let held: ConnectPage = { system: SystemName.parse('calendar'), decl: CALENDAR_DECL, ready: true, connections: [], ...page };
  return {
    connectPages: fakeCaller<'connectPages'>(() => Promise.resolve([held])),
    connect: fakeCaller<'connect'>(() => Promise.resolve({ url: 'https://accounts.example.com/sign-in' })),
    updateConnection: fakeCaller<'updateConnection'>(({ connection, settings, fns, share }) => {
      const found = held.connections.find((c) => c.id === connection);
      if (found === undefined) { return Promise.reject(new Error('no such connection')); }
      const next: ConnectionView = {
        ...found, ...(settings === undefined ? {} : { settings }), ...(fns === undefined ? {} : { fns }),
        ...(share === undefined ? {} : { share: { visibility: share.visibility, with: share.with.map((id) => ActorId.parse(id)) } }),
        updatedAt: found.updatedAt + 1,
      };
      held = { ...held, connections: held.connections.map((c) => (c.id === connection ? next : c)) };
      return Promise.resolve(next);
    }),
    disconnect: fakeCaller<'disconnect'>(({ connection }) => {
      held = { ...held, connections: held.connections.filter((c) => c.id !== connection) };
      return Promise.resolve({ ok: true });
    }),
  };
}
