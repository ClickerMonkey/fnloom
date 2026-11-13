/**
 * The widgets system's contract (`shared/`), after product's widget plan (build-8-widgets-design.md is binding). A
 * widget is a saved view of a read fn that returns a `ResultTable`: the visuals it switches between, a plan per source
 * argument (a chip, pinned or hidden), presets, the range args a chart drives, the paging args its buffered pager
 * drives, a drill and the row actions it narrows (`WidgetSpec` in `@harness/core`).
 *
 * - **The kind** `widgets/widget`: a saved widget is a fn of this kind, kept in the hub (`hub/save_fn`), never here. A
 *   run calls its source as a child run with the resolved args and the first window, checks the bindings against the
 *   real columns, and returns a `WidgetResult` the app draws.
 * - **make_widget** is an authoring fn: an agent on `ctx.ai()` reads the source and a real sample, then proposes a
 *   widget against a strict schema built for that source. It never saves; the chat shows the proposal with its preview
 *   and a Save button.
 * - **save_widget** is the person's Save (`visibility: 'user'`): it keeps the proposal as a `widgets/widget` fn.
 */
import { MakeWidgetArgs, SaveWidgetArgs, WIDGET_KIND, WIDGETS_SYSTEM, WidgetProposal, WidgetSpec } from '@harness/core';
import { context, fn, g, ginAs, hub, kind, system, type Infer } from '@harness/sdk';

/** A saved widget, as gin (`WidgetSpec`'s type). */
export const WidgetPayload = ginAs(WidgetSpec);

/** What `save_widget` gives: the widget fn, its version, and whether it is new. */
export const SavedWidget = g.obj({ fn: g.text(), version: g.num({ min: 1, whole: true }), created: g.bool() });

/**
 * A widget over a saved query that counts open tasks by stage (columns `stage`, `count`), as the examples write it.
 * A count needs a source that aggregates: `hub/records_table` gives one row per record and never counts.
 */
export const TASKS_BY_STAGE: WidgetSpec = {
  title: 'Open tasks by stage',
  source: 'database/main.open_tasks_by_stage',
  visuals: [{ visual: 'category', style: 'bar', bind: { x: ['stage'], y: ['count'] } }, { visual: 'table', style: 'table', bind: {} }],
  args: {},
  presets: [],
};

const status = {
  active: { one: 'Drawing {fn}…', many: 'Drawing {n} widgets…' },
  retry: { one: 'Drawing {fn} again…', many: 'Drawing {n} widgets again…' },
  done: { one: 'Drew {output.title}', many: 'Drew {n} widgets' },
  failed: { one: 'Drawing {fn} failed', many: '{n} widgets failed' },
};

/** What callers of `make_widget` read. */
const MAKE_USAGE = [
  'Use it when the person wants to keep a chart, table or calendar of a fn\'s rows to look at again, or to change a widget they have.',
  '`source` is a read fn that returns a table (a saved query, hub/records_table, a table fn); find it first with hub/fns_search.',
  '`request` says what to show in the person\'s words: the measure, what it is grouped by, the filters they want to change, the presets.',
  '`args` are sample args to read the source with (the source\'s own args by name): give one for every required arg.',
  '`fns` names any other fns the person wants bound as a row action or the drill (a fn that is not a method of the rows\' type).',
  'Set `show` to true when the person asked to see something now ("show me", "chart my …"): the proposal opens drawn; else it opens collapsed.',
  'It proposes and never saves: the person presses Save under the proposal. To change a widget, pass it as `widget`.',
].join(' ');

/** The widgets system's contract. */
export const widgets = system(WIDGETS_SYSTEM, {
  description: 'Saved views of a fn\'s table (charts, calendars, cards, tables) with their controls, presets, drill and row actions, proposed in the chat and kept by the person.',
  groups: [{ name: 'widgets', title: 'Widgets', description: 'Propose a widget over a fn that returns a table, and keep it when the person presses Save.' }],
  // make_widget's agent is on a model; saved widgets are hub fns; runs read sources, the visual registry and row actions
  grants: { hub: ['ai', 'fns'], calls: ['hub/fn_get', 'hub/save_fn', 'hub/read_table', 'hub/visuals', 'hub/row_actions'] },
})
  .with({
    kinds: {
      widget: kind({
        description: 'A saved widget: running it reads its source fn\'s table with the widget\'s args and draws it with its visuals, controls, presets, drill and row actions.',
        applicability: 'A view of a fn\'s rows the person will look at again (open tasks by stage, sales by month, this week\'s events), made by widgets/make_widget.',
        payload: WidgetPayload,
        // a widget only reads; its row actions ask for themselves
        approveChanges: false,
        status,
      }),
    },
    fns: {
      make_widget: fn({
        group: 'widgets',
        description: 'Propose a widget (a chart, calendar, cards or table with its controls and presets) over a fn that returns a table; the person saves it.',
        instructions: MAKE_USAGE,
        args: ginAs(MakeWidgetArgs),
        returns: ginAs(WidgetProposal),
        deps: { getFn: hub.fns.fn_get, readTable: hub.fns.read_table, visuals: hub.fns.visuals, rowActions: hub.fns.row_actions },
        examples: [
          {
            args: { source: 'database/main.sales_by_month', request: 'Sales by month as a line chart, with a control for the region and presets for this year and last year.', show: true },
            note: 'The person asked to see it: the proposal opens with its chart drawn.',
          },
          {
            args: { source: 'hub/records_table', request: 'My open tasks as cards, only tasks/Task records.', args: { type: 'tasks/Task' }, show: false },
            note: 'A pinned record type over one row per record (records_table never counts; a count by stage needs a query that aggregates); the proposal opens collapsed.',
          },
          {
            args: { source: 'database/main.sales_by_region', request: 'Same widget, but over sales by region as a pie.', widget: 'widgets/sales_by_month', show: true },
            note: 'Changing a widget to another source: allowed when every arg it plans exists in the new source.',
          },
        ],
        status: {
          active: { one: 'Making a widget…', many: 'Making {n} widgets…' },
          retry: { one: 'Making the widget again…', many: 'Making {n} widgets again…' },
          done: { one: 'Proposed {output.spec.title}', many: 'Proposed {n} widgets' },
          failed: { one: 'Making a widget failed', many: '{n} widgets failed' },
        },
        // the agent is a model call of the run; it reads its source and keeps nothing
        effects: { mode: 'read' },
        tags: ['widgets', 'read'],
      }),
      save_widget: fn({
        group: 'widgets',
        description: 'Keep a proposed widget as a `widgets/widget` fn of the person, or save over the widget it changes.',
        instructions: 'The person presses Save under a proposal; the model never calls it. `replace` saves over that widget (its owner only).',
        args: ginAs(SaveWidgetArgs),
        returns: SavedWidget,
        deps: { saveFn: hub.fns.save_fn, getFn: hub.fns.fn_get },
        examples: [{
          args: { name: 'open_tasks_by_stage', description: 'Open tasks counted by stage, as bars.', spec: TASKS_BY_STAGE },
          result: { fn: 'widgets/open_tasks_by_stage', version: 1, created: true },
        }],
        // the person saves it from under the proposal; the model doesn't
        visibility: 'user',
        status: {
          active: { one: 'Saving {args.name}…', many: 'Saving {n} widgets…' },
          retry: { one: 'Saving {args.name} again…', many: 'Saving {n} widgets again…' },
          done: { one: 'Saved {output.fn}', many: 'Saved {n} widgets' },
          failed: { one: 'Saving {args.name} failed', many: '{n} widgets were not saved' },
        },
        effects: { mode: 'write', free: true, registry: [{ thing: 'fns', action: 'create', kind: WIDGET_KIND }] },
        tags: ['widgets', 'write'],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to keep a chart or table of a fn\'s rows as a widget.',
        content: [
          'A fn that returns a table is drawn for the person as a chart, calendar, cards or a table chosen from its columns; never write a chart yourself.',
          'When the person wants to keep such a view, call widgets/make_widget with that fn and what they want; set `show` when they asked to see it now.',
          'The proposal waits for the person to press Save. Running a saved widget (`widgets/<name>`) draws it again with its controls.',
        ].join(' '),
        fns: [fns.make_widget],
        tags: ['widgets'],
      }),
    },
  }));

/** The widgets contract's type. */
export type WidgetsContract = typeof widgets;
/** What `save_widget` gives. */
export type SavedWidgetValue = Infer<typeof SavedWidget>;
