/**
 * Key-scoped connections (`ConnectDecl.scope: 'key'`, to-do phase 4): a system whose connections are keyed below its
 * one instance, by its own records (the api system's services). The page lists each key with how people connect to it
 * (worked out from the record's auth); connecting names the key, which reaches the system's `connectFinish`; a shared
 * key is connected once, by an admin, for everyone; and the gate finds a fn's connection by its key: fixed (an api fn's
 * service) or read from the call's args (a fn that names the service), never another key's.
 */
import { ActorId, ConnectKey, Json, mintId, noFnStats, QualifiedName, SystemName, type ConnectDecl, type ConnectFinish, type DataRecord, type FnRecord, type SystemRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { AesSecretVault, SecretBox } from '../api/secrets.ts';
import { TEST_KEYS, testManifest } from '../api/testing/rig.ts';
import { linkServer, TestSystem } from '../execution/testing.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { connectionsEnv } from './env.ts';
import { StoreConnectionService } from './service.ts';

const ADA = ActorId.parse('act_ada');
const BEN = ActorId.parse('act_ben');
const API = SystemName.parse('api');
const SERVICE_TYPE = QualifiedName.parse('api/Service');
const DECL: ConnectDecl = {
  title: 'API sign-ins', description: 'Per service.', how: { flow: 'form', form: { name: 'obj', props: { token: { type: { name: 'text' } } } } }, settings: { name: 'obj', props: {} },
  fns: {}, scope: 'key', keys: { type: SERVICE_TYPE }, defaults: { on: true, ask: false },
};

/** A service record of the system's key type. */
function service(name: string, auth: unknown): DataRecord {
  return { id: mintId('record'), type: SERVICE_TYPE, value: Json.parse({ name, label: name.toUpperCase(), baseUrl: `https://${name}.test`, auth }), title: name, version: 1, createdAt: 1, updatedAt: 1 };
}

/** A fn of the system: its connection key fixed, or read from an arg. */
function fn(local: string, connectKey: FnRecord['decl']['connectKey']): { name: QualifiedName; system: string; decl: { tags: string[]; connectKey: typeof connectKey } } {
  return { name: QualifiedName.parse(`api/${local}`), system: 'api', decl: { tags: [], connectKey } };
}

/** The catalog's record of one of the system's fns. */
function fnRecord(name: QualifiedName): FnRecord {
  const local = name.slice('api/'.length);
  return {
    name, system: API, version: 'v1', origin: 'contract', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0,
    decl: {
      name: local, description: local, kind: 'native', args: { name: 'obj', props: {} }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [],
    },
  };
}

async function world() {
  const store = await testStore();
  const catalog = {
    manifest: (name: SystemName) => Promise.resolve(name === API ? testManifest(API, { connect: DECL }) : undefined), check: () => Promise.resolve([]),
    fn: (name: QualifiedName) => Promise.resolve(name.startsWith('api/') ? fnRecord(name) : undefined),
  };
  const row: SystemRecord = { name: API, description: '', status: 'connected', enabled: { functions: true, renderers: true }, version: '1', manifestHash: 'h', actor: ADA };
  await store.table('systems').insert(row);
  await store.table('actors').insert({ id: ADA, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 0, disabled: false });
  await store.table('actors').insert({ id: BEN, kind: 'user', name: 'Ben', about: '', email: 'ben@example.com', role: 'member', createdAt: 0, disabled: false });
  for (const record of [
    service('tracker', { kind: 'bearer', per: 'person' }),
    service('board', { kind: 'bearer', per: 'shared' }),
    service('open', { kind: 'none' }),
    { ...service('broken', 'not an auth'), id: mintId('record') },
  ]) await store.table('records').insert(record);
  const hub = linkServer();
  const system = new TestSystem('api', hub);
  const finishes: ConnectFinish[] = [];
  system.behaviour.connectFinish = (input) => {
    finishes.push(input);
    return 'form' in input.answer ? { account: { label: input.key ?? '?' }, credentials: { form: input.answer.form, key: input.key ?? null } } : { problem: 'form only' };
  };
  const secrets = new AesSecretVault({ store, box: new SecretBox(TEST_KEYS.secretKey), clock: () => 1 });
  const connections = new StoreConnectionService({
    store, catalog, secrets, bus: new RecordingBus(), log: memoryLog().log, clock: () => 1, settings: connectionsEnv.parse(), hubUrl: 'http://hub.test',
    link: { connection: (name) => (name === API ? system.connection(hub) : undefined) },
  });
  return { store, connections, finishes };
}

describe('key-scoped connections', () => {
  it('lists each key the records name, with how people connect to it', async () => {
    const { connections } = await world();
    const [page] = await connections.pages(ADA);
    expect(page?.instances).toBeUndefined();
    // read from the records in the database, by name; a record that is no key is left out
    expect(page?.keys?.map((key) => [key.key, key.label, key.connect.flow?.flow ?? 'none', key.connect.share])).toEqual([
      ['board', 'BOARD', 'form', true],
      ['open', 'OPEN', 'none', false],
      ['tracker', 'TRACKER', 'form', false],
    ]);
  });

  it('connects to a key: the key reaches the system, the connection is keyed, and a shared key is an admin\'s for everyone', async () => {
    const { connections, finishes, store } = await world();
    const mine = await connections.connect(BEN, API, { token: 'ben-token' }, undefined, ConnectKey.parse('tracker'));
    expect(mine).toMatchObject({ connection: { status: 'connected', key: 'tracker', share: { visibility: 'private' } } });
    expect(finishes.at(-1)).toMatchObject({ key: 'tracker', answer: { form: { token: 'ben-token' } } });
    expect(finishes.at(-1)).not.toHaveProperty('instance');
    await expect(connections.connect(BEN, API, { token: 't' }, undefined, ConnectKey.parse('board'))).rejects.toThrow(/an admin connects api\/board once, for everyone/);
    expect(await connections.connect(ADA, API, { token: 'shared' }, undefined, ConnectKey.parse('board'))).toMatchObject({ connection: { key: 'board', share: { visibility: 'public' } } });
    await expect(connections.connect(BEN, API, { token: 't' }, undefined, ConnectKey.parse('open'))).rejects.toThrow(/needs no connection/);
    await expect(connections.connect(BEN, API, { token: 't' }, undefined, ConnectKey.parse('nowhere'))).rejects.toThrow(/has no nowhere/);
    await expect(connections.connect(BEN, API, { token: 't' })).rejects.toThrow(/say which api key/);
    expect((await store.table('connections').find({ where: { key: ConnectKey.parse('tracker') }, limit: 5 })).items).toHaveLength(1);
  });

  it('gates a fn by its key: fixed or from the call\'s args, and never through another key\'s connection', async () => {
    const { connections } = await world();
    const request = fn('tracker.issues', ConnectKey.parse('tracker'));
    const named = fn('test_request', { arg: 'service' });
    // no connection to the key: the fn acts as no one (the system says the key needs one); the records aren't read
    expect((await connections.gate(BEN, new Set())).fn(request)).toBeUndefined();
    await connections.connect(BEN, API, { token: 'ben-token' }, undefined, ConnectKey.parse('tracker'));
    const gate = await connections.gate(BEN, new Set());
    expect(gate.fn(request)).toMatchObject({ state: 'ready', connection: { key: 'tracker', owner: BEN } });
    // the arg names the key: the call's connection is the one to it; without args (a tool list) it is not gated
    expect(gate.fn(named, { service: 'tracker', url: '/' })).toMatchObject({ state: 'ready', connection: { key: 'tracker' } });
    expect(gate.fn(named, { service: 'board', url: '/' })).toBeUndefined();
    // switched off on the person's connection: the fn is off for them
    const own = (await connections.pages(BEN))[0]?.connections.find((row) => row.key === 'tracker');
    await connections.update(BEN, { connection: own?.id ?? mintId('connection'), fns: { 'tracker.issues': { on: false, ask: false } } });
    expect((await connections.gate(BEN, new Set())).fn(request)).toEqual({ state: 'off' });
    expect(gate.fn(named)).toBeUndefined();
    // a key that needs no connection, and a fn with no key, act as no one
    expect(gate.fn(fn('open.cards', ConnectKey.parse('open')))).toBeUndefined();
    expect(gate.fn(fn('services', undefined))).toBeUndefined();
    // an admin's shared connection serves everyone
    await connections.connect(ADA, API, { token: 'shared' }, undefined, ConnectKey.parse('board'));
    expect((await connections.gate(BEN, new Set())).fn(fn('board.cards', ConnectKey.parse('board')))).toMatchObject({ state: 'ready', connection: { owner: ADA, key: 'board' } });
    // Ada has no connection to the tracker of her own: Ben's is private
    expect((await connections.gate(ADA, new Set())).fn(request)).toBeUndefined();
  });

  it('says which key a call can\'t run without, read from its one record, with the connect page\'s link', async () => {
    const { connections } = await world();
    const link = 'http://hub.test/connect/api';
    expect(await connections.unconnected(fn('tracker.issues', ConnectKey.parse('tracker')))).toEqual({ system: API, key: 'tracker', label: 'TRACKER', shared: false, link });
    // a shared key: an admin connects it, for everyone
    expect(await connections.unconnected(fn('board.cards', ConnectKey.parse('board')))).toEqual({ system: API, key: 'board', label: 'BOARD', shared: true, link });
    // the key named by the call's args
    const named = fn('test_request', { arg: 'service' });
    expect(await connections.unconnected(named, { service: 'tracker', url: '/' })).toMatchObject({ key: 'tracker' });
    expect(await connections.unconnected(named)).toBeUndefined();
    // a key with no sign-in, a key with no record (or not a key record), a fn with no key: nothing to connect
    expect(await connections.unconnected(fn('open.cards', ConnectKey.parse('open')))).toBeUndefined();
    expect(await connections.unconnected(fn('gone.cards', ConnectKey.parse('gone')))).toBeUndefined();
    expect(await connections.unconnected(fn('broken.cards', ConnectKey.parse('broken')))).toBeUndefined();
    expect(await connections.unconnected(fn('services', undefined))).toBeUndefined();
    // a fn of a system that isn't key-scoped
    expect(await connections.unconnected({ name: QualifiedName.parse('cal/list'), system: 'cal', decl: { tags: [], connectKey: ConnectKey.parse('tracker') } })).toBeUndefined();
  });

  // security review M9: a service someone's agent added is theirs until an admin shares it, so nobody can put a name
  // on everyone's page and catch the tokens they type; each card shows the host a token goes to
  it('shows a key private to one person only to them, refuses anyone else connecting to it, and shows each key\'s host', async () => {
    const { connections, store } = await world();
    await store.table('records').insert({ ...service('squat', { kind: 'bearer', per: 'person' }), value: Json.parse({ name: 'squat', label: 'SQUAT', baseUrl: 'https://evil.test/v1', auth: { kind: 'bearer', per: 'person' }, privateTo: BEN }) });
    const keysOf = async (asker: ActorId) => ((await connections.pages(asker))[0]?.keys ?? []).map((key) => [key.key, key.host ?? '']);
    expect(await keysOf(ADA)).toEqual([['board', 'board.test'], ['open', 'open.test'], ['tracker', 'tracker.test']]);
    expect(await keysOf(BEN)).toEqual([['board', 'board.test'], ['open', 'open.test'], ['tracker', 'tracker.test'], ['squat', 'evil.test']]);
    // nobody but its person connects to it: their token never reaches its base URL
    await expect(connections.connect(ADA, API, { token: 'ada-token' }, undefined, ConnectKey.parse('squat'))).rejects.toThrow(/has no squat/);
    expect(await connections.connect(BEN, API, { token: 'ben-token' }, undefined, ConnectKey.parse('squat'))).toMatchObject({ connection: { key: 'squat' } });
  });
});
