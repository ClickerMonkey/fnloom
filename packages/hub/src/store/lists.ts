/**
 * List queries in SQL: a list's filters (`Filter`, the one filter model of `ListQuery`), its sort and its page, run
 * by the database over one hub table, with each list field read where it lives in the row: a scalar column, a value
 * inside a JSON column (`json_extract` with a bound path, so a field never becomes SQL), or an array inside one (a
 * filter matches when any element does, through `json_each`). What an absent value reads as is said per field (an
 * absent origin is `system`, an absent switch is off), so the database compares what the list shows. Free text (`words`)
 * is matched there too: every word appears, any case, in one of the list's text columns. Nothing is loaded to be
 * filtered, matched, sorted or counted.
 */
import { type Filter, type FilterValue, type RowOf, type Sort, type TableName } from '@harness/core';
import { type RawBuilder, type SqlBool, sql } from 'kysely';
import { z } from 'zod';
import { RowCodec } from './codec.ts';
import { CellSchema, type Scope, type StoredRow } from './db.ts';
import { StoreError } from './errors.ts';
import { KEY_COLUMN, TABLE_DEFS, tableLayout } from './schema.ts';

/** Where one list field is read in a table's row. */
export interface ListColumn {
  /** The column: a scalar one, or a JSON one read at `path`. */
  readonly column: string;
  /** A JSON path inside the column (`$.type`, `$.tags`); the column's own value when absent. */
  readonly path?: string;
  /** The value is an array: a filter matches when any element does. */
  readonly each?: true;
  /** What an absent value reads as. */
  readonly absent?: FilterValue;
}

/** One read of a table as a list: filters, sort and page in SQL. */
export interface ListFind<K extends TableName> {
  readonly table: K;
  /** Each list field the filters and sort may name, by field name. */
  readonly fields: Readonly<Record<string, ListColumn>>;
  readonly filters: readonly Filter[];
  readonly sort: readonly Sort[];
  /** Only the rows with these stored keys. */
  readonly keys?: readonly string[] | undefined;
  /** Free text: each of its words must appear, any case, in one of these columns (a list's text fields). */
  readonly words?: { readonly text: string; readonly columns: readonly ListColumn[] } | undefined;
  readonly offset: number;
  readonly limit: number;
}

/** A page of rows and how many match in all. */
export interface ListFound<Row> {
  readonly items: Row[];
  readonly total: number;
}

/** List queries over the hub's tables. */
export interface ListQueries {
  find<K extends TableName>(query: ListFind<K>): Promise<ListFound<RowOf<K>>>;
}

/** A JSON path the queries accept: `$` then dotted plain names, so a path stays a path. */
export const LIST_PATH = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const TRUE = sql<SqlBool>`1 = 1`;

/** A filter value as SQLite compares it (JSON booleans and bool columns read back as 1 and 0). */
export const sqlCell = (value: FilterValue): string | number => (typeof value === 'boolean' ? (value ? 1 : 0) : value);

/** One filter on a value as SQL: the one translation of the filter model, shared by every SQL list read. */
export function filterSql(at: RawBuilder<unknown>, filter: Filter): RawBuilder<SqlBool> {
  switch (filter.op) {
    case 'is': return sql<SqlBool>`${at} = ${sqlCell(filter.value)}`;
    case 'isNot': return sql<SqlBool>`(${at} is null or ${at} <> ${sqlCell(filter.value)})`;
    case 'gt': return sql<SqlBool>`${at} > ${sqlCell(filter.value)}`;
    case 'gte': return sql<SqlBool>`${at} >= ${sqlCell(filter.value)}`;
    case 'lt': return sql<SqlBool>`${at} < ${sqlCell(filter.value)}`;
    case 'lte': return sql<SqlBool>`${at} <= ${sqlCell(filter.value)}`;
    case 'contains': return sql<SqlBool>`instr(lower(cast(${at} as text)), ${String(filter.value).toLowerCase()}) > 0`;
    case 'in': return sql<SqlBool>`${at} in (${sql.join(filter.values.map(sqlCell))})`;
    case 'notIn': return sql<SqlBool>`(${at} is null or ${at} not in (${sql.join(filter.values.map(sqlCell))}))`;
    case 'between': return sql<SqlBool>`${at} between ${sqlCell(filter.from)} and ${sqlCell(filter.to)}`;
    case 'empty': return sql<SqlBool>`(${at} is null or ${at} = '')`;
    case 'notEmpty': return sql<SqlBool>`(${at} is not null and ${at} <> '')`;
  }
}

/** A field checked against the table's layout: its column exists, and a path is read only from a JSON column. */
function checked(table: TableName, name: string, field: ListColumn): ListColumn {
  const kind = tableLayout(table).get(field.column);
  if (kind === undefined) throw new StoreError('bad-query', `table ${table} has no column ${field.column} (field ${name})`);
  if (field.path !== undefined && (kind !== 'json' || !LIST_PATH.test(field.path))) throw new StoreError('bad-query', `table ${table}: ${name} can't be read at ${field.path}`);
  if (field.path === undefined && (kind === 'json' || field.each === true)) throw new StoreError('bad-query', `table ${table}: ${name} needs a path into ${field.column}`);
  return field;
}

/** A field's value as SQL: its column, or the value at its path, read as `absent` when it isn't there. */
function valueOf(field: ListColumn): RawBuilder<unknown> {
  const raw = field.path === undefined ? sql`${sql.ref(field.column)}` : sql`json_extract(${sql.ref(field.column)}, ${field.path})`;
  return field.absent === undefined ? raw : sql`coalesce(${raw}, ${sqlCell(field.absent)})`;
}

/** One filter on an array field: any element matches, and the negative ops (and `empty`) hold when none does. */
function eachSql(field: ListColumn, filter: Filter): RawBuilder<SqlBool> {
  const elements = sql`json_each(${sql.ref(field.column)}, ${field.path ?? '$'})`;
  const value = sql`${sql.ref('e.value')}`;
  const any = (condition: RawBuilder<SqlBool>) => sql<SqlBool>`exists (select 1 from ${elements} as e where ${condition})`;
  switch (filter.op) {
    case 'isNot': return sql<SqlBool>`not ${any(sql<SqlBool>`${value} = ${sqlCell(filter.value)}`)}`;
    case 'notIn': return sql<SqlBool>`not ${any(sql<SqlBool>`${value} in (${sql.join(filter.values.map(sqlCell))})`)}`;
    case 'empty': return sql<SqlBool>`not ${any(TRUE)}`;
    case 'notEmpty': return any(TRUE);
    case 'is': case 'gt': case 'gte': case 'lt': case 'lte': case 'contains': case 'in': case 'between': return any(filterSql(value, filter));
  }
}

/** The words of free text, lower-cased, each once. */
export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/\s+/).filter((word) => word !== ''))];
}

/** Free text as SQL: each word appears in one of the columns (an array column: in one of its elements). */
function wordsSql(table: TableName, text: string, columns: readonly ListColumn[]): Array<RawBuilder<SqlBool>> {
  const checkedColumns = columns.map((column, i) => checked(table, `words[${i}]`, column));
  return wordsOf(text).map((word) => {
    const contains = { field: '', op: 'contains', value: word } as const;
    const anywhere = checkedColumns.map((column) => (column.each === true ? eachSql(column, contains) : filterSql(valueOf(column), contains)));
    return anywhere.length === 0 ? sql<SqlBool>`1 = 0` : sql<SqlBool>`(${sql.join(anywhere, sql` or `)})`;
  });
}

const Count = z.object({ n: z.union([z.number(), z.bigint()]) });

/** The list queries on SQLite. */
export class SqliteListQueries implements ListQueries {
  readonly #scope: Scope;

  constructor(scope: Scope) {
    this.#scope = scope;
  }

  async find<K extends TableName>(query: ListFind<K>): Promise<ListFound<RowOf<K>>> {
    if (!Number.isInteger(query.limit) || query.limit < 1) throw new StoreError('bad-query', `table ${query.table}: the limit must be a whole number of at least 1, not ${query.limit}`);
    if (query.keys?.length === 0) return { items: [], total: 0 };
    const field = (name: string): ListColumn => {
      const found = query.fields[name];
      if (found === undefined) throw new StoreError('bad-query', `table ${query.table} has no list field ${name}`);
      return checked(query.table, name, found);
    };
    const where = [
      ...(query.keys === undefined ? [] : [sql<SqlBool>`${sql.ref(KEY_COLUMN)} in (${sql.join([...query.keys])})`]),
      ...query.filters.map((filter) => {
        const at = field(filter.field);
        return at.each === true ? eachSql(at, filter) : filterSql(valueOf(at), filter);
      }),
      ...(query.words === undefined ? [] : wordsSql(query.table, query.words.text, query.words.columns)),
    ];
    const condition = where.length === 0 ? TRUE : sql<SqlBool>`${sql.join(where, sql` and `)}`;
    // each sort key, then the key, so every row has one place
    const order = [
      ...query.sort.map((s) => {
        const at = valueOf(field(s.field));
        return s.dir === 'asc' ? sql`${at} asc nulls first` : sql`${at} desc nulls last`;
      }),
      sql`${sql.ref(KEY_COLUMN)} asc`,
    ];
    const table = sql.table(query.table);
    const { db } = this.#scope;
    const rows = await sql<StoredRow>`select * from ${table} where ${condition} order by ${sql.join(order)} limit ${query.limit} offset ${query.offset}`.execute(db);
    const total = await sql`select count(*) as n from ${table} where ${condition}`.execute(db);
    const codec = new RowCodec(query.table, TABLE_DEFS[query.table], tableLayout(query.table));
    return {
      items: rows.rows.map((row) => codec.decode(z.record(z.string(), CellSchema).parse(row))),
      total: Number(Count.parse(total.rows[0] ?? { n: 0 }).n),
    };
  }
}

