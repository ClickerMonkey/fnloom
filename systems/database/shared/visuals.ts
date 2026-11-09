/**
 * The query visuals' match logic, kept apart from their components so the server, the client and tests share it.
 * Each says whether a result table fits it and how much of it it shows well (core's `VisualFit`). The table always
 * fits with the lowest score, so every other visual that fits is preferred.
 */
import { TABLE_VISUAL_SCORE, type ColumnKind, type Json, type ResultTable, type VisualFit } from '@harness/core';

const NUMBER_KINDS: ReadonlySet<ColumnKind> = new Set(['integer', 'number']);
const LABEL_KINDS: ReadonlySet<ColumnKind> = new Set(['text', 'date', 'datetime', 'uuid']);

/** The most bars a bar chart draws. */
export const BAR_MAX_ROWS = 50;

/** The table: every result, the lowest score. */
export function tableFit(): VisualFit {
  return { fits: true, score: TABLE_VISUAL_SCORE };
}

/**
 * A bar chart: one label column (text or a date) and one number column, 2 to 50 rows, every row complete. The whole
 * result is the chart, so it scores high.
 */
export function barFit(table: ResultTable): VisualFit {
  const [first, second] = table.columns;
  if (table.columns.length !== 2 || first === undefined || second === undefined) { return { fits: false, score: 0 }; }
  const shape = LABEL_KINDS.has(first.kind) && NUMBER_KINDS.has(second.kind);
  const rows = table.rows.length >= 2 && table.rows.length <= BAR_MAX_ROWS;
  const numbers = table.rows.every((row) => typeof row[1] === 'number');
  return shape && rows && numbers ? { fits: true, score: 0.8 } : { fits: false, score: 0 };
}

/** A single value: one row with one column, drawn large. */
export function valueFit(table: ResultTable): VisualFit {
  return table.columns.length === 1 && table.rows.length === 1 ? { fits: true, score: 0.9 } : { fits: false, score: 0 };
}

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
