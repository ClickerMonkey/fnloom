/**
 * The browser maths over rows (charts-browser-math: only over a whole result; ranking hides the styles that need it
 * otherwise, and the authoring agent writes an aggregate query instead): a histogram's bins, a part-to-whole's
 * "Other" slice, and the samples a box plot's quartiles are taken from (ECharts' `boxplot` transform takes the
 * quartiles itself).
 */
import { PART_TO_WHOLE_MAX_SLICES } from '@harness/core';
import type { ChartValue } from './chart-data.ts';

/** The most bins a histogram draws. */
export const HISTOGRAM_MAX_BINS = 30;

/** One bin: its range (from inclusive, to exclusive but for the last) and how many values fall in it. */
export interface Bin {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

/** A readable step near `raw` (1, 2 or 5 times a power of ten), so bin edges are round numbers. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/** Bins over numbers (Sturges' count, rounded edges); one bin when every value is the same, none for no values. */
export function histogram(values: readonly number[]): Bin[] {
  if (values.length === 0) { return []; }
  const min = Math.min(...values); const max = Math.max(...values);
  if (min === max) { return [{ from: min, to: max, count: values.length }]; }
  const count = Math.min(HISTOGRAM_MAX_BINS, Math.ceil(Math.log2(values.length)) + 1);
  const step = niceStep((max - min) / count);
  const start = Math.floor(min / step) * step;
  const bins = Math.max(1, Math.ceil((max - start) / step + 1e-9));
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const at = Math.min(bins - 1, Math.floor((value - start) / step));
    counts[at] = (counts[at] ?? 0) + 1;
  }
  return counts.map((n, i) => ({ from: start + i * step, to: start + (i + 1) * step, count: n }));
}

/** One slice of a part-to-whole: its name, size, and the row it came from (none for "Other"). */
export interface Slice {
  readonly name: ChartValue;
  readonly value: number;
  readonly row: number | undefined;
}

/** The label of the slice the smallest ones fold into. */
export const OTHER_SLICE = 'Other';

/**
 * Slices largest first, the smallest folded into one "Other" when there are more than `max` (`size: 'partition'`).
 * Rows without a size are left out.
 */
export function foldSlices(slices: readonly Slice[], max = PART_TO_WHOLE_MAX_SLICES): Slice[] {
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  if (sorted.length <= max) { return sorted; }
  const kept = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((sum, slice) => sum + slice.value, 0);
  return [...kept, { name: OTHER_SLICE, value: rest, row: undefined }];
}
