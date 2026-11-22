/**
 * Fn metrics: every run records how long it waited and ran, what it cost and used, how it ended and how often it was
 * retried; the hub rolls them up per fn and per day. The admin's fn pages show the rollups, and `hub/fns_metrics` gives
 * them to the LLM (a slow or often-refused fn is worth knowing about when choosing one).
 */
import { z } from 'zod';
import { Duration, QualifiedName, SystemName, Timestamp, Usd } from './primitives.ts';
import { FnNameValue } from './model-names.ts';
import type { SettledRunStatus } from './run.ts';

/** How a run ended, for metrics: the settled statuses a run reaches on its own (`undone` comes later, by a person). */
export const RUN_OUTCOMES = ['done', 'invalid-input', 'failed', 'cancelled'] as const satisfies readonly SettledRunStatus[];
export const RunOutcome = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcome>;

/** Count by outcome: every outcome has a count (an enum-keyed record is exhaustive). */
export const OutcomeCounts = z.record(RunOutcome, z.number().int().min(0));
export type OutcomeCounts = z.infer<typeof OutcomeCounts>;

/** Every outcome at zero. */
export function noOutcomes(): OutcomeCounts {
  return { done: 0, 'invalid-input': 0, failed: 0, cancelled: 0 };
}

/** How many runs some outcome counts hold. */
export function runCount(outcomes: OutcomeCounts): number {
  return RUN_OUTCOMES.reduce((sum, outcome) => sum + outcomes[outcome], 0);
}

/** A UTC day, as metrics key and bound their periods: `2026-11-07`. */
export const UtcDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type UtcDay = z.infer<typeof UtcDay>;

/** One day in ms, for day arithmetic on timestamps. */
export const DAY_MS: Duration = 86_400_000;

/** The upper bounds (ms) of the duration histogram's buckets; a last bucket takes everything longer. */
export const DURATION_BUCKETS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000] as const;

/** Durations of many runs: count, sum, longest, and a histogram over `DURATION_BUCKETS` (one more bucket than bounds). */
export const DurationStats = z.object({
  count: z.number().int().min(0),
  sum: Duration,
  max: Duration,
  histogram: z.array(z.number().int().min(0)).length(DURATION_BUCKETS.length + 1),
});
export type DurationStats = z.infer<typeof DurationStats>;

/**
 * One fn's runs on one day (UTC, `2026-11-07`). `queued` is from created to started without the approval wait,
 * `approval` the time spent waiting for a person, `ran` from started to ended.
 */
export const FnMetricsDay = z.object({
  fn: QualifiedName,
  system: SystemName,
  day: UtcDay,
  outcomes: OutcomeCounts,
  queued: DurationStats,
  approval: DurationStats,
  ran: DurationStats,
  cost: Usd,
  tokens: z.number().int().min(0),
  /** Attempts beyond the first. */
  retries: z.number().int().min(0),
  modelCalls: z.number().int().min(0),
  updatedAt: Timestamp,
});
export type FnMetricsDay = z.infer<typeof FnMetricsDay>;

/** A fn's metrics over a period, as pages and the LLM read them. Percentiles come from the histograms. */
export const FnMetrics = z.object({
  fn: QualifiedName,
  system: SystemName,
  from: UtcDay,
  to: UtcDay,
  runs: z.number().int().min(0),
  outcomes: OutcomeCounts,
  p50: Duration.optional(),
  p95: Duration.optional(),
  averageQueued: Duration.optional(),
  averageCost: Usd,
  cost: Usd,
  tokens: z.number().int().min(0),
  retries: z.number().int().min(0),
  lastRunAt: Timestamp.optional(),
});
export type FnMetrics = z.infer<typeof FnMetrics>;

/** What a metrics query narrows by: one fn or system, over the last `days` days (7 by default). */
export const FnMetricsQuery = z.object({ fn: FnNameValue.optional(), system: SystemName.optional(), days: z.number().int().min(1).max(365).optional() });
export type FnMetricsQuery = z.infer<typeof FnMetricsQuery>;
