import { ApiError } from '@ayepi/core';
import { IDS, LIST_FIELDS, QualifiedName, ResourceUri, SystemName, TypeRecord, noFnStats, type ActorId, type FieldDecl, type Filter, type ListQuery, type ModelCall, type SessionId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { chatWorld, FixtureCatalog, makeRun } from '../chat/testing.ts';
import { instanceRow, systemRow } from '../catalog/fixtures.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { StoreCatalog } from '../catalog/catalog.ts';
import { queryEnv } from './env.ts';
import { evaluate, passes } from './evaluate.ts';
import { HubQuery } from './service.ts';
import { listSources } from './sources.ts';
import { openScope } from '../access/index.ts';

/** Everything visible to everyone. */
const OPEN_ACCESS = { scope: (actor: ActorId) => Promise.resolve(openScope(actor)) };

const admin = { id: IDS.actor.parse('act_admin'), role: 'admin' as const };
const member = { id: IDS.actor.parse('act_bo'), role: 'member' as const };

describe('the query evaluator', () => {
  const rows = [
    { name: 'Alpha', cost: 0.5, tags: ['a', 'b'], at: 3 },
    { name: 'beta', cost: 0.01, tags: [], at: 1 },
    { name: 'Gamma', cost: undefined, tags: ['b'], at: 2 },
  ];
  type Row = (typeof rows)[number];
  // a list's fields stand in for these rows: name (text), tags (dynamic), cost (number), updatedAt (date)
  const how = {
    list: 'contexts' as const,
    fields: {
      name: (r: Row) => r.name, system: () => undefined, origin: () => undefined, tags: (r: Row) => r.tags, disabled: () => false, stale: () => false,
      tokens: (r: Row) => r.cost, updatedAt: (r: Row) => r.at,
    },
  };
  const names = (query: ListQuery) => evaluate(rows, query, how, 50).items.map((r) => r.name);

  it('filters by every operator, a list field passing when any value does', () => {
    expect(names({ filters: [{ field: 'name', op: 'contains', value: 'A' }] })).toEqual(['Alpha', 'Gamma', 'beta']);
    expect(names({ filters: [{ field: 'name', op: 'is', value: 'alpha' }] })).toEqual(['Alpha']);
    expect(names({ filters: [{ field: 'tokens', op: 'gt', value: 0.1 }] })).toEqual(['Alpha']);
    expect(names({ filters: [{ field: 'tokens', op: 'between', from: 0, to: '0.1' }] })).toEqual(['beta']);
    expect(names({ filters: [{ field: 'tokens', op: 'empty' }] })).toEqual(['Gamma']);
    expect(names({ filters: [{ field: 'tags', op: 'in', values: ['b'] }] })).toEqual(['Alpha', 'Gamma']);
    expect(names({ filters: [{ field: 'tags', op: 'notIn', values: ['a'] }] })).toEqual(['Gamma', 'beta']);
    expect(names({ filters: [{ field: 'tags', op: 'empty' }] })).toEqual(['beta']);
    expect(passes(undefined, { field: 'x', op: 'isNot', value: 'y' }, { label: 'X', type: 'text', sortable: true, filterable: true })).toBe(true);
  });

  it('matches free text word by word, sorts by the query or the list default, and pages with a cursor', () => {
    expect(names({ text: 'gam' })).toEqual(['Gamma']);
    expect(names({})).toEqual(['Alpha', 'Gamma', 'beta']);
    expect(names({ sort: [{ field: 'name', dir: 'asc' }] })).toEqual(['Alpha', 'beta', 'Gamma']);
    expect(names({ sort: [{ field: 'tokens', dir: 'desc' }] })).toEqual(['Alpha', 'beta', 'Gamma']);
    const first = evaluate(rows, { limit: 2 }, how, 50);
    expect(first).toMatchObject({ cursor: '2', total: 3 });
    expect(evaluate(rows, { limit: 2, cursor: first.cursor }, how, 50).items.map((r) => r.name)).toEqual(['beta']);
  });
});

describe('the lists', () => {
  async function rig() {
    const store = await testStore();
    const catalog = new FixtureCatalog();
    const lists = new HubQuery(listSources({ store, catalog, access: OPEN_ACCESS }, queryEnv.parse()));
    const turn = IDS.turn.parse('trn_1');
    await store.table('runs').insert(makeRun({ id: IDS.run.parse('run_a'), fn: 'fs/read', turn, actor: admin.id, status: 'done', cost: 0.002, createdAt: 1 }));
    await store.table('runs').insert(makeRun({ id: IDS.run.parse('run_b'), fn: 'fs/write', turn, actor: member.id, status: 'failed', cost: 0.2, createdAt: 2 }));
    await store.table('runs').insert(makeRun({ id: IDS.run.parse('run_c'), fn: 'fs/read', turn, actor: member.id, status: 'done', cost: 0, createdAt: 3 }));
    return { store, lists };
  }

  it('serves runs by the standard, a member seeing only their own', async () => {
    const { lists } = await rig();
    const ids = async (query: ListQuery, who: typeof admin | typeof member = admin) => (await lists.page('runs', query, who)).items.map((r) => r.id);
    expect(await ids({})).toEqual(['run_c', 'run_b', 'run_a']);
    expect(await ids({ filters: [{ field: 'fn', op: 'is', value: 'fs/read' }] })).toEqual(['run_c', 'run_a']);
    expect(await ids({ filters: [{ field: 'status', op: 'in', values: ['failed'] }] })).toEqual(['run_b']);
    expect(await ids({ filters: [{ field: 'cost', op: 'gte', value: 0.002 }], sort: [{ field: 'cost', dir: 'asc' }] })).toEqual(['run_a', 'run_b']);
    expect(await ids({}, member)).toEqual(['run_c', 'run_b']);
    const result = await lists.query({ list: 'runs', query: { limit: 1 } }, admin);
    expect(result).toMatchObject({ cursor: '1', total: 3, sort: [{ field: 'createdAt', dir: 'desc' }] });
    expect(result.items[0]).toMatchObject({ id: 'run_c', fn: 'fs/read' });
  });

  it('pushes fn and session filters to the store, so the scan bound never cuts the runs of a rarely used fn', async () => {
    const { store } = await rig();
    const turn = IDS.turn.parse('trn_1');
    for (let i = 0; i < 100; i++) { await store.table('runs').insert(makeRun({ id: IDS.run.parse(`run_n${i}`), fn: 'fs/read', turn, actor: admin.id, status: 'done', createdAt: 10 + i })); }
    const lists = new HubQuery(listSources({ store, catalog: new FixtureCatalog(), access: OPEN_ACCESS }, { ...queryEnv.parse(), HARNESS_QUERY_SCAN: 100 }));
    const result = await lists.query({ list: 'runs', query: { filters: [{ field: 'fn', op: 'is', value: 'fs/write' }] } }, admin);
    expect(result).toMatchObject({ total: 1, items: [{ id: 'run_b' }] });
  });

  it('pushes number and date bounds and number sorts to the store, and says partial when the scan bound cut the read', async () => {
    const { store } = await rig();
    const turn = IDS.turn.parse('trn_1');
    for (let i = 0; i < 100; i++) { await store.table('runs').insert(makeRun({ id: IDS.run.parse(`run_n${i}`), fn: 'fs/read', turn, actor: admin.id, status: 'done', cost: 0.01, createdAt: 10 + i })); }
    const lists = new HubQuery(listSources({ store, catalog: new FixtureCatalog(), access: OPEN_ACCESS }, { ...queryEnv.parse(), HARNESS_QUERY_SCAN: 100 }));
    const run = async (query: ListQuery) => lists.query({ list: 'runs', query }, admin);
    // the oldest runs, past the newest 100, by a date bound and by a cost sort
    expect(await run({ filters: [{ field: 'createdAt', op: 'lt', value: 3 }] })).toMatchObject({ total: 2, items: [{ id: 'run_b' }, { id: 'run_a' }] });
    expect((await run({ filters: [{ field: 'cost', op: 'between', from: 0.1, to: 1 }] })).items).toMatchObject([{ id: 'run_b' }]);
    const cheapest = await run({ sort: [{ field: 'cost', dir: 'asc' }], limit: 2 });
    expect(cheapest).toMatchObject({ items: [{ id: 'run_c' }, { id: 'run_a' }], partial: true });
    // complete answers aren't partial
    expect(await run({ filters: [{ field: 'createdAt', op: 'lt', value: 3 }] })).not.toHaveProperty('partial');
  });

  it('refuses a query its list cannot answer (422) and lists admin-only lists to admins only (403)', async () => {
    const { lists } = await rig();
    await expect(lists.page('runs', { filters: [{ field: 'nope', op: 'is', value: 1 }] }, admin)).rejects.toSatisfy((e) => e instanceof ApiError && e.status === 422);
    await expect(lists.page('runs', { filters: [{ field: 'cost', op: 'contains', value: '1' }] }, admin)).rejects.toThrow(/does not take/);
    await expect(lists.page('fns', {}, member)).rejects.toSatisfy((e) => e instanceof ApiError && e.status === 403);
  });

  it('offers a field\'s values with counts, and an enum\'s declared values even when none has them', async () => {
    const { lists } = await rig();
    expect(await lists.values({ list: 'runs', field: 'fn' }, admin)).toEqual([{ value: 'fs/read', count: 2 }, { value: 'fs/write', count: 1 }]);
    const statuses = await lists.values({ list: 'runs', field: 'status', prefix: 'fai' }, admin);
    expect(statuses).toEqual([{ value: 'failed', count: 1 }]);
    await expect(lists.values({ list: 'runs', field: 'nope' }, admin)).rejects.toThrow(/no field/);
  });

  it('serves the fns catalogue with stats, and a member only the model calls of their own sessions', async () => {
    const w = await chatWorld();
    const lists = new HubQuery(listSources({ ...w, access: w.deps.access }, queryEnv.parse()));
    for (const [name, failed] of [['read', 0], ['write', 2]] as const) {
      const record = w.catalog.addFn('fs', { name, description: `${name} things` });
      await w.store.table('fns').put({ ...record, stats: { ...noFnStats(), outcomes: { done: 3, failed, 'invalid-input': 0, cancelled: 0 } } });
    }
    const fns = await lists.page('fns', { filters: [{ field: 'failures', op: 'gt', value: 0 }] }, admin);
    expect(fns.items.map((f) => [f.name, f.stats.outcomes.failed])).toEqual([['fs/write', 2]]);
    expect((await lists.page('fns', { text: 'read things' }, admin)).items.map((f) => f.name)).toEqual(['fs/read']);
    const call = (id: string, session?: SessionId): ModelCall => ({
      id: IDS.modelCall.parse(id), provider: 'p', model: 'm', modality: 'chat', units: { modality: 'chat', input: 10, output: 5 }, cost: 0.00042, status: 'done', sent: 0, received: 0,
      queued: 0, total: 30, startedAt: 1, ...(session === undefined ? {} : { session }),
    });
    await w.store.table('modelCalls').insert(call('mdl_1', w.session.id));
    await w.store.table('modelCalls').insert(call('mdl_2'));
    // the session's owner, seen as a member
    expect((await lists.page('modelCalls', {}, { id: w.admin.id, role: 'member' })).items.map((c) => c.id)).toEqual(['mdl_1']);
    expect((await lists.page('modelCalls', { filters: [{ field: 'tokens', op: 'is', value: 15 }] }, admin)).items).toHaveLength(2);
    // every declared field of each list reads its row: a field asked to be filled finds the rows that fill it, and no more
    const uri = ResourceUri.parse('file:///notes/a.md');
    await w.store.table('resources').insert({ uri, system: SystemName.parse('fs'), stat: { uri, name: 'a.md', type: 'file', version: 'v1' }, links: [], seenAt: 2 });
    await w.store.table('llmInteractions').insert({
      id: IDS.llmInteraction.parse('llm_1'), turn: IDS.turn.parse('trn_w'), run: IDS.run.parse('run_w'), iteration: 0, provider: 'openrouter', model: 'm', request: { messages: [] },
      cost: 0, status: 'done', priority: 'interactive', queuedAt: 1,
    });
    await w.store.table('context').put(w.catalog.addContext('fs', { name: 'guide', description: 'How fs works', tags: ['files'] }));
    await w.store.table('notifications').insert({
      id: IDS.notification.parse('ntf_1'), user: admin.id, reason: 'message', title: 'Hi', body: 'A message', link: { session: w.session.id }, read: false, pushed: false, createdAt: 4,
    });
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_w'), fn: 'fs/read', turn: IDS.turn.parse('trn_w'), actor: admin.id, status: 'done', cost: 0.01, createdAt: 5, endedAt: 9 }));
    await w.store.table('types').insert(TypeRecord.parse({ name: QualifiedName.parse('fs/Entry'), system: SystemName.parse('fs'), description: 'A file.', def: { name: 'text' }, display: { label: 'Entry' }, references: [], updatedAt: 1 }));
    for (const list of ['resources', 'fns', 'runs', 'modelCalls', 'llmCalls', 'sessions', 'contexts', 'notifications', 'systems', 'types'] as const) {
      const all = (await lists.page(list, {}, admin)).items.length;
      for (const [field, decl] of Object.entries<FieldDecl>(LIST_FIELDS[list].fields)) {
        const [yes, no]: [Filter, Filter] = decl.type === 'boolean'
          ? [{ field, op: 'is', value: true }, { field, op: 'is', value: false }]
          : [{ field, op: 'notEmpty' }, { field, op: 'empty' }];
        const counted = await Promise.all([yes, no].map(async (filter) => (await lists.page(list, { filters: [filter] }, admin)).items.length));
        expect((counted[0] ?? 0) + (counted[1] ?? 0)).toBe(all);
      }
    }
  });

  it('finds rows of each list by their words, and lists the systems to admins, without removed ones, by every field', async () => {
    const w = await chatWorld();
    const lists = new HubQuery(listSources({ ...w, access: w.deps.access }, queryEnv.parse()));
    const turn = IDS.turn.parse('trn_w');
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_oslo'), fn: 'fs/read', turn, actor: admin.id, status: 'done', createdAt: 5 }));
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_rome'), fn: 'fs/read', turn, actor: admin.id, status: 'done', createdAt: 6 }));
    await w.store.table('notifications').insert({
      id: IDS.notification.parse('ntf_1'), user: admin.id, reason: 'message', title: 'Trip booked', body: 'Oslo on Friday', link: { session: w.session.id }, read: false, pushed: false, createdAt: 4,
    });
    await w.store.table('notifications').insert({
      id: IDS.notification.parse('ntf_2'), user: admin.id, reason: 'message', title: 'Rent', body: 'Due soon', link: { session: w.session.id }, read: true, pushed: false, createdAt: 5,
    });
    await w.store.table('context').put(w.catalog.addContext('fs', { name: 'guide', description: 'How fs reads files', tags: ['files'] }));
    await w.store.table('context').put(w.catalog.addContext('fs', { name: 'style', description: 'House style for notes', tags: [] }));
    for (const [name, description] of [['Entry', 'A file on disk.'], ['Folder', 'A directory of entries.']] as const) {
      await w.store.table('types').insert(TypeRecord.parse({ name: QualifiedName.parse(`fs/${name}`), system: SystemName.parse('fs'), description, def: { name: 'text' }, display: { label: name }, references: [], updatedAt: 1 }));
    }
    const call = (id: string, fn: string, session?: SessionId): ModelCall => ({
      id: IDS.modelCall.parse(id), provider: 'p', model: 'm', modality: 'chat', units: { modality: 'chat', input: 10, output: 5 }, cost: 0.001, status: 'done', sent: 0, received: 0,
      queued: 0, total: 30, startedAt: 1, fn: QualifiedName.parse(fn), purpose: 'chat', ...(session === undefined ? {} : { session }),
    });
    await w.store.table('modelCalls').insert(call('mdl_1', 'hub/chat', w.session.id));
    await w.store.table('modelCalls').insert(call('mdl_2', 'fs/summarise', w.session.id));
    const found = async <L extends 'runs' | 'notifications' | 'contexts' | 'types' | 'modelCalls'>(list: L, text: string, who: typeof admin | typeof member = admin) => (await lists.page(list, { text }, who)).items.length;
    expect(await found('runs', 'oslo')).toBe(1);
    expect(await found('notifications', 'oslo friday')).toBe(1);
    expect(await found('contexts', 'house style')).toBe(1);
    expect(await found('types', 'directory')).toBe(1);
    expect(await found('modelCalls', 'summarise')).toBe(1);
    // a member asking for sessions that aren't theirs sees none of their calls
    expect((await lists.page('modelCalls', { filters: [{ field: 'session', op: 'in', values: ['ses_other'] }] }, { id: w.admin.id, role: 'member' })).items).toEqual([]);

    await w.store.table('systems').put(systemRow('fs', 'connected', { lastSeenAt: 10 }));
    await w.store.table('systems').put(systemRow('web', 'disconnected', { lastSeenAt: 5 }));
    await w.store.table('systems').put(systemRow('old', 'removed'));
    await w.store.table('instances').put(instanceRow('fs', 'connected'));
    // a system's view counts its fns from the real catalog
    const catalog = new StoreCatalog({ store: w.store, bus: new RecordingBus(), log: memoryLog().log, clock: () => 1, describer: { describe: () => Promise.resolve({ problems: [] }) } });
    const withSystems = new HubQuery(listSources({ store: w.store, catalog, access: OPEN_ACCESS }, queryEnv.parse()));
    const systems = async (query: ListQuery) => (await withSystems.page('systems', query, admin)).items.map((s) => s.name);
    expect(await systems({})).toEqual(['fs', 'web']);
    expect(await systems({ filters: [{ field: 'status', op: 'is', value: 'connected' }] })).toEqual(['fs']);
    expect(await systems({ sort: [{ field: 'name', dir: 'desc' }] })).toEqual(['web', 'fs']);
    expect(await systems({ filters: [{ field: 'lastSeenAt', op: 'empty' }] })).toEqual(expect.any(Array));
    expect(await systems({ filters: [{ field: 'instances', op: 'gt', value: 0 }] })).toEqual(['fs']);
    expect(await systems({ filters: [{ field: 'version', op: 'is', value: '1.0.0' }, { field: 'fns', op: 'gte', value: 0 }, { field: 'name', op: 'contains', value: 'w' }] })).toEqual(['web']);
    await expect(withSystems.page('systems', {}, member)).rejects.toSatisfy((e) => e instanceof ApiError && e.status === 403);
  });
});
