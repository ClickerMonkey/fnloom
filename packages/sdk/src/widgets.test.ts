/**
 * The widget pieces every side shares: a declared visual, column facts with gin facts, coverage-first ranking over
 * contributions, the widget's args, chip row, run args and pager, derived actions and drill args, the table-return
 * check, every problem a check finds, moving to another source, and the strict authoring schema built per call.
 */
import { BUILT_IN_VISUALS, HUB_VISUALS, ResultTable, type ContributionDecl, type GinTypeDef, type WidgetSpec } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { g, wireType } from './gin.ts';
import { checkWidget, sourceCompatible } from './widget-check.ts';
import { widgetProposalSchema } from './widget-schema.ts';
import { ginAs } from './zod-gin.ts';
import {
  BUILT_IN_CONTRIBUTIONS, boundArgs, channel, pagingOf, rangeOf, rankedVisuals, resultFacts, returnsTable, visual, widgetActionOptions, widgetArgs, widgetControls, widgetPager, widgetRunArgs,
} from './widgets.ts';

/** Every built-in family as the hub contributes it, and a system's own waffle after them. */
const waffle = visual({
  name: 'waffle', label: 'Waffle',
  shape: { channels: [channel('itemName', 'Square', ['text'], { role: 'group' }), channel('value', 'Size', ['integer'], { role: 'measure' })], rows: { min: 1, max: 10 }, whole: true },
});
const ENTRIES: ContributionDecl[] = [...BUILT_IN_CONTRIBUTIONS, waffle];

const SOURCE_ARGS: GinTypeDef = wireType(g.obj({
  status: g.enum(['open', 'done']),
  owner: g.optional(g.text()),
  due_from: g.optional(g.date()),
  due_to: g.optional(g.date()),
  offset: g.optional(g.num({ whole: true })),
  limit: g.optional(g.num({ whole: true })),
}));

const TABLE: ResultTable = {
  columns: [
    { name: 'owner', kind: 'text', nullable: false, type: wireType(g.enum(['ann', 'bo'])) },
    { name: 'open', kind: 'integer', nullable: false, type: wireType(g.num({ min: 0, max: 100 })) },
    { name: 'id', kind: 'uuid', nullable: false, ref: 'tasks/Task' },
  ],
  rows: [['ann', 3, '6f1c7c1e-0000-4000-8000-000000000001'], ['bo', 5, '6f1c7c1e-0000-4000-8000-000000000002']],
  offset: 0, truncated: false, sort: [],
};
const FACTS = resultFacts(TABLE);

const SPEC: WidgetSpec = {
  title: 'Open tasks by owner',
  source: 'tasks/open_by_owner',
  visuals: [{ visual: 'category', style: 'bar', bind: { x: ['owner'], y: ['open'] } }, { visual: 'table', style: 'table', bind: {} }],
  args: {
    status: { show: 'pinned', value: { literal: 'open' } },
    owner: { show: 'control', label: 'Who', choices: [{ label: 'Ann', value: { literal: 'ann' } }] },
  },
  presets: [{ label: 'Due this week', sets: { due_from: { relative: 'startOf(week)' }, due_to: { relative: 'endOf(week)' } } }],
  range: { from: 'due_from', to: 'due_to' },
  paging: { offset: 'offset', limit: 'limit' },
  drill: { fn: 'tasks/by_owner', label: 'Tasks', bind: { owner: 'owner' } },
};

describe('visuals and facts', () => {
  it('declares a contribution with its shape, and adds gin facts to the column facts', () => {
    expect(waffle).toMatchObject({ registry: HUB_VISUALS, name: 'waffle', shape: { whole: true, styles: [{ name: 'default' }] } });
    expect(FACTS.columns.map((c) => [c.name, c.members, c.bound, c.opaque])).toEqual([
      ['owner', ['ann', 'bo'], undefined, false], ['open', undefined, { min: 0, max: 100 }, false], ['id', undefined, undefined, true],
    ]);
  });

  it('ranks the contributions that draw a result, coverage first, and leaves out other registries and shapeless ones', () => {
    const ranked = rankedVisuals([...ENTRIES, { registry: 'other/registry', name: 'x', label: 'X', shape: BUILT_IN_VISUALS.table.shape }, { registry: HUB_VISUALS, name: 'bare', label: 'Bare' }], FACTS, TABLE);
    // all cover both readable columns; then the band and terms (an enum key with few values), then registry order
    expect(ranked.map((r) => r.entry.name)).toEqual(['part', 'category', 'value', 'distribution', 'waffle', 'table']);
    expect(ranked.find((r) => r.entry.name === 'category')?.rank.bind).toEqual({ x: ['owner'], y: ['open'] });
    // one page of more: the whole-only visuals are hidden
    expect(rankedVisuals(ENTRIES, resultFacts({ ...TABLE, truncated: true })).map((r) => r.entry.name)).toEqual(['category', 'table']);
  });
});

describe('args, controls and runs', () => {
  it('finds the paging and range args by their names', () => {
    expect(pagingOf(SOURCE_ARGS)).toEqual({ offset: 'offset', limit: 'limit' });
    expect(rangeOf(SOURCE_ARGS)).toEqual({ from: 'due_from', to: 'due_to' });
    expect(rangeOf(wireType(g.obj({ start: g.timestamp(), end: g.timestamp() })))).toEqual({ from: 'start', to: 'end' });
    expect(pagingOf(wireType(g.obj({ offset: g.num() })))).toBeUndefined();
    expect(rangeOf(wireType(g.obj({ from: g.text(), to: g.text() })))).toBeUndefined();
  });

  it('describes the widget args: pinned ones gone, claimed ones optional', () => {
    const args = widgetArgs(wireType(g.obj({ status: g.text(), from: g.date(), to: g.date(), offset: g.num(), limit: g.num() })), {
      args: { status: { show: 'pinned', value: { literal: 'open' } } }, range: { from: 'from', to: 'to' }, paging: { offset: 'offset', limit: 'limit' },
    });
    expect(Object.keys(args.props ?? {})).toEqual(['from', 'to', 'offset', 'limit']);
    expect(Object.values(args.props ?? {}).map((prop) => prop.type.name)).toEqual(['optional', 'optional', 'optional', 'optional']);
  });

  it('lists a chip per shown arg with its words, choices ("Any" on an optional one), relative dates and value', () => {
    const controls = widgetControls(SOURCE_ARGS, { ...SPEC, args: { ...SPEC.args, status: { show: 'control' } } }, { owner: 'bo' });
    expect(controls.map((c) => [c.arg, c.label, c.optional, c.choices?.map((choice) => choice.label), c.custom, c.relative, c.value])).toEqual([
      ['status', 'Status', false, ['open', 'done'], false, false, undefined],
      ['owner', 'Who', true, ['Any', 'Ann'], false, false, { literal: 'bo' }],
      ['due_from', 'Due from', true, undefined, true, true, undefined],
      ['due_to', 'Due to', true, undefined, true, true, undefined],
    ]);
    expect(widgetControls(SOURCE_ARGS, SPEC).map((c) => c.arg)).toEqual(['owner', 'due_from', 'due_to']);
  });

  it('runs with pinned values, the given args, defaults (relative dates resolved) and the first window', () => {
    const spec: WidgetSpec = { ...SPEC, args: { ...SPEC.args, due_from: { show: 'control', default: { relative: 'today-7d' } } } };
    const options = { now: new Date('2026-11-13T12:00:00Z'), zone: 'UTC', window: 25 };
    expect(widgetRunArgs(SOURCE_ARGS, spec, { owner: 'ann' }, options)).toEqual({ status: 'open', owner: 'ann', due_from: '2026-11-06', offset: 0, limit: 25 });
    expect(widgetRunArgs(SOURCE_ARGS, spec, { offset: 50, status: 'done' }, options)).toMatchObject({ status: 'open', offset: 50, limit: 25 });
    expect(widgetPager({ offset: 'offset', limit: 'limit' }, TABLE, 2)).toEqual({ offset: 'offset', limit: 'limit', window: 2, more: true });
    // "Any" (null) clears a chip that has a default: left out of the run, shown unset, and the widget's args take null
    expect(widgetRunArgs(SOURCE_ARGS, spec, { due_from: null }, options)).not.toHaveProperty('due_from');
    const cleared = widgetControls(SOURCE_ARGS, spec, { due_from: null }).find((c) => c.arg === 'due_from');
    expect([cleared?.value, cleared?.defaulted]).toEqual([undefined, true]);
    expect(widgetControls(SOURCE_ARGS, spec).find((c) => c.arg === 'due_from')?.value).toEqual({ relative: 'today-7d' });
    expect(widgetArgs(SOURCE_ARGS, spec).props?.['due_from']?.type).toMatchObject({ name: 'optional', generic: { T: { name: 'nullable' } } });
    expect(widgetPager({ offset: 'offset', limit: 'limit' }, TABLE, 25).more).toBe(false);
  });
});

describe('actions and drill', () => {
  const rowFns = [
    { fn: 'tasks/Task.show', mode: 'read', args: wireType(g.obj({ self: g.text() })), returnsTable: false },
    { fn: 'tasks/Task.close', mode: 'write', args: wireType(g.obj({ self: g.text(), reason: g.text() })), returnsTable: false },
    { fn: 'tasks/subtasks', mode: 'read', args: wireType(g.obj({ task: g.text() })), returnsTable: true },
  ] as const;

  it('derives the menu: labels, confirms, forms and what follows', () => {
    expect(widgetActionOptions(rowFns, undefined).map((o) => [o.fn, o.label, o.confirm, o.form === undefined ? [] : Object.keys(o.form.props ?? {}), o.then])).toEqual([
      ['tasks/Task.show', 'Show', false, [], 'status'], ['tasks/Task.close', 'Close', true, ['reason'], 'refresh'], ['tasks/subtasks', 'Subtasks', false, ['task'], 'open'],
    ]);
    expect(widgetActionOptions(rowFns, [{ fn: 'tasks/subtasks', label: 'Children', bind: { task: 'id' }, then: 'status' }, { fn: 'tasks/Gone.x', bind: {} }]))
      .toEqual([{ fn: 'tasks/subtasks', label: 'Children', mode: 'read', confirm: false, bind: { task: 'id' }, then: 'status' }]);
  });

  it('takes a click\'s args from the row', () => {
    expect(boundArgs({ owner: 'owner', n: 'open' }, TABLE, 1)).toEqual({ owner: 'bo', n: 5 });
    expect(() => boundArgs({ owner: 'gone' }, TABLE, 0)).toThrow(/lacks/);
    expect(() => boundArgs({}, TABLE, 9)).toThrow(/not in the table/);
  });

  it('knows a declared table return', () => {
    expect(returnsTable(wireType(ginAs(ResultTable)))).toBe(true);
    expect(returnsTable(wireType(g.obj({ rows: g.list(g.text()) })))).toBe(false);
  });
});

describe('checks', () => {
  it('passes a good spec and lists every problem with a bad one, keeping the visuals that draw', () => {
    expect(checkWidget(SPEC, { args: SOURCE_ARGS, facts: FACTS, entries: ENTRIES, table: TABLE })).toEqual({ visuals: SPEC.visuals, problems: [] });
    const bad: WidgetSpec = {
      ...SPEC,
      visuals: [{ visual: 'category', style: 'sparkle', bind: { x: ['open'] } }, { visual: 'pie', style: 'pie', bind: {} }, { visual: 'table', style: 'table', bind: {} }],
      args: { status: { show: 'hidden' }, owner: { show: 'pinned', value: { literal: 3 } }, gone: { show: 'hidden' }, offset: { show: 'hidden' } },
      presets: [{ label: 'Mine', sets: { owner: { literal: 'ann' }, due_from: { relative: 'now' } } }],
      drill: { fn: 'tasks/by_owner', label: 'Tasks', bind: { owner: 'who' } },
    };
    const { visuals, problems } = checkWidget(bad, { args: SOURCE_ARGS, facts: FACTS, entries: ENTRIES });
    expect(visuals.map((v) => v.visual)).toEqual(['table']);
    expect(problems).toEqual([
      'Arg status is hidden, but it has no default: pin a value or show it.',
      'Arg owner: 3 is not a valid text.',
      'Arg gone: tasks/open_by_owner has no arg gone.',
      'Arg offset is driven by the widget\'s pager, so it can\'t have a plan too.',
      'Preset Mine: arg owner is pinned, so a preset can\'t set it.',
      'Preset Mine arg due_from: now is not a relative date for a date argument.',
      'Visual category: Category: open is integer, not text or boolean or date or datetime.',
      'Visual category: style sparkle is not one of bar, stacked, percent, horizontal, line, area, radar, polar, pictorial.',
      'Visual pie: it is not a visual of hub/visuals.',
      'Drill tasks/by_owner: arg owner binds column who, which the result lacks.',
    ]);
    // a saved widget runs with no args, so a required arg shown as a chip needs a default
    const chip: WidgetSpec = { ...SPEC, args: { ...SPEC.args, status: { show: 'control' } } };
    expect(checkWidget(chip, { args: SOURCE_ARGS, facts: FACTS, entries: ENTRIES, table: TABLE }).problems).toEqual(['Arg status is required: give its chip a default, or pin a value.']);
  });

  it('needs a default on a required range arg, so a saved widget opens on a range and runs', () => {
    const source = wireType(g.obj({ from: g.date(), to: g.date(), offset: g.optional(g.num()), limit: g.optional(g.num()) }));
    const ranged: WidgetSpec = { ...SPEC, args: {}, presets: [], range: { from: 'from', to: 'to' } };
    const input = { args: source, facts: FACTS, entries: ENTRIES, table: TABLE };
    expect(checkWidget(ranged, input).problems).toEqual([
      'Arg from is required: give its chip a default, or pin a value.', 'Arg to is required: give its chip a default, or pin a value.',
    ]);
    const opens: WidgetSpec = { ...ranged, args: { from: { show: 'control', default: { relative: 'startOf(year)' } }, to: { show: 'control', default: { relative: 'today' } } } };
    expect(checkWidget(opens, input).problems).toEqual([]);
    const options = { now: new Date('2026-11-13T12:00:00Z'), zone: 'UTC', window: 200 };
    expect(widgetRunArgs(source, opens, {}, options)).toEqual({ from: '2026-01-01', to: '2026-11-13', offset: 0, limit: 200 });
    // the chart drives them, so they are chips only
    const pinned: WidgetSpec = { ...opens, args: { ...opens.args, to: { show: 'pinned', value: { relative: 'endOf(month)' } } } };
    expect(checkWidget(pinned, input).problems).toEqual(['Arg to is driven by the widget\'s range, so it can\'t be pinned: give it a chip with the range the widget opens on.']);
  });

  it('moves to a source whose args take the widget\'s values', () => {
    const next = wireType(g.obj({ status: g.enum(['open', 'done', 'later']), owner: g.optional(g.text()), due_from: g.optional(g.date()), due_to: g.optional(g.date()), offset: g.optional(g.num()), limit: g.optional(g.num()) }));
    expect(sourceCompatible(SPEC, next, { previous: SOURCE_ARGS })).toEqual([]);
    const narrower = wireType(g.obj({ status: g.enum(['done']), owner: g.optional(g.text()), offset: g.optional(g.num()), limit: g.optional(g.num()) }));
    expect(sourceCompatible(SPEC, narrower, { previous: SOURCE_ARGS })).toEqual([
      'Range: tasks/open_by_owner has no arg due_from.',
      'Range: tasks/open_by_owner has no arg due_to.',
      'Arg status: "open" is not a valid enum.',
      'Preset Due this week: tasks/open_by_owner has no arg due_from.',
      'Preset Due this week: tasks/open_by_owner has no arg due_to.',
      'Arg status: the new source\'s enum doesn\'t take every enum the old one did.',
    ]);
  });
});

describe('the strict authoring schema', () => {
  const ranked = rankedVisuals(ENTRIES, FACTS, TABLE).map((r) => r.rank);
  const proposal = widgetProposalSchema({ source: SPEC.source, args: SOURCE_ARGS, facts: FACTS, ranked, entries: ENTRIES, table: TABLE, drills: ['tasks/by_owner'] });
  const draft = {
    name: 'open_by_owner', description: 'Open tasks per owner.', title: 'Open tasks by owner',
    choice: { visual: 'category', style: 'horizontal' }, more: ['table', 'category'],
    args: { status: { show: 'pinned', value: { literal: 'open' } }, owner: { show: 'control', choices: [{ label: 'Anyone' }, { label: 'Ann', value: { literal: 'ann' } }] } },
    presets: [{ label: 'This week', sets: { owner: { literal: 'bo' } } }],
    drill: { fn: 'tasks/by_owner', label: 'Tasks', bind: { owner: 'owner' } },
  };

  it('reads a good draft as a spec, with the default bindings and the paging and range it found', () => {
    expect(proposal.read(draft)).toEqual({
      name: 'open_by_owner', description: 'Open tasks per owner.',
      spec: {
        title: 'Open tasks by owner', source: SPEC.source,
        visuals: [{ visual: 'category', style: 'horizontal', bind: { x: ['owner'], y: ['open'] } }, { visual: 'table', style: 'table', bind: { columns: ['owner', 'open'] } }],
        args: draft.args, presets: draft.presets, paging: { offset: 'offset', limit: 'limit' }, drill: draft.drill,
      },
    });
  });

  it('lets range args take a plan and presets while no chosen visual draws the range', () => {
    const dated = {
      ...draft, args: { ...draft.args, due_from: { show: 'control', default: { relative: 'today-7d' } } },
      presets: [{ label: 'This week', sets: { due_from: { relative: 'startOf(week)' }, due_to: { relative: 'endOf(week)' } } }],
    };
    const { spec } = proposal.read(dated);
    expect(spec.args['due_from']).toEqual({ show: 'control', default: { relative: 'today-7d' } });
    expect(spec.presets[0]?.sets).toEqual({ due_from: { relative: 'startOf(week)' }, due_to: { relative: 'endOf(week)' } });
    expect(spec.range).toBeUndefined();
  });

  it('can\'t spell a broken widget', () => {
    const refused = (patch: object): string[] => (proposal.schema.safeParse({ ...draft, ...patch }).error?.issues ?? []).map((issue) => issue.path.join('.') || issue.message);
    expect(refused({ choice: { visual: 'category', style: 'river' } })).toEqual(['choice.style']);
    expect(refused({ choice: { visual: 'time', style: 'line' } })).toEqual(['choice.visual']);
    expect(refused({ choice: { visual: 'category', style: 'bar', bind: { x: ['open'] } } })).toEqual(['choice.bind.x.0']);
    expect(refused({ args: { status: { show: 'pinned', value: { literal: 'later' } } } })).toContain('args.status.value.literal');
    expect(refused({ args: { ...draft.args, status: { show: 'hidden' } } })).toEqual(['args.status.show']);
    expect(refused({ args: { ...draft.args, offset: { show: 'hidden' } } })).toEqual(['args']);
    expect(refused({ args: { ...draft.args, status: { show: 'control', choices: [{ label: 'Any' }] } } })).toEqual(['args.status.choices.0.value']);
    expect(refused({ drill: { fn: 'tasks/other', label: 'x', bind: {} } })).toEqual(['drill.fn']);
    // a rule only the refinement sees: a pinned arg set by a preset
    expect(refused({ presets: [{ label: 'Done', sets: { status: { literal: 'done' } } }] })).toEqual(['Preset Done: arg status is pinned, so a preset can\'t set it.']);
  });

  it('keeps every enum in the tool\'s JSON Schema', () => {
    const text = JSON.stringify(z.toJSONSchema(proposal.schema, { io: 'input', unrepresentable: 'any' }));
    for (const word of ['"horizontal"', '"done"', '"owner"', '"tasks/by_owner"']) { expect(text).toContain(word); }
    expect(text).not.toContain('"time"');
    // a date arg the range doesn't claim offers the relative dates for days
    const dated = widgetProposalSchema({ source: SPEC.source, args: wireType(g.obj({ day: g.date() })), facts: FACTS, ranked, entries: ENTRIES });
    const datedText = JSON.stringify(z.toJSONSchema(dated.schema, { io: 'input', unrepresentable: 'any' }));
    expect(datedText).toContain('"startOf(week)"');
    expect(datedText).not.toContain('"now-1h"');
  });
});
