/**
 * Runs as the chat shows them: a `RunView` is what is known of a run so far (from its stored record and the live
 * `run` events since), and everything a card, the status line or the drawer says about it is worked out here, in plain
 * words. Pure, so it is tested alone.
 */
import { SETTLED_RUN_STATUSES, type FnError, type Json, type QualifiedName, type Run, type RunId, type RunStatus, type RunUpdate } from '@harness/core';
import type { IconName, Tone } from '../../ui/index.ts';
import { clamp } from './format.ts';
import { fnLabel, lowerFirst } from './labels.ts';

/** What is known of a run: always its id, fn, status and costs; the rest once the record or an event says. */
export type RunView = Pick<Run, 'id' | 'fn' | 'status' | 'cost' | 'totalCost' | 'attempt' | 'background' | 'errors'>
  & Partial<Pick<Run, 'args' | 'outcome' | 'progress' | 'allowed' | 'startedAt' | 'endedAt' | 'parent' | 'turn' | 'kind' | 'system' | 'llmCall' | 'createdAt'>>;

/** A run known only by an event: its fn and status. */
export function emptyRun(id: RunId, fn: QualifiedName, status: RunStatus = 'queued'): RunView {
  return { id, fn, status, cost: 0, totalCost: 0, attempt: 1, background: false, errors: [] };
}

/** A view of a stored run. */
export function viewOfRun(run: Run): RunView {
  return run;
}

/** Whether a status is one a run never leaves. */
export function isSettled(status: RunStatus): boolean {
  return SETTLED_RUN_STATUSES.some((settled) => settled === status);
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
      const next: RunView = { ...open, status: update.status, attempt, ...(startedAt === undefined ? {} : { startedAt }) };
      return isSettled(update.status) ? { ...next, endedAt: endedAt ?? now } : next;
    }
    case 'progress': return { ...run, progress: update.progress };
    case 'allowed': return { ...run, allowed: update.operations };
    case 'cost': return { ...run, cost: update.cost, totalCost: update.total };
  }
}

/** Merge a fetched record with what live events said meanwhile: the record wins, except a newer live status. */
export function mergeRecord(live: RunView | undefined, record: Run): RunView {
  if (live === undefined || isSettled(record.status) || !isSettled(live.status)) { return record; }
  return { ...record, status: live.status, ...(live.endedAt === undefined ? {} : { endedAt: live.endedAt }) };
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

/** What a run is doing, in plain words: "Read file…", "Retrying read file… (attempt 2)", "Read file failed". */
export function runText(run: Pick<RunView, 'fn' | 'status' | 'attempt'>): string {
  const label = fnLabel(run.fn);
  switch (run.status) {
    case 'awaiting-approval': return `Waiting for approval to ${lowerFirst(label)}`;
    case 'queued': return `${label} · queued`;
    case 'running': return run.attempt > 1 ? `Retrying ${lowerFirst(label)}… (attempt ${run.attempt})` : `${label}…`;
    case 'waiting': return `${label} · waiting`;
    case 'paused': return `${label} · paused`;
    case 'done': return label;
    case 'failed': return `${label} failed`;
    case 'cancelled': return `${label} cancelled`;
    case 'undone': return `${label} undone`;
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

/** Which phase a run is in. */
export function phaseOf(run: Pick<RunView, 'status' | 'attempt'>): Phase {
  if (run.status === 'running' && run.attempt > 1) { return 'retry'; }
  if (isActive(run.status)) { return 'active'; }
  if (run.status === 'awaiting-approval' || run.status === 'paused') { return 'waiting'; }
  if (run.status === 'failed') { return 'failed'; }
  return 'done';
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
  /** "Thinking…", "Waiting for your approval", or empty when groups say it all. */
  readonly lead: string;
}

/** How the status line behaves: how long finished groups stay, and how many groups show. */
export interface StatusLineOptions {
  readonly linger: number;
  readonly max: number;
}

export const STATUS_LINE: StatusLineOptions = { linger: 2_500, max: 3 };

const PHASE_TONE = { active: 'accent', retry: 'warn', waiting: 'warn', failed: 'danger', done: 'ok' } as const satisfies Record<Phase, Tone>;

function groupText(fn: QualifiedName, phase: Phase, count: number, attempt: number): string {
  const label = fnLabel(fn);
  const times = count > 1 ? ` ×${count}` : '';
  switch (phase) {
    case 'active': return `${label}${times}…`;
    case 'retry': return `Retrying ${lowerFirst(label)}${times}… (attempt ${attempt})`;
    case 'waiting': return `${label}${times} · waiting for you`;
    case 'failed': return `${label}${times} failed`;
    case 'done': return `${label}${times}`;
  }
}

/**
 * Sum up a turn's runs on one line: same-fn runs grouped ("Read file ×3…"), most active first, finished groups
 * kept for `linger` ms after they end then dropped, and past `max` groups "+N more".
 */
export function statusLine(runs: readonly RunView[], now: number, options: StatusLineOptions = STATUS_LINE): StatusLine {
  const groups = new Map<string, { fn: QualifiedName; phase: Phase; count: number; attempt: number; endedAt: number }>();
  for (const run of runs) {
    const phase = phaseOf(run);
    if ((phase === 'done' || run.status === 'cancelled' || run.status === 'undone') && now - (run.endedAt ?? now) > options.linger) { continue; }
    const key = `${run.fn}:${phase}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { fn: run.fn, phase, count: 1, attempt: run.attempt, endedAt: run.endedAt ?? now });
    } else {
      group.count++;
      group.attempt = Math.max(group.attempt, run.attempt);
    }
  }
  const sorted = [...groups.entries()].sort(([, a], [, b]) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  const shown = sorted.slice(0, options.max).map(([key, group]) => ({
    key, fn: group.fn, phase: group.phase, count: group.count, text: groupText(group.fn, group.phase, group.count, group.attempt), tone: PHASE_TONE[group.phase],
  }));
  const waiting = runs.some((run) => run.status === 'awaiting-approval');
  const lead = waiting ? 'Waiting for your approval' : runs.some((run) => isActive(run.status)) ? '' : 'Thinking…';
  return { groups: shown, more: Math.max(0, sorted.length - options.max), lead };
}
