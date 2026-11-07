/**
 * The ayepi ports (`@ayepi/sqlite`) on the store's connection, behind the store's gate. The sqlite ports drive the
 * connection synchronously, so on the store they wait for it (`Scope.exclusive`) and never land inside a
 * transaction that another caller left open across an `await`; on a transaction's store they run inside it. The
 * pub/sub never touches the database (the hub is one process), so it needs no gate.
 */
import type { RateLimitResult, RateLimitRule } from '@ayepi/rate';
import { type SqliteDeadLetter, type SqliteOptions, type SqlitePubSub, type SqliteQueue, type SqliteRateStore, type SqliteStore, sqliteQueue } from '@ayepi/sqlite';
import type { PulledWork, PushOptions } from '@ayepi/work';
import type BetterSqlite3 from 'better-sqlite3';
import type { Scope } from './db.ts';
import type { AyepiPorts, HubKeyValue, HubQueue, HubRateStore } from './index.ts';

/** The table prefix of every ayepi port. */
export const PORT_PREFIX = 'ayepi_';

/** A sqlite queue behind the gate. */
export class GatedQueue implements HubQueue {
  readonly #queue: SqliteQueue;
  readonly #scope: Scope;

  constructor(queue: SqliteQueue, scope: Scope) {
    this.#queue = queue;
    this.#scope = scope;
  }

  push(body: string, opts?: PushOptions): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#queue.push(body, opts);
    });
  }

  pop(max: number, visibility: number): Promise<PulledWork[]> {
    return this.#scope.exclusive(() => this.#queue.pop(max, visibility));
  }

  heartbeat(pulled: PulledWork, visibility: number): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#queue.heartbeat(pulled, visibility);
    });
  }

  ack(pulled: PulledWork): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#queue.ack(pulled);
    });
  }

  fail(pulled: PulledWork, delay?: number): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#queue.fail(pulled, delay);
    });
  }

  deadLetter(body: string, error: string): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#queue.deadLetter(body, error);
    });
  }

  size(): Promise<number> {
    return this.#scope.exclusive(() => this.#queue.size());
  }

  dead(limit?: number): Promise<SqliteDeadLetter[]> {
    return this.#scope.exclusive(() => this.#queue.dead(limit));
  }
}

/** A sqlite key/value store behind the gate. */
export class GatedStore implements HubKeyValue {
  readonly #store: SqliteStore;
  readonly #scope: Scope;

  constructor(store: SqliteStore, scope: Scope) {
    this.#store = store;
    this.#scope = scope;
  }

  get(key: string): Promise<string | undefined> {
    return this.#scope.exclusive(() => this.#store.get(key));
  }

  set(key: string, value: string, ttl?: number): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#store.set(key, value, ttl);
    });
  }

  delete(key: string): Promise<void> {
    return this.#scope.exclusive(() => {
      this.#store.delete(key);
    });
  }

  setIfNotExists(key: string, value: string, ttl?: number): Promise<boolean> {
    return this.#scope.exclusive(() => this.#store.setIfNotExists(key, value, ttl));
  }

  increment(key: string, by: number, ttl?: number): Promise<number> {
    return this.#scope.exclusive(() => this.#store.increment(key, by, ttl));
  }
}

/** A sqlite rate store behind the gate. */
export class GatedRateStore implements HubRateStore {
  readonly #rate: SqliteRateStore;
  readonly #scope: Scope;

  constructor(rate: SqliteRateStore, scope: Scope) {
    this.#rate = rate;
    this.#scope = scope;
  }

  async consume(key: string, rule: RateLimitRule, now: number, cost: number): Promise<RateLimitResult> {
    return this.#scope.exclusive(() => this.#rate.consume(key, rule, now, cost));
  }

  async reset(key: string): Promise<void> {
    await this.#scope.exclusive(() => {
      this.#rate.reset(key);
    });
  }
}

/** The raw sqlite ports, made once per store. */
export interface RawPorts {
  readonly database: BetterSqlite3.Database;
  readonly queue: SqliteQueue;
  readonly store: SqliteStore;
  readonly pubsub: SqlitePubSub;
  readonly rate: SqliteRateStore;
  /** The options every port was made with (prefix, clock). */
  readonly options: SqliteOptions;
}

/** The ports of one scope: the store's (gated) or a transaction's (run inside it). */
export class ScopedPorts implements AyepiPorts {
  readonly work: { queue: HubQueue; store: HubKeyValue; pubsub: SqlitePubSub };
  readonly rate: HubRateStore;
  readonly #raw: RawPorts;
  readonly #scope: Scope;
  /** Named queues, shared by every scope of the store so each is made once. */
  readonly #named: Map<string, SqliteQueue>;

  constructor(raw: RawPorts, scope: Scope, named: Map<string, SqliteQueue>) {
    this.#raw = raw;
    this.#scope = scope;
    this.#named = named;
    this.work = { queue: new GatedQueue(raw.queue, scope), store: new GatedStore(raw.store, scope), pubsub: raw.pubsub };
    this.rate = new GatedRateStore(raw.rate, scope);
  }

  queue(name: string): HubQueue {
    let queue = this.#named.get(name);
    if (queue === undefined) {
      // the default queue made the shared table already, so this only prepares statements
      queue = sqliteQueue(this.#raw.database, { ...this.#raw.options, name });
      this.#named.set(name, queue);
    }
    return new GatedQueue(queue, this.#scope);
  }
}
