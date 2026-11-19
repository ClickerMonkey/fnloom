/**
 * The hub's shared test doubles, used by every module's tests: a logger that keeps its records, a real store
 * (`SqliteStore` on `:memory:`, migrated, so tests see the same filter, order, cursor and transaction semantics as the
 * hub), a store decorator that fails a chosen write on purpose, and a bus that is the production `MemoryEventBus` and
 * also records what was published. Tests only.
 */
import { createLogger, type Logger, type LogRecord } from '@ayepi/log';
import type { LinkSession, Page, TableName } from '@harness/core';
import type { HubEventName, HubEvents } from './bus.ts';
import { MemoryEventBus } from './bus/memory.ts';
import type { AyepiPorts, HubStore, ListQueries, RecordQueries, HubTable, StoreOptions, Table, TableQuery, TextIndex, VectorIndex, Where } from './store/index.ts';
import { SqliteStore } from './store/sqlite.ts';

/** A logger at debug level that keeps every record it writes. */
export function memoryLog(): { log: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const log = createLogger({ level: 'debug', transports: [{ name: 'memory', write: (record) => { records.push(record); } }] });
  return { log, records };
}

/** Let queued microtasks and timers run: one wait of `ms`, then a few turns of the event loop. */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 4; i++) { await new Promise((resolve) => setTimeout(resolve, 0)); }
}

/** A migrated `SqliteStore` on `:memory:` (no embedder tables unless `dimensions` names some). */
export async function testStore(options: Partial<StoreOptions> = {}): Promise<SqliteStore> {
  const store = SqliteStore.open({ file: ':memory:', dimensions: {}, log: memoryLog().log, ...options });
  await store.migrate();
  return store;
}

/** A table whose `update` fails once when its store says so. Everything else goes to the real table. */
class FaultyTable<Row, Key> implements Table<Row, Key> {
  readonly #table: Table<Row, Key>;
  readonly #fail: () => boolean;

  constructor(table: Table<Row, Key>, fail: () => boolean) {
    this.#table = table;
    this.#fail = fail;
  }

  get(key: Key): Promise<Row | undefined> { return this.#table.get(key); }
  find(query: TableQuery<Row>): Promise<Page<Row>> { return this.#table.find(query); }
  count(where?: Where<Row>): Promise<number> { return this.#table.count(where); }
  insert(row: Row): Promise<Row> { return this.#table.insert(row); }
  put(row: Row): Promise<Row> { return this.#table.put(row); }
  putAll(rows: readonly Row[]): Promise<void> { return this.#table.putAll(rows); }
  remove(key: Key): Promise<boolean> { return this.#table.remove(key); }

  update(key: Key, patch: Partial<Row>): Promise<Row> {
    return this.#fail() ? Promise.reject(new Error('The update failed (on purpose).')) : this.#table.update(key, patch);
  }
}

/**
 * A store that fails the next `update` of a chosen table, to test what a transaction puts back. Transactions run on
 * the real store and their store is wrapped the same way, so the failure is seen inside them too.
 */
export class FaultyStore implements HubStore {
  readonly #store: HubStore;
  readonly #failing: Set<TableName>;

  constructor(store: HubStore, failing: Set<TableName> = new Set()) {
    this.#store = store;
    this.#failing = failing;
  }

  /** Make the next update of `table` fail. */
  failNextUpdate(table: TableName): void {
    this.#failing.add(table);
  }

  get vectors(): VectorIndex { return this.#store.vectors; }
  get text(): TextIndex { return this.#store.text; }
  get recordQueries(): RecordQueries { return this.#store.recordQueries; }
  get lists(): ListQueries { return this.#store.lists; }
  get ports(): AyepiPorts { return this.#store.ports; }

  table<K extends TableName>(name: K): HubTable<K> {
    return new FaultyTable(this.#store.table(name), () => this.#failing.delete(name));
  }

  tx<T>(fn: (store: HubStore) => Promise<T>): Promise<T> {
    return this.#store.tx((inner) => fn(new FaultyStore(inner, this.#failing)));
  }

  migrate(): Promise<void> { return this.#store.migrate(); }
  close(): Promise<void> { return this.#store.close(); }
}

/** Every event published so far, by name. */
type Published = { [E in HubEventName]?: Array<HubEvents[E]> };

/**
 * The production `MemoryEventBus` (listeners on a microtask, failures caught) that also records every publish. A
 * listener failure is kept in `errors` rather than logged.
 */
export class RecordingBus extends MemoryEventBus {
  readonly errors: ReadonlyArray<{ event: HubEventName; error: unknown }>;
  readonly #published: Published = {};

  constructor() {
    const errors: Array<{ event: HubEventName; error: unknown }> = [];
    super((event, error) => { errors.push({ event, error }); });
    this.errors = errors;
  }

  override publish<E extends HubEventName>(event: E, data: HubEvents[E]): void {
    // a view of the record keyed by E alone, so TypeScript pairs the event with its data on write
    const published: { [K in E]?: Array<HubEvents[K]> } = this.#published;
    const list: Array<HubEvents[E]> = published[event] ?? [];
    list.push(data);
    published[event] = list;
    super.publish(event, data);
  }

  /** The data of every published event of one name, in order. */
  of<E extends HubEventName>(event: E): ReadonlyArray<HubEvents[E]> {
    return this.#published[event] ?? [];
  }
}

/** A link handler's payload as the link server builds it, with the parts handlers read: the body and the asking system's session. */
export function linkPayload<D>(data: D, link: LinkSession) {
  return { data, link, signal: new AbortController().signal, req: new Request('http://hub/link'), emit: () => undefined, status: () => undefined, header: () => undefined, cookie: () => undefined };
}
