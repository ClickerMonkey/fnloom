/**
 * The store module: the hub's one database behind a port. SQLite (better-sqlite3 + sqlite-vec, typed with Kysely) is
 * the implementation now; Postgres + pgvector can replace it behind the same port. The same database file backs the
 * ayepi ports the hub uses (work queue/store/pubsub and the rate store, from `@ayepi/sqlite`), so one file holds
 * everything. Every row read is parsed with its table's schema from core's `HUB_TABLES`.
 *
 * The implementation is `SqliteStore` (`store/sqlite.ts`, opened with `openSqliteStore`); `HybridSearch`
 * (`store/hybrid.ts`) merges the vector and text indexes by reciprocal rank on any `HubStore`.
 */
import type { IndexedKind, Page, QualifiedName, RowOf, TableName } from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { RateLimitResult, RateLimitRule, RateLimitStore } from '@ayepi/rate';
import type { SqliteDeadLetter } from '@ayepi/sqlite';
import type { PubSub, PulledWork, PushOptions, Queue, Store } from '@ayepi/work';
import type { StoreTuning } from './env.ts';
import type { ScalarKey } from './schema.ts';

export type { ScalarKey } from './schema.ts';

/**
 * A filter on one column: equal to a value, one of some values, a bound (`gt`, `gte`, `lt`, `lte`), or whether the
 * field is set at all (`exists`, for optional fields).
 */
export type ColumnFilter<V> =
  | V
  | { in: readonly V[] }
  | { gt: V }
  | { gte: V }
  | { lt: V }
  | { lte: V }
  | { exists: boolean };

/**
 * A filter on columns. All given columns must match. Only scalar fields (strings, numbers, booleans, enums) are
 * columns that can be filtered; objects, arrays and JSON fields can't, and naming one doesn't compile.
 */
export type Where<Row> = { [K in ScalarKey<Row>]?: ColumnFilter<Exclude<Row[K], undefined>> };

/** An order: scalar fields, each ascending or descending. Absent fields sort first ascending, last descending. */
export type Order<Row> = ReadonlyArray<readonly [ScalarKey<Row>, 'asc' | 'desc']>;

/** A bounded, ordered read. Nothing reads a whole table. Rows with equal order values are ordered by key. */
export interface TableQuery<Row> {
  where?: Where<Row> | undefined;
  order?: Order<Row> | undefined;
  /** The most rows to return: a whole number of at least 1. */
  limit: number;
  /** The cursor of the previous page. */
  cursor?: string | undefined;
}

/** One table, typed by its row. */
export interface Table<Row> {
  get(key: string): Promise<Row | undefined>;
  find(query: TableQuery<Row>): Promise<Page<Row>>;
  count(where?: Where<Row>): Promise<number>;
  /** Insert; refused when the key exists. */
  insert(row: Row): Promise<Row>;
  /** Insert or replace by key. */
  put(row: Row): Promise<Row>;
  /** Change some fields; refused when the key doesn't exist. The result is parsed with the row schema. */
  update(key: string, patch: Partial<Row>): Promise<Row>;
  remove(key: string): Promise<boolean>;
}

/** A vector index per embedder (sqlite-vec now, pgvector later). Dimensions are fixed per embedder. */
export interface VectorIndex {
  upsert(embedder: QualifiedName, entries: ReadonlyArray<{ kind: IndexedKind; key: string; vector: readonly number[] }>): Promise<void>;
  remove(embedder: QualifiedName, kind: IndexedKind, keys: readonly string[]): Promise<void>;
  /** Nearest by cosine distance; `score` is similarity in [0, 1]. */
  nearest(embedder: QualifiedName, vector: readonly number[], limit: number, kinds?: readonly IndexedKind[]): Promise<Array<{ kind: IndexedKind; key: string; score: number }>>;
}

/** Full-text search over indexed text (SQLite FTS5 now). `score` is higher for better matches. */
export interface TextIndex {
  upsert(entries: ReadonlyArray<{ kind: IndexedKind; key: string; text: string }>): Promise<void>;
  remove(kind: IndexedKind, keys: readonly string[]): Promise<void>;
  search(query: { text: string; kinds: readonly IndexedKind[]; limit: number }): Promise<Array<{ kind: IndexedKind; key: string; score: number }>>;
}

/**
 * A work queue on the hub's database: an `@ayepi/work` `Queue` whose every operation is a promise (it waits for the
 * connection), that also reports its size and dead letters.
 */
export interface HubQueue extends Queue {
  push(body: string, opts?: PushOptions): Promise<void>;
  pop(max: number, visibility: number): Promise<PulledWork[]>;
  heartbeat(pulled: PulledWork, visibility: number): Promise<void>;
  ack(pulled: PulledWork): Promise<void>;
  fail(pulled: PulledWork, delay?: number): Promise<void>;
  deadLetter(body: string, error: string): Promise<void>;
  /** Items in the queue, leased or not. */
  size(): Promise<number>;
  /** Items that ran out of retries, oldest first (default 100). */
  dead(limit?: number): Promise<SqliteDeadLetter[]>;
}

/** The `@ayepi/work` key/value store on the hub's database, every operation a promise, with delete and increment. */
export interface HubKeyValue extends Store {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  setIfNotExists(key: string, value: string, ttl?: number): Promise<boolean>;
  increment(key: string, by: number, ttl?: number): Promise<number>;
}

/** The `@ayepi/rate` store on the hub's database, every operation a promise. */
export interface HubRateStore extends RateLimitStore {
  consume(key: string, rule: RateLimitRule, now: number, cost: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

/** In-process pub/sub (the hub is one process): a publish reaches every subscriber before it returns. */
export interface HubPubSub extends PubSub {
  publish(message: string): void;
}

/**
 * The ayepi ports on the hub's database. On the store they wait for the connection, so they never land inside an
 * open transaction; on a transaction's store (`tx`) they run as part of it, so work enqueued in a transaction is
 * only queued if it commits.
 */
export interface AyepiPorts {
  /** The default work queue, the key/value store and pub/sub, to spread into `createWork`. */
  readonly work: { queue: HubQueue; store: HubKeyValue; pubsub: HubPubSub };
  /** A named queue in the same table, for a work type that should not share the default one. */
  queue(name: string): HubQueue;
  readonly rate: HubRateStore;
}

/** The storage port. */
export interface HubStore {
  table<K extends TableName>(name: K): Table<RowOf<K>>;
  /**
   * Run `fn` in one transaction; everything it does through `store` (tables, indexes and ports) commits or rolls back
   * together. Nested `tx` on that store is a savepoint. Inside `fn`, use only `store`: the outer store waits for the
   * transaction to finish, so awaiting it there never returns.
   */
  tx<T>(fn: (store: HubStore) => Promise<T>): Promise<T>;
  readonly vectors: VectorIndex;
  readonly text: TextIndex;
  readonly ports: AyepiPorts;
  /** Create or upgrade tables. Safe to run on every start. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/** How to open a store: a SQLite file (`:memory:` for tests), with the vector dimensions per embedder. */
export interface StoreOptions {
  file: string;
  /** The dimensions of each embedder's vectors (`embedder/gemma` → 768). */
  dimensions: Readonly<Record<string, number>>;
  /** The clock of the key/value store's expiries and the queue's leases (default `Date.now`). */
  now?: () => number;
  /** Where the store logs migrations (default `@ayepi/log`'s logger). */
  log?: Logger;
  /** Tunables; the defaults come from the `storeEnv` slice. */
  tuning?: Partial<StoreTuning>;
}

/** Opens a store. The SQLite implementation is the default; tests use `:memory:`. */
export type StoreFactory = (options: StoreOptions) => Promise<HubStore>;
