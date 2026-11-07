/**
 * What a run says it is doing, in plain words. A fn may declare status templates for four phases (active, retry,
 * done, failed), each with a form for one run and a form for a group of same-fn runs; its kind may declare defaults;
 * the hub's `DEFAULT_STATUS` is the floor. The hub resolves the text when a run changes phase and sends it with the
 * run's `status` update, so the browser never builds it.
 *
 * Tokens: `{fn}` is the fn's label in the middle of a sentence ("read file"); `{args.path.to.value}` is a value from
 * the run's args; `{output.path}` a value from its result (done only); `{n}` the group's count (`many` forms only).
 * A token may name a fallback after `|` (`{args.path|a file}`). A template whose token has no value and no fallback
 * is skipped, and the next source is tried. Every text starts with a capital letter.
 */
import { z } from 'zod';
import { fnLabel, lowerFirst, upperFirst } from './labels.ts';
import type { Json, QualifiedName } from './primitives.ts';
import type { RunStatus } from './run.ts';

/** The phases a run's status text speaks of. */
export const RUN_PHASES = ['active', 'retry', 'done', 'failed'] as const;
export const RunPhase = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof RunPhase>;

/** One phase's words: `one` for a single run ("Reading {args.path}…"), `many` for a group ("Reading {n} files…"). */
export const StatusForms = z.object({ one: z.string().min(1), many: z.string().min(1) });
export type StatusForms = z.infer<typeof StatusForms>;

/** A fn's (or a kind's) status templates, one per phase. */
export const StatusTemplates = z.object({ active: StatusForms, retry: StatusForms, done: StatusForms, failed: StatusForms });
export type StatusTemplates = z.infer<typeof StatusTemplates>;

/** A run's resolved status text: its phase, its own words, and the group form with `{n}` left for the count. */
export const RunText = z.object({ phase: RunPhase, one: z.string(), many: z.string() });
export type RunText = z.infer<typeof RunText>;

/** The words every fn falls back to. They use only `{fn}` and `{n}`, so they always resolve. */
export const DEFAULT_STATUS = {
  active: { one: '{fn}…', many: '{fn} ×{n}…' },
  retry: { one: 'Retrying {fn}…', many: 'Retrying {fn} ×{n}…' },
  done: { one: '{fn} done', many: '{fn} ×{n} done' },
  failed: { one: '{fn} failed', many: '{fn} ×{n} failed' },
} as const satisfies StatusTemplates;

/** The statuses whose words are the chat's own: a run waiting on a person, or one that was stopped or taken back. */
export type UnphasedRunStatus = 'awaiting-approval' | 'paused' | 'cancelled' | 'undone';
/** The statuses a run's own status words speak of. */
export type PhasedRunStatus = Exclude<RunStatus, UnphasedRunStatus>;

/** The phase a run is in, or undefined for statuses whose words are the chat's own (approval, paused, cancelled, undone). */
export function phaseOf(status: PhasedRunStatus, attempt: number): RunPhase;
export function phaseOf(status: RunStatus, attempt: number): RunPhase | undefined;
export function phaseOf(status: RunStatus, attempt: number): RunPhase | undefined {
  switch (status) {
    case 'queued': case 'running': case 'waiting': return attempt > 1 ? 'retry' : 'active';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'awaiting-approval': case 'paused': case 'cancelled': case 'undone': return undefined;
  }
}

/** What a template is filled from. `output` is the run's result, once it is done. */
export interface StatusValues {
  readonly fn: QualifiedName;
  readonly args: Json;
  readonly output?: Json;
}

/** How long a value may run in a status line, and how many list items it names before "and N more". */
const MAX_VALUE = 60;
const MAX_ITEMS = 3;

const TOKEN = /\{([^{}|]+)(?:\|([^{}]*))?\}/g;

/**
 * Resolve a run's status text for a phase from the first source whose tokens all have values. `sources` run from
 * most specific (the fn's) to least (its kind's); `DEFAULT_STATUS` is used when none resolves.
 */
export function resolveStatus(sources: ReadonlyArray<StatusTemplates | undefined>, phase: RunPhase, values: StatusValues): RunText {
  for (const source of sources) {
    if (source === undefined) { continue; }
    const one = fill(source[phase].one, values, false);
    const many = fill(source[phase].many, values, true);
    if (one !== undefined && many !== undefined) { return { phase, one, many }; }
  }
  // The defaults use only `{fn}` and `{n}`, which always fill.
  const floor = DEFAULT_STATUS[phase];
  return { phase, one: fill(floor.one, values, false) ?? floor.one, many: fill(floor.many, values, true) ?? floor.many };
}

/** A group's words for `count` runs: the `many` form with its count, or the `one` form for a single run. */
export function countedText(text: Pick<RunText, 'one' | 'many'>, count: number): string {
  return count === 1 ? text.one : text.many.replaceAll('{n}', String(count));
}

/** A template filled in, or undefined when a token has no value. `{n}` stays for the count in `many` forms. */
function fill(template: string, values: StatusValues, many: boolean): string | undefined {
  const missing: string[] = [];
  const text = template.replace(TOKEN, (whole, token: string, fallback: string | undefined) => {
    const value = tokenValue(token.trim(), values, many);
    if (value !== undefined) { return value; }
    if (fallback !== undefined) { return fallback; }
    missing.push(token);
    return whole;
  });
  // a clipped value ending a template that ends in `…` would read `……`
  return missing.length > 0 ? undefined : upperFirst(text.replace(/…{2,}/g, '…'));
}

function tokenValue(token: string, values: StatusValues, many: boolean): string | undefined {
  if (token === 'fn') { return lowerFirst(fnLabel(values.fn)); }
  if (token === 'n') { return many ? '{n}' : undefined; }
  const [root, ...path] = token.split('.');
  const base = root === 'args' ? values.args : root === 'output' ? values.output : undefined;
  return base === undefined ? undefined : spoken(at(base, path));
}

/** The value at a dotted path (array indices too), or undefined. A plain key walk: nothing is evaluated. */
function at(value: Json, path: readonly string[]): Json | undefined {
  let current: Json | undefined = value;
  for (const key of path) {
    if (current === undefined || current === null || typeof current !== 'object') { return undefined; }
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

/**
 * A value as a status line says it: short text clipped to a line, an object by its `title`, `name` or `id`, a list
 * as one English list naming a few items and counting the rest. Undefined when there is nothing to say.
 */
function spoken(value: Json | undefined): string | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value === 'string') { return value === '' ? undefined : clip(value); }
  if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
  if (Array.isArray(value)) {
    const items = value.map(spoken).filter((item) => item !== undefined);
    if (items.length === 0) { return undefined; }
    const named = items.slice(0, MAX_ITEMS);
    const rest = items.length - named.length;
    return englishList(rest > 0 ? [...named, `${rest} more`] : named);
  }
  for (const key of ['title', 'name', 'id']) {
    const field = value[key];
    if (typeof field === 'string' && field !== '') { return clip(field); }
  }
  return undefined;
}

function englishList(items: readonly string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

function clip(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > MAX_VALUE ? `${line.slice(0, MAX_VALUE - 1)}…` : line;
}
