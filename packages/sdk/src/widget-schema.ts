/**
 * The strict schema `widgets/make_widget`'s agent proposes a widget against, built per call from the source and a real
 * result (product's strict schema): a broken widget can't be spelled. The visual is one of the ranked ones, each with
 * an enum of its fitting styles and, per channel, an enum of the columns that channel may bind; the arg plans have
 * exactly the source's args that the pager doesn't drive (range args only when no chosen visual draws the range), each value typed by the arg's gin type (an enum's
 * members, a number's range, relative dates only for date args); presets, actions and the drill name only what exists.
 * What a static schema can't say (a binding that breaks a visual's rule, a preset setting a pinned arg) the schema's
 * refinement catches with `checkWidget`, so the agent's tool call fails with the reason and the agent fixes it.
 */
import {
  ActionThen, ArgPlan, ArgValue, LocalName, WidgetAction, WidgetDrill, WidgetSpec,
  type ColumnFacts, type GinTypeDef, type QualifiedName, type ResultFacts, type ResultTable, type VisualChannel, type VisualRank, type WidgetPreset, type WidgetVisual,
} from '@harness/core';
import type { TypeScope } from '@aeye/gin';
import { z } from 'zod';
import { relativeDatesFor } from './relative-dates.ts';
import { checkWidget } from './widget-check.ts';
import { argsOf, ginTypeOf, pagingOf, rangeOf, type ArgInfo, type VisualContribution } from './widgets.ts';

/** What `widgetProposalSchema` builds from. */
export interface WidgetProposalSchemaInput {
  /** The source fn, a read fn returning a table. */
  readonly source: QualifiedName;
  /** Its args type. */
  readonly args: GinTypeDef;
  /** The facts of a real result of it (`resultFacts`). */
  readonly facts: ResultFacts;
  /** The visuals that draw it, best first (`rankedVisuals(entries, facts)`'s ranks). */
  readonly ranked: readonly VisualRank[];
  /** Every `HUB_VISUALS` contribution, for the visuals' shapes and labels. */
  readonly entries: readonly VisualContribution[];
  /** The sample's rows, so rules over values are judged too. */
  readonly table?: Pick<ResultTable, 'rows' | 'columns'>;
  /** The fns an action may name (the row types' methods and any fn it may bind); none: actions are derived. */
  readonly actions?: readonly QualifiedName[];
  /** The read fns returning a table a click may drill into; none: a click opens the row's action menu. */
  readonly drills?: readonly QualifiedName[];
  /** The source declares a live source (`FnDecl.live`), so the widget may re-run on its own. */
  readonly live?: boolean;
  /** Where the args' named types resolve; `g` without it. */
  readonly scope?: TypeScope;
}

/**
 * What the agent writes, as every call's schema shares it (the per-call schema narrows each part): the fn's name and
 * description, the title, the visual shown first (its style, label, and bindings replacing the default ones), the
 * other visuals the switcher offers (each with its default binding and first style), a plan per arg, presets, and the
 * optional actions, drill and live flag.
 */
export const WidgetDraftInput = z.object({
  name: LocalName,
  description: z.string().min(1),
  title: z.string().min(1),
  choice: z.object({ visual: LocalName, style: LocalName, label: z.string().min(1).optional(), bind: z.record(LocalName, z.array(z.string().min(1)).min(1).optional()).optional() }),
  more: z.array(LocalName),
  args: z.record(LocalName, ArgPlan),
  presets: z.array(z.object({ label: z.string().min(1), sets: z.record(LocalName, ArgValue.optional()) })),
  actions: z.array(WidgetAction).optional(),
  drill: WidgetDrill.optional(),
  live: z.boolean().optional(),
});
export type WidgetDraftInput = z.infer<typeof WidgetDraftInput>;

/** A proposal's saved parts: the fn's name and description and the widget spec. */
export interface WidgetDraft {
  readonly name: z.infer<typeof LocalName>;
  readonly description: string;
  readonly spec: WidgetSpec;
}

/** The strict schema of one call and how to read a parsed draft as a spec. */
export interface WidgetProposalSchema {
  /**
   * The agent's tool input, its output typed by `WidgetDraftInput`: its input side is this call's strict schema, so
   * take its JSON Schema with `io: 'input'` (as the SDK's LLM wire does) to keep every enum.
   */
  readonly schema: z.ZodType<WidgetDraftInput>;
  /** A draft the schema accepts, as the fn name, description and spec. Throws when `value` doesn't parse. */
  read(value: unknown): WidgetDraft;
}

/** A zod enum of names, or `undefined` when there are none (a zod enum needs one value). */
function enumOf(names: readonly string[]): z.ZodEnum<Record<string, string>> | undefined {
  const [first, ...rest] = [...new Set(names)];
  return first === undefined ? undefined : z.enum([first, ...rest]);
}

/** The columns a channel may bind: readable, of a kind it takes, with the role it wants. */
function bindable(channel: VisualChannel, columns: readonly ColumnFacts[]): string[] {
  return columns.filter((column) => !column.opaque && channel.accepts.includes(column.kind) && (channel.role === undefined || channel.role === column.role)).map((column) => column.name);
}

/** An argument value for one arg: a literal of its type, or (for a date or timestamp arg) a relative date. */
function argValueSchema(arg: ArgInfo, scope: TypeScope | undefined): z.ZodType {
  const typed: z.ZodType = ginTypeOf(arg.type, scope).toValueSchema({ ...(scope === undefined ? {} : { scope }), unknownKeys: 'refuse' });
  const literal = z.strictObject({ literal: typed }).describe(`A ${arg.type.name} value.`);
  const relative = enumOf(relativeDatesFor(arg.type.name));
  return relative === undefined ? literal : z.union([literal, z.strictObject({ relative }).describe('A relative date, resolved each time the widget runs.')]);
}

/** One arg's plan: a chip (labelled, with typed choices and default), pinned to a typed value, or hidden (only with a default). */
function argPlanSchema(arg: ArgInfo, scope: TypeScope | undefined): z.ZodType {
  const value = argValueSchema(arg, scope);
  const choice = z.strictObject({ label: z.string().min(1), value: arg.required ? value : value.optional() });
  const control = z.strictObject({
    show: z.literal('control'),
    label: z.string().min(1).optional().describe('The chip\'s words, when the arg\'s name doesn\'t say it.'),
    choices: z.array(choice).min(1).optional().describe(arg.required ? 'The only values offered, in order.' : 'The only values offered, in order; a choice without a value clears the arg ("Any").'),
    custom: z.boolean().optional().describe('Whether a value outside the choices may be typed.'),
    default: value.optional(),
  });
  const pinned = z.strictObject({ show: z.literal('pinned'), value }).describe('Fixed: no chip, and the widget\'s callers can\'t change it.');
  const hidden = z.strictObject({ show: z.literal('hidden') }).describe('No chip: the arg takes its default.');
  return arg.required ? z.discriminatedUnion('show', [control, pinned]) : z.discriminatedUnion('show', [control, pinned, hidden]);
}

/** The first visual: a union over the ranked visuals, each with its styles and per-channel column enums. */
function choiceSchema(input: WidgetProposalSchemaInput): z.ZodType {
  const shapes = new Map(input.entries.map((entry) => [entry.name, entry]));
  const options = input.ranked.flatMap((rank) => {
    const entry = shapes.get(rank.visual);
    const styles = enumOf(rank.styles);
    if (entry?.shape === undefined || styles === undefined) { return []; }
    const bind = Object.fromEntries(entry.shape.channels.flatMap((channel) => {
      const columns = enumOf(bindable(channel, input.facts.columns));
      return columns === undefined ? [] : [[channel.name, z.array(columns).min(channel.many ? channel.min ?? 1 : 1).max(channel.many ? input.facts.columns.length : 1).optional().describe(channel.label)]];
    }));
    return [z.strictObject({
      visual: z.literal(rank.visual),
      style: styles,
      label: z.string().min(1).optional(),
      bind: z.strictObject(bind).optional().describe(`Columns per channel, only where the default (${JSON.stringify(rank.bind)}) is wrong.`),
    }).describe(entry.label)];
  });
  const [first, ...rest] = options;
  if (first === undefined) { throw new Error(`No visual draws ${input.source}'s result.`); }
  return rest.length === 0 ? first : z.discriminatedUnion('visual', [first, ...rest]);
}

/** The args the pager drives (they get no plan) and the range args (a plan only when no chosen visual draws the range). */
function claimed(input: WidgetProposalSchemaInput): { readonly paging: Set<string>; readonly range: Set<string> } {
  const paging = pagingOf(input.args);
  const range = rangeOf(input.args);
  const names = (list: readonly (string | undefined)[]): Set<string> => new Set(list.filter((name): name is string => name !== undefined));
  return { paging: names([paging?.offset, paging?.limit]), range: names([range?.from, range?.to]) };
}

/** A draft as a spec: the chosen visual with its bindings over the default, the rest with theirs, paging and range found. */
function specOf(input: WidgetProposalSchemaInput, draft: WidgetDraftInput): WidgetSpec {
  const ranks = new Map(input.ranked.map((rank) => [rank.visual, rank]));
  const shapes = new Map(input.entries.map((entry) => [entry.name, entry.shape]));
  const chosen = ranks.get(draft.choice.visual);
  const bind: Record<string, string[]> = { ...chosen?.bind };
  for (const [name, columns] of Object.entries(draft.choice.bind ?? {})) { if (columns !== undefined) { bind[name] = [...columns]; } }
  const first: WidgetVisual = { visual: draft.choice.visual, style: draft.choice.style, ...(draft.choice.label === undefined ? {} : { label: draft.choice.label }), bind };
  const more = draft.more.filter((name) => name !== draft.choice.visual).flatMap((name): WidgetVisual[] => {
    const rank = ranks.get(name);
    const style = rank?.styles[0];
    return rank === undefined || style === undefined ? [] : [{ visual: name, style, bind: rank.bind }];
  });
  const visuals = [first, ...more];
  const range = rangeOf(input.args);
  // a range is the only claim a visual makes today
  const claims = visuals.some((offered) => (shapes.get(offered.visual)?.claims ?? []).length > 0);
  const paging = pagingOf(input.args);
  const presets = draft.presets.map((preset): WidgetPreset => ({
    label: preset.label,
    sets: Object.fromEntries(Object.entries(preset.sets).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]]))),
  }));
  return WidgetSpec.parse({
    title: draft.title, source: input.source, visuals, args: draft.args, presets,
    ...(range !== undefined && claims ? { range } : {}), ...(paging === undefined ? {} : { paging }),
    ...(draft.actions === undefined ? {} : { actions: draft.actions }), ...(draft.drill === undefined ? {} : { drill: draft.drill }),
    ...(draft.live === true && input.live === true ? { live: true } : {}),
  });
}

/**
 * The strict schema of one `make_widget` call, from the source's args, a real result's facts and the visuals that
 * draw it, and how to read what it accepts as a spec. Throws when no visual draws the result.
 *
 * ```ts
 * const ranked = rankedVisuals(entries, facts).map((r) => r.rank);
 * const { schema, read } = widgetProposalSchema({ source, args, facts, ranked, entries });
 * // schema is the propose tool's input; read(toolInput) is the proposal's name, description and spec
 * ```
 */
export function widgetProposalSchema(input: WidgetProposalSchemaInput): WidgetProposalSchema {
  const taken = claimed(input);
  const open = argsOf(input.args).filter((arg) => !taken.paging.has(arg.name));
  const plans = z.strictObject(Object.fromEntries(open.map((arg) => {
    const plan = argPlanSchema(arg, input.scope);
    const about = `${arg.name}: ${arg.type.name}${arg.required ? ', required' : ''}`;
    // a visual that draws a range (time, calendar, timeline, finance) drives these, so they take a plan only without one
    return [arg.name, taken.range.has(arg.name) ? plan.optional().describe(`${about}; a range arg: leave it out when a chosen visual draws a range`) : plan.describe(about)];
  })));
  const presetSets = z.strictObject(Object.fromEntries(open.map((arg) => [arg.name, argValueSchema(arg, input.scope).optional()])));
  const columns = enumOf(input.facts.columns.map((column) => column.name)) ?? z.never();
  const visuals = enumOf(input.ranked.map((rank) => rank.visual)) ?? z.never();
  const actionFns = enumOf(input.actions ?? []);
  const drillFns = enumOf(input.drills ?? []);
  const shape = {
    name: LocalName.describe('The widget fn\'s name, snake_case ("open_tasks_by_owner").'),
    description: z.string().min(1).describe('One sentence: what the widget shows.'),
    title: z.string().min(1).describe('The widget\'s heading, a few words ("Open tasks by owner").'),
    choice: choiceSchema(input).describe('The visual shown first; the ranked ones only, best first.'),
    more: z.array(visuals).describe('The other visuals the switcher offers (by default every ranked one).'),
    args: plans.describe('A plan for every arg of the source: a chip, pinned or hidden.'),
    presets: z.array(z.strictObject({ label: z.string().min(1), sets: presetSets })).describe('Named chips that set several args in one tap ("Overdue"); [] for none.'),
    ...(actionFns === undefined ? {} : {
      actions: z.array(z.strictObject({
        fn: actionFns, label: z.string().min(1).optional(), confirm: z.literal(true).optional(), bind: z.record(LocalName, columns), then: ActionThen.optional(),
      })).optional().describe('Leave out to offer every derived action; [] for none.'),
    }),
    ...(drillFns === undefined ? {} : {
      drill: z.strictObject({ fn: drillFns, label: z.string().min(1), bind: z.record(LocalName, columns) }).optional().describe('What clicking a bar, slice or row opens, its args from the clicked row\'s columns.'),
    }),
    ...(input.live === true ? { live: z.boolean().optional().describe('Re-run on its own while shown.') } : {}),
  };
  const schema = z.strictObject(shape).pipe(WidgetDraftInput).superRefine((draft, ctx) => {
    let spec: WidgetSpec;
    try {
      spec = specOf(input, draft);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const problem of checkWidget(spec, { args: input.args, facts: input.facts, entries: input.entries, ...(input.table === undefined ? {} : { table: input.table }), ...(input.scope === undefined ? {} : { scope: input.scope }) }).problems) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  });
  return {
    schema,
    read: (value) => {
      const draft = schema.parse(value);
      return { name: LocalName.parse(draft.name), description: draft.description, spec: specOf(input, draft) };
    },
  };
}
