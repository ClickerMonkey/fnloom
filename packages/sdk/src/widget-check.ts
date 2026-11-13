/**
 * Checking a widget spec (`WidgetSpec`) against its source and a real result, the one check the widgets kind's `check`
 * and `run`, `make_widget` and `save_widget` share. A problem is a sentence; a widget with problems still draws what
 * fits (`checkWidget().visuals`), so a source that changed shows what it can and says what broke.
 */
import { HUB_VISUALS, bindingProblems, type ArgValue, type GinTypeDef, type ResultFacts, type ResultTable, type VisualBinding, type VisualShape, type WidgetSpec, type WidgetVisual } from '@harness/core';
import type { TypeScope } from '@aeye/gin';
import { relativeDatesFor } from './relative-dates.ts';
import { argsOf, ginTypeOf, rankedVisuals, type ArgInfo, type VisualContribution } from './widgets.ts';

/** What `checkWidget` is given besides the spec. */
export interface WidgetCheckInput {
  /** The source's args type. */
  readonly args: GinTypeDef;
  /** The facts of a real result of the source (`resultFacts`), or of its declared columns. */
  readonly facts: ResultFacts;
  /** Every `HUB_VISUALS` contribution (the hub's `hub/visuals`). */
  readonly entries: readonly VisualContribution[];
  /** The rows, so rules over values (a tree's parent links) are judged too. */
  readonly table?: Pick<ResultTable, 'rows' | 'columns'>;
  /** Where the args' named types resolve (the hub's scope); `g` without it. */
  readonly scope?: TypeScope;
}

/** What `checkWidget` finds: the spec's visuals that draw this result, in its order, and every problem in words. */
export interface WidgetCheckResult {
  readonly visuals: WidgetVisual[];
  readonly problems: string[];
}

/** Why a value doesn't fill an argument, or `undefined` when it does. */
function valueProblem(arg: ArgInfo, value: ArgValue, scope: TypeScope | undefined): string | undefined {
  if ('relative' in value) {
    return relativeDatesFor(arg.type.name).includes(value.relative) ? undefined : `${value.relative} is not a relative date for a ${arg.type.name} argument.`;
  }
  return ginTypeOf(arg.type, scope).valid(value.literal, scope) ? undefined : `${JSON.stringify(value.literal)} is not a valid ${arg.type.name}.`;
}

/** The spec's arg names that it plans, presets or claims. */
function plannedArgs(spec: WidgetSpec): Set<string> {
  return new Set([
    ...Object.keys(spec.args), ...spec.presets.flatMap((preset) => Object.keys(preset.sets)),
    ...(spec.paging === undefined ? [] : [spec.paging.offset, spec.paging.limit]), ...(spec.range === undefined ? [] : [spec.range.from, spec.range.to]),
  ]);
}

/** Every problem with a spec's args against a source's args: plans, presets, paging and range. */
function argProblems(spec: WidgetSpec, sourceArgs: GinTypeDef, scope: TypeScope | undefined): string[] {
  const problems: string[] = [];
  const args = new Map(argsOf(sourceArgs).map((arg) => [arg.name, arg]));
  // the pager's args take no plan; the range's take a chip only (its default is the range the widget opens on)
  const paged = new Set<string>();
  const ranged = new Set<string>();
  const claim = (role: 'Paging' | 'Range', name: string, accepts: readonly string[]): void => {
    (role === 'Paging' ? paged : ranged).add(name);
    const arg = args.get(name);
    if (arg === undefined) { problems.push(`${role}: ${spec.source} has no arg ${name}.`); return; }
    if (!accepts.includes(arg.type.name)) { problems.push(`${role}: arg ${name} is ${arg.type.name}, not ${accepts.join(' or ')}.`); }
  };
  if (spec.paging !== undefined) { claim('Paging', spec.paging.offset, ['num']); claim('Paging', spec.paging.limit, ['num']); }
  if (spec.range !== undefined) { claim('Range', spec.range.from, ['date', 'timestamp']); claim('Range', spec.range.to, ['date', 'timestamp']); }
  const check = (where: string, arg: ArgInfo, value: ArgValue): void => {
    const problem = valueProblem(arg, value, scope);
    if (problem !== undefined) { problems.push(`${where}: ${problem}`); }
  };
  for (const [name, plan] of Object.entries(spec.args)) {
    const arg = args.get(name);
    if (arg === undefined) { problems.push(`Arg ${name}: ${spec.source} has no arg ${name}.`); continue; }
    if (paged.has(name)) { problems.push(`Arg ${name} is driven by the widget's pager, so it can't have a plan too.`); }
    if (ranged.has(name) && plan.show !== 'control') { problems.push(`Arg ${name} is driven by the widget's range, so it can't be ${plan.show}: give it a chip with the range the widget opens on.`); }
    if (plan.show === 'hidden' && arg.required) { problems.push(`Arg ${name} is hidden, but it has no default: pin a value or show it.`); }
    if (plan.show === 'pinned') { check(`Arg ${name}`, arg, plan.value); }
    if (plan.show !== 'control') { continue; }
    if (plan.default !== undefined) { check(`Arg ${name} default`, arg, plan.default); }
    for (const choice of plan.choices ?? []) {
      if (choice.value === undefined) { if (arg.required) { problems.push(`Arg ${name}: choice ${choice.label} clears it, but the arg is required.`); } continue; }
      check(`Arg ${name} choice ${choice.label}`, arg, choice.value);
    }
  }
  // a saved widget runs with no args given, so each required arg needs a value of its own (a range arg's chip default
  // is the range the widget opens on; only the pager fills its own)
  for (const arg of args.values()) {
    if (!arg.required || paged.has(arg.name)) { continue; }
    const plan = spec.args[arg.name];
    if (plan === undefined || (plan.show === 'control' && plan.default === undefined)) { problems.push(`Arg ${arg.name} is required: give its chip a default, or pin a value.`); }
  }
  for (const preset of spec.presets) {
    for (const [name, value] of Object.entries(preset.sets)) {
      const arg = args.get(name);
      if (arg === undefined) { problems.push(`Preset ${preset.label}: ${spec.source} has no arg ${name}.`); continue; }
      if (spec.args[name]?.show === 'pinned') { problems.push(`Preset ${preset.label}: arg ${name} is pinned, so a preset can't set it.`); }
      check(`Preset ${preset.label} arg ${name}`, arg, value);
    }
  }
  return problems;
}

/** The problems with one style: not the visual's, or not fitting this binding and result. */
function styleProblems(offered: WidgetVisual, shape: VisualShape, bind: VisualBinding, facts: ResultFacts): string[] {
  const style = shape.styles.find((s) => s.name === offered.style);
  if (style === undefined) { return [`style ${offered.style} is not one of ${shape.styles.map((s) => s.name).join(', ')}.`]; }
  return [
    ...(style.whole === true && !facts.whole ? [`style ${style.name} only draws a whole result.`] : []),
    ...(style.needs ?? []).filter((name) => bind[name] === undefined).map((name) => `style ${style.name} needs ${name} bound.`),
  ];
}

/**
 * Every problem with a widget spec against its source's args and a real result (or the source's declared columns):
 * arg plans naming args the source lacks, a required arg hidden, values that aren't the arg's type, presets setting
 * pinned or unknown args, paging and range args of the wrong kind; visuals not in `HUB_VISUALS`, styles they don't
 * have, bindings that don't draw (core's `bindingProblems`, a channel left out taking the default binding); action and
 * drill bindings to columns the result lacks. A visual with a problem leaves `visuals`; the rest keep the spec's order.
 */
export function checkWidget(spec: WidgetSpec, input: WidgetCheckInput): WidgetCheckResult {
  const problems = argProblems(spec, input.args, input.scope);
  const entries = new Map(input.entries.filter((entry) => entry.registry === HUB_VISUALS).map((entry) => [entry.name, entry]));
  const defaults = new Map(rankedVisuals(input.entries, input.facts, input.table).map((ranked) => [ranked.entry.name, ranked.rank.bind]));
  const visuals: WidgetVisual[] = [];
  const named = new Set<string>();
  for (const offered of spec.visuals) {
    const found: string[] = [];
    if (named.has(offered.visual)) { found.push('it is offered twice.'); }
    named.add(offered.visual);
    const shape = entries.get(offered.visual)?.shape;
    if (shape === undefined) {
      found.push(`it is not a visual of ${HUB_VISUALS}.`);
    } else {
      const bind: VisualBinding = { ...defaults.get(offered.visual), ...offered.bind };
      found.push(...bindingProblems(shape, bind, input.facts, input.table), ...styleProblems(offered, shape, bind, input.facts));
    }
    problems.push(...found.map((problem) => `Visual ${offered.visual}: ${problem}`));
    if (found.length === 0) { visuals.push(offered); }
  }
  const columns = new Set(input.facts.columns.map((column) => column.name));
  const binds: Array<{ readonly what: string; readonly bind: Readonly<Record<string, string>> }> = [
    ...(spec.actions ?? []).map((action) => ({ what: `Action ${action.fn}`, bind: action.bind })),
    ...(spec.drill === undefined ? [] : [{ what: `Drill ${spec.drill.fn}`, bind: spec.drill.bind }]),
  ];
  for (const { what, bind } of binds) {
    for (const [arg, column] of Object.entries(bind)) {
      if (!columns.has(column)) { problems.push(`${what}: arg ${arg} binds column ${column}, which the result lacks.`); }
    }
  }
  return { visuals, problems };
}

/** What `sourceCompatible` is given besides the spec and the new source's args. */
export interface SourceCompatibleOptions {
  /** The old source's args: each planned arg's new type must take every value of its old one (gin `compatible`). */
  readonly previous?: GinTypeDef;
  readonly scope?: TypeScope;
}

/**
 * Why a widget can't move to a new source (authoring-edit-source), or `[]` when it can: every arg it plans, presets,
 * pages or ranges must exist in the new source, take the values the widget stores, and (given the old args) take every
 * value its old type did, constraints included (gin `compatible` in value mode: an enum's members, a number's range).
 */
export function sourceCompatible(spec: WidgetSpec, args: GinTypeDef, options: SourceCompatibleOptions = {}): string[] {
  const problems = argProblems(spec, args, options.scope);
  if (options.previous === undefined) { return problems; }
  const before = new Map(argsOf(options.previous).map((arg) => [arg.name, arg]));
  const after = new Map(argsOf(args).map((arg) => [arg.name, arg]));
  for (const name of plannedArgs(spec)) {
    const old = before.get(name);
    const now = after.get(name);
    if (old === undefined || now === undefined) { continue; }
    if (!ginTypeOf(now.type, options.scope).compatible(ginTypeOf(old.type, options.scope), { value: true }, options.scope)) {
      problems.push(`Arg ${name}: the new source's ${now.type.name} doesn't take every ${old.type.name} the old one did.`);
    }
  }
  return problems;
}
