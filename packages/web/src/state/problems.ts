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

/** One sentence for a failed call. A declared error's `reason` wins over the status's default. */
export function problemText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (error instanceof ApiError) {
    const reason = z.object({ reason: z.string() }).safeParse(error.data);
    if (reason.success) { return reason.data.reason; }
    return BY_STATUS[error.status] ?? (error.status >= 500 ? 'The hub had a problem. Try again in a moment.' : fallback);
  }
  if (error instanceof DOMException && error.name === 'AbortError') { return 'Cancelled.'; }
  return fallback;
}

/** Plain words for one schema issue. */
function issueText(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_small': return issue.origin === 'string' ? (Number(issue.minimum) <= 1 ? 'Required.' : `At least ${Number(issue.minimum)} characters.`) : `At least ${Number(issue.minimum)}.`;
    case 'too_big': return issue.origin === 'string' ? `At most ${Number(issue.maximum)} characters.` : `At most ${Number(issue.maximum)}.`;
    case 'invalid_format': return issue.format === 'email' ? 'Enter an email address.' : issue.format === 'url' ? 'Enter a web address.' : 'Check the format.';
    case 'invalid_type': return 'Required.';
    default: return 'Check this value.';
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
