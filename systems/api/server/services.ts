/**
 * The api system's services: its `api/Service` records (core's `ApiService`), kept and searched in the hub's database
 * through `ctx.data`. A service is found by its name (a filter in the database), listed by words (the hub's text
 * search), and added by the authoring agent when the request names a service there is none of yet. Its name never
 * changes once added: api fns and connections name it.
 */
import { ApiService, type ApiServiceName, type RecordId } from '@harness/core';
import type { Data } from '@harness/sdk';
import { api, type ServicesPage } from '../shared/index.ts';

/** The stored type of services, as `ctx.data` takes it. */
const SERVICE = api.types.Service;

/** The services in the hub's database, as one run or the system sees them. */
export class Services {
  readonly #data: Data;

  constructor(data: Data) {
    this.#data = data;
  }

  /** The record of the service with this name (its id, and its value read as an `ApiService`), if there is one. */
  async record(name: ApiServiceName | string): Promise<{ id: RecordId; service: ApiService } | undefined> {
    const { items } = await this.#data.find(SERVICE, { query: { filters: [{ field: 'name', op: 'is', value: name }], limit: 1 } });
    const found = items[0];
    return found === undefined ? undefined : { id: found.id, service: ApiService.parse(found.value) };
  }

  /** The service with this name, if there is one. */
  async get(name: ApiServiceName | string): Promise<ApiService | undefined> {
    return (await this.record(name))?.service;
  }

  /** A page of services, best match first for `text`, else by name. */
  async find(query: { text?: string | undefined; limit?: number | undefined; cursor?: string | undefined }): Promise<ServicesPage> {
    const text = query.text?.trim() ?? '';
    const page = await this.#data.find(SERVICE, {
      ...(text === '' ? {} : { search: text }),
      query: { limit: query.limit ?? 20, ...(text === '' ? { sort: [{ field: 'name', dir: 'asc' }] } : {}), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
    });
    return { items: page.items.map((record) => ApiService.parse(record.value)), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  }

  /** Add a service; refused (`ServiceTaken`) when one has its name already. */
  async add(input: unknown): Promise<{ service: ApiService; id: RecordId }> {
    const service = ApiService.parse(input);
    if (await this.record(service.name) !== undefined) throw new ServiceTaken(service.name);
    const saved = await this.#data.save(SERVICE, service);
    return { service: ApiService.parse(saved.value), id: saved.id };
  }
}

/** There is no service by that name. */
export class NoService extends Error {
  constructor(name: string) {
    super(`There is no API service ${name}: api/services lists them, and make_api adds one from its base URL.`);
    this.name = 'NoService';
  }
}

/** A service by that name is there already. */
export class ServiceTaken extends Error {
  constructor(name: string) {
    super(`There is an API service named ${name} already: use it, or give the new one another name.`);
    this.name = 'ServiceTaken';
  }
}
