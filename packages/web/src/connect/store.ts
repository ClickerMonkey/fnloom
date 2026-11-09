/**
 * The connect pages: every per-person system the hub offers, with the asker's connections. Loaded once for the nav
 * and again when a page opens; every change answers with the stored connection, which replaces the one held.
 */
import type { ConnectionChange, ConnectionId, ConnectionView, ConnectPage, Json, SystemName } from '@harness/core';
import { computed } from 'vue';
import type { ConnectionsApi } from '../api/connections.ts';
import { Loaded, Task, type Outcome } from '../state/loaded.ts';
import { connectNav } from './logic.ts';

/** What starting a connection came to: go to the provider's sign-in, or the connection made by a form. */
export type ConnectStarted = { readonly url: string } | { readonly connection: ConnectionView };

/** Every connect page, and changing a connection. */
export class ConnectionsStore {
  readonly #api: ConnectionsApi;
  readonly pages = new Loaded<ConnectPage[]>();
  readonly saving = new Task();
  /** The nav entries the pages add. */
  readonly nav = computed(() => connectNav(this.pages.value.value ?? []));

  constructor(api: ConnectionsApi) {
    this.#api = api;
  }

  /** Load the pages; `quiet` keeps the loading state off (a refresh). */
  async load(quiet = false): Promise<void> {
    await this.pages.load(() => this.#api.connectPages.call({}), 'Couldn’t load the connect pages.', quiet);
  }

  /** One system's page, once loaded. */
  page(system: SystemName): ConnectPage | undefined {
    return this.pages.value.value?.find((p) => p.system === system);
  }

  /** Start connecting: an OAuth system answers the sign-in address, a form system the connection made. */
  async connect(system: SystemName, form?: Json): Promise<Outcome<ConnectStarted>> {
    const done = await this.saving.run(() => this.#api.connect.call({ system, ...(form === undefined ? {} : { form }) }), 'Couldn’t start connecting.');
    if (done.ok && 'connection' in done.value) { this.#put(done.value.connection); }
    return done;
  }

  /** Change a connection's settings, fn switches or sharing. */
  async update(change: ConnectionChange): Promise<Outcome<ConnectionView>> {
    const done = await this.saving.run(() => this.#api.updateConnection.call(change), 'Couldn’t save the change.');
    if (done.ok) { this.#put(done.value); }
    return done;
  }

  /** Disconnect: the system forgets the account and the hub deletes the credentials. */
  async disconnect(connection: ConnectionId): Promise<Outcome<boolean>> {
    const done = await this.saving.run(async () => (await this.#api.disconnect.call({ connection })).ok, 'Couldn’t disconnect.');
    if (done.ok) { this.#drop(connection); }
    return done;
  }

  /** Put a stored connection in its page, replacing the one held. */
  #put(connection: ConnectionView): void {
    this.#edit(connection.system, (list) => [connection, ...list.filter((c) => c.id !== connection.id)]);
  }

  #drop(id: ConnectionId): void {
    const page = this.pages.value.value?.find((p) => p.connections.some((c) => c.id === id));
    if (page !== undefined) { this.#edit(page.system, (list) => list.filter((c) => c.id !== id)); }
  }

  #edit(system: SystemName, change: (list: readonly ConnectionView[]) => ConnectionView[]): void {
    const pages = this.pages.value.value;
    if (pages === undefined) { return; }
    this.pages.set(pages.map((p) => (p.system === system ? { ...p, connections: change(p.connections) } : p)));
  }
}
