/**
 * Widgets for system authors and for the hub's widget kind (`hub/widget`), after product's widget design. A widget is a
 * saved view of a fn that returns a `ResultTable`: the visuals it switches between with their bindings, a control per
 * source argument, the paging it drives, and the actions offered on each row (`WidgetSpecV1` in `@harness/core`).
 *
 * These are the pure pieces every side shares, so a fit, a check or a control means the same thing in a system, the
 * hub's kind and `hub/make_widget`, and the web app:
 *
 * - **Visuals:** `visual(...)` declares a contribution to the hub's visual registry (`HUB_VISUALS`) with its shape,
 *   `channel(...)` one of its inputs; `fittingVisuals` lists the declared visuals whose shape fits a table.
 * - **Args and controls:** `widgetArgs` is the widget's args (the source's minus the pinned ones and the page size);
 *   `widgetControls` the controls a widget shows, in the source's order.
 * - **Checks:** `checkWidget` lists every problem with a spec against a real result and says which visuals still fit;
 *   the kind's handler and `widget_check` both use it. `widgetSpecSchema` is the strict schema an authoring agent
 *   drafts against, built from the source's args, the result's columns and the visuals that fit.
 * - **Actions:** `widgetActionOptions` turns a row type's methods into the menu a row offers, narrowed and relabelled
 *   by the spec, with a confirm for anything above a read (`confirmOf`) and a form for the args left after binding.
 */
import {
  ContributionDecl, HUB_VISUALS, Json, LocalName, QualifiedName, WidgetSpecV1, actionLabel, confirmOf, declaredFit,
  type ActionThenV1, type ColumnKind, type FnMode, type GinTypeDef, type ResultColumn, type ResultTable, type VisualChannel, type VisualShape, type VisualShapeInput,
  type WidgetActionV1, type WidgetActionOptionV1, type WidgetVisualV1,
} from '@harness/core';
import { z } from 'zod';

export { HUB_VISUALS, WIDGET_KIND_V1 } from '@harness/core';

// ─── Visuals ──────────────────────────────────────────────────────────────────

/** One input of a visual: `channel('value', 'Value', ['integer', 'number'])`; required and single unless said. */
export function channel(name: string, label: string, accepts: readonly ColumnKind[], options: { required?: boolean; many?: boolean } = {}): VisualChannel {
  return { name: LocalName.parse(name), label, accepts: [...accepts], required: options.required ?? true, many: options.many ?? false };
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
 * A visual this system adds to the hub's visual registry, for `system(name, { contributes: [visual(...)] })`; its
 * component and match logic go in `client({ visuals: { [HUB_VISUALS]: { <name>: { match, component } } } })`.
 *
 * ```ts
 * visual({ name: 'pie', label: 'Pie', shape: { channels: [channel('label', 'Slice', ['text']), channel('value', 'Size', ['integer', 'number'])], rows: { min: 1, max: 12 }, whole: true } })
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

/** A declared visual whose shape fits a table, with its shape. */
export interface FittingVisual {
  readonly name: string;
  readonly label: string;
  readonly shape: VisualShape;
}

/**
 * The visuals of `HUB_VISUALS` (among `entries`, every system's contributions) whose declared shape fits the table. A
 * widget that pages its source (`paged`) shows every page, so a `whole` visual is judged as if the table were whole.
 */
export function fittingVisuals(table: ResultTable, entries: readonly ContributionDecl[], paged = false): FittingVisual[] {
  const judged = paged ? { ...table, offset: 0, truncated: false } : table;
  return entries.flatMap((entry) => {
    if (entry.registry !== HUB_VISUALS || entry.shape === undefined || !declaredFit(entry.shape, judged).fits) { return []; }
    return [{ name: entry.name, label: entry.label, shape: entry.shape }];
  });
}

// ─── Args and controls ────────────────────────────────────────────────────────

/** One argument of an object type: its type (without an optional wrapper) and whether it must be given. */
interface ArgInfo {
  readonly name: string;
  readonly type: GinTypeDef;
  readonly required: boolean;
}

/** The args of a fn's args type, in order. A type that is not an object has none. */
function argsOf(args: GinTypeDef): ArgInfo[] {
  return Object.entries(args.props ?? {}).map(([name, prop]) => {
    const optional = prop.type.name === 'optional' || prop.default !== undefined;
    const inner = prop.type.name === 'optional' ? prop.type.generic?.['T'] ?? prop.type : prop.type;
    return { name, type: inner, required: !optional };
  });
}

/** The source args the widget's pager drives. */
function pagingArgs(spec: Pick<WidgetSpecV1, 'paging'>): Set<string> {
  return new Set([spec.paging?.offset, spec.paging?.limit].filter((arg): arg is string => arg !== undefined));
}

/**
 * The widget's args type (the kind's `describe`): its source's args minus the pinned ones and the page size the widget
 * fixes. The offset arg stays, so the pager asks for another page by running the widget with it.
 */
export function widgetArgs(source: GinTypeDef, spec: Pick<WidgetSpecV1, 'controls' | 'paging'>): GinTypeDef {
  const size = spec.paging?.limit;
  const dropped = new Set([...(size === undefined ? [] : [size]), ...spec.controls.filter((control) => control.pinned !== undefined).map((control) => control.arg)]);
  const props = Object.fromEntries(Object.entries(source.props ?? {}).filter(([name]) => !dropped.has(name)));
  return { ...source, props };
}

/** A control as the widget's bar shows it: the arg, its label and type, and the values offered. */
export interface WidgetControlView {
  readonly arg: string;
  readonly label: string;
  readonly type: GinTypeDef;
  readonly required: boolean;
  /** The only values offered, in order; absent offers the type's own editor. */
  readonly choices?: readonly Json[];
  /** Whether a value outside `choices` may be typed. */
  readonly custom: boolean;
}

/** `due_before` → "Due before". */
function argLabel(arg: string): string {
  return actionLabel(arg);
}

/** The controls a widget shows, in its source's arg order: every arg not pinned, hidden or driven by the pager. */
export function widgetControls(source: GinTypeDef, spec: Pick<WidgetSpecV1, 'controls' | 'paging'>): WidgetControlView[] {
  const paging = pagingArgs(spec);
  const byArg = new Map(spec.controls.map((control) => [control.arg, control]));
  return argsOf(source).flatMap((arg): WidgetControlView[] => {
    const control = byArg.get(arg.name);
    if (paging.has(arg.name) || control?.pinned !== undefined || control?.hidden === true) { return []; }
    return [{
      arg: arg.name,
      label: control?.label ?? argLabel(arg.name),
      type: arg.type,
      required: arg.required,
      ...(control?.choices === undefined ? {} : { choices: control.choices }),
      custom: control?.choices === undefined || control.custom === true,
    }];
  });
}

// ─── Checks ───────────────────────────────────────────────────────────────────

/** What `checkWidget` is given besides the spec: the source's args type, a real result, every declared visual. */
export interface WidgetCheckInput {
  readonly args: GinTypeDef;
  readonly table: ResultTable;
  readonly visuals: readonly ContributionDecl[];
}

/** What `checkWidget` finds: the spec's visuals that still fit, in order, and every problem in words. */
export interface WidgetCheckResult {
  readonly visuals: WidgetVisualV1[];
  readonly problems: string[];
}

const NUMBER_TYPES: ReadonlySet<string> = new Set(['num']);

/**
 * Every problem with a widget spec against its source's args and a real result: controls and paging naming args the
 * source lacks, a required arg hidden with no value, visuals that aren't declared, bindings to missing columns or to
 * columns of a kind the channel doesn't take, visuals whose shape doesn't fit, and actions binding missing columns.
 * A visual with a problem leaves `visuals`; the rest keep the spec's order.
 */
export function checkWidget(spec: WidgetSpecV1, input: WidgetCheckInput): WidgetCheckResult {
  const problems: string[] = [];
  const args = new Map(argsOf(input.args).map((arg) => [arg.name, arg]));
  const columns = new Map(input.table.columns.map((column) => [column.name, column]));
  const seen = new Set<string>();
  for (const control of spec.controls) {
    const arg = args.get(control.arg);
    if (arg === undefined) { problems.push(`Control ${control.arg}: ${spec.source} has no arg ${control.arg}.`); continue; }
    if (seen.has(control.arg)) { problems.push(`Control ${control.arg} is listed twice.`); }
    seen.add(control.arg);
    if (control.hidden === true && control.pinned === undefined && arg.required) {
      problems.push(`Control ${control.arg} is hidden, but the arg is required: pin a value or show it.`);
    }
    if (control.pinned !== undefined && control.choices !== undefined && !control.choices.some((choice) => sameJson(choice, control.pinned))) {
      problems.push(`Control ${control.arg} pins a value that is not one of its choices.`);
    }
  }
  for (const [role, arg] of [['offset', spec.paging?.offset], ['limit', spec.paging?.limit]] as const) {
    if (arg === undefined) { continue; }
    const found = args.get(arg);
    if (found === undefined) { problems.push(`Paging ${role}: ${spec.source} has no arg ${arg}.`); continue; }
    if (!NUMBER_TYPES.has(found.type.name)) { problems.push(`Paging ${role}: arg ${arg} is not a number.`); }
    if (spec.controls.some((control) => control.arg === arg)) { problems.push(`Arg ${arg} is driven by the pager, so it can't have a control too.`); }
  }
  const declared = new Map(input.visuals.filter((entry) => entry.registry === HUB_VISUALS).map((entry) => [entry.name, entry]));
  const fitting = new Set(fittingVisuals(input.table, input.visuals, spec.paging !== undefined).map((fit) => fit.name));
  const visuals: WidgetVisualV1[] = [];
  const named = new Set<string>();
  for (const offered of spec.visuals) {
    const before = problems.length;
    if (named.has(offered.visual)) { problems.push(`Visual ${offered.visual} is offered twice.`); }
    named.add(offered.visual);
    const entry = declared.get(offered.visual);
    if (entry === undefined) { problems.push(`Visual ${offered.visual} is not in ${HUB_VISUALS}.`); continue; }
    if (entry.shape !== undefined) {
      problems.push(...bindingProblems(offered, entry.shape, columns));
      if (!fitting.has(offered.visual)) {
        const why = declaredFit(entry.shape, spec.paging === undefined ? input.table : { ...input.table, offset: 0, truncated: false }).why;
        problems.push(`Visual ${offered.visual} doesn't fit this result${why === undefined ? '.' : `: ${why}`}`);
      }
    }
    if (problems.length === before) { visuals.push(offered); }
  }
  for (const action of spec.actions ?? []) {
    for (const [arg, column] of Object.entries(action.bind)) {
      if (!columns.has(column)) { problems.push(`Action ${action.fn}: arg ${arg} binds column ${column}, which the result lacks.`); }
    }
  }
  return { visuals, problems };
}

/** The problems with one visual's bindings: unknown channels, missing columns, kinds the channel doesn't take. */
function bindingProblems(offered: WidgetVisualV1, shape: VisualShape, columns: ReadonlyMap<string, ResultColumn>): string[] {
  const problems: string[] = [];
  const channels = new Map(shape.channels.map((c) => [c.name, c]));
  for (const [name, bound] of Object.entries(offered.bind)) {
    const channelDecl = channels.get(name);
    if (channelDecl === undefined) { problems.push(`Visual ${offered.visual} has no channel ${name} (it has ${[...channels.keys()].join(', ')}).`); continue; }
    if (!channelDecl.many && bound.length > 1) { problems.push(`Visual ${offered.visual}: channel ${name} takes one column, not ${String(bound.length)}.`); }
    for (const columnName of bound) {
      const column = columns.get(columnName);
      if (column === undefined) { problems.push(`Visual ${offered.visual}: channel ${name} binds column ${columnName}, which the result lacks.`); continue; }
      if (!channelDecl.accepts.includes(column.kind)) {
        problems.push(`Visual ${offered.visual}: channel ${name} takes ${channelDecl.accepts.join(', ')}, but column ${columnName} is ${column.kind}.`);
      }
    }
  }
  return problems;
}

/** Whether two JSON values are the same value. */
function sameJson(a: Json, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── The authoring schema ─────────────────────────────────────────────────────

/** What `widgetSpecSchema` builds from: the source, its args, a sample result, the fitting visuals and the row methods. */
export interface WidgetSchemaInput {
  readonly source: QualifiedName;
  readonly args: GinTypeDef;
  readonly columns: readonly ResultColumn[];
  readonly visuals: readonly FittingVisual[];
  /** The fns an action may name (the row types' methods); absent: any fn. */
  readonly actions?: readonly QualifiedName[];
}

/** A zod enum of names, or `undefined` when there are none (zod enums need one value). */
function namesOf(names: readonly string[]): z.ZodType<string> | undefined {
  const [first, ...rest] = names;
  return first === undefined ? undefined : z.enum([first, ...rest]);
}

/**
 * The strict schema an authoring agent drafts a widget against, built at tool time: the source is fixed, a visual is one
 * of those that fit with a binding per channel naming only columns that channel takes, a control names one of the
 * source's args, paging names its number args, and an action names one of the row methods. What the schema can't say
 * (a required arg hidden with no value) `checkWidget` catches.
 */
export function widgetSpecSchema(input: WidgetSchemaInput): z.ZodType<WidgetSpecV1> {
  const argNames = namesOf(argsOf(input.args).map((arg) => arg.name)) ?? z.never();
  const numberArgs = namesOf(argsOf(input.args).filter((arg) => NUMBER_TYPES.has(arg.type.name)).map((arg) => arg.name)) ?? z.never();
  const columnNames = namesOf(input.columns.map((column) => column.name)) ?? z.never();
  const visualSchemas = input.visuals.map((fit) => z.object({
    visual: z.literal(fit.name).describe(`${fit.label}: ${fit.shape.channels.map((c) => `${c.name} (${c.label}; ${c.accepts.join('/')}${c.required ? '' : ', optional'}${c.many ? ', several' : ''})`).join(', ')}`),
    label: z.string().min(1).optional(),
    bind: z.strictObject(Object.fromEntries(fit.shape.channels.flatMap((c) => {
      const accepted = namesOf(input.columns.filter((column) => c.accepts.includes(column.kind)).map((column) => column.name));
      return accepted === undefined ? [] : [[c.name, z.array(accepted).min(1).max(c.many ? 20 : 1).optional()]];
    }))).transform((bind) => Object.fromEntries(Object.entries(bind).filter((entry): entry is [string, string[]] => entry[1] !== undefined))),
  }));
  const [firstVisual, ...moreVisuals] = visualSchemas;
  const visualSchema = firstVisual === undefined ? z.never() : moreVisuals.length === 0 ? firstVisual : z.union([firstVisual, ...moreVisuals]);
  const actionFn = namesOf(input.actions ?? []) ?? QualifiedName;
  const strict = z.strictObject({
    title: z.string().min(1).describe('What the widget shows, in a few words ("Open tasks by owner").'),
    source: z.literal(input.source),
    visuals: z.array(visualSchema).min(1).describe('The visuals to switch between, the best first.'),
    controls: z.array(z.strictObject({
      arg: argNames,
      label: z.string().min(1).optional(),
      choices: z.array(Json).min(1).optional(),
      custom: z.boolean().optional(),
      pinned: Json.optional(),
      hidden: z.boolean().optional(),
    })).describe('One per source arg the person should see differently (labelled, limited to choices, pinned or hidden); args left out show as they are.'),
    paging: z.strictObject({ offset: numberArgs.optional(), limit: numberArgs.optional(), size: z.number().int().min(1).max(500) }).optional(),
    actions: z.array(z.strictObject({
      fn: actionFn,
      label: z.string().min(1).optional(),
      confirm: z.literal(true).optional(),
      bind: z.record(argNames, columnNames),
      then: z.enum(['refresh', 'show', 'none']),
    })).optional().describe('Leave out to offer every action of the row type; [] for none.'),
  });
  return strict.pipe(WidgetSpecV1);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/** A fn a row could run: a method of the row's type (or any fn), its mode and args. */
export interface RowFn {
  readonly fn: QualifiedName;
  readonly mode: FnMode;
  readonly args: GinTypeDef;
}

/**
 * The actions a row offers: every row fn when the spec lists none, else the listed ones in their order, each labelled
 * (`actionLabel` unless relabelled), confirming when `confirmOf` says so, with its bound args and a form for the args
 * left. A method's value (`self`) is bound by the row's ref, so it never shows in the form. A listed action whose fn
 * isn't a row fn is left out.
 */
export function widgetActionOptions(rowFns: readonly RowFn[], actions: readonly WidgetActionV1[] | undefined): WidgetActionOptionV1[] {
  const byFn = new Map(rowFns.map((rowFn) => [rowFn.fn, rowFn]));
  const chosen: Array<{ rowFn: RowFn; action: WidgetActionV1 | undefined }> = actions === undefined
    ? rowFns.map((rowFn) => ({ rowFn, action: undefined }))
    : actions.flatMap((action) => { const rowFn = byFn.get(action.fn); return rowFn === undefined ? [] : [{ rowFn, action }]; });
  return chosen.map(({ rowFn, action }) => {
    const bind = action?.bind ?? {};
    const left = Object.fromEntries(Object.entries(rowFn.args.props ?? {}).filter(([name]) => name !== 'self' && !(name in bind)));
    const then: ActionThenV1 = action?.then ?? (rowFn.mode === 'read' ? 'show' : 'refresh');
    return {
      fn: rowFn.fn,
      label: action?.label ?? actionLabel(rowFn.fn),
      mode: rowFn.mode,
      confirm: confirmOf(rowFn.mode, action?.confirm),
      bind: { ...bind },
      ...(Object.keys(left).length === 0 ? {} : { form: { ...rowFn.args, props: left } }),
      then,
    };
  });
}
