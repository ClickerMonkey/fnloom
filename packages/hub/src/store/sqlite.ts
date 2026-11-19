/**
 * The SQLite store: one better-sqlite3 connection (sqlite-vec loaded, WAL for files) holding the hub's tables, the
 * text and vector indexes, and every ayepi port. `openSqliteStore` is the `StoreFactory`; call `migrate()` once on
 * start before using it.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type KeyOf, type RowOf, type TableName } from '@harness/core';
import { type Logger, logger as defaultLogger } from '@ayepi/log';
import { type SqliteOptions, type SqliteQueue, sqlitePubSub, sqliteQueue, sqliteRateStore, sqliteStore } from '@ayepi/sqlite';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { RowCodec } from './codec.ts';
import { type Db, RootScope, type Scope, openKysely } from './db.ts';
import { type StoreTuning, storeEnv } from './env.ts';
import { StoreError } from './errors.ts';
import { HybridSearch } from './hybrid.ts';
import type { HubStore, StoreFactory, StoreOptions, HubTable, TextIndex, VectorIndex } from './index.ts';
import { type TableChange, ensureMeta, isChange, migrateTable } from './migrate.ts';
import { PORT_PREFIX, type RawPorts, ScopedPorts } from './ports.ts';
import { TABLE_DEFS, TABLE_NAMES, tableIndexes, tableLayout } from './schema.ts';
import { SqliteTable } from './table.ts';
import { SqliteTextIndex, createTextTables } from './text.ts';
import { SqliteVectorIndex, createVectorTables } from './vectors.ts';
import { SqliteRecordQueries, type RecordQueries } from './records.ts';
import { SqliteListQueries, type ListQueries } from './lists.ts';

/** What every scope of one store shares. */
interface Shared {
  readonly root: Db;
  readonly raw: RawPorts;
  readonly named: Map<string, SqliteQueue>;
  /** Each embedder's table size, as made in the database (grows as `vectors.ensure` makes tables). */
  readonly dimensions: Map<string, number>;
  readonly tuning: StoreTuning;
  readonly log: Logger;
}

/** The codec of a table, typed by its row schema. */
function codecOf<K extends TableName>(name: K): RowCodec<RowOf<K>, KeyOf<K>> {
  return new RowCodec(name, TABLE_DEFS[name], tableLayout(name));
}

/** The hub's store on SQLite, in a scope: the whole store, or one transaction (see `tx`). */
export class SqliteStore implements HubStore {
  readonly vectors: VectorIndex;
  readonly text: TextIndex;
  readonly recordQueries: RecordQueries;
  readonly lists: ListQueries;
  readonly ports: ScopedPorts;
  /** Hybrid (vector + text) search over this store's indexes. */
  readonly search: HybridSearch;
  readonly #shared: Shared;
  readonly #scope: Scope;

  private constructor(shared: Shared, scope: Scope) {
    this.#shared = shared;
    this.#scope = scope;
    this.vectors = new SqliteVectorIndex(scope, shared.dimensions, shared.log);
    this.text = new SqliteTextIndex(scope);
    this.recordQueries = new SqliteRecordQueries(scope);
    this.lists = new SqliteListQueries(scope);
    this.ports = new ScopedPorts(shared.raw, scope, shared.named);
    this.search = new HybridSearch(this, shared.tuning);
  }

  /**
   * Open a store on a file (`:memory:` for tests), making its folder if needed. Tables are made by `migrate()`; the
   * ayepi ports' tables now.
   */
  static open(options: StoreOptions): SqliteStore {
    const tuning: StoreTuning = { ...storeEnv.parse(), ...options.tuning };
    const onDisk = options.file !== ':memory:' && options.file !== '';
    if (onDisk) mkdirSync(dirname(options.file), { recursive: true });
    const database = new Database(options.file);
    sqliteVec.load(database);
    database.pragma(`busy_timeout = ${tuning.HARNESS_DB_BUSY_TIMEOUT}`);
    if (onDisk) database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    const portOptions: SqliteOptions = options.now === undefined ? { prefix: PORT_PREFIX } : { prefix: PORT_PREFIX, now: options.now };
    const raw: RawPorts = {
      database,
      options: portOptions,
      queue: sqliteQueue(database, portOptions),
      store: sqliteStore(database, { ...portOptions, sweepEvery: tuning.HARNESS_KV_SWEEP_EVERY }),
      // one process: messages stay in memory and never touch the database
      pubsub: sqlitePubSub(database, { ...portOptions, poll: false }),
      rate: sqliteRateStore(database, { prefix: PORT_PREFIX, sweepEvery: tuning.HARNESS_KV_SWEEP_EVERY }),
    };
    const root = openKysely(database);
    const shared: Shared = { root, raw, named: new Map(), dimensions: new Map(Object.entries(options.dimensions ?? {})), tuning, log: options.log ?? defaultLogger };
    return new SqliteStore(shared, new RootScope(root));
  }

  /** Whether this is a transaction's store. */
  get inTransaction(): boolean {
    return this.#scope.inTransaction;
  }

  table<K extends TableName>(name: K): HubTable<K> {
    return new SqliteTable(this.#scope, codecOf(name));
  }

  async tx<T>(fn: (store: HubStore) => Promise<T>): Promise<T> {
    return this.#scope.atomic((scope) => fn(new SqliteStore(this.#shared, scope)));
  }

  async migrate(): Promise<void> {
    const { log, dimensions } = this.#shared;
    const { changes, rebuiltVectors } = await this.#scope.atomic(async (scope) => {
      await ensureMeta(scope.db);
      const changes: TableChange[] = [];
      for (const name of TABLE_NAMES) {
        changes.push(await migrateTable(scope.db, { name, layout: tableLayout(name), indexes: tableIndexes(name) }));
      }
      await createTextTables(scope);
      return { changes: changes.filter(isChange), rebuiltVectors: await createVectorTables(scope, dimensions, log) };
    });
    for (const change of changes) {
      log.info('store.table.migrated', {
        table: change.table, created: change.created, rebuilt: change.rebuilt, added: change.added, retired: change.retired,
        indexesCreated: change.indexesCreated, indexesDropped: change.indexesDropped,
      });
    }
    log.info('store.migrated', { tables: TABLE_NAMES.length, changed: changes.length, embedders: [...dimensions.keys()], rebuiltVectors });
  }

  async close(): Promise<void> {
    if (this.#scope.inTransaction) throw new StoreError('in-transaction', "a transaction's store can't close the store");
    this.#shared.raw.pubsub.close();
    await this.#shared.root.destroy();
  }
}

/** The default `StoreFactory`. */
export const openSqliteStore: StoreFactory = (options) => Promise.resolve(SqliteStore.open(options));
