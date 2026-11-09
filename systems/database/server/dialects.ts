/**
 * The `@aeye/query` dialect for each database the system speaks: its SQL (quoting, placeholders, paging) and its DDL
 * writer (`dialect.ddl`: reading native column types, `createTable`, `alterTable`).
 */
import { PostgresDialect, SqlServerDialect, SqliteDialect, type Dialect } from '@aeye/query';
import type { DialectName } from '../shared/shapes.ts';

const DIALECTS: Readonly<Record<DialectName, Dialect>> = {
  sqlite: new SqliteDialect(),
  postgres: new PostgresDialect(),
  sqlserver: new SqlServerDialect(),
};

/** The dialect a database speaks. */
export function dialectFor(name: DialectName): Dialect {
  return DIALECTS[name];
}
