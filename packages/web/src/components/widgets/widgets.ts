/**
 * Widgets on the web side (widget pass), apart from any component: telling a widget's result, a widget proposal or a
 * plain result table from any other run result, the visuals a widget offers (its own list, in its order, with its
 * bindings), the chip row's words and the args a chip set runs with, the actions a row can take and the args a click
 * sends, the drill levels kept in the URL, and the words around them. The page a widget is drawn on provides a
 * `WidgetHost`, which runs what the view asks for, so the view knows nothing of where it is.
 */
import {
  ExportQuery, QualifiedName, RELATIVE_DATES, ResultTable, WidgetPaging, WidgetProposal, WidgetResult, type ArgValue, type FnMode, type Json,
  type RecordUpdate, type RowActionsQuery, type SaveWidgetArgs, type WidgetActionOption, type WidgetDrill, type WidgetShownControl, type WidgetVisual,
} from '@harness/core';
import { relativeDatesFor, resolveArgValue } from '@harness/sdk';
import type { InjectionKey } from 'vue';
import { z } from 'zod';
import type { RankedVisual } from '../results/visuals.ts';

// ─── Telling results apart ────────────────────────────────────────────────────

/** A run result as a widget's, when it is one. */
export function widgetResultOf(value: Json | undefined): WidgetResult | undefined {
  if (value === undefined) { return undefined; }
  const parsed = WidgetResult.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A run result as a widget proposal (`widgets/make_widget`), when it is one. */
export function proposalOf(value: Json | undefined): WidgetProposal | undefined {
  if (value === undefined) { return undefined; }
  const parsed = WidgetProposal.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A run result as a result table, when it is one. */
export function resultTableOf(value: Json | undefined): ResultTable | undefined {
  if (value === undefined) { return undefined; }
  const parsed = ResultTable.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a result is rows (a widget's result, a proposal or a result table), which the chat draws in full. */
export function showsRows(value: Json | undefined): boolean {
  return widgetResultOf(value) !== undefined || proposalOf(value) !== undefined || resultTableOf(value) !== undefined;
}

// ─── Visuals ──────────────────────────────────────────────────────────────────

/**
 * The visuals a widget offers: its own, in its order, each with its label, its style first and its bindings (the
 * ranking's default only where it binds none: a channel it left empty stays empty); one the result can no longer draw
 * is left out. When none of its own fit, every visual that does.
 */
export function widgetVisuals(ranked: readonly RankedVisual[], own: readonly WidgetVisual[]): RankedVisual[] {
  const offered = own.flatMap((entry): RankedVisual[] => {
    const match = ranked.find((r) => r.visual.name === entry.visual);
    if (match === undefined) { return []; }
    const styles = match.rank.styles.includes(entry.style) ? [entry.style, ...match.rank.styles.filter((s) => s !== entry.style)] : match.rank.styles;
    const [first, ...rest] = styles;
    return [{
      visual: entry.label === undefined ? match.visual : { ...match.visual, label: entry.label },
      rank: { ...match.rank, bind: Object.keys(entry.bind).length === 0 ? match.rank.bind : entry.bind, styles: first === undefined ? match.rank.styles : [first, ...rest] },
    }];
  });
  return offered.length > 0 ? offered : [...ranked];
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

/** The most row types one ask for actions names (`RowActionsQuery`'s bound). */
export const MAX_ROW_TYPES = 20;

/** The named types a table's rows refer to (columns with `ref`, and the table's record type), each once. */
export function rowTypes(table: Pick<ResultTable, 'columns' | 'records'>): QualifiedName[] {
  const types: QualifiedName[] = table.records === undefined ? [] : [table.records.type];
  for (const column of table.columns) {
    if (column.ref !== undefined && !types.includes(column.ref)) { types.push(column.ref); }
  }
  return types.slice(0, MAX_ROW_TYPES);
}

/** The args a click takes from a row (`bind`: arg → column); undefined when a bound column is missing or empty there. */
export function rowArgs(bind: Readonly<Record<string, string>>, table: Pick<ResultTable, 'columns' | 'rows'>, rowIndex: number): Record<string, Json> | undefined {
  const row = table.rows[rowIndex];
  if (row === undefined) { return undefined; }
  const args: Record<string, Json> = {};
  for (const [arg, column] of Object.entries(bind)) {
    const at = table.columns.findIndex((c) => c.name === column);
    const value = at < 0 ? undefined : row[at];
    if (value === undefined || value === null) { return undefined; }
    args[arg] = value;
  }
  return args;
}

/** The actions one row can take: those whose bound columns all have a value in it. */
export function actionsForRow(options: readonly WidgetActionOption[], table: Pick<ResultTable, 'columns' | 'rows'>, rowIndex: number): WidgetActionOption[] {
  return options.filter((option) => rowArgs(option.bind, table, rowIndex) !== undefined);
}

/** The args an action runs with: what its form filled in (an object; anything else is ignored), then what the row binds. */
export function actionArgs(bound: Readonly<Record<string, Json>>, form: Json | undefined): Record<string, Json> {
  return form !== null && typeof form === 'object' && !Array.isArray(form) ? { ...form, ...bound } : { ...bound };
}

/** What an action does, in words, beside it in the menu (a read says nothing). */
export const ACTION_MODE_WORDS = { read: '', write: 'changes it', delete: 'removes it' } as const satisfies Record<FnMode, string>;

/** Columns whose value names a row, best first. */
const NAMING_COLUMNS = ['title', 'name', 'label'] as const;

/** A row's name for the menu that acts on it and a drill's crumb: its title (or name, or label), else its first text cell. */
export function rowName(table: Pick<ResultTable, 'columns' | 'rows'>, rowIndex: number): string | undefined {
  const row = table.rows[rowIndex];
  if (row === undefined) { return undefined; }
  const named = NAMING_COLUMNS.map((name) => table.columns.findIndex((column) => column.name === name)).find((at) => at >= 0 && typeof row[at] === 'string' && row[at] !== '');
  const at = named ?? row.findIndex((cell) => typeof cell === 'string' && cell !== '');
  const cell = row[at];
  return typeof cell === 'string' && cell !== '' ? cell : undefined;
}

/** What a person is asked before an action runs: "Archive “Trip notes”?" with what it does. */
export function confirmText(option: Pick<WidgetActionOption, 'label' | 'mode'>, name: string | undefined): string {
  const what = option.mode === 'delete' ? 'It removes something and may not be undone.' : option.mode === 'read' ? 'It only reads.' : 'It changes something.';
  return `${option.label} ${name === undefined ? 'this row' : `“${name}”`}? ${what}`;
}

// ─── The chip row ─────────────────────────────────────────────────────────────

/** A chip's staged value: an `ArgValue`, or `null` for "Any" (the arg is cleared). */
export type ChipValue = ArgValue | null;

/** A value as a chip shows it: "Any" when unset, text as it is, yes or no, a list joined, else compact JSON. */
export function jsonText(value: Json | undefined): string {
  if (value === undefined || value === null || value === '') { return 'Any'; }
  if (typeof value === 'string') { return value; }
  if (typeof value === 'number') { return String(value); }
  if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
  if (Array.isArray(value)) { return value.length === 0 ? 'Any' : value.map((item) => jsonText(item)).join(', '); }
  return JSON.stringify(value);
}

const sameJson = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether two staged values are the same. */
export function sameValue(a: ChipValue | undefined, b: ChipValue | undefined): boolean {
  if (a === undefined || a === null || b === undefined || b === null) { return (a ?? null) === (b ?? null); }
  if ('relative' in a || 'relative' in b) { return 'relative' in a && 'relative' in b && a.relative === b.relative; }
  return sameJson(a.literal, b.literal);
}

/** A chip's value in words: a choice's label, a relative date's words, the value, or "Any". */
export function chipText(control: Pick<WidgetShownControl, 'choices'>, value: ChipValue | undefined): string {
  if (value === undefined || value === null) { return 'Any'; }
  const choice = control.choices?.find((c) => c.value !== undefined && sameValue(c.value, value));
  if (choice !== undefined) { return choice.label; }
  return 'relative' in value ? RELATIVE_DATES[value.relative].label : jsonText(value.literal);
}

/** The relative dates a chip's popover offers: days for a date argument, instants for a timestamp, else none. */
export function relativeChoices(control: Pick<WidgetShownControl, 'relative' | 'argType'>): { readonly value: ArgValue; readonly label: string }[] {
  if (!control.relative) { return []; }
  return relativeDatesFor(control.argType.name).map((relative) => ({ value: { relative }, label: RELATIVE_DATES[relative].label }));
}

/** The person's time zone, for relative dates. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The widget args a chip row runs with: each chip's staged value (else the one it ran with), relative dates resolved
 * now. A value the widget filled in from its own default (a relative one) is left out, so the widget keeps it current;
 * "Any" leaves the arg out, or sends `null` where the widget would otherwise fill in its default (`defaulted`).
 */
export function chipArgs(controls: readonly WidgetShownControl[], staged: Readonly<Record<string, ChipValue>>, now: Date, zone: string): Record<string, Json> {
  const args: Record<string, Json> = {};
  for (const control of controls) {
    const set = Object.hasOwn(staged, control.arg) ? staged[control.arg] : undefined;
    const value = set === undefined ? control.value : set;
    if (value === undefined || value === null) {
      // "Any" over a chip the widget would fill from its default is sent as null, which clears it
      if (control.defaulted === true) { args[control.arg] = null; }
      continue;
    }
    if (set === undefined && 'relative' in value) { continue; }
    args[control.arg] = resolveArgValue(value, now, zone);
  }
  return args;
}

// ─── Drill levels in the URL ──────────────────────────────────────────────────

/**
 * One drill step: the fn it ran, its crumb and the args it took from the clicked row, and the paging args its rows are
 * read in pages by (a drill through the query: `limit` / `offset`).
 */
export const DrillStep = z.object({ fn: QualifiedName, label: z.string().min(1), args: z.record(z.string(), z.json()), paging: WidgetPaging.optional() });
export type DrillStep = z.infer<typeof DrillStep>;

/** The paging args a drill through the query reads the rows behind a group with. */
export const DRILL_PAGING: WidgetPaging = { offset: 'offset', limit: 'limit' };

/** Whether a group key's value pins rows: NULL (or nothing) stands for no group a query can pin, a list for none. */
function pinnable(value: Json | undefined): value is Json {
  return value !== undefined && value !== null && !Array.isArray(value);
}

/**
 * The drill through the query for one clicked row (`ResultTable.drill`, build-9 feedback): its source's drill fn with the
 * source's args and the row's value of each group key column, its crumb the keys' labels and values ("Status: paid"),
 * paged. Undefined when the table can't be drilled into or the row has no value for a key (a NULL group).
 */
export function groupDrill(table: Pick<ResultTable, 'columns' | 'rows' | 'drill'>, rowIndex: number): DrillStep | undefined {
  const drill = table.drill;
  const row = table.rows[rowIndex];
  if (drill === undefined || row === undefined) { return undefined; }
  const group: Record<string, Json> = {};
  const words: string[] = [];
  for (const key of drill.keys) {
    const at = table.columns.findIndex((column) => column.name === key);
    const value = at < 0 ? undefined : row[at];
    if (!pinnable(value)) { return undefined; }
    group[key] = value;
    words.push(`${table.columns[at]?.label ?? key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return { fn: drill.fn, label: words.length === 0 ? 'Every row' : words.join(' · '), args: { ...drill.args, group }, paging: DRILL_PAGING };
}

/**
 * What a click on a row's mark opens: the widget's own drill when it binds one (`WidgetDrill`, a fn the author chose),
 * else the drill through the query when the source's result says it has one; undefined for neither.
 */
export function drillStepOf(own: WidgetDrill | undefined, table: Pick<ResultTable, 'columns' | 'rows' | 'drill'>, rowIndex: number): DrillStep | undefined {
  if (own === undefined) { return groupDrill(table, rowIndex); }
  const args = rowArgs(own.bind, table, rowIndex);
  return args === undefined ? undefined : { fn: own.fn, label: crumbLabel(own.label, rowName(table, rowIndex)), args };
}

/** The drill levels of one widget (`of`, its view key), as the URL's `level` keeps them. */
export const WidgetLevels = z.object({ of: z.string().min(1), steps: z.array(DrillStep).min(1).max(8) });
export type WidgetLevels = z.infer<typeof WidgetLevels>;

/** A `level` query value read back; undefined when it doesn't parse. */
export function readLevels(text: string): WidgetLevels | undefined {
  if (text === '') { return undefined; }
  try {
    const parsed = WidgetLevels.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ─── Saving, export and the host ──────────────────────────────────────────────

/** The request that asks the agent to make a widget from a run's fn and args (it proposes; the person saves). */
export function saveWidgetRequest(fn: QualifiedName, args: Json | undefined): string {
  const asked = args === undefined || (typeof args === 'object' && args !== null && Object.keys(args).length === 0) ? '' : ` with ${JSON.stringify(args)}`;
  return `Make a widget from ${fn}${asked} that I can open again (use widgets/make_widget). Keep controls for its arguments and the visuals that fit.`;
}

/** The request that asks the agent to change a proposal before it is saved. */
export function changeWidgetRequest(proposal: Pick<WidgetProposal, 'spec'>): string {
  return `Change the proposed widget “${proposal.spec.title}” (from ${proposal.spec.source}): `;
}

/** The request that asks the agent to save a look picked in a widget's Settings as the saved widget's own (it proposes; the person saves). */
export function saveLookRequest(widget: QualifiedName, visual: string, style: string): string {
  return `Change the widget ${widget} so it opens as ${visual} (${style}) first, keeping its other visuals and everything else (use widgets/make_widget).`;
}

/** The streamed export of a widget's whole result (`GET /api/export`); undefined when its source doesn't page. */
export function exportQuery(result: Pick<WidgetResult, 'source' | 'paging'>): ExportQuery | undefined {
  const paging = result.paging;
  if (paging === undefined) { return undefined; }
  const args = Object.fromEntries(Object.entries(result.source.args).filter(([name]) => name !== paging.offset && name !== paging.limit));
  return ExportQuery.parse({ fn: result.source.fn, args: JSON.stringify(args), offset: paging.offset, limit: paging.limit, format: 'csv' });
}

/** How an ordinary run the person sees ended: its output, or why it didn't finish. */
export type RunOutcome = { readonly ok: true; readonly output: Json } | { readonly ok: false; readonly problem: string };

/** What a widget needs from the page it is drawn on. */
export interface WidgetHost {
  /** The actions rows of these types offer (for a plain table; a widget's result carries its own). */
  actions(query: RowActionsQuery): Promise<readonly WidgetActionOption[]>;
  /**
   * Read a fn as the person and give its output (fetching more rows, a range, a drill level, a refresh). `quiet`
   * says whether such reads stay out of the page's history; only then does a live widget re-run on its own.
   */
  read(fn: QualifiedName, args: Readonly<Record<string, Json>>): Promise<Json>;
  readonly quiet: boolean;
  /**
   * Run a fn as an ordinary run the person sees (an action, Save), resolving when it settles. `waiting` is called once
   * if the run stops for the person's approval, which is given where the page shows it (the chat's approval card).
   */
  run(fn: QualifiedName, args: Json, waiting?: () => void): Promise<RunOutcome>;
  /** Download a read fn's whole result as CSV (the hub's streamed export). */
  exportCsv(query: ExportQuery, fileName: string): Promise<void>;
  /** The drill levels kept in the URL (`level`), read and written as text; absent where the page keeps none. */
  readonly levels?: { get(): string; set(text: string): void } | undefined;
  /** Ask the agent to make a widget from a run, or to change a proposal; absent where there is no agent to ask. */
  readonly ask?: ((text: string, send: boolean) => Promise<boolean>) | undefined;
  /** Change some fields of a stored record in place (the Data page's inline edit); absent where cells aren't edited. */
  readonly update?: ((change: RecordUpdate) => Promise<void>) | undefined;
}

/** Where a page provides its widget host. */
export const WIDGET_HOST: InjectionKey<WidgetHost> = Symbol('widget-host');

/** The fn that keeps a proposal (`widgets/save_widget`), run as the person. */
export const SAVE_WIDGET_FN = QualifiedName.parse('widgets/save_widget');

/** A proposal as `widgets/save_widget` takes it. */
export function saveArgs(proposal: WidgetProposal): SaveWidgetArgs {
  return { name: proposal.name, description: proposal.description, spec: proposal.spec, ...(proposal.replaces === undefined ? {} : { replace: proposal.replaces }) };
}

/** A level's crumb: the drill's or action's label and the row it was asked for ("Orders: Oslo"). */
export function crumbLabel(label: string, row: string | undefined): string {
  return row === undefined ? label : `${label}: ${row}`;
}
