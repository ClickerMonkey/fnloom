/**
 * Cells as the person reads them: numbers grouped by locale, dates and times in their locale, booleans as words,
 * JSON compact, nulls as a dash.
 */
import type { ColumnKind, Json } from '@harness/core';

/** One cell as text. */
export function formatCell(value: Json | undefined, kind: ColumnKind): string {
  if (value === null || value === undefined) { return '—'; }
  if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
  if (typeof value === 'number') { return kind === 'integer' ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toLocaleString(undefined, { maximumFractionDigits: 4 }); }
  if (typeof value === 'string') {
    if (kind === 'datetime') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }
    if (kind === 'date') {
      const date = new Date(`${value.slice(0, 10)}T00:00:00`);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
    }
    return value;
  }
  return JSON.stringify(value);
}

/** Whether a column's cells line up on the right (numbers). */
export function alignsRight(kind: ColumnKind): boolean {
  return kind === 'integer' || kind === 'number';
}
