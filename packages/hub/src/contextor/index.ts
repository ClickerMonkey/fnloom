/**
 * The contextor module (contextor lane): chat modes and contextors, the token budget every prompt is held to, model
 * limits and calibration, and the context graph's links.
 *
 * - A **chat mode** (`ChatMode`, one per `ChatModeConfig` variant) decides how fns reach the model and how its calls
 *   come back: `tools` makes a native tool per selected fn; `static` sends five fixed tools (`find`, `inspect`,
 *   `load`, `unload`, `run`) and shows loaded fns as text cards, and turns `run(fn, args)` into a run of that fn.
 * - A **contextor** (`Contextor`, one per `ContextorConfig` variant) decides what one prompt holds: `plain` (the
 *   transcript), `suggest` (plus suggestions and auto-injected context), `graph` (a fresh prompt per message chosen
 *   by weight from history, context and fns at the detail the budget allows).
 * - The **planner** (`PromptPlanner`) is what the agent loop calls: it resolves the session's mode and contextor,
 *   measures the fixed part, asks the contextor for a selection, renders it with the mode and reports the budget.
 *   Nothing it plans is ever more than `window − output − reasoning − margin` tokens.
 *
 * **Tools and core's request planning.** The planner decides which fns a prompt offers (within the token budget); the
 * provider then plans the request with `@aeye/core`'s `prepareRequest`: each tool's `@aeye/schema` args rendered for
 * the model (strict where it takes it, degraded where the provider's limits run out). The two never both dispatch:
 * the hub's own `fns_search` / `fns_load` (static mode's `find` / `load`) bring fns into a LATER prompt, while core's
 * `run_tool({ tool, args })` dispatcher is only a way to SEND this prompt's tools to a provider with a tool cap
 * (OpenAI's 128): it can only appear in tools mode, when more fns are selected at `signature` than the provider takes
 * (static mode sends six tools). A dispatched call is decoded by core back to the tool it names, whose `call` records
 * it under that tool's name (`execution/tools.ts`), so the hub maps it to its fn as any other call (`rendered.fns`).
 *
 * Pure parts live in their own files so tests need no store: `tokens.ts` (estimates, calibration), `budget.ts`
 * (`B = W − O − M`, water-filling), `score.ts` (`rbf`, base score, spread), `choose.ts` (units, greedy detail
 * upgrades), `history.ts` (exchanges, contiguous tail, summaries), `render.ts` (context blocks, `fnCard`,
 * `parseRunBlocks`). The registries `CHAT_MODES` and `CONTEXTORS` (in `modes.ts` and `contextors.ts`) are typed by
 * `ChatModeFactories` and `ContextorFactories`, so a new config variant fails to compile until it has an
 * implementation. Tunables are the `contextorEnv` slice (`env.ts`).
 */
import type {
  ActorId, RunId, BudgetReport, ChatModeConfig, ChatModeType, ContextLink, ContextorConfig, ContextorType, ContextRecord, DeclarableRelation, Detail, Exposure, FnExample, FnRecord,
  InstanceName, InvalidInput, Json, LinkTarget, LlmMessage, LlmToolSpec, ModelFnNames, ModelLimits, ModelLimitsView, QualifiedName, ResolvedModelLimits, SelectionReport,
  Session, SuggestionRecord, SessionId, Turn, TurnId, UserInfo,
} from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { LlmPayload } from '@harness/sdk';
import type { Bindable } from '@aeye/schema';
import type { Catalog, FnSignature } from '../catalog/index.ts';
import type { FnsForPrompt } from '../fns/index.ts';
import type { AccessScope } from '../access/index.ts';
import type { Search } from '../index/index.ts';
import type { InstanceRouter } from '../link/index.ts';
import type { ContextorEnv } from './env.ts';
import type { ExampleWriter } from './examples.ts';
import type { SizedChoice } from './brought.ts';
import type { Exchange } from './history.ts';
import type { RunBlock } from './render.ts';

// ─── Tokens and budgets ───────────────────────────────────────────────────────

/** Token estimates for one model: characters over characters-per-token, times the model's calibration ratio. */
export interface TokenEstimator {
  readonly model: string;
  readonly limits: ResolvedModelLimits;
  /** Measured input tokens over estimated, for this model (1.1 before any call). */
  readonly ratio: number;
  text(text: string): number;
  /** A message with its role and framing (and its tool calls). */
  message(message: LlmMessage): number;
  /** A native tool definition: its name, description and JSON schema as sent. */
  tool(tool: LlmToolSpec): number;
  /** Several messages together. */
  messages(messages: readonly LlmMessage[]): number;
}

/** Makes estimators and learns from real usage. */
export interface TokenEstimates {
  /** The estimator for a model, with its resolved limits and current ratio. */
  forModel(model: string): Promise<TokenEstimator>;
  /** After a call: fold the measured input tokens into the model's ratio (a clamped moving average). */
  observe(model: string, estimated: number, actual: number): Promise<void>;
}

/** Where every model's limits come from: an admin's record, then the provider's probe, then aeye, then defaults. */
export interface ModelLimitsService {
  resolve(model: string): Promise<ModelLimitsView>;
  /** All chat models the hub can call, resolved. */
  list(): Promise<ModelLimitsView[]>;
  /** Set an admin's limits for a model; a record with every field absent is removed. */
  set(model: string, limits: ModelLimits, by: ActorId): Promise<ModelLimitsView>;
}

/** One prompt's budget, worked out before anything is chosen. `available` (B) = window − output − reasoning − margin. */
export interface BudgetPlan {
  readonly limits: ResolvedModelLimits;
  /** The answer's reserve (the model's output limit, capped by the agent's `maxOutput`) and the thinking reserve. */
  readonly output: number;
  readonly reasoning: number;
  readonly margin: number;
  readonly available: number;
  /** Instructions, tool definitions and the current turn: always sent. */
  readonly fixed: number;
  /** `available − fixed`: what history, context and fns share. Negative means even the fixed part doesn't fit. */
  readonly flexible: number;
}

// ─── What a prompt holds ──────────────────────────────────────────────────────

/** A fn as a mode shows it: its record, its signature in gin's TypeScript-like code, and the named types it uses. */
export interface FnView {
  readonly record: FnRecord;
  /** Its parsed signature, for native tools and checking args. */
  readonly signature: FnSignature;
  /** `args.toCode()` and `returns.toCode()`. */
  readonly args: string;
  readonly returns: string;
  /** `toCodeDefinition()` of each named type in the signature's closure. */
  readonly types: ReadonlyMap<QualifiedName, string>;
  /** Build 6: what it changes in the hub, in one line ("Creates fns (database/query)."), worked out deeply; absent when nothing. */
  readonly effects?: string;
  /** Its long-running warning ("x usually takes about 3 minutes."), from its run times; absent when it runs quickly. */
  readonly notice?: string;
  /**
   * Widget pass: `RESULT_TABLE_ROUTING` when its declared return is a table (sdk `returnsTable`), so the model knows the
   * person sees the result drawn; absent otherwise.
   */
  readonly routing?: string;
}

/** A context item chosen for a prompt, with the text at its detail (its line, its summary, or its content). */
export interface ChosenContext {
  readonly record: ContextRecord;
  readonly detail: Detail;
  readonly activation: number;
  readonly text: string;
  /** Build 6: its choices (`ContextDecl.choices`) with the token size of each, shown as decisions with its block. */
  readonly choices?: readonly SizedChoice[];
}

/** A fn chosen for a prompt. */
export interface ChosenFn {
  readonly view: FnView;
  readonly detail: Detail;
  readonly activation: number;
  /** Build 5: the examples its card shows this turn, the most relevant first (its first declared ones when absent). */
  readonly examples?: readonly FnExample[];
}

/** An earlier exchange, summarised for the system prompt without a model call. */
export interface ExchangeSummary {
  /** Its turn's number in the session (0 is the first). */
  readonly turn: number;
  readonly user: string;
  readonly answer: string;
  /** The fns and context it used, by name. */
  readonly used: readonly QualifiedName[];
}

/** What a contextor chose for one prompt. `report` is what the LLM interaction keeps. */
export interface Selection {
  readonly context: readonly ChosenContext[];
  readonly fns: readonly ChosenFn[];
  /** The conversation the request carries: the contiguous recent tail, then the current turn. */
  readonly linear: readonly LlmMessage[];
  readonly earlier: readonly ExchangeSummary[];
  readonly report: SelectionReport;
  /** What a graph cycle considered (used, under its threshold, or no room), recorded on the user message as its suggestions. */
  readonly considered?: SuggestionRecord;
}

/**
 * A native tool a mode sends: its `@aeye/schema` args, bound for the prompt (its fn-name fields spelled by the prompt's
 * names), which `@aeye/core` plans for the model, checks and decodes each call with; and the definition in the code
 * shape (`spec`, its parameters the `LENIENT` JSON schema, for estimates and records).
 */
export interface ModeTool {
  readonly name: string;
  readonly description: string;
  readonly instructions?: string | undefined;
  readonly schema: Bindable<object>;
  readonly spec: LlmToolSpec;
}

/** What one iteration sends: native tools (none for the text protocol), text after the instructions, and a tail. */
export interface RenderedIteration {
  readonly tools: readonly ModeTool[];
  readonly systemEnd: string;
  /** A trailing system message after the conversation (static mode, placement `tail`). */
  readonly tail: string | undefined;
  readonly protocol: CallProtocol;
  /** Tool name → the fn it runs, for `interpret` (static mode: only `run` and the four hub fns). */
  readonly fns: ReadonlyMap<string, QualifiedName>;
  /** Tools whose args carry an `on` choice (a fleet's fn in tools mode), taken out before the fn's args are checked. */
  readonly fleet: ReadonlySet<string>;
  /**
   * Static mode: the fns whose args a native `run` call is decoded with (the fns the prompt shows, and the toolset's
   * own), so core has checked them already; any other fn's args come as any JSON and are checked hub-side.
   */
  readonly decoded?: ReadonlySet<QualifiedName>;
  /** The fn names this prompt speaks (`ModeContext.names`): its calls are read back, and its results written, through them. */
  readonly names: ModelFnNames;
}

/**
 * A call the model made: a native tool call, its args decoded by `@aeye/core` through the tool's schema (the code
 * shape: its fn-name fields qualified names), or a `<run fn="…">{…}</run>` block from its text, as the model wrote it.
 */
export type ModelCallOut =
  | { readonly type: 'tool'; readonly id: string; readonly name: string; readonly args: Json }
  | ({ readonly type: 'block'; readonly id: string } & RunBlock);

/**
 * What the loop does with one model call: run a fn (a queued run of the named fn, never a wrapper), or answer at once
 * with invalid input (bad JSON, not the fn's args, an unknown fn: fed back softly, with the fn's card or near names).
 */
export type CallPlan =
  | { readonly type: 'run'; readonly fn: QualifiedName; readonly args: Json; /** The fleet instance the model named (`on`), taken out of the args. */ readonly on?: InstanceName }
  | { readonly type: 'invalid'; readonly fn: QualifiedName | undefined; readonly invalid: InvalidInput; readonly reply: string; /** The args the model gave the fn, when they were JSON. */ readonly args?: Json };

// ─── Modes and contextors ─────────────────────────────────────────────────────

/** How calls come back in one prompt: native tool calls, or `<run>` blocks in the model's text. */
export type CallProtocol = 'native' | 'text';

/** What a mode renders and prices with: the model's estimator and the protocol this prompt uses. */
export interface ModeContext {
  readonly estimator: TokenEstimator;
  readonly protocol: CallProtocol;
  /**
   * The one fn name (core's `modelFnNames`): every fn this prompt names, as the model calls it in this mode, read back
   * through the hub's registry. The planner always sets it; a mode given none names fns by the rule alone.
   */
  readonly names?: ModelFnNames;
  /**
   * The agent takes summaries (its injected section's `detail` is `summary`: a small window): the `<systems>` list is
   * one line a system and the static tools carry their short descriptions (Phil 2026-11-22).
   */
  readonly brief?: boolean;
  /**
   * How fn examples that aren't a tool's own are written for this prompt (`examples.ts`): static mode's cards, the
   * cards a result exposes. The planner always sets it; without, the code shape.
   */
  readonly writer?: ExampleWriter;
}

/** Who a call is checked for: the session (its systems) and the person. */
export interface CallScope {
  readonly session: Session | undefined;
  /** What the person may see and use. */
  readonly access: AccessScope;
}

/** How fns reach the model and how its calls come back. One implementation per `ChatModeConfig` variant. */
export interface ChatMode {
  readonly type: ChatModeType;
  /** The detail a loaded fn is shown at (tools: `signature`, a native tool; static: its `loadDetail`). */
  readonly loadDetail: Detail;
  /**
   * The detail the agent's own fns (its payload's `tools`) are always shown at: `signature` in tools mode, so each is a
   * native tool it can call; `listed` in static mode, where `run` reaches any fn and a card costs tokens.
   */
  readonly alwaysDetail: Detail;
  /** Hub fns whose jobs this mode's own tools do: never shown, whoever names them (static: build 1's search and load fns). */
  readonly replaces: ReadonlySet<string>;
  /** The protocol for a model that does (or doesn't) take native tools. */
  protocol(nativeTools: boolean): CallProtocol;
  /** Text the mode always adds after the agent's instructions (how to call fns). */
  guide(ctx: ModeContext): string;
  /** The tools this mode always sends (static: the five, none for the text protocol; tools: none). */
  fixedTools(ctx: ModeContext): Promise<readonly ModeTool[]>;
  /** Tokens a fn costs at a detail in this mode (a tool definition, or a card). */
  cost(fn: FnView, detail: Detail, ctx: ModeContext): number;
  render(selection: Selection, ctx: ModeContext): Promise<RenderedIteration>;
  interpret(call: ModelCallOut, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan>;
  /** What a tool reply adds for the fns its run exposed (`ctx.expose`): their cards, or their names. */
  exposed(views: readonly ChosenFn[], ctx: ModeContext): string;
}

/** Names of items, by kind. */
export interface Names {
  readonly context: readonly string[];
  readonly fns: readonly string[];
}

/** What a contextor chooses from. */
export interface ContextorInput {
  /** Absent for an agent run outside a session (its run's own conversation is used). */
  readonly session: Session | undefined;
  /** The person the prompt is for (memory scoped to them is theirs). */
  readonly user: ActorId;
  /** What that person may see and use: the systems, fns, context and resources shared with them. */
  readonly access: AccessScope;
  /** The turn the prompt is for, when there is one (previews have none). */
  readonly turn: TurnId | undefined;
  readonly agent: FnRecord;
  readonly payload: LlmPayload;
  /** The person's words of the current message, with mentions and without the hub's blocks. */
  readonly query: string;
  /** Earlier exchanges, oldest first (the current one is not among them). */
  readonly history: readonly Exchange[];
  /** The current exchange's messages so far: always sent, and charged to the fixed part. */
  readonly current: readonly LlmMessage[];
  /** What the agent always has: its payload's context and tools, and context injected into it (`inject`). */
  readonly always: Names;
  /** What the session loaded (`session.context`, `session.tools`). */
  readonly loaded: Names;
  /** What the current message asked for: its `/command` context and the fns it names. */
  readonly asked: Names;
  /**
   * The context items the agent's injected section shows (full or summary): in the prompt already, as part of its fixed
   * region, so a contextor treats them as loaded: never suggests, loads or chooses them again, and never counts them.
   * `always`, `loaded` and `asked` never hold them. Absent: none.
   */
  readonly injected?: readonly QualifiedName[];
  /** The args of each of the current message's `/command`s, by context name (what its dynamic context is written with). */
  readonly commands: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** The person as systems see them (the turn's), for dynamic context; absent for previews, where the hub looks them up. */
  readonly person: UserInfo | undefined;
  readonly mode: ChatMode;
  readonly ctx: ModeContext;
  readonly plan: BudgetPlan;
  /** The selection made for this message before (`perMessage`), so a retried or later iteration keeps it. */
  readonly cached?: SelectionReport | undefined;
}

/** What goes in one prompt. One implementation per `ContextorConfig` variant. */
export interface Contextor {
  readonly type: ContextorType;
  select(input: ContextorInput): Promise<Selection>;
}

/** Who a dynamic context item is written for. */
export interface DynamicAsk {
  readonly session: SessionId | undefined;
  readonly actor: ActorId;
  /** The person as systems see them; looked up by `actor` when absent. */
  readonly user?: UserInfo | undefined;
  /** The `/command`'s args; absent reuses the args the item was last written with for this session and person. */
  readonly args?: Readonly<Record<string, string>> | undefined;
}

/** The text of dynamic context (declared without `content`), asked of the system that owns it. */
export interface DynamicContext {
  /**
   * The record with its `content` filled in: unchanged when it declares content; else the text its system writes for
   * this ask (kept a while); else, when the system can't answer (logged), the last text kept, or the record unchanged.
   */
  resolve(record: ContextRecord, ask: DynamicAsk): Promise<ContextRecord>;
}

/** The services modes and contextors are built with. */
export interface ContextorDeps {
  readonly catalog: Pick<Catalog, 'fn' | 'context'>;
  /** Dynamic context's text, for items a prompt shows in full. */
  readonly dynamic: DynamicContext;
  readonly search: Pick<Search, 'search'>;
  readonly views: FnViewSource;
  readonly graph: ContextGraph;
  /** A fleet's connected instances, so a fn whose system has several gets an `on` choice. */
  readonly instances: Pick<InstanceRouter, 'connected'>;
  readonly settings: ContextorEnv;
  readonly log: Logger;
  readonly clock: () => number;
  /** What a person may see and use (the access module). */
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  /** Build 5: examples for a fn's card by relevance, and fns' modes for a chat's fn mode (none: declared examples, every fn). */
  readonly fns?: FnsForPrompt;
}

/** Fn views, built once per fn version, and named types as cards show them. */
export interface FnViewSource {
  view(name: QualifiedName): Promise<FnView | undefined>;
  /** A named type's definition in gin's code, after the definitions of the types it uses; undefined for no such type. */
  typeText(name: QualifiedName): Promise<string | undefined>;
}

/** Every chat mode, by config type: a variant added to `ChatModeConfig` without a factory doesn't compile. */
export type ChatModeFactories = { readonly [T in ChatModeType]: (config: Extract<ChatModeConfig, { type: T }>, deps: ContextorDeps) => ChatMode };
/** Every contextor, by config type. */
export type ContextorFactories = { readonly [T in ContextorType]: (config: Extract<ContextorConfig, { type: T }>, deps: ContextorDeps) => Contextor };

// ─── The planner the agent loop calls ─────────────────────────────────────────

/** One planned LLM call. */
export interface PlannedPrompt {
  readonly model: string;
  /**
   * The agent's instructions as the system message's template: `{{injectedContext}}` made the raw value
   * `{{{injectedContext}}}`, or the section put straight after them when they have no placeholder.
   */
  readonly instructions: string;
  /** The agent's injected section as the model reads it ('' for none): filled in where `instructions` says. */
  readonly injectedContext: string;
  /** What follows the agent's instructions in the system message: the mode's guide, context, earlier summaries, fn cards. */
  readonly context: string;
  /** The conversation the request carries (the linear history, the current exchange, a trailing card message). */
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ModeTool[];
  /** Set on the request, so the provider never cuts the front and aeye's `forget` never fires. */
  readonly maxTokens: number;
  readonly contextWindow: number;
  /** The request's estimate in tokens, never more than the budget. */
  readonly estimate: number;
  readonly rendered: RenderedIteration;
  readonly report: SelectionReport;
  /** What a graph cycle considered, for the user message's suggestions. */
  readonly considered?: SuggestionRecord;
  /** What the prompt was planned for, to interpret its calls. */
  readonly mode: ChatMode;
  readonly ctx: ModeContext;
  readonly session: Session | undefined;
  /** What the person it was planned for may see and use. */
  readonly access: AccessScope;
}

/** What the agent loop asks for each iteration. */
export interface PlanInput {
  readonly session: Session | undefined;
  readonly turn: Turn;
  readonly agent: FnRecord;
  /** The model the call goes to (`auto` when aeye picks by weights). */
  readonly model: string;
  /** The agent's instructions (before Handlebars fills them). */
  readonly instructions: string;
  /** The whole conversation so far, the current exchange last. */
  readonly transcript: readonly LlmMessage[];
  /** A selection made earlier for this user message, kept on the run's resume (`perMessage`), so a retried job sends the same prompt. */
  readonly cached?: SelectionReport | undefined;
}

/** What a draft prompt is planned for (`PromptPlanner.draft`): a turn's first step with no turn. */
export interface DraftInput {
  readonly session: Session | undefined;
  readonly agent: FnRecord;
  readonly model: string;
  readonly instructions: string;
  readonly transcript: readonly LlmMessage[];
  /** The person it is planned for. */
  readonly user: ActorId;
}

/** Builds each prompt within the model's limits, and interprets the model's calls. */
export interface PromptPlanner {
  /** Refused (`PromptTooLarge`) with a plain message when even the instructions and the person's own words don't fit. */
  plan(input: PlanInput): Promise<PlannedPrompt>;
  interpret(call: ModelCallOut, prompt: PlannedPrompt): Promise<CallPlan>;
  /** What a tool reply adds for fns its run exposed, as the session's mode shows them to this model. */
  exposed(exposures: readonly Exposure[], to: ExposedTo): Promise<string>;
  /** After a call: calibrate the model's ratio, and learn links between what the iteration used together. */
  settled(input: { model: string; estimate: number; actual: number | undefined; used: readonly QualifiedName[] }): Promise<void>;
  /** What a message would get, without calling the model (`previewSelection`). */
  preview(session: SessionId, text: string, by: ActorId): Promise<SelectionReport>;
  /**
   * The whole prompt a session's agent would be sent for this transcript, planned as a turn's first step is but
   * keeping nothing (no stamp, no selection): the admins' prompt preview (`previewPrompt`). No model is called.
   */
  draft(input: DraftInput): Promise<PlannedPrompt>;
  /** The fn names a run's results are written in for this session's mode and model (its tool replies go through them). */
  names(to: ExposedTo): Promise<ModelFnNames>;
  /**
   * How fn examples are written for this session's mode and model where they aren't a tool's own (`examples.ts`): a
   * card a result shows, a page of examples, a suggestion. `protect` (default): each as a value kept from the fn-name
   * speller, for text the hub spells afterwards (`spelled`); `false`: plain JSON text, for a hub fn's own output.
   */
  writer(to: ExposedTo, protect?: boolean): Promise<ExampleWriter>;
  /**
   * The writer (`protect: false`) of the prompt a hub fn's run was called from: its parent run, when that is an agent
   * (a static `inspect` shows its card's examples as the calling model would send them). Undefined outside a prompt.
   */
  writerForRun(run: { readonly parent?: RunId | undefined; readonly user: { readonly id: ActorId } }): Promise<ExampleWriter | undefined>;
  /**
   * Fns' args (examples, in the code shape) as the model would write them here (`writer`'s `args`: JSON, or a deferred
   * value of `run` in static mode, written when the request is planned); a fn it can't see, as given.
   */
  writeArgs(to: ExposedTo, calls: ReadonlyArray<{ readonly fn: QualifiedName; readonly args: Json }>): Promise<string[]>;
}

/** Who a run's exposed fns are shown to: the session, its agent and the model. */
export interface ExposedTo {
  readonly session: Session | undefined;
  readonly access: AccessScope;
  readonly agent: FnRecord;
  readonly model: string;
}

/** The chat mode and contextor a run uses: the session's override, else the agent payload's, else build 1's. */
export interface ModeChoice {
  readonly mode: ChatModeConfig;
  readonly contextor: ContextorConfig;
}

// ─── The context graph ────────────────────────────────────────────────────────

/**
 * The edges between context items, fns, types and resources. Declared and mentioned edges are derived from their
 * item's record (`linksOf`) and rewritten in the same write as the record; resource edges are written when context
 * is made from a resource; learned edges come from co-use and decay; authored ones are a person's.
 */
export interface ContextGraph {
  /** Edges out of an item (a context item's or a fn's name). */
  links(from: QualifiedName): Promise<ContextLink[]>;
  /** Edges into a target. */
  backlinks(to: LinkTarget): Promise<ContextLink[]>;
  /** Items within `hops` of these, with the strongest path weight to each (bounded by `limit`). */
  neighbours(names: readonly QualifiedName[], hops: number, limit: number): Promise<ReadonlyMap<QualifiedName, number>>;
  /** Rewrite an item's derived edges from its record (the catalog calls this when it writes context). */
  derive(record: ContextRecord): Promise<void>;
  /** Write edges a resource conversion found, replacing that item's earlier resource edges. */
  replaceResourceLinks(from: QualifiedName, links: ReadonlyArray<Pick<ContextLink, 'to' | 'relation' | 'weight'>>): Promise<void>;
  /** Count one turn's co-use: every pair of used items strengthens its learned edge. */
  learn(used: readonly QualifiedName[]): Promise<void>;
  /** A person's edge. */
  author(input: { from: QualifiedName; to: LinkTarget; relation: DeclarableRelation; weight: number; by: ActorId }): Promise<ContextLink>;
  remove(key: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): Promise<boolean>;
}

/** The contextor module's services (`HubServices.contextor`). */
export interface ContextorServices {
  readonly planner: PromptPlanner;
  readonly limits: ModelLimitsService;
  readonly tokens: TokenEstimates;
  readonly graph: ContextGraph;
  /** Fns as modes show them (cards, tools), for the contextor's hub fns. */
  readonly views: FnViewSource;
  /** Dynamic context's text, for everything that shows context (`hub/inspect`, `hub/ctx_get`). */
  readonly dynamic: DynamicContext;
}

/** The report of a prompt that could not be planned: the numbers behind the plain message. */
export interface Overflow {
  readonly report: BudgetReport;
  readonly message: string;
}
