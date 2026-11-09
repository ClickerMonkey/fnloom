/**
 * Opening the configured database: the driver for its connection kind. A new SQLite file lives in the instance's
 * data folder; a read-only database opens read-only where the driver can (SQLite).
 */
import { join } from 'node:path';
import type { Connection } from '../../shared/shapes.ts';
import type { Database } from './database.ts';
import { PostgresDatabase } from './postgres.ts';
import { SqliteDatabase } from './sqlite.ts';
import { SqlServerDatabase } from './sqlserver.ts';

export { bindValue, errorText, jsonValue, type Database, type Rows, type Statement, type Written } from './database.ts';

/** Connect to a database. */
export function openDatabase(connection: Connection, options: { dataDir: string; readonly: boolean }): Database {
  switch (connection.kind) {
    case 'sqlite-new': return new SqliteDatabase(join(options.dataDir, connection.path), { create: true, readonly: false });
    case 'sqlite-file': return new SqliteDatabase(connection.path, { create: false, readonly: options.readonly });
    case 'postgres': return new PostgresDatabase(connection.url);
    case 'sqlserver': return new SqlServerDatabase(connection);
  }
}
