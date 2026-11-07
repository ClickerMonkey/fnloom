/** Reading many rows through the store's bounded, paged reads. */
import type { Table, Where } from '../store/index.ts';

/** The page size used when reading every matching row. */
export const PAGE = 200;

/** Every row matching `where`, read page by page (the store never reads a whole table at once). */
export async function allRows<Row>(table: Table<Row>, where?: Where<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await table.find({ ...(where === undefined ? {} : { where }), limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}
