/** Providers, models, priorities, budgets and the ledger. */
import { z } from 'zod';
import {
  ActorId, BudgetId, Duration, LedgerId, LlmInteractionId, ModelCallId, ModelCategoryId, Priority, PriorityRuleId, ProviderId, QualifiedName,
  ReservationId, RunId, SecretId, SessionId, SystemName, Timestamp, TurnId, Usd,
} from '../primitives.ts';
import { awsProviderVariant } from '../system-providers.ts';

/** Where a local Ollama listens by default. */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * The one table of model providers harness can configure (one per aeye provider package the hub builds, in
 * `execution/providers.ts`) and the fields each takes. A provider joins here only once the hub can build it.
 * `secret` is the schema of a field that holds a key: a stored `SecretId` in `ProviderConfig`, the key itself in the
 * web's `ProviderInput`. Both unions, and `ProviderKind`, are built from here.
 */
export function providerVariants<S extends z.ZodType<string>>(secret: S) {
  return z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('openai'), apiKey: secret, baseURL: z.url().optional() }),
    z.object({ provider: z.literal('openrouter'), apiKey: secret }),
    /**
     * A local Ollama, no key: chat through its OpenAI-compatible `/v1`, limits and abilities read from `/api/show`.
     * `contextWindow` is the window its models are served with when their Modelfiles set no `num_ctx`.
     */
    z.object({ provider: z.literal('ollama'), baseURL: z.url().default(OLLAMA_BASE_URL), contextWindow: z.number().int().min(256).optional() }),
    /** Amazon Bedrock (`@aeye/aws`): a region and an access key pair or a Bedrock API key. */
    awsProviderVariant(secret),
  ]);
}

/** A model provider. Keys are stored as secrets. */
export const ProviderConfig = providerVariants(SecretId);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** The model providers harness can configure, read off `providerVariants`. */
export const ProviderKind = z.enum(ProviderConfig.options.map((option) => option.shape.provider.value));
export type ProviderKind = z.infer<typeof ProviderKind>;

/** A configured provider row. */
export const ProviderRecord = z.object({ id: ProviderId, config: ProviderConfig, createdAt: Timestamp });
export type ProviderRecord = z.infer<typeof ProviderRecord>;

/** An encrypted secret. Only its id and name ever leave the hub. */
export const Secret = z.object({ id: SecretId, name: z.string(), owner: ActorId, ciphertext: z.string(), createdAt: Timestamp });
export type Secret = z.infer<typeof Secret>;

/** A named, ordered list of models: start with the first, move down when quality demands it. */
export const ModelCategory = z.object({ id: ModelCategoryId, name: z.string(), description: z.string(), models: z.array(z.string()) });
export type ModelCategory = z.infer<typeof ModelCategory>;

/** The levels a turn passes through, from broad to specific, plus systems, fns and models (budgets only). */
export const LimitScope = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('hub') }),
  z.object({ scope: z.literal('group'), group: ActorId }),
  z.object({ scope: z.literal('user'), user: ActorId }),
  z.object({ scope: z.literal('session'), session: SessionId }),
  z.object({ scope: z.literal('turn'), turn: TurnId }),
  z.object({ scope: z.literal('system'), system: SystemName }),
  z.object({ scope: z.literal('fn'), fn: QualifiedName }),
  z.object({ scope: z.literal('model'), model: z.string() }),
]);
export type LimitScope = z.infer<typeof LimitScope>;
export type LimitLevel = LimitScope['scope'];

/** The levels a priority rule can live at. */
export const PriorityLevel = z.enum(['hub', 'group', 'user', 'session', 'turn']);
export type PriorityLevel = z.infer<typeof PriorityLevel>;

/** Where a priority rule lives. */
export const PriorityScope = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('hub') }),
  z.object({ scope: z.literal('group'), group: ActorId }),
  z.object({ scope: z.literal('user'), user: ActorId }),
  z.object({ scope: z.literal('session'), session: SessionId }),
  z.object({ scope: z.literal('turn'), turn: TurnId }),
]);
export type PriorityScope = z.infer<typeof PriorityScope>;

/** How long a budget's spend adds up before it starts again: a rolling window, never, or each turn on its own. */
export const BudgetPeriod = z.union([z.object({ window: Duration }), z.literal('all-time'), z.literal('per-turn')]);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

/** A budget: how much may be spent at one level, per period. */
export const BudgetRule = z.object({
  id: BudgetId,
  target: LimitScope,
  period: BudgetPeriod,
  maxCost: Usd,
  maxTokens: z.number().int().optional(),
  maxCalls: z.number().int().optional(),
  /** For `per-turn` budgets: how long a turn may take. */
  maxTime: Duration.optional(),
  /** Only on groups. `pooled`: members share one pot. `each`: every member gets this allowance. */
  share: z.enum(['pooled', 'each']).optional(),
  /** When reached: wait for the period to free up, refuse, or ask someone to raise it. */
  onLimit: z.enum(['wait', 'refuse', 'ask']),
  setBy: ActorId,
});
export type BudgetRule = z.infer<typeof BudgetRule>;

/** A priority rule: the priority used unless something more specific sets one, and the highest allowed. */
export const PriorityRule = z.object({
  id: PriorityRuleId,
  target: PriorityScope,
  default: Priority.optional(),
  /** No turn under this level runs above it. */
  max: Priority.optional(),
  setBy: ActorId,
});
export type PriorityRule = z.infer<typeof PriorityRule>;

/** The priority and budgets resolved for a turn. There is always exactly one answer (see the execution module). */
export const ResolvedLimits = z.object({
  priority: Priority,
  /** Which level gave the default, and which capped it. */
  priorityFrom: z.object({ default: PriorityLevel, cappedBy: PriorityLevel.optional() }),
  /** The turn's own budget. */
  turn: z.object({ cost: Usd, time: Duration }),
  /** Every budget that applies, with what was left when the turn started. */
  budgets: z.array(z.object({ rule: BudgetId, scope: LimitScope, remaining: Usd })),
  /** The tightest one, shown in the chat ("limited by: session total"); absent when nothing limits. */
  limitedBy: BudgetId.optional(),
});
export type ResolvedLimits = z.infer<typeof ResolvedLimits>;

/** Budget held before an LLM call, settled with the real cost after. */
export const Reservation = z.object({
  id: ReservationId,
  budgets: z.array(BudgetId),
  estimate: Usd,
  createdAt: Timestamp,
  settled: z.object({ cost: Usd, at: Timestamp }).optional(),
});
export type Reservation = z.infer<typeof Reservation>;

/** One line of spend. */
export const LedgerEntry = z.object({
  id: LedgerId,
  at: Timestamp,
  cost: Usd,
  tokens: z.number().int().min(0),
  actor: ActorId,
  system: SystemName.optional(),
  session: SessionId.optional(),
  fn: QualifiedName,
  model: z.string().optional(),
  llmCall: LlmInteractionId.optional(),
  /** The model call it paid for (every modality). */
  modelCall: ModelCallId.optional(),
  run: RunId,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
