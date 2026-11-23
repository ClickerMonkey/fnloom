/**
 * Widgets (widget pass, after product's widget plan; build-8-widgets-design.md is binding). A widget is a saved view of
 * a read fn that returns a `ResultTable`: the visuals it switches between with their styles and bindings, a plan per
 * source argument (a control, pinned or hidden), presets, the range args a chart drives, the paging args its buffered
 * pager drives, a drill and the row actions it narrows.
 *
 * The bundled `widgets` system owns the kind (`WIDGET_KIND`), saved widgets (fns of that kind, kept with `hub/fns_save`),
 * the authoring fn (`widgets/make_widget`, which proposes; the person presses Save, which runs `widgets/save_widget`)
 * and runs: a run calls its source as a child run, checks the bindings against the real columns and returns a
 * `WidgetResult`. The hub keeps only its `native` and `llm` kinds, the visual registry (`HUB_VISUALS`), row actions
 * (derived from the catalog) and the export route.
 *
 * Actions are derived, never listed by hand: every method of a row's type is offered, and a widget may narrow them, add
 * any fn bound to columns, relabel them and declare a drill. Anything that is not a read confirms first (`confirmOf`);
 * a write with a form shows the form, then the confirm. What follows is derived (`deriveThen`).
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { humanize } from './labels.ts';
import { FnNameValue } from './model-names.ts';
import { FnMode } from './manifest.ts';
import { partialNote } from './partial.ts';
import { InstanceName, Json, LocalName, QualifiedName, RunId } from './primitives.ts';
import { ResultTable } from './registries.ts';
import { ResultFacts, VisualBinding } from './visuals.ts';
import type { ActionThenV1, WidgetSpecV1 } from './widgets-v1.ts';

/** The bundled system that owns widgets. */
export const WIDGETS_SYSTEM = 'widgets';

/** The widget kind. */
export const WIDGET_KIND = 'widgets/widget';

// ─── Argument values ──────────────────────────────────────────────────────────

/**
 * The fixed list of relative dates a date control offers, stored in the date grammar's own text (product's
 * `today-7d`, `startOf(month)`) so the full grammar can follow without migrating saved widgets. `day` ones fill a
 * date arg, `instant` ones a datetime arg. The control resolves one to a plain value when it applies it.
 */
export const RELATIVE_DATE_EXPRS = [
  'today', 'today-1d', 'today+1d', 'today-7d', 'today-30d', 'today+7d', 'startOf(week)', 'endOf(week)', 'startOf(month)', 'endOf(month)',
  'startOf(month,today-1mo)', 'startOf(quarter)', 'startOf(year)', 'now', 'now-1h', 'now-24h',
] as const;
export const RelativeDate = z.enum(RELATIVE_DATE_EXPRS);
export type RelativeDate = z.infer<typeof RelativeDate>;

/** Each relative date's words, and whether it fills a date (`day`) or a datetime (`instant`) argument. */
export const RELATIVE_DATES: Readonly<Record<RelativeDate, { readonly label: string; readonly yields: 'day' | 'instant' }>> = {
  'today': { label: 'Today', yields: 'day' },
  'today-1d': { label: 'Yesterday', yields: 'day' },
  'today+1d': { label: 'Tomorrow', yields: 'day' },
  'today-7d': { label: '7 days ago', yields: 'day' },
  'today-30d': { label: '30 days ago', yields: 'day' },
  'today+7d': { label: 'In 7 days', yields: 'day' },
  'startOf(week)': { label: 'Start of this week', yields: 'day' },
  'endOf(week)': { label: 'End of this week', yields: 'day' },
  'startOf(month)': { label: 'Start of this month', yields: 'day' },
  'endOf(month)': { label: 'End of this month', yields: 'day' },
  'startOf(month,today-1mo)': { label: 'Start of last month', yields: 'day' },
  'startOf(quarter)': { label: 'Start of this quarter', yields: 'day' },
  'startOf(year)': { label: 'Start of this year', yields: 'day' },
  'now': { label: 'Now', yields: 'instant' },
  'now-1h': { label: 'An hour ago', yields: 'instant' },
  'now-24h': { label: '24 hours ago', yields: 'instant' },
};

/** A value for a source argument: a plain value, or a relative date resolved when the widget runs. */
export const ArgValue = z.union([z.object({ literal: Json }), z.object({ relative: RelativeDate })]);
export type ArgValue = z.infer<typeof ArgValue>;

/** One choice of a control: its words and its value. Without a value it is the "Any" row, which clears the argument. */
export const ChoiceOption = z.object({ label: z.string().min(1), value: ArgValue.optional() });
export type ChoiceOption = z.infer<typeof ChoiceOption>;

/**
 * How a widget shows one argument of its source: a chip in the control row (labelled, limited to choices, with a
 * default), `pinned` to a value (it leaves the widget's args; no chip), or `hidden` (no chip; it takes its default, so
 * only an argument with a default may be hidden). An argument with no plan is a chip with the source's own words.
 */
export const ArgPlan = z.discriminatedUnion('show', [
  z.object({
    show: z.literal('control'),
    label: z.string().min(1).optional(),
    /** The only values offered, in order; an "Any" row only on an optional argument. */
    choices: z.array(ChoiceOption).min(1).optional(),
    /** Whether a value outside `choices` may be typed. */
    custom: z.boolean().optional(),
    default: ArgValue.optional(),
  }),
  z.object({ show: z.literal('pinned'), value: ArgValue }),
  z.object({ show: z.literal('hidden') }),
]);
export type ArgPlan = z.infer<typeof ArgPlan>;

/** A named preset that sets several arguments in one tap ("Overdue", "This week"). */
export const WidgetPreset = z.object({ label: z.string().min(1), sets: z.record(LocalName, ArgValue) });
export type WidgetPreset = z.infer<typeof WidgetPreset>;

/** The source's range args a visual's range claim drives (a calendar's month, a zoomed time axis). */
export const WidgetRange = z.object({ from: LocalName, to: LocalName });
export type WidgetRange = z.infer<typeof WidgetRange>;

/** The source's paging args, which the buffered pager drives instead of showing them as controls. */
export const WidgetPaging = z.object({ offset: LocalName, limit: LocalName });
export type WidgetPaging = z.infer<typeof WidgetPaging>;

// ─── Visuals, drill and actions ───────────────────────────────────────────────

/** One visual a widget offers: its name in `HUB_VISUALS`, the style shown, and the columns bound to each channel. */
export const WidgetVisual = z.object({
  visual: LocalName,
  style: LocalName,
  /** The switcher's label instead of the visual's. */
  label: z.string().min(1).optional(),
  /** Channel → columns; a channel left out takes the default binding (`rankVisuals`). Bindings carry over between styles. */
  bind: VisualBinding,
});
export type WidgetVisual = z.infer<typeof WidgetVisual>;

/**
 * What follows an action: `open` its rows as a new level (with a breadcrumb back), `refresh` the widget, or a `status`
 * line. Derived (`deriveThen`): rows returned open, a write refreshes, anything else is a status line.
 */
export const ActionThen = z.enum(['open', 'refresh', 'status']);
export type ActionThen = z.infer<typeof ActionThen>;

/** One action a widget keeps, relabels or confirms: a method of the row's type, or any fn with args bound to columns. */
export const WidgetAction = z.object({
  /** The fn: a type method (`fs/Entry.reveal`) or any fn. */
  fn: QualifiedName,
  label: z.string().min(1).optional(),
  /** `true` asks before running even a read. Writes and deletes always ask. */
  confirm: z.literal(true).optional(),
  /** Argument → the column whose value it takes from the row (`self` for a method is bound by the row's type). */
  bind: z.record(LocalName, z.string().min(1)),
  /** Instead of the derived `then`. */
  then: ActionThen.optional(),
});
export type WidgetAction = z.infer<typeof WidgetAction>;

/**
 * What clicking a bar, slice, point or row runs: a read fn returning a table, its args from the clicked row's columns,
 * opened as a new level with a breadcrumb. Without one, a click opens the row's action menu.
 */
export const WidgetDrill = z.object({ fn: QualifiedName, label: z.string().min(1), bind: z.record(LocalName, z.string().min(1)) });
export type WidgetDrill = z.infer<typeof WidgetDrill>;

/** A saved widget: the payload of a `widgets/widget` fn. */
export const WidgetSpec = z.object({
  title: z.string().min(1),
  /** The read fn whose result it draws; it must return a `ResultTable`. */
  source: QualifiedName,
  /** The visuals offered, the first shown first; only visuals that fit the source's columns. */
  visuals: z.array(WidgetVisual).min(1),
  /** A plan per source argument; one left out is a chip with the source's own words. */
  args: z.record(LocalName, ArgPlan),
  presets: z.array(WidgetPreset),
  range: WidgetRange.optional(),
  paging: WidgetPaging.optional(),
  /** The actions offered on each row; absent offers every derived one, `[]` none. */
  actions: z.array(WidgetAction).optional(),
  drill: WidgetDrill.optional(),
  /** Re-run on its own while shown, when the source declares a live source (`FnDecl.live`). */
  live: z.literal(true).optional(),
});
export type WidgetSpec = z.infer<typeof WidgetSpec>;

// ─── Results ──────────────────────────────────────────────────────────────────

/** A chip in the control row: the argument, its words and type, what it offers and what it is set to. */
export const WidgetShownControl = z.object({
  arg: LocalName,
  label: z.string().min(1),
  /**
   * The argument's gin type, for the chip's popover editor. Not named `type`: next to `value` that would make the
   * control read as a gin value envelope (`{type, value}`) inside a typed list.
   */
  argType: GinTypeDef,
  /** Whether it may be cleared (the "Any" row). */
  optional: z.boolean(),
  /**
   * Whether the widget fills it with its own default when it is left out: clearing it ("Any") then sends `null`, which
   * the widget reads as "explicitly unset" (absent when not given).
   */
  defaulted: z.boolean().optional(),
  choices: z.array(ChoiceOption).min(1).optional(),
  custom: z.boolean(),
  /** Whether the popover offers `RELATIVE_DATES` (a date or datetime argument). */
  relative: z.boolean(),
  value: ArgValue.optional(),
});
export type WidgetShownControl = z.infer<typeof WidgetShownControl>;

/**
 * How the buffered pager asks for more: the paging args, the window the run applied (`limit`), and whether more may
 * follow (a full window means there may be; a short one is the last). The pager pages locally through what it holds and
 * runs the widget again (offset = rows held) only when a page needs rows it lacks.
 */
export const WidgetPager = z.object({ offset: LocalName, limit: LocalName, window: z.number().int().min(1), more: z.boolean() });
export type WidgetPager = z.infer<typeof WidgetPager>;

/** An action as a row's menu offers it: derived from the fn, narrowed and labelled by the widget. */
export const WidgetActionOption = z.object({
  fn: QualifiedName,
  label: z.string().min(1),
  mode: FnMode,
  confirm: z.boolean(),
  bind: z.record(LocalName, z.string().min(1)),
  /** The args left for a form after binding (shown first; the confirm follows for anything above a read). */
  form: GinTypeDef.optional(),
  then: ActionThen,
});
export type WidgetActionOption = z.infer<typeof WidgetActionOption>;

/** What a widget run returns, and what the widget view draws. */
export const WidgetResult = z.object({
  title: z.string().min(1),
  table: ResultTable,
  /** The table's column facts (`columnFacts`, with the source's gin facts); the pager works them out again as it grows. */
  facts: ResultFacts,
  /** The source fn, the child run that made the table, and the args it ran with, so the pager and refresh can ask again. */
  source: z.object({ fn: QualifiedName, run: RunId, args: z.record(z.string(), Json) }),
  /** The spec's visuals that still fit, in its order; the table always last. */
  visuals: z.array(WidgetVisual).min(1),
  /** Bindings that no longer fit (a column gone or of another kind), in words; the widget still draws. */
  problems: z.array(z.string()),
  /** The chip row, in the source's arg order. */
  controls: z.array(WidgetShownControl),
  presets: z.array(WidgetPreset),
  range: WidgetRange.optional(),
  paging: WidgetPager.optional(),
  /** The actions on rows of the table's row types, narrowed by the spec. */
  actions: z.array(WidgetActionOption),
  drill: WidgetDrill.optional(),
  /** The rows came from a write (`table.write`): no controls, no fetching more, no drill; "Run again" asks first. */
  readOnly: z.boolean(),
  /** How often the view re-runs it while shown, when it is live (never below the hub's floor). */
  live: z.object({ every: z.number().int().min(1) }).optional(),
  /** One line for the chat model ("Bar chart of count by stage, 12 rows"); `tableModelView` adds who sees the rows. */
  summary: z.string().min(1),
});
export type WidgetResult = z.infer<typeof WidgetResult>;

// ─── Fns and routes ───────────────────────────────────────────────────────────

/**
 * The actions offered on rows of these types (hub `rowActions` and `hub/row_actions`), narrowed by a widget's list. With
 * no row types (a source with no records type or ref columns) only the fns the widget binds are offered.
 */
export const RowActionsQuery = z.object({ types: z.array(QualifiedName).max(20), narrow: z.array(WidgetAction).optional() })
  .refine((query) => query.types.length > 0 || (query.narrow?.length ?? 0) > 0, { message: 'name a row type or an action to offer' });
export type RowActionsQuery = z.infer<typeof RowActionsQuery>;

/** `hub/read_table`: run a read fn that returns a table, as a child run of the caller, as its person. */
export const ReadTableArgs = z.object({ fn: QualifiedName, args: z.record(z.string(), Json) });
export type ReadTableArgs = z.infer<typeof ReadTableArgs>;

/** The web's quiet read (`readFn`): a read fn and its args, and for a fleet the instance it runs on (`on`, else the hub picks). */
export const ReadFnArgs = ReadTableArgs.extend({ on: InstanceName.optional() });
export type ReadFnArgs = z.infer<typeof ReadFnArgs>;

/**
 * `widgets/make_widget`: the source fn, what the person wants, sample args, the widget to change (absent: a new one),
 * and whether the person asked to see something (the proposal then opens with its chart drawn).
 */
export const MakeWidgetArgs = z.object({
  // fn names as the model's tools spell them, read back at the boundary (`g.fnName()`)
  source: FnNameValue,
  request: z.string().min(1),
  args: z.record(z.string(), Json).optional(),
  /** Other fns the widget may bind as row actions or its drill (any fn, as the person names them), besides the rows' types' methods. */
  fns: z.array(FnNameValue).max(10).optional(),
  widget: FnNameValue.optional(),
  show: z.boolean(),
});
export type MakeWidgetArgs = z.infer<typeof MakeWidgetArgs>;

/** What `widgets/make_widget` returns: a proposal the chat draws as a preview with a Save button. Nothing is saved. */
export const WidgetProposal = z.object({
  name: LocalName,
  description: z.string().min(1),
  spec: WidgetSpec,
  /** The source run with the plan's args, drawn as the widget will be. */
  preview: WidgetResult,
  /** The widget it changes, when it edits one. */
  replaces: FnNameValue.optional(),
  show: z.boolean(),
});
export type WidgetProposal = z.infer<typeof WidgetProposal>;

/** `widgets/save_widget` (a person's Save, never an agent's tool): keep a proposal as a widget fn. */
export const SaveWidgetArgs = z.object({ name: LocalName, description: z.string().min(1), spec: WidgetSpec, replace: QualifiedName.optional() });
export type SaveWidgetArgs = z.infer<typeof SaveWidgetArgs>;

/**
 * The hub's streamed export (`GET /api/export`): a read fn, its args as JSON text, its paging args, and the format. The
 * hub runs it page by page as the person, writes each page and lets it go, and ends a file cut at the row ceiling with a
 * line saying so.
 */
export const ExportQuery = z.object({ fn: QualifiedName, args: z.string(), offset: LocalName, limit: LocalName, format: z.literal('csv') });
export type ExportQuery = z.infer<typeof ExportQuery>;

// ─── Routing ──────────────────────────────────────────────────────────────────

/** The clause the chat's fn line gets for a fn whose declared return is a `ResultTable`. */
export const RESULT_TABLE_ROUTING = 'returns a table; the chat draws it as a chart, calendar, cards or a table chosen from its columns, every other fitting visual one click away';

/** The short instruction beside those lines. */
export const RESULT_TABLE_INSTRUCTION = 'To show data as a chart or table, call a fn that returns a table; never write a chart yourself. To keep one, call widgets/make_widget with that fn.';

/** What the chat model sees of a table result: one line, the columns, and the first rows. */
export const TableModelView = z.object({
  summary: z.string(), columns: z.array(z.string()), rows: z.array(z.array(Json)), more: z.number().int().min(0),
  /** When the model reads fewer rows than there are: which rows it has, how many were left out and how to read them (`partialNote`). */
  partial: z.string().optional(),
});
export type TableModelView = z.infer<typeof TableModelView>;

/**
 * How the chat model reads table results in one run: how many rows it gets, and whether a person is watching
 * (`RunInfo.watched`), so the table is drawn for them. Unwatched (a nested agent, a background or scheduled run) no one
 * sees the rows, so the model gets more of them and answers from those.
 */
export interface TableReading {
  readonly rows: number;
  readonly watched: boolean;
}

/**
 * A table result as the chat model sees it: the summary with who sees the rows, the column names and the first
 * `reading.rows` rows. Watched, the person has the whole table; unwatched, the summary says no one sees them.
 */
export function tableModelView(summary: string, table: ResultTable, reading: TableReading): TableModelView {
  const rows = table.rows.slice(0, reading.rows);
  const more = table.rows.length - rows.length;
  const held = more > 0 ? `: answer from the first ${String(rows.length)}, and say the answer covers only those` : `: answer from them`;
  const seen = reading.watched ? `${summary}, shown to the person` : `${summary}. Nobody is watching this run, so no one sees them${held}`;
  // rows nobody sees (held back from an unwatched run, or past this page): the view says how many and how to read them;
  // a watched run's person has the whole page, and `more` counts what the model was not given
  const total = table.total ?? (table.truncated ? undefined : table.offset + table.rows.length);
  const rest = `run it again narrower${table.truncated ? ` or from offset ${String(table.offset + table.rows.length)}` : ''}`;
  const partial = (more > 0 && !reading.watched) || table.truncated
    ? partialNote({ unit: 'rows', offset: table.offset, shown: rows.length, ...(total === undefined ? {} : { total }), rest })
    : undefined;
  return { summary: seen, columns: table.columns.map((column) => column.name), rows, more, ...(partial === undefined ? {} : { partial }) };
}

/** A widget's summary line: "Bar chart of count by stage, 12 rows". */
export function widgetSummary(visualLabel: string, bind: VisualBinding, table: ResultTable): string {
  const names = (channel: string): string => (bind[channel] ?? []).join(', ');
  const measure = names('y') || names('value');
  const key = names('x') || names('itemName') || names('time');
  const of = measure === '' ? '' : ` of ${measure}${key === '' ? '' : ` by ${key}`}`;
  return `${visualLabel}${of}, ${rowsLine(table)}`;
}

/** How many rows a table holds, as the model reads it: "12 rows (more held back)". */
export function rowsLine(table: Pick<ResultTable, 'rows' | 'truncated'>): string {
  const count = table.rows.length === 1 ? '1 row' : `${String(table.rows.length)} rows`;
  return `${count}${table.truncated ? ' (more held back)' : ''}`;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/** Whether an action asks first: always for anything that is not a read, else when the widget says so. */
export function confirmOf(mode: FnMode, declared: true | undefined): boolean {
  return mode !== 'read' || declared === true;
}

/** What follows an action by default: rows returned open a new level, a write refreshes, else a status line. */
export function deriveThen(mode: FnMode, returnsTable: boolean): ActionThen {
  if (returnsTable) { return 'open'; }
  return mode === 'read' ? 'status' : 'refresh';
}

/** A method, fn or arg name as a label: `mark_done` → "Mark done", `Task.archive` → "Archive", `owner_id` → "Owner ID". */
export function actionLabel(fn: string): string {
  const last = fn.split(/[/.]/).pop() ?? fn;
  return humanize(last) || fn;
}

/** Build 8's visuals as the widget pass names them: the family and its style, and how the old channels map. */
const V1_VISUALS: Readonly<Record<string, { readonly visual: string; readonly style: string; readonly channels: Readonly<Record<string, string>> }>> = {
  table: { visual: 'table', style: 'table', channels: { columns: 'columns' } },
  bar: { visual: 'category', style: 'bar', channels: { label: 'x', value: 'y' } },
  value: { visual: 'value', style: 'cards', channels: { value: 'value' } },
};

/** A build 8 action's `then` in the widget pass's words. */
const V1_THEN: Readonly<Record<ActionThenV1, ActionThen>> = { refresh: 'refresh', show: 'open', none: 'status' };

/**
 * A build 8 `hub/widget` payload as a widget-pass spec, for the hub's start-up migration: visuals renamed to their
 * family and style (another system's visual keeps its name with the `default` style), controls as arg plans, paging
 * kept only when both paging args were named, actions with their `then` renamed.
 */
export function upgradeWidgetSpec(old: WidgetSpecV1): WidgetSpec {
  const visuals = old.visuals.map((entry): WidgetVisual => {
    const known = V1_VISUALS[entry.visual];
    const bind: VisualBinding = {};
    for (const [channel, columns] of Object.entries(entry.bind)) { bind[known?.channels[channel] ?? channel] = columns; }
    return { visual: known?.visual ?? entry.visual, style: known?.style ?? 'default', ...(entry.label === undefined ? {} : { label: entry.label }), bind };
  });
  const [first, ...rest] = visuals;
  const args: Record<string, ArgPlan> = {};
  for (const control of old.controls) {
    if (control.pinned !== undefined) { args[control.arg] = { show: 'pinned', value: { literal: control.pinned } }; continue; }
    if (control.hidden === true) { args[control.arg] = { show: 'hidden' }; continue; }
    const choices = control.choices?.map((value): ChoiceOption => ({ label: typeof value === 'string' ? value : JSON.stringify(value), value: { literal: value } }));
    args[control.arg] = {
      show: 'control', ...(control.label === undefined ? {} : { label: control.label }),
      ...(choices === undefined ? {} : { choices }), ...(control.custom === undefined ? {} : { custom: control.custom }),
    };
  }
  const { offset, limit } = old.paging ?? {};
  return {
    title: old.title, source: old.source, visuals: first === undefined ? [{ visual: 'table', style: 'table', bind: {} }] : [first, ...rest], args, presets: [],
    ...(offset !== undefined && limit !== undefined ? { paging: { offset, limit } } : {}),
    ...(old.actions === undefined ? {} : {
      actions: old.actions.map((action): WidgetAction => ({
        fn: action.fn, bind: action.bind, then: V1_THEN[action.then],
        ...(action.label === undefined ? {} : { label: action.label }), ...(action.confirm === undefined ? {} : { confirm: action.confirm }),
      })),
    }),
  };
}
