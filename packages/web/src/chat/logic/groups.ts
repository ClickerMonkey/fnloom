/**
 * Fn calls in a row, collapsed into one section (the chat's "Group fn calls" option, on by default): its summary
 * condenses the calls of each fn into one entry with a count, the fn called most recently first, and its status is the
 * one that matters most now. A group stays open by itself while one of its runs is going or needs the person (an
 * approval, a question).
 * Pure, so it is tested alone.
 */
import { isSettled, type QualifiedName, type RunStatus } from '@harness/core';
import { fnLabel } from './labels.ts';
import { shownStatus, type RunView } from './runs.ts';

/** The fewest calls in a row that collapse into a group; one call shows as its own card. */
export const GROUP_MIN_RUNS = 2;

/** One fn's calls in a group. */
export interface GroupEntry {
  readonly fn: QualifiedName;
  readonly label: string;
  readonly count: number;
  readonly failed: number;
}

/** A group's summary: its entries (most recent fn first), its status and its counts. */
export interface GroupSummary {
  readonly entries: readonly GroupEntry[];
  readonly status: RunStatus;
  readonly total: number;
  readonly failed: number;
  /** Runs still going. */
  readonly active: number;
}

/** Whether a run waits on the person: its approval, or a question it asked. */
export function needsPerson(run: Pick<RunView, 'status' | 'asking'>): boolean {
  return run.status === 'awaiting-approval' || (run.asking === true && !isSettled(run.status));
}

/**
 * The status a group shows: the first run that needs the person, else one still going, else a failure, else the
 * latest run's own.
 */
function groupStatus(runs: readonly RunView[]): RunStatus {
  const person = runs.find(needsPerson);
  if (person !== undefined) { return shownStatus(person); }
  const going = runs.find((run) => !isSettled(run.status));
  if (going !== undefined) { return shownStatus(going); }
  if (runs.some((run) => run.status === 'failed')) { return 'failed'; }
  return runs.at(-1)?.status ?? 'done';
}

/** A group's summary, from its runs in call order. */
export function groupSummary(runs: readonly RunView[]): GroupSummary {
  const byFn = new Map<QualifiedName, { count: number; failed: number }>();
  // newest first, so the fn called most recently leads; a Map keeps the order of first insertion
  for (const run of [...runs].reverse()) {
    const entry = byFn.get(run.fn) ?? { count: 0, failed: 0 };
    entry.count++;
    if (run.status === 'failed') { entry.failed++; }
    byFn.set(run.fn, entry);
  }
  return {
    entries: [...byFn].map(([fn, { count, failed }]) => ({ fn, label: fnLabel(fn), count, failed })),
    status: groupStatus(runs),
    total: runs.length,
    failed: runs.filter((run) => run.status === 'failed').length,
    active: runs.filter((run) => !isSettled(run.status)).length,
  };
}

/** The summary in words: "Bash ×3 · Read ×2", the most recent fn first. */
export function groupText(summary: Pick<GroupSummary, 'entries'>): string {
  return summary.entries.map((entry) => (entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label)).join(' · ');
}

/** The group's count in words: "5 fn calls", "5 fn calls, 1 failed", "5 fn calls, 2 in progress". */
export function groupCount(summary: Pick<GroupSummary, 'total' | 'failed' | 'active'>): string {
  const calls = `${summary.total} fn ${summary.total === 1 ? 'call' : 'calls'}`;
  if (summary.active > 0) { return `${calls}, ${summary.active} in progress`; }
  return summary.failed > 0 ? `${calls}, ${summary.failed} failed` : calls;
}

/** Whether runs in a row collapse into a group: the option is on and there are enough of them. */
export function groups(grouped: boolean, runs: readonly RunView[]): boolean {
  return grouped && runs.length >= GROUP_MIN_RUNS;
}
