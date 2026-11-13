/**
 * Reading many rows through the store's bounded, paged reads. The store never reads a whole table at once, so
 * anything that must see every matching row (policies, a system's items, a run's children) goes through here
 * instead of its own cursor loop. Every read names its filter in `query.where`; reads of a whole table are for
 * small, bounded tables only (providers, systems, rules).
 */
import { reject } from '@ayepi/core';
import type { Page } from '@harness/core';
import type { Table, TableQuery, Where } from './index.ts';

/** How many rows one page read returns. */
export const PAGE = 500;

/** A read with no page size or cursor: those are this module's job. */
export type RowsQuery<Row> = Omit<TableQuery<Row>, 'limit' | 'cursor'>;

/** Every row a query matches, page by page, in the query's order. */
export async function* rows<Row, Key>(table: Table<Row, Key>, query: RowsQuery<Row> = {}): AsyncGenerator<Row> {
  let cursor: string | undefined;
  do {
    const page = await table.find({ ...query, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    yield* page.items;
    cursor = page.cursor;
  } while (cursor !== undefined);
}

/** Every row a query matches, as an array. */
export async function allRows<Row, Key>(table: Table<Row, Key>, query: RowsQuery<Row> = {}): Promise<Row[]> {
  const out: Row[] = [];
  for await (const row of rows(table, query)) { out.push(row); }
  return out;
}

/** The first row a query matches that also passes `match`, reading no further pages once one does. */
export async function firstRow<Row, Key, Match extends Row>(table: Table<Row, Key>, query: RowsQuery<Row>, match: (row: Row) => row is Match): Promise<Match | undefined>;
export async function firstRow<Row, Key>(table: Table<Row, Key>, query: RowsQuery<Row>, match: (row: Row) => boolean): Promise<Row | undefined>;
export async function firstRow<Row, Key>(table: Table<Row, Key>, query: RowsQuery<Row>, match: (row: Row) => boolean): Promise<Row | undefined> {
  for await (const row of rows(table, query)) {
    if (match(row)) { return row; }
  }
  return undefined;
}

/** The first `max` rows a query matches, in the query's order. */
export async function someRows<Row, Key>(table: Table<Row, Key>, query: RowsQuery<Row>, max: number): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  while (out.length < max) {
    const page = await table.find({ ...query, limit: Math.min(PAGE, max - out.length), ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) { break; }
  }
  return out;
}

/** A cursor into a filtered scan: the store's cursor of a page, and how many rows of that page were already seen. */
function encodeCursor(store: string | undefined, skip: number): string {
  return `${skip}:${store ?? ''}`;
}

/** The store cursor and skip a filtered-scan cursor holds; refused (400) when it isn't one `filteredPage` gave out. */
function decodeCursor(cursor: string | undefined): { store: string | undefined; skip: number } {
  if (cursor === undefined) { return { store: undefined, skip: 0 }; }
  const at = cursor.indexOf(':');
  const skip = Number.parseInt(cursor.slice(0, at), 10);
  if (at < 0 || !Number.isSafeInteger(skip) || skip < 0) { throw reject(400, 'BAD_CURSOR', 'That cursor is not one this list gave out.'); }
  const store = cursor.slice(at + 1);
  return { store: store === '' ? undefined : store, skip };
}

/**
 * A page of the rows that pass `keep`, for a filter the database can't run (who may see a row). The table's own
 * `where` and `order` narrow and order the scan; `keep` drops rows page by page. The cursor is exact (it remembers
 * where in a store page it stopped), and a scan stops after `maxPages` store pages with a cursor to go on from.
 */
export async function filteredPage<Row, Key>(
  table: Table<Row, Key>, query: Omit<TableQuery<Row>, 'cursor'> & { cursor?: string | undefined }, keep: (row: Row) => boolean, maxPages = 20,
): Promise<Page<Row>> {
  let { store, skip } = decodeCursor(query.cursor);
  const items: Row[] = [];
  for (let scanned = 0; scanned < maxPages; scanned++) {
    const page = await table.find({ ...query, ...(store === undefined ? {} : { cursor: store }) });
    for (let i = skip; i < page.items.length; i++) {
      const row = page.items[i];
      if (row === undefined || !keep(row)) { continue; }
      items.push(row);
      if (items.length === query.limit) {
        const more = i + 1 < page.items.length ? encodeCursor(store, i + 1) : page.cursor === undefined ? undefined : encodeCursor(page.cursor, 0);
        return more === undefined ? { items } : { items, cursor: more };
      }
    }
    if (page.cursor === undefined) { return { items }; }
    store = page.cursor;
    skip = 0;
  }
  return { items, cursor: encodeCursor(store, 0) };
}

/** The first `cap` rows matching `where`, and how many more match (for a "+N more" hint). */
export async function cappedRows<Row, Key>(table: Table<Row, Key>, where: Where<Row>, cap: number): Promise<{ rows: Row[]; hidden: number }> {
  const found = await someRows(table, { where }, cap);
  if (found.length < cap) { return { rows: found, hidden: 0 }; }
  return { rows: found, hidden: Math.max(0, (await table.count(where)) - found.length) };
}
