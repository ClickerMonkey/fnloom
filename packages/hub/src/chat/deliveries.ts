/**
 * Deliveries: actions a renderer sends to its system, and form submissions to a waiting run. Each is checked against
 * its declared type and stored before anything is sent, so nothing is lost while the system is offline. Each
 * system's deliveries go out one at a time, oldest first; a delivery cut off by a disconnect goes back to the queue
 * and is sent again, in order, when the system connects. Its status (queued, delivered, done, failed, expired) is
 * published as it changes.
 */
import { ApiError } from '@ayepi/core';
import {
  DeliveryView, mintId, qualify, type ActorId, type GinTypeDef, type ClientInfo, type DeliveryId, type DeliveryRecord, type FnError, type Json, type RunId, type SessionId, type SystemName,
} from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import type { DeliveryService } from './index.ts';
import type { People } from './people.ts';
import { allowsSystem, callSystem, entryOf, readAll } from './support.ts';

/** How many queued deliveries are read at a time while draining a system's queue. */
const BATCH = 50;

/** The status `ApiError` carries when the connection closed before the reply. */
const DISCONNECTED = 0;

/** Deliveries on the store, sent over the link. */
export class LinkDeliveryService implements DeliveryService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'catalog' | 'link'>;
  readonly #people: People;
  /** The drain in progress per system; flushes chain onto it so a system's deliveries never overlap. */
  readonly #drains = new Map<SystemName, Promise<void>>();

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'catalog' | 'link'>, people: People) {
    this.#deps = deps;
    this.#people = people;
  }

  async act(input: { session: SessionId; system: SystemName; action: string; input: Json; run?: RunId; actor: ActorId; client: ClientInfo }): Promise<DeliveryId> {
    const session = await this.#deps.store.table('sessions').get(input.session);
    if (session?.participants.some((p) => p.actor === input.actor && p.role !== 'agent') !== true) { throw new ChatError('not-found', 'No such session.'); }
    if (!allowsSystem(session, input.system)) { throw new ChatError('unavailable', `The ${input.system} system is not enabled in this session.`); }
    const name = qualify(input.system, input.action);
    const action = await entryOf(this.#deps.catalog, 'actions', name);
    if (action === undefined) { throw new ChatError('not-found', `No action ${name}.`); }
    const available = await this.#deps.catalog.availability(name);
    if (available !== true) { throw new ChatError('unavailable', `${name} can't be used now: ${available.detail}.`); }
    await this.#check(input.system, action.decl.input, input.input, `The input of ${name}`);
    if (input.run !== undefined) {
      const run = await this.#deps.store.table('runs').get(input.run);
      if (run?.session !== input.session) { throw new ChatError('invalid', 'That run is not in this session.'); }
    }
    const now = this.#deps.clock();
    return this.#store({
      id: mintId('delivery', this.#deps.random), system: input.system, kind: { action: input.action, input: input.input }, session: input.session, actor: input.actor,
      ...(input.run === undefined ? {} : { run: input.run }), status: 'queued', attempts: 0, createdAt: now,
      ...(action.decl.expires === undefined ? {} : { expiresAt: now + action.decl.expires }),
    });
  }

  async submit(input: { run: RunId; value: Json; actor: ActorId }): Promise<DeliveryId> {
    const run = await this.#deps.store.table('runs').get(input.run);
    if (run?.session === undefined) { throw new ChatError('not-found', `No session run ${input.run}.`); }
    const session = await this.#deps.store.table('sessions').get(run.session);
    if (session?.participants.some((p) => p.actor === input.actor && p.role !== 'agent') !== true) { throw new ChatError('not-found', `No session run ${input.run}.`); }
    if (run.status !== 'running' && run.status !== 'waiting') { throw new ChatError('conflict', `The run is ${run.status}, not waiting for its form.`); }
    const fn = await this.#deps.catalog.fn(run.fn);
    if (fn?.decl.form === undefined) { throw new ChatError('invalid', `${run.fn} has no form.`); }
    await this.#check(fn.system, fn.decl.form, input.value, `The form of ${run.fn}`);
    return this.#store({
      id: mintId('delivery', this.#deps.random), system: run.system, kind: { form: run.id, value: input.value }, session: run.session, actor: input.actor, run: run.id,
      status: 'queued', attempts: 0, createdAt: this.#deps.clock(),
    });
  }

  async get(delivery: DeliveryId): Promise<DeliveryRecord | undefined> {
    return this.#deps.store.table('deliveries').get(delivery);
  }

  async flush(system: SystemName): Promise<void> {
    const previous = this.#drains.get(system) ?? Promise.resolve();
    // The previous drain's failure was reported to its own caller; it must not stop this one.
    const next = previous.catch(() => undefined).then(async () => this.#drain(system));
    this.#drains.set(system, next);
    try {
      await next;
    } finally {
      if (this.#drains.get(system) === next) { this.#drains.delete(system); }
    }
  }

  /** Flush each system as it connects, and every connected one now. Returns the stop. */
  start(): () => void {
    for (const connection of this.#deps.link.connected()) { this.#flushLater(connection.system); }
    return this.#deps.link.onChange(({ system, connected }) => { if (connected) { this.#flushLater(system); } });
  }

  #flushLater(system: SystemName): void {
    this.flush(system).catch((error: unknown) => { this.#deps.log.error('chat.delivery.flush.failed', { system, error: messageOf(error) }); });
  }

  async #check(system: SystemName, type: GinTypeDef, value: Json, what: string): Promise<void> {
    const problems = await this.#deps.catalog.check(system, type, value);
    if (problems.length > 0) { throw new ChatError('invalid', `${what} doesn't fit its type: ${problems.join('; ')}`); }
  }

  /** Store a new delivery, publish it, and send it when its system is online. */
  async #store(record: DeliveryRecord): Promise<DeliveryId> {
    await this.#deps.store.table('deliveries').insert(record);
    this.#deps.log.info('chat.delivery.queued', { delivery: record.id, system: record.system, kind: 'action' in record.kind ? 'action' : 'form' });
    this.#publish(record);
    if (this.#deps.link.connection(record.system) !== undefined) { this.#flushLater(record.system); }
    return record.id;
  }

  /**
   * Send a system's queued deliveries, oldest first, until none are left or it goes offline. Drains of one system never
   * overlap, so a delivery still marked delivered when one starts was cut off by a hub stop: it is sent again (systems
   * get the delivery id, so they can tell a repeat).
   */
  async #drain(system: SystemName): Promise<void> {
    await this.#requeueInterrupted(system);
    for (;;) {
      if (this.#deps.link.connection(system) === undefined) { return; }
      const queued = await this.#deps.store.table('deliveries').find({ where: { system, status: 'queued' }, order: [['createdAt', 'asc']], limit: BATCH });
      if (queued.items.length === 0) { return; }
      for (const delivery of queued.items) {
        if (!(await this.#deliver(delivery))) { return; }
      }
    }
  }

  async #requeueInterrupted(system: SystemName): Promise<void> {
    const deliveries = this.#deps.store.table('deliveries');
    const cut = await readAll(deliveries, { where: { system, status: 'delivered' } }, BATCH);
    for (const delivery of cut) {
      this.#publish(await deliveries.update(delivery.id, { status: 'queued' }));
      this.#deps.log.info('chat.delivery.requeued', { delivery: delivery.id, system, reason: 'interrupted' });
    }
  }

  /** Send one delivery. False when the system went away, so the drain stops and the rest wait in order. */
  async #deliver(delivery: DeliveryRecord): Promise<boolean> {
    const deliveries = this.#deps.store.table('deliveries');
    const now = this.#deps.clock();
    if (delivery.expiresAt !== undefined && delivery.expiresAt <= now) {
      this.#publish(await deliveries.update(delivery.id, { status: 'expired', doneAt: now }));
      return true;
    }
    this.#publish(await deliveries.update(delivery.id, { status: 'delivered', attempts: delivery.attempts + 1, deliveredAt: now }));
    try {
      const result = await this.#send(delivery);
      this.#publish(await deliveries.update(delivery.id, { status: 'done', ...(result === undefined ? {} : { result }), doneAt: this.#deps.clock() }));
      this.#deps.log.info('chat.delivery.done', { delivery: delivery.id, system: delivery.system });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === DISCONNECTED || error instanceof ChatError && error.code === 'unavailable') {
        this.#publish(await deliveries.update(delivery.id, { status: 'queued' }));
        this.#deps.log.info('chat.delivery.requeued', { delivery: delivery.id, system: delivery.system });
        return false;
      }
      const failure: FnError = { class: 'caller', code: 'delivery-failed', message: messageOf(error) };
      this.#publish(await deliveries.update(delivery.id, { status: 'failed', error: failure, doneAt: this.#deps.clock() }));
      this.#deps.log.warn('chat.delivery.failed', { delivery: delivery.id, system: delivery.system, error: failure.message });
      return true;
    }
  }

  /** Call the system: an action with its asker (its result checked against the action's type), or a form. */
  async #send(delivery: DeliveryRecord): Promise<Json | undefined> {
    const timeout = this.#deps.settings.chat.HARNESS_DELIVERY_TIMEOUT;
    const { kind } = delivery;
    if ('form' in kind) {
      await callSystem(this.#deps.link, delivery.system, timeout, (c, signal) => c.peer.call('form', { delivery: delivery.id, run: kind.form, value: kind.value }, { signal }));
      return undefined;
    }
    const asker = await this.#people.asker(delivery.session, delivery.actor);
    const { result } = await callSystem(this.#deps.link, delivery.system, timeout, (c, signal) => c.peer.call('action', {
      ...asker, delivery: delivery.id, action: kind.action, input: kind.input, ...(delivery.run === undefined ? {} : { run: delivery.run }),
    }, { signal }));
    const action = await entryOf(this.#deps.catalog, 'actions', qualify(delivery.system, kind.action));
    if (action !== undefined) { await this.#check(delivery.system, action.decl.returns, result, `The result of ${action.name}`); }
    return result;
  }

  #publish(record: DeliveryRecord): void {
    this.#deps.bus.publish('delivery', { session: record.session, delivery: DeliveryView.parse(record) });
  }
}
