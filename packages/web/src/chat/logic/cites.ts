/**
 * Citations in the chat ("Use citations"): each cite of an answer is a `[n]` chip whose popover shows the model's
 * reason, the value it cites in readable form, and a way to the run's card. What a chip shows is worked out here: the
 * cite's state (still streaming, resolved, or not), and the value at its path (kept on the message when small, else
 * read from the run's result the thread holds).
 */
import { valueAt, type Citation, type Json, type StreamedCite } from '@harness/core';
import { humanize } from './labels.ts';
import { runResult, type RunView } from './runs.ts';

/** A cite as the chat holds it: settled with its message, or streamed in and not yet resolved. */
export type ChatCite = Citation | StreamedCite;

/** Whether a cite is a settled message's (resolved or not), not one still streaming. */
export function isSettledCite(cite: ChatCite): cite is Citation {
  return 'run' in cite || 'problem' in cite;
}

/** What a cite's chip shows: still checked, the value it cites, a value too large to keep that isn't loaded, or why it doesn't resolve. */
export type CiteState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly value: Json }
  | { readonly kind: 'unloaded' }
  | { readonly kind: 'problem'; readonly problem: string };

/** A cite's state, the run it cites read from the thread when its value wasn't kept. */
export function citeState(cite: ChatCite, run: RunView | undefined): CiteState {
  if (!isSettledCite(cite)) { return { kind: 'pending' }; }
  if (cite.problem !== undefined) { return { kind: 'problem', problem: cite.problem }; }
  if (cite.value !== undefined) { return { kind: 'value', value: cite.value }; }
  const result = run === undefined ? undefined : runResult(run);
  const found = result === undefined ? undefined : valueAt(result, cite.path);
  return found === undefined ? { kind: 'unloaded' } : { kind: 'value', value: found.value };
}

/** A cite's chip label: `[n]`. */
export function citeLabel(cite: Pick<ChatCite, 'number'>): string {
  return `[${cite.number}]`;
}

/** The chip's accessible name: its number, and whether it doesn't resolve. */
export function citeAria(cite: ChatCite): string {
  const problem = isSettledCite(cite) && cite.problem !== undefined;
  return `Citation ${cite.number}${problem ? ', not found' : ''}`;
}

/** The path a cite names, for people: "the whole result" for ''. */
export function pathLabel(path: string): string {
  return path.trim() === '' || path.trim() === '$' ? 'the whole result' : path;
}

/** A value in readable form: one line of text, a list of fields, a list of items, or JSON when it is deep. */
export type ReadableValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fields'; readonly fields: ReadonlyArray<{ readonly key: string; readonly label: string; readonly text: string; readonly long: boolean }> }
  | { readonly kind: 'items'; readonly items: readonly string[] }
  | { readonly kind: 'json'; readonly json: string };

/** The longest a field's text runs on one line before it is shown as a block. */
const LINE = 80;

/** A value as one line of text (JSON for objects and lists). */
function brief(value: Json): string {
  if (typeof value === 'string') { return value; }
  if (value === null) { return '—'; }
  if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
  if (typeof value === 'number') { return String(value); }
  return JSON.stringify(value);
}

/** Whether a value is a plain one (text, a number, yes or no, nothing). */
const isPlain = (value: Json): boolean => value === null || typeof value !== 'object';

/** A cited value for people: plain values as text, an object as its fields, a list of plain values as items, the rest as JSON. */
export function readableValue(value: Json): ReadableValue {
  if (value === null || typeof value !== 'object') { return { kind: 'text', text: brief(value) }; }
  if (Array.isArray(value)) {
    return value.every(isPlain) ? { kind: 'items', items: value.map(brief) } : { kind: 'json', json: JSON.stringify(value, null, 2) };
  }
  const entries = Object.entries(value);
  return {
    kind: 'fields',
    fields: entries.map(([key, v]) => {
      const text = isPlain(v) ? brief(v) : JSON.stringify(v, null, 2);
      return { key, label: humanize(key), text, long: !isPlain(v) || text.length > LINE || text.includes('\n') };
    }),
  };
}

/** The cites across an answer's messages, in order: where a message's markers find theirs by index. */
export function citesByIndex(cites: readonly ChatCite[]): ReadonlyMap<number, ChatCite> {
  return new Map(cites.map((cite) => [cite.index, cite]));
}

/** Whether an answer says "No citations": it was answered with citations on, settled well, and cites nothing. */
export function citesNothing(messages: ReadonlyArray<{ readonly status: string; readonly citations?: readonly Citation[] | undefined }>): boolean {
  const cited = messages.filter((m) => m.citations !== undefined);
  return cited.length > 0 && messages.every((m) => m.status === 'done') && cited.every((m) => m.citations?.length === 0);
}
