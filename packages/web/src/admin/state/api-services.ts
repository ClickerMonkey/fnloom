/**
 * The API services pages' state: the `api/Service` records of the one `api` instance (the data system's records, found
 * by words in the hub's database), the open service and its api fns (made in the chat with `api/make_api`, found by
 * name in the database), and adding, changing and removing a service as a record.
 */
import { Json, type ApiService, type ConnectKey, type DataRecord, type FnRecord, type RecordId } from '@harness/core';
import { shallowRef } from 'vue';
import type { DataApi } from '../../data/api.ts';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import { Problem } from '../../state/problems.ts';
import type { AdminApi } from '../api.ts';
import { readApiService, SERVICE_TYPE, serviceFnsQuery, serviceQuery, servicesQuery } from '../logic/api-services.ts';

/** What the pages call: the services as records, and the fns catalogue. */
export type ServicesApi = Pick<AdminApi, 'fns'> & Pick<DataApi, 'records' | 'saveRecord' | 'removeRecord'>;

/** A service as its record: the id and version to change it by, and the service. */
export interface ServiceRow {
  readonly id: RecordId;
  readonly version: number;
  readonly service: ApiService;
}

/** A record as a service row; undefined when its value isn't a service. */
function rowOf(record: DataRecord): ServiceRow | undefined {
  const service = readApiService(record.value);
  return service === undefined ? undefined : { id: record.id, version: record.version, service };
}

/** The API services and the open one with its fns. */
export class ApiServicesStore {
  readonly #api: ServicesApi;
  readonly list = new Loaded<readonly ServiceRow[]>();
  /** The words the list was last searched by. */
  readonly #text = shallowRef('');
  readonly open = shallowRef<ConnectKey | undefined>(undefined);
  readonly service = new Loaded<ServiceRow | undefined>();
  readonly fns = new Loaded<readonly FnRecord[]>();
  readonly saving = new Task();
  readonly removing = new Task();

  constructor(api: ServicesApi) {
    this.#api = api;
  }

  /** The services, by words of their label, name, description or base URL (all of them for no words). */
  async load(text = this.#text.value, quiet = false): Promise<void> {
    this.#text.value = text;
    await this.list.load(async () => (await this.#api.records.call(servicesQuery(text))).items.flatMap((record) => rowOf(record) ?? []), 'Couldn’t load the API services.', quiet);
  }

  /** Open one service's page (again, quietly, when it is the one open): its record and its fns. */
  async show(name: ConnectKey): Promise<void> {
    const same = this.open.value === name;
    if (!same) { this.close(); }
    this.open.value = name;
    await Promise.all([
      this.service.load(async () => {
        const [record] = (await this.#api.records.call(serviceQuery(name))).items;
        return record === undefined ? undefined : rowOf(record);
      }, 'Couldn’t load the service.', same),
      this.fns.load(async () => (await this.#api.fns.call(serviceFnsQuery(name))).items, 'Couldn’t load its fns.', same),
    ]);
  }

  close(): void {
    this.open.value = undefined;
    this.service.reset();
    this.fns.reset();
  }

  /**
   * Add a service (`row` absent) or change one; a change names the version it read, so a change made meanwhile is not
   * lost. A new service's name must be free.
   */
  async save(service: ApiService, row?: ServiceRow): Promise<Outcome<ServiceRow>> {
    return this.saving.run(async () => {
      if (row === undefined && (await this.#api.records.call(serviceQuery(service.name))).items.length > 0) {
        throw new Problem(`There is a service named ${service.name} already: give the new one another name.`);
      }
      const saved = rowOf(await this.#api.saveRecord.call({ type: SERVICE_TYPE, value: Json.parse(service), ...(row === undefined ? {} : { id: row.id, expect: row.version }) }));
      if (saved === undefined) { throw new Problem('The hub kept something that is not a service.'); }
      if (this.open.value === saved.service.name) { this.service.set(saved); }
      void this.load(this.#text.value, true);
      return saved;
    }, 'Couldn’t save the service.');
  }

  /** Remove a service: its fns stop working, and its connections stay until people remove them. */
  async remove(row: ServiceRow): Promise<boolean> {
    const done = await this.removing.run(async () => (await this.#api.removeRecord.call({ type: SERVICE_TYPE, id: row.id })).removed, 'Couldn’t remove the service.');
    if (done.ok) { void this.load(this.#text.value, true); }
    return done.ok && done.value;
  }
}
