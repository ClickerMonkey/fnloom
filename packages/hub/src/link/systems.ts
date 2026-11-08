/** Switching a system's functions and renderers, removing it (every instance), and importing its contract again. */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import type { ActorId, ImportReport, InstanceRef, SystemEnabled, SystemName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { LinkService, SystemAdmin } from './index.ts';
import type { InstanceKeeper } from './status.ts';

/** What the admin service needs. */
export interface SystemAdminOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly catalog: Catalog;
  readonly links: LinkService;
  readonly instances: InstanceKeeper;
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
    const enabled: SystemEnabled = { functions: change.functions ?? record.enabled.functions, renderers: change.renderers ?? record.enabled.renderers };
    await this.#options.instances.syncSystem(system, { enabled });
    this.#options.log.info('system.enabled', { system, ...enabled, by });
    return enabled;
  }

  async remove(system: SystemName, by: ActorId): Promise<{ fnsUnavailable: number }> {
    const { catalog, instances, log } = this.#options;
    const before = await catalog.fns({ system, available: true });
    for (const instance of await instances.of(system)) { await this.removeInstance(instance, by); }
    await instances.syncSystem(system);
    log.info('system.removed', { system, by, fnsUnavailable: before.length });
    return { fnsUnavailable: before.length };
  }

  /** Mark one instance removed and ask it to stop. Its key no longer proves it; it must pair again. */
  async removeInstance(ref: InstanceRef, by: ActorId): Promise<void> {
    const { links, instances, log, stopTimeout } = this.#options;
    await instances.sync(ref, { status: 'removed' });
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
