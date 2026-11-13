/**
 * Build 9: the API services pages' state. The list is the `api` system's instances (`FleetStore`); one service's page
 * adds the api fns that run on it (made in the chat with `api/make_api`, routed to the service).
 */
import type { FnRecord, InstanceName } from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import { API } from '../logic/api-services.ts';
import { instanceFns } from '../logic/instances.ts';
import { FleetStore, type FleetApi } from './fleet.ts';

type ServicesApi = FleetApi & Pick<AdminApi, 'systemFns'>;

/** The API services and the open service's fns. */
export class ApiServicesStore {
  readonly #api: ServicesApi;
  readonly fleet: FleetStore;
  readonly open = shallowRef<InstanceName | undefined>(undefined);
  readonly fns = new Loaded<readonly FnRecord[]>();

  constructor(api: ServicesApi) {
    this.#api = api;
    this.fleet = new FleetStore(api, API);
  }

  /** Open one service's page (again, quietly, when it is the one open). */
  async show(instance: InstanceName): Promise<void> {
    const same = this.open.value === instance;
    if (!same) { this.close(); }
    this.open.value = instance;
    await Promise.all([
      this.fleet.load(this.fleet.list.value.value !== undefined),
      this.fns.load(async () => instanceFns(await this.#api.systemFns.call({ system: API }), instance), "Couldn't load its fns.", same),
    ]);
  }

  close(): void {
    this.open.value = undefined;
    this.fns.reset();
  }
}
