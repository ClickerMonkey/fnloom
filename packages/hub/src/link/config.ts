/**
 * System config. A value is checked against the config type in the system's manifest; a valid one is versioned,
 * stored on the system's row and pushed to the system (`configure`, with the previous value) if it is connected.
 * A system can't be used without a valid config. A config given before the system sent its contract (at install)
 * waits and is applied once the contract arrives; a config type `{}` satisfies is set to `{}` by itself.
 */
import type { Logger } from '@ayepi/log';
import type { ActorId, ConfigValue, Json, SystemName, SystemRecord } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { ConfigService, LinkService } from './index.ts';
import type { SystemStatusKeeper } from './status.ts';

/** What config needs. */
export interface ConfigOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly clock: () => number;
  readonly catalog: Catalog;
  readonly links: LinkService;
  readonly status: SystemStatusKeeper;
}

/** The config value a row holds, as the link carries it. */
function valueOf(record: SystemRecord | undefined): ConfigValue | undefined {
  return record?.config === undefined ? undefined : { value: record.config.value, version: record.config.version };
}

/** Config kept on system rows. */
export class StoreConfigService implements ConfigService {
  readonly #options: ConfigOptions;
  /** Configs given before the system's contract arrived, applied when it does. */
  readonly #waiting = new Map<SystemName, { value: Json; by: ActorId }>();

  constructor(options: ConfigOptions) {
    this.#options = options;
  }

  async current(system: SystemName): Promise<ConfigValue | undefined> {
    return valueOf(await this.#options.store.table('systems').get(system));
  }

  async set(system: SystemName, value: Json, by: ActorId): Promise<{ version: number } | { problems: string[] }> {
    const { store, catalog, clock } = this.#options;
    const [record, manifest] = await Promise.all([store.table('systems').get(system), catalog.manifest(system)]);
    if (record === undefined) { return { problems: [`no system ${system}`] }; }
    if (manifest === undefined) { return { problems: [`${system} has not sent its contract yet, so its config type is unknown`] }; }
    const problems = await catalog.check(system, manifest.config, value);
    if (problems.length > 0) { return { problems }; }
    // the version is taken from the row inside the status keeper's write, so two sets at once get two versions
    let change: ConfigValue & { previous?: Json } = { value, version: 0 };
    await this.#options.status.sync(system, (current) => {
      const previous = current.config?.value;
      change = { value, version: (current.config?.version ?? 0) + 1, ...(previous === undefined ? {} : { previous }) };
      return { ...current, config: { value, version: change.version, setBy: by, setAt: clock() } };
    });
    this.#options.log.info('config.set', { system, version: change.version, by });
    this.#push(system, change);
    return { version: change.version };
  }

  /** Keep a config for a system whose contract hasn't arrived yet (an installed system's first start). */
  preset(system: SystemName, value: Json, by: ActorId): void {
    this.#waiting.set(system, { value, by });
  }

  /**
   * Once a system's contract is known: apply the config waiting for it, or give a system whose config type accepts
   * `{}` that value, so a system with nothing to configure is usable at once. A waiting config its type refuses is
   * dropped and logged. Returns the config the system has afterwards.
   */
  async applyPending(system: SystemName, by: ActorId): Promise<ConfigValue | undefined> {
    const current = await this.current(system);
    const manifest = await this.#options.catalog.manifest(system);
    if (manifest === undefined) { return current; }
    const waiting = this.#waiting.get(system);
    if (waiting !== undefined) {
      this.#waiting.delete(system);
      const set = await this.set(system, waiting.value, waiting.by);
      if ('version' in set) { return { value: waiting.value, version: set.version }; }
      this.#options.log.warn('config.preset.refused', { system, problems: set.problems });
    }
    if (current !== undefined || (await this.#options.catalog.check(system, manifest.config, {})).length > 0) { return current; }
    const set = await this.set(system, {}, by);
    return 'version' in set ? { value: {}, version: set.version } : undefined;
  }

  /** Tell a connected system its config changed; a system that is away gets it in its next welcome. */
  #push(system: SystemName, change: ConfigValue & { previous?: Json }): void {
    const connection = this.#options.links.connection(system);
    if (connection === undefined) { return; }
    connection.peer.call('configure', change).catch((error: unknown) => {
      this.#options.log.warn('config.push.failed', { system, version: change.version, error: messageOf(error) });
    });
  }
}
