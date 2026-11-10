/**
 * The query visuals' match logic, kept apart from their components so the server, the client and tests share it.
 * Each says whether a result table fits it and how much of it it shows well (core's `VisualFit`). The table always
 * fits with the lowest score, so every other visual that fits is preferred.
 */
import type { Json, ResultTable } from '@harness/core';

export { barFit, tableFit, valueFit } from '@harness/core';

/** A cell as a bar's label. */
function labelText(value: Json | undefined): string {
  if (value === null || value === undefined) { return '—'; }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The bars of a bar chart: each row's label and value, and the largest value (for scaling). */
export function barsOf(table: ResultTable): { bars: { label: string; value: number }[]; max: number } {
  const bars = table.rows.map((row) => ({ label: labelText(row[0]), value: typeof row[1] === 'number' ? row[1] : 0 }));
  return { bars, max: bars.reduce((most, bar) => Math.max(most, Math.abs(bar.value)), 0) };
}
