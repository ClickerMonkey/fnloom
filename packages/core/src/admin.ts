/**
 * The shapes the admin pages read beyond the records themselves: a system's output lines, the models providers
 * offer, budgets with what they have spent, declared settings, the filters of the runs, LLM call and resource
 * browsers, and a reference to a rule an admin removes. The endpoints that return them are in `web.ts`'s admin group.
 */
import { z } from 'zod';
import { SettingDecl } from './manifest.ts';
import { BudgetId, ModelCategoryId, PolicyId, PriorityRuleId, ProviderId, QualifiedName, SystemName, Timestamp, Usd } from './primitives.ts';
import { ModelRole } from './model-calls.ts';
import { LlmInteraction } from './records/runs.ts';
import { BudgetRule, ProviderKind } from './records/spend.ts';

/**
 * One line of a system's output: what a connected system logged over the link (`stdout` for info and below,
 * `stderr` for warnings and errors), or a note the hub wrote about it (connected, disconnected, exited).
 */
export const OutputLine = z.object({ at: Timestamp, stream: z.enum(['stdout', 'stderr', 'hub']), text: z.string() });
export type OutputLine = z.infer<typeof OutputLine>;

/** Who serves a model: a configured provider's kind (`openai`), or a provider a system brings (`<system>/<name>`). */
export const ModelProvider = z.union([ProviderKind, QualifiedName]);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** A model a provider offers, as aeye's model list describes it. `provider` is who serves it. Prices are per million tokens. */
export const ModelInfo = z.object({
  id: z.string(),
  provider: ModelProvider,
  name: z.string(),
  contextWindow: z.number().int().min(0).optional(),
  pricing: z.object({ input: Usd, output: Usd }).optional(),
  /** What it can do: `chat`, `tools`, `vision`, `reasoning`, `embedding`, … */
  capabilities: z.array(z.string()),
  /** A decision model's most questions per call (aeye's `ModelInfo.maxQuestions`): callers split their questions by it. */
  maxQuestions: z.number().int().min(1).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/**
 * A model as a system's aeye sees it through the hub (`models` on the hub link, `ctx.ai()` / `hubAi()`):
 * what `ModelInfo` says plus what aeye's selection needs, and the hub roles it fills. `capabilities` are aeye's
 * capability names. Only the models the system may use are listed; the hub still checks access and budgets per call.
 */
export const HubModelInfo = ModelInfo.extend({
  tier: z.enum(['flagship', 'efficient', 'legacy', 'experimental']),
  maxOutputTokens: z.number().int().min(1).optional(),
  roles: z.array(ModelRole),
});
export type HubModelInfo = z.infer<typeof HubModelInfo>;

/** A budget with what has been spent in its current period. */
export const BudgetView = BudgetRule.extend({ spent: Usd });
export type BudgetView = z.infer<typeof BudgetView>;

/** An actor setting a system declared. */
export const SettingView = z.object({ setting: QualifiedName, system: SystemName, decl: SettingDecl });
export type SettingView = z.infer<typeof SettingView>;


/** An LLM call in a list: everything but the request and response, which `llmCall` fetches. */
export const LlmSummary = LlmInteraction.omit({ request: true, response: true });
export type LlmSummary = z.infer<typeof LlmSummary>;



/** A rule an admin can remove, by what it is. */
export const RuleRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('budget'), id: BudgetId }),
  z.object({ kind: z.literal('priority'), id: PriorityRuleId }),
  z.object({ kind: z.literal('policy'), id: PolicyId }),
  z.object({ kind: z.literal('category'), id: ModelCategoryId }),
  z.object({ kind: z.literal('provider'), id: ProviderId }),
]);
export type RuleRef = z.infer<typeof RuleRef>;
