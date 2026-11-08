/**
 * The database handle every part of the store works through: Kysely over one better-sqlite3 connection, and the
 * scope a piece of work runs in (the whole store, or one open transaction).
 *
 * Kysely sees the hub tables structurally (any table, any column, cells of SQL values) because their names and
 * columns are derived from core's schemas at runtime; the typing that matters is the row schema each cell set is
 * parsed with on the way out. The store's own bookkeeping tables (`AuxDb`) are named, so their columns are checked. Kysely's SQLite driver gives the one connection to one holder at a time, so a
 * transaction left open across `await`s never interleaves with other statements; the ayepi ports, which drive the
 * connection synchronously, go through the same gate (`Scope.exclusive`).
 */
import { type ControlledTransaction, Kysely, SqliteDialect } from 'kysely';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import type { AuxDb } from './auxTables.ts';

/** A value as SQLite stores it. */
export type Cell = string | number | bigint | Uint8Array | null;

/** A row as the database returns it, before it is decoded and parsed. */
export interface StoredRow {
  [column: string]: Cell;
}

/** The database as Kysely sees it: the bookkeeping tables by name, and any other table of stored rows. */
export interface StoredDb extends AuxDb {
  [table: string]: StoredRow;
}

/** Kysely over the stored tables. */
export type Db = Kysely<StoredDb>;

/** Parses a raw cell read with `sql` (Kysely types raw rows by assertion, so they are checked here instead). */
export const CellSchema = z.union([z.string(), z.number(), z.bigint(), z.instanceof(Uint8Array), z.null()]);

/** Open Kysely on a better-sqlite3 connection. Closing Kysely closes the connection. */
export function openKysely(database: BetterSqlite3.Database): Db {
  return new Kysely<StoredDb>({ dialect: new SqliteDialect({ database }) });
}

/** Where a piece of store work runs: the whole store, or inside one transaction. */
export interface Scope {
  /** The executor: Kysely on the store, or the open transaction. */
  readonly db: Db;
  /** Whether this scope is a transaction (work in it commits or rolls back together). */
  readonly inTransaction: boolean;
  /** Run `fn` atomically: in a new transaction on the store, in a savepoint inside a transaction. */
  atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T>;
  /**
   * Run synchronous work on the raw connection with nothing else using it. On the store this waits for the
   * connection (so it never lands inside someone's open transaction); inside a transaction it runs at once, as part
   * of it.
   */
  exclusive<T>(fn: () => T): Promise<T>;
}

/** The store-wide scope: atomic work opens a transaction, exclusive work waits for the connection. */
export class RootScope implements Scope {
  readonly inTransaction = false;
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
    const trx = await this.db.startTransaction().execute();
    try {
      const out = await fn(new TransactionScope(trx));
      await trx.commit().execute();
      return out;
    } catch (error) {
      await trx.rollback().execute();
      throw error;
    }
  }

  async exclusive<T>(fn: () => T): Promise<T> {
    return this.db.connection().execute(() => Promise.resolve().then(fn));
  }
}

/** A scope inside an open transaction: nested atomic work uses a savepoint, exclusive work runs at once. */
export class TransactionScope implements Scope {
  readonly inTransaction = true;
  /** Savepoint names only need to be unique among the open ones; a process-wide counter makes them unique outright. */
  static #savepoints = 0;

  readonly db: ControlledTransaction<StoredDb, string[]>;

  constructor(db: ControlledTransaction<StoredDb, string[]>) {
    this.db = db;
  }

  async atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
    const name = `sp${++TransactionScope.#savepoints}`;
    const point = await this.db.savepoint(name).execute();
    try {
      const out = await fn(new TransactionScope(point));
      await point.releaseSavepoint(name).execute();
      return out;
    } catch (error) {
      await point.rollbackToSavepoint(name).execute();
      throw error;
    }
  }

  exclusive<T>(fn: () => T): Promise<T> {
    return Promise.resolve().then(fn);
  }
}
