/**
 * SQLite through better-sqlite3: a new file in the instance's data folder or an existing one. The schema comes from
 * `sqlite_master` and the table pragmas, read into `TableSpec`s by the SQLite DDL writer; a column's closed set of
 * values from a `CHECK (col IN (...))` in its table's SQL. Booleans bind as 0 and 1. A read runs only a statement
 * SQLite says changes nothing; a read-only database opens the file read-only.
 */
import type { ColumnSpec, ForeignKeySpec, TableSpec, UniqueSpec } from '@aeye/query';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { dialectFor } from '../dialects.ts';
import { ScannedTable, checkValues } from '../schema.ts';
import { READ_ONLY, bindValue, jsonValue, type Database, type Rows, type Statement, type Written } from './database.ts';

const TableRow = z.object({ name: z.string(), sql: z.string().nullable() });
const ColumnRow = z.object({ name: z.string(), type: z.string(), notnull: z.number(), dflt_value: z.string().nullable(), pk: z.number(), hidden: z.number().optional() });
const ForeignRow = z.object({ id: z.number(), seq: z.number(), table: z.string(), from: z.string(), to: z.string().nullable() });
const IndexRow = z.object({ name: z.string(), unique: z.number(), origin: z.string() });
const IndexColumnRow = z.object({ seqno: z.number(), name: z.string().nullable() });
const CountRow = z.object({ n: z.number() });

/** A param as SQLite binds it. */
function sqliteValue(value: Parameters<typeof bindValue>[0]): string | number | null {
  const bound = bindValue(value);
  return typeof bound === 'boolean' ? (bound ? 1 : 0) : bound;
}

/** A name as a SQLite identifier. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Thrown inside a dry run's transaction to roll it back. */
class RolledBack extends Error {}

/** A SQLite database file. */
export class SqliteDatabase implements Database {
  readonly dialect = 'sqlite' as const;
  readonly #db: BetterSqlite3.Database;
  readonly #readonly: boolean;

  /** Open (or, with `create`, make) the file; a new file that is read-only is made first, then opened read-only. */
  constructor(file: string, options: { create: boolean; readonly: boolean }) {
    this.#readonly = options.readonly;
    if (options.create && options.readonly) { new BetterSqlite3(file).close(); }
    this.#db = new BetterSqlite3(file, { fileMustExist: !options.create || options.readonly, readonly: options.readonly });
    this.#db.pragma('foreign_keys = ON');
  }

  read(statement: Statement): Promise<Rows> {
    if (!this.#db.prepare(statement.sql).readonly) { return Promise.reject(new Error('A read may not change data.')); }
    return Promise.resolve(this.#run(statement));
  }

  write(statements: readonly Statement[]): Promise<Written> {
    if (this.#readonly) { return Promise.reject(new Error(READ_ONLY)); }
    return Promise.resolve(this.#db.transaction(() => this.#apply(statements))());
  }

  dryRun(statements: readonly Statement[]): Promise<Written> {
    let written: Written = { affected: 0, columns: [], rows: [] };
    try {
      this.#db.transaction(() => {
        written = this.#apply(statements);
        throw new RolledBack();
      })();
    } catch (error) {
      if (!(error instanceof RolledBack)) { throw error; }
    }
    return Promise.resolve(written);
  }

  schema(): Promise<ScannedTable[]> {
    const tables = z.array(TableRow).parse(this.#db.prepare('SELECT name, sql FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all());
    const read = tables.map((table) => this.#table(table.name, table.sql ?? ''));
    // a foreign key that names no columns refers to its table's primary key
    const keys = new Map(read.map((table) => [table.spec.name, table.spec.primaryKey]));
    return Promise.resolve(read.map((table) => ScannedTable.parse({
      ...table,
      spec: {
        ...table.spec,
        foreignKeys: table.spec.foreignKeys.map((key) => (key.references.every((name) => name === '?') ? { ...key, references: keys.get(key.table) ?? key.references } : key)),
      },
    })));
  }

  close(): Promise<void> {
    this.#db.close();
    return Promise.resolve();
  }

  #apply(statements: readonly Statement[]): Written {
    let affected = 0;
    let last: Rows = { columns: [], rows: [] };
    for (const statement of statements) {
      const prepared = this.#db.prepare(statement.sql);
      if (prepared.reader) {
        last = this.#run(statement);
        affected += last.rows.length;
      } else {
        affected += prepared.run(...statement.params.map(sqliteValue)).changes;
        last = { columns: [], rows: [] };
      }
    }
    return { affected, ...last };
  }

  #run(statement: Statement): Rows {
    const prepared = this.#db.prepare(statement.sql);
    const columns = prepared.columns().map((column) => column.name);
    const rows = prepared.raw(true).all(...statement.params.map(sqliteValue));
    return { columns, rows: rows.map((row) => (Array.isArray(row) ? row.map(jsonValue) : [])) };
  }

  #pragma<T>(schema: z.ZodType<T>, sql: string): T[] {
    return z.array(schema).parse(this.#db.prepare(sql).all());
  }

  #table(name: string, sql: string): ScannedTable {
    const ddl = dialectFor('sqlite').ddl;
    const columns = this.#pragma(ColumnRow, `PRAGMA table_xinfo(${quote(name)})`).filter((column) => (column.hidden ?? 0) === 0);
    const primaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    // a lone INTEGER PRIMARY KEY is the rowid: SQLite fills it in
    const rowid = primaryKey.length === 1 && columns.some((column) => column.name === primaryKey[0] && column.type.toUpperCase() === 'INTEGER');
    const foreign = new Map<number, z.infer<typeof ForeignRow>[]>();
    for (const row of this.#pragma(ForeignRow, `PRAGMA foreign_key_list(${quote(name)})`)) { foreign.set(row.id, [...(foreign.get(row.id) ?? []), row]); }
    const unique: UniqueSpec[] = this.#pragma(IndexRow, `PRAGMA index_list(${quote(name)})`)
      .filter((index) => index.unique === 1 && index.origin !== 'pk')
      .flatMap((index) => {
        const parts = this.#pragma(IndexColumnRow, `PRAGMA index_info(${quote(index.name)})`).sort((a, b) => a.seqno - b.seqno).flatMap((column) => (column.name === null ? [] : [column.name]));
        return parts.length > 0 ? [{ columns: parts }] : [];
      });
    const foreignKeys: ForeignKeySpec[] = [...foreign.values()].map((parts) => {
      const sorted = [...parts].sort((a, b) => a.seq - b.seq);
      return { columns: sorted.map((part) => part.from), table: sorted[0]?.table ?? '', references: sorted.map((part) => part.to ?? '?') };
    });
    const specColumns: ColumnSpec[] = columns.map((column) => {
      const values = checkValues(sql, column.name);
      const fallback = column.dflt_value === null ? undefined : ddl.readDefault(column.dflt_value);
      return {
        name: column.name,
        type: ddl.readColumnType(column.type),
        nullable: column.notnull === 0 && column.pk === 0,
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(rowid && column.name === primaryKey[0] ? { generated: true } : {}),
        ...(values === undefined ? {} : { values }),
      };
    });
    const spec: TableSpec = { name, columns: specColumns, primaryKey, foreignKeys, unique };
    return { spec, rows: z.number().parse(CountRow.parse(this.#db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get()).n) };
  }
}
