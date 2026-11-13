/**
 * The Data pages' logic (build 8), apart from any component: a stored type's records page read from and written to the
 * URL (words to search, filters, a sort and where the page starts), the hub query it asks with, how a record's row is
 * found in the result table, and the words for a stored type's storage and a record's history.
 */
import {
  Filter, OP_LABELS, QualifiedName, splitName, type DataSetView, type Json, type RecordStorage, type RecordTableQuery, type RecordVersion,
  type ResultTable, type Sort,
} from '@harness/core';
import { z } from 'zod';

/** How many records a page of the grid asks for. */
export const RECORDS_PAGE = 50;

/** The Data page of one stored type's query: words, filters (JSON), sort (`field` or `-field`) and the first row. */
export const RecordsUrl = z.object({
  q: z.string(),
  where: z.string(),
  sort: z.string(),
  at: z.string().regex(/^\d+$/),
}).partial();
export type RecordsUrl = z.infer<typeof RecordsUrl>;

/** The stored types list's query: words and a system. */
export const DataSetsUrl = z.object({ q: z.string(), system: z.string() }).partial();
export type DataSetsUrl = z.infer<typeof DataSetsUrl>;

/** A stored type's qualified name from the route's two parts (`notes` and `Note`). */
export function typeOf(system: string, local: string): QualifiedName | undefined {
  const parsed = QualifiedName.safeParse(`${system}/${local}`);
  return parsed.success ? parsed.data : undefined;
}

/** A stored type's route parts. */
export function typeParts(type: QualifiedName): { readonly system: string; readonly local: string } {
  const { system, local } = splitName(type);
  return { system, local };
}

/** The sort a URL holds (`-title` is title descending); undefined when it holds none. */
export function sortOf(param: string | undefined): Sort | undefined {
  if (param === undefined || param === '' || param === '-') { return undefined; }
  return param.startsWith('-') ? { field: param.slice(1), dir: 'desc' } : { field: param, dir: 'asc' };
}

/** A sort as the URL writes it; '' for none. */
export function sortParam(sort: Sort | undefined): string {
  return sort === undefined ? '' : `${sort.dir === 'desc' ? '-' : ''}${sort.field}`;
}

/** The filters a URL holds; anything that doesn't read as filters is dropped. */
export function filtersOf(param: string | undefined): Filter[] {
  if (param === undefined || param === '') { return []; }
  try {
    const parsed = Filter.array().max(20).safeParse(JSON.parse(param));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Filters as the URL writes them; '' for none. */
export function filtersParam(filters: readonly Filter[]): string {
  return filters.length === 0 ? '' : JSON.stringify(filters);
}

/** A filter as its pill reads: "status is done", "title contains plan". */
export function filterLabel(filter: Filter): string {
  const op = OP_LABELS[filter.op];
  switch (filter.op) {
    case 'in':
    case 'notIn': return `${filter.field} ${op} ${filter.values.join(', ')}`;
    case 'between': return `${filter.field} ${op} ${String(filter.from)} and ${String(filter.to)}`;
    case 'empty':
    case 'notEmpty': return `${filter.field} ${op}`;
    case 'is':
    case 'isNot':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains': return `${filter.field} ${op} ${String(filter.value)}`;
  }
}

/** A filter typed in the filter form: a number when the column holds numbers and the text reads as one. */
export function typedFilter(field: string, op: 'is' | 'contains' | 'gt' | 'lt', text: string, numeric: boolean): Filter {
  const number = Number(text);
  const value = numeric && text.trim() !== '' && Number.isFinite(number) ? number : text;
  return { field, op, value };
}

/** The hub query for a page of a stored type's records, from its URL. */
export function recordTableQuery(type: QualifiedName, url: RecordsUrl, limit = RECORDS_PAGE): RecordTableQuery {
  const sort = sortOf(url.sort);
  const filters = filtersOf(url.where);
  const search = url.q?.trim() ?? '';
  return {
    type,
    ...(search === '' ? {} : { search }),
    ...(filters.length === 0 && sort === undefined ? {} : { query: { ...(filters.length === 0 ? {} : { filters }), ...(sort === undefined ? {} : { sort: [sort] }) } }),
    offset: Number(url.at ?? '0'),
    limit,
  };
}

/** The column of a record table that holds each row's record id (`id`, which refers to the type). */
export const ID_COLUMN = 'id';

/** The record id of a row of a record table; undefined when the table has no id column or the row none. */
export function recordIdOf(table: Pick<ResultTable, 'columns'>, row: readonly Json[]): string | undefined {
  const at = table.columns.findIndex((c) => c.name === ID_COLUMN);
  const value = at < 0 ? undefined : row[at];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A stored type's storage in words: "Many records · each person's own · searched by title, body and meaning". */
export function storageWords(storage: RecordStorage): string {
  const shape = storage.shape === 'table' ? 'Many records' : 'One value';
  const owner = storage.owner === 'person' ? "each person's own" : 'shared';
  const by = [...storage.search.text, ...(storage.search.embed ? ['meaning'] : [])];
  const searched = by.length === 0 ? 'not searched' : `searched by ${by.length === 1 ? (by[0] ?? '') : `${by.slice(0, -1).join(', ')} and ${by.at(-1) ?? ''}`}`;
  return `${shape} · ${owner} · ${searched}`;
}

/** How many records, in words. */
export function recordCount(set: Pick<DataSetView, 'records' | 'storage'>): string {
  if (set.storage.shape === 'value') { return set.records === 0 ? 'Not set' : 'Set'; }
  return `${new Intl.NumberFormat().format(set.records)} ${set.records === 1 ? 'record' : 'records'}`;
}

/** What a version did, in words. */
export const CHANGE_WORDS = { created: 'Created', updated: 'Changed', removed: 'Removed' } as const satisfies Record<RecordVersion['change'], string>;

/** Stored types grouped by system, in the order the hub listed them. */
export function bySystem(sets: readonly DataSetView[]): { readonly system: string; readonly sets: readonly DataSetView[] }[] {
  const groups = new Map<string, DataSetView[]>();
  for (const set of sets) { groups.set(set.system, [...(groups.get(set.system) ?? []), set]); }
  return [...groups].map(([system, list]) => ({ system, sets: list }));
}
