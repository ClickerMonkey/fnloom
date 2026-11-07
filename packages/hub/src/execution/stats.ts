/**
 * A fn's running numbers (`FnRecord.stats`): every run that settles adds to its fn's count, its failures, and the
 * running averages of what it cost and how long it took, and the new numbers are announced (`fn.stats`) so admin
 * views update live. Paused runs haven't ended and aren't counted; an undone run was counted when it settled.
 */
import type { Duration, FnStats, Run, Timestamp, Usd } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { HubStore } from '../store/index.ts';

/** What one settled run adds to its fn's numbers. */
export interface RunSample {
  readonly failed: boolean;
  readonly cost: Usd;
  readonly time: Duration;
  readonly at: Timestamp;
}

/** The sample a settled run gives: its whole cost (children included) and its time from start (or creation) to end. */
export function sampleOf(run: Pick<Run, 'status' | 'totalCost' | 'createdAt' | 'startedAt' | 'endedAt'>): RunSample {
  const at = run.endedAt ?? run.createdAt;
  return { failed: run.status === 'failed', cost: run.totalCost, time: Math.max(0, at - (run.startedAt ?? run.createdAt)), at };
}

/** A fn's numbers with one more run. Averages are running means, so no history is kept; time stays whole ms. */
export function addSample(stats: FnStats, sample: RunSample): FnStats {
  const runs = stats.runs + 1;
  return {
    runs,
    failures: stats.failures + (sample.failed ? 1 : 0),
    averageCost: stats.averageCost + (sample.cost - stats.averageCost) / runs,
    averageTime: Math.round(stats.averageTime + (sample.time - stats.averageTime) / runs),
    lastRunAt: Math.max(stats.lastRunAt ?? 0, sample.at),
  };
}

/** Keeps every fn's numbers current as its runs settle. */
export class FnStatsRecorder {
  readonly #store: HubStore;
  readonly #bus: EventBus;

  constructor(deps: { readonly store: HubStore; readonly bus: EventBus }) {
    this.#store = deps.store;
    this.#bus = deps.bus;
  }

  /** Add a settled run to its fn's numbers (in one transaction, so runs settling at once all count). */
  async record(run: Run): Promise<void> {
    const sample = sampleOf(run);
    const updated = await this.#store.tx(async (tx) => {
      const fn = await tx.table('fns').get(run.fn);
      return fn === undefined ? undefined : tx.table('fns').update(fn.name, { stats: addSample(fn.stats, sample) });
    });
    if (updated !== undefined) this.#bus.publish('fn.stats', { fn: updated.name, system: updated.system, stats: updated.stats });
  }
}
