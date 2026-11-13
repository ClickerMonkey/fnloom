/**
 * Widgets (build 8), after product's widget design: a widget is a component plus the props it needs to render, chosen
 * from a data shape. The rendering half is a visual of the hub's visual registry (`HUB_VISUALS`, which every system
 * contributes to, the database's table, bar and value visuals included); the matching half is declared
 * (`VisualShape`, `declaredFit`) so the hub and agents can judge it, and scored by each visual's client code.
 *
 * A saved widget is a fn of the hub's kind `hub/widget` (`WIDGET_KIND`): its payload (`WidgetSpec`) names a source fn
 * that returns a `ResultTable` (a `database/query` fn, `hub/records_table`, any fn of that shape), the visuals the
 * person wants to switch between with their bindings, a control per source argument (labelled, limited to choices,
 * pinned or hidden), the paging arguments the widget drives itself, and the actions offered on each row. Its args are
 * the source's minus the pinned ones (the kind's `describe`). A run calls the source as a child run (cost, approval and
 * provenance as for any call), checks the bindings against the real columns, and returns a `WidgetResult`, which the
 * chat and the fn page draw with the result view.
 *
 * Actions are derived, never listed by hand: every method of a row's type (`ResultColumn.ref`) is offered, labelled
 * from its name, with a form for any args left after binding. A widget narrows the set and relabels it. Anything that is
 * not a read always confirms first (`confirmOf`); a widget can add a confirm, never remove one. Nothing runs until a
 * person clicks.
 *
 * `hub/make_widget` writes widgets: a prompt with tools over `authoringAgent()` that is handed a source fn and the
 * person's request (and a widget to change), inspects the source's args and a sample result, picks visuals that fit,
 * checks the spec (`hub/widget_check`) and saves it.
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { FnMode } from './manifest.ts';
import { Json, LocalName, QualifiedName, RunId } from './primitives.ts';
import { ResultTable, type ResultColumn, type VisualShape } from './registries.ts';

/** The hub's visual registry: every visual any system draws a `ResultTable` with. */
export const HUB_VISUALS = 'hub/visuals';

/** The hub's widget kind. */
export const WIDGET_KIND = 'hub/widget';

/** How the widget shows one argument of its source fn. */
export const WidgetControl = z.object({
  arg: LocalName,
  /** The label instead of the argument's name. */
  label: z.string().min(1).optional(),
  /** The only values offered, in order. */
  choices: z.array(Json).min(1).optional(),
  /** Whether a value outside `choices` may be typed. */
  custom: z.boolean().optional(),
  /** A fixed value: the argument leaves the widget's args and its control is not shown. */
  pinned: Json.optional(),
  /** Keep the argument (it takes its default) but show no control. */
  hidden: z.boolean().optional(),
});
export type WidgetControl = z.infer<typeof WidgetControl>;

/** The source's paging arguments, which the widget's pager drives instead of showing them as controls. */
export const WidgetPaging = z.object({ offset: LocalName.optional(), limit: LocalName.optional(), size: z.number().int().min(1).max(500) });
export type WidgetPaging = z.infer<typeof WidgetPaging>;

/** One visual the widget offers, with which columns bind to each of its channels. */
export const WidgetVisual = z.object({
  /** The visual's name in `HUB_VISUALS`. */
  visual: LocalName,
  /** The switcher's label instead of the visual's. */
  label: z.string().min(1).optional(),
  /** Channel name → column names; a channel left out is bound by the visual's own logic. */
  bind: z.record(LocalName, z.array(z.string().min(1)).min(1)),
});
export type WidgetVisual = z.infer<typeof WidgetVisual>;

/** What follows an action: run the widget again, show the action's result in its own view, or nothing. */
export const ActionThen = z.enum(['refresh', 'show', 'none']);
export type ActionThen = z.infer<typeof ActionThen>;

/** One action a widget keeps, relabels or confirms: a method of the row's type, or any fn with args bound to columns. */
export const WidgetAction = z.object({
  /** The fn: a type method (`fs/Entry.reveal`) or any fn. */
  fn: QualifiedName,
  label: z.string().min(1).optional(),
  /** `true` asks before running even a read. Writes and deletes always ask. */
  confirm: z.literal(true).optional(),
  /** Argument → the column whose value it takes from the row (`self` for a method is bound by `ref`). */
  bind: z.record(LocalName, z.string().min(1)),
  then: ActionThen,
});
export type WidgetAction = z.infer<typeof WidgetAction>;

/** A saved widget: the payload of a `hub/widget` fn. */
export const WidgetSpec = z.object({
  title: z.string().min(1),
  /** The fn whose result it draws; it must return a `ResultTable`. */
  source: QualifiedName,
  /** The visuals offered, the first shown first. */
  visuals: z.array(WidgetVisual).min(1),
  controls: z.array(WidgetControl),
  paging: WidgetPaging.optional(),
  /** The actions offered on each row; absent offers every derived one, `[]` none. */
  actions: z.array(WidgetAction).optional(),
});
export type WidgetSpec = z.infer<typeof WidgetSpec>;

/** What a widget run returns, and what its renderer draws. */
export const WidgetResult = z.object({
  title: z.string().min(1),
  table: ResultTable,
  /** The source fn and the child run that made the table, so the pager and refresh can ask again. */
  source: z.object({ fn: QualifiedName, run: RunId }),
  /** The spec's visuals that still fit the real columns, in the spec's order; the table visual is always last. */
  visuals: z.array(WidgetVisual),
  /** Bindings that no longer fit (a column gone or of another kind), in words; the widget still draws. */
  problems: z.array(z.string()),
  /**
   * How the pager asks for another page, when the widget pages: run the widget again with `arg` set to the page's
   * offset (`table.offset` is this page's, `table.truncated` says whether more follow), `size` rows a page.
   */
  paging: z.object({ arg: LocalName, size: z.number().int().min(1) }).optional(),
});
export type WidgetResult = z.infer<typeof WidgetResult>;

/** An action as a row's menu offers it: derived from the fn, narrowed and labelled by the widget. */
export const WidgetActionOption = z.object({
  fn: QualifiedName,
  label: z.string().min(1),
  mode: FnMode,
  confirm: z.boolean(),
  bind: z.record(LocalName, z.string().min(1)),
  /** The args left for a form after binding; absent when none are left. */
  form: GinTypeDef.optional(),
  then: ActionThen,
});
export type WidgetActionOption = z.infer<typeof WidgetActionOption>;

/** The actions offered on rows of these types (web `widgetActions`), narrowed by a widget's list when given. */
export const WidgetActionsQuery = z.object({ types: z.array(QualifiedName).min(1).max(20), widget: QualifiedName.optional() });
export type WidgetActionsQuery = z.infer<typeof WidgetActionsQuery>;

/** `hub/make_widget`: the source fn, what the person wants, and the widget to change (absent: a new one). */
export const MakeWidgetArgs = z.object({ source: QualifiedName, request: z.string().min(1), widget: QualifiedName.optional() });
export type MakeWidgetArgs = z.infer<typeof MakeWidgetArgs>;

/** `hub/widget_check`: a spec and a sample of its source's result; the answer lists every problem, empty when fine. */
export const WidgetCheck = z.object({ spec: WidgetSpec, sample: ResultTable });
export type WidgetCheck = z.infer<typeof WidgetCheck>;

/** Whether an action asks first: always for anything that is not a read, else when the widget says so. */
export function confirmOf(mode: FnMode, declared: true | undefined): boolean {
  return mode !== 'read' || declared === true;
}

/** A method or fn name as a label: `mark_done` → "Mark done", `Task.archive` → "Archive". */
export function actionLabel(fn: string): string {
  const last = fn.split(/[/.]/).pop() ?? fn;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.length === 0 ? fn : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Whether a visual's declared shape can draw a table's columns: every required channel has a column of a kind it
 * accepts, the row count is in range, and a `whole` visual gets a whole result. The client's match logic scores it.
 */
export function declaredFit(shape: VisualShape, table: Pick<ResultTable, 'columns' | 'rows' | 'offset' | 'truncated'>): { readonly fits: boolean; readonly why?: string } {
  for (const channel of shape.channels.filter((c) => c.required)) {
    if (!table.columns.some((column: ResultColumn) => channel.accepts.includes(column.kind))) {
      return { fits: false, why: `No column fits ${channel.label} (${channel.accepts.join(', ')}).` };
    }
  }
  if (table.rows.length < shape.rows.min) { return { fits: false, why: `Needs at least ${String(shape.rows.min)} rows.` }; }
  if (shape.rows.max !== undefined && table.rows.length > shape.rows.max) { return { fits: false, why: `Shows at most ${String(shape.rows.max)} rows.` }; }
  if (shape.whole && (table.truncated || table.offset > 0)) { return { fits: false, why: 'Only shows a whole result, and this is one page of it.' }; }
  return { fits: true };
}
