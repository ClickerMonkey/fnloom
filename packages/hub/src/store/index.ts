/**
 * The store module: the hub's one database behind a port. SQLite (better-sqlite3 + sqlite-vec, typed with Kysely) is
 * the implementation now; Postgres + pgvector can replace it behind the same port. The same database file backs the
 * ayepi ports the hub uses (work queue/store/pubsub and the rate store, from `@ayepi/sqlite`), so one file holds
 * everything. Every row read is parsed with its table's schema from core's `HUB_TABLES`.
 *
 * Owner: the data lane. Implement `SqliteStore` (`store/sqlite.ts`) against `HubStore`.
 */
import type { IndexedKind, Page, QualifiedName, RowOf, TableName } from '@harness/core';
import type { RateLimitStore } from '@ayepi/rate';
import type { PubSub, Queue, Store } from '@ayepi/work';

/** A filter on one column: equal, one of, greater or less than. */
export type ColumnFilter<V> = V | { in: readonly V[] } | { gt: V } | { lt: V };

/** A filter on columns. All given columns must match. */
export type Where<Row> = { [K in keyof Row]?: ColumnFilter<Row[K]> };

/** A bounded, ordered read. Nothing reads a whole table. */
export interface TableQuery<Row> {
  where?: Where<Row>;
  order?: ReadonlyArray<readonly [keyof Row & string, 'asc' | 'desc']>;
  limit: number;
  cursor?: string;
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
  remove(embedder: QualifiedName, keys: readonly string[]): Promise<void>;
  /** Nearest by cosine distance; `score` is similarity in [0, 1]. */
  nearest(embedder: QualifiedName, vector: readonly number[], limit: number, kinds?: readonly IndexedKind[]): Promise<Array<{ kind: IndexedKind; key: string; score: number }>>;
}

/** Full-text search over indexed text (SQLite FTS5 now). `score` is higher for better matches. */
export interface TextIndex {
  upsert(entries: ReadonlyArray<{ kind: IndexedKind; key: string; text: string }>): Promise<void>;
  remove(kind: IndexedKind, keys: readonly string[]): Promise<void>;
  search(query: { text: string; kinds: readonly IndexedKind[]; limit: number }): Promise<Array<{ kind: IndexedKind; key: string; score: number }>>;
}

/** The ayepi ports on the hub's database. */
export interface AyepiPorts {
  readonly work: { queue: Queue; store: Store; pubsub: PubSub };
  readonly rate: RateLimitStore;
}

/** The storage port. */
export interface HubStore {
  table<K extends TableName>(name: K): Table<RowOf<K>>;
  /** Run `fn` in one transaction; everything it does through `store` commits or rolls back together. */
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
  now?: () => number;
}

/** Opens a store. The SQLite implementation is the default; tests use `:memory:`. */
export type StoreFactory = (options: StoreOptions) => Promise<HubStore>;
