/**
 * The widget authoring agent behind `make_widget`, on the SDK's `authoringAgent` (product's widget-authoring fn): the
 * chat model passes the source fn and what the person wants; this agent reads the source and a real sample, then
 * proposes a widget against a strict schema built for that source and result (`widgetProposalSchema`). The chat gets
 * the proposal with its preview, never the working context, and nothing is saved: the person presses Save.
 *
 * - **inspect:** `source` shows the source fn's args (which ones the pager and range drive), a sample of its rows with
 *   each column's facts, the visuals that draw it with their styles, channels and default bindings, the row actions and
 *   drills, and the widget being changed, if any. It builds the strict schema of the proposal from what it read.
 * - **propose → check → fix:** a proposal is read as a spec and checked by running it for real (the preview): the
 *   widget's own check, the source change rule when it edits a widget, and a preview that draws.
 * - **offer:** the clean proposal is what `make_widget` answers with.
 */
import {
  WIDGETS_SYSTEM, qualify, type FnLive, type GinTypeDef, type Json, type QualifiedName, type ResultTable, type VisualRank, type WidgetActionOption, type WidgetResult, type WidgetSpec,
} from '@harness/core';
import {
  argsOf, pagingOf, rangeOf, rankedVisuals, resultFacts, sourceCompatible, widgetProposalSchema, type VisualContribution, type WidgetDraft, type WidgetProposalSchema,
} from '@harness/sdk';
import { authoringAgent, authoringTool, type AuthoredFn, type AuthoringSession } from '@harness/sdk/server';
import { z } from 'zod';

/** The source fn as the hub declares it. */
export interface SourceDecl {
  readonly fn: QualifiedName;
  readonly description: string;
  readonly args: GinTypeDef;
  readonly live?: FnLive | undefined;
}

/** A widget being changed: its fn and spec. */
export interface EditedWidget {
  readonly fn: QualifiedName;
  readonly spec: WidgetSpec;
}

/** What a widget authoring run needs from its run: the source, samples, the registry, row actions and a preview. */
export interface WidgetAuthoringDeps {
  /** The source fn's declaration; throws with why when it is not a fn the person may read. */
  source(fn: QualifiedName): Promise<SourceDecl>;
  /** A small sample of the source's rows (`hub/read_table`), refused when it doesn't read or return a table. */
  sample(fn: QualifiedName, args: Readonly<Record<string, Json>>): Promise<ResultTable>;
  /** Every visual of `hub/visuals`. */
  visuals(): Promise<readonly VisualContribution[]>;
  /** The actions rows of these types offer the person, and these other fns as actions (any fn may be bound). */
  rowActions(types: readonly QualifiedName[], fns: readonly QualifiedName[]): Promise<WidgetActionOption[]>;
  /** The widget run for real with these args, as the view will draw it. */
  preview(spec: WidgetSpec, source: SourceDecl, given: Readonly<Record<string, Json>>): Promise<WidgetResult>;
  /** The rows a sample holds. */
  readonly sampleRows: number;
}

/** What `make_widget` was asked: the source, the person's words, sample args and the widget it changes. */
export interface WidgetRequest {
  readonly source: QualifiedName;
  readonly args: Readonly<Record<string, Json>>;
  /** Other fns the request names to bind as actions or the drill. */
  readonly fns: readonly QualifiedName[];
  readonly edited?: EditedWidget | undefined;
}

/** What the `source` tool read, kept for the proposal's schema and check. */
interface SourceRead {
  readonly source: SourceDecl;
  readonly schema: WidgetProposalSchema;
}

/** One widget authoring run's state: its deps, what was asked, what the source tool read and the proposal. */
export class WidgetAuthoring {
  readonly deps: WidgetAuthoringDeps;
  readonly asked: WidgetRequest;
  #read: SourceRead | undefined;
  #proposal: { readonly draft: WidgetDraft; readonly preview: WidgetResult } | undefined;
  #checked: { readonly draft: WidgetDraft; readonly preview: WidgetResult } | undefined;

  constructor(deps: WidgetAuthoringDeps, asked: WidgetRequest) {
    this.deps = deps;
    this.asked = asked;
  }

  /** What the source tool read; throws before it ran (the propose tool is offered only after it). */
  get read(): SourceRead {
    if (this.#read === undefined) { throw new Error('Call source first.'); }
    return this.#read;
  }

  /** The proposal offered, once there is one. */
  get proposal(): { readonly draft: WidgetDraft; readonly preview: WidgetResult } | undefined {
    return this.#proposal;
  }

  learned(read: SourceRead): void {
    this.#read = read;
  }

  checked(draft: WidgetDraft, preview: WidgetResult): void {
    this.#checked = { draft, preview };
  }

  /** Offer the last clean proposal. */
  offer(): { readonly draft: WidgetDraft; readonly preview: WidgetResult } {
    if (this.#checked === undefined) { throw new Error('There is no clean proposal to offer.'); }
    this.#proposal = this.#checked;
    return this.#checked;
  }
}

/** One example, as the agent reads it: a request, what the source showed, and the proposal that answers it. */
const EXAMPLE = {
  request: 'Sales by month as a line chart, with the region as a chip and presets for this year and this quarter.',
  source: 'database/main.sales_by_month(region?: text, from: date, to: date, limit?: num, offset?: num) — the pager drives limit/offset, the range drives from/to',
  columns: 'month (date, group), region (text, group, 4 distinct), total (number, measure)',
  proposal: {
    name: 'sales_by_month',
    description: 'Monthly sales totals, with the region to filter by.',
    title: 'Sales by month',
    choice: { visual: 'time', style: 'line' },
    more: ['category', 'table'],
    args: {
      region: { show: 'control', label: 'Region', choices: [{ label: 'Any' }, { label: 'North', value: { literal: 'north' } }, { label: 'South', value: { literal: 'south' } }] },
      from: { show: 'control', label: 'From', default: { relative: 'startOf(year)' } },
      to: { show: 'control', label: 'To', default: { relative: 'today' } },
    },
    presets: [
      { label: 'This year', sets: { from: { relative: 'startOf(year)' }, to: { relative: 'today' } } },
      { label: 'This quarter', sets: { from: { relative: 'startOf(quarter)' }, to: { relative: 'today' } } },
    ],
  },
};

/** The agent's job, step by step, with worked examples. */
const INSTRUCTIONS = [
  'You design one widget: a saved view of the source fn\'s table that the person will open again. You propose it; the person sees a preview and presses Save. You never save.',
  '',
  '1. Call source. It shows the source\'s args (and which the pager and the range drive), real sample rows with what each column is, the visuals that draw them best first with their styles and default bindings, the row actions and drills.',
  '2. Call propose with the whole widget. Its schema only lets you name what source showed: the visuals that draw this result, the columns each channel may bind, the args and their typed values.',
  '   - choice: the visual the person asked for, else the first one listed (it ranks best). Bind a channel only where the default binding is wrong for the request.',
  '   - more: the other visuals worth switching to (always keep table).',
  '   - args: a plan for every arg. A chip (show: control) for what the person will change, with plain words and choices when the values are few (an optional arg gets an "Any" choice with no value);',
  '     pinned for what the request fixes (a record type, "only open tasks"); hidden for what nobody needs to see (only an arg with a default). Dates may be relative ({"relative": "today-7d"}), so a saved widget stays current.',
  '     Range args (source says the range drives them) are always chips, never pinned or hidden: the chart moves them, and their defaults are where the range opens, so a required one needs a default.',
  '     Every other arg source lists needs a plan, optional ones too. An optional arg nobody needs to change (most often `sort`) is {"show": "hidden"}. To fix an order, pin the sort: {"sort": {"show": "pinned", "value": {"literal": [{"column": "total", "dir": "desc"}]}}} (a list of {column, dir}, the column one source lists, dir "asc" or "desc").',
  '     A value is always wrapped: {"literal": <value>} or, for a date, {"relative": "today"}; a plain value where a wrapped one is expected is refused.',
  '   - presets: named chips that set several args at once when the request names them ("Overdue", "This week"); [] otherwise.',
  '   - actions: leave out to offer every row action; list them only to narrow, relabel or bind another fn to the row\'s columns. drill: only when the request says what a click should open (a grouped database query drills into the rows behind a group on its own).',
  '   - name: snake_case after what it shows; title: a few words; description: one sentence.',
  '3. The proposal is run for real and checked. Fix every problem listed and propose again, whole. When it is clean, call offer, then answer in one line.',
  '   Each problem names the arg, visual or field it is about: change only that and keep the rest of the proposal as it was. Never send the same proposal twice.',
  '',
  'Always end with a proposal you offered. When the visual the person asked for is not listed (an empty sample, or columns it can\'t draw), propose the best listed one and say in your answer which they asked for and why it was not offered (for example: the sample had no rows, so no line chart could be checked).',
  'Charts that need maths over rows (a histogram, a boxplot, a pie with "Other") are only listed when the sample is the whole result. When the person wants a total, a count or an average by something and the source gives rows, say in your answer that a query that aggregates is needed; propose the best fitting visual of what the source gives.',
  '',
  `Example. Request: "${EXAMPLE.request}" Source: ${EXAMPLE.source}. Columns: ${EXAMPLE.columns}. The proposal:`,
  JSON.stringify(EXAMPLE.proposal),
  'Example. Request: "my open tasks by stage" over hub/records_table(type: text, query?: …, limit?, offset?). It gives one row per task (its fields and id) and never counts, so there is no count to chart. Pin the type ({"type": {"show": "pinned", "value": {"literal": "tasks/Task"}}}), pin the query to open tasks, choose the table visual in its cards style (or table), and answer that a count by stage needs a query that aggregates (stage, count); over that query the category visual with x = stage, y = count fits.',
].join('\n');

type Session = AuthoringSession<WidgetAuthoring, unknown>;

/** One column's facts in a line: `stage (text, group, 4 distinct)`. */
function columnLine(column: ReturnType<typeof resultFacts>['columns'][number]): string {
  const range = column.min === undefined ? '' : `, ${JSON.stringify(column.min)} to ${JSON.stringify(column.max)}`;
  const members = column.members === undefined ? '' : `, one of ${column.members.join(' | ')}`;
  return `- ${column.name} (${column.kind}, ${column.role}${column.opaque ? ', not readable: never bound' : ''}, ${String(column.distinct)} distinct${range}${members}${column.nulls > 0 ? `, ${String(Math.round(column.nulls * 100))}% empty` : ''})`;
}

/** One ranked visual in a line, with its styles, channels and default binding. */
function visualLine(rank: VisualRank, entries: readonly VisualContribution[]): string {
  const entry = entries.find((candidate) => candidate.name === rank.visual);
  const channels = (entry?.shape?.channels ?? []).map((channel) => `${channel.name}${channel.required ? '' : '?'}${channel.many ? '[]' : ''}: ${channel.label}`).join(', ');
  return `- ${rank.visual} (${entry?.label ?? rank.visual}): styles ${rank.styles.join(', ')}; channels ${channels}; default ${JSON.stringify(rank.bind)}`;
}

/** The row types of a table: its records' type and its columns' refs. */
function rowTypes(table: ResultTable): QualifiedName[] {
  return [...new Set([table.records?.type, ...table.columns.map((column) => column.ref)].filter((type): type is QualifiedName => type !== undefined))];
}

/** `source`: the source fn, a real sample, the visuals that draw it, row actions and drills; builds the proposal schema. */
const sourceTool = authoringTool<WidgetAuthoring, unknown, Record<string, never>>({
  name: 'source',
  stage: 'inspect',
  description: 'Show the source fn\'s args, real sample rows with each column\'s facts, the visuals that draw them (best first), the row actions and drills, and the widget being changed.',
  instructions: 'Call it once, first.',
  schema: z.object({}),
  when: (session) => !session.disclosure.isLoaded('fn', session.state.asked.source),
  async call(_input, session) {
    const { deps, asked } = session.state;
    const source = await deps.source(asked.source);
    const paging = pagingOf(source.args);
    const range = rangeOf(source.args);
    const sampleArgs = paging === undefined ? asked.args : { ...asked.args, [paging.offset]: 0, [paging.limit]: deps.sampleRows };
    const [table, entries] = await Promise.all([deps.sample(asked.source, sampleArgs), deps.visuals()]);
    const facts = resultFacts(table);
    const ranked = rankedVisuals(entries, facts, table).map((item) => item.rank);
    const types = rowTypes(table);
    const actions = types.length === 0 && asked.fns.length === 0 ? [] : await deps.rowActions(types, asked.fns);
    const drills = actions.filter((action) => action.mode === 'read' && action.then === 'open').map((action) => action.fn);
    const schema = widgetProposalSchema({
      source: asked.source, args: source.args, facts, ranked, entries, table, actions: actions.map((action) => action.fn), drills, live: source.live !== undefined,
    });
    session.state.learned({ source, schema });
    session.disclosure.markLoaded('fn', [asked.source]);
    const claimed = new Set([paging?.offset, paging?.limit, range?.from, range?.to]);
    const args = argsOf(source.args).map((arg) => `- ${arg.name}: ${arg.type.name}${arg.required ? ', required' : arg.defaulted ? ', has a default' : ', optional'}${claimed.has(arg.name) ? (arg.name === range?.from || arg.name === range?.to ? ', driven by the range (no plan)' : ', driven by the pager (no plan)') : ''}`);
    const rows = table.rows.slice(0, deps.sampleRows).map((row) => `  ${JSON.stringify(row)}`);
    return [
      `${asked.source}: ${source.description}${source.live === undefined ? '' : ` Its rows change on their own (every ${String(source.live.every)} ms), so the widget may be live.`}`,
      'Args:', ...(args.length === 0 ? ['- none'] : args),
      `Sample (${String(table.rows.length)} rows${facts.whole ? ', the whole result' : ', one page of more'}; columns in order):`, ...facts.columns.map(columnLine), ...rows,
      'Visuals that draw it, best first:', ...ranked.map((rank) => visualLine(rank, entries)),
      actions.length === 0 ? 'Row actions: none.' : `Row actions: ${actions.map((action) => `${action.fn} (${action.label}, ${action.mode})`).join(', ')}.`,
      drills.length === 0 ? 'Drills: none.' : `Drills: ${drills.join(', ')}.`,
      ...(asked.edited === undefined ? [] : [`You are changing ${asked.edited.fn}; keep what the request doesn't change. Its spec: ${JSON.stringify(asked.edited.spec)}`]),
      'Now call propose with the whole widget.',
    ].join('\n');
  },
});

/** The proposal's fn as the chat calls it once saved. */
function authored(draft: WidgetDraft): AuthoredFn {
  const fn = qualify(WIDGETS_SYSTEM, draft.name);
  return { fn, version: 1, signature: `${fn}()`, about: draft.description, reused: false, call: `${fn}({})` };
}

/** The widget authoring agent. Run it with the run's `ctx.ai()` and a `WidgetAuthoring`. */
export const widgetAuthoring = authoringAgent<WidgetAuthoring, unknown>({
  name: 'widget_author',
  description: 'Design one widget over a source fn\'s table and propose it for the person to save.',
  instructions: INSTRUCTIONS,
  tools: [sourceTool],
  stages: { find: false },
  toolNames: { draft: 'propose', save: 'offer' },
  draft: {
    description: 'the widget: name, description, title, the visual shown first, the others, a plan per arg, presets, and optional actions, drill and live.',
    schema: (session: Session) => session.state.read.schema.schema,
  },
  async check(draft, session) {
    const { deps, asked, read } = session.state;
    const proposal = read.schema.read(draft);
    const edited = asked.edited;
    // moving a widget to a new source: each planned arg's new type must take every value its old one did
    const moved = edited !== undefined && edited.spec.source !== asked.source
      ? sourceCompatible(proposal.spec, read.source.args, { previous: (await deps.source(edited.spec.source)).args })
      : [];
    const preview = await deps.preview(proposal.spec, read.source, asked.args);
    // the preview's check repeats the arg problems sourceCompatible lists: each once
    const problems = [...new Set([...moved, ...preview.problems])];
    if (problems.length === 0) { session.state.checked(proposal, preview); }
    return { problems, note: `Preview: ${preview.summary}` };
  },
  save(_draft, session) {
    return Promise.resolve(authored(session.state.offer().draft));
  },
});
