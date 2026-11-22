/**
 * Suggestions: what the hub offered a user message (fns and context), what it left out and why, and the admin's
 * choice of who picks them: a decision model, an LLM, or no model (the score alone). The record rides on the user message, so the
 * chat shows a compact icon row with counts and, opened, the used and the not-used items with their reasons.
 */
import { z } from 'zod';
import { AutoClassifier, SearchItemKind } from './fn-facts.ts';
import { HUB_NAME_OPTION, HubDisplayName } from './identity.ts';
import { ImageEmbedding } from './image-embeddings.ts';
import { RoleModel } from './model-calls.ts';
import { PROXY_TRUST_OPTION, ProxyTrust, SIGN_IN_LIMITS_OPTION, SIGN_IN_POLICY_OPTION, SignInLimits, SignInPolicy } from './sso.ts';
import { OUTSIDE_IMAGES_OPTION, OutsideImages } from './urls.ts';
import { ActorId, ModelCallId, QualifiedName, Timestamp } from './primitives.ts';

/** Who chose: the score threshold (no model picks), the decision model (or an LLM), or the graph contextor's selection. */
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
 * What a chooser does with what it picks: `suggest` (cards the model may load: `<suggested_fns>`,
 * `<suggested_ctx>`) or `load` (loaded for the turn, as `hub/fns_load` and `hub/ctx_load` load: the fns join
 * the model's tools from its first step, and context is brought into the user message as its text, with the fns it
 * brings; the message says so in `<loaded_for_you>`). Phil (2026-11-22): "options to not only allow a decision model
 * or llm to suggest context or fns but actually have them automatically add them".
 */
export const CHOOSER_ACTIONS = ['suggest', 'load'] as const;
export const ChooserAction = z.enum(CHOOSER_ACTIONS);
export type ChooserAction = z.infer<typeof ChooserAction>;

/** What a setting's chooser does: its `action`, else `suggest` (as every setting stored before 2026-11-22 did). No model, no loading. */
export function actionOf(setting: { readonly by: string; readonly action?: ChooserAction | undefined }): ChooserAction {
  return setting.by === 'none' ? 'suggest' : setting.action ?? 'suggest';
}

/**
 * What became of a pick a chooser with action `load` loaded, or meant to. `loaded`: loaded for the turn. `budget`:
 * its text didn't fit the room the prompt has for it, so it was suggested instead. `blocked`: it can't be loaded now
 * (a fn that can't be used here, a context item with no text of its own yet), so it was suggested instead.
 */
export const LOAD_OUTCOMES = ['loaded', 'budget', 'blocked'] as const;
export const LoadOutcome = z.enum(LOAD_OUTCOMES);
export type LoadOutcome = z.infer<typeof LoadOutcome>;

/** What a load outcome reads as in the chat and the admin's try-out. */
export const LOAD_OUTCOME_LABELS = {
  loaded: 'Loaded for the turn', budget: 'No room to load it, so suggested', blocked: 'Can\'t be loaded now, so suggested',
} as const satisfies Record<LoadOutcome, string>;

/**
 * One candidate fn or context item and what became of it. `note`: the decision model's reason, in its words.
 * `broughtBy`: a fn suggested because a suggested context brings it, at that context's score. `load`: with action
 * `load`, what became of a pick (absent: it was suggested, as the action `suggest` does).
 */
export const SuggestionOutcome = z.discriminatedUnion('used', [
  z.object({ used: z.literal(true), kind: z.enum(['fn', 'context']), name: QualifiedName, score: z.number().optional(), broughtBy: QualifiedName.optional(), note: z.string().optional(), load: LoadOutcome.optional() }),
  z.object({ used: z.literal(false), kind: z.enum(['fn', 'context']), name: QualifiedName, score: z.number().optional(), broughtBy: QualifiedName.optional(), reason: SkipReason, note: z.string().optional() }),
]);
export type SuggestionOutcome = z.infer<typeof SuggestionOutcome>;

/**
 * What the hub suggested for one user message, and what it did not. Absent on messages with no candidates at all. (A
 * record stored before 2026-11-19 named only its first call, `call`, which nothing reads; it is dropped when read.)
 */
export const SuggestionRecord = z.object({
  by: SuggestionDecider,
  /** The score threshold that applied (the decision model's floor when `by` is `decision`). */
  threshold: z.number().optional(),
  /** The model's calls, in order, for the model calls page: more than one when its questions were split across calls. */
  calls: z.array(ModelCallId).min(1).optional(),
  /** `load` when the chooser's action loads what it picks (each used item's `load` says what became of it); absent when it suggests. */
  action: z.literal('load').optional(),
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
   * The least similarity of meaning (cosine, 0 to 1, the same scale as the hub's suggestion threshold, 0.3) a
   * candidate needs to reach the model. Below the threshold, so the model can take a near miss the score alone would
   * drop: measured on 2026-11-22 with EmbeddingGemma, a clearly relevant general fn scores only 0.2 to 0.3 against an
   * ordinary request (`widgets/make_widget` 0.23 for keeping track of groceries), while the median item scores 0.09
   * to 0.19. A test keeps it under the threshold.
   */
  floor: z.number().min(0).max(1).default(0.2),
});
export type SuggestPicking = z.infer<typeof SuggestPicking>;

/** Who picks the suggestions: `none` (no model: the score alone), a decision model, or an LLM. */
export const SUGGESTION_CHOOSERS = ['decision', 'llm', 'none'] as const;
export const SuggestionChooser = z.enum(SUGGESTION_CHOOSERS);
export type SuggestionChooser = z.infer<typeof SuggestionChooser>;

/**
 * The suggestions setting (admins), one choice:
 * - `none`: no model picks (the default): the best candidates by similarity of meaning at or over the hub's
 *   `HARNESS_SUGGEST_THRESHOLD` are suggested, up to `HARNESS_SUGGESTIONS`.
 * - `decision`: a decision model (`model`, else the `decide` role's) answers one yes/no question per candidate; those
 *   at or over the decide role's threshold are picked, most likely first. Calls are split by the model's `maxQuestions`.
 * - `llm`: a chat model (`model`) reads the candidates and answers which to pick, as JSON, with reasons.
 * The picks and refusals become the message's `SuggestionRecord`. If the model fails, the score threshold decides.
 *
 * A model chooser's `action` (`ChooserAction`, default `suggest`) says whether its picks are suggested or loaded for
 * the turn. `none` only suggests: similarity alone is too weak a sign to put things in the prompt unasked (a clearly
 * relevant fn scores 0.2 to 0.3, near the median item), and nothing would say why each was loaded. If the model
 * fails, the score's picks are suggested, never loaded.
 */
export const SuggestDecision = z.discriminatedUnion('by', [
  z.object({ by: z.literal('none') }),
  SuggestPicking.extend({ by: z.literal('decision'), model: RoleModel.optional(), action: ChooserAction.optional() }),
  SuggestPicking.extend({ by: z.literal('llm'), model: RoleModel, action: ChooserAction.optional() }),
]);
export type SuggestDecision = z.infer<typeof SuggestDecision>;

/** The setting before any admin chose: no model, the score picks. */
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

/** Who filters a search's hits: nobody (the default), a decision model, or an LLM. */
export const SEARCH_JUDGES = ['none', 'decision', 'llm'] as const;
export const SearchJudge = z.enum(SEARCH_JUDGES);
export type SearchJudge = z.infer<typeof SearchJudge>;

/**
 * A search decision setting (admins), one per item kind (`SEARCH_DECISION_OPTIONS`): who filters the hits of
 * `hub/fns_search` / `hub/ctx_search` and of the web's search of fns and context (one operation) before they are returned.
 * - `none`: nobody; the hits are returned as ranked (the default).
 * - `decision`: a decision model (`model`, else the `decide` role's) answers one yes/no question per hit, "does it fit
 *   what the search is for?"; those at or over the decide role's threshold are kept, in their order.
 * - `llm`: a chat model (`model`) reads the hits and the search and answers which to keep, as JSON, with reasons.
 * What the search was for is its text and, inside a turn, the turn's latest user message. If the model fails, every
 * hit is kept and the page says so (`SearchFiltered.failed`).
 *
 * A model's `action` (default `suggest`: the kept hits are returned, for the model to load) may be `load`: when
 * `hub/fns_search` / `hub/ctx_search` runs in a chat, the best kept hits that can be used there are loaded too (fns into the tools,
 * context into the session, as `hub/fns_load` and `hub/ctx_load` load them), up to `HARNESS_SEARCH_LOAD_MAX` of each
 * kind, and the page says what (`FnSearchPage.loaded`). The web's search only filters; a failed filter loads nothing.
 */
export const SearchDecision = z.discriminatedUnion('by', [
  z.object({ by: z.literal('none') }),
  z.object({ by: z.literal('decision'), model: RoleModel.optional(), action: ChooserAction.optional() }),
  z.object({ by: z.literal('llm'), model: RoleModel, action: ChooserAction.optional() }),
]);
export type SearchDecision = z.infer<typeof SearchDecision>;

/** The search decision before any admin chose: nobody filters. */
export const SEARCH_DECISION_DEFAULT: SearchDecision = { by: 'none' };

/** The hub option each item kind's search decision is stored under: fns' and context's. */
export const SEARCH_DECISION_OPTIONS = { fn: 'fnsSearchDecision', context: 'contextSearchDecision' } as const satisfies Record<SearchItemKind, string>;

/** One stored search decision, who set it and when. */
export const SearchDecisionView = z.object({ value: SearchDecision, setBy: ActorId.optional(), updatedAt: Timestamp.optional() });
export type SearchDecisionView = z.infer<typeof SearchDecisionView>;

/** Both search decisions: fns' and context's. */
export const SearchDecisionsView = z.object({ fn: SearchDecisionView, context: SearchDecisionView });
export type SearchDecisionsView = z.infer<typeof SearchDecisionsView>;

/** Setting one item kind's search decision. */
export const SetSearchDecision = z.object({ item: SearchItemKind, value: SearchDecision });
export type SetSearchDecision = z.infer<typeof SetSearchDecision>;

/**
 * A hub-wide option an admin sets, one row per key. A new option is a new variant here (and a slice endpoint pair to
 * read and set it).
 */
export const HubOption = z.discriminatedUnion('key', [
  z.object({ key: z.literal('suggestDecision'), value: StoredSuggestDecision, setBy: ActorId, updatedAt: Timestamp }),
  z.object({ key: z.literal('autoClassifier'), value: AutoClassifier, setBy: ActorId, updatedAt: Timestamp }),
  /** Who filters the hits of a search of fns, and of context (`SearchDecision`). */
  z.object({ key: z.literal(SEARCH_DECISION_OPTIONS.fn), value: SearchDecision, setBy: ActorId, updatedAt: Timestamp }),
  z.object({ key: z.literal(SEARCH_DECISION_OPTIONS.context), value: SearchDecision, setBy: ActorId, updatedAt: Timestamp }),
  /** Build 8: the hub's display name, set by an admin (`identity.ts`). */
  z.object({ key: z.literal(HUB_NAME_OPTION), value: HubDisplayName, setBy: ActorId, updatedAt: Timestamp }),
  /** Where the index embeds images (`image-embeddings.ts`). */
  z.object({ key: z.literal('imageEmbedding'), value: ImageEmbedding, setBy: ActorId, updatedAt: Timestamp }),
  /** SSO: who may make an account by signing in through a provider for the first time (`sso.ts`). */
  z.object({ key: z.literal(SIGN_IN_POLICY_OPTION), value: SignInPolicy, setBy: ActorId, updatedAt: Timestamp }),
  /** Whether markdown images from outside the hub load at once or wait for a click (`urls.ts`). */
  z.object({ key: z.literal(OUTSIDE_IMAGES_OPTION), value: OutsideImages, setBy: ActorId, updatedAt: Timestamp }),
  /** How many password sign-ins the hub takes (`sso.ts`). */
  z.object({ key: z.literal(SIGN_IN_LIMITS_OPTION), value: SignInLimits, setBy: ActorId, updatedAt: Timestamp }),
  /** Whether proxies in front of the hub say where requests come from (`sso.ts`). */
  z.object({ key: z.literal(PROXY_TRUST_OPTION), value: ProxyTrust, setBy: ActorId, updatedAt: Timestamp }),
]);
export type HubOption = z.infer<typeof HubOption>;
