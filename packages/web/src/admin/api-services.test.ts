/**
 * To-do phase 4 on the admin pages and the connect page: API services are records of the one `api` instance. A
 * service's draft and the record it saves (its name from the label, never a secret, no OAuth); the queries the pages
 * send (words and filters run in the hub's database); the store adding, changing (by the version it read) and
 * removing a service as a record and finding its fns by name; and the connect page's cards for a key-scoped page.
 */
import { ActorId, ApiService, ConnectKey, Json, mintId, QualifiedName, ConnectPage, type DataRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { instanceCards, scopedPage } from '../connect/logic.ts';
import { fakeCaller } from '../test/fakes.ts';
import { API_AUTH_KINDS, apiServiceDraft, apiServiceValue, SERVICE_TYPE, serviceFnsQuery, serviceQuery, servicesQuery } from './logic/api-services.ts';
import { authDraft } from './logic/remote-config.ts';
import { ApiServicesStore } from './state/api-services.ts';
import { fakeRecordsApi, fnRecord } from './test/fakes.ts';

const LINEAR = ApiService.parse({ name: 'linear', label: 'Linear', baseUrl: 'https://api.linear.app', auth: { kind: 'bearer', per: 'shared' } });

/** A service as the hub keeps it. */
const record = (service: ApiService, version = 1): DataRecord => ({ id: mintId('record'), type: SERVICE_TYPE, value: Json.parse(service), title: service.label, version, createdAt: 1, updatedAt: 1 });

describe('an API service draft', () => {
  it('saves its name from the label, never a typed secret, and refuses OAuth (a service names no sign-in endpoints)', () => {
    const draft = { ...apiServiceDraft(), label: 'Linear tickets', baseUrl: 'https://api.linear.app', auth: { ...authDraft({ kind: 'bearer', per: 'shared' }), token: 'typed' }, timeout: '10', maxBody: '2' };
    const checked = apiServiceValue(draft);
    expect(checked.ok && checked.service).toEqual({ name: 'linear-tickets', label: 'Linear tickets', baseUrl: 'https://api.linear.app', auth: { kind: 'bearer', per: 'shared' }, timeout: 10_000, maxBody: 2048 });
    expect(apiServiceDraft(checked.ok ? checked.service : undefined)).toMatchObject({ name: 'linear-tickets', timeout: '10', maxBody: '2', auth: { kind: 'bearer', per: 'shared', token: '' } });
    const problem: unknown = expect.any(String);
    expect(apiServiceValue({ ...draft, name: 'Linear!' })).toMatchObject({ ok: false, problems: { name: problem } });
    expect(apiServiceValue({ ...draft, baseUrl: 'api.linear.app' }).ok).toBe(false);
    expect(apiServiceValue({ ...draft, auth: { ...draft.auth, kind: 'oauth', per: 'person' } }).ok).toBe(false);
    expect(API_AUTH_KINDS).not.toContain('oauth');
  });

  it('asks the hub\'s database: the services by words or by label, one by name, its fns by name', () => {
    expect(servicesQuery('')).toEqual({ type: 'api/Service', query: { limit: 100, sort: [{ field: 'label', dir: 'asc' }] } });
    expect(servicesQuery(' linear ')).toEqual({ type: 'api/Service', query: { limit: 100 }, search: 'linear' });
    expect(serviceQuery('linear').query?.filters).toEqual([{ field: 'name', op: 'is', value: 'linear' }]);
    expect(serviceFnsQuery('linear').filters).toEqual([{ field: 'system', op: 'is', value: 'api' }, { field: 'name', op: 'contains', value: 'api/linear.' }]);
  });
});

describe('the API services store', () => {
  function world(kept: DataRecord[] = [record(LINEAR)]) {
    const data = fakeRecordsApi(kept);
    const fn = fnRecord({ name: QualifiedName.parse('api/linear.issues') });
    const fns = fakeCaller<'fns'>(() => Promise.resolve({ items: [fn] }));
    return { data, fns, store: new ApiServicesStore({ fns, records: data.records, saveRecord: data.saveRecord, removeRecord: data.removeRecord }) };
  }

  it('lists and opens services as records, with the fns sent to them', async () => {
    const { store, fns } = world();
    await store.load('lin');
    expect(store.list.value.value?.map((row) => row.service.name)).toEqual(['linear']);
    await store.show(ConnectKey.parse('linear'));
    expect(store.service.value.value?.service).toEqual(LINEAR);
    expect(store.fns.value.value?.map((f) => f.name)).toEqual(['api/linear.issues']);
    expect(fns.calls.at(-1)?.[0]).toEqual(serviceFnsQuery('linear'));
    await store.show(ConnectKey.parse('gone'));
    expect(store.service.value.value).toBeUndefined();
  });

  it('adds a service once by its name, changes one by the version it read, and removes it', async () => {
    const { store, data } = world();
    const board = ApiService.parse({ name: 'board', label: 'Board', baseUrl: 'https://board.test' });
    expect((await store.save(board)).ok).toBe(true);
    expect(await store.save(board)).toMatchObject({ ok: false });
    expect(store.saving.problem.value).toContain('named board already');
    await store.show(ConnectKey.parse('linear'));
    const row = store.service.value.value;
    if (row === undefined) throw new Error('no service');
    const changed = await store.save({ ...LINEAR, label: 'Linear (EU)' }, row);
    expect(changed).toMatchObject({ ok: true, value: { version: 2, service: { label: 'Linear (EU)' } } });
    expect(data.saveRecord.calls.at(-1)?.[0]).toMatchObject({ id: row.id, expect: 1 });
    expect(store.service.value.value?.service.label).toBe('Linear (EU)');
    expect(await store.remove(row)).toBe(true);
    expect(data.kept.map((kept) => kept.value)).toEqual([expect.objectContaining({ name: 'board' })]);
  });
});

describe('the connect page of a key-scoped system', () => {
  it('shows a card per service, with the person\'s own and the shared connections to it', () => {
    const me = ActorId.parse('act_me');
    const admin = ActorId.parse('act_admin');
    const connection = (owner: ActorId, key: string) => ({
      id: mintId('connection'), system: 'api', key: ConnectKey.parse(key), owner, status: 'connected' as const, settings: {}, fns: {},
      share: { visibility: owner === admin ? 'public' as const : 'private' as const, with: [] }, createdAt: 1, updatedAt: 1,
    });
    const page = ConnectPage.parse({
      system: 'api', ready: true,
      decl: { title: 'API sign-ins', description: '', how: { flow: 'oauth' }, settings: { name: 'obj', props: {} }, fns: {}, scope: 'key', keys: { type: 'api/Service' } },
      connections: [connection(me, 'tracker'), connection(admin, 'board')],
      keys: [
        { key: ConnectKey.parse('tracker'), label: 'Tracker', connect: { flow: { flow: 'form', form: { name: 'obj', props: {} } }, share: false, title: 'Connect to Tracker' } },
        { key: ConnectKey.parse('board'), label: 'Board', connect: { flow: { flow: 'form', form: { name: 'obj', props: {} } }, share: true, title: 'Set Board\'s sign-in for everyone' } },
      ],
    });
    expect(scopedPage(page)).toBe(true);
    const cards = instanceCards(page, me, false);
    expect(cards.map((card) => [card.id, card.target, card.own?.owner, card.shared.map((c) => c.owner), card.mayConnect])).toEqual([
      ['board', { key: 'board' }, undefined, [admin], false],
      ['tracker', { key: 'tracker' }, me, [], true],
    ]);
  });
});
