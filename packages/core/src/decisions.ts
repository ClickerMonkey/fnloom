/**
 * The decision model for systems. The admin's suggestion decision model (`SuggestDecision`) can also choose
 * for a system between reusing something it has and making something new: the database system's `get_query` asks it
 * whether a saved query answers a description, the input system's `get_input` whether a saved form fits. The system
 * sends the question and its scored candidates (`decide` on the hub link); the hub answers with the model's picks, or
 * says the decision model is off so the system goes by its scores. The call is a model call of the asking run.
 */
import { z } from 'zod';
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
