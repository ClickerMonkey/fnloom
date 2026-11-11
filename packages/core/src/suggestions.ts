/**
 * Suggestions (build 3): what the hub offered a user message (fns and context), what it left out and why, and the
 * admin's decision model that can choose instead of a score threshold. The record rides on the user message, so the
 * chat shows a compact icon row with counts and, opened, the used and the not-used items with their reasons.
 */
import { z } from 'zod';
import { AutoClassifier } from './fn-facts.ts';
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
 * `broughtBy` (build 6): a fn suggested because a suggested context brings it, at that context's score.
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
 * The decision model setting (admins; off by default). When on, the candidates scoring at least `floor` (at most
 * `candidates` of them) and the last `messages` user messages go to `model`, which picks at most `cap` to suggest.
 * Its picks and refusals, with reasons, become the message's `SuggestionRecord`. If it fails, the score decides.
 */
export const SuggestDecision = z.object({
  enabled: z.boolean().default(false),
  model: RoleModel.optional(),
  messages: z.number().int().min(1).max(20).default(3),
  candidates: z.number().int().min(1).max(50).default(20),
  cap: z.number().int().min(0).max(20).default(6),
  floor: z.number().min(0).max(1).default(0.2),
}).refine((value) => !value.enabled || value.model !== undefined, { message: 'Pick a model to turn the decision model on.', path: ['model'] });
export type SuggestDecision = z.infer<typeof SuggestDecision>;

/** The stored setting, who set it and when (the `hubOptions` row keyed `suggestDecision`). */
export const SuggestDecisionView = z.object({ value: SuggestDecision, setBy: ActorId.optional(), updatedAt: Timestamp.optional() });
export type SuggestDecisionView = z.infer<typeof SuggestDecisionView>;

/**
 * A hub-wide option an admin sets, one row per key. A new option is a new variant here (and a slice endpoint pair to
 * read and set it).
 */
export const HubOption = z.discriminatedUnion('key', [
  z.object({ key: z.literal('suggestDecision'), value: SuggestDecision, setBy: ActorId, updatedAt: Timestamp }),
  z.object({ key: z.literal('autoClassifier'), value: AutoClassifier, setBy: ActorId, updatedAt: Timestamp }),
]);
export type HubOption = z.infer<typeof HubOption>;
