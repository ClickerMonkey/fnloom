/**
 * A result table's logic, apart from any component: how a cell reads for its column's kind, how rows sort, which rows
 * a page of the grid shows and when a page has to be asked of the fn again (the rows held stop short of it), and the
 * table as CSV.
 */
import type { ColumnKind, Json, ResultColumn, ResultSort, ResultTable } from '@harness/core';

/** How many rows the grid shows at a time. */
export const GRID_PAGE = 25;

/** Ask the fn that made a table for another slice of it: the next or previous rows, or all of it in another order. */
export interface PageRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly ResultSort[];
}

/** The page sizes the grid offers (beside the visual's own). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Calls the table's fn again with a page request (a new run, whose result shows as its own table). A `buffered` one
 * (a widget's pager) only reads the rows after those held and adds them, so the grid sorts and pages the rows held,
 * unless it has `sort`: then its source sorts (the Data page's records, sorted by the hub with the sort in the URL).
 */
export type ResultPager = ((request: PageRequest) => void) & {
  readonly buffered?: boolean;
  readonly sort?: ((next: ResultSort | undefined) => void) | undefined;
};

/** Kinds whose cells line up on the right, digits under digits. */
const NUMERIC: ReadonlySet<ColumnKind> = new Set(['integer', 'number']);

/** Whether a column's cells are numbers, aligned right. */
export function isNumeric(column: Pick<ResultColumn, 'kind'>): boolean {
  return NUMERIC.has(column.kind);
}

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
const DATETIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A cell as the grid shows it; `undefined` for an empty (null) cell, which the grid marks as such. */
export function cellText(value: Json | undefined, column: Pick<ResultColumn, 'kind'>): string | undefined {
  if (value === null || value === undefined) { return undefined; }
  switch (column.kind) {
    case 'integer':
    case 'number': return typeof value === 'number' ? NUMBER.format(value) : plain(value);
    case 'boolean': return value === true ? 'Yes' : value === false ? 'No' : plain(value);
    case 'datetime': {
      const at = typeof value === 'number' || typeof value === 'string' ? new Date(value) : undefined;
      return at !== undefined && !Number.isNaN(at.getTime()) ? DATETIME.format(at) : plain(value);
    }
    case 'binary': return typeof value === 'string' ? `${Math.floor((value.length * 3) / 4)} bytes` : 'binary';
    case 'text':
    case 'date':
    case 'time':
    case 'uuid':
    case 'json': return plain(value);
  }
}

/** A value as plain text: strings as they are, anything else as compact JSON. */
function plain(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Compare two cells of a column: empty cells last whatever the direction, numbers by value, text by locale. */
export function compareCells(a: Json | undefined, b: Json | undefined, dir: ResultSort['dir']): number {
  const emptyA = a === null || a === undefined;
  const emptyB = b === null || b === undefined;
  if (emptyA || emptyB) { return emptyA === emptyB ? 0 : emptyA ? 1 : -1; }
  const order = typeof a === 'number' && typeof b === 'number' ? a - b
    : typeof a === 'boolean' && typeof b === 'boolean' ? Number(a) - Number(b)
      : plain(a).localeCompare(plain(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? order : -order;
}

/** The rows in a sort's order (a new array; the table is left alone). Unknown columns leave the order as it was. */
export function sortRows(table: Pick<ResultTable, 'columns' | 'rows'>, sort: ResultSort | undefined): readonly (readonly Json[])[] {
  if (sort === undefined) { return table.rows; }
  const at = table.columns.findIndex((c) => c.name === sort.column);
  if (at < 0) { return table.rows; }
  return [...table.rows].sort((a, b) => compareCells(a[at], b[at], sort.dir));
}

/** The sort a header click asks for: ascending first, then descending, then back to how the table came. */
export function nextSort(current: ResultSort | undefined, column: string): ResultSort | undefined {
  if (current?.column !== column) { return { column, dir: 'asc' }; }
  return current.dir === 'asc' ? { column, dir: 'desc' } : undefined;
}

/** Whether the rows held are the whole result, so sorting and paging need no new call. */
export function isComplete(table: Pick<ResultTable, 'offset' | 'truncated'>): boolean {
  return table.offset === 0 && !table.truncated;
}

/** One page of the grid: its rows, where they sit in the whole result, and how to move. */
export interface GridWindow {
  readonly rows: readonly (readonly Json[])[];
  /** 1-based position of the first and last row shown in the whole result (0 and 0 when empty). */
  readonly from: number;
  readonly to: number;
  /** The whole result's size when known ("of 120"), else what is held and whether more exists. */
  readonly total: number | undefined;
  /** Move within the rows held. */
  readonly canPrev: boolean;
  readonly canNext: boolean;
  /** Past the rows held: what to ask the fn for, when it can be asked. */
  readonly fetchPrev: PageRequest | undefined;
  readonly fetchNext: PageRequest | undefined;
}

/**
 * The rows a page of the grid shows. `page` counts pages of `size` within the rows held; past the last one (when the
 * result was truncated) or before the first (when it starts past 0), the window says what to ask the fn for instead.
 */
export function gridWindow(table: ResultTable, rows: readonly (readonly Json[])[], page: number, size = GRID_PAGE): GridWindow {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(Math.max(0, page), pages - 1);
  const shown = rows.slice(at * size, at * size + size);
  const limit = table.limit ?? Math.max(rows.length, size);
  const sort = table.sort;
  return {
    rows: shown,
    from: shown.length === 0 ? 0 : table.offset + at * size + 1,
    to: table.offset + at * size + shown.length,
    total: table.total,
    canPrev: at > 0,
    canNext: at < pages - 1,
    fetchPrev: at === 0 && table.offset > 0 ? { offset: Math.max(0, table.offset - limit), limit, sort } : undefined,
    fetchNext: at === pages - 1 && table.truncated ? { offset: table.offset + rows.length, limit, sort } : undefined,
  };
}

/** "1–25 of 120", "1–25 of 50+" (more exist, uncounted), "No rows". */
export function windowLabel(window: Pick<GridWindow, 'from' | 'to' | 'total'>, truncated: boolean): string {
  if (window.to === 0) { return 'No rows'; }
  const of = window.total !== undefined ? NUMBER.format(window.total) : `${NUMBER.format(window.to)}${truncated ? '+' : ''}`;
  return `${NUMBER.format(window.from)}–${NUMBER.format(window.to)} of ${of}`;
}

/** A field as CSV (RFC 4180): quoted when it holds a comma, quote, line break or edge space. */
function csvField(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A cell as CSV: raw values (numbers unformatted, JSON compact), empty for null. */
function csvCell(value: Json | undefined): string {
  if (value === null || value === undefined) { return ''; }
  return csvField(typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));
}

/** The rows held as CSV, a header row of column names first, lines ending in CRLF. */
export function toCsv(table: Pick<ResultTable, 'columns'>, rows: readonly (readonly Json[])[]): string {
  const lines = [table.columns.map((c) => csvField(c.name)).join(','), ...rows.map((row) => table.columns.map((_, i) => csvCell(row[i])).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/** The rows held as JSON: an array of objects keyed by column name (empty cells `null`), indented for reading. */
export function toJson(table: Pick<ResultTable, 'columns'>, rows: readonly (readonly Json[])[]): string {
  const objects = rows.map((row) => Object.fromEntries(table.columns.map((column, i) => [column.name, row[i] ?? null])));
  return `${JSON.stringify(objects, null, 2)}
`;
}

/** A file name for a table's CSV, from its title: lower case, words joined by dashes. */
export function csvFileName(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base === '' ? 'results' : base}.csv`;
}
