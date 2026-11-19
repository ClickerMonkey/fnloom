/**
 * Moving the api system from one instance per service to one instance whose services are records (to-do phase 4).
 * Before, each API service was its own `api` instance: its config an `ApiServiceConfig` (a shared token sealed in it),
 * its people's connections keyed by the instance, and its fns routed to it. Now the one `api` instance authors fns
 * like `code`, each service is an `api/Service` record (core's `ApiService`) and connections are keyed by the service.
 *
 * For each `api` instance that still holds a service config, once per start and before systems connect:
 *
 * - its service becomes an `api/Service` record named after the instance (indexed as a save would), unless one is;
 * - a shared token or header values become one admin's connection shared with everyone (the one who set the config),
 *   bound to the service's base URL; the sealed config secrets are removed;
 * - its people's connections are keyed by the service and their credentials bound to its base URL;
 * - its api fns lose their routing (they run on the one instance) and act through the service (`connectKey`);
 * - the instance's config and connect card are cleared, and every instance but one (`main` when there is one) is
 *   removed, so the system runs one instance.
 *
 * An instance with no service config left is already moved, so running it again changes nothing.
 */
import type { Logger } from '@ayepi/log';
import {
  API_SERVICE_RECORDS, API_SERVICE_TYPE, API_SYSTEM, ApiService, ApiServiceConfig, ConnectKey, DataRecord, Json, MAIN_INSTANCE, mintId, RemoteCredentials,
  recordVersionId, SystemName, type ActorId, type IdRandom, type InstanceRecord, type UserConnection,
} from '@harness/core';
import { accountLabel } from '@harness/sdk';
import { indexKey, searchText } from '../data/service.ts';
import { allRows } from '../store/rows.ts';
import type { HubStore } from '../store/index.ts';
import { ConfigSecretKeeper, type ConfigVault } from './config-secrets.ts';

/** What the migration uses. */
export interface ApiMigrationDeps {
  readonly store: HubStore;
  /** The hub's secrets, looked up when a service has one to move. */
  readonly vault: () => ConfigVault;
  readonly log: Logger;
  readonly clock: () => number;
  readonly random?: IdRandom;
}

/** What one run moved. */
export interface ApiMigration {
  /** The services made records. */
  readonly services: number;
  /** The connections keyed by service (shared ones made from config secrets among them). */
  readonly connections: number;
  /** The api fns routed to an instance before. */
  readonly fns: number;
  /** The instances removed. */
  readonly removed: number;
}

const API = SystemName.parse(API_SYSTEM);

/** The instance kept as the one api instance: `main`, else the first paired. */
function keptInstance(rows: readonly InstanceRecord[]): InstanceRecord | undefined {
  const live = rows.filter((row) => row.status !== 'removed');
  return live.find((row) => row.instance === MAIN_INSTANCE) ?? [...live].sort((a, b) => (a.pairedAt ?? 0) - (b.pairedAt ?? 0))[0];
}

/** A config's shared credentials (a shared token or shared header values), if it has them. */
function sharedCredentials(config: ApiServiceConfig): RemoteCredentials | undefined {
  const auth = config.auth;
  if (auth.kind === 'bearer' && auth.per === 'shared' && auth.token !== undefined && auth.token !== '') return { token: auth.token };
  if (auth.kind === 'headers' && auth.per === 'shared' && auth.values !== undefined && Object.keys(auth.values).length > 0) return { headers: { ...auth.values } };
  return undefined;
}

/** A legacy config as the service record it becomes (no secret in it). */
function serviceOf(name: ConnectKey, config: ApiServiceConfig): ApiService {
  const auth = config.auth.kind === 'none' ? { kind: 'none' as const }
    : config.auth.kind === 'bearer' ? { kind: 'bearer' as const, per: config.auth.per }
      : { kind: 'headers' as const, per: config.auth.per, names: config.auth.names };
  return ApiService.parse({
    name, label: config.label, baseUrl: config.baseUrl, auth, timeout: config.timeout, maxBody: config.maxBody,
    ...(config.description === undefined ? {} : { description: config.description }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.openapi === undefined ? {} : { openapi: config.openapi }),
  });
}

/** Turn every per-service `api` instance into a service record of the one instance. */
export async function migrateApiServices(deps: ApiMigrationDeps): Promise<ApiMigration> {
  const { store, vault, log } = deps;
  const keeper = new ConfigSecretKeeper(vault);
  const rows = await allRows(store.table('instances'), { where: { system: API } });
  const kept = keptInstance(rows);
  const moved = { services: 0, connections: 0, fns: 0, removed: 0 };
  /** Each moved instance's service, for its routed fns (moved in one pass below). */
  const services = new Map<string, ConnectKey>();
  for (const row of rows) {
    if (row.status === 'removed') continue;
    const plain = row.config === undefined ? undefined : await keeper.unseal(row.config.value);
    const config = ApiServiceConfig.safeParse(plain);
    const name = ConnectKey.safeParse(row.instance);
    if (config.success && name.success && row.config !== undefined) {
      const service = serviceOf(name.data, config.data);
      const by = row.config.setBy;
      if (await serviceRecord(store, service.name) === undefined) {
        await addRecord(deps, service, by);
        moved.services += 1;
      }
      const shared = sharedCredentials(config.data);
      if (shared !== undefined) {
        await addSharedConnection(deps, service, shared, by);
        moved.connections += 1;
      }
      moved.connections += await keyConnections(deps, row, service);
      services.set(row.instance, service.name);
    }
    const removing = row.instance !== kept?.instance;
    // the instance kept with nothing to clear is already moved: left as it is
    if (!removing && row.config === undefined && row.connect === undefined) continue;
    // the sealed secrets go with the config (sealing an empty one with no secret paths releases them all); the one
    // instance kept has no config, the rest are removed
    if (row.config !== undefined) await (await keeper.seal(row, {}, row.config.value, [], row.config.setBy)).release();
    const { config: _config, connect: _connect, ...rest } = row;
    await store.table('instances').put({ ...rest, ...(removing ? { status: 'removed' as const } : {}) });
    if (removing) moved.removed += 1;
  }
  moved.fns = await unrouteFns(store, services);
  if (moved.services + moved.connections + moved.fns + moved.removed > 0) log.info('link.api.migrated', { ...moved });
  return moved;
}

/** The record of the service by this name, if there is one. */
async function serviceRecord(store: HubStore, name: ConnectKey): Promise<DataRecord | undefined> {
  const found = await store.recordQueries.find({ type: API_SERVICE_TYPE, filters: [{ field: 'name', op: 'is', value: name }], sort: [], offset: 0, limit: 1 });
  return found.items[0];
}

/** Add the service record, its first version and its search text, as a save of it would. */
async function addRecord(deps: ApiMigrationDeps, service: ApiService, by: ActorId): Promise<void> {
  const now = deps.clock();
  const value = Json.parse(service);
  const record = DataRecord.parse({
    id: mintId('record', deps.random), type: API_SERVICE_TYPE, value, title: service.label, version: 1, createdAt: now, updatedAt: now, updatedBy: by, updatedBySystem: API,
  });
  await deps.store.tx(async (tx) => {
    await tx.table('records').put(record);
    await tx.table('recordVersions').put({ id: recordVersionId(record.id, 1), record: record.id, type: record.type, number: 1, change: 'created', value, at: now, by, bySystem: API });
  });
  await deps.store.text.upsert([{ kind: 'record', key: indexKey(record), text: searchText(value, API_SERVICE_RECORDS, record.title) }]);
}

/** Credentials as the api system keeps them: bound to the base URL they were given for. */
function bound(credentials: RemoteCredentials, service: ApiService): string {
  return JSON.stringify({ ...credentials, baseUrl: service.baseUrl });
}

/** The service's shared token or headers as the admin's connection, shared with everyone (unless there is one). */
async function addSharedConnection(deps: ApiMigrationDeps, service: ApiService, credentials: RemoteCredentials, owner: ActorId): Promise<void> {
  const table = deps.store.table('connections');
  const existing = await allRows(table, { where: { system: API, owner } });
  if (existing.some((row) => row.key === service.name && row.share.visibility === 'public')) return;
  const now = deps.clock();
  const id = mintId('connection', deps.random);
  const secret = await deps.vault().store({ name: `connection:${id}`, owner, value: bound(credentials, service) });
  const row: UserConnection = {
    id, system: API, key: service.name, owner, status: 'connected', account: { label: service.label, detail: accountLabel(credentials) }, credentials: secret,
    settings: {}, fns: {}, share: { visibility: 'public', with: [] }, createdAt: now, updatedAt: now,
  };
  await table.insert(row);
}

/** The instance's connections keyed by its service, their credentials bound to its base URL. How many moved. */
async function keyConnections(deps: ApiMigrationDeps, row: InstanceRecord, service: ApiService): Promise<number> {
  const table = deps.store.table('connections');
  let moved = 0;
  for (const connection of await allRows(table, { where: { system: API, instance: row.instance } })) {
    const { instance: _instance, ...rest } = connection;
    let credentials = connection.credentials;
    const text = credentials === undefined ? undefined : await deps.vault().reveal(credentials);
    const parsed = text === undefined ? undefined : RemoteCredentials.safeParse(parseJson(text));
    const read = parsed?.success === true ? parsed.data : undefined;
    if (credentials !== undefined && read !== undefined) {
      const next = await deps.vault().store({ name: `connection:${connection.id}`, owner: connection.owner, value: bound(read, service) });
      await deps.vault().remove(credentials);
      credentials = next;
    }
    await table.put({ ...rest, key: service.name, ...(credentials === undefined ? {} : { credentials }), updatedAt: deps.clock() });
    moved += 1;
  }
  return moved;
}

/** The api fns routed to a moved instance: no routing (the one instance runs them), acting through its service. */
async function unrouteFns(store: HubStore, services: ReadonlyMap<string, ConnectKey>): Promise<number> {
  if (services.size === 0) return 0;
  const table = store.table('fns');
  let moved = 0;
  for (const fn of await allRows(table, { where: { system: API } })) {
    const routing = fn.decl.routing;
    const service = routing?.to === 'instance' ? services.get(routing.instance) : undefined;
    if (service === undefined) continue;
    const { routing: _routing, ...decl } = fn.decl;
    await table.put({ ...fn, decl: { ...decl, connectKey: service } });
    moved += 1;
  }
  return moved;
}

/** JSON text's value, or undefined when it isn't JSON. */
function parseJson(text: string): Json | undefined {
  try {
    const parsed = Json.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
