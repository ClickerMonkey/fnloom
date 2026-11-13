/**
 * Turning failures into plain words for people: a failed call into one sentence, and a schema's issues into one
 * message per form field.
 */
import { ApiError } from '@ayepi/core/client';
import { z } from 'zod';

const BY_STATUS: Readonly<Record<number, string>> = {
  0: "Can't reach the hub. Check the connection and try again.",
  401: 'Your sign-in has ended. Sign in again.',
  403: "You don't have access to that.",
  404: "That isn't there any more.",
  409: 'That changed while you were working. Reload and try again.',
  429: 'Too many tries. Wait a moment and try again.',
};

/** Whether a call failed only because a newer one superseded it, or it was cancelled (a caller's `lastOnly` or `cancel`). */
export function isSuperseded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** The refusals whose message the hub writes for people (`reject(403, 'NOT_A_MEMORY', '… only memories can be forgotten')`). */
const SAYS_WHY = new Set([403, 404, 409]);

/** A message as a sentence: a plain first word capitalised (a name such as `fs/guide` kept as it is), a full stop at the end. */
function sentence(message: string): string {
  const text = message.trim();
  const capital = /^[a-z]+(\s|$)/.test(text) ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * One sentence for a failed call. A declared error's `reason` wins over the status's default, and so does the hub's
 * own message on a refusal (403, 404, 409) that has one besides its code.
 */
export function problemText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (error instanceof ApiError) {
    const reason = z.object({ reason: z.string() }).safeParse(error.data);
    if (reason.success) { return reason.data.reason; }
    if (SAYS_WHY.has(error.status) && error.message.trim() !== '' && error.message !== error.code) { return sentence(error.message); }
    return BY_STATUS[error.status] ?? (error.status >= 500 ? 'The hub had a problem. Try again in a moment.' : fallback);
  }
  if (isSuperseded(error)) { return 'Cancelled.'; }
  return fallback;
}

/** Plain words for one schema issue. */
function issueText(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_small': return issue.origin === 'string' ? (Number(issue.minimum) <= 1 ? 'Required.' : `At least ${Number(issue.minimum)} characters.`) : `At least ${Number(issue.minimum)}.`;
    case 'too_big': return issue.origin === 'string' ? `At most ${Number(issue.maximum)} characters.` : `At most ${Number(issue.maximum)}.`;
    case 'invalid_format': return issue.format === 'email' ? 'Enter an email address.' : issue.format === 'url' ? 'Enter a web address.' : 'Check the format.';
    case 'invalid_type': return 'Required.';
    case 'invalid_value': case 'invalid_union': case 'invalid_key': case 'invalid_element': case 'not_multiple_of':
    case 'unrecognized_keys': case 'custom':
      return 'Check this value.';
  }
}

/** The fields of a form and their messages: one per field, the first issue found. */
export type FieldProblems<K extends string> = Partial<Record<K, string>>;

/** Check a form against a schema; returns the parsed value or a message per field. */
export function checkForm<S extends z.ZodObject>(schema: S, input: unknown): { ok: true; value: z.output<S> } | { ok: false; problems: FieldProblems<keyof z.output<S> & string> } {
  const parsed = schema.safeParse(input);
  if (parsed.success) { return { ok: true, value: parsed.data }; }
  const problems: Partial<Record<string, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && problems[field] === undefined) { problems[field] = issueText(issue); }
  }
  return { ok: false, problems };
}

/** A form's messages by the dot path of the field each is about (`transport.url`): one per path, the first issue found. */
export type PathProblems = Readonly<Record<string, string>>;

/** Check a nested form against a schema; returns the parsed value or a message per field path. */
export function checkPaths<S extends z.ZodType>(schema: S, input: unknown): { ok: true; value: z.output<S> } | { ok: false; problems: PathProblems } {
  const parsed = schema.safeParse(input);
  if (parsed.success) { return { ok: true, value: parsed.data }; }
  const problems: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.filter((part) => typeof part === 'string' || typeof part === 'number').join('.');
    problems[path] ??= issueText(issue);
  }
  return { ok: false, problems };
}
