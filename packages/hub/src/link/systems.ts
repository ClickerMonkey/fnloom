/** Switching a system's functions, renderers and context (whole or per item), removing it (every instance), and importing its contract again. */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { splitName, type ActorId, type ImportReport, type InstanceRef, type SwitchItem, type SystemEnabled, type SystemName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../catalog/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { AutoPairService } from './auto-pair.ts';
import type { LinkService, SystemAdmin } from './index.ts';
import type { InstanceKeeper } from './status.ts';

/** What the admin service needs. */
export interface SystemAdminOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly catalog: Catalog;
  readonly links: LinkService;
  readonly instances: InstanceKeeper;
  /** Its auto-pair secrets are revoked when an instance is removed, so only a new pairing brings it back. */
  readonly autoPairs: AutoPairService;
  /** How long a removed instance gets to stop. */
  readonly stopTimeout: number;
}

/** The admin's switches over systems. */
export class StoreSystemAdmin implements SystemAdmin {
  readonly #options: SystemAdminOptions;

  constructor(options: SystemAdminOptions) {
    this.#options = options;
  }

  async setEnabled(system: SystemName, change: Partial<SystemEnabled>, by: ActorId): Promise<SystemEnabled> {
    const record = await this.#options.store.table('systems').get(system);
    if (record === undefined) { throw refuse(404, 'NO_SYSTEM', `no system ${system}`); }
    const context = change.context ?? record.enabled.context ?? true;
    const enabled: SystemEnabled = { functions: change.functions ?? record.enabled.functions, renderers: change.renderers ?? record.enabled.renderers, context };
    await this.#options.instances.syncSystem(system, { enabled });
    if (context !== (record.enabled.context ?? true)) {
      // each item keeps its own switch (`disabled`); the system's is written beside it, and an installed system's
      // context stays off until it goes live (`SystemLifecycle.goLive` writes the switch then)
      const { store } = this.#options;
      const off = !context || record.stage === 'installed';
      await store.tx(async (tx) => {
        for (const item of await allRows(tx.table('context'), { system })) { await tx.table('context').update(item.name, { systemOff: off }); }
      });
    }
    this.#options.log.info('system.enabled', { system, ...enabled, by });
    return enabled;
  }

  async switchItem(item: SwitchItem, by: ActorId): Promise<{ on: boolean }> {
    const { store, catalog, log } = this.#options;
    if (item.section === 'fns') {
      const fn = await catalog.fn(item.name);
      if (fn === undefined) { throw refuse(404, 'NO_FN', `no fn ${item.name}`); }
      await store.table('fns').update(item.name, { disabled: !item.on });
      // availability follows the switch (`disabled` makes a fn unavailable), for the fn and what depends on it
      await catalog.refreshAvailability(fn.system);
    } else {
      if (await store.table('context').get(item.name) === undefined) { throw refuse(404, 'NO_CONTEXT', `no context ${item.name}`); }
      await store.table('context').update(item.name, { disabled: !item.on });
    }
    log.info('system.item.switched', { section: item.section, name: item.name, system: splitName(item.name).system, on: item.on, by });
    return { on: item.on };
  }

  async remove(system: SystemName, by: ActorId): Promise<{ fnsUnavailable: number }> {
    const { catalog, instances, log } = this.#options;
    const before = await catalog.fns({ system, available: true });
    for (const instance of await instances.of(system)) { await this.removeInstance(instance, by); }
    await instances.syncSystem(system);
    log.info('system.removed', { system, by, fnsUnavailable: before.length });
    return { fnsUnavailable: before.length };
  }

  /** Mark one instance removed, drop the types and fns it owns, and ask it to stop. Its key no longer proves it; it must pair again. */
  async removeInstance(ref: InstanceRef, by: ActorId): Promise<void> {
    const { links, instances, autoPairs, log, stopTimeout } = this.#options;
    await instances.sync(ref, { status: 'removed' });
    await autoPairs.revokeInstance(ref, by);
    // what the instance owned (a database's table types and saved query fns) goes with it
    await this.#options.catalog.forgetInstance(ref.system, ref.instance);
    const connection = links.connection(ref.system, ref.instance);
    if (connection !== undefined) {
      try {
        await connection.peer.call('stop', { reason: 'removed', timeout: stopTimeout }, { signal: AbortSignal.timeout(stopTimeout) });
      } catch (error) {
        log.warn('system.remove.stop.failed', { system: ref.system, instance: ref.instance, error: messageOf(error) });
      }
    }
    log.info('instance.removed', { system: ref.system, instance: ref.instance, by });
  }

  async reimport(system: SystemName): Promise<ImportReport> {
    const report = await this.#options.catalog.reimport(system);
    await this.#options.catalog.refreshAvailability(system);
    return report;
  }
}
