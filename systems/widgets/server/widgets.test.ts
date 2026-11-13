/**
 * The widgets system with the SDK test kit and a scripted hub: a saved widget's run (args resolved, the source read as
 * a child run with the pager's window, bindings checked against the real columns, the table last, the chip row, the
 * pager and the row actions; rows from a write read-only), `make_widget`'s agent (source first, then a proposal against
 * the strict schema, checked by a real preview, offered and never saved), and `save_widget` (the person's own fn, the
 * next free name, saving over the widget it changes).
 */
import { Json, QualifiedName, ResultTable, WIDGET_KIND, jsonOf, mintId, type GinTypeDef, type LlmForward, type RunSettled, WidgetResult, type WidgetSpec } from '@harness/core';
import { ginAs, hub, wireType } from '@harness/sdk';
import { mockModel, replyChunks, testHub, toolCall, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { widgets } from '../shared/index.ts';
import { widgetsEnv } from './env.ts';
import { createWidgetsImpl } from './impl.ts';

widgetsEnv.set({ WIDGETS_WINDOW: '3', WIDGETS_SAMPLE_ROWS: '2' });

const SOURCE = QualifiedName.parse('database/main.tasks_by_stage');
const optional = (type: GinTypeDef): GinTypeDef => ({ name: 'optional', generic: { T: type } });
/** The source's args: an optional owner, a required day, and the pager's limit and offset. */
const SOURCE_ARGS: GinTypeDef = {
  name: 'obj',
  props: { owner: { type: optional({ name: 'text' }) }, since: { type: { name: 'date' } }, limit: { type: optional({ name: 'num' }) }, offset: { type: optional({ name: 'num' }) } },
};

/** Tasks counted by stage, with the task type each row refers to. */
function tasks(extra: Partial<ResultTable> = {}): ResultTable {
  return {
    columns: [{ name: 'stage', kind: 'text', nullable: false }, { name: 'count', kind: 'integer', nullable: false }, { name: 'task', kind: 'text', nullable: false, ref: QualifiedName.parse('tasks/Task') }],
    rows: [['todo', 4, 't1'], ['doing', 2, 't2'], ['done', 7, 't3']], offset: 0, truncated: false, sort: [], ...extra,
  };
}

/** A widget over the source: bars of count by stage, a stale line chart, the owner as a chip, `since` a week ago. */
const SPEC: WidgetSpec = {
  title: 'Tasks by stage',
  source: SOURCE,
  visuals: [
    { visual: 'table', style: 'table', bind: {} },
    { visual: 'category', style: 'bar', bind: { x: ['stage'], y: ['count'] } },
    { visual: 'time', style: 'line', bind: { time: ['gone'] } },
  ],
  args: { since: { show: 'pinned', value: { relative: 'today-7d' } }, owner: { show: 'control', label: 'Owner', choices: [{ label: 'Ann', value: { literal: 'ann' } }] } },
  presets: [{ label: 'Mine', sets: { owner: { literal: 'me' } } }],
  paging: { offset: 'offset', limit: 'limit' },
};

const done = (result: Json): RunSettled => ({ status: 'done', result });

/**
 * Script the hub: every child run reported as the real hub does, the source's declaration (`hub/fn_get`), its rows
 * (through `hub/read_table`), and the task's close method; the visual registry and
 * row actions are the kit's own (`kit.hub.widgets`).
 */
function scriptHub(kit: TestSystem<'widgets', typeof widgets.defs>, table: () => ResultTable, returns: GinTypeDef = wireType(ginAs(ResultTable))): Array<{ fn: string; args: Json }> {
  const seen: Array<{ fn: string; args: Json }> = [];
  kit.hub.widgets.table(SOURCE, () => table());
  kit.hub.widgets.rowFns(QualifiedName.parse('tasks/Task'), [{ fn: QualifiedName.parse('tasks/Task.close'), mode: 'write', args: { name: 'obj', props: {} }, returnsTable: false }]);
  const stored = { fn: SOURCE, kind: 'database/query', description: 'Tasks counted by stage.', version: 1, available: true, args: SOURCE_ARGS, returns };
  kit.hub.onCall = async (call) => {
    seen.push({ fn: call.fn, args: call.args });
    await kit.hub.peer().call('child', { parent: call.parent, key: call.key, run: mintId('run') });
    if (call.fn === hub.fns.fn_get.name) { return done(Json.parse(stored)); }
    return kit.hub.widgets.settle(call) ?? kit.hub.fns.settle(call) ?? done(null);
  };
  return seen;
}

/** A done outcome's result. */
function resultOf(outcome: Awaited<ReturnType<TestSystem<'widgets', typeof widgets.defs>['hub']['run']>>): Json {
  if (outcome.status !== 'done') { throw new Error(`The run ended ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

let kit: TestSystem<'widgets', typeof widgets.defs> | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

describe('the widget kind', () => {
  it('reads its source with resolved args and the window, keeps the visuals that draw, the table last, and lists what broke', async () => {
    kit = await testHub(widgets, createWidgetsImpl({ settings: widgetsEnv.parse() }), { config: {} });
    const seen = scriptHub(kit, () => tasks());
    const run = kit.hub.runInfo(QualifiedName.parse('widgets/tasks_by_stage'));
    const out = resultOf(await kit.hub.run('widgets/tasks_by_stage', { owner: 'ann' }, { kind: WIDGET_KIND, payload: jsonOf(SPEC), run: { ...run, time: { ...run.time, now: Date.parse('2026-03-15T10:00:00Z') } } }));
    const result = WidgetResult.parse(out);
    // pinned relative day resolved in the person's zone, the chip given, the first window
    expect(seen.find((call) => call.fn === hub.fns.read_table.name)?.args).toEqual({ fn: SOURCE, args: { since: '2026-03-08', owner: 'ann', offset: 0, limit: 3 } });
    expect(result.visuals.map((v) => v.visual)).toEqual(['category', 'table']);
    expect(result.problems.join(' ')).toContain('Visual time');
    expect(result.controls.map((c) => [c.arg, c.label, c.value])).toEqual([['owner', 'Owner', { literal: 'ann' }]]);
    expect(result.controls[0]?.choices?.[0]).toEqual({ label: 'Any' });
    expect(result.paging).toEqual({ offset: 'offset', limit: 'limit', window: 3, more: true });
    expect(result.actions.map((a) => a.fn)).toEqual(['tasks/Task.close']);
    expect(seen.find((call) => call.fn === hub.fns.row_actions.name)?.args).toEqual({ types: ['tasks/Task'] });
    expect(result.readOnly).toBe(false);
    expect(result.summary).toBe('Bars of count by stage, 3 rows');
    expect(result.facts.whole).toBe(true);
  });

  it('shows rows from a write read-only: no chips, presets, pager or drill; row actions stay', async () => {
    kit = await testHub(widgets, createWidgetsImpl({ settings: widgetsEnv.parse() }), { config: {} });
    scriptHub(kit, () => tasks({ write: { affected: 3 } }));
    const result = WidgetResult.parse(resultOf(await kit.hub.run('widgets/tasks_by_stage', {}, { kind: WIDGET_KIND, payload: jsonOf({ ...SPEC, drill: { fn: SOURCE, label: 'Stage', bind: { owner: 'stage' } } }) })));
    expect(result).toMatchObject({ readOnly: true, controls: [], presets: [] });
    expect(result.paging).toBeUndefined();
    expect(result.drill).toBeUndefined();
    expect(result.actions).toHaveLength(1);
  });

  it('describes a widget as a read that depends on its source and returns a widget result', async () => {
    kit = await testHub(widgets, createWidgetsImpl({ settings: widgetsEnv.parse() }), { config: {} });
    const props = await kit.kindProps('widget', SPEC);
    expect(props.problems).toEqual([]);
    expect(props.description?.deps).toEqual([SOURCE, 'hub/fn_get', 'hub/read_table', 'hub/visuals', 'hub/row_actions']);
    expect(props.description?.effects).toEqual({ mode: 'read' });
  });
});

/** The tools a forward offered, sorted. */
const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

describe('make_widget', () => {
  it('reads the source first, proposes against the strict schema, checks it with a real preview, and never saves', async () => {
    const proposal = {
      name: 'tasks_by_stage', description: 'Tasks counted by stage.', title: 'Tasks by stage',
      choice: { visual: 'category', style: 'bar' }, more: ['table'],
      args: { owner: { show: 'control', label: 'Owner' }, since: { show: 'pinned', value: { relative: 'startOf(month)' } } },
      presets: [],
    };
    const model = mockModel([toolCall('source', {}), toolCall('propose', { draft: proposal }), toolCall('offer', {}), replyChunks('Proposed.')]);
    kit = await testHub(widgets, createWidgetsImpl({ settings: widgetsEnv.parse() }), { config: {}, model });
    const seen = scriptHub(kit, () => tasks());
    const made = await kit.call('make_widget', { source: SOURCE, request: 'tasks by stage as bars, the owner as a chip, this month', args: { since: '2026-03-01' }, show: true });
    expect(made.result).toMatchObject({ name: 'tasks_by_stage', show: true, spec: { source: SOURCE, paging: { offset: 'offset', limit: 'limit' }, visuals: [{ visual: 'category', style: 'bar' }, { visual: 'table' }] } });
    expect(made.result.preview.problems).toEqual([]);
    expect(made.result.preview.visuals.map((v) => v.visual)).toEqual(['category', 'table']);
    // the sample is a small window; nothing was kept
    expect(seen.find((call) => call.fn === hub.fns.read_table.name)?.args).toEqual({ fn: SOURCE, args: { since: '2026-03-01', offset: 0, limit: 2 } });
    expect(seen.some((call) => call.fn === hub.fns.save_fn.name)).toBe(false);
    // a required arg with no sample value is refused before the agent starts
    await expect(kit.call('make_widget', { source: SOURCE, request: 'tasks by stage', show: false })).rejects.toThrow(/needs since/);
    const forwards = made.hubCalls.forwards;
    expect(offered(forwards[0])).toEqual(['source']);
    expect(offered(forwards[1])).toEqual(['propose']);
    expect(offered(forwards[2])).toContain('offer');
    expect(JSON.stringify(forwards[1]?.request.messages)).toContain('Bars');
  });
});

describe('save_widget', () => {
  it('keeps the widget as the person’s own, takes the next free name, and saves over the widget it changes', async () => {
    kit = await testHub(widgets, createWidgetsImpl({ settings: widgetsEnv.parse() }), { config: {} });
    scriptHub(kit, () => tasks());
    const first = await kit.call('save_widget', { name: 'tasks_by_stage', description: 'Tasks by stage.', spec: SPEC });
    expect(first.result).toEqual({ fn: 'widgets/tasks_by_stage', version: 1, created: true });
    expect(kit.hub.fns.kept.get('widgets/tasks_by_stage')?.saved).toMatchObject({ kind: WIDGET_KIND, share: { visibility: 'private', with: [] } });
    const second = await kit.call('save_widget', { name: 'tasks_by_stage', description: 'Again.', spec: SPEC });
    expect(second.result.fn).toBe('widgets/tasks_by_stage_2');
    const changed = await kit.call('save_widget', { name: 'tasks_by_stage', description: 'As a pie.', spec: SPEC, replace: 'widgets/tasks_by_stage' });
    expect(changed.result).toEqual({ fn: 'widgets/tasks_by_stage', version: 2, created: false });
  });

  it('refuses a widget whose source does not return a table or does not take its plans', async () => {
    kit = await testHub(widgets, createWidgetsImpl({ settings: widgetsEnv.parse() }), { config: {} });
    scriptHub(kit, () => tasks(), { name: 'text' });
    const spec: WidgetSpec = { ...SPEC, args: { ...SPEC.args, region: { show: 'pinned', value: { literal: 'north' } } } };
    await expect(kit.call('save_widget', { name: 'tasks_by_stage', description: 'Tasks by stage.', spec })).rejects.toThrow(/does not return a table.*has no arg region/);
    expect(kit.hub.fns.kept.has('widgets/tasks_by_stage')).toBe(false);
  });
});
