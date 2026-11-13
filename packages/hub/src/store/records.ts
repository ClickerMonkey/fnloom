/**
 * Queries on the data system's records (build 8, `core/data.ts`): filters and sorts on the top-level fields of a
 * record's value, pushed into SQL with `json_extract`, counted and paged by offset. The value is JSON text in the
 * `records` table's `value` column; each field is read with a bound JSON path, so a field name never becomes SQL.
 * The data service checks field names against the stored type before it asks; this only reads.
 */
import { type DataRecord, type Filter, type FilterValue, type QualifiedName, type ActorId, type RecordId, type Sort, type Timestamp } from '@harness/core';
import { type RawBuilder, type SqlBool, sql } from 'kysely';
import { z } from 'zod';
import { RowCodec } from './codec.ts';
import { CellSchema, type Scope, type StoredRow } from './db.ts';
import { StoreError } from './errors.ts';
import { TABLE_DEFS, tableLayout } from './schema.ts';

/** One read of a stored type's records. */
export interface RecordFind {
  readonly type: QualifiedName;
  /** Only this person's (a person-owned type's records, for anyone but an admin). */
  readonly owner?: ActorId | undefined;
  /** Only these records (the ones a text or semantic search found). */
  readonly ids?: readonly RecordId[] | undefined;
  readonly filters: readonly Filter[];
  readonly sort: readonly Sort[];
  readonly offset: number;
  readonly limit: number;
}

/** A page of records and how many match in all. */
export interface RecordFound {
  readonly items: DataRecord[];
  readonly total: number;
}

/** How many records each type has (that one person sees), and when one last changed. */
export interface RecordCount {
  readonly count: number;
  readonly updatedAt: Timestamp | undefined;
}

/** The queries on records. */
export interface RecordQueries {
  find(query: RecordFind): Promise<RecordFound>;
  counts(types: readonly QualifiedName[], owner?: ActorId): Promise<ReadonlyMap<QualifiedName, RecordCount>>;
}

/** A top-level field name the queries accept: letters, digits and `_`, so the JSON path stays plain. */
export const RECORD_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TRUE = sql<SqlBool>`1 = 1`;
const FALSE = sql<SqlBool>`1 = 0`;

/** A field of the value, read with a bound path. */
function field(name: string): RawBuilder<unknown> {
  if (!RECORD_FIELD.test(name)) throw new StoreError('bad-query', `records: "${name}" is not a field name`);
  return sql`json_extract(${sql.ref('value')}, ${`$.${name}`})`;
}

/** A filter value as SQLite compares it (JSON booleans read back as 1 and 0). */
const cell = (value: FilterValue): string | number => (typeof value === 'boolean' ? (value ? 1 : 0) : value);

/** One filter as SQL. */
function condition(filter: Filter): RawBuilder<SqlBool> {
  const at = field(filter.field);
  switch (filter.op) {
    case 'is': return sql<SqlBool>`${at} = ${cell(filter.value)}`;
    case 'isNot': return sql<SqlBool>`(${at} is null or ${at} <> ${cell(filter.value)})`;
    case 'gt': return sql<SqlBool>`${at} > ${cell(filter.value)}`;
    case 'gte': return sql<SqlBool>`${at} >= ${cell(filter.value)}`;
    case 'lt': return sql<SqlBool>`${at} < ${cell(filter.value)}`;
    case 'lte': return sql<SqlBool>`${at} <= ${cell(filter.value)}`;
    case 'contains': return sql<SqlBool>`instr(lower(cast(${at} as text)), ${String(filter.value).toLowerCase()}) > 0`;
    case 'in': return sql<SqlBool>`${at} in (${sql.join(filter.values.map(cell))})`;
    case 'notIn': return sql<SqlBool>`(${at} is null or ${at} not in (${sql.join(filter.values.map(cell))}))`;
    case 'between': return sql<SqlBool>`${at} between ${cell(filter.from)} and ${cell(filter.to)}`;
    case 'empty': return sql<SqlBool>`(${at} is null or ${at} = '')`;
    case 'notEmpty': return sql<SqlBool>`(${at} is not null and ${at} <> '')`;
  }
}

/** The `where` of a read. */
function whereOf(query: Pick<RecordFind, 'type' | 'owner' | 'ids' | 'filters'>): RawBuilder<SqlBool> {
  if (query.ids?.length === 0) return FALSE;
  const parts = [
    sql<SqlBool>`${sql.ref('type')} = ${query.type}`,
    ...(query.owner === undefined ? [] : [sql<SqlBool>`${sql.ref('owner')} = ${query.owner}`]),
    ...(query.ids === undefined ? [] : [sql<SqlBool>`${sql.ref('id')} in (${sql.join([...query.ids])})`]),
    ...query.filters.map(condition),
  ];
  return parts.length === 0 ? TRUE : sql<SqlBool>`${sql.join(parts, sql` and `)}`;
}

const Count = z.object({ n: z.union([z.number(), z.bigint()]) });
const TypeCount = z.object({ type: z.string(), n: z.union([z.number(), z.bigint()]), at: z.union([z.number(), z.null()]) });

/** The record queries on SQLite. */
export class SqliteRecordQueries implements RecordQueries {
  readonly #scope: Scope;
  readonly #codec = new RowCodec('records', TABLE_DEFS.records, tableLayout('records'));

  constructor(scope: Scope) {
    this.#scope = scope;
  }

  async find(query: RecordFind): Promise<RecordFound> {
    const where = whereOf(query);
    // each sort key, then the newest change, then the id, so every row has one place
    const order = [
      ...query.sort.map((s) => (s.dir === 'asc' ? sql`${field(s.field)} asc nulls first` : sql`${field(s.field)} desc nulls last`)),
      sql`${sql.ref('updatedAt')} desc`, sql`${sql.ref('id')} asc`,
    ];
    const { db } = this.#scope;
    const rows = await sql<StoredRow>`select * from ${sql.table('records')} where ${where} order by ${sql.join(order)} limit ${query.limit} offset ${query.offset}`.execute(db);
    const total = await sql`select count(*) as n from ${sql.table('records')} where ${where}`.execute(db);
    return {
      items: rows.rows.map((row) => this.#codec.decode(z.record(z.string(), CellSchema).parse(row))),
      total: Number(Count.parse(total.rows[0] ?? { n: 0 }).n),
    };
  }

  async counts(types: readonly QualifiedName[], owner?: ActorId): Promise<ReadonlyMap<QualifiedName, RecordCount>> {
    const out = new Map<QualifiedName, RecordCount>();
    if (types.length === 0) return out;
    const byOwner = owner === undefined ? sql`` : sql`and ${sql.ref('owner')} = ${owner}`;
    const result = await sql`
      select type, count(*) as n, max(${sql.ref('updatedAt')}) as at from ${sql.table('records')}
      where type in (${sql.join([...types])}) ${byOwner} group by type`.execute(this.#scope.db);
    const names = new Map<string, QualifiedName>(types.map((type) => [type, type]));
    for (const row of result.rows) {
      const parsed = TypeCount.parse(row);
      const type = names.get(parsed.type);
      if (type !== undefined) out.set(type, { count: Number(parsed.n), updatedAt: parsed.at ?? undefined });
    }
    return out;
  }
}
