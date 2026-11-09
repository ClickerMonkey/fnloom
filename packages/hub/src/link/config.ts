/**
 * Instance config. A value is checked against the config type in the system's manifest; a valid one is versioned,
 * stored on the instance's row and pushed to the instance (`configure`, with the previous value) if it is connected.
 * An instance can't be used without a valid config. A config given before the system sent its contract (at install)
 * waits and is applied once the contract arrives; a config type `{}` satisfies is set to `{}` by itself. Each instance
 * of a fleet has its own config (each fs machine its own folders).
 */
import type { Logger } from '@ayepi/log';
import { instanceLabel, type ActorId, type ConfigValue, type InstanceName, type InstanceRecord, type InstanceRef, type Json, type SystemName } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { ConfigService, LinkService } from './index.ts';
import type { ConfigSecretKeeper } from './config-secrets.ts';
import type { InstanceKeeper } from './status.ts';

/** What config needs. */
export interface ConfigOptions {
  readonly log: Logger;
  readonly clock: () => number;
  readonly catalog: Catalog;
  readonly bus: EventBus;
  readonly links: LinkService;
  readonly instances: InstanceKeeper;
  /** Seals the config's secret fields (`Manifest.configSecrets`) and reveals them for the system. */
  readonly secrets: ConfigSecretKeeper;
}

/** The config value a row holds, as the link carries it. */
export function configOf(record: Pick<InstanceRecord, 'config'> | undefined): ConfigValue | undefined {
  return record?.config === undefined ? undefined : { value: record.config.value, version: record.config.version };
}

/** Config kept on instance rows. */
export class StoreConfigService implements ConfigService {
  readonly #options: ConfigOptions;
  /** Configs given before the system's contract arrived, applied when it does, by `system@instance`. */
  readonly #waiting = new Map<string, { value: Json; by: ActorId }>();

  constructor(options: ConfigOptions) {
    this.#options = options;
  }

  async current(system: SystemName, instance?: InstanceName): Promise<ConfigValue | undefined> {
    const ref = await this.#ref(system, instance);
    return ref === undefined ? undefined : this.#plain(configOf(await this.#options.instances.get(ref)));
  }

  async set(system: SystemName, value: Json, by: ActorId, instance?: InstanceName): Promise<{ version: number } | { problems: string[] }> {
    const ref = await this.#ref(system, instance);
    if (ref === undefined) { return { problems: [`${system} has no instance${instance === undefined ? '' : ` ${instance}`}`] }; }
    const before = (await this.#options.instances.get(ref))?.config?.value;
    const paths = (await this.#options.catalog.manifest(system))?.configSecrets ?? [];
    const { plain, sealed, release } = await this.#options.secrets.seal(ref, value, before, paths, by);
    const problems = await this.check(system, plain);
    if (problems.length > 0) { return { problems }; }
    const written = await this.#write(ref, { plain, sealed }, by);
    await release();
    return written;
  }

  /** The problems of a value for a system's config type (none when it fits). */
  async check(system: SystemName, value: Json): Promise<string[]> {
    const { catalog } = this.#options;
    const manifest = await catalog.manifest(system);
    if (manifest === undefined) { return [`${system} has not sent its contract yet, so its config type is unknown`]; }
    return catalog.check(system, manifest.config, value);
  }

  /** Keep a config for an instance whose contract hasn't arrived yet (an installed instance's first start). */
  preset(ref: InstanceRef, value: Json, by: ActorId): void {
    this.#waiting.set(instanceLabel(ref), { value, by });
  }

  /**
   * Once a system's contract is known: apply the config waiting for an instance, or give an instance whose config type
   * accepts `{}` that value, so a system with nothing to configure is usable at once. A waiting config its type
   * refuses is dropped and logged. Returns the config the instance has afterwards.
   */
  async applyPending(ref: InstanceRef, by: ActorId): Promise<ConfigValue | undefined> {
    const current = await this.current(ref.system, ref.instance);
    if (await this.#options.catalog.manifest(ref.system) === undefined) { return current; }
    const key = instanceLabel(ref);
    const waiting = this.#waiting.get(key);
    if (waiting !== undefined) {
      this.#waiting.delete(key);
      const set = await this.set(ref.system, waiting.value, waiting.by, ref.instance);
      if ('version' in set) { return this.current(ref.system, ref.instance); }
      this.#options.log.warn('config.preset.refused', { system: ref.system, instance: ref.instance, problems: set.problems });
    }
    if (current !== undefined || (await this.check(ref.system, {})).length > 0) { return current; }
    const set = await this.set(ref.system, {}, by, ref.instance);
    return 'version' in set ? { value: {}, version: set.version } : undefined;
  }

  /** The instance a call names, or the system's default. */
  async #ref(system: SystemName, instance: InstanceName | undefined): Promise<InstanceRef | undefined> {
    const name = instance ?? await this.#options.instances.defaultOf(system);
    return name === undefined ? undefined : { system, instance: name };
  }

  /** A stored config with its secrets revealed, as the system is sent it. */
  async #plain(config: ConfigValue | undefined): Promise<ConfigValue | undefined> {
    return config === undefined ? undefined : { value: await this.#options.secrets.unseal(config.value), version: config.version };
  }

  /**
   * Store a checked value, sealed, as the next version (taken inside the keeper's write, so two sets get two
   * versions), and send the system the plain value with the plain previous one.
   */
  async #write(ref: InstanceRef, value: { plain: Json; sealed: Json }, by: ActorId): Promise<{ version: number }> {
    let version = 0;
    let previous: Json | undefined;
    await this.#options.instances.sync(ref, (current) => {
      previous = current.config?.value;
      version = (current.config?.version ?? 0) + 1;
      return { ...current, config: { value: value.sealed, version, setBy: by, setAt: this.#options.clock() } };
    });
    this.#options.log.info('config.set', { system: ref.system, instance: ref.instance, version, by });
    const plainBefore = previous === undefined ? undefined : await this.#options.secrets.unseal(previous);
    this.#push(ref, { value: value.plain, version, ...(plainBefore === undefined ? {} : { previous: plainBefore }) });
    return { version };
  }

  /**
   * Tell a connected instance its config changed; one that is away gets it in its next welcome. Once it has applied
   * it, `system.configured` says so (what it serves, such as its roots, may follow from the config).
   */
  #push(ref: InstanceRef, change: ConfigValue & { previous?: Json }): void {
    const connection = this.#options.links.connection(ref.system, ref.instance);
    if (connection === undefined) { return; }
    connection.peer.call('configure', change).then(() => {
      this.#options.bus.publish('system.configured', { system: ref.system, version: change.version });
    }, (error: unknown) => {
      this.#options.log.warn('config.push.failed', { system: ref.system, instance: ref.instance, version: change.version, error: messageOf(error) });
    });
  }
}
