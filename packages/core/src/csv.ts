/**
 * Tables as CSV (RFC 4180), one implementation for the hub's streamed export and the web app's download of the rows it
 * holds: a header row of column names, raw values (numbers unformatted, JSON compact, empty for null), lines ending in
 * CRLF. Written a line at a time, so an export never holds more than the page in hand.
 */
import type { Json } from './primitives.ts';
import type { ResultColumn } from './registries.ts';

/** A field as CSV: quoted when it holds a comma, quote, line break or edge space. */
export function csvField(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A cell as CSV: raw values (numbers unformatted, JSON compact), empty for null. */
export function csvCell(value: Json | undefined): string {
  if (value === null || value === undefined) { return ''; }
  return csvField(typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));
}

/** The header line: the column names. */
export function csvHeader(columns: readonly Pick<ResultColumn, 'name'>[]): string {
  return `${columns.map((column) => csvField(column.name)).join(',')}\r\n`;
}

/** The lines of some rows, one cell per column. */
export function csvRows(columns: readonly Pick<ResultColumn, 'name'>[], rows: readonly (readonly Json[])[]): string {
  return rows.map((row) => `${columns.map((_, index) => csvCell(row[index])).join(',')}\r\n`).join('');
}

/** A whole table as CSV, the header first. */
export function toCsv(columns: readonly Pick<ResultColumn, 'name'>[], rows: readonly (readonly Json[])[]): string {
  return csvHeader(columns) + csvRows(columns, rows);
}
