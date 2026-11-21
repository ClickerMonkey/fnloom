/**
 * The realtime relay: each bus event a browser cares about becomes a `session` event (to everyone watching that
 * session) or a `user` event, sent only to the people it is for. One table, `ROUTES`, says what every bus event becomes
 * and who hears it, so a new bus event is relayed by adding one line and a changed web event shape breaks here at
 * compile time.
 *
 * Who hears a `user` event:
 * - a notification: the person it is for;
 * - an approval: the people who answer it (the hub's approvers) and the person whose turn asked;
 * - a session summary or deletion: the session's people, the same rule `visibleSession` applies (a participant);
 * - a pairing: the admins;
 * - system status, capabilities, fn numbers, resource forms, context changes and the hub's name: everyone signed in.
 *
 * `Listeners` remembers which person and sign-in each socket subscribed as (the event guards add it), so "everyone"
 * means everyone listening, and a sign-out or a turned-off person (`access.ended`) ends their sockets' subscriptions.
 */
import type { AnySpec, Server, WsConn } from '@ayepi/core';
import type { ActorId, AuthSessionId, SessionEvent, SessionId, UserEvent } from '@harness/core';
import type { EventBus, HubEventName, HubEvents } from '../bus.ts';
import type { HubStore } from '../store/index.ts';
import { USER_COLUMNS } from '../query/columns.ts';
import type { EventRelay, WebEmit } from './index.ts';

/** Where relayed events go, by who hears them. */
export interface WebAudience {
  /** Everyone watching a session (the `session` guard let only people who may see it in). */
  session(session: SessionId, event: SessionEvent): void;
  /** These people. */
  people(users: readonly ActorId[], event: UserEvent): void;
  /** Everyone signed in and listening. */
  everyone(event: UserEvent): void;
  /** The hub's admins (read from the database when the event happens). */
  admins(event: UserEvent): Promise<void>;
}

/** How one bus event reaches browsers. */
type Route<E extends HubEventName> = (data: HubEvents[E], to: WebAudience) => void | Promise<void>;

/** Every relayed bus event. Events browsers don't hear (resources, internal catalog detail) are absent. */
export const ROUTES: { readonly [E in HubEventName]?: Route<E> } = {
  'message': ({ message }, to) => { to.session(message.session, { type: 'message', message }); },
  'message.token': ({ session, message, text }, to) => { to.session(session, { type: 'token', message, text }); },
  'message.reasoning': ({ session, message, text }, to) => { to.session(session, { type: 'reasoning', message, text }); },
  'session.changed': ({ session, participants }, to) => {
    to.session(session.id, { type: 'session', session });
    to.people(participants, { type: 'session', session });
  },
  'session.deleted': ({ session, participants }, to) => { to.people(participants, { type: 'session-deleted', session }); },
  'session.controls': ({ session, controls }, to) => { to.session(session, { type: 'controls', controls }); },
  'turn.compare': ({ session, turn }, to) => { to.session(session, { type: 'compare', turn }); },
  'budget.reached': ({ session, run, budget, reason }, to) => {
    if (session !== undefined) { to.session(session, { type: 'budget', run, budget, reason }); }
  },
  'run.update': ({ run, fn, session, update }, to) => {
    if (session !== undefined) { to.session(session, { type: 'run', run, fn, update }); }
  },
  'state.changed': ({ session, system, fields }, to) => { to.session(session, { type: 'state', system, fields }); },
  'delivery': ({ session, delivery }, to) => { to.session(session, { type: 'delivery', delivery }); },
  'handler': ({ session, call }, to) => {
    if (session !== undefined) { to.session(session, { type: 'handler', call }); }
  },
  'approval': ({ session, approval, approvers, turnUser }, to) => {
    if (session !== undefined) { to.session(session, { type: 'approval', approval }); }
    to.people([...approvers, turnUser], { type: 'approval', approval });
  },
  'presence': ({ presence }, to) => { to.session(presence.session, { type: 'presence', presence }); },
  'notification': ({ notification }, to) => { to.people([notification.user], { type: 'notification', notification }); },
  'system.status': ({ system, status }, to) => {
    to.everyone({ type: 'system', system, status });
    to.everyone({ type: 'capabilities' });
  },
  'pairing': ({ pairing }, to) => to.admins({ type: 'pairing', pairing }),
  'identity': ({ identity }, to) => { to.everyone({ type: 'identity', identity }); },
  'catalog.changed': (_data, to) => { to.everyone({ type: 'capabilities' }); },
  'fn.stats': ({ fn, system, stats }, to) => { to.everyone({ type: 'fn', fn, system, stats }); },
  'capabilities.changed': (_data, to) => { to.everyone({ type: 'capabilities' }); },
  'resource.forms': ({ uri, forms }, to) => { to.everyone({ type: 'resource', uri, forms }); },
  'context.changed': ({ name }, to) => { to.everyone({ type: 'context', name }); },
};

/** The names of the relayed events, typed (the table's keys). */
function routedEvents(): HubEventName[] {
  return Object.keys(ROUTES).filter((name): name is HubEventName => name in ROUTES);
}

/** Who a socket listens as: the person and the sign-in its token belongs to. */
export interface Listener {
  readonly user: ActorId;
  readonly session: AuthSessionId;
}

/** Which person and sign-in each listening socket subscribed as. A socket is forgotten when it closes or is ended. */
export class Listeners {
  readonly #by = new Map<WsConn, Listener>();

  /** Remember a socket that passed an event guard. */
  add(conn: WsConn, who: Listener): void {
    if (!this.#by.has(conn)) { conn.req.signal.addEventListener('abort', () => { this.#by.delete(conn); }, { once: true }); }
    this.#by.set(conn, who);
  }

  /** The people listening now, each once. */
  people(): ActorId[] {
    return [...new Set([...this.#by.values()].map((who) => who.user))];
  }

  /** Forget and return the sockets of one sign-in (`session`) or, without one, all of a person's. */
  take(ended: { readonly user: ActorId; readonly session?: AuthSessionId | undefined }): WsConn[] {
    const gone = [...this.#by].filter(([, who]) => who.user === ended.user && (ended.session === undefined || who.session === ended.session)).map(([conn]) => conn);
    for (const conn of gone) { this.#by.delete(conn); }
    return gone;
  }
}

/** What ends a socket's subscriptions: the web API server's `ws` side. */
export type WebSockets = Pick<Server<AnySpec>['ws'], 'close'>;

/** How many admins one read takes. */
const ADMIN_PAGE = 100;

/** The hub's admins who can sign in, read in SQL a page at a time. */
export async function activeAdmins(store: Pick<HubStore, 'lists'>): Promise<ActorId[]> {
  const out: ActorId[] = [];
  for (let offset = 0; ; offset += ADMIN_PAGE) {
    const { items } = await store.lists.find({
      table: 'actors', fields: USER_COLUMNS, sort: [{ field: 'createdAt', dir: 'asc' }], offset, limit: ADMIN_PAGE,
      filters: [{ field: 'kind', op: 'is', value: 'user' }, { field: 'role', op: 'is', value: 'admin' }, { field: 'disabled', op: 'is', value: false }],
    });
    out.push(...items.map((row) => row.id));
    if (items.length < ADMIN_PAGE) { return out; }
  }
}

/** What the relay reads. */
export interface RelayDeps {
  readonly bus: EventBus;
  readonly store: Pick<HubStore, 'lists'>;
}

/** Relays the bus to browsers through the web API's events, each to the people it is for. */
export class BusEventRelay implements EventRelay {
  readonly #deps: RelayDeps;
  readonly #listeners = new Listeners();

  constructor(deps: RelayDeps) {
    this.#deps = deps;
  }

  listen(conn: WsConn, who: Listener): void {
    this.#listeners.add(conn, who);
  }

  start(emit: WebEmit, sockets: WebSockets): () => void {
    const audience = this.#audience(emit);
    const stops = routedEvents().map((event) => this.#relay(event, audience));
    stops.push(this.#deps.bus.subscribe('access.ended', (ended) => {
      for (const conn of this.#listeners.take(ended)) {
        sockets.close(conn);
        // again once the current work settles: a guard that let the socket in just now adds its subscription after
        // returning (the server does that a few microtasks later), and that late subscription must end too
        setImmediate(() => { sockets.close(conn); });
      }
    }));
    return () => { for (const stop of stops) { stop(); } };
  }

  #audience(emit: WebEmit): WebAudience {
    const people = (users: readonly ActorId[], event: UserEvent): void => {
      for (const user of new Set(users)) { emit('user', { user }, event); }
    };
    return {
      session: (session, event) => { emit('session', { session }, event); },
      people,
      everyone: (event) => { people(this.#listeners.people(), event); },
      admins: async (event) => { people(await activeAdmins(this.#deps.store), event); },
    };
  }

  #relay<E extends HubEventName>(event: E, audience: WebAudience): () => void {
    const route: Route<E> | undefined = ROUTES[event];
    if (route === undefined) { return () => undefined; }
    return this.#deps.bus.subscribe(event, (data) => route(data, audience));
  }
}
