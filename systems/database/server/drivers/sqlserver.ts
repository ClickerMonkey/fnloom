/**
 * SQL Server through `mssql` (tedious), the `dbo` schema. Params bind by name as `@p1`, `@p2`, … in placeholder
 * order. Columns come from `INFORMATION_SCHEMA`, keys from its constraints, foreign keys and checks from `sys`, row
 * counts from `sys.partitions`. SQL Server keeps `col IN ('a', 'b')` checks as `[col]='a' OR [col]='b'`; both read.
 */
import mssql from 'mssql';
import { z } from 'zod';
import type { Connection } from '../../shared/shapes.ts';
import type { ColumnSpec, TableSpec } from '@aeye/query';
import { dialectFor } from '../dialects.ts';
import { ScannedTable, checkValues, orValues } from '../schema.ts';
import { bindValue, jsonValue, type Database, type Rows, type Statement, type Written } from './database.ts';

const ColumnRow = z.object({
  table_name: z.string(), column_name: z.string(), data_type: z.string(), is_nullable: z.string(),
  column_default: z.string().nullable(), default_name: z.string().nullable(), max_length: z.number().nullable(), is_identity: z.number().nullable(),
});
const KeyRow = z.object({ table_name: z.string(), name: z.string(), type: z.string(), column_name: z.string(), position: z.number() });
const ForeignRow = z.object({ name: z.string(), table_name: z.string(), column_name: z.string(), ftable: z.string(), fcolumn: z.string(), position: z.number() });
const CheckRow = z.object({ table_name: z.string(), column_name: z.string().nullable(), name: z.string(), definition: z.string() });
const CountRow = z.object({ table_name: z.string(), rows: z.number() });

const COLUMNS_SQL = `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
  c.COLUMN_DEFAULT AS column_default, c.CHARACTER_MAXIMUM_LENGTH AS max_length,
  COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS is_identity, dc.name AS default_name
FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME) AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'ColumnId')
WHERE c.TABLE_SCHEMA = 'dbo' AND t.TABLE_TYPE = 'BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;

const KEYS_SQL = `SELECT tc.TABLE_NAME AS table_name, tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type, k.COLUMN_NAME AS column_name, k.ORDINAL_POSITION AS position
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA
WHERE tc.TABLE_SCHEMA = 'dbo' AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

const FOREIGN_SQL = `SELECT fk.name AS name, tp.name AS table_name, cp.name AS column_name, tr.name AS ftable, cr.name AS fcolumn, fkc.constraint_column_id AS position
FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
ORDER BY fk.name, fkc.constraint_column_id`;

const CHECKS_SQL = `SELECT t.name AS table_name, c.name AS column_name, cc.name AS name, cc.definition AS definition FROM sys.check_constraints cc
JOIN sys.tables t ON t.object_id = cc.parent_object_id LEFT JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id`;

const COUNTS_SQL = `SELECT t.name AS table_name, CAST(SUM(p.rows) AS int) AS rows FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id
WHERE p.index_id IN (0, 1) GROUP BY t.name`;

/** A SQL Server database. */
export class SqlServerDatabase implements Database {
  readonly dialect = 'sqlserver' as const;
  readonly #pool: mssql.ConnectionPool;
  #connected: Promise<mssql.ConnectionPool> | undefined;

  constructor(connection: Extract<Connection, { kind: 'sqlserver' }>) {
    this.#pool = new mssql.ConnectionPool({
      server: connection.host, port: connection.port, database: connection.database, user: connection.user, password: connection.password,
      options: { encrypt: connection.encrypt, trustServerCertificate: true },
      pool: { max: 4 },
    });
  }

  async read(statement: Statement): Promise<Rows> {
    const result = await this.#request(await this.#pool_(), statement).query(statement.sql);
    return rowsOf(result);
  }

  write(statements: readonly Statement[]): Promise<Written> {
    return this.#transaction(statements, true);
  }

  dryRun(statements: readonly Statement[]): Promise<Written> {
    return this.#transaction(statements, false);
  }

  async #transaction(statements: readonly Statement[], commit: boolean): Promise<Written> {
    const pool = await this.#pool_();
    const transaction = new mssql.Transaction(pool);
    await transaction.begin();
    try {
      let affected = 0;
      let last: Rows = { columns: [], rows: [] };
      for (const statement of statements) {
        const result = await this.#request(transaction, statement).query(statement.sql);
        affected += result.rowsAffected.reduce((sum, n) => sum + n, 0);
        last = rowsOf(result);
      }
      if (commit) { await transaction.commit(); } else { await transaction.rollback(); }
      return { affected, ...last };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async schema(): Promise<ScannedTable[]> {
    const ddl = dialectFor('sqlserver').ddl;
    const [columns, keys, foreign, checks, counts] = await Promise.all([
      this.#rows(ColumnRow, COLUMNS_SQL), this.#rows(KeyRow, KEYS_SQL), this.#rows(ForeignRow, FOREIGN_SQL), this.#rows(CheckRow, CHECKS_SQL), this.#rows(CountRow, COUNTS_SQL),
    ]);
    const names = [...new Set(columns.map((row) => row.table_name))].sort();
    return names.map((name) => {
      const mine = checks.filter((row) => row.table_name === name);
      const constraints = groupBy(keys.filter((row) => row.table_name === name), (row) => row.name);
      const primary = constraints.find((parts) => parts[0]?.type === 'PRIMARY KEY') ?? [];
      const specColumns: ColumnSpec[] = columns.filter((row) => row.table_name === name).map((row) => {
        const check = mine.find((item) => item.column_name === row.column_name);
        const values = check === undefined ? undefined : orValues(check.definition, row.column_name) ?? checkValues(check.definition, row.column_name);
        const length = row.max_length === null ? '' : row.max_length < 0 ? '(max)' : `(${row.max_length})`;
        const fallback = row.column_default === null ? undefined : ddl.readDefault(row.column_default);
        return {
          name: row.column_name,
          type: ddl.readColumnType(`${row.data_type}${length}`),
          nullable: row.is_nullable === 'YES',
          ...(fallback === undefined ? {} : { default: fallback }),
          ...(row.default_name === null ? {} : { defaultName: row.default_name }),
          ...(row.is_identity === 1 ? { generated: true } : {}),
          ...(values === undefined || check === undefined ? {} : { values, checkName: check.name }),
        };
      });
      const spec: TableSpec = {
        name,
        schema: 'dbo',
        columns: specColumns,
        primaryKey: primary.map((part) => part.column_name),
        ...(primary[0] === undefined ? {} : { primaryKeyName: primary[0].name }),
        unique: constraints.filter((parts) => parts[0]?.type === 'UNIQUE').map((parts) => ({ name: parts[0]?.name ?? '', columns: parts.map((part) => part.column_name) })),
        foreignKeys: groupBy(foreign.filter((row) => row.table_name === name), (row) => row.name).map((parts) => ({
          name: parts[0]?.name ?? '', columns: parts.map((part) => part.column_name), table: parts[0]?.ftable ?? '', references: parts.map((part) => part.fcolumn),
        })),
      };
      return ScannedTable.parse({ spec, rows: counts.find((row) => row.table_name === name)?.rows ?? 0 });
    });
  }

  async close(): Promise<void> {
    if (this.#connected !== undefined) { await this.#pool.close(); }
  }

  #pool_(): Promise<mssql.ConnectionPool> {
    this.#connected ??= this.#pool.connect();
    return this.#connected;
  }

  #request(on: mssql.ConnectionPool | mssql.Transaction, statement: Statement): mssql.Request {
    const request = on instanceof mssql.Transaction ? new mssql.Request(on) : new mssql.Request(on);
    statement.params.forEach((value, index) => { request.input(`p${index + 1}`, bindValue(value)); });
    return request;
  }

  async #rows<T>(schema: z.ZodType<T>, sql: string): Promise<T[]> {
    return z.array(schema).parse((await new mssql.Request(await this.#pool_()).query(sql)).recordset);
  }
}

/** Items grouped by a key, in first-seen order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) { groups.set(key(item), [...(groups.get(key(item)) ?? []), item]); }
  return [...groups.values()];
}

/** A result's last record set as rows. */
function rowsOf(result: mssql.IResult<unknown>): Rows {
  const set = result.recordset;
  const columns = Object.keys(set.columns);
  const rows: Rows['rows'] = [];
  for (const record of set) {
    rows.push(columns.map((column) => (typeof record === 'object' && record !== null && column in record ? jsonValue(Reflect.get(record, column)) : null)));
  }
  return { columns, rows };
}
