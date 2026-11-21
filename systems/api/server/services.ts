/**
 * The api system's services: its `api/Service` records (core's `ApiService`), kept and searched in the hub's database
 * through `ctx.data`. A service is found by its name (a filter in the database), listed by words (the hub's text
 * search), and added by the authoring agent when the request names a service there is none of yet. Its name never
 * changes once added: api fns and connections name it.
 *
 * Who sees one: a service the agent added is its person's own (`privateTo`) until an admin shares it, so nobody can
 * claim a name for everyone and catch the tokens others connect with; admins see every service. Only admins (and this
 * system) change the records (`API_SERVICE_RECORDS.writers`), so only an admin shares one or lets it reach private
 * addresses (`allowPrivate`). An added service's base URL and OpenAPI document must pass the address check.
 */
import { ApiService, type ActorId, type ApiServiceName, type Filter, type RecordId, type UserInfo } from '@harness/core';
import type { Data } from '@harness/sdk';
import type { HostLookup } from '@harness/sdk/server';
import { api, type ServicesPage } from '../shared/index.ts';
import { ServiceGuard } from './guard.ts';

/** The stored type of services, as `ctx.data` takes it. */
const SERVICE = api.types.Service;

/** What the authoring agent gives to add a service: no tunables (their defaults are kept), and nothing only an admin sets. */
export const NewService = ApiService.omit({ timeout: true, maxBody: true, allowPrivate: true, privateTo: true });

/** Who looks at the services: a person, and whether they are an admin (who sees every service). */
export interface Viewer {
  readonly id: ActorId;
  readonly admin: boolean;
}

/** The viewer a run's person is. */
export function viewerOf(user: Pick<UserInfo, 'id' | 'role'>): Viewer {
  return { id: user.id, admin: user.role === 'admin' };
}

/** The services in the hub's database, as one person sees them. */
export class Services {
  readonly #data: Data;
  readonly #viewer: Viewer;
  readonly #lookup: HostLookup;

  constructor(data: Data, viewer: Viewer, lookup: HostLookup) {
    this.#data = data;
    this.#viewer = viewer;
    this.#lookup = lookup;
  }

  /** The record of the service with this name the viewer sees (its id, and its value read as an `ApiService`), if there is one. */
  async record(name: ApiServiceName | string): Promise<{ id: RecordId; service: ApiService } | undefined> {
    const found = await this.#named(name);
    return found === undefined || !this.#sees(found.service) ? undefined : found;
  }

  /** The service with this name the viewer sees, if there is one. */
  async get(name: ApiServiceName | string): Promise<ApiService | undefined> {
    return (await this.record(name))?.service;
  }

  /**
   * A page of the services the viewer sees, best match first for `text`, else by name. Someone who is not an admin
   * gets their own unshared services first (on the first page), then the shared ones; each is a filter in the database.
   */
  async find(query: { text?: string | undefined; limit?: number | undefined; cursor?: string | undefined }): Promise<ServicesPage> {
    const limit = query.limit ?? 20;
    if (this.#viewer.admin) return await this.#page([], query, limit);
    const own = query.cursor === undefined ? (await this.#page([{ field: 'privateTo', op: 'is', value: this.#viewer.id }], query, limit)).items : [];
    const shared = await this.#page([{ field: 'privateTo', op: 'empty' }], query, Math.max(1, limit - own.length));
    return { items: [...own, ...shared.items], ...(shared.cursor === undefined ? {} : { cursor: shared.cursor }) };
  }

  /**
   * Add a service for the viewer alone (an admin shares it), never one that reaches a private address; refused
   * (`ServiceTaken`) when one has its name already, whoever's it is, and (`AddressRefused`) when its base URL or
   * OpenAPI document is a private or local address.
   */
  async add(input: unknown): Promise<{ service: ApiService; id: RecordId }> {
    const service = ApiService.parse({ ...NewService.parse(input), privateTo: this.#viewer.id });
    const guard = new ServiceGuard(this.#lookup, service);
    for (const url of [service.baseUrl, ...(service.openapi === undefined ? [] : [service.openapi])]) await guard.check(new URL(url));
    if (await this.#named(service.name) !== undefined) throw new ServiceTaken(service.name);
    const saved = await this.#data.save(SERVICE, service);
    return { service: ApiService.parse(saved.value), id: saved.id };
  }

  /** Whether the viewer sees a service: a shared one, their own, or any for an admin. */
  #sees(service: ApiService): boolean {
    return this.#viewer.admin || service.privateTo === undefined || service.privateTo === this.#viewer.id;
  }

  /** The service with this name, whoever's it is (a name is taken for everyone). */
  async #named(name: ApiServiceName | string): Promise<{ id: RecordId; service: ApiService } | undefined> {
    const { items } = await this.#data.find(SERVICE, { query: { filters: [{ field: 'name', op: 'is', value: name }], limit: 1 } });
    const found = items[0];
    return found === undefined ? undefined : { id: found.id, service: ApiService.parse(found.value) };
  }

  /** One page of services under these filters, best match first for `text`, else by name. */
  async #page(filters: Filter[], query: { text?: string | undefined; cursor?: string | undefined }, limit: number): Promise<ServicesPage> {
    const text = query.text?.trim() ?? '';
    const page = await this.#data.find(SERVICE, {
      ...(text === '' ? {} : { search: text }),
      query: { filters, limit, ...(text === '' ? { sort: [{ field: 'name', dir: 'asc' }] } : {}), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
    });
    return { items: page.items.map((record) => ApiService.parse(record.value)), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
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
