/**
 * Rows read by a query as the `ResultTable` the person is shown (the `result` attachment): the query's columns, the
 * engine's `$total` taken out as the table's total, and whether more rows exist past the page. The model's view of it
 * is the SDK's `resultBlock`.
 */
import type { Json, ResultColumn, ResultTable } from '@harness/core';
import type { CallPlan } from './compile.ts';
import type { Rows } from './drivers/index.ts';

/** The engine's total column, present on a counted list. */
const TOTAL_COLUMN = '$total';

/** Rows as a result table: the query's columns (by name where it knows them), and the total split off. */
export function resultTable(read: Rows, columns: readonly ResultColumn[], plan: Pick<CallPlan, 'offset' | 'limit' | 'sort'>): ResultTable {
  const totalAt = read.columns.indexOf(TOTAL_COLUMN);
  const keep = read.columns.map((_, index) => index).filter((index) => index !== totalAt);
  const known = new Map(columns.map((column) => [column.name, column]));
  const tableColumns: ResultColumn[] = keep.map((index) => {
    const name = read.columns[index] ?? `column_${index + 1}`;
    return known.get(name) ?? { name, kind: 'text', nullable: true };
  });
  const rows: Json[][] = read.rows.map((row) => keep.map((index) => row[index] ?? null));
  const firstTotal = totalAt < 0 ? undefined : read.rows[0]?.[totalAt];
  // an empty page has no row to carry the count: past the end, or nothing matched
  const total = totalAt < 0 ? undefined : typeof firstTotal === 'number' ? firstTotal : plan.offset === 0 ? 0 : undefined;
  const more = total === undefined ? plan.limit !== undefined && rows.length >= plan.limit : plan.offset + rows.length < total;
  return {
    columns: tableColumns,
    rows,
    offset: plan.offset,
    ...(plan.limit === undefined ? {} : { limit: plan.limit }),
    ...(total === undefined ? {} : { total }),
    truncated: more,
    sort: [...plan.sort],
  };
}
