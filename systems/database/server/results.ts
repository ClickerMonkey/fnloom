/**
 * Rows read by a query as the `ResultTable` the person is shown (the `result` attachment): the query's columns, the
 * engine's `$total` taken out as the table's total, and whether more rows exist past the page. No table holds more than
 * the plan's cap (`DATABASE_MAX_ROWS`); rows past it are cut and the table says it is truncated. The model's view of it
 * is the SDK's `resultBlock`, worded for whether a person is watching (`modelBlock`).
 */
import type { Json, ResultColumn, ResultTable } from '@harness/core';
import type { ResultBlock } from '@harness/sdk';
import { resultBlock, type ResultBlockOptions } from '@harness/sdk/server';
import type { CallPlan } from './compile.ts';
import type { Rows } from './drivers/index.ts';

/** The engine's total column, present on a counted list. */
const TOTAL_COLUMN = '$total';

/** Rows as a result table: the query's columns (by name where it knows them), and the total split off. */
export function resultTable(read: Rows, columns: readonly ResultColumn[], plan: Pick<CallPlan, 'offset' | 'limit' | 'sort' | 'cap'>): ResultTable {
  const totalAt = read.columns.indexOf(TOTAL_COLUMN);
  const keep = read.columns.map((_, index) => index).filter((index) => index !== totalAt);
  const known = new Map(columns.map((column) => [column.name, column]));
  const tableColumns: ResultColumn[] = keep.map((index) => {
    const name = read.columns[index] ?? `column_${index + 1}`;
    return known.get(name) ?? { name, kind: 'text', nullable: true };
  });
  const cut = read.rows.length > plan.cap;
  const rows: Json[][] = read.rows.slice(0, plan.cap).map((row) => keep.map((index) => row[index] ?? null));
  const firstTotal = totalAt < 0 ? undefined : read.rows[0]?.[totalAt];
  // an empty page has no row to carry the count: past the end, or nothing matched
  const total = totalAt < 0 ? undefined : typeof firstTotal === 'number' ? firstTotal : plan.offset === 0 ? 0 : undefined;
  const more = cut || (total === undefined ? plan.limit !== undefined && rows.length >= plan.limit : plan.offset + rows.length < total);
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

/**
 * The model's view of rows read: the SDK's result block when a person is watching (the rows are shown to them), else
 * the same block worded headless. With nobody watching (a nested agent, an MCP call, a background run) the rows are
 * kept with the run but shown to no one, so the model is told to use the sample itself.
 */
export function modelBlock(table: ResultTable, options: ResultBlockOptions, watched: boolean | undefined): ResultBlock {
  const block = resultBlock(table, options);
  if (watched === true) { return block; }
  const { sampleNote: _shownNote, ...rest } = block;
  const counted = block.total !== undefined && block.total > block.rowCount ? ` (of ${block.total})` : '';
  const more = block.nextPage === undefined ? '' : ` There are more rows: ${block.nextPage.call} reads the next ${block.nextPage.limit}.`;
  const shown = block.rowCount === 0
    ? 'No rows matched. Nobody is watching this run, so say so in your answer.'
    : `${block.rowCount === 1 ? 'One row was' : `${block.rowCount} rows${counted} were`} read. Nobody is watching this run, so no one sees them: answer from the sample.${more}`;
  return block.sample.length < block.rowCount
    ? { ...rest, shown, sampleNote: `The sample holds the first ${block.sample.length} of the ${block.rowCount} rows read.` }
    : { ...rest, shown };
}
