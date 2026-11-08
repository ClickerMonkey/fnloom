/**
 * Reading every row a query matches, a page at a time. The store never reads a whole table at once, so anything
 * that must see all matching rows (policies, rules, a run's children) goes through here instead of its own loop.
 */
import type { Table, TableQuery } from '../store/index.ts';

/** How many rows are read per page. */
export const PAGE = 500;

/** Every row a query matches, page by page, in the query's order. */
export async function* rows<Row, Key>(table: Table<Row, Key>, query: Omit<TableQuery<Row>, 'limit' | 'cursor'> = {}): AsyncGenerator<Row> {
  let cursor: string | undefined;
  do {
    const page = await table.find({ ...query, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    yield* page.items;
    cursor = page.cursor;
  } while (cursor !== undefined);
}

/** Every row a query matches, as an array. */
export async function allRows<Row, Key>(table: Table<Row, Key>, query: Omit<TableQuery<Row>, 'limit' | 'cursor'> = {}): Promise<Row[]> {
  const out: Row[] = [];
  for await (const row of rows(table, query)) out.push(row);
  return out;
}
