/**
 * The pure part of fn metrics: what one settled run adds (`RunSample`), folding it into its fn's day, merging days
 * into a period's `FnMetrics`, percentiles from the duration histograms, and the running numbers on `FnRecord.stats`.
 * No store, no clock: the service (`fn-metrics.ts`) reads and writes around these.
 */
import {
  DAY_MS, DURATION_BUCKETS, noOutcomes, RUN_OUTCOMES, runCount, type Duration, type DurationStats, type FnMetrics, type FnMetricsDay, type FnStats, type OutcomeCounts, type QualifiedName,
  type Run, type RunOutcome, type SystemName, type Timestamp, type Usd, type UtcDay,
} from '@harness/core';

/** What one settled run adds to its fn's numbers. Durations are absent for the phases the run never went through. */
export interface RunSample {
  readonly fn: QualifiedName;
  readonly system: SystemName;
  readonly outcome: RunOutcome;
  /** When it ended: its day and `lastRunAt`. */
  readonly at: Timestamp;
  /** Created (or approved) to started, without the approval wait. */
  readonly queued?: Duration | undefined;
  /** Created to approved, when a person had to approve it. */
  readonly approval?: Duration | undefined;
  /** Started to ended. */
  readonly ran?: Duration | undefined;
  readonly cost: Usd;
  readonly tokens: number;
  readonly retries: number;
  readonly modelCalls: number;
}

/** A run's outcome for metrics, or undefined for a status that isn't one (an `undone` run was counted when it settled). */
export function outcomeOf(status: Run['status']): RunOutcome | undefined {
  return RUN_OUTCOMES.find((outcome) => outcome === status);
}

/** The sample a settled run gives, or undefined when its status isn't an outcome. */
export function sampleOf(run: Run, modelCalls: number): RunSample | undefined {
  const outcome = outcomeOf(run.status);
  if (outcome === undefined) return undefined;
  const at = run.endedAt ?? run.createdAt;
  const waitedFrom = run.approvedAt ?? run.createdAt;
  return {
    fn: run.fn,
    system: run.system,
    outcome,
    at,
    ...(run.approvedAt === undefined ? {} : { approval: Math.max(0, run.approvedAt - run.createdAt) }),
    ...(run.startedAt === undefined ? {} : { queued: Math.max(0, run.startedAt - waitedFrom), ran: Math.max(0, at - run.startedAt) }),
    cost: run.totalCost,
    tokens: run.tokens ?? 0,
    retries: Math.max(0, run.attempt - 1),
    modelCalls,
  };
}

/** The UTC day of a time, as `FnMetricsDay.day` keys it (`2026-11-07`). */
export function dayOf(at: Timestamp): UtcDay {
  return new Date(at).toISOString().slice(0, 10);
}

/** The UTC day `days - 1` days before `at`'s: the first day of a period of `days` days ending on `at`'s day. */
export function firstDay(at: Timestamp, days: number): UtcDay {
  return dayOf(at - (days - 1) * DAY_MS);
}

/** No durations yet. */
export function emptyDurations(): DurationStats {
  return { count: 0, sum: 0, max: 0, histogram: new Array<number>(DURATION_BUCKETS.length + 1).fill(0) };
}

/** Which histogram bucket a duration falls in: the first bound it doesn't exceed, else the last (overflow) bucket. */
export function bucketOf(duration: Duration): number {
  const index = DURATION_BUCKETS.findIndex((bound) => duration <= bound);
  return index === -1 ? DURATION_BUCKETS.length : index;
}

/** Durations with one more. */
export function addDuration(stats: DurationStats, duration: Duration | undefined): DurationStats {
  if (duration === undefined) return stats;
  const bucket = bucketOf(duration);
  return {
    count: stats.count + 1,
    sum: stats.sum + duration,
    max: Math.max(stats.max, duration),
    histogram: stats.histogram.map((n, i) => (i === bucket ? n + 1 : n)),
  };
}

/** Two sets of durations as one. */
export function mergeDurations(a: DurationStats, b: DurationStats): DurationStats {
  return { count: a.count + b.count, sum: a.sum + b.sum, max: Math.max(a.max, b.max), histogram: a.histogram.map((n, i) => n + (b.histogram[i] ?? 0)) };
}

/**
 * The `p`th percentile (0 to 1) of some durations, from their histogram: the upper bound of the bucket holding that
 * rank (the longest duration for the overflow bucket, and never more than it), so it is within one bucket of the
 * real value. Undefined with no durations.
 */
export function percentile(stats: DurationStats, p: number): Duration | undefined {
  if (stats.count === 0) return undefined;
  const rank = Math.max(1, Math.ceil(p * stats.count));
  let seen = 0;
  for (const [i, n] of stats.histogram.entries()) {
    seen += n;
    if (seen >= rank) return Math.min(DURATION_BUCKETS[i] ?? stats.max, stats.max);
  }
  return stats.max;
}

/** The mean of some durations, rounded to whole ms; undefined with none. */
export function mean(stats: DurationStats): Duration | undefined {
  return stats.count === 0 ? undefined : Math.round(stats.sum / stats.count);
}

/** Outcome counts added together. */
function addOutcomes(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  return { done: a.done + b.done, 'invalid-input': a['invalid-input'] + b['invalid-input'], failed: a.failed + b.failed, cancelled: a.cancelled + b.cancelled };
}

/** A fn's day with one more run (a new day when there is none yet). */
export function foldDay(day: FnMetricsDay | undefined, sample: RunSample, now: Timestamp): FnMetricsDay {
  const base: FnMetricsDay = day ?? {
    fn: sample.fn, system: sample.system, day: dayOf(sample.at), outcomes: noOutcomes(), queued: emptyDurations(), approval: emptyDurations(), ran: emptyDurations(),
    cost: 0, tokens: 0, retries: 0, modelCalls: 0, updatedAt: now,
  };
  return {
    ...base,
    outcomes: { ...base.outcomes, [sample.outcome]: base.outcomes[sample.outcome] + 1 },
    queued: addDuration(base.queued, sample.queued),
    approval: addDuration(base.approval, sample.approval),
    ran: addDuration(base.ran, sample.ran),
    cost: base.cost + sample.cost,
    tokens: base.tokens + sample.tokens,
    retries: base.retries + sample.retries,
    modelCalls: base.modelCalls + sample.modelCalls,
    updatedAt: now,
  };
}

/** Days of one fn merged into its metrics over the period `from` to `to` (inclusive). */
export function rollup(fn: QualifiedName, system: SystemName, days: readonly FnMetricsDay[], period: { from: UtcDay; to: UtcDay }, lastRunAt?: Timestamp): FnMetrics {
  let outcomes = noOutcomes();
  let ran = emptyDurations();
  let queued = emptyDurations();
  let cost = 0;
  let tokens = 0;
  let retries = 0;
  for (const day of days) {
    outcomes = addOutcomes(outcomes, day.outcomes);
    ran = mergeDurations(ran, day.ran);
    queued = mergeDurations(queued, day.queued);
    cost += day.cost;
    tokens += day.tokens;
    retries += day.retries;
  }
  const runs = runCount(outcomes);
  const p50 = percentile(ran, 0.5);
  const p95 = percentile(ran, 0.95);
  const averageQueued = mean(queued);
  return {
    fn, system, from: period.from, to: period.to, runs, outcomes,
    ...(p50 === undefined ? {} : { p50 }), ...(p95 === undefined ? {} : { p95 }), ...(averageQueued === undefined ? {} : { averageQueued }),
    averageCost: runs === 0 ? 0 : cost / runs, cost, tokens, retries,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  };
}

/**
 * A fn's running numbers with one more run: counts by outcome, running means of cost, time and queue wait (no history
 * kept; times stay whole ms), the tokens it used, and the week's p95 run time read from the daily metrics.
 */
export function addSample(stats: FnStats, sample: RunSample, p95: Duration | undefined): FnStats {
  const before = runCount(stats.outcomes);
  const runs = before + 1;
  const time = sample.ran ?? 0;
  const queuedCount = stats.averageQueued === undefined ? 0 : before;
  const averageQueued = sample.queued === undefined
    ? stats.averageQueued
    : Math.round((stats.averageQueued ?? 0) + (sample.queued - (stats.averageQueued ?? 0)) / (queuedCount + 1));
  return {
    outcomes: { ...stats.outcomes, [sample.outcome]: stats.outcomes[sample.outcome] + 1 },
    averageCost: stats.averageCost + (sample.cost - stats.averageCost) / runs,
    averageTime: Math.round(stats.averageTime + (time - stats.averageTime) / runs),
    lastRunAt: Math.max(stats.lastRunAt ?? 0, sample.at),
    tokens: stats.tokens + sample.tokens,
    ...(averageQueued === undefined ? {} : { averageQueued }),
    ...(p95 === undefined ? {} : { p95 }),
  };
}
