/**
 * Fn metrics as the fn page reads them: a percentile from a duration histogram (to within one bucket), a day's
 * typical time, the figures of the metrics strip, and the bars of the per-day charts. Pure, so it is tested alone.
 */
import { DURATION_BUCKETS, type DurationStats, type FnMetrics, type FnMetricsDay } from '@harness/core';
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

/** The share of runs that ended `done`, as a whole percent ('' with no runs). */
export function successRate(metrics: Pick<FnMetrics, 'runs' | 'outcomes'>): string {
  return metrics.runs === 0 ? '' : `${Math.round((metrics.outcomes.done / metrics.runs) * 100)}%`;
}

/** The metrics strip: runs, how they ended (retried input apart from failures), times, cost and tokens. */
export function figures(metrics: FnMetrics): Figure[] {
  const time = (ms: number | undefined): string => (ms === undefined ? '—' : formatDuration(ms));
  return [
    { key: 'runs', label: 'Runs', value: metrics.runs.toLocaleString(), detail: successRate(metrics) === '' ? '' : `${successRate(metrics)} done` },
    { key: 'retried', label: 'Retried input', value: metrics.outcomes['invalid-input'].toLocaleString(), detail: 'The agent fixed its call' },
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
    const ended = `${day.outcomes.done} done · ${day.outcomes['invalid-input']} retried · ${day.outcomes.failed} failed`;
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
