/**
 * Tables for the table viewer: a converted version's tables (a workbook's sheets, a csv's rows, as
 * `@aeye/resources` makes them), or the raw text of a csv or tsv file read here when the hub hasn't converted it.
 * The viewer sorts and filters rows and pages through them; column kinds come from the library's `columnKinds`, so
 * numbers sort as numbers. Pure, so it is tested alone.
 */
import { columnKinds, type ColumnKind } from '@aeye/resources/versions';
import type { ConvertedVersion } from '@harness/core';

/** One table of a converted version: its name, sheet, headers and rows of string cells. */
export type Table = Extract<ConvertedVersion, { kind: 'table' }>['tables'][number];

export type { ColumnKind };

/** Read delimited text (csv, tsv) into a table: quoted cells, doubled quotes and line breaks inside quotes; the first row is the header. */
export function parseDelimited(text: string, delimiter: ',' | '\t', name?: string): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') { quoted = false; } else { cell += ch; }
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') { i++; }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  const [headers = [], ...body] = rows;
  return { ...(name === undefined ? {} : { name }), headers, rows: body };
}

/** The delimiter of a delimited format. */
export function delimiterOf(format: string | undefined): ',' | '\t' {
  return format === 'tsv' ? '\t' : ',';
}

/** How the table viewer orders and narrows rows. */
export interface TableView {
  /** The column sorted by, and which way; none keeps the table's order. */
  readonly sort?: { readonly column: number; readonly descending: boolean };
  /** Words every shown row has somewhere in its cells (case does not matter). */
  readonly filter: string;
}

/** Compare two cells of a column by its kind: numbers and dates by value, the rest as text. */
function compare(a: string, b: string, kind: ColumnKind): number {
  if (kind === 'integer' || kind === 'number') { return (Number(a) || 0) - (Number(b) || 0); }
  if (kind === 'date') { return (Date.parse(a) || 0) - (Date.parse(b) || 0); }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** A table's rows filtered and sorted, each with its row number in the table (from 1), so the viewer can show it. */
export function viewRows(table: Table, view: TableView, kinds: readonly ColumnKind[] = columnKinds(table)): { readonly number: number; readonly cells: readonly string[] }[] {
  const words = view.filter.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  const rows = table.rows.map((cells, i) => ({ number: i + 1, cells })).filter((row) => words.every((w) => row.cells.some((cell) => cell.toLowerCase().includes(w))));
  const sort = view.sort;
  if (sort === undefined) { return rows; }
  const kind = kinds[sort.column] ?? 'text';
  return rows.sort((x, y) => {
    const order = compare(x.cells[sort.column] ?? '', y.cells[sort.column] ?? '', kind);
    return sort.descending ? -order : order;
  });
}

/** A table's column kinds (from `@aeye/resources`). */
export function kindsOf(table: Table): ColumnKind[] {
  return columnKinds(table);
}

/** Whether a column holds numbers, so its cells line up on the right. */
export function isNumeric(kind: ColumnKind | undefined): boolean {
  return kind === 'integer' || kind === 'number';
}

/** The next sort after a click on a column's header: ascending, then descending, then the table's order. */
export function nextSort(current: TableView['sort'], column: number): TableView['sort'] {
  if (current?.column !== column) { return { column, descending: false }; }
  return current.descending ? undefined : { column, descending: true };
}
