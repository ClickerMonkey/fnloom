/**
 * Runs as the chat shows them: a `RunView` is what is known of a run so far (from its stored record and the live
 * `run` events since), and everything a card, the status line or the drawer says about it is worked out here, in plain
 * words. Pure, so it is tested alone.
 */
import {
  argSummary, countedText, isSettled, problemLine, type Display, phaseOf as runPhase, resolveStatus, RUN_PHASES, RUN_STATUS_WORDS, type FnError, type InputProblemSource, type InvalidInput, type Json, type PhasedRunStatus, type QualifiedName, type Run, type RunId,
  type RunPhase, type RunStatus, type RunText, type RunUpdate,
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
  & Partial<Pick<Run, 'args' | 'outcome' | 'progress' | 'allowed' | 'startedAt' | 'endedAt' | 'parent' | 'turn' | 'kind' | 'system' | 'instance' | 'llmCall' | 'createdAt' | 'text'>>
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

/**
 * Whether each status means the run is doing something now: not settled, and not held for a person (an approval, a
 * pause). Every status must be classed, so a new one fails to compile until it is.
 */
const ACTIVE_BY_STATUS = {
  'awaiting-approval': false, queued: true, running: true, waiting: true, paused: false,
  done: false, 'invalid-input': false, failed: false, cancelled: false, undone: false,
} as const satisfies Record<RunStatus, boolean>;

/** Whether a run is doing something now (not waiting on a person, not settled). */
export function isActive(status: RunStatus): boolean {
  return ACTIVE_BY_STATUS[status];
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

/**
 * A run as an open drawer shows it: the record it fetched, with what the thread has heard live since laid over it
 * (status, progress, cost, timing, words) while the record is not settled, so the drawer moves with the card. A settled
 * record already holds everything, so it stands as it is.
 */
export function drawerRun(live: RunView | undefined, record: Run | undefined): RunView | undefined {
  if (record === undefined) { return live; }
  if (live === undefined || isSettled(record.status)) { return record; }
  return { ...record, ...live };
}

/** Whether an open drawer's record is behind its run: the thread heard it settle, but the record was fetched before. */
export function recordIsBehind(live: Pick<RunView, 'id' | 'status'> | undefined, record: Pick<Run, 'id' | 'status'> | undefined): boolean {
  return live !== undefined && record !== undefined && live.id === record.id && isSettled(live.status) && !isSettled(record.status);
}

/** How a status looks: its tone and icon, and its word from core's `RUN_STATUS_WORDS`. */
export const STATUS_LOOK = {
  'awaiting-approval': { tone: 'warn', icon: 'shield', word: RUN_STATUS_WORDS['awaiting-approval'] },
  queued: { tone: 'neutral', icon: 'clock', word: RUN_STATUS_WORDS.queued },
  running: { tone: 'accent', icon: 'dot', word: RUN_STATUS_WORDS.running },
  waiting: { tone: 'warn', icon: 'clock', word: RUN_STATUS_WORDS.waiting },
  paused: { tone: 'neutral', icon: 'clock', word: RUN_STATUS_WORDS.paused },
  done: { tone: 'ok', icon: 'success', word: RUN_STATUS_WORDS.done },
  // refused input is retried by the agent: shown softly, never as a failure
  'invalid-input': { tone: 'neutral', icon: 'refresh', word: RUN_STATUS_WORDS['invalid-input'] },
  failed: { tone: 'danger', icon: 'error', word: RUN_STATUS_WORDS.failed },
  cancelled: { tone: 'neutral', icon: 'x', word: RUN_STATUS_WORDS.cancelled },
  undone: { tone: 'neutral', icon: 'refresh', word: RUN_STATUS_WORDS.undone },
} as const satisfies Record<RunStatus, { tone: Tone; icon: IconName; word: string }>;

/** A one-line summary of a run's args (core's, shared with the hub's notifications). */
export { argSummary };

/** The error a run ended with, if it failed: its outcome's, or its last attempt's. */
export function runError(run: RunView): FnError | undefined {
  if (run.outcome?.status === 'failed') { return run.outcome.error; }
  return run.status === 'failed' ? run.errors.at(-1)?.error : undefined;
}

/** Why a run's input was refused, when it was: the agent retries it, so it is never shown as a failure. */
export function runInvalid(run: Pick<RunView, 'outcome'>): InvalidInput | undefined {
  return run.outcome?.status === 'invalid-input' ? run.outcome.invalid : undefined;
}

/** What each kind of refused input was, in plain words. */
export const INPUT_PROBLEM_WORDS = {
  json: 'The input wasn’t valid JSON',
  schema: 'The input didn’t fit the fn’s args',
  validation: 'The fn’s own checks refused the input',
} as const satisfies Record<InputProblemSource, string>;

/** A refused input in one line: what was wrong and its first problem ("The input didn’t fit the fn’s args: path: required"). */
export function invalidLine(invalid: InvalidInput): string {
  const [first, ...rest] = invalid.problems;
  if (first === undefined) { return INPUT_PROBLEM_WORDS[invalid.source]; }
  return `${INPUT_PROBLEM_WORDS[invalid.source]}: ${problemLine(first)}${rest.length > 0 ? ` (+${rest.length} more)` : ''}`;
}

/**
 * How a run shows in the thread now: its card while it runs or when it failed (so the failure stays in view), and once
 * it is done (or stopped) as its fn's `display` says: its card, a line of text, or nothing.
 */
export function runShows(run: Pick<RunView, 'status'>, display: Display): Display {
  return !isSettled(run.status) || run.status === 'failed' ? 'card' : display;
}

/**
 * The line a run shown as a message reads: its status words, then its result when it is short text, or how many it
 * found when it is a list ("Search fns done: 4 found"). Anything else stays in the run's details.
 */
export function runMessage(run: RunView, max = 120): string {
  const text = runText(run);
  const result = runResult(run);
  if (Array.isArray(result)) { return `${text}: ${result.length} found`; }
  const brief = typeof result === 'string' ? clamp(result, max) : '';
  return brief === '' ? text : `${text}: ${brief}`;
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

/** A run whose input was refused, once it is over: settled words, not the retry phase's progress words. */
export const INVALID_TEXT = 'Sent back for the agent to fix its call';

/**
 * What a run is doing, in plain words: its fn's words for its phase ("Reading harness.md…", "Read harness.md",
 * "Retrying harness.md…", "Reading harness.md failed"), or the chat's own while it waits on a person, after it was
 * stopped or taken back, or once its input was refused and sent back for the agent to fix (`INVALID_TEXT`).
 */
export function runText(run: Pick<RunView, 'fn' | 'status' | 'attempt' | 'args' | 'text' | 'asking'>): string {
  const label = fnLabel(run.fn);
  if (run.asking === true && !isSettled(run.status)) { return ASKING_TEXT; }
  switch (run.status) {
    case 'awaiting-approval': return `Waiting for approval to ${lowerFirst(label)}`;
    case 'paused': return `${label} · paused`;
    case 'cancelled': return `${label} cancelled`;
    case 'undone': return `${label} undone`;
    case 'invalid-input': return INVALID_TEXT;
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

/** A phase on the status line: core's run phases, plus `waiting` for runs held for a person. */
export type Phase = RunPhase | 'waiting';

/** Where each phase sorts on the status line: what is happening first. Every phase must be placed. */
const PHASE_ORDER = { active: 0, retry: 1, waiting: 2, failed: 3, done: 4 } as const satisfies Record<Phase, number>;

/** The phases the status line sorts by, built from core's `RUN_PHASES`: what is happening first. */
export const PHASES: readonly Phase[] = [...RUN_PHASES, 'waiting' as const].sort((a, b) => PHASE_ORDER[a] - PHASE_ORDER[b]);

/** Which phase a run is in on the status line: its own, `waiting` while it waits on a person, `done` once stopped. */
export function phaseOf(run: Pick<RunView, 'status' | 'attempt' | 'asking'>): Phase {
  if (run.asking === true && !isSettled(run.status)) { return 'waiting'; }
  switch (run.status) {
    case 'awaiting-approval': case 'paused': return 'waiting';
    case 'cancelled': case 'undone': return 'done';
    case 'queued': case 'running': case 'waiting': case 'done': case 'invalid-input': case 'failed': return runPhase(run.status, run.attempt);
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
    case 'queued': case 'running': case 'waiting': case 'done': case 'invalid-input': case 'failed': return countedText(runWords({ ...first, status: first.status }), count);
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
  const sorted = [...groups.entries()].sort(([, a], [, b]) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]);
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
