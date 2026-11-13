/**
 * The widget pieces every side shares: a declared visual and its fit, the widget's args and controls, every problem a
 * check finds (and which visuals survive), the strict authoring schema, the derived row actions, a visual judged by its
 * declared shape alone, and an authoring agent that skips `find` and names its tools for widgets.
 */
import { mintId, type GinTypeDef, type LlmForward, type LlmForwardChunk, type ResultTable, type WidgetSpec } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { z } from 'zod';
import { authoringAgent, authoringTool, type AuthoredFn } from './authoring.ts';
import { DECLARED_FIT_SCORE, client } from './client.ts';
import { g, wireType } from './gin.ts';
import { FakeModelLink, fakeHubAi, replyChunks } from './server/fake-models.ts';
import { system } from './system.ts';
import { HUB_VISUALS, channel, checkWidget, fittingVisuals, visual, widgetActionOptions, widgetArgs, widgetControls, widgetSpecSchema } from './widgets.ts';

const bar = visual({ name: 'bar', label: 'Bar chart', shape: { channels: [channel('label', 'Label', ['text']), channel('value', 'Value', ['integer', 'number'])], rows: { min: 1, max: 50 }, whole: false } });
const pie = visual({ name: 'pie', label: 'Pie', shape: { channels: [channel('label', 'Slice', ['text']), channel('value', 'Size', ['integer'])], rows: { min: 1, max: 8 }, whole: true } });
const VISUALS = [bar, pie];

const SOURCE_ARGS: GinTypeDef = wireType(g.obj({ status: g.text(), owner: g.optional(g.text()), offset: g.optional(g.num({ whole: true })), limit: g.optional(g.num({ whole: true })) }));

const TABLE: ResultTable = {
  columns: [{ name: 'owner', kind: 'text', nullable: false }, { name: 'open', kind: 'integer', nullable: false }, { name: 'id', kind: 'text', nullable: false, ref: 'tasks/Task' }],
  rows: [['ann', 3, 'rec_1'], ['bo', 5, 'rec_2']],
  offset: 0, limit: 2, truncated: true, sort: [],
};

const SPEC: WidgetSpec = {
  title: 'Open tasks by owner',
  source: 'tasks/open_by_owner',
  visuals: [{ visual: 'bar', bind: { label: ['owner'], value: ['open'] } }],
  controls: [{ arg: 'status', choices: ['open', 'done'], pinned: 'open' }, { arg: 'owner', label: 'Who' }],
  paging: { offset: 'offset', limit: 'limit', size: 2 },
};

describe('visuals', () => {
  it('declares a contribution to the hub registry with its shape, and lists the ones whose shape fits', () => {
    expect(bar).toMatchObject({ registry: HUB_VISUALS, name: 'bar', shape: { whole: false } });
    // the table is one page of more: a whole visual (pie) doesn't fit, unless the widget pages it
    expect(fittingVisuals(TABLE, VISUALS).map((v) => v.name)).toEqual(['bar']);
    expect(fittingVisuals(TABLE, VISUALS, true).map((v) => v.name)).toEqual(['bar', 'pie']);
  });

  it('judges a client visual by its declared shape when it has no match of its own', () => {
    const contract = system('charts', { description: 'Charts.', contributes: [bar] });
    const module = client(contract, { visuals: { [HUB_VISUALS]: { bar: { component: defineComponent({ render: () => null }) } } } });
    expect(module.renderers.visuals?.[HUB_VISUALS]?.['bar'] !== undefined && 'match' in module.renderers.visuals[HUB_VISUALS]['bar']).toBe(false);
    const bare = system('bare', { description: 'No shape.', contributes: [{ registry: HUB_VISUALS, name: 'dots', label: 'Dots' }] });
    expect(() => client(bare, { visuals: { [HUB_VISUALS]: { dots: { component: defineComponent({ render: () => null }) } } } })).toThrow(/needs a match or a declared shape/);
    expect(DECLARED_FIT_SCORE).toBeGreaterThan(0);
  });
});

describe('a widget spec', () => {
  it('takes its source args minus the pinned ones and the page size, and shows a control for the rest', () => {
    expect(Object.keys(widgetArgs(SOURCE_ARGS, SPEC).props ?? {})).toEqual(['owner', 'offset']);
    expect(widgetControls(SOURCE_ARGS, SPEC)).toEqual([{ arg: 'owner', label: 'Who', type: { name: 'text' }, required: false, custom: true }]);
  });

  it('checks clean against a real result, and lists every problem of a broken one', () => {
    expect(checkWidget(SPEC, { args: SOURCE_ARGS, table: TABLE, visuals: VISUALS })).toEqual({ visuals: SPEC.visuals, problems: [] });
    const broken: WidgetSpec = {
      ...SPEC,
      visuals: [{ visual: 'bar', bind: { label: ['open'], size: ['open'] } }, { visual: 'map', bind: {} }, { visual: 'pie', bind: { value: ['missing'] } }],
      controls: [{ arg: 'status', hidden: true }, { arg: 'nope' }],
      paging: { offset: 'status', size: 2 },
      actions: [{ fn: 'tasks/Task.close', bind: { reason: 'gone' }, then: 'refresh' }],
    };
    const { visuals, problems } = checkWidget(broken, { args: SOURCE_ARGS, table: TABLE, visuals: VISUALS });
    expect(visuals).toEqual([]);
    expect(problems).toEqual([
      'Control status is hidden, but the arg is required: pin a value or show it.',
      'Control nope: tasks/open_by_owner has no arg nope.',
      'Paging offset: arg status is not a number.',
      'Arg status is driven by the pager, so it can\'t have a control too.',
      'Visual bar: channel label takes text, but column open is integer.',
      'Visual bar has no channel size (it has label, value).',
      'Visual map is not in hub/visuals.',
      'Visual pie: channel value binds column missing, which the result lacks.',
      'Action tasks/Task.close: arg reason binds column gone, which the result lacks.',
    ]);
  });

  it('drafts against a strict schema built from the args, columns and fitting visuals', () => {
    const schema = widgetSpecSchema({ source: SPEC.source, args: SOURCE_ARGS, columns: TABLE.columns, visuals: fittingVisuals(TABLE, VISUALS), actions: ['tasks/Task.close'] });
    expect(schema.safeParse(SPEC).success).toBe(true);
    expect(schema.safeParse({ ...SPEC, source: 'tasks/other' }).success).toBe(false);
    expect(schema.safeParse({ ...SPEC, visuals: [{ visual: 'pie', bind: {} }] }).success).toBe(false);
    expect(schema.safeParse({ ...SPEC, visuals: [{ visual: 'bar', bind: { value: ['owner'] } }] }).success).toBe(false);
    expect(schema.safeParse({ ...SPEC, controls: [{ arg: 'nope' }] }).success).toBe(false);
  });

  it('offers a row type\'s methods as actions, confirming anything above a read, with a form for unbound args', () => {
    const rowFns = [
      { fn: 'tasks/Task.show', mode: 'read' as const, args: wireType(g.obj({ self: g.text() })) },
      { fn: 'tasks/Task.close', mode: 'write' as const, args: wireType(g.obj({ self: g.text(), reason: g.text() })) },
    ] as const;
    expect(widgetActionOptions(rowFns, undefined)).toEqual([
      { fn: 'tasks/Task.show', label: 'Show', mode: 'read', confirm: false, bind: {}, then: 'show' },
      { fn: 'tasks/Task.close', label: 'Close', mode: 'write', confirm: true, bind: {}, form: { name: 'obj', props: { reason: { type: { name: 'text' } } } }, then: 'refresh' },
    ]);
    expect(widgetActionOptions(rowFns, [{ fn: 'tasks/Task.show', label: 'Open', confirm: true, bind: {}, then: 'none' }, { fn: 'tasks/Gone.x', bind: {}, then: 'none' }]))
      .toEqual([{ fn: 'tasks/Task.show', label: 'Open', mode: 'read', confirm: true, bind: {}, then: 'none' }]);
  });
});

/** A reply that calls one tool. */
function callTool(name: string, args: object): LlmForwardChunk[] {
  return [
    { type: 'chunk', chunk: { toolCall: { id: mintId('llmInteraction'), name, arguments: JSON.stringify(args) } } },
    { type: 'chunk', chunk: { finishReason: 'tool_calls' } },
    { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'fake/model' },
  ];
}

const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

describe('an authoring agent for widgets', () => {
  it('skips find, drafts with widget_check against the strict schema and saves with widget_save', async () => {
    const saved: AuthoredFn = { fn: 'hub/open_by_owner_widget', version: 1, signature: 'hub/open_by_owner_widget(owner?: text)', about: 'Open tasks by owner.', reused: false, call: 'hub/open_by_owner_widget({})' };
    const source = authoringTool<{ table: ResultTable }, WidgetSpec, object>({
      name: 'widget_source', stage: 'inspect', description: 'The source args and a sample.', schema: z.object({}), call: () => 'owner: text, open: integer',
    });
    const agent = authoringAgent<{ table: ResultTable }, WidgetSpec>({
      name: 'make_widget', description: 'Make a widget.', instructions: 'Inspect the source, draft, check, save.', tools: [source],
      stages: { find: false }, toolNames: { draft: 'widget_check', save: 'widget_save' },
      draft: { description: 'The widget spec.', schema: (s) => widgetSpecSchema({ source: SPEC.source, args: SOURCE_ARGS, columns: s.state.table.columns, visuals: fittingVisuals(s.state.table, VISUALS, true) }) },
      check: (draft, s) => Promise.resolve({ problems: checkWidget(draft, { args: SOURCE_ARGS, table: s.state.table, visuals: VISUALS }).problems }),
      save: () => Promise.resolve(saved),
    });
    const script = [callTool('widget_source', {}), callTool('widget_check', { draft: SPEC }), callTool('widget_save', {}), replyChunks('Saved.')];
    const link = new FakeModelLink({ reply: () => script.shift() ?? replyChunks('done') });
    const { result, session } = await agent.run(await fakeHubAi(link), 'Open tasks by owner as bars', { table: TABLE });
    expect(result).toEqual(saved);
    expect(offered(link.forwards[0])).toEqual(['widget_source']);
    expect(session.log.map((step) => step.tool)).toEqual(['widget_source', 'widget_check', 'widget_save']);
  });

  it('refuses find tools when it skips find', () => {
    const search = authoringTool<object, WidgetSpec, object>({ name: 'search', stage: 'find', description: 'x', schema: z.object({}), call: () => '' });
    expect(() => authoringAgent<object, WidgetSpec>({
      name: 'w', description: 'w', instructions: 'w', tools: [search], stages: { find: false },
      draft: { description: 'x', schema: widgetSpecSchema({ source: SPEC.source, args: SOURCE_ARGS, columns: [], visuals: [] }) },
      check: () => Promise.resolve({ problems: [] }), save: () => Promise.reject(new Error('no')),
    })).toThrow(/skips find/);
  });
});
