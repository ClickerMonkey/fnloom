/**
 * Problems a caller can fix (a wrong path, text that isn't there). Server code throws `FsProblem`; the fn layer turns
 * it into a `caller` failure with its code, so the LLM sees a message it can act on.
 */

/** Every problem code, so callers and tests can rely on them. */
export const PROBLEM_CODES = [
  'no-roots', 'outside', 'read-only', 'not-found', 'not-a-file', 'not-a-folder', 'binary', 'too-large',
  'no-match', 'ambiguous', 'bad-pattern', 'denied', 'needs-confirmation', 'timeout',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** A problem with what a fn was asked to do. */
export class FsProblem extends Error {
  override readonly name = 'FsProblem';
  readonly code: ProblemCode;
  constructor(code: ProblemCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** True for a Node error with this `code` (`ENOENT`, `EISDIR`). */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
