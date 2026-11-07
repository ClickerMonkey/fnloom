/**
 * A system's status is worked out, never set by hand: removed stays removed; otherwise it is disconnected without a
 * live connection, needs config without a valid config, and connected with both. `SystemStatusKeeper` is the one
 * place that changes a system's row once it is paired: one change at a time (so none is lost), recomputing the
 * status, announcing a change on the bus and having the catalog recompute what is available.
 */
import type { SystemName, SystemRecord, SystemStatus } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { Serial } from '../catalog/serial.ts';
import type { HubStore } from '../store/index.ts';
import type { LinkService } from './index.ts';

/** The status a system's row and connection add up to. */
export function liveStatus(record: SystemRecord, connected: boolean): SystemStatus {
  if (record.status === 'removed') { return 'removed'; }
  if (!connected) { return 'disconnected'; }
  return record.config === undefined ? 'needs-config' : 'connected';
}

/** Writes system rows and keeps their status, the bus and the catalog in step. */
export class SystemStatusKeeper {
  readonly #store: HubStore;
  readonly #bus: EventBus;
  readonly #catalog: Catalog;
  readonly #links: LinkService;
  readonly #writes = new Serial();

  constructor(options: { store: HubStore; bus: EventBus; catalog: Catalog; links: LinkService }) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#catalog = options.catalog;
    this.#links = options.links;
  }

  /**
   * Change a system's row and recompute its status. `change` is fields to set, or a function from the current row to
   * the new one. Throws when the system is unknown.
   */
  async sync(system: SystemName, change: Partial<SystemRecord> | ((record: SystemRecord) => SystemRecord) = {}): Promise<SystemRecord> {
    const { before, after } = await this.#writes.run(async () => {
      const current = await this.#store.table('systems').get(system);
      if (current === undefined) { throw new Error(`no system ${system}`); }
      const merged: SystemRecord = typeof change === 'function' ? change(current) : { ...current, ...change };
      const status = liveStatus(merged, this.#links.connection(system) !== undefined);
      return { before: current, after: await this.#store.table('systems').put({ ...merged, status }) };
    });
    if (after.status !== before.status) { this.#bus.publish('system.status', { system, status: after.status }); }
    await this.#catalog.refreshAvailability(system);
    return after;
  }
}
