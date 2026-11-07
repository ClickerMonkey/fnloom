/** Switching a system's functions and renderers, removing it, and importing its contract again. */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import type { ActorId, ImportReport, SystemEnabled, SystemName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { LinkService, SystemAdmin } from './index.ts';
import type { SystemStatusKeeper } from './status.ts';

/** What the admin service needs. */
export interface SystemAdminOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly catalog: Catalog;
  readonly links: LinkService;
  readonly status: SystemStatusKeeper;
  /** How long a removed system gets to stop. */
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
    await this.#options.status.sync(system, { enabled });
    this.#options.log.info('system.enabled', { system, ...enabled, by });
    return enabled;
  }

  async remove(system: SystemName, by: ActorId): Promise<{ fnsUnavailable: number }> {
    const { links, catalog, status, log, stopTimeout } = this.#options;
    const before = await catalog.fns({ system, available: true });
    await status.sync(system, { status: 'removed' });
    const connection = links.connection(system);
    if (connection !== undefined) {
      try {
        await connection.peer.call('stop', { reason: 'removed', timeout: stopTimeout }, { signal: AbortSignal.timeout(stopTimeout) });
      } catch (error) {
        log.warn('system.remove.stop.failed', { system, error: messageOf(error) });
      }
    }
    log.info('system.removed', { system, by, fnsUnavailable: before.length });
    return { fnsUnavailable: before.length };
  }

  async reimport(system: SystemName): Promise<ImportReport> {
    const report = await this.#options.catalog.reimport(system);
    await this.#options.catalog.refreshAvailability(system);
    return report;
  }
}
