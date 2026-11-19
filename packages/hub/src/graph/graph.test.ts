import { ActorId, QualifiedName, SystemName, type Filter, type GraphPage } from '@harness/core';
import { context, fn, g, kind, system, type } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { manifestFor } from '../catalog/fixtures.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from '../link/rig.ts';
import { queryEnv } from '../query/env.ts';
import { HubQuery } from '../query/service.ts';
import { listSources } from '../query/sources.ts';
import { HubGraph } from './graph.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);

const notes = system('notes', { description: 'Notes.' }).with({
  types: { Note: type({ description: 'A note.', shape: g.obj({ id: g.text(), text: g.text() }), display: { label: 'Note', title: 'id' } }) },
  kinds: { saved: kind({ description: 'A saved note search.', applicability: 'When a search is kept.', payload: g.obj({ text: g.text() }) }) },
  fns: {
    read: fn({ description: 'Read a note.', args: g.obj({ id: g.text() }), returns: g.text(), effects: { mode: 'read' } }),
    keep: fn({ description: 'Keep a search as a fn.', args: g.obj({ text: g.text() }), returns: g.text(), effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: 'notes/saved' }] } }),
  },
  context: { guide: context({ description: 'How notes work.', content: 'Read one with @notes/read.' }) },
});

const tasks = system('tasks', { description: 'Tasks.' }).with({
  fns: { add: fn({ description: 'Add a task from a note.', args: g.obj({ note: notes.types.Note }), returns: g.bool(), deps: { read: notes.fns.read }, effects: { mode: 'write' } }) },
});

let rig: LinkRig;
let graph: HubGraph;
const access = openScope(ActorId.parse('act_admin'));

beforeEach(async () => {
  rig = await linkRig();
  for (const contract of [notes, tasks]) {
    const fake = new FakeSystem(rig.app, contract.name, await manifestFor(contract));
    await pairDirectly(rig, fake);
    await fake.start();
  }
  // the fns module keeps these as it works out facts; the graph reads them as they are
  await rig.store.table('fnUses').put({ fn: q('tasks/add'), uses: q('notes/read') });
  await rig.store.table('fnTypes').put({ fn: q('notes/read'), type: q('notes/Note'), use: 'read' });
  graph = new HubGraph({ store: rig.store, catalog: rig.catalog, limit: 200 });
});
afterEach(() => rig.stop());

const ids = (page: GraphPage): string[] => page.nodes.map((n) => n.id).sort();
const edges = (page: GraphPage): string[] => page.edges.map((e) => e.label).sort();

describe('the system graph', () => {
  it('draws a system\'s own nodes and edges, and what it references elsewhere greyed', async () => {
    const page = await graph.query({ systems: [SystemName.parse('tasks')] }, access);
    expect(ids(page)).toEqual(expect.arrayContaining(['fn:tasks/add', 'system:tasks', 'instance:tasks/main', 'fn:notes/read']));
    expect(page.nodes.find((n) => n.id === 'fn:tasks/add')).toMatchObject({ external: false, facts: { mode: 'write', on: true, stage: 'live' } });
    expect(page.nodes.find((n) => n.id === 'fn:notes/read')).toMatchObject({ external: true, system: 'notes' });
    expect(edges(page)).toEqual(expect.arrayContaining(['tasks/add calls notes/read', 'tasks/add belongs to tasks']));
    // asked not to, it leaves the references out
    expect(ids(await graph.query({ systems: [SystemName.parse('tasks')], external: false }, access))).not.toContain('fn:notes/read');
  });

  it('draws effects, kinds, types and context links', async () => {
    const page = await graph.query({ systems: [SystemName.parse('notes')] }, access);
    expect(edges(page)).toEqual(expect.arrayContaining([
      'notes/keep creates notes/saved fns', 'notes/read reads notes/Note', 'notes/guide mentions notes/read', 'notes/saved belongs to notes',
    ]));
    expect(page.nodes.find((n) => n.id === 'fn:notes/keep')?.facts.effects).toEqual([{ thing: 'fns', action: 'create', kind: 'notes/saved' }]);
  });
});

describe('filters', () => {
  const fnsOnly: Filter = { field: 'nodeKind', op: 'is', value: 'fn' };

  it('keeps node and edge kinds, fn modes and text, by the query standard\'s filters', async () => {
    const calls = await graph.query({ filters: [fnsOnly, { field: 'edgeKind', op: 'in', values: ['calls'] }] }, access);
    expect(ids(calls)).toEqual(['fn:notes/keep', 'fn:notes/read', 'fn:tasks/add']);
    expect(edges(calls)).toEqual(['tasks/add calls notes/read']);
    expect(ids(await graph.query({ filters: [fnsOnly, { field: 'mode', op: 'is', value: 'write' }] }, access))).toEqual(['fn:notes/keep', 'fn:tasks/add']);
    expect(ids(await graph.query({ text: 'search', filters: [{ field: 'nodeKind', op: 'in', values: ['fn', 'kind'] }] }, access))).toEqual(['fn:notes/keep', 'kind:notes/saved']);
    // a negation and a contains, as any list takes them
    expect(ids(await graph.query({ filters: [fnsOnly, { field: 'system', op: 'isNot', value: 'notes' }] }, access))).toEqual(['fn:tasks/add']);
    expect(ids(await graph.query({ filters: [fnsOnly, { field: 'name', op: 'contains', value: 'kee' }] }, access))).toEqual(['fn:notes/keep']);
  });

  it('keeps what fns belong to under a fn-fact filter, and reads only the systems a system filter names', async () => {
    const effects = await graph.query({ filters: [{ field: 'effect', op: 'is', value: 'fns' }] }, access);
    expect(ids(effects)).toContain('fn:notes/keep');
    expect(ids(effects)).not.toContain('fn:notes/read');
    expect(ids(effects)).toEqual(expect.arrayContaining(['system:notes', 'kind:notes/saved']));
    expect(effects.nodes.every((n) => ['fn', 'system', 'kind', 'type'].includes(n.kind))).toBe(true);
    const notes = await graph.query({ filters: [{ field: 'system', op: 'is', value: 'notes' }], external: false }, access);
    expect(notes.nodes.length).toBeGreaterThan(0);
    expect(notes.nodes.every((n) => n.system === 'notes')).toBe(true);
    const live = await graph.query({ filters: [fnsOnly, { field: 'stage', op: 'is', value: 'live' }, { field: 'on', op: 'is', value: true }] }, access);
    expect(ids(live)).toEqual(['fn:notes/keep', 'fn:notes/read', 'fn:tasks/add']);
  });

  it('refuses a filter the graph list does not take, with the problem in words', async () => {
    await expect(graph.query({ filters: [{ field: 'cost', op: 'gt', value: 1 }] }, access)).rejects.toThrow(/no filterable field "cost"/);
    await expect(graph.query({ filters: [{ field: 'on', op: 'contains', value: 'x' }] }, access)).rejects.toThrow(/does not take/);
  });

  it('serves the graph list through the query service: hub/query pages its nodes, listValues offers its systems', async () => {
    const lists = new HubQuery(listSources({ store: rig.store, catalog: rig.catalog, access: { scope: () => Promise.resolve(access) } }, queryEnv.parse()));
    const viewer = { id: ActorId.parse('act_admin'), role: 'admin' as const };
    const page = await lists.query({ list: 'graph', query: { filters: [fnsOnly], limit: 2 } }, viewer);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.cursor).toBe('2');
    const systems = await lists.values({ list: 'graph', field: 'system' }, viewer);
    expect(systems.map((option) => option.value)).toEqual(expect.arrayContaining(['notes', 'tasks']));
    await expect(lists.query({ list: 'graph', query: { filters: [{ field: 'cost', op: 'gt', value: 1 }] } }, viewer)).rejects.toThrow(/no filterable field/);
  });

  it('focuses on a node and its neighbourhood, reaching into other systems', async () => {
    const page = await graph.query({ focus: { node: 'fn:tasks/add', hops: 1 } }, access);
    // the API index item of its group brings it
    expect(ids(page)).toEqual(['context:tasks/api.general', 'fn:notes/read', 'fn:tasks/add', 'system:tasks']);
    const two = await graph.query({ focus: { node: 'fn:tasks/add', hops: 2 } }, access);
    expect(ids(two)).toEqual(expect.arrayContaining(['type:notes/Note', 'context:notes/guide', 'system:notes']));
  });

  it('collapses a system into one node, and caps with "+N more"', async () => {
    const collapsed = await graph.query({ collapse: [SystemName.parse('notes')] }, access);
    expect(collapsed.nodes.find((n) => n.id === 'system:notes')?.collapsed).toBeGreaterThan(3);
    expect(ids(collapsed).filter((id) => id.includes('notes/'))).toEqual([]);
    expect(edges(collapsed)).toContain('tasks/add calls notes');

    const capped = await graph.query({ systems: [SystemName.parse('notes')], limit: 2 }, access);
    expect(capped.nodes).toHaveLength(2);
    expect(capped.total.nodes).toBeGreaterThan(2);
    expect(capped.more.length).toBeGreaterThan(0);
    expect(capped.edges.every((e) => capped.nodes.some((n) => n.id === e.from) && capped.nodes.some((n) => n.id === e.to))).toBe(true);
  });
});
