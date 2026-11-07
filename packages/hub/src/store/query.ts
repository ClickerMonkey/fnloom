/**
 * Filters, orders and cursors as SQL. Filters and orders are checked against the table's layout at runtime too (the
 * types already refuse non-scalar fields), and every value is encoded the way its column stores it.
 *
 * Paging is by keyset: a cursor holds the order values and key of the last row of a page, and the next page starts
 * strictly after it, so rows inserted while paging never shift a page. Absent values sort first ascending and last
 * descending (`NULLS FIRST` / `NULLS LAST`, the same on SQLite and Postgres).
 */
import { type RawBuilder, type SqlBool, sql } from 'kysely';
import { z } from 'zod';
import { encodeCell } from './codec.ts';
import type { StoredRow } from './db.ts';
import { StoreError } from './errors.ts';
import { type ColumnKind, KEY_COLUMN, type Layout, isScalarKind } from './schema.ts';

/** A condition. */
export type Condition = RawBuilder<SqlBool>;

const TRUE: Condition = sql<SqlBool>`1 = 1`;
const FALSE: Condition = sql<SqlBool>`1 = 0`;

/** The operator forms of a column filter; anything that isn't an object is an equality. */
const Operator = z.union([
  z.strictObject({ in: z.array(z.unknown()) }),
  z.strictObject({ gt: z.unknown() }),
  z.strictObject({ gte: z.unknown() }),
  z.strictObject({ lt: z.unknown() }),
  z.strictObject({ lte: z.unknown() }),
  z.strictObject({ exists: z.boolean() }),
]);

/** A filter object seen as plain fields. */
const FilterFields = z.record(z.string(), z.unknown());

/** One column of an order. */
export interface OrderColumn {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

const ref = (column: string) => sql.ref(column);

/** Joins conditions with `and` (true when there are none). */
export function all(conditions: readonly Condition[]): Condition {
  return conditions.length === 0 ? TRUE : sql<SqlBool>`(${sql.join(conditions, sql` and `)})`;
}

function any(conditions: readonly Condition[]): Condition {
  return conditions.length === 0 ? FALSE : sql<SqlBool>`(${sql.join(conditions, sql` or `)})`;
}

function scalarKind(table: string, layout: Layout, column: string): ColumnKind {
  const kind = column === KEY_COLUMN ? 'text' : layout.get(column);
  if (kind === undefined) throw new StoreError('bad-query', `table ${table} has no column ${column}`);
  if (!isScalarKind(kind)) throw new StoreError('bad-query', `table ${table}: ${column} is stored as JSON and can't be filtered or ordered`);
  return kind;
}

/** The condition of a `Where`: every given column must match. */
export function whereCondition(table: string, layout: Layout, where: unknown): Condition {
  if (where === undefined) return TRUE;
  const conditions: Condition[] = [];
  for (const [column, filter] of Object.entries(FilterFields.parse(where))) {
    if (filter === undefined) continue;
    const kind = scalarKind(table, layout, column);
    const value = (v: unknown) => encodeCell(kind, v, `${table}.${column}`, 'bad-query');
    if (typeof filter !== 'object' || filter === null) {
      conditions.push(sql<SqlBool>`${ref(column)} = ${value(filter)}`);
      continue;
    }
    const op = Operator.safeParse(filter);
    if (!op.success) throw new StoreError('bad-query', `table ${table}: ${JSON.stringify(filter)} is not a filter on ${column}`);
    const f = op.data;
    if ('in' in f) conditions.push(f.in.length === 0 ? FALSE : sql<SqlBool>`${ref(column)} in (${sql.join(f.in.map(value))})`);
    else if ('gt' in f) conditions.push(sql<SqlBool>`${ref(column)} > ${value(f.gt)}`);
    else if ('gte' in f) conditions.push(sql<SqlBool>`${ref(column)} >= ${value(f.gte)}`);
    else if ('lt' in f) conditions.push(sql<SqlBool>`${ref(column)} < ${value(f.lt)}`);
    else if ('lte' in f) conditions.push(sql<SqlBool>`${ref(column)} <= ${value(f.lte)}`);
    else conditions.push(f.exists ? sql<SqlBool>`${ref(column)} is not null` : sql<SqlBool>`${ref(column)} is null`);
  }
  return all(conditions);
}

/** The full order of a query: the given columns, then the key, so every row has one place. */
export function orderColumns(table: string, layout: Layout, order: ReadonlyArray<readonly [string, 'asc' | 'desc']> | undefined): OrderColumn[] {
  const columns = (order ?? []).map(([column, direction]) => {
    scalarKind(table, layout, column);
    return { column, direction };
  });
  return [...columns, { column: KEY_COLUMN, direction: 'asc' }];
}

/** The `order by` items, with explicit null placement. */
export function orderBy(columns: readonly OrderColumn[]): RawBuilder<unknown> {
  return sql.join(columns.map(({ column, direction }) => (direction === 'asc' ? sql`${ref(column)} asc nulls first` : sql`${ref(column)} desc nulls last`)));
}

/** A cursor: the order it was made for, and the last row's values in that order. */
const CursorValue = z.union([z.string(), z.number(), z.null()]);
const CursorBody = z.object({ order: z.string(), values: z.array(CursorValue) });
type CursorBody = z.infer<typeof CursorBody>;

const orderSignature = (table: string, columns: readonly OrderColumn[]): string =>
  [table, ...columns.map((c) => `${c.column}:${c.direction}`)].join(',');

/** The cursor that continues after `row`. */
export function makeCursor(table: string, columns: readonly OrderColumn[], row: StoredRow): string {
  const values = columns.map(({ column }) => CursorValue.parse(row[column] ?? null));
  const body: CursorBody = { order: orderSignature(table, columns), values };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

/** The condition "strictly after the cursor's row", in the query's order. */
export function afterCursor(table: string, columns: readonly OrderColumn[], cursor: string | undefined): Condition {
  if (cursor === undefined) return TRUE;
  const body = readCursor(cursor);
  if (body.order !== orderSignature(table, columns) || body.values.length !== columns.length) {
    throw new StoreError('bad-cursor', `the cursor was made for another query (${body.order})`);
  }
  // after = gt₁ or (eq₁ and (gt₂ or (eq₂ and … gtₙ)))
  let condition = FALSE;
  for (let i = columns.length - 1; i >= 0; i--) {
    const column = columns[i];
    const value = body.values[i];
    if (column === undefined || value === undefined) continue;
    const { greater, equal } = compare(column, value);
    condition = i === columns.length - 1 ? greater : any([greater, all([equal, condition])]);
  }
  return condition;
}

function readCursor(cursor: string): CursorBody {
  try {
    return CursorBody.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch (error) {
    throw new StoreError('bad-cursor', 'the cursor is not one this store issued', { cause: error });
  }
}

/** "Comes after `value`" and "equals `value`" for one order column, with nulls first ascending and last descending. */
function compare({ column, direction }: OrderColumn, value: string | number | null): { greater: Condition; equal: Condition } {
  const c = ref(column);
  if (value === null) {
    return { greater: direction === 'asc' ? sql<SqlBool>`${c} is not null` : FALSE, equal: sql<SqlBool>`${c} is null` };
  }
  return {
    greater: direction === 'asc' ? sql<SqlBool>`${c} > ${value}` : sql<SqlBool>`(${c} < ${value} or ${c} is null)`,
    equal: sql<SqlBool>`${c} = ${value}`,
  };
}
