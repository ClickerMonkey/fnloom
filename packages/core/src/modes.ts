/**
 * Chat modes and contextors: the two choices that shape an agent's prompt. The **chat mode** decides how fns reach
 * the model and how its calls come back (`tools`: one native tool per fn; `static`: a small fixed tool set plus fn
 * cards as text and one `run` tool). The **contextor** decides what the prompt holds (`plain`: the whole transcript;
 * `suggest`: suggestion blocks and optional auto-injected context; `graph`: a fresh prompt each message, built from a
 * weighted selection of history, context and fns under the model's token budget). Both are chosen per agent fn and
 * may be overridden per session. Every shape here is a zod schema; the agent payload's gin fields are made from them.
 */
import { z } from 'zod';
import { ActorId, QualifiedName, Timestamp, TurnId } from './primitives.ts';

// ─── Detail ───────────────────────────────────────────────────────────────────

/**
 * How much of a fn or context item the model sees: `listed` (its name and one line), `signature` (a fn's call
 * signature and types; a context item's summary), `full` (a fn's instructions and examples too; a context item's
 * whole content).
 */
export const DETAIL_LEVELS = ['listed', 'signature', 'full'] as const;
export const Detail = z.enum(DETAIL_LEVELS);
export type Detail = z.infer<typeof Detail>;

/** A fn a run's result shows the agent, and at what detail (`ctx.expose` in the SDK). */
export const Exposure = z.object({ fn: QualifiedName, detail: Detail });
export type Exposure = z.infer<typeof Exposure>;

// ─── Chat modes ───────────────────────────────────────────────────────────────

/** Strict tools: every selected fn is a native tool definition. With the `plain` contextor this is build 1's agent. */
export const ToolsMode = z.object({ type: z.literal('tools') });
export type ToolsMode = z.infer<typeof ToolsMode>;

/** How a static-mode model's calls come back: native tool calls, or `<run fn="…">{…}</run>` blocks in its text. */
export const STATIC_PROTOCOLS = ['auto', 'native', 'text'] as const;
export const StaticProtocol = z.enum(STATIC_PROTOCOLS);
export type StaticProtocol = z.infer<typeof StaticProtocol>;

/** Where loaded fn cards go: the end of the system prompt, or a system message after the conversation. */
export const CARD_PLACEMENTS = ['system-end', 'tail'] as const;
export const CardPlacement = z.enum(CARD_PLACEMENTS);
export type CardPlacement = z.infer<typeof CardPlacement>;

/**
 * The static toolset: five fixed tools (`find`, `inspect`, `load`, `unload`, `run`) whatever the session can use, so
 * the tool block stays small and a provider's prompt cache stays warm. Loaded fns are shown as text cards; `run`
 * runs any fn the session may use by name and args.
 */
export const StaticMode = z.object({
  type: z.literal('static'),
  /** `auto` picks `native` when the model supports tools, else `text`. */
  protocol: StaticProtocol.default('auto'),
  placement: CardPlacement.default('system-end'),
  /** The detail a fn gets when it is loaded without one. */
  loadDetail: Detail.default('full'),
});
export type StaticMode = z.infer<typeof StaticMode>;

/** A chat mode's settings. Adding a variant fails to compile in the hub until it has an implementation. */
export const ChatModeConfig = z.discriminatedUnion('type', [ToolsMode, StaticMode]);
export type ChatModeConfig = z.infer<typeof ChatModeConfig>;
/** The chat modes, read off `ChatModeConfig`. */
export const ChatModeType = z.enum(ChatModeConfig.options.map((option) => option.shape.type.value));
export type ChatModeType = z.infer<typeof ChatModeType>;

/** The static toolset's tool names. `run` is not a fn: its calls become runs of the named fn. */
export const STATIC_TOOLS = ['find', 'inspect', 'load', 'unload', 'run'] as const;
export const StaticTool = z.enum(STATIC_TOOLS);
export type StaticTool = z.infer<typeof StaticTool>;

// ─── Contextors ───────────────────────────────────────────────────────────────

/** The whole transcript and the loaded context, trimmed oldest-first only when it would not fit the model. */
export const PlainContextor = z.object({ type: z.literal('plain') });
export type PlainContextor = z.infer<typeof PlainContextor>;

/** Suggestion blocks on each user message, and optionally the best context's content put in the system prompt. */
export const SuggestContextor = z.object({
  type: z.literal('suggest'),
  topN: z.number().int().min(0).default(6),
  /** Put the best items' full content in the system prompt, up to these many items and tokens. */
  autoInject: z.object({ tokens: z.number().int().min(0), items: z.number().int().min(0) }).optional(),
});
export type SuggestContextor = z.infer<typeof SuggestContextor>;

/**
 * The signals the graph contextor scores a candidate by. `embedding`: cosine similarity to the message. `words`:
 * share of the message's words it has. `turnsAgo`: turns since it was last selected or used. `age`: days since it was
 * written (memory). `selectedBefore`: it was in the last selection. `used`: how often it was run, loaded or cited in
 * the last five turns.
 */
export const GRAPH_METRICS = ['embedding', 'words', 'turnsAgo', 'age', 'selectedBefore', 'used'] as const;
export const GraphMetric = z.enum(GRAPH_METRICS);
export type GraphMetric = z.infer<typeof GraphMetric>;

/** One metric's part of the score: `weight × e^(−k(value − target)²)`. Absent target and k take the metric's defaults. */
export const MetricWeight = z.object({ weight: z.number().min(0), target: z.number().optional(), k: z.number().positive().optional() });
export type MetricWeight = z.infer<typeof MetricWeight>;

/** When the graph contextor chooses: once per user message (stable within a turn), or before every LLM call. */
export const GRAPH_EVALUATIONS = ['perMessage', 'perIteration'] as const;
export const GraphEvaluation = z.enum(GRAPH_EVALUATIONS);
export type GraphEvaluation = z.infer<typeof GraphEvaluation>;

/** How the flexible budget is shared between history, context and fns; what one leaves unused flows to the others. */
export const BudgetShares = z.object({ history: z.number().min(0), context: z.number().min(0), fns: z.number().min(0) });
export type BudgetShares = z.infer<typeof BudgetShares>;

/**
 * A fresh prompt per user message: the relevant history rebuilt (a recent linear tail plus summaries of earlier
 * exchanges), the likely-related context and fns chosen by weight at the detail the budget allows, never more than
 * the model takes. Built for small local models.
 */
export const GraphContextor = z.object({
  type: z.literal('graph'),
  /** Overrides of the metrics' default weights; a metric left out keeps its default. */
  metrics: z.partialRecord(GraphMetric, MetricWeight).default({}),
  /** Activation spread over links: how much a neighbour passes on (damping), and over how many hops. */
  spread: z.object({ damping: z.number().min(0).max(0.95).default(0.5), hops: z.number().int().min(0).max(4).default(2) }).prefault({}),
  /** Exchanges always kept in the linear history (the current message always is). */
  floorExchanges: z.number().int().min(0).default(1),
  shares: BudgetShares.default({ history: 0.45, context: 0.35, fns: 0.2 }),
  /** Below this activation an item is not offered even as a name. */
  threshold: z.number().min(0).default(0.15),
  evaluate: GraphEvaluation.default('perMessage'),
});
export type GraphContextor = z.infer<typeof GraphContextor>;

/** A contextor's settings. Adding a variant fails to compile in the hub until it has an implementation. */
export const ContextorConfig = z.discriminatedUnion('type', [PlainContextor, SuggestContextor, GraphContextor]);
export type ContextorConfig = z.infer<typeof ContextorConfig>;
/** The contextors, read off `ContextorConfig`. */
export const ContextorType = z.enum(ContextorConfig.options.map((option) => option.shape.type.value));
export type ContextorType = z.infer<typeof ContextorType>;

/** The defaults an agent gets when its payload names neither: build 1's behaviour. */
export const DEFAULT_CHAT_MODE: ChatModeConfig = { type: 'tools' };
export const DEFAULT_CONTEXTOR: ContextorConfig = { type: 'plain' };

// ─── Model limits ─────────────────────────────────────────────────────────────

/**
 * What the hub budgets a model's prompts against. Every field may be absent: the next source fills it (an admin's
 * record, then the provider's probe, then aeye's model info, then the hub's defaults).
 */
export const ModelLimits = z.object({
  /** The window the provider actually serves (Ollama's `num_ctx`), not the length the model was trained to. */
  contextWindow: z.number().int().min(256).optional(),
  maxOutputTokens: z.number().int().min(16).optional(),
  /** Tokens a reasoning model thinks before it answers; reserved on top of the answer. */
  reasoningTokens: z.number().int().min(0).optional(),
  /** Characters per token for estimates, before calibration. */
  charsPerToken: z.number().min(1).max(8).optional(),
});
export type ModelLimits = z.infer<typeof ModelLimits>;

/** Limits with every field known: what one prompt is budgeted against. */
export const ResolvedModelLimits = ModelLimits.required();
export type ResolvedModelLimits = z.infer<typeof ResolvedModelLimits>;

/** Where each resolved limit came from, so the admin page can say "window 4096 (Ollama num_ctx)". */
export const LIMIT_SOURCES = ['admin', 'probe', 'model-info', 'default'] as const;
export const LimitSource = z.enum(LIMIT_SOURCES);
export type LimitSource = z.infer<typeof LimitSource>;

/** Resolved limits with the source of each field. */
export const ModelLimitsView = z.object({
  model: z.string(),
  limits: ResolvedModelLimits,
  sources: z.record(z.enum(['contextWindow', 'maxOutputTokens', 'reasoningTokens', 'charsPerToken']), LimitSource),
  /** Measured input tokens over estimated, from recent calls (1 before any). */
  ratio: z.number(),
});
export type ModelLimitsView = z.infer<typeof ModelLimitsView>;

/** An admin's limits for one model (the aeye model id, `ollama/qwen2.5:3b`). */
export const ModelLimitsRecord = z.object({ model: z.string(), limits: ModelLimits, setBy: ActorId, updatedAt: Timestamp });
export type ModelLimitsRecord = z.infer<typeof ModelLimitsRecord>;

/** How far the hub's token estimates are off for one model: measured input tokens over estimated, as a moving average. */
export const ModelCalibration = z.object({ model: z.string(), ratio: z.number().min(0.5).max(2), samples: z.number().int().min(0), updatedAt: Timestamp });
export type ModelCalibration = z.infer<typeof ModelCalibration>;

// ─── What a prompt held ───────────────────────────────────────────────────────

/** One budget pool's ask and what it got, in tokens. */
export const PoolUse = z.object({ asked: z.number().int().min(0), got: z.number().int().min(0) });
export type PoolUse = z.infer<typeof PoolUse>;

/**
 * How one prompt's tokens were spent: the window, the reserve for the reply (and reasoning), the safety margin, the
 * fixed part (instructions, tools, the current turn), each pool's ask and share, and what was cut to fit. Saved on
 * the LLM interaction, so the run inspector can show why something was left out.
 */
export const BudgetReport = z.object({
  window: z.number().int().min(0),
  output: z.number().int().min(0),
  reasoning: z.number().int().min(0),
  margin: z.number().int().min(0),
  fixed: z.number().int().min(0),
  pools: z.object({ history: PoolUse, context: PoolUse, fns: PoolUse }),
  /** The request's estimate, which is never more than `window − output − reasoning − margin`. */
  estimate: z.number().int().min(0),
  cut: z.array(z.object({ what: z.string(), why: z.string() })),
});
export type BudgetReport = z.infer<typeof BudgetReport>;

/** An item a contextor chose, at a detail, with its activation (its score after spreading over links). */
export const SelectedItem = z.object({ name: QualifiedName, detail: Detail, activation: z.number().min(0) });
export type SelectedItem = z.infer<typeof SelectedItem>;

/** What one contextor cycle chose: saved with the LLM interaction and shown in the run inspector. */
export const SelectionReport = z.object({
  contextor: ContextorType,
  mode: ChatModeType,
  context: z.array(SelectedItem),
  fns: z.array(SelectedItem),
  /** Exchanges sent as real messages, newest last. */
  linear: z.number().int().min(0),
  /** Earlier exchanges summarised in the system prompt, by turn number. */
  earlier: z.array(z.number().int().min(0)),
  budget: BudgetReport,
});
export type SelectionReport = z.infer<typeof SelectionReport>;

/**
 * The graph contextor's memory of its last cycle in a session: what it chose (for the `selectedBefore` metric and a
 * stable answer within a turn). Rewritten wholesale every cycle.
 */
export const GraphSelection = z.object({ turn: TurnId, items: z.array(SelectedItem), at: Timestamp });
export type GraphSelection = z.infer<typeof GraphSelection>;
