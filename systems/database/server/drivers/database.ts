/**
 * One interface over every database the system connects to: read rows, write in a transaction, read the schema.
 * Each driver (`sqlite.ts`, `postgres.ts`, `sqlserver.ts`) binds params the way its dialect's SQL numbers them, and
 * hands every value back as JSON (dates as ISO text, binary as base64, big integers as numbers when they fit).
 */
import type { Json } from '@harness/core';
import type { DialectName } from '../../shared/shapes.ts';
import type { ScannedTable } from '../schema.ts';

/** Rows as read: the column names once, then each row in column order. */
export interface Rows {
  readonly columns: string[];
  readonly rows: Json[][];
}

/** One statement and its params, in placeholder order. */
export interface Statement {
  readonly sql: string;
  readonly params: readonly Json[];
}

/** What a write did: rows affected in all, and the rows the last statement returned (`RETURNING`), if any. */
export interface Written extends Rows {
  readonly affected: number;
}

/** A connected database. */
export interface Database {
  readonly dialect: DialectName;
  /** Read rows. A read never changes data, whatever its SQL: each driver enforces that itself. */
  read(statement: Statement): Promise<Rows>;
  /** Run the statements in one transaction: all of them, or none when one fails. A read-only database refuses. */
  write(statements: readonly Statement[]): Promise<Written>;
  /** Run the statements in a transaction that is always rolled back: what a write would do, without doing it. */
  dryRun(statements: readonly Statement[]): Promise<Written>;
  /** Every table, with its columns, keys and foreign keys. */
  schema(): Promise<ScannedTable[]>;
  close(): Promise<void>;
}

/** What a read-only database says when asked to write. */
export const READ_ONLY = 'This database is read-only: it takes no writes.';

/** A value from a driver as JSON. */
export function jsonValue(value: unknown): Json {
  if (value === null || value === undefined) { return null; }
  if (typeof value === 'string' || typeof value === 'boolean') { return value; }
  if (typeof value === 'number') { return Number.isFinite(value) ? value : String(value); }
  if (typeof value === 'bigint') { return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString(); }
  if (value instanceof Date) { return Number.isNaN(value.getTime()) ? null : value.toISOString(); }
  if (value instanceof Uint8Array) { return Buffer.from(value).toString('base64'); }
  if (Array.isArray(value)) { return value.map(jsonValue); }
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) { out[key] = jsonValue(item); }
    return out;
  }
  // a function or a symbol: nothing a database hands back as data
  return null;
}

/** A param as a driver binds it: objects and arrays as JSON text (a json column takes it), the rest as they are. */
export function bindValue(value: Json): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return value; }
  return JSON.stringify(value);
}

/** The error a driver threw, as one line for the model and the logs. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
