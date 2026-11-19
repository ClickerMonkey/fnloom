/**
 * The realtime relay: each bus event a browser cares about becomes a `session` event (to everyone watching that
 * session) or a `user` event (to signed-in browsers). One table, `ROUTES`, says what every bus event becomes, so a new
 * bus event is relayed by adding one line and a changed web event shape breaks here at compile time.
 */
import type { EventBus, HubEventName, HubEvents } from '../bus.ts';
import type { EventRelay, WebEmit } from './index.ts';

/** How one bus event reaches browsers. */
type Route<E extends HubEventName> = (data: HubEvents[E], emit: WebEmit) => void;

/** Every relayed bus event. Events browsers don't hear (resources, internal catalog detail) are absent. */
export const ROUTES: { readonly [E in HubEventName]?: Route<E> } = {
  'message': ({ message }, emit) => { emit('session', { session: message.session }, { type: 'message', message }); },
  'message.token': ({ session, message, text }, emit) => { emit('session', { session }, { type: 'token', message, text }); },
  'message.reasoning': ({ session, message, text }, emit) => { emit('session', { session }, { type: 'reasoning', message, text }); },
  'session.changed': ({ session }, emit) => {
    emit('session', { session: session.id }, { type: 'session', session });
    emit('user', { type: 'session', session });
  },
  'session.deleted': ({ session }, emit) => { emit('user', { type: 'session-deleted', session }); },
  'session.controls': ({ session, controls }, emit) => { emit('session', { session }, { type: 'controls', controls }); },
  'turn.compare': ({ session, turn }, emit) => { emit('session', { session }, { type: 'compare', turn }); },
  'budget.reached': ({ session, run, budget, reason }, emit) => {
    if (session !== undefined) { emit('session', { session }, { type: 'budget', run, budget, reason }); }
  },
  'run.update': ({ run, fn, session, update }, emit) => {
    if (session !== undefined) { emit('session', { session }, { type: 'run', run, fn, update }); }
  },
  'state.changed': ({ session, system, fields }, emit) => { emit('session', { session }, { type: 'state', system, fields }); },
  'delivery': ({ session, delivery }, emit) => { emit('session', { session }, { type: 'delivery', delivery }); },
  'handler': ({ session, call }, emit) => {
    if (session !== undefined) { emit('session', { session }, { type: 'handler', call }); }
  },
  'approval': ({ session, approval }, emit) => {
    if (session !== undefined) { emit('session', { session }, { type: 'approval', approval }); }
    emit('user', { type: 'approval', approval });
  },
  'presence': ({ presence }, emit) => { emit('session', { session: presence.session }, { type: 'presence', presence }); },
  'notification': ({ notification }, emit) => { emit('user', { type: 'notification', notification }); },
  'system.status': ({ system, status }, emit) => {
    emit('user', { type: 'system', system, status });
    emit('user', { type: 'capabilities' });
  },
  'pairing': ({ pairing }, emit) => { emit('user', { type: 'pairing', pairing }); },
  'identity': ({ identity }, emit) => { emit('user', { type: 'identity', identity }); },
  'catalog.changed': (_data, emit) => { emit('user', { type: 'capabilities' }); },
  'fn.stats': ({ fn, system, stats }, emit) => { emit('user', { type: 'fn', fn, system, stats }); },
  'capabilities.changed': (_data, emit) => { emit('user', { type: 'capabilities' }); },
  'resource.forms': ({ uri, forms }, emit) => { emit('user', { type: 'resource', uri, forms }); },
  'context.changed': ({ name }, emit) => { emit('user', { type: 'context', name }); },
};

/** The names of the relayed events, typed (the table's keys). */
function routedEvents(): HubEventName[] {
  return Object.keys(ROUTES).filter((name): name is HubEventName => name in ROUTES);
}

/** Relays the bus to browsers through the web API's events. */
export class BusEventRelay implements EventRelay {
  readonly #bus: EventBus;

  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  start(emit: WebEmit): () => void {
    const stops = routedEvents().map((event) => this.#relay(event, emit));
    return () => { for (const stop of stops) { stop(); } };
  }

  #relay<E extends HubEventName>(event: E, emit: WebEmit): () => void {
    const route: Route<E> | undefined = ROUTES[event];
    if (route === undefined) { return () => undefined; }
    return this.#bus.subscribe(event, (data) => { route(data, emit); });
  }
}
