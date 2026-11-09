/**
 * Postgres through `pg` (a pool over the configured URL), the `public` schema. Columns come from
 * `information_schema.columns` (enum types give their labels as the closed set of values), keys and checks from
 * `pg_constraint`, row counts from the planner's estimate.
 */
import pg from 'pg';
import { z } from 'zod';
import type { ColumnSpec, TableSpec } from '@aeye/query';
import { dialectFor } from '../dialects.ts';
import { ScannedTable, anyValues, checkValues } from '../schema.ts';
import { bindValue, jsonValue, type Database, type Rows, type Statement, type Written } from './database.ts';

const ColumnRow = z.object({
  table_name: z.string(), column_name: z.string(), data_type: z.string(), udt_name: z.string(), is_nullable: z.string(),
  column_default: z.string().nullable(), character_maximum_length: z.number().nullable(), is_identity: z.string(),
});
const ConstraintRow = z.object({ name: z.string(), type: z.string(), table: z.string(), ftable: z.string().nullable(), cols: z.array(z.string()), fcols: z.array(z.string()).nullable(), def: z.string() });
const EnumRow = z.object({ typname: z.string(), labels: z.array(z.string()) });
const CountRow = z.object({ relname: z.string(), rows: z.number() });

const COLUMNS_SQL = `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
  c.character_maximum_length::int AS character_maximum_length, c.is_identity
FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`;

const CONSTRAINTS_SQL = `SELECT con.conname::text AS name, con.contype::text AS type, rel.relname::text AS "table", frel.relname::text AS ftable,
  ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
  CASE WHEN con.confrelid = 0 THEN NULL ELSE ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) END AS fcols,
  pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
LEFT JOIN pg_class frel ON frel.oid = con.confrelid
WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f', 'c') ORDER BY con.conname`;

const ENUMS_SQL = `SELECT t.typname::text AS typname, ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype = 'e' AND n.nspname = 'public'`;

const COUNTS_SQL = `SELECT c.relname::text AS relname, GREATEST(c.reltuples, 0)::float8 AS rows FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;

/** The declared type of a column, as people write it (`varchar(80)`, `timestamptz`, an enum's name). */
function declared(row: z.infer<typeof ColumnRow>): string {
  if (row.data_type === 'USER-DEFINED' || row.data_type === 'ARRAY') { return row.udt_name; }
  return row.character_maximum_length === null ? row.data_type : `${row.data_type}(${row.character_maximum_length})`;
}

/** Big integers and numerics as numbers when they fit (pg reads them as text). */
const NUMERIC_OIDS = [pg.types.builtins.INT8, pg.types.builtins.NUMERIC] as const;

/** A number read as text, as a number when it is exact. */
function numberOf(text: string): number | string {
  const value = Number(text);
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : text;
}

/** A Postgres database. */
export class PostgresDatabase implements Database {
  readonly dialect = 'postgres' as const;
  readonly #pool: pg.Pool;

  constructor(url: string) {
    this.#pool = new pg.Pool({ connectionString: url, max: 4 });
    for (const oid of NUMERIC_OIDS) { pg.types.setTypeParser(oid, numberOf); }
  }

  async read(statement: Statement): Promise<Rows> {
    const result = await this.#pool.query({ text: statement.sql, values: statement.params.map(bindValue), rowMode: 'array' });
    return { columns: result.fields.map((field) => field.name), rows: rowsOf(result.rows) };
  }

  write(statements: readonly Statement[]): Promise<Written> {
    return this.#transaction(statements, true);
  }

  dryRun(statements: readonly Statement[]): Promise<Written> {
    return this.#transaction(statements, false);
  }

  async #transaction(statements: readonly Statement[], commit: boolean): Promise<Written> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      let affected = 0;
      let last: Rows = { columns: [], rows: [] };
      for (const statement of statements) {
        const result = await client.query({ text: statement.sql, values: statement.params.map(bindValue), rowMode: 'array' });
        affected += result.rowCount ?? 0;
        last = { columns: result.fields.map((field) => field.name), rows: rowsOf(result.rows) };
      }
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return { affected, ...last };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async schema(): Promise<ScannedTable[]> {
    const ddl = dialectFor('postgres').ddl;
    const [columns, constraints, enums, counts] = await Promise.all([
      this.#rows(ColumnRow, COLUMNS_SQL), this.#rows(ConstraintRow, CONSTRAINTS_SQL), this.#rows(EnumRow, ENUMS_SQL), this.#rows(CountRow, COUNTS_SQL),
    ]);
    const enumValues = new Map(enums.map((row) => [row.typname, row.labels]));
    const rowCounts = new Map(counts.map((row) => [row.relname, Math.round(row.rows)]));
    const names = [...new Set(columns.map((row) => row.table_name))].sort();
    return names.map((name) => {
      const mine = constraints.filter((row) => row.table === name);
      const checks = mine.filter((row) => row.type === 'c').map((row) => row.def).join(' ');
      const specColumns: ColumnSpec[] = columns.filter((row) => row.table_name === name).map((row) => {
        const labels = enumValues.get(row.udt_name);
        const values = labels ?? anyValues(checks, row.column_name) ?? checkValues(checks, row.column_name);
        const serial = (row.column_default ?? '').startsWith('nextval(');
        const fallback = row.column_default === null || serial ? undefined : ddl.readDefault(row.column_default);
        return {
          name: row.column_name,
          // an enum type holds text from a closed set
          type: labels === undefined ? ddl.readColumnType(declared(row)) : { kind: 'text' },
          nullable: row.is_nullable === 'YES',
          ...(fallback === undefined ? {} : { default: fallback }),
          ...(row.is_identity === 'YES' || serial ? { generated: true } : {}),
          ...(values === undefined || values.length === 0 ? {} : { values }),
        };
      });
      const primary = mine.find((row) => row.type === 'p');
      const spec: TableSpec = {
        name,
        schema: 'public',
        columns: specColumns,
        primaryKey: primary?.cols ?? [],
        ...(primary === undefined ? {} : { primaryKeyName: primary.name }),
        unique: mine.filter((row) => row.type === 'u').map((row) => ({ name: row.name, columns: row.cols })),
        foreignKeys: mine.flatMap((row) => (row.type === 'f' && row.ftable !== null && row.fcols !== null ? [{ name: row.name, columns: row.cols, table: row.ftable, references: row.fcols }] : [])),
      };
      return ScannedTable.parse({ spec, rows: rowCounts.get(name) ?? 0 });
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #rows<T>(schema: z.ZodType<T>, sql: string): Promise<T[]> {
    return z.array(schema).parse((await this.#pool.query(sql)).rows);
  }
}

/** `pg`'s array rows as JSON rows. */
function rowsOf(rows: unknown[]): Rows['rows'] {
  return rows.map((row) => (Array.isArray(row) ? row.map(jsonValue) : []));
}
