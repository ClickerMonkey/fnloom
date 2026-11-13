/**
 * Build 9: a fleet of remote services added from the browser (MCP servers, API services), each an instance of one
 * bundled system: the list of its instances, adding one (`addInstance`: the hub installs the bundled folder, pairs,
 * configures and starts it), saving one's config (`configureSystem`, kept secrets sent back as `SECRET_KEPT`) and
 * removing one. One class for every such fleet; its pages pass the system.
 */
import type { InstanceName, InstanceRef, InstanceView, JsonObject, SystemName } from '@harness/core';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { ConfigResult } from './system.ts';

/** The callers a fleet uses. */
export type FleetApi = Pick<AdminApi, 'instances' | 'addInstance' | 'configureSystem' | 'removeInstance'>;

/** One fleet's instances, and adding, changing and removing them. */
export class FleetStore {
  readonly #api: FleetApi;
  readonly system: SystemName;
  readonly list = new Loaded<readonly InstanceView[]>();
  readonly adding = new Task();
  readonly saving = new Task();
  readonly removing = new Task();

  constructor(api: FleetApi, system: SystemName) {
    this.#api = api;
    this.system = system;
  }

  /** Read the instances; `quiet` keeps the loading state off (a refresh). */
  async load(quiet = false): Promise<void> {
    await this.list.load(() => this.#api.instances.call({ system: this.system }), "Couldn't load the list.", quiet);
  }

  /** One instance, once listed. */
  find(instance: InstanceName): InstanceView | undefined {
    return this.list.value.value?.find((view) => view.instance === instance);
  }

  /** Add an instance with its config; the list is read again after. */
  async add(instance: InstanceName, config: JsonObject, description?: string): Promise<Outcome<InstanceRef>> {
    const result = await this.adding.run(
      () => this.#api.addInstance.call({ system: this.system, instance, config, ...(description === undefined ? {} : { description }) }),
      `Couldn't add ${instance}.`,
    );
    if (result.ok) { void this.load(true); }
    return result;
  }

  /** Save an instance's config; the hub refuses one that isn't valid for the system's config type, and says why. */
  async configure(instance: InstanceName, config: JsonObject): Promise<ConfigResult> {
    const result = await this.saving.run(() => this.#api.configureSystem.call({ system: this.system, instance, config }), "Couldn't save the settings.");
    if (!result.ok) { return { ok: false, problems: [result.problem] }; }
    if ('problems' in result.value) { return { ok: false, problems: result.value.problems }; }
    void this.load(true);
    return { ok: true, version: result.value.version };
  }

  /** Remove an instance: its fns, config and folders go. */
  async remove(instance: InstanceName): Promise<boolean> {
    const result = await this.removing.run(() => this.#api.removeInstance.call({ system: this.system, instance }), `Couldn't remove ${instance}.`);
    if (result.ok && result.value.ok) { this.list.set((this.list.value.value ?? []).filter((view) => view.instance !== instance)); }
    return result.ok && result.value.ok;
  }
}
