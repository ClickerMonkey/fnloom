import { ActorId, ConnectionId, InstanceName, noFnStats, QualifiedName, SystemName, type ConnectDecl, type FnRecord, type SystemRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { AesSecretVault, SecretBox } from '../api/secrets.ts';
import { TEST_KEYS, testManifest } from '../api/testing/rig.ts';
import { linkServer, TestSystem } from '../execution/testing.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { connectionsEnv } from './env.ts';
import type { ConnectStart } from './index.ts';
import { StoreConnectionService } from './service.ts';

const ADA = ActorId.parse('act_ada');
const BEN = ActorId.parse('act_ben');
const CAL = SystemName.parse('cal');
const LINEAR = InstanceName.parse('linear');
const DECL: ConnectDecl = {
  title: 'Calendar', description: 'Your calendar.', how: { flow: 'oauth' }, settings: { name: 'object', props: {} },
  fns: { list_events: { on: true, ask: false }, delete_event: { on: false, ask: true } },
};


async function world(decl: ConnectDecl = DECL, fns: ReadonlyMap<QualifiedName, FnRecord> = new Map()) {
  const store = await testStore();
  const catalog = {
    manifest: (name: SystemName) => Promise.resolve(name === CAL ? testManifest(CAL, { connect: decl }) : undefined), check: () => Promise.resolve([]),
    fn: (name: QualifiedName) => Promise.resolve(fns.get(name)),
  };
  const row: SystemRecord = { name: CAL, description: '', status: 'connected', enabled: { functions: true, renderers: true }, version: '1', manifestHash: 'h', actor: ADA };
  await store.table('systems').insert(row);
  const hub = linkServer();
  const system = new TestSystem('cal', hub);
  const now = { at: 1_000 };
  const secrets = new AesSecretVault({ store, box: new SecretBox(TEST_KEYS.secretKey), clock: () => now.at });
  const service = new StoreConnectionService({
    store, catalog, secrets, bus: new RecordingBus(), log: memoryLog().log, clock: () => now.at, settings: connectionsEnv.parse(), hubUrl: 'http://hub.test',
    link: { connection: (name, instance) => (name === CAL && (instance === undefined || instance === LINEAR) ? system.connection(hub) : undefined) },
  });
  return { store, catalog, system, service, secrets, now };
}

/** The state the hub put in the provider URL. */
const stateOf = (url: string): string => new URL(url).searchParams.get('state') ?? '';

/** The cookies of the browser that started a sign-in: its binding. */
const browserOf = (started: ConnectStart): Record<string, string> => ('binding' in started ? { [started.binding.cookie]: started.binding.value } : {});

describe('per-person connections', () => {
  it('connects through the provider redirect, keeps the credentials as the person\'s secret and lists the page', async () => {
    const { service, store, secrets } = await world();
    const started = await service.connect(ADA, CAL);
    if (!('url' in started)) throw new Error('expected a URL');
    const answer = await service.callback({ state: stateOf(started.url), code: 'c0de' }, browserOf(started));
    expect(answer).toEqual({ system: CAL, problem: undefined, clear: `harness_connect_${(await store.table('connections').find({ limit: 1 })).items[0]?.id ?? ''}` });
    if (!('binding' in started)) throw new Error('expected a binding');
    expect(started.binding).toMatchObject({ maxAge: connectionsEnv.parse().HARNESS_CONNECT_WINDOW / 1000, secure: false });
    const [page] = await service.pages(ADA);
    expect(page).toMatchObject({ system: CAL, ready: true, connections: [{ status: 'connected', account: { label: 'ada@example.com' } }] });
    expect(page?.connections[0]).not.toHaveProperty('credentials');
    const row = (await store.table('connections').find({ where: { owner: ADA }, limit: 1 })).items[0];
    expect(row?.credentials).toBeDefined();
    expect(JSON.parse((await secrets.reveal(row?.credentials ?? 'sec_x')) ?? '')).toEqual({ access: 'a1', refresh: 'r1' });
    expect(await service.pages(BEN)).toEqual([{ system: CAL, decl: DECL, ready: true, connections: [] }]);
    // the state works once
    expect((await service.callback({ state: stateOf(started.url), code: 'again' }, browserOf(started))).problem).toMatch(/expired or was already used/);
  });

  it('connects through a form the system checks, with no redirect', async () => {
    const { service, system, store } = await world({ ...DECL, how: { flow: 'form', form: { name: 'object', props: { key: { type: { name: 'text' } } } } } });
    const seen: unknown[] = [];
    system.behaviour.connectFinish = (input) => {
      seen.push(input.answer);
      return 'form' in input.answer && JSON.stringify(input.answer.form) === '{"key":"good"}'
        ? { account: { label: 'ada@service' }, credentials: { key: 'good' } }
        : { problem: 'That key was refused.' };
    };
    const made = await service.connect(ADA, CAL, { key: 'good' });
    expect(made).toMatchObject({ connection: { status: 'connected', account: { label: 'ada@service' } } });
    expect(seen).toEqual([{ form: { key: 'good' } }]);
    expect((await store.table('connections').find({ where: { owner: ADA }, limit: 5 })).items).toHaveLength(1);
    await expect(service.connect(BEN, CAL, { key: 'bad' })).resolves.toMatchObject({ connection: { status: 'failed', problem: 'That key was refused.' } });
  });

  it('refuses a forged or expired state', async () => {
    const { service, now } = await world();
    const started = await service.connect(ADA, CAL);
    if (!('url' in started)) throw new Error('expected a URL');
    expect((await service.callback({ state: `${stateOf(started.url)}x`, code: 'c' }, browserOf(started))).problem).toMatch(/expired/);
    now.at += connectionsEnv.parse().HARNESS_CONNECT_WINDOW + 1;
    expect((await service.callback({ state: stateOf(started.url), code: 'c' }, browserOf(started))).problem).toMatch(/expired/);
  });

  it('gates per-person fns: missing until connected, the person\'s switches, then shared connections', async () => {
    const { service } = await world();
    const list = { name: QualifiedName.parse('cal/list_events'), system: 'cal' };
    const remove = { name: QualifiedName.parse('cal/delete_event'), system: 'cal' };
    expect((await service.gate(ADA, new Set())).fn(list)).toEqual({ state: 'missing', page: 'Calendar' });
    const started = await service.connect(ADA, CAL);
    if ('url' in started) await service.callback({ state: stateOf(started.url), code: 'c' }, browserOf(started));
    const gate = await service.gate(ADA, new Set());
    expect(gate.fn(list)).toMatchObject({ state: 'ready', option: { on: true, ask: false } });
    expect(gate.fn(remove)).toEqual({ state: 'off' });
    expect(gate.fn({ name: QualifiedName.parse('fs/read'), system: 'fs' })).toBeUndefined();
    expect((await service.gate(BEN, new Set())).fn(list)).toMatchObject({ state: 'missing' });
    const [page] = await service.pages(ADA);
    const id = page?.connections[0]?.id;
    if (id === undefined) throw new Error('no connection');
    await service.update(ADA, { connection: id, fns: { delete_event: { on: true, ask: true } }, share: { visibility: 'shared', with: [BEN] } });
    expect((await service.gate(BEN, new Set())).fn(remove)).toMatchObject({ state: 'ready', connection: { owner: ADA }, option: { ask: true } });
    await expect(service.update(BEN, { connection: id, fns: {} })).rejects.toThrow(/no connection/);
    await expect(service.update(ADA, { connection: id, fns: { nope: { on: true, ask: false } } })).rejects.toThrow(/no per-person fn nope/);
  });

  it('takes refreshed credentials, marks an expired one, and forgets a connection with its secret', async () => {
    const { service, store, secrets, system } = await world();
    const started = await service.connect(ADA, CAL);
    if ('url' in started) await service.callback({ state: stateOf(started.url), code: 'c' }, browserOf(started));
    const row = (await store.table('connections').find({ where: { owner: ADA }, limit: 1 })).items[0];
    if (row === undefined) throw new Error('no connection');
    await service.refreshed(CAL, { connection: row.id, update: { credentials: { access: 'a2' }, expiresAt: 9 } });
    const refreshed = await store.table('connections').get(row.id);
    expect((await service.forRun(refreshed ?? row)).credentials).toEqual({ access: 'a2' });
    expect(await secrets.reveal(row.credentials ?? 'sec_x')).toBeUndefined();
    await expect(service.refreshed(SystemName.parse('other'), { connection: row.id, update: { expired: 'x' } })).rejects.toThrow(/no connection/);
    await service.refreshed(CAL, { connection: row.id, update: { expired: 'The sign-in was revoked.' } });
    expect(await store.table('connections').get(row.id)).toMatchObject({ status: 'expired', problem: 'The sign-in was revoked.' });
    const revoked: string[] = [];
    system.behaviour.disconnect = (input) => { revoked.push(input.id); };
    expect(await service.disconnect(ADA, row.id)).toBe(true);
    expect(revoked).toEqual([row.id]);
    expect(await store.table('connections').get(row.id)).toBeUndefined();
  });

  it('records the provider\'s refusal as the connection\'s problem', async () => {
    const { service } = await world();
    const started = await service.connect(ADA, CAL);
    if (!('url' in started)) throw new Error('expected a URL');
    expect(await service.callback({ state: stateOf(started.url), error: 'access_denied', error_description: 'You said no.' }, browserOf(started))).toMatchObject({ system: CAL, problem: 'You said no.' });
    expect((await service.pages(ADA))[0]?.connections[0]).toMatchObject({ status: 'failed', problem: 'You said no.' });
  });

  it('drops an earlier sign-in that never came back when the person connects again', async () => {
    const { service } = await world();
    const first = await service.connect(ADA, CAL);
    const second = await service.connect(ADA, CAL);
    if (!('url' in first) || !('url' in second)) throw new Error('expected URLs');
    expect((await service.pages(ADA))[0]?.connections).toHaveLength(1);
    expect((await service.callback({ state: stateOf(first.url), code: 'c0de' }, browserOf(first))).problem).toMatch(/expired/);
    expect(await service.callback({ state: stateOf(second.url), code: 'c0de' }, browserOf(second))).toMatchObject({ system: CAL, problem: undefined });
  });

  it('finishes a sign-in only in the browser that started it', async () => {
    const { service, store } = await world();
    const started = await service.connect(ADA, CAL);
    if (!('url' in started)) throw new Error('expected a URL');
    // the consent link passed to someone else: their browser has no binding, or another sign-in's
    expect((await service.callback({ state: stateOf(started.url), code: 'bens' }, {})).problem).toMatch(/another browser/);
    const other = await service.connect(BEN, CAL);
    expect((await service.callback({ state: stateOf(started.url), code: 'bens' }, browserOf(other))).problem).toMatch(/another browser/);
    expect((await store.table('connections').find({ where: { owner: ADA }, limit: 1 })).items[0]).toMatchObject({ status: 'pending' });
    expect((await service.callback({ state: stateOf(started.url), code: 'c0de' }, browserOf(started))).problem).toBeUndefined();
  });

  it('finishes a sign-in once when its callback comes twice at the same time', async () => {
    const { service, store, system } = await world();
    let finishes = 0;
    system.behaviour.connectFinish = () => {
      finishes += 1;
      return { account: { label: 'ada@example.com' }, credentials: { access: 'a1' } };
    };
    const started = await service.connect(ADA, CAL);
    if (!('url' in started)) throw new Error('expected a URL');
    const [first, again] = await Promise.all([1, 2].map(() => service.callback({ state: stateOf(started.url), code: 'c0de' }, browserOf(started))));
    expect([first?.problem, again?.problem]).toEqual([undefined, expect.stringMatching(/already used/)]);
    expect(finishes).toBe(1);
    expect((await store.table('connections').find({ where: { owner: ADA }, limit: 1 })).items[0]).toMatchObject({ status: 'connected' });
  });

  it('takes refreshes one at a time, so no replaced secret is left behind', async () => {
    const { service, store } = await world();
    const started = await service.connect(ADA, CAL);
    if ('url' in started) await service.callback({ state: stateOf(started.url), code: 'c' }, browserOf(started));
    const row = (await store.table('connections').find({ where: { owner: ADA }, limit: 1 })).items[0];
    if (row === undefined) throw new Error('no connection');
    await Promise.all(['a2', 'a3', 'a4'].map((access) => service.refreshed(CAL, { connection: row.id, update: { credentials: { access } } })));
    const secrets = (await store.table('secrets').find({ limit: 10 })).items;
    expect(secrets.map((secret) => secret.id)).toEqual([(await store.table('connections').get(row.id))?.credentials]);
  });
});

/** A runtime fn of the `linear` instance (routed to it), as the instance-scoped tests use. */
function instanceFn(local: string): FnRecord {
  return {
    name: QualifiedName.parse(`cal/${local}`), system: CAL, version: 'v1', origin: 'runtime', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0,
    decl: {
      name: local, description: local, kind: 'native', args: { name: 'obj', props: {} }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [], routing: { to: 'instance', instance: LINEAR },
    },
  };
}

describe('instance-scoped connections (build 9)', () => {
  const SCOPED: ConnectDecl = { ...DECL, title: 'MCP servers', scope: 'instance', fns: {}, defaults: { on: true, ask: false } };
  const SEARCH = instanceFn('linear_search');

  /** A world with the `linear` instance saying how people connect to it. */
  async function scoped(share = false) {
    const made = await world(SCOPED, new Map([[SEARCH.name, SEARCH]]));
    await made.store.table('instances').insert({
      system: CAL, instance: LINEAR, description: 'Linear', status: 'connected', keyFingerprint: 'k', publicKey: 'p', version: '1', manifestHash: 'h',
      connect: { flow: { flow: 'oauth' }, share, title: 'Sign in to Linear' },
    });
    await made.store.table('actors').insert({ id: ADA, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 0, disabled: false });
    await made.store.table('actors').insert({ id: BEN, kind: 'user', name: 'Ben', about: '', email: 'ben@example.com', role: 'member', createdAt: 0, disabled: false });
    return made;
  }

  it('connects to one instance through its own flow, tells the instance which, and gates only that instance\'s fns', async () => {
    const { service, system, store } = await scoped();
    const starts: unknown[] = [];
    const finishes: unknown[] = [];
    system.behaviour.connectStart = (input) => { starts.push(input.instance); return { url: `https://linear.example/auth?state=${encodeURIComponent(input.state)}` }; };
    system.behaviour.connectFinish = (input) => { finishes.push(input.instance); return { account: { label: 'ada@linear' }, credentials: { access: 't1' } }; };
    const [page] = await service.pages(ADA);
    expect(page?.instances).toEqual([{ instance: LINEAR, label: 'Linear', connect: { flow: { flow: 'oauth' }, share: false, title: 'Sign in to Linear' } }]);
    await expect(service.connect(ADA, CAL)).rejects.toThrow(/which cal instance/);
    expect((await service.gate(ADA, new Set())).fn(SEARCH)).toEqual({ state: 'missing', page: 'MCP servers' });
    const started = await service.connect(ADA, CAL, undefined, LINEAR);
    if (!('url' in started)) throw new Error('expected a URL');
    await service.callback({ state: stateOf(started.url), code: 'c' }, browserOf(started));
    expect([starts, finishes]).toEqual([[LINEAR], [LINEAR]]);
    expect((await store.table('connections').find({ limit: 1 })).items[0]).toMatchObject({ instance: LINEAR, status: 'connected', share: { visibility: 'private' } });
    const gate = await service.gate(ADA, new Set());
    expect(gate.fn(SEARCH)).toMatchObject({ state: 'ready', option: { on: true, ask: false } });
    // a contract fn with no instance of its own is not per person; another person has no connection
    expect(gate.fn({ name: QualifiedName.parse('cal/server_status'), system: 'cal' })).toBeUndefined();
    expect((await service.gate(BEN, new Set())).fn(SEARCH)).toMatchObject({ state: 'missing' });
    // the switches name the instance's own fns only
    const id = (await store.table('connections').find({ limit: 1 })).items[0]?.id ?? 'con_x';
    await service.update(ADA, { connection: id, fns: { linear_search: { on: false, ask: false } } });
    expect((await service.gate(ADA, new Set())).fn(SEARCH)).toEqual({ state: 'off' });
    await expect(service.update(ADA, { connection: id, fns: { other_tool: { on: true, ask: false } } })).rejects.toThrow(/other_tool/);
    // only its own instance refreshes it
    await expect(service.refreshed(CAL, { connection: id, update: { expired: 'x' } }, InstanceName.parse('jira'))).rejects.toThrow(/no connection/);
    await service.refreshed(CAL, { connection: id, update: { expired: 'revoked' } }, LINEAR);
    expect(await store.table('connections').get(id)).toMatchObject({ status: 'expired' });
  });

  it('a shared instance is connected once by an admin, for everyone', async () => {
    const { service } = await scoped(true);
    await expect(service.connect(BEN, CAL, undefined, LINEAR)).rejects.toThrow(/an admin connects/);
    const started = await service.connect(ADA, CAL, undefined, LINEAR);
    if (!('url' in started)) throw new Error('expected a URL');
    await service.callback({ state: stateOf(started.url), code: 'c' }, browserOf(started));
    expect((await service.gate(BEN, new Set())).fn(SEARCH)).toMatchObject({ state: 'ready', connection: { owner: ADA, instance: LINEAR } });
  });

  it('lists each system\'s own connections on its page, the pages in title order, read in one query for all systems', async () => {
    const { service, store, catalog } = await world();
    const MAIL = SystemName.parse('mail');
    const mailDecl: ConnectDecl = { ...DECL, title: 'Agenda mail' };
    catalog.manifest = (name: SystemName) => Promise.resolve(name === CAL ? testManifest(CAL, { connect: DECL }) : name === MAIL ? testManifest(MAIL, { connect: mailDecl }) : undefined);
    await store.table('systems').insert({ name: MAIL, description: '', status: 'disconnected', enabled: { functions: true, renderers: true }, version: '1', manifestHash: 'h', actor: ADA });
    await service.connect(ADA, CAL);
    const calRow = (await store.table('connections').find({ limit: 1 })).items[0];
    if (calRow === undefined) throw new Error('no connection row');
    await store.table('connections').insert({ ...calRow, id: ConnectionId.parse('cnx_mail'), system: MAIL, createdAt: calRow.createdAt + 1 });
    const pages = await service.pages(ADA);
    expect(pages.map((page) => [page.system, page.ready, page.connections.length])).toEqual([[MAIL, false, 1], [CAL, true, 1]]);
    expect(pages[0]?.connections[0]?.id).toBe('cnx_mail');
    expect(pages[1]?.connections[0]?.id).toBe(calRow.id);
  });

  it('refuses an instance that needs no connection, and an instance for a system-wide connection', async () => {
    const { service, store } = await scoped();
    await store.table('instances').update({ system: CAL, instance: LINEAR }, { connect: { share: false, title: 'Linear' } });
    await expect(service.connect(ADA, CAL, undefined, LINEAR)).rejects.toThrow(/needs no connection/);
    expect((await service.gate(BEN, new Set())).fn(SEARCH)).toBeUndefined();
    expect((await service.pages(ADA))[0]?.instances).toEqual([]);
    const plain = await world();
    await expect(plain.service.connect(ADA, CAL, undefined, LINEAR)).rejects.toThrow(/once for the whole system/);
  });
});
