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
 * Pure parts live in their own files so tests need no store: `tokens.ts` (estimates, calibration), `budget.ts`
 * (`B = W − O − M`, water-filling), `score.ts` (`rbf`, base score, spread), `choose.ts` (units, greedy detail
 * upgrades), `history.ts` (exchanges, contiguous tail, summaries), `render.ts` (context blocks, `fnCard`,
 * `parseRunBlocks`). The registries `CHAT_MODES` and `CONTEXTORS` (in `modes.ts` and `contextors.ts`) are typed by
 * `ChatModeFactories` and `ContextorFactories`, so a new config variant fails to compile until it has an
 * implementation. Tunables are the `contextorEnv` slice (`env.ts`).
 */
import type {
  ActorId, BudgetReport, ChatModeConfig, ChatModeType, ContextLink, ContextorConfig, ContextorType, ContextRecord, DeclarableRelation, Detail, Exposure, FnRecord,
  InvalidInput, Json, LinkTarget, LlmMessage, LlmToolSpec, ModelLimits, ModelLimitsView, QualifiedName, ResolvedModelLimits, SelectionReport,
  Session, SessionId, Turn, TurnId,
} from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { LlmPayload } from '@harness/sdk';
import type { z } from 'zod';
import type { Catalog, FnSignature } from '../catalog/index.ts';
import type { Search } from '../index/index.ts';
import type { ContextorEnv } from './env.ts';
import type { Exchange } from './history.ts';

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
}

/** A context item chosen for a prompt, with the text at its detail (its line, its summary, or its content). */
export interface ChosenContext {
  readonly record: ContextRecord;
  readonly detail: Detail;
  readonly activation: number;
  readonly text: string;
}

/** A fn chosen for a prompt. */
export interface ChosenFn {
  readonly view: FnView;
  readonly detail: Detail;
  readonly activation: number;
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
}

/**
 * A native tool a mode sends: its zod schema (the args aeye checks a call against) and the definition as the provider
 * sees it (`spec`, for estimates and records).
 */
export interface ModeTool {
  readonly name: string;
  readonly description: string;
  readonly instructions?: string | undefined;
  readonly schema: z.ZodType<object>;
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
}

/** A call the model made: a native tool call, or a `<run fn="…">{…}</run>` block from its text. */
export type ModelCallOut =
  | { readonly type: 'tool'; readonly id: string; readonly name: string; readonly args: Json }
  | { readonly type: 'block'; readonly id: string; readonly fn: string | undefined; readonly json: string };

/**
 * What the loop does with one model call: run a fn (a queued run of the named fn, never a wrapper), or answer at once
 * with invalid input (bad JSON, not the fn's args, an unknown fn: fed back softly, with the fn's card or near names).
 */
export type CallPlan =
  | { readonly type: 'run'; readonly fn: QualifiedName; readonly args: Json }
  | { readonly type: 'invalid'; readonly fn: QualifiedName | undefined; readonly invalid: InvalidInput; readonly reply: string };

// ─── Modes and contextors ─────────────────────────────────────────────────────

/** How calls come back in one prompt: native tool calls, or `<run>` blocks in the model's text. */
export type CallProtocol = 'native' | 'text';

/** What a mode renders and prices with: the model's estimator and the protocol this prompt uses. */
export interface ModeContext {
  readonly estimator: TokenEstimator;
  readonly protocol: CallProtocol;
}

/** Who a call is checked for: the session (its systems) and the person. */
export interface CallScope {
  readonly session: Session | undefined;
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
  /** What the agent always has: its payload's context and tools, and context that names it in `alwaysFor`. */
  readonly always: Names;
  /** What the session loaded (`session.context`, `session.tools`). */
  readonly loaded: Names;
  /** What the current message asked for: its `/command` context and the fns it names. */
  readonly asked: Names;
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

/** The services modes and contextors are built with. */
export interface ContextorDeps {
  readonly catalog: Pick<Catalog, 'fn' | 'context'>;
  readonly search: Pick<Search, 'search'>;
  readonly views: FnViewSource;
  readonly graph: ContextGraph;
  readonly settings: ContextorEnv;
  readonly log: Logger;
  readonly clock: () => number;
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
  /** What the prompt was planned for, to interpret its calls. */
  readonly mode: ChatMode;
  readonly ctx: ModeContext;
  readonly session: Session | undefined;
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
}

/** Who a run's exposed fns are shown to: the session, its agent and the model. */
export interface ExposedTo {
  readonly session: Session | undefined;
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
}

/** The report of a prompt that could not be planned: the numbers behind the plain message. */
export interface Overflow {
  readonly report: BudgetReport;
  readonly message: string;
}
