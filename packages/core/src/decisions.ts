/**
 * Decisions. The model that picks suggestions (`SuggestDecision`: a decision model or an LLM) also chooses for a system
 * between reusing something it has and making something new: the database system's `get_query` asks it whether a
 * saved query answers a description, the input system's `get_input` whether a saved form fits. The system sends the
 * question and its scored candidates (`decide` on the hub link); the hub answers with the model's picks, or says no
 * model picks suggestions so the system goes by its scores. The call is a model call of the asking run.
 *
 * Below, the wire shapes of aeye's decision calls (`ai.decide`): questions, answers and inputs, which the hub link's
 * `model` endpoint and system providers' `providerDecide` carry.
 */
import { z } from 'zod';
import { LlmMessage } from './llm.ts';
import { ModelCallId, RunId } from './primitives.ts';

/** One thing the model may pick: the system's own id for it, what it is in words, and the system's score for it. */
export const DecideCandidate = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** The system's own match score, 0 to 1 (cosine similarity for embeddings). */
  score: z.number().min(0).max(1),
});
export type DecideCandidate = z.infer<typeof DecideCandidate>;

/** A system asks the decision model to choose (`decide` on the hub link). */
export const DecideRequest = z.object({
  /** The run asking, which the model call is charged to. */
  run: RunId,
  /** What is wanted, in the asker's words ("a query that lists overdue invoices by customer"). */
  question: z.string().min(1),
  candidates: z.array(DecideCandidate).min(1).max(50),
  /** The most it may pick; 1 for "the one to reuse, or none". */
  max: z.number().int().min(1).max(20),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

/**
 * The answer. `decision`: the model's picks, best first (none means make something new), with its reasons.
 * `off`: no decision model is set, so go by the scores. `failed`: it was set but its call failed, so go by the scores.
 */
export const DecideAnswer = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('decision'),
    picked: z.array(z.object({ id: z.string(), why: z.string().optional() })),
    /** Why it picked nothing, when it didn't. */
    note: z.string().optional(),
    /** The model call it made, charged to the asking run. */
    call: ModelCallId.optional(),
  }),
  z.object({ by: z.literal('off') }),
  z.object({ by: z.literal('failed'), message: z.string() }),
]);
export type DecideAnswer = z.infer<typeof DecideAnswer>;

// ─── Decision model calls (aeye's `ai.decide`) ────────────────────────────────

/**
 * A question a decision model answers about an input, in aeye's shape (`DecisionQuestion`; the hub pins the two
 * together at compile time): `predicate` how likely a condition holds, `choice` which of the keyed choices applies,
 * `score` where the input falls on ordered levels, lowest first.
 */
export const DecisionQuestion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), instructions: z.string().min(1) }),
  z.object({ type: z.literal('choice'), instructions: z.string().min(1), choices: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('score'), instructions: z.string().min(1), levels: z.array(z.string()).min(1) }),
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;

/** What a decision call reads: text, or a conversation. */
export const DecisionInput = z.union([z.string().min(1), z.array(LlmMessage).min(1)]);
export type DecisionInput = z.infer<typeof DecisionInput>;

/** Questions by name. */
export const DecisionQuestions = z.record(z.string().min(1), DecisionQuestion);
export type DecisionQuestions = z.infer<typeof DecisionQuestions>;

/** A probability, 0 to 1. */
const Probability = z.number().min(0).max(1);

/** A decision model's answer to one question, in aeye's shape (`DecisionAnswer`). */
export const DecisionAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), probability: Probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), Probability), confidence: Probability }),
  z.object({ type: z.literal('score'), score: z.number(), probabilities: z.array(Probability), confidence: Probability }),
  z.object({ type: z.literal('refusal') }),
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

/** Answers by question name. */
export const DecisionAnswers = z.record(z.string(), DecisionAnswer);
export type DecisionAnswers = z.infer<typeof DecisionAnswers>;

/** The threshold a predicate's probability must reach to count as yes, unless the decide role sets another. */
export const DEFAULT_DECIDE_THRESHOLD = 0.5;

/** A predicate answer's probability; 0 for a refusal or an answer of another type. */
export function yesProbability(answer: DecisionAnswer | undefined): number {
  return answer?.type === 'predicate' ? answer.probability : 0;
}
