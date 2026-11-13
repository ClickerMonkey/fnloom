/**
 * Visuals and widgets for system authors and the bundled widgets system (`widgets/widget`), after product's widget
 * design. A widget is a saved view of a read fn that returns a `ResultTable`: the visuals it switches between, a plan
 * per source argument (a chip, pinned or hidden), presets, the range and paging args the view drives, the actions on
 * each row and what a click drills into (`WidgetSpec` in `@harness/core`).
 *
 * These are the pure pieces every side shares, so a fit, a control or an action means the same thing in a system, the
 * widgets system, the hub and the web app:
 *
 * - **Visuals:** `visual(...)` declares a contribution to `HUB_VISUALS` with its shape, `channel(...)` one of its
 *   inputs. `resultFacts` is core's `columnFacts` with the gin facts of each column's type (`ginTypeFacts`);
 *   `rankedVisuals` is core's coverage-first `rankVisuals` over registry contributions.
 * - **Args and controls:** `widgetArgs` is the widget's args type, `widgetControls` its chip row, `widgetRunArgs` the
 *   source args a run uses (relative dates resolved), `widgetPager` the buffered pager's state after a run.
 * - **Actions and drill:** `widgetActionOptions` the menu a row offers (with the derived `then`), `boundArgs` the args a
 *   click takes from a row, `returnsTable` whether a fn's declared return is a table.
 *
 * Checks and the authoring schema are in `widget-check.ts` and `widget-schema.ts`; relative dates in `relative-dates.ts`.
 */
import {
  BUILT_IN_VISUALS, ContributionDecl, HUB_VISUALS, Json, VISUAL_FAMILIES, LocalName, ResultTable, actionLabel, columnFacts, confirmOf, deriveThen, rankVisuals,
  type ArgPlan, type ChoiceOption, type GinTypeDef, type ColumnFacts, type ColumnKind, type FnMode, type QualifiedName, type ResultColumn, type ResultFacts,
  type VisualChannel, type VisualRank, type VisualShape, type VisualShapeInput, type WidgetAction, type WidgetActionOption, type WidgetPager, type WidgetPaging, type WidgetRange,
  type WidgetShownControl, type WidgetSpec,
} from '@harness/core';
import type { TypeScope } from '@aeye/gin';
import { z } from 'zod';
import { g, type GinType } from './gin.ts';
import { ginAs } from './zod-gin.ts';
import { relativeDatesFor, resolveArgValue } from './relative-dates.ts';

export { HUB_VISUALS, WIDGET_KIND, WIDGETS_SYSTEM } from '@harness/core';

// ─── Visuals ──────────────────────────────────────────────────────────────────

/** What `channel()` takes besides the name, label and kinds: all optional (required and single by default). */
export interface ChannelOptions {
  readonly required?: boolean;
  readonly many?: boolean;
  /** The fewest columns a `many` channel needs. */
  readonly min?: number;
  /** The role its columns must have: a category wants a `group` key, a value a `measure`. */
  readonly role?: 'group' | 'measure';
}

/** One input of a visual: `channel('y', 'Value', ['integer', 'number'], { role: 'measure' })`; required and single unless said. */
export function channel(name: string, label: string, accepts: readonly ColumnKind[], options: ChannelOptions = {}): VisualChannel {
  return {
    name: LocalName.parse(name), label, accepts: [...accepts], required: options.required ?? true, many: options.many ?? false,
    ...(options.min === undefined ? {} : { min: options.min }), ...(options.role === undefined ? {} : { role: options.role }),
  };
}

/** What `visual()` takes: the visual's name, its switcher label and icon, and the data it draws. */
export interface VisualInput {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly shape: VisualShapeInput;
}

/**
 * A visual this system adds to the hub's visual registry, for `system(name, { contributes: [visual(...)] })`. Its
 * component (and an optional veto) go in `client({ visuals: { [HUB_VISUALS]: { <name>: { component } } } })`.
 *
 * ```ts
 * visual({ name: 'waffle', label: 'Waffle', shape: { channels: [channel('itemName', 'Square', ['text'], { role: 'group' }), channel('value', 'Size', ['integer'], { role: 'measure' })], rows: { min: 1, max: 10 }, whole: true } })
 * ```
 */
export function visual(input: VisualInput): ContributionDecl {
  return ContributionDecl.parse({
    registry: HUB_VISUALS,
    name: input.name,
    label: input.label,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.icon === undefined ? {} : { icon: input.icon }),
    shape: input.shape,
  });
}

/**
 * The app's own visuals (`BUILT_IN_VISUALS`: the table, the value cards and the twelve ECharts families) as the hub
 * contributes them to `HUB_VISUALS`, in registry order. The web app draws them; systems add theirs after.
 */
export const BUILT_IN_CONTRIBUTIONS: readonly ContributionDecl[] = VISUAL_FAMILIES.map((name) => {
  const builtIn = BUILT_IN_VISUALS[name];
  return ContributionDecl.parse({ registry: HUB_VISUALS, name, label: builtIn.label, description: builtIn.description, icon: builtIn.icon, shape: builtIn.shape });
});

const EnumOptions = z.object({ values: z.record(z.string(), Json) });
const BoundOptions = z.object({ min: z.number(), max: z.number() });

/** A type without its `optional` or `nullable` wrapper. */
function bare(type: GinTypeDef): GinTypeDef {
  const inner = type.name === 'optional' || type.name === 'nullable' ? type.generic?.['T'] : undefined;
  return inner === undefined ? type : bare(inner);
}

/** An enum type's values by label, or `undefined` when the type is not an enum. */
function enumValues(type: GinTypeDef): Record<string, Json> | undefined {
  const bareType = bare(type);
  if (bareType.name !== 'enum') { return undefined; }
  const parsed = EnumOptions.safeParse(bareType.options);
  return parsed.success ? parsed.data.values : undefined;
}

/**
 * What a column's gin type says that core can't read (core runs no gin): an enum's members and a number's declared
 * range. Pass it to `columnFacts` as `typeFacts`, or use `resultFacts`.
 */
export function ginTypeFacts(column: ResultColumn): Pick<ColumnFacts, 'members' | 'bound'> {
  if (column.type === undefined) { return {}; }
  const values = enumValues(column.type);
  if (values !== undefined) { return { members: Object.values(values).map((value) => (typeof value === 'string' ? value : JSON.stringify(value))) }; }
  const type = bare(column.type);
  const bound = type.name === 'num' ? BoundOptions.safeParse(type.options) : undefined;
  return bound?.success === true ? { bound: bound.data } : {};
}

/** A table's column facts with its columns' gin facts: what the widgets system attaches and the web recomputes. */
export function resultFacts(table: Pick<ResultTable, 'columns' | 'rows' | 'offset' | 'truncated'>): ResultFacts {
  return columnFacts(table, ginTypeFacts);
}

/** A visual a registry offers, as `rankedVisuals` reads it (`ContributionDecl`, `ContributionView`). */
export interface VisualContribution {
  readonly registry: string;
  readonly name: string;
  readonly label: string;
  readonly shape?: VisualShape | undefined;
}

/** A contribution that can draw a result, with its rank. */
export interface RankedVisual<E extends VisualContribution> {
  readonly entry: E;
  readonly rank: VisualRank;
}

/**
 * Every `HUB_VISUALS` contribution among `entries` that can draw a result, best first (core's `rankVisuals`: coverage,
 * then priority, then the entries' order). Contributions to other registries and ones without a shape are left out.
 */
export function rankedVisuals<E extends VisualContribution>(entries: readonly E[], facts: ResultFacts, table?: Pick<ResultTable, 'rows' | 'columns'>): RankedVisual<E>[] {
  const shaped = entries.flatMap((entry) => (entry.registry === HUB_VISUALS && entry.shape !== undefined ? [{ entry, shape: entry.shape }] : []));
  const byName = new Map(shaped.map((item) => [item.entry.name, item.entry]));
  return rankVisuals(shaped.map((item) => ({ name: item.entry.name, shape: item.shape })), facts, table).flatMap((rank) => {
    const entry = byName.get(rank.visual);
    return entry === undefined ? [] : [{ entry, rank }];
  });
}

// ─── Args and controls ────────────────────────────────────────────────────────

/** One argument of a fn's args type: its type (without an optional wrapper) and whether it must be given. */
export interface ArgInfo {
  readonly name: string;
  readonly type: GinTypeDef;
  /** Neither optional nor defaulted. */
  readonly required: boolean;
  /** It declares a default, so leaving it out still gives it a value. */
  readonly defaulted: boolean;
}

/** The args of a fn's args type, in order. A type that is not an object has none. */
export function argsOf(args: GinTypeDef): ArgInfo[] {
  return Object.entries(args.props ?? {}).map(([name, prop]) => {
    const optional = prop.type.name === 'optional';
    const inner = optional ? prop.type.generic?.['T'] ?? prop.type : prop.type;
    const defaulted = prop.default !== undefined;
    return { name, type: inner, required: !optional && !defaulted, defaulted };
  });
}

/** The args a buffered pager drives, when a source has both (`limit` and `offset`, as the database's query fns name them). */
export const WINDOW_ARGS: WidgetPaging = { offset: 'offset', limit: 'limit' };

/** The source's paging args (`WINDOW_ARGS`, both whole-number args), or `undefined` when it doesn't page. */
export function pagingOf(args: GinTypeDef): WidgetPaging | undefined {
  const found = new Map(argsOf(args).map((arg) => [arg.name, arg]));
  const numeric = (name: string): boolean => found.get(name)?.type.name === 'num';
  return numeric(WINDOW_ARGS.offset) && numeric(WINDOW_ARGS.limit) ? WINDOW_ARGS : undefined;
}

/** The pairs of arg names read as a range, first match wins: `from`/`to`, `start`/`end`, `after`/`before`, with any prefix. */
const RANGE_PAIRS: readonly (readonly [string, string])[] = [['from', 'to'], ['start', 'end'], ['after', 'before'], ['since', 'until']];

/**
 * The source's range args, which a range-claiming visual (time, calendar, timeline, finance) drives: the first pair of
 * date or timestamp args named `from`/`to`, `start`/`end`, `after`/`before` or `since`/`until`, alone or after a
 * shared prefix (`due_from`/`due_to`). `undefined` when there is none.
 */
export function rangeOf(args: GinTypeDef): WidgetRange | undefined {
  const dates = argsOf(args).filter((arg) => arg.type.name === 'date' || arg.type.name === 'timestamp').map((arg) => arg.name);
  const names = new Set(dates);
  for (const [from, to] of RANGE_PAIRS) {
    for (const name of dates) {
      const prefix = name === from ? '' : name.endsWith(`_${from}`) ? name.slice(0, -from.length) : undefined;
      if (prefix !== undefined && names.has(`${prefix}${to}`)) { return { from: name, to: `${prefix}${to}` }; }
    }
  }
  return undefined;
}

/** The args the widget's pager and range claim drive. */
function claimedArgs(spec: Pick<WidgetSpec, 'paging' | 'range'>): Set<string> {
  return new Set([spec.paging?.offset, spec.paging?.limit, spec.range?.from, spec.range?.to].filter((arg): arg is string => arg !== undefined));
}

/**
 * The widget's args type (the kind's `describe`): its source's args minus the pinned ones, with the paging and range
 * args made optional (the view drives them; a run without them reads the first window of the default range).
 */
export function widgetArgs(source: GinTypeDef, spec: Pick<WidgetSpec, 'args' | 'paging' | 'range'>): GinTypeDef {
  const claimed = claimedArgs(spec);
  const props = Object.fromEntries(Object.entries(source.props ?? {}).flatMap(([name, prop]) => {
    if (spec.args[name]?.show === 'pinned') { return []; }
    const asIs = !claimed.has(name) || prop.type.name === 'optional' || prop.default !== undefined;
    return [[name, asIs ? prop : { ...prop, type: { name: 'optional', generic: { T: prop.type } } }]];
  }));
  return { ...source, props };
}

/** An enum's members as choices (label and value), or `undefined` when the type is not an enum. */
function enumChoices(type: GinTypeDef): ChoiceOption[] | undefined {
  const values = enumValues(type);
  return values === undefined ? undefined : Object.entries(values).map(([label, value]) => ({ label, value: { literal: value } }));
}

/**
 * The chip row (`WidgetResult.controls`), in the source's arg order: every arg not pinned, hidden or driven by the
 * pager, with its plan's words and choices (an enum's members when the plan names none; an "Any" row first on an
 * optional arg), and its value: the one the run used (`given`), else the plan's default. Range args are chips too, so
 * a visual that doesn't draw the range still lets the person set it.
 */
export function widgetControls(source: GinTypeDef, spec: Pick<WidgetSpec, 'args' | 'paging'>, given: Readonly<Record<string, Json>> = {}): WidgetShownControl[] {
  const paging = new Set([spec.paging?.offset, spec.paging?.limit]);
  return argsOf(source).flatMap((arg): WidgetShownControl[] => {
    const plan: ArgPlan | undefined = spec.args[arg.name];
    if (paging.has(arg.name) || plan?.show === 'pinned' || plan?.show === 'hidden') { return []; }
    const planned = plan?.choices;
    const offered = planned ?? enumChoices(arg.type);
    const choices = offered === undefined || arg.required || offered.some((choice) => choice.value === undefined) ? offered : [{ label: 'Any' }, ...offered];
    const value = given[arg.name] !== undefined ? { literal: given[arg.name] ?? null } : plan?.default;
    return [{
      arg: arg.name,
      label: plan?.label ?? actionLabel(arg.name),
      argType: arg.type,
      optional: !arg.required,
      ...(choices === undefined ? {} : { choices }),
      custom: plan?.custom ?? offered === undefined,
      relative: relativeDatesFor(arg.type.name).length > 0,
      ...(value === undefined ? {} : { value }),
    }];
  });
}

/** When and where a widget runs: the moment and time zone relative dates resolve in, and the pager's window. */
export interface WidgetRunOptions {
  readonly now: Date;
  /** The person's time zone (an IANA name). */
  readonly zone: string;
  /** The rows a run asks for when the widget pages (its first visual's page size, or the pager's). */
  readonly window: number;
}

/**
 * The source args a widget run uses: pinned values, then the args given (the chips the person set), then each plan's
 * default, relative dates resolved; an arg with none of these is left out (it takes the source's default). A paged
 * widget asks for `window` rows from the given offset (0 when none).
 */
export function widgetRunArgs(source: GinTypeDef, spec: Pick<WidgetSpec, 'args' | 'paging'>, given: Readonly<Record<string, Json>>, options: WidgetRunOptions): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const arg of argsOf(source)) {
    const plan = spec.args[arg.name];
    const value = given[arg.name];
    if (plan?.show === 'pinned') { out[arg.name] = resolveArgValue(plan.value, options.now, options.zone); continue; }
    if (value !== undefined) { out[arg.name] = value; continue; }
    if (plan?.show === 'control' && plan.default !== undefined) { out[arg.name] = resolveArgValue(plan.default, options.now, options.zone); }
  }
  if (spec.paging !== undefined) {
    const offset = given[spec.paging.offset];
    out[spec.paging.offset] = typeof offset === 'number' ? offset : 0;
    out[spec.paging.limit] = options.window;
  }
  return out;
}

/** The pager's state after a run that asked for `window` rows: a full window means more may follow. */
export function widgetPager(paging: WidgetPaging, table: Pick<ResultTable, 'rows'>, window: number): WidgetPager {
  return { ...paging, window, more: table.rows.length >= window };
}

// ─── Actions and drill ────────────────────────────────────────────────────────

/** A fn a row could run: a method of the row's type or any fn a widget binds, with its mode, args and declared return. */
export interface RowFn {
  readonly fn: QualifiedName;
  readonly mode: FnMode;
  readonly args: GinTypeDef;
  /** Its declared return is a table (`returnsTable`), so its rows open as a new level. */
  readonly returnsTable: boolean;
}

/**
 * The actions a row offers: every row fn when the widget lists none, else the listed ones in their order, each
 * labelled (`actionLabel` unless relabelled), confirming when `confirmOf` says so, with its bound args, a form for the
 * args left (the form comes first; the confirm follows for anything above a read), and what follows: the widget's
 * `then`, else derived (`deriveThen`: rows returned open, a write refreshes, else a status line). A method's value
 * (`self`) is bound by the row's ref, so it never shows in the form. A listed action whose fn isn't among `rowFns`
 * is left out.
 */
export function widgetActionOptions(rowFns: readonly RowFn[], actions: readonly WidgetAction[] | undefined): WidgetActionOption[] {
  const byFn = new Map(rowFns.map((rowFn) => [rowFn.fn, rowFn]));
  const chosen: Array<{ rowFn: RowFn; action: WidgetAction | undefined }> = actions === undefined
    ? rowFns.map((rowFn) => ({ rowFn, action: undefined }))
    : actions.flatMap((action) => { const rowFn = byFn.get(action.fn); return rowFn === undefined ? [] : [{ rowFn, action }]; });
  return chosen.map(({ rowFn, action }) => {
    const bind = action?.bind ?? {};
    const left = Object.fromEntries(Object.entries(rowFn.args.props ?? {}).filter(([name]) => name !== 'self' && !(name in bind)));
    return {
      fn: rowFn.fn,
      label: action?.label ?? actionLabel(rowFn.fn),
      mode: rowFn.mode,
      confirm: confirmOf(rowFn.mode, action?.confirm),
      bind: { ...bind },
      ...(Object.keys(left).length === 0 ? {} : { form: { ...rowFn.args, props: left } }),
      then: action?.then ?? deriveThen(rowFn.mode, rowFn.returnsTable),
    };
  });
}

/**
 * The args a click takes from a row (an action's or the drill's `bind`: arg → column), by column name. A column the
 * table lacks, or a row past its end, throws: the widget's check already refused such a binding.
 */
export function boundArgs(bind: Readonly<Record<string, string>>, table: Pick<ResultTable, 'columns' | 'rows'>, rowIndex: number): Record<string, Json> {
  const row = table.rows[rowIndex];
  if (row === undefined) { throw new Error(`Row ${String(rowIndex)} is not in the table (it has ${String(table.rows.length)}).`); }
  return Object.fromEntries(Object.entries(bind).map(([arg, column]) => {
    const index = table.columns.findIndex((c) => c.name === column);
    if (index < 0) { throw new Error(`Arg ${arg} binds column ${column}, which the table lacks.`); }
    return [arg, row[index] ?? null];
  }));
}

/** A gin type from its definition, in `scope` (the hub's or loaded types) or `g`. Throws a gin error when it doesn't parse. */
export function ginTypeOf(def: GinTypeDef, scope?: TypeScope): GinType {
  return (scope ?? g).parse(def);
}

let tableType: GinType | undefined;

/**
 * Whether a fn's declared return is a table: every value of it is a `ResultTable` (gin `compatible`), so the chat routes
 * it to the result view (`RESULT_TABLE_ROUTING`) and a widget may draw from it. A return that names a type `scope`
 * doesn't know is not a table.
 */
export function returnsTable(returns: GinTypeDef, scope?: TypeScope): boolean {
  tableType ??= ginAs(ResultTable);
  try {
    return tableType.compatible(ginTypeOf(returns, scope), undefined, scope);
  } catch {
    return false;
  }
}
