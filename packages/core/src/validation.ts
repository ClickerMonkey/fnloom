/**
 * Fn validation hooks. A fn can declare `validate.input` and `validate.output` (TypeScript in its system,
 * given ctx, args, session state and, for output, the result). The hub calls the system's `validate` endpoint before
 * starting such a run and after it succeeds. A refused input tells the model the fn can't run now and why (a tool
 * result, not an error). A refused output either asks the model to try again with the reason, or stops the run with the
 * reason shown to the person.
 */
import { z } from 'zod';
import { RunInfo } from './run.ts';
import { Json } from './primitives.ts';

/** Which hooks a fn declares (`FnDecl.validate`). */
export const FnValidation = z.object({ input: z.boolean(), output: z.boolean() });
export type FnValidation = z.infer<typeof FnValidation>;

/** The answer of an input check. */
export const InputVerdict = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.string().min(1) })]);
export type InputVerdict = z.infer<typeof InputVerdict>;

/** The answer of an output check: fine, try again (the model gets `reason`), or stop the run (the person sees `reason`). */
export const OutputVerdict = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), action: z.enum(['retry', 'stop']), reason: z.string().min(1) }),
]);
export type OutputVerdict = z.infer<typeof OutputVerdict>;

/** Hub → system (`validate`): check a run's args before it starts, or its result after it succeeds. */
export const ValidateRequest = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('input'), run: RunInfo, fn: z.string(), args: Json }),
  z.object({ phase: z.literal('output'), run: RunInfo, fn: z.string(), args: Json, result: Json, attempt: z.number().int().min(1) }),
]);
export type ValidateRequest = z.infer<typeof ValidateRequest>;

/**
 * The system's answer to `validate`, by phase. The output verdict is tried first: an input refusal has no `action`,
 * and trying it first would strip the `action` from an output one.
 */
export const ValidateAnswer = z.union([OutputVerdict, InputVerdict]);
export type ValidateAnswer = z.infer<typeof ValidateAnswer>;
