/**
 * One instance of a system (a fleet's copy, `fs@laptop`): its record among its system's instances, its config (each
 * instance has its own; saved only when valid), its data export (a zip of its data folder, downloaded through the
 * returned link) and removing it. Its status follows the user channel: a change of its system reads the instances
 * again.
 */
import type { InstanceMode, InstanceName, InstanceView, Json, SystemName, UserEvent } from '@harness/core';
import { computed, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { ConfigResult } from './system.ts';

type InstanceApi = Pick<AdminApi, 'instances' | 'system' | 'configureSystem' | 'removeInstance' | 'exportSystemData'>;

/** An instance's address: its system and its name. */
export interface InstanceKey {
  readonly system: SystemName;
  readonly instance: InstanceName;
}

/** One instance's page. */
export class InstanceStore {
  readonly #api: InstanceApi;
  readonly #events: UserEvents;
  #stop: (() => void) | undefined;
  readonly key = shallowRef<InstanceKey | undefined>(undefined);
  /** Every instance of its system (the page lists the others beside it). */
  readonly instances = new Loaded<readonly InstanceView[]>();
  /**
   * Its system's config type and secret fields, for the config form, and whether the system runs one instance (whose
   * page is the system's own).
   */
  readonly configForm = new Loaded<{ readonly type: Json | undefined; readonly secrets: readonly string[]; readonly instanceMode: InstanceMode }>();
  readonly config = new Task();
  readonly exporting = new Task();
  readonly removing = new Task();
  /** The instance itself, once listed. */
  readonly view = computed(() => this.instances.value.value?.find((i) => i.instance === this.key.value?.instance));

  constructor(api: InstanceApi, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  async open(key: InstanceKey): Promise<void> {
    const same = this.key.value?.system === key.system && this.key.value.instance === key.instance;
    if (!same) { this.close(); }
    this.key.value = key;
    this.#stop ??= this.#events((event) => { this.#onEvent(event); });
    await Promise.all([
      this.#loadInstances(key.system, same),
      this.configForm.load(async () => {
        const system = await this.#api.system.call({ system: key.system });
        return { type: system.configType, secrets: system.configSecrets ?? [], instanceMode: system.instanceMode };
      }, "Couldn't load this system.", same),
    ]);
  }

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.key.value = undefined;
    this.instances.reset();
    this.configForm.reset();
  }

  /** Save this instance's config; the hub refuses one that isn't valid for the system's config type, and says why. */
  async configure(config: Json): Promise<ConfigResult> {
    const key = this.key.value;
    if (key === undefined) { return { ok: false, problems: ['No instance is open.'] }; }
    const result = await this.config.run(() => this.#api.configureSystem.call({ system: key.system, instance: key.instance, config }), "Couldn't save the config.");
    if (!result.ok) { return { ok: false, problems: [result.problem] }; }
    if ('problems' in result.value) { return { ok: false, problems: result.value.problems }; }
    void this.#loadInstances(key.system, true);
    return { ok: true, version: result.value.version };
  }

  /**
   * Zip an instance's data folder (its config's secrets only when asked): this one, or the one named (a single-instance
   * system's `main`, from its system's page). Answers the download link.
   */
  async exportData(withSecrets: boolean, key: InstanceKey | undefined = this.key.value): Promise<Outcome<{ readonly url: string; readonly size: number }>> {
    if (key === undefined) { return { ok: false, problem: 'No instance is open.' }; }
    return this.exporting.run(async () => {
      const made = await this.#api.exportSystemData.call({ ...key, ...(withSecrets ? { withSecrets } : {}) });
      return { url: made.url, size: made.size };
    }, "Couldn't export this instance's data.");
  }

  /** Remove this instance: its key, config and folders go; the system's other instances stay. */
  async remove(): Promise<boolean> {
    const key = this.key.value;
    if (key === undefined) { return false; }
    const result = await this.removing.run(() => this.#api.removeInstance.call(key), `Couldn't remove ${key.system}@${key.instance}.`);
    return result.ok && result.value.ok;
  }

  async #loadInstances(system: SystemName, quiet: boolean): Promise<void> {
    await this.instances.load(() => this.#api.instances.call({ system }), "Couldn't load this system's instances.", quiet);
  }

  #onEvent(event: UserEvent): void {
    const key = this.key.value;
    if (event.type === 'system' && key !== undefined && event.system === key.system) { void this.#loadInstances(key.system, true); }
  }
}
