/**
 * The generic evaluator of the query standard: a `ListQuery` over rows already read, by the list's field accessors.
 * Every list source reads its rows (bounded, narrowed to what the viewer may see) and leaves the filters, free text,
 * sort and page to this, so every list behaves the same.
 */
import { fieldOf, LIST_FIELDS, sortOf, type FieldDecl, type FieldValueOption, type Filter, type FilterValue, type ListField, type ListName, type ListQuery, type Page, type Sort } from '@harness/core';
import type { FieldAccessors } from './index.ts';

/** What an accessor reads off a row. */
export type FieldReading = string | number | boolean | readonly string[] | undefined;

/** One field's reader by its key, for a loop over a query's field names (each name checked against the list first). */
export function readerOf<L extends ListName, Row>(fields: FieldAccessors<L, Row>, list: L, field: string): ((row: Row) => FieldReading) | undefined {
  if (fieldOf(list, field) === undefined) { return undefined; }
  const readers: Readonly<Record<string, (row: Row) => FieldReading>> = fields;
  return readers[field];
}

/** A filter value as a number: numbers as they are, dates and numbers written as text parsed. */
export function numberOf(value: FilterValue): number | undefined {
  if (typeof value === 'number') { return value; }
  if (typeof value === 'boolean') { return undefined; }
  const plain = Number(value);
  if (value.trim() !== '' && Number.isFinite(plain)) { return plain; }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

/** Whether one reading equals a filter value: text without case (exact for enums), numbers as numbers, flags as flags. */
function equals(reading: string | number | boolean, value: FilterValue, decl: FieldDecl): boolean {
  if (typeof reading === 'boolean') { return reading === (typeof value === 'boolean' ? value : String(value) === 'true'); }
  if (typeof reading === 'number') { return reading === numberOf(value); }
  return decl.type === 'text' ? reading.toLowerCase() === String(value).toLowerCase() : reading === String(value);
}

/** Whether a reading is empty: absent, blank text or no values. */
function isEmpty(reading: FieldReading): boolean {
  return reading === undefined || reading === '' || (Array.isArray(reading) && reading.length === 0);
}

/** The single readings of a reading (a list's values, or the one value). */
function each(reading: FieldReading): ReadonlyArray<string | number | boolean> {
  if (reading === undefined) { return []; }
  if (typeof reading === 'string' || typeof reading === 'number' || typeof reading === 'boolean') { return [reading]; }
  return reading;
}

/** Compare a reading with a bound: undefined when it can't be compared (not a number, or no number in the filter). */
function compare(reading: string | number | boolean, value: FilterValue): number | undefined {
  const bound = numberOf(value);
  if (typeof reading === 'number' && bound !== undefined) { return reading - bound; }
  if (typeof reading === 'string' && typeof value === 'string') { return reading.localeCompare(value); }
  return undefined;
}

/** Whether a row's reading passes one filter. A list field passes when any of its values does (none, for negations). */
export function passes(reading: FieldReading, filter: Filter, decl: FieldDecl): boolean {
  const values = each(reading);
  switch (filter.op) {
    case 'empty': return isEmpty(reading);
    case 'notEmpty': return !isEmpty(reading);
    case 'is': return values.some((v) => equals(v, filter.value, decl));
    case 'isNot': return !values.some((v) => equals(v, filter.value, decl));
    case 'in': return values.some((v) => filter.values.some((w) => equals(v, w, decl)));
    case 'notIn': return !values.some((v) => filter.values.some((w) => equals(v, w, decl)));
    case 'contains': {
      const needle = String(filter.value).toLowerCase();
      return values.some((v) => String(v).toLowerCase().includes(needle));
    }
    case 'between': return values.some((v) => (compare(v, filter.from) ?? -1) >= 0 && (compare(v, filter.to) ?? 1) <= 0);
    case 'gt': return values.some((v) => (compare(v, filter.value) ?? 0) > 0);
    case 'gte': return values.some((v) => { const c = compare(v, filter.value); return c !== undefined && c >= 0; });
    case 'lt': return values.some((v) => (compare(v, filter.value) ?? 0) < 0);
    case 'lte': return values.some((v) => { const c = compare(v, filter.value); return c !== undefined && c <= 0; });
  }
}

/** Order two readings: absent first ascending (last descending, as the store orders), then by value. */
function order(a: FieldReading, b: FieldReading): number {
  if (a === undefined || b === undefined) { return a === b ? 0 : a === undefined ? -1 : 1; }
  const left = typeof a === 'object' ? a.join(', ') : a;
  const right = typeof b === 'object' ? b.join(', ') : b;
  if (typeof left === 'number' && typeof right === 'number') { return left - right; }
  if (typeof left === 'boolean' && typeof right === 'boolean') { return Number(left) - Number(right); }
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base', numeric: true });
}

/** The text free text matches: every text and enum field's readings, plus what the source adds. */
function textOf<L extends ListName, Row>(fields: FieldAccessors<L, Row>, list: L, row: Row, extra: ((row: Row) => string) | undefined): string {
  const parts: string[] = [];
  const decls: Readonly<Record<string, FieldDecl>> = LIST_FIELDS[list].fields;
  for (const [key, decl] of Object.entries(decls)) {
    if (decl.type !== 'text' && decl.type !== 'enum') { continue; }
    for (const value of each(readerOf(fields, list, key)?.(row))) { parts.push(String(value)); }
  }
  if (extra !== undefined) { parts.push(extra(row)); }
  return parts.join('\n').toLowerCase();
}

/** How an evaluation runs: the list, its accessors, and the source's extra searchable text. */
export interface Evaluation<L extends ListName, Row> {
  readonly list: L;
  readonly fields: FieldAccessors<L, Row>;
  /** More text free text matches (a fn's description, a run's args), beside the text fields. */
  readonly search?: ((row: Row) => string) | undefined;
}

/** The rows a query keeps: every filter holds and every word of the free text appears. */
export function filterRows<L extends ListName, Row>(rows: readonly Row[], query: ListQuery, how: Evaluation<L, Row>): Row[] {
  const words = query.text?.toLowerCase().split(/\s+/).filter((word) => word !== '') ?? [];
  const checks = (query.filters ?? []).flatMap((filter) => {
    const decl = fieldOf(how.list, filter.field);
    const read = readerOf(how.fields, how.list, filter.field);
    return decl === undefined || read === undefined ? [] : [(row: Row) => passes(read(row), filter, decl)];
  });
  return rows.filter((row) => checks.every((check) => check(row)) && (words.length === 0 || words.every((word) => textOf(how.fields, how.list, row, how.search).includes(word))));
}

/** Rows in a sort's order (stable: rows equal on every key keep the order they were read in). */
export function sortRows<L extends ListName, Row>(rows: readonly Row[], sort: readonly Sort[], how: Evaluation<L, Row>): Row[] {
  const keys = sort.flatMap((key) => {
    const read = readerOf(how.fields, how.list, key.field);
    return read === undefined ? [] : [{ read, sign: key.dir === 'asc' ? 1 : -1 }];
  });
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const key of keys) {
        const c = order(key.read(a.row), key.read(b.row));
        if (c !== 0) { return c * key.sign; }
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/** The page a cursor points at: cursors are offsets into the sorted rows. */
export function pageRows<Row>(rows: readonly Row[], cursor: string | undefined, limit: number): Page<Row> {
  const start = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const end = start + limit;
  return { items: rows.slice(start, end), ...(end < rows.length ? { cursor: String(end) } : {}) };
}

/** A whole query over rows read: filtered, sorted (`sortOf`), paged. `total` is how many matched. */
export function evaluate<L extends ListName, Row>(rows: readonly Row[], query: ListQuery, how: Evaluation<L, Row>, limit: number): Page<Row> & { total: number } {
  const kept = sortRows(filterRows(rows, query, how), sortOf(how.list, query), how);
  return { ...pageRows(kept, query.cursor, query.limit ?? limit), total: kept.length };
}

/** The values a field takes over rows, with counts, those with a word starting with the prefix (case aside), most common first. */
export function valuesOf<L extends ListName, Row>(rows: readonly Row[], how: Evaluation<L, Row>, field: ListField<L>, prefix: string | undefined, limit: number): FieldValueOption[] {
  const read = readerOf(how.fields, how.list, field);
  const decl = fieldOf(how.list, field);
  if (read === undefined || decl === undefined) { return []; }
  const counts = new Map<string | number | boolean, number>();
  for (const value of decl.values ?? []) { counts.set(value, 0); }
  for (const row of rows) {
    for (const value of each(read(row))) { counts.set(value, (counts.get(value) ?? 0) + 1); }
  }
  const start = prefix?.toLowerCase() ?? '';
  return [...counts.entries()]
    .filter(([value]) => start === '' || String(value).toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith(start)) || String(value).toLowerCase().startsWith(start))
    .sort((a, b) => b[1] - a[1] || order(a[0], b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}
