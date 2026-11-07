/**
 * The in-process `EventBus`: listeners keyed by event name, each called on a microtask after `publish` returns, so a
 * publisher never waits on (or is broken by) a listener. A listener that throws, or returns a promise that rejects, is
 * reported through `onError` and the others still run.
 */
import type { EventBus, HubEventName, HubEvents } from '../bus.ts';

/** Where listener failures go (the hub passes its logger). */
export type BusErrorSink = (event: HubEventName, error: unknown) => void;

/** A listener; what it returns is only looked at to catch a rejected promise. */
type Listener<E extends HubEventName> = (data: HubEvents[E]) => unknown;

/** A typed publish/subscribe bus in one process. */
export class MemoryEventBus implements EventBus {
  /** The listeners of each event. Each set only ever holds listeners of its own event (see `#set`). */
  readonly #listeners = new Map<HubEventName, Set<Listener<never>>>();
  readonly #onError: BusErrorSink;

  constructor(onError: BusErrorSink) {
    this.#onError = onError;
  }

  publish<E extends HubEventName>(event: E, data: HubEvents[E]): void {
    const listeners = this.#set(event);
    for (const listener of [...listeners]) {
      queueMicrotask(() => { this.#call(event, listener, data); });
    }
  }

  subscribe<E extends HubEventName>(event: E, listener: Listener<E>): () => void {
    const listeners = this.#set(event);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  /** How many listeners an event has (for tests and the health page). */
  listenerCount(event: HubEventName): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  #set<E extends HubEventName>(event: E): Set<Listener<E>> {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the set under `event` only receives listeners of `E` (subscribe is the one writer)
    return set as Set<Listener<E>>;
  }

  #call<E extends HubEventName>(event: E, listener: Listener<E>, data: HubEvents[E]): void {
    try {
      const result: unknown = listener(data);
      if (result instanceof Promise) { result.catch((error: unknown) => { this.#onError(event, error); }); }
    } catch (error) {
      this.#onError(event, error);
    }
  }
}
