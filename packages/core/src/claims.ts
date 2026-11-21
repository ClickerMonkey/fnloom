/**
 * Parallel claims: what a call of a fn operates on, so an agent's calls that touch the same thing never run at once.
 * When a model makes several tool calls in one step, the hub starts them together, except that a call whose claims
 * conflict with an earlier call's (in the order the model made them) waits until that call has settled. Two calls
 * conflict when they share a claim, or when either claims `*` (it runs alone). The rule itself is aeye's
 * (`claimsConflict`, `claimWaits` in `@aeye/core`); this file holds what a fn declares and how the hub fills it in.
 *
 * A fn's claims come from two places, and a call claims both:
 *
 * - `FnDecl.parallelClaims`: templates the hub fills from the call's args, with no round trip. `{args.path}` is a
 *   value from the args (`file:{args.path}`), `{args.dir|.}` names a fallback for when it has none. A token that names
 *   a list gives one claim per item. A template whose token has no value and no fallback claims nothing.
 * - `FnDecl.dynamicClaims`: the hub asks the fn's system (`claims` on the system link) for the call's claims, worked
 *   out by its implementation from the args and the call's context (a path resolved against its roots).
 */
import { z } from 'zod';
import { Json, LocalName, RunId, SessionId } from './primitives.ts';
import { UserInfo } from './run.ts';
import { TEMPLATE_TOKEN, valueAtPath } from './status.ts';

/** Why a claim template can't be used: a token that isn't a dotted path into the args (`args.path`, `args.items.0`). */
function claimTokenProblem(template: string): string | undefined {
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    const token = (match[1] ?? '').trim();
    if (!token.startsWith('args.')) { return `the claim "${template}" uses {${token}}: a claim reads only its call's args ({args.path})`; }
  }
  return undefined;
}

/** One claim as a fn declares it: plain text with `{args.x}` tokens (`file:{args.path}`), or `*` to run alone. */
export const ClaimTemplate = z.string().min(1).max(500).superRefine((template, ctx) => {
  const problem = claimTokenProblem(template);
  if (problem !== undefined) { ctx.addIssue({ code: 'custom', message: problem }); }
});
export type ClaimTemplate = z.infer<typeof ClaimTemplate>;

/** What the hub asks a fn's system for a call's claims with (`claims` on the system link), before the call is a run. */
export const ClaimsRequest = z.object({
  fn: LocalName,
  args: Json,
  /** The person whose turn made the call. */
  user: UserInfo,
  /** The agent run that made the call. */
  caller: RunId,
  /** The chat the call was made in, when there is one. */
  session: SessionId.optional(),
});
export type ClaimsRequest = z.infer<typeof ClaimsRequest>;

/** A system's answer to `claims`: the call's claims (empty when it claims nothing). */
export const ClaimsAnswer = z.object({ claims: z.array(z.string().min(1)) });
export type ClaimsAnswer = z.infer<typeof ClaimsAnswer>;

/** A value as claims say it: text as it is, a list item by item, anything else as JSON; nothing for no value. */
function claimValues(value: Json | undefined): string[] {
  if (value === undefined || value === null || value === '') { return []; }
  if (typeof value === 'string') { return [value]; }
  if (typeof value === 'number' || typeof value === 'boolean') { return [String(value)]; }
  if (Array.isArray(value)) { return value.flatMap((item) => (Array.isArray(item) ? [JSON.stringify(item)] : claimValues(item))); }
  return [JSON.stringify(value)];
}

/** One template's claims for these args: one per combination of its tokens' values (a list token gives one per item). */
function fillClaim(template: string, args: Json): string[] {
  // the text between tokens, and each token's values, in order
  const pieces: string[] = [];
  const values: string[][] = [];
  let last = 0;
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    pieces.push(template.slice(last, match.index));
    last = match.index + match[0].length;
    const [root, ...path] = (match[1] ?? '').trim().split('.');
    const found = root === 'args' ? claimValues(valueAtPath(args, path)) : [];
    const fallback = match[2];
    const filled = found.length > 0 ? found : fallback === undefined ? [] : [fallback];
    if (filled.length === 0) { return []; }
    values.push(filled);
  }
  pieces.push(template.slice(last));
  let claims = [pieces[0] ?? ''];
  values.forEach((options, index) => {
    const after = pieces[index + 1] ?? '';
    claims = claims.flatMap((start) => options.map((option) => `${start}${option}${after}`));
  });
  return claims;
}

/**
 * A call's claims from its fn's templates (`FnDecl.parallelClaims`) and its args, each once, in the order declared.
 *
 * @example
 * fillClaims(['file:{args.path}'], { path: 'src/app.ts' })   // → ['file:src/app.ts']
 * fillClaims(['row:{args.ids}'], { ids: [1, 2] })            // → ['row:1', 'row:2']
 * fillClaims(['dir:{args.cwd|.}'], {})                       // → ['dir:.']
 */
export function fillClaims(templates: readonly string[], args: Json): string[] {
  return [...new Set(templates.flatMap((template) => fillClaim(template, args)))];
}
