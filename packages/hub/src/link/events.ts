/**
 * Hub events systems subscribed to. A manifest lists the event types its implementation handles; the relay turns
 * the matching bus events into `SystemEvent`s and sends each to the connected systems that asked for it (`event`,
 * fire and forget: a system that fails to take one is logged, never retried).
 */
import type { Logger } from '@ayepi/log';
import { isHeardSystemStatus, type ChatMessage, type MessageView, type SystemEvent } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { LinkService } from './index.ts';

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

/** Relays subscribed hub events to systems. */
export class SystemEventRelay {
  readonly #links: LinkService;
  readonly #catalog: Catalog;
  readonly #log: Logger;
  readonly #stops: Array<() => void> = [];

  constructor(options: { bus: EventBus; links: LinkService; catalog: Catalog; log: Logger }) {
    this.#links = options.links;
    this.#catalog = options.catalog;
    this.#log = options.log;
    const { bus } = options;
    this.#stops.push(
      bus.subscribe('message', ({ message }) => { if (message.status === 'done') { this.send({ type: 'message', message: messageView(message) }); } }),
      bus.subscribe('run.update', ({ run, fn, update }) => { this.send({ type: 'run', run, fn, update }); }),
      bus.subscribe('resources.changed', ({ changes }) => { this.send({ type: 'resources', changes }); }),
      bus.subscribe('system.status', ({ system, status }) => {
        if (isHeardSystemStatus(status)) { this.send({ type: 'system', system, status }); }
      }),
      bus.subscribe('catalog.changed', ({ added, removed }) => { if (added.length + removed.length > 0) { this.send({ type: 'fns', added, removed }); } }),
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
