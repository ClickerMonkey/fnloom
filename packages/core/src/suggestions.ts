/**
 * Suggestions: what the hub offered a user message (fns and context), what it left out and why, and the admin's
 * choice of who picks them: no model (the score threshold), a decision model, or an LLM. The record rides on the user message, so the
 * chat shows a compact icon row with counts and, opened, the used and the not-used items with their reasons.
 */
import { z } from 'zod';
import { AutoClassifier } from './fn-facts.ts';
import { HUB_NAME_OPTION, HubDisplayName } from './identity.ts';
import { ImageEmbedding } from './image-embeddings.ts';
import { RoleModel } from './model-calls.ts';
import { ActorId, ModelCallId, QualifiedName, Timestamp } from './primitives.ts';

/** Who chose: the score threshold, the decision model, or the graph contextor's selection. */
export const SUGGESTION_DECIDERS = ['score', 'decision', 'graph'] as const;
export const SuggestionDecider = z.enum(SUGGESTION_DECIDERS);
export type SuggestionDecider = z.infer<typeof SuggestionDecider>;

/**
 * Why an item was left out. `below-threshold`: its score was under the threshold (or the decision model's floor).
 * `top-n`: more items scored higher than the count allows. `declined`: the decision model chose against it (its words
 * in `note`). `budget`: no room in the prompt's token budget. `rule`: a policy, its audience or an off switch hid it.
 * `failed`: the decision model failed, so the score decided (the item records what the score said).
 */
export const SKIP_REASONS = ['below-threshold', 'top-n', 'declined', 'budget', 'rule', 'failed'] as const;
export const SkipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

/** What a skip reason reads as in the chat. */
export const SKIP_REASON_LABELS = {
  'below-threshold': 'Score under the threshold', 'top-n': 'Others scored higher', declined: 'The decision model declined it',
  budget: 'No room in the token budget', rule: 'Hidden by a rule', failed: 'Decision model failed; the score decided',
} as const satisfies Record<SkipReason, string>;

/**
 * One candidate fn or context item and what became of it. `note`: the decision model's reason, in its words.
 * `broughtBy`: a fn suggested because a suggested context brings it, at that context's score.
 */
export const SuggestionOutcome = z.discriminatedUnion('used', [
  z.object({ used: z.literal(true), kind: z.enum(['fn', 'context']), name: QualifiedName, score: z.number().optional(), broughtBy: QualifiedName.optional(), note: z.string().optional() }),
  z.object({ used: z.literal(false), kind: z.enum(['fn', 'context']), name: QualifiedName, score: z.number().optional(), broughtBy: QualifiedName.optional(), reason: SkipReason, note: z.string().optional() }),
]);
export type SuggestionOutcome = z.infer<typeof SuggestionOutcome>;

/** What the hub suggested for one user message, and what it did not. Absent on messages with no candidates at all. */
export const SuggestionRecord = z.object({
  by: SuggestionDecider,
  /** The score threshold that applied (the decision model's floor when `by` is `decision`). */
  threshold: z.number().optional(),
  /** The decision model's call, for the model calls page. */
  call: ModelCallId.optional(),
  items: z.array(SuggestionOutcome),
});
export type SuggestionRecord = z.infer<typeof SuggestionRecord>;

/**
 * What a model that picks suggestions reads and may pick: the last `messages` user messages, the candidates scoring at
 * least `floor` (at most `candidates` of them), and at most `cap` picks.
 */
export const SuggestPicking = z.object({
  messages: z.number().int().min(1).max(20).default(3),
  candidates: z.number().int().min(1).max(50).default(20),
  cap: z.number().int().min(0).max(20).default(6),
  /**
   * The least similarity of meaning (cosine, 0 to 1, the same scale as the hub's suggestion threshold, 0.45) a
   * candidate needs to reach the model. Below the threshold, so the model can take a near miss the score alone would
   * drop (0.35 to 0.45), and above most unrelated text (0.2 to 0.4 with EmbeddingGemma), which the old 0.2, set on the
   * fused-rank scale where every hit scored near 1, let through whole. A test keeps it under the threshold.
   */
  floor: z.number().min(0).max(1).default(0.35),
});
export type SuggestPicking = z.infer<typeof SuggestPicking>;

/** Who picks the suggestions: `none` (no model; the score threshold decides), a decision model, or an LLM. */
export const SUGGESTION_CHOOSERS = ['none', 'decision', 'llm'] as const;
export const SuggestionChooser = z.enum(SUGGESTION_CHOOSERS);
export type SuggestionChooser = z.infer<typeof SuggestionChooser>;

/**
 * The suggestions setting (admins), one choice:
 * - `none`: no model; the best candidates over the score threshold are suggested (the default).
 * - `decision`: a decision model (`model`, else the `decide` role's) answers one yes/no question per candidate; those
 *   at or over the decide role's threshold are picked, most likely first. Calls are split by the model's `maxQuestions`.
 * - `llm`: a chat model (`model`) reads the candidates and answers which to pick, as JSON, with reasons.
 * The picks and refusals become the message's `SuggestionRecord`. If the model fails, the score decides.
 */
export const SuggestDecision = z.discriminatedUnion('by', [
  z.object({ by: z.literal('none') }),
  SuggestPicking.extend({ by: z.literal('decision'), model: RoleModel.optional() }),
  SuggestPicking.extend({ by: z.literal('llm'), model: RoleModel }),
]);
export type SuggestDecision = z.infer<typeof SuggestDecision>;

/** The setting before any admin chose: no model. */
export const SUGGEST_DECISION_DEFAULT: SuggestDecision = { by: 'none' };

/** The setting as it was stored before 2026-11-19: a chat model, on or off. */
const LegacySuggestDecision = SuggestPicking.extend({ enabled: z.boolean(), model: RoleModel.optional() });

/** A legacy setting as today's: on with a model is `llm` (it was always a chat model asked for JSON); otherwise `none`. */
export function upgradeSuggestDecision(legacy: z.infer<typeof LegacySuggestDecision>): SuggestDecision {
  const { enabled, model, ...picking } = legacy;
  return enabled && model !== undefined ? { by: 'llm', model, ...picking } : SUGGEST_DECISION_DEFAULT;
}

/** The stored setting: today's shape, or the legacy one read as today's (rewritten in today's shape when next saved). */
export const StoredSuggestDecision = z.union([SuggestDecision, LegacySuggestDecision.transform(upgradeSuggestDecision)]);

/** The stored setting, who set it and when (the `hubOptions` row keyed `suggestDecision`). */
export const SuggestDecisionView = z.object({ value: SuggestDecision, setBy: ActorId.optional(), updatedAt: Timestamp.optional() });
export type SuggestDecisionView = z.infer<typeof SuggestDecisionView>;

/**
 * A hub-wide option an admin sets, one row per key. A new option is a new variant here (and a slice endpoint pair to
 * read and set it).
 */
export const HubOption = z.discriminatedUnion('key', [
  z.object({ key: z.literal('suggestDecision'), value: StoredSuggestDecision, setBy: ActorId, updatedAt: Timestamp }),
  z.object({ key: z.literal('autoClassifier'), value: AutoClassifier, setBy: ActorId, updatedAt: Timestamp }),
  /** Build 8: the hub's display name, set by an admin (`identity.ts`). */
  z.object({ key: z.literal(HUB_NAME_OPTION), value: HubDisplayName, setBy: ActorId, updatedAt: Timestamp }),
  /** Where the index embeds images (`image-embeddings.ts`). */
  z.object({ key: z.literal('imageEmbedding'), value: ImageEmbedding, setBy: ActorId, updatedAt: Timestamp }),
]);
export type HubOption = z.infer<typeof HubOption>;
