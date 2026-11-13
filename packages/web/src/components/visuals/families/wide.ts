/**
 * The wide table a category or time family draws: a row per key, a column per series. Several measures make a series
 * each; one measure with a series column is pivoted, a series per value of it.
 */
import { boundAll, bound, chartValue, labelOf, needed, numberOf, pivot, type ChartInput, type ChartValue } from '../chart-data.ts';

/** A family's series over its key, and where each cell came from. */
export interface Wide {
  readonly key: string;
  /** Series names, in order. */
  readonly names: string[];
  /** `[key, value per series…]` per key. */
  readonly source: ChartValue[][];
  rowAt(key: number, series: number): number | undefined;
}

/** The wide table of a key channel, the measures channel `y` and the optional `series` channel. */
export function wide(input: ChartInput, keyChannel: string): Wide {
  const key = needed(input, keyChannel);
  const measures = boundAll(input, 'y');
  const split = bound(input, 'series');
  const [first] = measures;
  if (split !== undefined && first !== undefined) {
    const pivoted = pivot(input.table, key.index, split.index, first.index);
    return { key: key.name, names: pivoted.series.map(labelOf), source: pivoted.source, rowAt: (k, s) => pivoted.rowAt(k, s) };
  }
  return {
    key: key.name,
    names: measures.map((measure) => measure.label),
    source: input.table.rows.map((row): ChartValue[] => [chartValue(row[key.index]), ...measures.map((measure) => numberOf(row[measure.index]))]),
    rowAt: (k) => k,
  };
}

/** Each key's values as shares of its row's total, in percent (the 100% stacked style). */
export function asPercent(source: readonly ChartValue[][]): ChartValue[][] {
  return source.map(([key = null, ...values]) => {
    const total = values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? Math.abs(value) : 0), 0);
    return [key, ...values.map((value) => (typeof value === 'number' && total > 0 ? (Math.abs(value) / total) * 100 : null))];
  });
}
