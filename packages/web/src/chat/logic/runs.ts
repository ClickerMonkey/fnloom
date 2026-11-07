/**
 * Runs as the chat shows them: a `RunView` is what is known of a run so far (from its stored record and the live
 * `run` events since), and everything a card, the status line or the drawer says about it is worked out here, in plain
 * words. Pure, so it is tested alone.
 */
import {
  countedText, isSettled, phaseOf as runPhase, resolveStatus, type FnError, type Json, type PhasedRunStatus, type QualifiedName, type Run, type RunId,
  type RunStatus, type RunText, type RunUpdate,
} from '@harness/core';
import { hub } from '@harness/sdk';
import type { IconName, Tone } from '../../ui/index.ts';
import { clamp } from './format.ts';
import { fnLabel, lowerFirst } from './labels.ts';

/**
 * What is known of a run: always its id, fn, status and costs; the rest once the record or an event says. `asking` is
 * the chat's own: the run is blocked on the person's answer to one of its handlers (a confirm, a question), so it says
 * so instead of looking busy.
 */
export type RunView = Pick<Run, 'id' | 'fn' | 'status' | 'cost' | 'totalCost' | 'attempt' | 'background' | 'errors'>
  & Partial<Pick<Run, 'args' | 'outcome' | 'progress' | 'allowed' | 'startedAt' | 'endedAt' | 'parent' | 'turn' | 'kind' | 'system' | 'llmCall' | 'createdAt' | 'text'>>
  & { readonly asking?: boolean };

/** The words of a run waiting on the person's answer. */
export const ASKING_TEXT = 'Waiting for your answer';

/** The status a run shows as: `waiting` while it waits on the person's answer, else its own. */
export function shownStatus(run: Pick<RunView, 'status' | 'asking'>): RunStatus {
  return run.asking === true && !isSettled(run.status) ? 'waiting' : run.status;
}

/** Whether a run is busy now: active, and not blocked on the person. */
export function isBusy(run: Pick<RunView, 'status' | 'asking'>): boolean {
  return isActive(run.status) && run.asking !== true;
}

/** A run known only by an event: its fn and status. */
export function emptyRun(id: RunId, fn: QualifiedName, status: RunStatus = 'queued'): RunView {
  return { id, fn, status, cost: 0, totalCost: 0, attempt: 1, background: false, errors: [] };
}

/** Whether a run is doing something now (not waiting on a person, not settled). */
export function isActive(status: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}

/** Apply a live update. `now` stamps when it started and ended, as this browser saw it, until the record says. */
export function applyRunUpdate(run: RunView, update: RunUpdate, now: number): RunView {
  switch (update.type) {
    case 'status': {
      const { endedAt, ...open } = run;
      const startedAt = run.startedAt ?? (update.status === 'running' ? now : undefined);
      const attempt = update.status === 'running' && isSettled(run.status) ? run.attempt + 1 : run.attempt;
      const next: RunView = { ...open, status: update.status, attempt, ...(startedAt === undefined ? {} : { startedAt }), ...(update.text === undefined ? {} : { text: update.text }) };
      return isSettled(update.status) ? { ...next, endedAt: endedAt ?? now } : next;
    }
    case 'progress': return { ...run, progress: update.progress };
    case 'allowed': return { ...run, allowed: update.operations };
    case 'cost': return { ...run, cost: update.cost, totalCost: update.total };
    case 'background': return { ...run, background: true };
  }
}

/** Merge a fetched record with what live events said meanwhile: the record wins, except a newer live status. */
export function mergeRecord(live: RunView | undefined, record: Run): RunView {
  if (live === undefined || isSettled(record.status) || !isSettled(live.status)) { return record; }
  return { ...record, status: live.status, ...(live.endedAt === undefined ? {} : { endedAt: live.endedAt }), ...(live.text === undefined ? {} : { text: live.text }) };
}

/** How a status looks: its tone, icon and word. */
export const STATUS_LOOK = {
  'awaiting-approval': { tone: 'warn', icon: 'shield', word: 'Needs approval' },
  queued: { tone: 'neutral', icon: 'clock', word: 'Queued' },
  running: { tone: 'accent', icon: 'dot', word: 'Running' },
  waiting: { tone: 'warn', icon: 'clock', word: 'Waiting' },
  paused: { tone: 'neutral', icon: 'clock', word: 'Paused' },
  done: { tone: 'ok', icon: 'success', word: 'Done' },
  failed: { tone: 'danger', icon: 'error', word: 'Failed' },
  cancelled: { tone: 'neutral', icon: 'x', word: 'Cancelled' },
  undone: { tone: 'neutral', icon: 'refresh', word: 'Undone' },
} as const satisfies Record<RunStatus, { tone: Tone; icon: IconName; word: string }>;

/** The keys whose value best says what a run is about, most telling first. */
const TELLING_KEYS = ['path', 'file', 'uri', 'query', 'command', 'url', 'name', 'title', 'text', 'pattern', 'message'] as const;

/** A one-line summary of a run's args: the most telling value ("harness.md"), clamped. Empty when there are none. */
export function argSummary(args: Json | undefined, max = 60): string {
  if (args === undefined || args === null) { return ''; }
  if (typeof args === 'string') { return clamp(args, max); }
  if (typeof args === 'number' || typeof args === 'boolean') { return String(args); }
  if (Array.isArray(args)) { return args.length === 0 ? '' : `${args.length} item${args.length === 1 ? '' : 's'}`; }
  const entries = Object.entries(args);
  const telling = TELLING_KEYS.map((key) => args[key]).find((value) => typeof value === 'string' && value !== '');
  if (typeof telling === 'string') { return clamp(telling, max); }
  for (const [key, value] of entries) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return clamp(`${key}: ${String(value)}`, max); }
  }
  return '';
}

/** The error a run ended with, if it failed: its outcome's, or its last attempt's. */
export function runError(run: RunView): FnError | undefined {
  if (run.outcome?.status === 'failed') { return run.outcome.error; }
  return run.status === 'failed' ? run.errors.at(-1)?.error : undefined;
}

/** The result of a run that is done. */
export function runResult(run: RunView): Json | undefined {
  return run.outcome?.status === 'done' ? run.outcome.result : undefined;
}

/**
 * A result in brief, as a run card without a renderer shows it: text as text, an object that carries its text in a
 * `text` field or in its only field (a file read) as that text, anything else as indented JSON.
 */
export function resultBrief(value: Json | undefined): string {
  if (value === undefined || value === null) { return ''; }
  if (typeof value === 'string') { return value; }
  if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
  if (!Array.isArray(value)) {
    const text = value['text'];
    if (typeof text === 'string') { return text; }
    const fields = Object.values(value);
    const only = fields[0];
    if (fields.length === 1 && typeof only === 'string') { return only; }
  }
  return JSON.stringify(value, null, 2);
}

/**
 * A run's status words for its phase: what the hub sent (from the fn's status templates), or, before the hub has
 * said, core's defaults for the same phase. Statuses without a phase are worded by `runText`.
 */
export function runWords(run: Pick<RunView, 'fn' | 'attempt' | 'args' | 'text'> & { readonly status: PhasedRunStatus }): RunText {
  const phase = runPhase(run.status, run.attempt);
  return run.text?.phase === phase ? run.text : resolveStatus([], phase, { fn: run.fn, args: run.args ?? null });
}

/**
 * What a run is doing, in plain words: its fn's words for its phase ("Reading harness.md…", "Read harness.md",
 * "Retrying harness.md…", "Reading harness.md failed"), or the chat's own while it waits on a person or after it was
 * stopped or taken back.
 */
export function runText(run: Pick<RunView, 'fn' | 'status' | 'attempt' | 'args' | 'text' | 'asking'>): string {
  const label = fnLabel(run.fn);
  if (run.asking === true && !isSettled(run.status)) { return ASKING_TEXT; }
  switch (run.status) {
    case 'awaiting-approval': return `Waiting for approval to ${lowerFirst(label)}`;
    case 'paused': return `${label} · paused`;
    case 'cancelled': return `${label} cancelled`;
    case 'undone': return `${label} undone`;
    case 'queued': case 'running': case 'waiting': case 'done': case 'failed': return runWords({ ...run, status: run.status }).one;
  }
}

/** How long a run has taken: until it ended, or until `now` while it runs. Undefined before it starts. */
export function runElapsed(run: Pick<RunView, 'startedAt' | 'endedAt'>, now: number): number | undefined {
  if (run.startedAt === undefined) { return undefined; }
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

/** Progress as a fraction (0 to 1), for a bar: linear progress as given; steps as the share done. */
export function progressFraction(run: Pick<RunView, 'progress'>): number | undefined {
  const progress = run.progress;
  if (progress === undefined) { return undefined; }
  if ('fraction' in progress) { return progress.fraction; }
  const steps = Object.values(progress.steps);
  if (steps.length === 0) { return undefined; }
  return steps.filter((step) => step.status === 'done' || step.status === 'skipped').length / steps.length;
}

/** The phases the status line sorts by: what is happening first. */
export const PHASES = ['active', 'retry', 'waiting', 'failed', 'done'] as const;
export type Phase = (typeof PHASES)[number];

/** Which phase a run is in on the status line: its own, `waiting` while it waits on a person, `done` once stopped. */
export function phaseOf(run: Pick<RunView, 'status' | 'attempt' | 'asking'>): Phase {
  if (run.asking === true && !isSettled(run.status)) { return 'waiting'; }
  switch (run.status) {
    case 'awaiting-approval': case 'paused': return 'waiting';
    case 'cancelled': case 'undone': return 'done';
    case 'queued': case 'running': case 'waiting': case 'done': case 'failed': return runPhase(run.status, run.attempt);
  }
}

/** One group on the status line: runs of one fn in one phase. */
export interface StatusGroup {
  readonly key: string;
  readonly fn: QualifiedName;
  readonly phase: Phase;
  readonly count: number;
  readonly text: string;
  readonly tone: Tone;
}

/** The status line under an answer: the groups to show, how many more, and the words when no run reports. */
export interface StatusLine {
  readonly groups: readonly StatusGroup[];
  readonly more: number;
  /** "Thinking…", "Waiting for your approval", "Paused", or empty when groups say it all. */
  readonly lead: string;
}

/** How the status line behaves: how long finished groups stay, and how many groups show. */
export interface StatusLineOptions {
  readonly linger: number;
  readonly max: number;
}

export const STATUS_LINE: StatusLineOptions = { linger: 2_500, max: 3 };

const PHASE_TONE = { active: 'accent', retry: 'warn', waiting: 'warn', failed: 'danger', done: 'ok' } as const satisfies Record<Phase, Tone>;

/** The lead while nothing but the agent itself is working. */
export const THINKING = 'Thinking…';

/**
 * Whether a run is the turn's own agent: the line's lead ("Thinking…") speaks for it, never its label. Known by its
 * kind once its record arrives, and before that by being the session's agent fn with no parent.
 */
function isTurnAgent(run: Pick<RunView, 'parent' | 'kind' | 'fn'>, agent: QualifiedName | undefined): boolean {
  return run.parent === undefined && (run.kind === hub.kinds.llm.name || (run.kind === undefined && run.fn === agent));
}

/** Whether a status line says more than that the agent is thinking: worth showing beside (or instead of) typing dots. */
export function lineHasNews(line: StatusLine): boolean {
  return line.groups.length > 0 || line.more > 0 || (line.lead !== '' && line.lead !== THINKING);
}

/** A group's words: its runs' status words, the `many` form with the count when there is more than one. */
function groupText(first: RunView, count: number): string {
  switch (first.status) {
    case 'awaiting-approval': case 'paused': case 'cancelled': case 'undone': return runText(first);
    case 'queued': case 'running': case 'waiting': case 'done': case 'failed': return countedText(runWords({ ...first, status: first.status }), count);
  }
}

/**
 * Sum up a turn's runs on one line: same-fn runs grouped in their fn's words ("Reading 3 files…"), most active first,
 * finished groups kept for `linger` ms after they end then dropped, and past `max` groups "+N more". Runs waiting on a
 * person are not grouped: their cards already say so, and the lead says "Waiting for your approval". The turn's own
 * agent is the lead too.
 */
export function statusLine(runs: readonly RunView[], now: number, options: StatusLineOptions = STATUS_LINE, agent?: QualifiedName): StatusLine {
  const groups = new Map<string, { first: RunView; phase: Phase; count: number }>();
  for (const run of runs) {
    const phase = phaseOf(run);
    if (phase === 'waiting' || isTurnAgent(run, agent)) { continue; }
    if (phase === 'done' && now - (run.endedAt ?? now) > options.linger) { continue; }
    const key = `${run.fn}:${phase}`;
    const group = groups.get(key);
    if (group === undefined) { groups.set(key, { first: run, phase, count: 1 }); } else { group.count++; }
  }
  const sorted = [...groups.entries()].sort(([, a], [, b]) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  const shown = sorted.slice(0, options.max).map(([key, group]) => ({
    key, fn: group.first.fn, phase: group.phase, count: group.count, text: groupText(group.first, group.count), tone: PHASE_TONE[group.phase],
  }));
  const working = runs.some((run) => isBusy(run) && !isTurnAgent(run, agent));
  const lead = runs.some((run) => run.status === 'awaiting-approval') ? 'Waiting for your approval'
    : runs.some((run) => run.asking === true && !isSettled(run.status)) ? ASKING_TEXT
    : runs.some((run) => run.status === 'paused') ? 'Paused'
    : working ? '' : THINKING;
  return { groups: shown, more: Math.max(0, sorted.length - options.max), lead };
}
