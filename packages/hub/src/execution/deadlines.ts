/**
 * Run deadlines, enforced by the hub. A run may take until the earlier of its turn's time budget running out
 * (`turn.createdAt + limits.turn.time`) and its fn's own timeout from when this attempt started. Systems are told the
 * deadline in the run request and the SDK stops a fn there itself, but the hub doesn't rely on it: when a deadline
 * passes the hub stops the run (its executor ends the work) and settles it as failed with code `timeout`. A fn that
 * ran past its own timeout may be tried again (`retry`); a turn whose time is spent can't give more (`fatal`).
 */
import type { FnError, FnRecord, Run, RunId, Turn } from '@harness/core';
import { fnError } from './errors.ts';

/** What ends a run's time: its turn's time budget or its fn's own timeout. */
export type DeadlineBy = 'turn' | 'fn';

/** When a run's time runs out, and what sets it. */
export interface RunDeadline {
  readonly at: number;
  readonly by: DeadlineBy;
}

/**
 * The deadline of an attempt that starts at `start`: the turn's (its time budget from when it began, or from when a
 * person last continued it), or the fn's timeout from `start` when that is sooner.
 */
export function runDeadline(start: number, turn: Pick<Turn, 'createdAt' | 'continuedAt' | 'limits'>, fn: Pick<FnRecord, 'decl'>): RunDeadline {
  const turnAt = (turn.continuedAt ?? turn.createdAt) + turn.limits.turn.time;
  const timeout = fn.decl.limits.timeout;
  return timeout !== undefined && start + timeout < turnAt ? { at: start + timeout, by: 'fn' } : { at: turnAt, by: 'turn' };
}

/** The error a run settles with when its deadline passes. */
export function deadlineError(deadline: RunDeadline, run: Pick<Run, 'fn'>, turn: Pick<Turn, 'limits'>, fn: Pick<FnRecord, 'decl'>): FnError {
  return deadline.by === 'fn'
    ? fnError('retry', `${run.fn} took longer than its ${fn.decl.limits.timeout ?? 0} ms limit and was stopped.`, 'timeout')
    : fnError('fatal', `The turn ran out of time (its budget is ${turn.limits.turn.time} ms), so ${run.fn} was stopped.`, 'timeout');
}

/** One timer per run, fired at its deadline. Arming a run again replaces its timer. */
export class DeadlineTimers {
  readonly #timers = new Map<RunId, ReturnType<typeof setTimeout>>();
  readonly #clock: () => number;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  /** Call `expire` once the clock reaches `at` (at once when it already has). */
  arm(run: RunId, at: number, expire: () => void): void {
    this.disarm(run);
    const timer = setTimeout(() => {
      this.#timers.delete(run);
      expire();
    }, Math.max(0, at - this.#clock()));
    timer.unref();
    this.#timers.set(run, timer);
  }

  /** Whether a run has a timer armed. */
  armed(run: RunId): boolean {
    return this.#timers.has(run);
  }

  disarm(run: RunId): void {
    const timer = this.#timers.get(run);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(run);
  }

  /** Disarm every timer (the hub is stopping). */
  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
