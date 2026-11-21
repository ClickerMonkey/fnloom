/**
 * The api migration (to-do phase 4): a hub with one `api` instance per service becomes one api instance whose services
 * are `api/Service` records. Each service config becomes a record (found by name and by words, as a save would leave
 * it); a sealed shared token becomes the configuring admin's connection, shared with everyone and bound to the base
 * URL, and the sealed config secret is removed; people's connections are keyed by the service, their credentials
 * bound too; routed api fns lose their routing and act through the service; and every instance but `main` is removed.
 * Running it again changes nothing.
 */
import {
  ActorId, API_SERVICE_TYPE, ConnectKey, InstanceName, mintId, noFnStats, QualifiedName, SystemName, type FnRecord, type InstanceRecord, type Json, type UserConnection,
} from '@harness/core';
import { describe, expect, it } from 'vitest';
import { AesSecretVault, SecretBox } from '../api/secrets.ts';
import { TEST_KEYS } from '../api/testing/rig.ts';
import { allRows } from '../store/rows.ts';
import { memoryLog, testStore } from '../testing.ts';
import { ConfigSecretKeeper } from './config-secrets.ts';
import { migrateApiServices } from './migrate-api.ts';

const ADA = ActorId.parse('act_ada');
const BEN = ActorId.parse('act_ben');
const API = SystemName.parse('api');
const PATHS = ['auth.token', 'auth.values'] as const;

/** An api instance row as the hub kept it before. */
function instance(name: string, pairedAt: number): InstanceRecord {
  return {
    system: API, instance: InstanceName.parse(name), description: '', status: 'disconnected', keyFingerprint: `fp-${name}`, publicKey: `pk-${name}`,
    version: '0.1.0', manifestHash: 'h', pairedAt,
  };
}

/** An api fn as `make_api` saved it before: routed to its service's instance. */
function apiFn(service: string, local: string): FnRecord {
  return {
    name: QualifiedName.parse(`api/${service}.${local}`), system: API, version: 'v1', origin: 'runtime', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0,
    decl: {
      name: `${service}.${local}`, description: local, kind: 'api/request', payload: { service }, args: { name: 'obj', props: {} }, returns: { name: 'any' }, deps: [], handlers: {},
      progress: { type: 'none' }, operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: ['api', service],
      routing: { to: 'instance', instance: InstanceName.parse(service) },
    },
  };
}

async function world() {
  const store = await testStore();
  const vault = new AesSecretVault({ store, box: new SecretBox(TEST_KEYS.secretKey), clock: () => 5 });
  const keeper = new ConfigSecretKeeper(() => vault);
  /** Seal a service config onto its instance, as configuring it did. */
  const configure = async (row: InstanceRecord, value: Json): Promise<InstanceRecord> => {
    const { sealed } = await keeper.seal(row, value, undefined, PATHS, ADA);
    return { ...row, config: { value: sealed, version: 1, setBy: ADA, setAt: 1 } };
  };
  const tracker = await configure(instance('tracker', 2), {
    label: 'Tracker', baseUrl: 'https://tracker.test/v1', auth: { kind: 'bearer', per: 'shared', token: 'shared-token' }, openapi: 'https://tracker.test/openapi.json', timeout: 30_000, maxBody: 4096,
  });
  const board = await configure(instance('board', 3), { label: 'Board', description: 'Cards.', baseUrl: 'https://board.test/api', auth: { kind: 'bearer', per: 'person' }, timeout: 60_000, maxBody: 2_097_152 });
  for (const row of [instance('main', 1), tracker, board]) await store.table('instances').insert(row);
  // Ben's own token to the board, as his connection to that instance kept it
  const secret = await vault.store({ name: 'connection:c', owner: BEN, value: JSON.stringify({ token: 'ben-token' }) });
  const connection: UserConnection = {
    id: mintId('connection'), system: API, instance: InstanceName.parse('board'), owner: BEN, status: 'connected', account: { label: 'Board' }, credentials: secret,
    settings: {}, fns: {}, share: { visibility: 'private', with: [] }, createdAt: 1, updatedAt: 1,
  };
  await store.table('connections').insert(connection);
  await store.table('fns').insert(apiFn('tracker', 'issues'));
  const sealedToken = tracker.config?.value;
  return { store, vault, connection, sealedToken, migrate: () => migrateApiServices({ store, vault: () => vault, log: memoryLog().log, clock: () => 9 }) };
}

describe('migrating per-service api instances to one instance', () => {
  it('makes each service a record, moves its secrets and connections, unroutes its fns and keeps one instance', async () => {
    const { store, vault, connection, sealedToken, migrate } = await world();
    expect(await migrate()).toEqual({ services: 2, connections: 2, fns: 1, removed: 2 });

    // the services, as records found by name in the database and searchable by words, with no secret in them
    const records = await store.recordQueries.find({ type: API_SERVICE_TYPE, filters: [], sort: [{ field: 'name', dir: 'asc' }], offset: 0, limit: 10 });
    expect(records.items.map((record) => record.value)).toEqual([
      { name: 'board', label: 'Board', description: 'Cards.', baseUrl: 'https://board.test/api', allowPrivate: false, auth: { kind: 'bearer', per: 'person' }, timeout: 60_000, maxBody: 2_097_152 },
      { name: 'tracker', label: 'Tracker', baseUrl: 'https://tracker.test/v1', allowPrivate: false, auth: { kind: 'bearer', per: 'shared' }, openapi: 'https://tracker.test/openapi.json', timeout: 30_000, maxBody: 4096 },
    ]);
    expect(records.items.map((record) => [record.title, record.version, record.updatedBy, record.updatedBySystem])).toEqual([['Board', 1, ADA, 'api'], ['Tracker', 1, ADA, 'api']]);
    expect(JSON.stringify(records.items)).not.toContain('shared-token');
    const hits = await store.text.search({ text: 'Tracker', kinds: ['record'], limit: 5, prefix: `${API_SERVICE_TYPE}#` });
    expect(hits[0]?.key).toBe(`${API_SERVICE_TYPE}#${records.items[1]?.id ?? ''}`);

    // the shared token: Ada's connection, shared with everyone and bound to the base URL; the sealed one is gone
    const connections = await allRows(store.table('connections'), { where: { system: API } });
    const shared = connections.find((row) => row.key === ConnectKey.parse('tracker'));
    expect(shared).toMatchObject({ owner: ADA, status: 'connected', share: { visibility: 'public' }, account: { label: 'Tracker', detail: 'Token ending oken' } });
    expect(JSON.parse((await vault.reveal(shared?.credentials ?? 'sec_x')) ?? '')).toEqual({ token: 'shared-token', baseUrl: 'https://tracker.test/v1' });
    const sealed = JSON.stringify(sealedToken).match(/"\$secret":"([^"]+)"/)?.[1] ?? '';
    expect(sealed).not.toBe('');
    expect(await vault.reveal(sealed)).toBeUndefined();

    // Ben's board connection: keyed by the service, no longer by an instance, his token bound to the base URL
    const ben = await store.table('connections').get(connection.id);
    expect(ben).toMatchObject({ key: 'board', owner: BEN });
    expect(ben?.instance).toBeUndefined();
    expect(JSON.parse((await vault.reveal(ben?.credentials ?? 'sec_x')) ?? '')).toEqual({ token: 'ben-token', baseUrl: 'https://board.test/api' });
    expect(await vault.reveal(connection.credentials ?? 'sec_x')).toBeUndefined();

    // the fn runs on the one instance and acts through its service
    const fn = await store.table('fns').get(QualifiedName.parse('api/tracker.issues'));
    expect(fn?.decl.routing).toBeUndefined();
    expect(fn?.decl.connectKey).toBe('tracker');

    // one instance, `main`, with no config; the service instances are removed
    const instances = await allRows(store.table('instances'), { where: { system: API } });
    expect(instances.map((row) => [row.instance, row.status, row.config === undefined]).sort()).toEqual([['board', 'removed', true], ['main', 'disconnected', true], ['tracker', 'removed', true]]);

    // again: nothing left to move
    expect(await migrate()).toEqual({ services: 0, connections: 0, fns: 0, removed: 0 });
    expect((await store.recordQueries.find({ type: API_SERVICE_TYPE, filters: [], sort: [], offset: 0, limit: 10 })).total).toBe(2);
  });

  it('keeps the first paired service instance as the one instance when there is no main, its service a record too', async () => {
    const { store, migrate } = await world();
    await store.table('instances').remove({ system: API, instance: InstanceName.parse('main') });
    expect(await migrate()).toMatchObject({ services: 2, removed: 1 });
    const instances = await allRows(store.table('instances'), { where: { system: API } });
    expect(instances.filter((row) => row.status !== 'removed').map((row) => [row.instance, row.config === undefined])).toEqual([['tracker', true]]);
  });
});
