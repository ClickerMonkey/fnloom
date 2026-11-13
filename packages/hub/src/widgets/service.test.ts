import {
  ActorId, IDS, Json, noFnStats, QualifiedName, SystemName, TurnId,
  type FnDecl, type FnRecord, type ImportReport, type Manifest, type ResultTable, type RunSettled, type UserInfo, type WidgetSpec,
} from '@harness/core';
import { fn, g, manifestOf, system, type, hub as hubContract } from '@harness/sdk';
import { systemRow } from '../catalog/fixtures.ts';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import type { RunInput } from '../execution/index.ts';
import { testStore } from '../testing.ts';
import { describeWidget, WidgetService } from './service.ts';

const ANN = ActorId.parse('act_ann');
const TASKS = QualifiedName.parse('tasks/open');
const USER: UserInfo = { id: ANN, name: 'Ann', email: 'ann@example.com', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' };
const AGENT = ActorId.parse('act_agent');
const BOB = ActorId.parse('act_bob');
const RUN = { id: IDS.run.parse('run_1'), turn: TurnId.parse('trn_1'), user: USER, caller: AGENT };

/** A fn record of a native fn. */
function record(name: QualifiedName, decl: Partial<FnDecl>): FnRecord {
  const local = name.slice(name.indexOf('/') + 1);
  return {
    name, system: SystemName.parse(name.slice(0, name.indexOf('/'))), version: 'v1', origin: 'contract', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0,
    decl: {
      name: local, description: `The ${local} fn.`, kind: 'native', args: { name: 'obj', props: {} }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [], ...decl,
    },
  };
}

const SOURCE = record(TASKS, {
  args: { name: 'obj', props: { owner: { type: { name: 'text' } }, offset: { type: { name: 'optional', generic: { T: { name: 'num' } } } }, limit: { type: { name: 'optional', generic: { T: { name: 'num' } } } } } },
});
const DONE = record(QualifiedName.parse('tasks/Task.done'), { args: { name: 'obj', props: { self: { type: { name: 'text' } } } } });
const CLOSE = record(QualifiedName.parse('tasks/close'), { args: { name: 'obj', props: { id: { type: { name: 'text' } } } } });
const RENAME = record(QualifiedName.parse('tasks/Task.rename'), { args: { name: 'obj', props: { self: { type: { name: 'text' } }, title: { type: { name: 'text' } } } } });
const TABLE: ResultTable = {
  columns: [{ name: 'title', kind: 'text', nullable: false }, { name: 'id', kind: 'text', nullable: false, ref: QualifiedName.parse('tasks/Task') }],
  rows: [['Pay rent', 'rec_1']], offset: 0, truncated: false, sort: [],
};
const SPEC: WidgetSpec = {
  title: 'Open tasks', source: TASKS, visuals: [{ visual: 'table', bind: {} }, { visual: 'bars', bind: { value: ['stars'] } }],
  controls: [{ arg: 'owner', pinned: 'ann' }], paging: { offset: 'offset', limit: 'limit', size: 25 },
};

async function world() {
  const store = await testStore();
  await store.table('systems').put(systemRow('tasks', 'connected'));
  const hubManifest = await manifestOf(hubContract, { version: '1' });
  const tasksManifest: Manifest = await manifestOf(system('tasks', { description: 'Tasks.' }).with({
    types: {
      Task: type({
        description: 'A task.', shape: g.obj({ title: g.text() }), display: { label: 'Task' },
        methods: { done: fn({ description: 'Mark it done.', args: g.obj({}), returns: g.bool() }), rename: fn({ description: 'Rename it.', args: g.obj({ title: g.text() }), returns: g.bool() }) },
      }),
    },
  }), { version: '1' });
  const fns = new Map<string, FnRecord>([[TASKS, SOURCE], [DONE.name, DONE], [RENAME.name, RENAME], [CLOSE.name, CLOSE]]);
  const started: RunInput[] = [];
  const declared: FnDecl[] = [];
  const owners = new Map<string, ActorId>();
  const widgets = new WidgetService({
    catalog: () => ({
      fn: (name) => Promise.resolve(fns.get(name)),
      entries: () => Promise.resolve([]),
      manifest: (system) => Promise.resolve(system === 'hub' ? hubManifest : system === 'tasks' ? tasksManifest : undefined),
      declare: (_system, decl): Promise<ImportReport> => { declared.push(decl); return Promise.resolve({ added: [QualifiedName.parse(`hub/${decl.name}`)], updated: [], removed: [], refused: [] }); },
    }),
    runs: () => ({
      start: (input) => {
        started.push(input);
        const settled: RunSettled = { status: 'done', result: Json.parse(TABLE) };
        return Promise.resolve({ run: IDS.run.parse(`run_child${String(started.length)}`), settled: Promise.resolve(settled) });
      },
    }),
    facts: () => ({ modes: (names) => Promise.resolve(new Map(names.map((name) => [name, name === DONE.name ? 'write' as const : 'read' as const]))) }),
    store: () => store,
    access: (actor) => Promise.resolve({ ...openScope(actor), admin: false }),
    sharing: () => ({
      sharing: (target) => Promise.resolve({ owner: owners.get(target.kind === 'fn' ? target.fn : '') ?? ANN, visibility: 'private', with: [] }),
      own: (target, owner, rule) => { owners.set(target.kind === 'fn' ? target.fn : '', owner); return Promise.resolve({ target, sharing: { owner, ...rule }, editable: true }); },
    }),
  });
  return { widgets, started, declared, fns, owners };
}

describe('widgets', () => {
  it('describe a widget as its source minus the pinned args and the page size, depending on it', async () => {
    const described = await describeWidget((name) => Promise.resolve(name === TASKS ? SOURCE : undefined), Json.parse(SPEC));
    expect(described.problems).toEqual([]);
    expect(Object.keys(described.description?.args.props ?? {})).toEqual(['offset']);
    expect(described.description?.deps).toEqual([TASKS]);
    expect((await describeWidget(() => Promise.resolve(undefined), Json.parse(SPEC))).problems).toEqual(['there is no fn tasks/open to draw']);
    expect((await describeWidget(() => Promise.resolve(SOURCE), { title: 'x' })).problems.length).toBeGreaterThan(0);
  });

  it('run their source as a child run with the pinned values and the asked page, listing bindings that no longer fit', async () => {
    const { widgets, started } = await world();
    const widget = record(QualifiedName.parse('hub/open_tasks'), { kind: 'hub/widget', payload: Json.parse(SPEC) });
    const result = await widgets.run(widget, {}, RUN);
    // the source is called by the run's own caller (an agent stays an agent), never as the person by hand
    expect(started[0]).toMatchObject({ fn: TASKS, args: { owner: 'ann', offset: 0, limit: 25 }, parent: RUN.id, turn: RUN.turn, actor: ANN, caller: AGENT });
    expect(result.paging).toEqual({ arg: 'offset', size: 25 });
    await widgets.run(widget, { offset: 25, limit: 1000 }, RUN);
    expect(started[1]).toMatchObject({ args: { owner: 'ann', offset: 25, limit: 25 }, key: 'source:25' });
    expect(result).toMatchObject({ title: 'Open tasks', table: TABLE, source: { fn: TASKS, run: 'run_child1' } });
    expect(result.visuals.map((v) => v.visual)).toEqual(['table']);
    expect(result.problems).toEqual(['Visual bars is not in hub/visuals.']);
  });

  it('sample a source with args given as an object or as JSON text, and refuse args that are not an object', async () => {
    const { widgets, started } = await world();
    await widgets.source(TASKS, { owner: 'ann' }, RUN);
    await widgets.source(TASKS, '{"owner": "bob"}', RUN);
    expect(started.map((input) => input.args)).toEqual([{ owner: 'ann', limit: 5 }, { owner: 'bob', limit: 5 }]);
    await expect(widgets.source(TASKS, 'ann', RUN)).rejects.toThrow(/args must be an object/);
    // a source that is not a read is refused before anything runs
    await expect(widgets.source(DONE.name, { self: 'rec_1' }, RUN)).rejects.toThrow(/writes, so it can't be a widget's source/);
    await expect(widgets.fits(DONE.name, {}, RUN)).rejects.toThrow(/writes/);
    expect(started).toHaveLength(2);
  });

  it('offer each row type\'s methods as actions, confirming what is not a read, and save widgets as hub fns', async () => {
    const { widgets, declared, fns } = await world();
    const actions = await widgets.actions({ types: [QualifiedName.parse('tasks/Task')] }, ANN);
    expect(actions.map((a) => [a.fn, a.label, a.confirm])).toEqual([['tasks/Task.done', 'Done', true], ['tasks/Task.rename', 'Rename', false]]);
    expect(actions[1]?.form?.props).toHaveProperty('title');
    // a widget's own list narrows the methods, and may bind any other fn to a row's columns
    const listed = record(QualifiedName.parse('hub/closing_tasks'), { kind: 'hub/widget', payload: Json.parse({ ...SPEC, actions: [{ fn: CLOSE.name, label: 'Close', bind: { id: 'id' }, then: 'refresh' }] }) });
    fns.set(listed.name, listed);
    const bound = await widgets.actions({ types: [QualifiedName.parse('tasks/Task')], widget: listed.name }, ANN);
    expect(bound.map((a) => [a.fn, a.label, a.bind])).toEqual([['tasks/close', 'Close', { id: 'id' }]]);
    expect(await widgets.save({ name: 'open_tasks', description: 'Open tasks.', spec: SPEC }, RUN)).toEqual({ fn: 'hub/open_tasks', created: true });
    expect(declared[0]).toMatchObject({ name: 'open_tasks', kind: 'hub/widget', payload: { source: TASKS } });
  });

  it('save a new widget private to its person, and only its owner saves over it', async () => {
    const { widgets, fns, owners } = await world();
    await widgets.save({ name: 'mine', description: 'Mine.', spec: SPEC }, RUN);
    expect(owners.get('hub/mine')).toBe(ANN);
    fns.set(QualifiedName.parse('hub/mine'), record(QualifiedName.parse('hub/mine'), { kind: 'hub/widget', payload: Json.parse(SPEC) }));
    const bob = { ...RUN, user: { ...USER, id: BOB, name: 'Bob' } };
    await expect(widgets.save({ name: 'mine', description: 'Taken.', spec: SPEC, replace: true }, bob)).rejects.toThrow(/someone else's widget/);
    expect(await widgets.save({ name: 'mine', description: 'Mine again.', spec: SPEC, replace: true }, RUN)).toEqual({ fn: 'hub/mine', created: false });
    // a source that writes is no widget's
    await expect(widgets.save({ name: 'done', description: 'Done.', spec: { ...SPEC, source: DONE.name } }, RUN)).rejects.toThrow(/writes/);
  });
});
