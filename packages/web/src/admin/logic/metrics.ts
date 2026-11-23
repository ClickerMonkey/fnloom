/**
 * Fn metrics as the fn page reads them: a percentile from a duration histogram (to within one bucket), a day's
 * typical time, the figures of the metrics strip, and the bars of the per-day charts. Pure, so it is tested alone.
 */
import { DURATION_BUCKETS, runCount, type DurationStats, type FnMetrics, type FnMetricsDay, type OutcomeCounts } from '@harness/core';
import { formatCost, formatDuration, formatTokens } from '../../chat/logic/format.ts';

/**
 * The `p`th percentile (0 to 1) of durations, as the upper bound of the bucket it falls in (the last, open bucket
 * reads as the longest seen). Undefined with no runs.
 */
export function percentile(stats: DurationStats, p: number): number | undefined {
  if (stats.count === 0) { return undefined; }
  const rank = Math.max(1, Math.ceil(p * stats.count));
  let seen = 0;
  for (const [bucket, count] of stats.histogram.entries()) {
    seen += count;
    if (seen >= rank) { return DURATION_BUCKETS[bucket] ?? stats.max; }
  }
  return stats.max;
}

/** One figure of the metrics strip. */
export interface Figure {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}

/**
 * The runs that say how the fn itself does: all but those whose args the model got wrong (`invalid-input`: sent back for
 * the model to fix, never run), which say nothing of the fn.
 */
export function realRuns(outcomes: OutcomeCounts): number {
  return runCount(outcomes) - outcomes['invalid-input'];
}

/** A share as a whole percent, '' when there is nothing to share. */
const percentOf = (part: number, whole: number): string => (whole === 0 ? '' : `${Math.round((part / whole) * 100)}%`);

/** The share of the fn's real runs (`realRuns`) that ended `done`, as a whole percent ('' with none). */
export function successRate(metrics: Pick<FnMetrics, 'outcomes'>): string {
  return percentOf(metrics.outcomes.done, realRuns(metrics.outcomes));
}

/** The share of the fn's real runs that failed ("3% failed"; '' with none): the model's arg mistakes are not failures. */
export function failureRate(outcomes: OutcomeCounts): string {
  const rate = percentOf(outcomes.failed, realRuns(outcomes));
  return rate === '' ? '' : `${rate} failed`;
}

/** The model's arg mistakes a fn's runs held, in words ("4 fixed by the model"), '' with none: not failures. */
export function fixedByModel(outcomes: OutcomeCounts): string {
  return outcomes['invalid-input'] === 0 ? '' : `${outcomes['invalid-input'].toLocaleString()} fixed by the model`;
}

/** What the "Fixed by the model" figure means. */
export const FIXED_BY_MODEL_DETAIL = 'Calls the model sent back and fixed; not failures';

/** The metrics strip: runs, how they ended (the model's arg mistakes apart from failures), times, cost and tokens. */
export function figures(metrics: FnMetrics): Figure[] {
  const time = (ms: number | undefined): string => (ms === undefined ? '—' : formatDuration(ms));
  return [
    { key: 'runs', label: 'Runs', value: metrics.runs.toLocaleString(), detail: successRate(metrics) === '' ? '' : `${successRate(metrics)} done` },
    { key: 'retried', label: 'Fixed by the model', value: metrics.outcomes['invalid-input'].toLocaleString(), detail: FIXED_BY_MODEL_DETAIL },
    { key: 'failed', label: 'Failed', value: metrics.outcomes.failed.toLocaleString(), detail: metrics.outcomes.cancelled > 0 ? `${metrics.outcomes.cancelled} cancelled` : '' },
    { key: 'p50', label: 'Typical time', value: time(metrics.p50), detail: `p95 ${time(metrics.p95)}` },
    { key: 'queued', label: 'Waited', value: time(metrics.averageQueued), detail: 'On average, before running' },
    { key: 'cost', label: 'Cost', value: formatCost(metrics.cost), detail: `${formatCost(metrics.averageCost)} a run` },
    { key: 'tokens', label: 'Tokens', value: formatTokens(metrics.tokens), detail: metrics.retries > 0 ? `${metrics.retries} retries` : '' },
  ];
}

/** One bar of a per-day chart. */
export interface DayBar {
  readonly day: string;
  /** The short date under it ("Nov 7"). */
  readonly label: string;
  readonly value: number;
  /** What its tooltip says. */
  readonly lines: readonly string[];
}

/** The measures a day chart can show. */
export type DayMeasure = 'runs' | 'time';

const dayLabel = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A day's length in ms. */
const DAY_MS = 86_400_000;

/** The window a day chart covers: so many days, ending today (or on the latest day with data, if later). */
export interface DayWindow {
  readonly period: number;
  readonly now: number;
}

/** Every UTC day of a window, oldest first. */
export function windowDays(window: DayWindow, latest?: string): string[] {
  const today = new Date(window.now).toISOString().slice(0, 10);
  const end = Date.parse(`${latest !== undefined && latest > today ? latest : today}T00:00:00Z`);
  return Array.from({ length: window.period }, (_, i) => new Date(end - (window.period - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/**
 * The bars of a per-day chart: one for every day of the window (a day without runs is an empty bar, so each date sits
 * under its own bar), how many runs each day, or each day's typical time (p50).
 */
export function dayBars(days: readonly FnMetricsDay[], measure: DayMeasure, window: DayWindow): DayBar[] {
  const byDay = new Map(days.map((day) => [day.day, day]));
  return windowDays(window, days.map((d) => d.day).sort().at(-1)).map((key): DayBar => {
    const day = byDay.get(key);
    if (day === undefined) { return { day: key, label: dayLabel(key), value: 0, lines: [measure === 'runs' ? '0 runs' : 'No runs'] }; }
    const runs = day.ran.count;
    const p50 = percentile(day.ran, 0.5);
    const p95 = percentile(day.ran, 0.95);
    const ended = `${day.outcomes.done} done · ${day.outcomes.failed} failed${day.outcomes['invalid-input'] === 0 ? '' : ` · ${day.outcomes['invalid-input']} fixed by the model`}`;
    return measure === 'runs'
      ? { day: day.day, label: dayLabel(day.day), value: runs, lines: [`${runs.toLocaleString()} ${runs === 1 ? 'run' : 'runs'}`, ended] }
      : { day: day.day, label: dayLabel(day.day), value: p50 ?? 0, lines: [p50 === undefined ? 'No runs' : `Typical ${formatDuration(p50)}`, p95 === undefined ? '' : `p95 ${formatDuration(p95)}`].filter((l) => l !== '') };
  });
}

/** A rounded top for a chart's scale: 1, 2 or 5 times a power of ten, at least `value`. */
export function niceMax(value: number): number {
  if (value <= 0) { return 1; }
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * power >= value) ?? 10;
  return step * power;
}
