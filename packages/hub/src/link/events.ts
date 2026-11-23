/**
 * Hub events systems subscribed to. A manifest lists the event types its implementation handles; the relay turns
 * the matching bus events into `SystemEvent`s and sends each to the connected systems that asked for it (`event`,
 * fire and forget: a system that fails to take one is logged, never retried).
 */
import type { Logger } from '@ayepi/log';
import { isHeardSystemStatus, isSettled, type ChatMessage, type FnRecord, type MessageView, type QualifiedName, type RunId, type SystemEvent, type SystemName } from '@harness/core';
import type { EventBus } from '../bus.ts';
import { messageOf } from '../catalog/scope.ts';

/** A finished message as systems see it: its text parts joined. */
export function messageView(message: ChatMessage): MessageView {
  return {
    id: message.id,
    session: message.session,
    author: message.author,
    role: message.role,
    text: message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : part.type === 'mention' ? [part.label] : [])).join(''),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    replyAll: message.replyAll,
    createdAt: message.createdAt,
  };
}

/**
 * The `fns` event for a catalog change: `added` only the new fns, `changed` those saved again (a new version) or whose
 * availability moved (an owner turned off, a system gone), `removed` the ones gone.
 */
export function fnsEvent(event: { added: readonly QualifiedName[]; removed: readonly QualifiedName[]; fns: readonly FnRecord[]; updated?: readonly QualifiedName[] }): Extract<SystemEvent, { type: 'fns' }> {
  const updated = new Set(event.updated ?? []);
  const added = event.added.filter((name) => !updated.has(name));
  const gone = new Set([...added, ...event.removed]);
  const changed = [...new Set([...updated, ...event.fns.map((fn) => fn.name)])].filter((name) => !gone.has(name)).sort();
  return { type: 'fns', added, removed: [...event.removed], changed };
}

/** How many runs that notified are remembered until they settle. */
const NOTIFIED_REMEMBERED = 10_000;

/** An insertion-ordered set of run ids that forgets its oldest past a size. */
class RecentRuns {
  readonly #items = new Set<RunId>();
  readonly #size: number;

  constructor(size: number) {
    this.#size = size;
  }

  add(run: RunId): void {
    this.#items.delete(run);
    this.#items.add(run);
    for (const old of this.#items) {
      if (this.#items.size <= this.#size) { break; }
      this.#items.delete(old);
    }
  }

  has(run: RunId): boolean {
    return this.#items.has(run);
  }
}

/** The connected systems the relay sends to (the link service's), each with the peer it calls `event` on. */
export interface RelayLinks {
  connected(): ReadonlyArray<{ readonly system: SystemName; readonly peer: { call(endpoint: 'event', event: SystemEvent): Promise<unknown> } }>;
}

/** Which event types a system's manifest subscribes to (the catalog's). */
export interface RelayCatalog {
  manifest(system: SystemName): Promise<{ readonly events: readonly string[] } | undefined>;
}

/** Relays subscribed hub events to systems. */
export class SystemEventRelay {
  readonly #links: RelayLinks;
  readonly #catalog: RelayCatalog;
  readonly #log: Logger;
  readonly #stops: Array<() => void> = [];
  /** Runs that (or under which a run) sent their person a notice, newest kept. */
  readonly #notified = new RecentRuns(NOTIFIED_REMEMBERED);

  constructor(options: { bus: EventBus; links: RelayLinks; catalog: RelayCatalog; log: Logger }) {
    this.#links = options.links;
    this.#catalog = options.catalog;
    this.#log = options.log;
    const { bus } = options;
    this.#stops.push(
      bus.subscribe('message', ({ message }) => { if (message.status === 'done') { this.send({ type: 'message', message: messageView(message) }); } }),
      bus.subscribe('run.notified', ({ runs }) => { for (const run of runs) { this.#notified.add(run); } }),
      bus.subscribe('run.update', ({ run, fn, update }) => {
        // the update that settles a run says whether it, or a run under it, told its person something
        const settles = update.type === 'status' && isSettled(update.status);
        this.send({ type: 'run', run, fn, update, ...(settles ? { notified: this.#notified.has(run) } : {}) });
      }),
      bus.subscribe('resources.changed', ({ changes }) => { this.send({ type: 'resources', changes }); }),
      bus.subscribe('system.status', ({ system, status }) => {
        if (isHeardSystemStatus(status)) { this.send({ type: 'system', system, status }); }
      }),
      bus.subscribe('catalog.changed', (event) => {
        const fns = fnsEvent(event);
        if (fns.added.length + fns.removed.length + fns.changed.length > 0) { this.send(fns); }
      }),
    );
  }

  /** Send an event to every connected system that subscribed to its type. */
  send(event: SystemEvent): void {
    void Promise.all(this.#links.connected().map(async (connection) => {
      const manifest = await this.#catalog.manifest(connection.system);
      if (manifest?.events.includes(event.type) !== true) { return; }
      try {
        await connection.peer.call('event', event);
      } catch (error) {
        this.#log.warn('link.event.failed', { system: connection.system, type: event.type, error: messageOf(error) });
      }
    }));
  }

  /** Stop relaying. */
  stop(): void {
    for (const stop of this.#stops.splice(0)) { stop(); }
  }
}
