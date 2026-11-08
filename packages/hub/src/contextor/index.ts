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
  ActorId, BudgetReport, ChatModeConfig, ChatModeType, ContextLink, ContextorConfig, ContextorType, ContextRecord, DeclarableRelation, Detail, FnRecord,
  InvalidInput, Json, LinkTarget, LlmMessage, LlmToolCall, LlmToolSpec, ModelLimits, ModelLimitsView, QualifiedName, ResolvedModelLimits, SelectionReport,
  Session, SessionId, Turn,
} from '@harness/core';

// ─── Tokens and budgets ───────────────────────────────────────────────────────

/** Token estimates for one model: characters over characters-per-token, times the model's calibration ratio. */
export interface TokenEstimator {
  readonly model: string;
  readonly limits: ResolvedModelLimits;
  /** Measured input tokens over estimated, for this model (1 before any call). */
  readonly ratio: number;
  text(text: string): number;
  /** A message with its role and framing (and its tool calls). */
  message(message: LlmMessage): number;
  /** A native tool definition: its name, description and JSON schema as sent. */
  tool(tool: LlmToolSpec): number;
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
  readonly at: number;
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

/** What one iteration sends: native tools (none for the text protocol), text after the instructions, and a tail. */
export interface RenderedIteration {
  readonly tools: readonly LlmToolSpec[];
  readonly systemEnd: string;
  /** A trailing system message after the conversation (static mode, placement `tail`). */
  readonly tail: string | undefined;
  readonly protocol: 'native' | 'text';
  /** Tool name → the fn it runs, for `interpret` (static mode: only `run` and the four hub fns). */
  readonly fns: ReadonlyMap<string, QualifiedName>;
}

/** A call the model made: a native tool call, or a `<run fn="…">{…}</run>` block from its text. */
export type ModelCallOut =
  | { readonly type: 'tool'; readonly call: LlmToolCall }
  | { readonly type: 'block'; readonly id: string; readonly fn: string | undefined; readonly json: string };

/**
 * What the loop does with one model call: run a fn (a queued run of the named fn, never a wrapper), or answer at once
 * with invalid input (bad JSON, not the fn's args, an unknown fn: fed back softly, with the fn's card or near names).
 */
export type CallPlan =
  | { readonly type: 'run'; readonly fn: QualifiedName; readonly args: Json }
  | { readonly type: 'invalid'; readonly fn: QualifiedName | undefined; readonly invalid: InvalidInput; readonly reply: string };

// ─── Modes and contextors ─────────────────────────────────────────────────────

/** How fns reach the model and how its calls come back. One implementation per `ChatModeConfig` variant. */
export interface ChatMode {
  readonly type: ChatModeType;
  /** Tokens a fn costs at a detail in this mode (a tool definition, or a card). */
  cost(fn: FnView, detail: Detail, estimator: TokenEstimator): number;
  /** The fixed tools this mode always sends (static: the five; tools: none). */
  fixedTools(): readonly LlmToolSpec[];
  render(selection: Selection, estimator: TokenEstimator): RenderedIteration;
  interpret(call: ModelCallOut, rendered: RenderedIteration): Promise<CallPlan>;
}

/** What a contextor chooses from. */
export interface ContextorInput {
  /** Absent for an agent run outside a session (its run's own conversation is used). */
  readonly session: Session | undefined;
  readonly turn: Turn;
  /** The agent fn and its payload's context, tools and always-items. */
  readonly agent: FnRecord;
  /** The rendered user message, with mentions and without suggestion blocks. */
  readonly query: string;
  readonly transcript: readonly LlmMessage[];
  readonly mode: ChatMode;
  readonly estimator: TokenEstimator;
  readonly plan: BudgetPlan;
}

/** What goes in one prompt. One implementation per `ContextorConfig` variant. */
export interface Contextor {
  readonly type: ContextorType;
  select(input: ContextorInput): Promise<Selection>;
}

/** The services modes and contextors are built with. */
export interface ContextorDeps {
  readonly graph: ContextGraph;
  readonly clock: () => number;
}

/** Every chat mode, by config type: a variant added to `ChatModeConfig` without a factory doesn't compile. */
export type ChatModeFactories = { readonly [T in ChatModeType]: (config: Extract<ChatModeConfig, { type: T }>, deps: ContextorDeps) => ChatMode };
/** Every contextor, by config type. */
export type ContextorFactories = { readonly [T in ContextorType]: (config: Extract<ContextorConfig, { type: T }>, deps: ContextorDeps) => Contextor };

// ─── The planner the agent loop calls ─────────────────────────────────────────

/** One planned LLM call. */
export interface PlannedPrompt {
  /** The instructions plus the context region, earlier summaries and (static, system-end) fn cards. */
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolSpec[];
  /** Set on the request, so the provider never cuts the front and aeye's `forget` never fires. */
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly rendered: RenderedIteration;
  readonly report: SelectionReport;
}

/** What the agent loop asks for each iteration. */
export interface PlanInput {
  readonly session: Session | undefined;
  readonly turn: Turn;
  readonly agent: FnRecord;
  /** The model the gateway resolved for this call. */
  readonly model: string;
  readonly instructions: string;
  readonly query: string;
  readonly transcript: readonly LlmMessage[];
  /** The current turn's messages so far (its user message and tool loop): always linear. */
  readonly current: readonly LlmMessage[];
  /** A selection cached on the run's resume for this user message (`perMessage`), so a retried job sends the same prompt. */
  readonly cached?: SelectionReport;
}

/** Builds each prompt within the model's limits, and interprets the model's calls. */
export interface PromptPlanner {
  /** Refused with a plain message when even the instructions and the user's own words don't fit the model. */
  plan(input: PlanInput): Promise<PlannedPrompt>;
  interpret(call: ModelCallOut, prompt: PlannedPrompt): Promise<CallPlan>;
  /** After the call: calibrate the model's ratio and learn links between what the turn used together. */
  settled(input: { model: string; estimate: number; actual: number; used: readonly QualifiedName[] }): Promise<void>;
  /** What a message would get, without calling the model (`previewSelection`). */
  preview(session: SessionId, text: string, by: ActorId): Promise<SelectionReport>;
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
}

/** The report of a prompt that could not be planned: the numbers behind the plain message. */
export interface Overflow {
  readonly report: BudgetReport;
  readonly message: string;
}
