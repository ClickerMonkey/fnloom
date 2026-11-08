/**
 * Statuses are worked out, never set by hand. An instance: removed stays removed; otherwise it is disconnected
 * without a live connection, needs config without a valid config, and connected with both. A system: connected when
 * one of its instances is, else needs config when one does, else disconnected; removed when every instance is
 * (or it has none left). `InstanceKeeper` is the one place that writes instance rows and the system rows' derived
 * facts: one change at a time (so none is lost), recomputing both statuses, announcing a system's change on the bus
 * and having the catalog recompute what is available.
 */
import {
  MAIN_INSTANCE, instanceLabel, type InstanceName, type InstanceRecord, type InstanceRef, type SystemName, type SystemRecord, type SystemStatus,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../catalog/rows.ts';
import { Serial } from '../catalog/serial.ts';
import type { HubStore } from '../store/index.ts';
import type { LinkService } from './index.ts';

/** The status an instance's row and connection add up to. */
export function liveStatus(record: Pick<InstanceRecord, 'status' | 'config'>, connected: boolean): SystemStatus {
  if (record.status === 'removed') { return 'removed'; }
  if (!connected) { return 'disconnected'; }
  return record.config === undefined ? 'needs-config' : 'connected';
}

/** The order a system's status is picked from its instances' statuses: the first one any instance has wins. */
const SYSTEM_STATUS_ORDER = ['connected', 'needs-config', 'pairing', 'disconnected'] as const satisfies readonly SystemStatus[];

/** A system's status from its instances' statuses. */
export function systemStatus(instances: readonly SystemStatus[]): SystemStatus {
  return SYSTEM_STATUS_ORDER.find((status) => instances.includes(status)) ?? 'removed';
}

/** The instance a system's calls go to when nothing else picks: its default, else `main`, else the first paired. */
export function defaultInstanceOf(system: Pick<SystemRecord, 'defaultInstance'>, instances: readonly Pick<InstanceRecord, 'instance' | 'status' | 'pairedAt'>[]): InstanceName | undefined {
  const live = instances.filter((i) => i.status !== 'removed');
  const named = (name: InstanceName | undefined) => (name === undefined ? undefined : live.find((i) => i.instance === name)?.instance);
  return named(system.defaultInstance) ?? named(MAIN_INSTANCE) ?? [...live].sort((a, b) => (a.pairedAt ?? 0) - (b.pairedAt ?? 0))[0]?.instance;
}

/** A system row as written, and its status before. */
interface SystemChange {
  readonly record: SystemRecord;
  readonly before: SystemStatus;
}

/** A change to an instance row: fields to set, or a function from the current row to the new one. */
export type InstanceChange = Partial<InstanceRecord> | ((record: InstanceRecord) => InstanceRecord);

/** Writes instance rows and keeps statuses, the system rows, the bus and the catalog in step. */
export class InstanceKeeper {
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

  /** One instance's row. */
  get(ref: InstanceRef): Promise<InstanceRecord | undefined> {
    return this.#store.table('instances').get(ref);
  }

  /** Every instance of a system (removed ones too), by name. */
  async of(system: SystemName): Promise<InstanceRecord[]> {
    return (await allRows(this.#store.table('instances'), { system })).sort((a, b) => a.instance.localeCompare(b.instance));
  }

  /** The instance a system's calls go to when nothing else picks one (see `defaultInstanceOf`). */
  async defaultOf(system: SystemName): Promise<InstanceName | undefined> {
    const record = await this.#store.table('systems').get(system);
    return record === undefined ? undefined : defaultInstanceOf(record, await this.of(system));
  }

  /**
   * Write an instance's row (or make it, with `create` for a new one) and recompute its status and its system's.
   * Throws when the instance is unknown and there is nothing to create it from.
   */
  async sync(ref: InstanceRef, change: InstanceChange = {}, create?: InstanceRecord): Promise<InstanceRecord> {
    const result = await this.#writes.run(async () => {
      const current = await this.get(ref) ?? create;
      if (current === undefined) { throw new Error(`no instance ${instanceLabel(ref)}`); }
      const merged: InstanceRecord = typeof change === 'function' ? change(current) : { ...current, ...change };
      const status = liveStatus(merged, this.#links.connection(ref.system, ref.instance) !== undefined);
      const saved = await this.#store.table('instances').put({ ...merged, status });
      return { saved, system: await this.#syncSystem(ref.system) };
    });
    if (result.system !== undefined) { await this.#announced(result.system); }
    return result.saved;
  }

  /**
   * Change a system's own row (its switches, its default instance) and recompute its status. Throws when the system
   * is unknown.
   */
  async syncSystem(system: SystemName, change: Partial<Pick<SystemRecord, 'enabled' | 'defaultInstance' | 'description' | 'version' | 'manifestHash'>> = {}): Promise<SystemRecord> {
    const result = await this.#writes.run(async () => {
      const changed = await this.#syncSystem(system, change);
      if (changed === undefined) { throw new Error(`no system ${system}`); }
      return changed;
    });
    await this.#announced(result);
    return result.record;
  }

  /** Write a system's row with `change` and the status its instances add up to. Runs inside a write. */
  async #syncSystem(system: SystemName, change: Partial<SystemRecord> = {}): Promise<SystemChange | undefined> {
    const current = await this.#store.table('systems').get(system);
    if (current === undefined) { return undefined; }
    const status = systemStatus((await this.of(system)).map((i) => i.status));
    const record = await this.#store.table('systems').put({ ...current, ...change, status });
    return { record, before: current.status };
  }

  async #announced(change: SystemChange): Promise<void> {
    const { record, before } = change;
    if (record.status !== before) { this.#bus.publish('system.status', { system: record.name, status: record.status }); }
    await this.#catalog.refreshAvailability(record.name);
  }
}
