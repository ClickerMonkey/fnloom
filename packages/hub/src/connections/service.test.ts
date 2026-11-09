import { ActorId, QualifiedName, SystemName, type ConnectDecl, type SystemRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { AesSecretVault, SecretBox } from '../api/secrets.ts';
import { TEST_KEYS, testManifest } from '../api/testing/rig.ts';
import { linkServer, TestSystem } from '../execution/testing.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { connectionsEnv } from './env.ts';
import { StoreConnectionService } from './service.ts';

const ADA = ActorId.parse('act_ada');
const BEN = ActorId.parse('act_ben');
const CAL = SystemName.parse('cal');
const DECL: ConnectDecl = {
  title: 'Calendar', description: 'Your calendar.', how: { flow: 'oauth' }, settings: { name: 'object', props: {} },
  fns: { list_events: { on: true, ask: false }, delete_event: { on: false, ask: true } },
};


async function world(decl: ConnectDecl = DECL) {
  const store = await testStore();
  const catalog = { manifest: (name: SystemName) => Promise.resolve(name === CAL ? testManifest(CAL, { connect: decl }) : undefined), check: () => Promise.resolve([]) };
  const row: SystemRecord = { name: CAL, description: '', status: 'connected', enabled: { functions: true, renderers: true }, version: '1', manifestHash: 'h', actor: ADA };
  await store.table('systems').insert(row);
  const hub = linkServer();
  const system = new TestSystem('cal', hub);
  const now = { at: 1_000 };
  const secrets = new AesSecretVault({ store, box: new SecretBox(TEST_KEYS.secretKey), clock: () => now.at });
  const service = new StoreConnectionService({
    store, catalog, secrets, bus: new RecordingBus(), log: memoryLog().log, clock: () => now.at, settings: connectionsEnv.parse(), hubUrl: 'http://hub.test',
    link: { connection: (name) => (name === CAL ? system.connection(hub) : undefined) },
  });
  return { store, catalog, system, service, secrets, now };
}

/** The state the hub put in the provider URL. */
const stateOf = (url: string): string => new URL(url).searchParams.get('state') ?? '';

describe('per-person connections', () => {
  it('connects through the provider redirect, keeps the credentials as the person\'s secret and lists the page', async () => {
    const { service, store, secrets } = await world();
    const started = await service.connect(ADA, CAL);
    if (!('url' in started)) throw new Error('expected a URL');
    const answer = await service.callback({ state: stateOf(started.url), code: 'c0de' });
    expect(answer).toEqual({ system: CAL, problem: undefined });
    const [page] = await service.pages(ADA);
    expect(page).toMatchObject({ system: CAL, ready: true, connections: [{ status: 'connected', account: { label: 'ada@example.com' } }] });
    expect(page?.connections[0]).not.toHaveProperty('credentials');
    const row = (await store.table('connections').find({ where: { owner: ADA }, limit: 1 })).items[0];
    expect(row?.credentials).toBeDefined();
    expect(JSON.parse((await secrets.reveal(row?.credentials ?? 'sec_x')) ?? '')).toEqual({ access: 'a1', refresh: 'r1' });
    expect(await service.pages(BEN)).toEqual([{ system: CAL, decl: DECL, ready: true, connections: [] }]);
    // the state works once
    expect((await service.callback({ state: stateOf(started.url), code: 'again' })).problem).toMatch(/expired or was already used/);
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
    expect((await service.callback({ state: `${stateOf(started.url)}x`, code: 'c' })).problem).toMatch(/expired/);
    now.at += connectionsEnv.parse().HARNESS_CONNECT_WINDOW + 1;
    expect((await service.callback({ state: stateOf(started.url), code: 'c' })).problem).toMatch(/expired/);
  });

  it('gates per-person fns: missing until connected, the person\'s switches, then shared connections', async () => {
    const { service } = await world();
    const list = { name: QualifiedName.parse('cal/list_events'), system: 'cal' };
    const remove = { name: QualifiedName.parse('cal/delete_event'), system: 'cal' };
    expect((await service.gate(ADA, new Set())).fn(list)).toEqual({ state: 'missing', page: 'Calendar' });
    const started = await service.connect(ADA, CAL);
    if ('url' in started) await service.callback({ state: stateOf(started.url), code: 'c' });
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
    if ('url' in started) await service.callback({ state: stateOf(started.url), code: 'c' });
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
    expect(await service.callback({ state: stateOf(started.url), error: 'access_denied', error_description: 'You said no.' })).toEqual({ system: CAL, problem: 'You said no.' });
    expect((await service.pages(ADA))[0]?.connections[0]).toMatchObject({ status: 'failed', problem: 'You said no.' });
  });

  it('drops an earlier sign-in that never came back when the person connects again', async () => {
    const { service } = await world();
    const first = await service.connect(ADA, CAL);
    const second = await service.connect(ADA, CAL);
    if (!('url' in first) || !('url' in second)) throw new Error('expected URLs');
    expect((await service.pages(ADA))[0]?.connections).toHaveLength(1);
    expect((await service.callback({ state: stateOf(first.url), code: 'c0de' })).problem).toMatch(/expired/);
    expect(await service.callback({ state: stateOf(second.url), code: 'c0de' })).toEqual({ system: CAL, problem: undefined });
  });
});
