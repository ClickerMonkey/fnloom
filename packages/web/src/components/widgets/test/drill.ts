/**
 * Drill-down samples (build-9 feedback, drill-downs through the query), shared by the component tests and the mock
 * hub (`e2e/mockDrill.ts`): the chart gallery's grouped results made drillable as the database system's would be
 * (`ResultTable.drill` naming `database/drill_down`, the source fn and its args, and the group key columns), and the rows
 * behind one group as `database/drill_down` gives them, a page at a time with a total. Plain values only.
 */
import { Json, QualifiedName, type ResultColumn, type ResultTable } from '@harness/core';
import { z } from 'zod';
import { CHART_SAMPLES } from '../../visuals/test/samples.ts';
import type { ChartFamily } from '../../visuals/families/index.ts';

/** The database's drill fn. */
export const DRILL_FN = QualifiedName.parse('database/drill_down');

/** The saved query the gallery's results come from. */
export const DRILL_SOURCE = QualifiedName.parse('database/shop.sample');

/** The rows `drill_down` reads a page of when the call gives no `limit` (smaller than the database's, so paging shows). */
export const DRILL_PAGE = 20;

/** The gallery's grouped results, by family, and the columns each groups by (the rest are measures). */
export const DRILL_KEYS: Readonly<Partial<Record<ChartFamily, readonly string[]>>> = {
  part: ['city'], category: ['city'], time: ['day', 'shop'], crosstab: ['month', 'shop'], calendar: ['day'],
};

/** Whether a name is one of the gallery's chart families. */
function isFamily(name: unknown): name is ChartFamily {
  return typeof name === 'string' && Object.hasOwn(CHART_SAMPLES, name);
}

/** A gallery result as a grouped query's: drillable through the query when its family groups, else as it was. */
export function drillableSample(family: string, table: ResultTable): ResultTable {
  const keys = isFamily(family) ? DRILL_KEYS[family] : undefined;
  return keys === undefined ? table : { ...table, drill: { fn: DRILL_FN, args: { fn: DRILL_SOURCE, args: { family } }, keys: [...keys] } };
}

/** `database/drill_down`'s args, as the mock reads them (the database system's `DrillArgs`). */
const DrillArgs = z.object({
  fn: z.string(), args: z.record(z.string(), Json).optional(), group: z.record(z.string(), Json),
  limit: z.number().int().min(1).optional(), offset: z.number().int().min(0).optional(),
});

const CUSTOMERS = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli'] as const;

/** How many rows stand behind a group: its first measure, at most 120 (a calendar's steps are not rows). */
function behind(table: ResultTable, row: readonly Json[], keys: readonly string[]): number {
  const at = table.columns.findIndex((column) => !keys.includes(column.name) && (column.kind === 'integer' || column.kind === 'number'));
  const value = at < 0 ? undefined : row[at];
  return typeof value === 'number' ? Math.max(1, Math.min(120, Math.round(value))) : 3;
}

/**
 * The rows behind one group of a gallery result, as `database/drill_down` reads them: each order with its id, the
 * group's keys, its customer, amount and day; a page from `offset` (`DRILL_PAGE` rows when no `limit`), counted.
 * Undefined for a call that isn't a gallery drill, or a group no row of it stands for.
 */
export function drilledRows(args: Json): ResultTable | undefined {
  const parsed = DrillArgs.safeParse(args);
  if (!parsed.success || parsed.data.fn !== DRILL_SOURCE) { return undefined; }
  const family = parsed.data.args?.['family'];
  const keys = isFamily(family) ? DRILL_KEYS[family] : undefined;
  const table = isFamily(family) ? CHART_SAMPLES[family] : undefined;
  if (keys === undefined || table === undefined) { return undefined; }
  const group = parsed.data.group;
  const row = table.rows.find((candidate) => keys.every((key) => candidate[table.columns.findIndex((column) => column.name === key)] === group[key]));
  if (row === undefined) { return undefined; }
  const total = behind(table, row, keys);
  const keyColumns = keys.map((key): ResultColumn => table.columns.find((column) => column.name === key) ?? { name: key, kind: 'text', nullable: true });
  const columns: ResultColumn[] = [
    { name: 'id', kind: 'integer', nullable: false, key: true }, ...keyColumns,
    { name: 'customer', kind: 'text', nullable: false }, { name: 'amount', kind: 'number', nullable: false }, { name: 'placed', kind: 'date', nullable: false },
  ];
  const offset = parsed.data.offset ?? 0;
  const limit = parsed.data.limit ?? DRILL_PAGE;
  const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, at): Json[] => {
    const n = offset + at;
    return [n + 1, ...keys.map((key) => group[key] ?? null), CUSTOMERS[n % CUSTOMERS.length] ?? 'Ada', ((n * 37) % 90) + 10.5, `2026-10-${String((n % 28) + 1).padStart(2, '0')}`];
  });
  return { columns, rows, offset, limit, total, truncated: offset + rows.length < total, sort: [] };
}
