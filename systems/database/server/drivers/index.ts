/**
 * Opening the configured database: the driver for its connection kind. A new SQLite file lives in the instance's
 * data folder. A read-only database is read-only in its driver too (a read-only SQLite file, Postgres sessions that
 * default to read-only transactions, SQL Server writes refused), not only in the queries the system compiles.
 */
import { join } from 'node:path';
import type { Connection } from '../../shared/shapes.ts';
import type { Database } from './database.ts';
import { PostgresDatabase } from './postgres.ts';
import { SqliteDatabase } from './sqlite.ts';
import { SqlServerDatabase } from './sqlserver.ts';

export { READ_ONLY, bindValue, errorText, jsonValue, type Database, type Rows, type Statement, type Written } from './database.ts';

/** Connect to a database. */
export function openDatabase(connection: Connection, options: { dataDir: string; readonly: boolean }): Database {
  switch (connection.kind) {
    case 'sqlite-new': return new SqliteDatabase(join(options.dataDir, connection.path), { create: true, readonly: options.readonly });
    case 'sqlite-file': return new SqliteDatabase(connection.path, { create: false, readonly: options.readonly });
    case 'postgres': return new PostgresDatabase(connection.url, { readonly: options.readonly });
    case 'sqlserver': return new SqlServerDatabase(connection, { readonly: options.readonly });
  }
}
