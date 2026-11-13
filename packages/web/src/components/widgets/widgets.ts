/**
 * Widgets on the web side (build 8), apart from any component: telling a widget's result or a plain result table from
 * any other run result, which of a widget's visuals to offer and with which columns, the types a table's rows are of
 * (so their actions can be asked for), which actions a row can take and the args a click sends, and the words around
 * them. The host a widget is drawn in (`WidgetHost`) runs what it asks for, so the view knows nothing of where it is.
 */
import {
  ResultTable, WidgetResult, type FnMode, type GinTypeDef, type Json, type QualifiedName, type WidgetActionOption, type WidgetVisual,
} from '@harness/core';
import type { InjectionKey } from 'vue';
import { TABLE_VISUAL, type FittingVisual } from '../results/visuals.ts';

/** A run result as a widget's, when it is one. */
export function widgetResultOf(value: Json | undefined): WidgetResult | undefined {
  if (value === undefined) { return undefined; }
  const parsed = WidgetResult.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A run result as a result table, when it is one. */
export function resultTableOf(value: Json | undefined): ResultTable | undefined {
  if (value === undefined) { return undefined; }
  const parsed = ResultTable.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a result is rows (a widget's result or a result table), which the chat draws in full rather than in brief. */
export function showsRows(value: Json | undefined): boolean {
  return widgetResultOf(value) !== undefined || resultTableOf(value) !== undefined;
}

/** The most row types one ask for actions names (the `widgetActions` query's bound). */
export const MAX_ROW_TYPES = 20;

/** The named types a table's rows refer to (columns with `ref`), each once, in column order. */
export function rowTypes(table: Pick<ResultTable, 'columns'>): QualifiedName[] {
  const types: QualifiedName[] = [];
  for (const column of table.columns) {
    if (column.ref !== undefined && !types.includes(column.ref)) { types.push(column.ref); }
  }
  return types.slice(0, MAX_ROW_TYPES);
}

/**
 * The args an action takes from a row: each bound argument gets its column's value. Undefined when a bound column is
 * missing from the table or empty in this row, so the row doesn't offer it.
 */
export function boundArgs(option: Pick<WidgetActionOption, 'bind'>, table: Pick<ResultTable, 'columns'>, row: readonly Json[]): Record<string, Json> | undefined {
  const args: Record<string, Json> = {};
  for (const [arg, column] of Object.entries(option.bind)) {
    const at = table.columns.findIndex((c) => c.name === column);
    const value = at < 0 ? undefined : row[at];
    if (value === undefined || value === null) { return undefined; }
    args[arg] = value;
  }
  return args;
}

/** The actions one row can take: those whose bound columns all have a value in it. */
export function rowActions(options: readonly WidgetActionOption[], table: Pick<ResultTable, 'columns'>, row: readonly Json[]): WidgetActionOption[] {
  return options.filter((option) => boundArgs(option, table, row) !== undefined);
}

/** The args an action runs with: what the row binds, then what its form filled in (an object; anything else is ignored). */
export function actionArgs(bound: Readonly<Record<string, Json>>, form: Json | undefined): Json {
  return form !== null && typeof form === 'object' && !Array.isArray(form) ? { ...form, ...bound } : { ...bound };
}

/** What a person is asked before an action runs, in words: "Archive this row?" with what it changes. */
/** What an action does, in words, beside it in the menu (a read says nothing). */
export const ACTION_MODE_WORDS = { read: '', write: 'changes it', delete: 'removes it' } as const satisfies Record<FnMode, string>;

/** Columns whose value names a row, best first. */
const NAMING_COLUMNS = ['title', 'name', 'label'] as const;

/** A row's name for the menu that acts on it: its title (or name, or label) column, else its first text cell. */
export function rowName(table: Pick<ResultTable, 'columns'>, row: readonly Json[]): string | undefined {
  const named = NAMING_COLUMNS.map((name) => table.columns.findIndex((column) => column.name === name)).find((at) => at >= 0 && typeof row[at] === 'string' && row[at] !== '');
  const at = named ?? row.findIndex((cell) => typeof cell === 'string' && cell !== '');
  const cell = row[at];
  return typeof cell === 'string' && cell !== '' ? cell : undefined;
}

export function confirmText(option: Pick<WidgetActionOption, 'label' | 'mode'>): string {
  const what = option.mode === 'delete' ? 'It removes something and may not be undone.'
    : option.mode === 'read' ? 'It only reads.'
      : 'It changes something.';
  return `${option.label} this row? ${what}`;
}

/**
 * The visuals a widget offers, in its own order and with its own labels: each visual it kept that fits the columns it
 * binds (`fitting` answers the registry's visuals that fit a table), then the table, which is always there and last.
 */
export function offeredVisuals(fitting: (table: ResultTable) => readonly FittingVisual[], table: ResultTable, visuals: readonly WidgetVisual[]): FittingVisual[] {
  const offered: FittingVisual[] = [];
  const labelled = (fit: FittingVisual, label: string | undefined): FittingVisual => (label === undefined ? fit : { fit: fit.fit, visual: { ...fit.visual, label } });
  for (const kept of visuals) {
    if (kept.visual === TABLE_VISUAL) { continue; }
    const fit = fitting(boundTable(table, kept).table).find((f) => f.visual.name === kept.visual);
    if (fit !== undefined) { offered.push(labelled(fit, kept.label)); }
  }
  const whole = fitting(table).find((f) => f.visual.name === TABLE_VISUAL);
  if (whole !== undefined) { offered.push(labelled(whole, visuals.find((v) => v.visual === TABLE_VISUAL)?.label)); }
  return offered;
}

/** A table as a visual draws it, and the row of the whole table each drawn row came from (for its actions). */
export interface BoundTable {
  readonly table: ResultTable;
  original(row: readonly Json[]): readonly Json[];
}

/**
 * The table a visual draws: with bindings, only the bound columns, in the order of the visual's channels as the widget
 * lists them (a bar chart's label, then its value); without any, or when a bound column is gone, the whole table.
 */
export function boundTable(table: ResultTable, visual: WidgetVisual | undefined): BoundTable {
  const whole: BoundTable = { table, original: (row) => row };
  const names = visual === undefined ? [] : Object.values(visual.bind).flat();
  if (names.length === 0) { return whole; }
  const at = names.map((name) => table.columns.findIndex((c) => c.name === name));
  if (at.some((i) => i < 0)) { return whole; }
  const from = new WeakMap<readonly Json[], readonly Json[]>();
  const rows = table.rows.map((row) => {
    const drawn = at.map((i) => row[i] ?? null);
    from.set(drawn, row);
    return drawn;
  });
  return {
    table: { ...table, columns: at.flatMap((i) => (table.columns[i] === undefined ? [] : [table.columns[i]])), rows, sort: table.sort.filter((s) => names.includes(s.column)) },
    original: (row) => from.get(row) ?? row,
  };
}

/** The request that asks the agent to save a run's result as a widget (it uses `hub/make_widget`). */
export function saveWidgetRequest(fn: QualifiedName, args: Json | undefined): string {
  const asked = args === undefined || (typeof args === 'object' && args !== null && Object.keys(args).length === 0) ? '' : ` with ${JSON.stringify(args)}`;
  return `Save the result of ${fn}${asked} as a widget I can open again (use hub/make_widget). Keep the controls for its arguments and the visuals that fit.`;
}

/** What a widget needs from the page it is drawn on: its row actions, running fns, and its controls' type. */
export interface WidgetHost {
  /** The actions rows of these types offer, narrowed by the widget when it is one. */
  actions(types: readonly QualifiedName[], widget: QualifiedName | undefined): Promise<readonly WidgetActionOption[]>;
  /** Run a fn as an ordinary run (a control change, a refresh, an action); whether it started. */
  run(fn: QualifiedName, args: Json): Promise<boolean>;
  /** The gin type of a fn's args, when the page knows it (the widget's controls). */
  argsType(fn: QualifiedName): GinTypeDef | undefined;
  /** Ask the agent to save a run's result table as a widget; absent where there is no agent to ask. */
  readonly saveAsWidget?: ((fn: QualifiedName, args: Json | undefined) => Promise<boolean>) | undefined;
}

/** Where a page provides its widget host. */
export const WIDGET_HOST: InjectionKey<WidgetHost> = Symbol('widget-host');
