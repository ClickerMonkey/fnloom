/**
 * The widgets system's contract (`shared/`), after product's widget plan (build-8-widgets-design.md is binding). A
 * widget is a saved view of a read fn that returns a `ResultTable`: the visuals it switches between, a plan per source
 * argument (a chip, pinned or hidden), presets, the range args a chart drives, the paging args its buffered pager
 * drives, a drill and the row actions it narrows (`WidgetSpec` in `@harness/core`).
 *
 * - **The kind** `widgets/widget`: a saved widget is a fn of this kind, kept in the hub (`hub/fns_save`), never here. A
 *   run calls its source as a child run with the resolved args and the first window, checks the bindings against the
 *   real columns, and returns a `WidgetResult` the app draws.
 * - **make_widget** is an authoring fn: an agent on `ctx.ai()` reads the source and a real sample, then proposes a
 *   widget against a strict schema built for that source. It never saves; the chat shows the proposal with its preview
 *   and a Save button.
 * - **save_widget** is the person's Save (`visibility: 'user'`): it keeps the proposal as a `widgets/widget` fn.
 * - **The client** (`client/`) draws a proposal's card with Save and a saved widget's result (keeping the look picked in
 *   its Settings) through the result-renderer slot, and owns the saved widgets' page (`/s/widgets/saved`).
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
  'Use it when the person wants to keep a chart, table, calendar or cards of some rows to look at again ("a chart of my spending by month I can open any time"), or to change a widget they have.',
  'Not needed just to show rows once: a fn that returns a table is already drawn for the person when it runs.',
  '`source` is the full name of a fn that only reads and returns a table: a saved query (`database/main.expenses_by_month`), a table\'s generated selectPage fn, or hub/records_table. Find it first (a search, or database/get_query to make the query); if none exists, make it first.',
  'A chart of totals or counts by something needs a source that already groups and totals (a query that does the sum or count): a source that gives one row per item can\'t be charted as totals.',
  '`request` says what to show in the person\'s words: the measure, what it is grouped by, the chart type, the filters they want to change and any named presets ("This month").',
  '`args` is ONE JSON object (never a list or a string) of the source\'s own args by name, used to read a sample: give a value for every required arg, and leave out optional ones such as `sort`, `limit` and `offset` (the widget plans them).',
  '`fns` lists other fns to offer as a row action or a click-through, only when the person asks for one. `widget` is the widget to change (`widgets/spending_by_month`).',
  'Set `show` to true when the person asked to see it now ("show me", "chart my …"): the proposal opens drawn; false opens it collapsed.',
  'What comes back is a proposal (its name, title, what it shows and a preview), not a saved widget: the person presses Save under it in the chat. Tell them to press Save; don\'t say it is saved. Once saved it is a fn `widgets/<name>` they can open again from the Widgets page or by running it.',
  'If it fails, read the reason (a source that does not read or return a table, a required arg missing from `args`) and fix that, or tell the person.',
].join(' ');

/** The saved widgets' page segment (`/s/widgets/saved`). */
export const WIDGETS_PAGE = 'saved';

/** The widgets system's contract. */
export const widgets = system(WIDGETS_SYSTEM, {
  description: 'Saved views of a fn\'s table (charts, calendars, cards, tables) with their controls, presets, drill and row actions, proposed in the chat and kept by the person.',
  about: [
    'Widgets: lasting views of rows (a chart, a table, a calendar or cards) the person can open again, with chips to change filters and dates.',
    'Its one fn for you is widgets/make_widget: give it a fn that returns a table (a saved query, a table\'s list fn, hub/records_table) and what to show, and it proposes a widget with a preview; the person keeps it by pressing Save in the chat.',
    'It defines the fn kind `widgets/widget`: a saved widget is a fn `widgets/<name>` that reads its source again each time it runs, so the view stays current; saved ones are listed on the person\'s Widgets page.',
    'Reach for it when the person wants a chart or view to keep and come back to. Never draw a chart yourself (no ASCII art or text bars): a fn\'s table is drawn for the person when it runs, and widgets keep such a view.',
    'It only reads: changing data is the source system\'s fns. Load the context item `widgets/guide` before the first use.',
  ].join(' '),
  groups: [{ name: 'widgets', title: 'Widgets', description: 'Propose a widget over a fn that returns a table, and keep it when the person presses Save.' }],
  // make_widget's agent is on a model; saved widgets are hub fns; runs read sources, the visual registry and row actions
  grants: { hub: ['ai', 'fns'], calls: ['hub/fns_get', 'hub/fns_save', 'hub/read_table', 'hub/visuals', 'hub/row_actions'] },
  // the saved widgets, searched by the hub, each opened in a new chat (was the Data page's Widgets tab, /data/widgets)
  pages: [{ segment: WIDGETS_PAGE, title: 'Widgets', description: 'Saved views of data. Open one in a chat to run it with its controls and actions.', icon: 'grid', component: 'WidgetsPage' }],
})
  .with({
    kinds: {
      widget: kind({
        description: 'A saved widget, kept as a fn (`widgets/<name>`): running it reads its source fn\'s table again with the widget\'s args and draws it for the person, with its chart types, chips, presets, click-through and row actions.',
        applicability: 'A view of a fn\'s rows the person will look at again (open tasks by stage, spending by month, this week\'s events). Proposed by widgets/make_widget and kept when the person presses Save; never written by hand.',
        payload: WidgetPayload,
        // a widget only reads; its row actions ask for themselves
        approveChanges: false,
        status,
      }),
    },
    fns: {
      make_widget: fn({
        group: 'widgets',
        description: 'Propose a widget, a lasting chart, calendar, cards or table view with its controls and presets, over a fn that returns a table. It shows the person a preview with a Save button; it saves nothing itself.',
        instructions: MAKE_USAGE,
        args: ginAs(MakeWidgetArgs),
        returns: ginAs(WidgetProposal),
        deps: { getFn: hub.fns.fns_get, readTable: hub.fns.read_table, visuals: hub.fns.visuals, rowActions: hub.fns.row_actions },
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
          {
            args: { source: 'database/main.spending_by_category', request: 'Spending per category as bars, with chips for the start and end dates, opening on this month.', args: { from: '2026-11-01', to: '2026-11-30' }, show: true },
            note: 'A source with required date params: `args` gives one value for each, to read a sample; optional ones like sort are left out.',
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
        deps: { saveFn: hub.fns.fns_save, getFn: hub.fns.fns_get },
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
        description: 'How to keep a chart, table, calendar or cards of some rows as a widget the person can open again.',
        content: [
          '# Widgets',
          '',
          'When a fn that returns a table runs, the app draws its rows for the person (a table, or a chart that fits the columns). Never draw a chart yourself in text. A widget keeps such a view: it is saved as a fn `widgets/<name>` that reads its source again each time, so it stays current.',
          '',
          '## Making one',
          '',
          '1. Find the source: a fn that only reads and returns a table. Usually a saved database query (search with kinds ["database/query"], or make one with database/get_query), a table\'s generated selectPage fn, or hub/records_table.',
          '   For totals or counts by something (spending per month, chores per person), the source must already do the sum or count: ask database/get_query for "total amount per month between a start date and an end date". A source that gives one row per item can only be shown as a list, table, cards or calendar.',
          '2. Call widgets/make_widget with `source`, `request` (what to show, in the person\'s words), `args` (one JSON object with a sample value for each required arg of the source, such as {"from": "2026-11-01", "to": "2026-11-30"}; leave out sort, limit and offset), and `show` (true when they want to see it now).',
          '   Example: {"source": "database/main.spending_by_month", "request": "Spending per month as a line chart, opening on this year", "args": {"from": "2026-01-01", "to": "2026-12-31"}, "show": true}',
          '3. It comes back as a proposal with a preview and a Save button. Tell the person to press Save if they want to keep it; until they do, nothing is saved.',
          '',
          '## Afterwards',
          '',
          'A saved widget is listed on the person\'s Widgets page, and running `widgets/<name>` draws it again with its chips. To change one, call widgets/make_widget again with `widget` set to it and what to change.',
          'A widget only reads. Its rows may offer actions (mark done, edit) that are the source table\'s own fns, and those ask for approval as usual. A widget does not refresh or notify anyone on its own when it is not open.',
        ].join('\n'),
        fns: [fns.make_widget],
        tags: ['widgets'],
      }),
    },
  }));

/** The widgets contract's type. */
export type WidgetsContract = typeof widgets;
/** What `save_widget` gives. */
export type SavedWidgetValue = Infer<typeof SavedWidget>;
