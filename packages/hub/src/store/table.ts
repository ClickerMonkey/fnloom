/** One hub table on SQLite: rows encoded by the table's codec, queries built from its layout. */
import type { Page } from '@harness/core';
import type { Table, TableQuery, Where } from './index.ts';
import type { RowCodec } from './codec.ts';
import type { Scope, StoredRow } from './db.ts';
import { StoreError } from './errors.ts';
import { afterCursor, all, makeCursor, orderBy, orderColumns, whereCondition } from './query.ts';
import { KEY_COLUMN } from './schema.ts';

/** The most cells one `putAll` statement binds. */
const PUT_CELLS = 900;

/** A table in a scope (the store, or a transaction). */
export class SqliteTable<Row, Key> implements Table<Row, Key> {
  readonly #scope: Scope;
  readonly #codec: RowCodec<Row, Key>;

  constructor(scope: Scope, codec: RowCodec<Row, Key>) {
    this.#scope = scope;
    this.#codec = codec;
  }

  private get name(): string {
    return this.#codec.table;
  }

  async get(key: Key): Promise<Row | undefined> {
    const cells = await this.#read(this.#scope, this.#codec.storedKey(key));
    return cells === undefined ? undefined : this.#codec.decode(cells);
  }

  async find(query: TableQuery<Row>): Promise<Page<Row>> {
    if (!Number.isInteger(query.limit) || query.limit < 1) throw new StoreError('bad-query', `table ${this.name}: the limit must be a whole number of at least 1, not ${query.limit}`);
    const { limit } = query;
    const columns = orderColumns(this.name, this.#codec.layout, query.order);
    const condition = all([whereCondition(this.name, this.#codec.layout, query.where), afterCursor(this.name, columns, query.cursor)]);
    const rows = await this.#scope.db.selectFrom(this.name).selectAll().where(condition).orderBy(orderBy(columns)).limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const items = page.map((cells) => this.#codec.decode(cells));
    return rows.length > limit && last !== undefined ? { items, cursor: makeCursor(this.name, columns, last) } : { items };
  }

  async count(where?: Where<Row>): Promise<number> {
    const row = await this.#scope.db
      .selectFrom(this.name)
      .select((eb) => eb.fn.countAll().as('n'))
      .where(whereCondition(this.name, this.#codec.layout, where))
      .executeTakeFirstOrThrow();
    return Number(row['n']);
  }

  async insert(row: Row): Promise<Row> {
    const encoded = this.#codec.encode(row);
    const result = await this.#scope.db
      .insertInto(this.name)
      .values(encoded.cells)
      .onConflict((oc) => oc.column(KEY_COLUMN).doNothing())
      .executeTakeFirst();
    if (result.numInsertedOrUpdatedRows === 0n) throw new StoreError('exists', `table ${this.name} already has ${encoded.key}`);
    return encoded.row;
  }

  async put(row: Row): Promise<Row> {
    const encoded = this.#codec.encode(row);
    const { [KEY_COLUMN]: _key, ...fields } = encoded.cells;
    await this.#scope.db
      .insertInto(this.name)
      .values(encoded.cells)
      .onConflict((oc) => oc.column(KEY_COLUMN).doUpdateSet(fields))
      .execute();
    return encoded.row;
  }

  async putAll(rows: readonly Row[]): Promise<void> {
    if (rows.length === 0) return;
    const encoded = rows.map((row) => this.#codec.encode(row).cells);
    const columns = [...this.#codec.layout.keys()];
    // a few hundred cells a statement keeps well inside SQLite's bound-parameter limit
    const size = Math.max(1, Math.floor(PUT_CELLS / (columns.length + 1)));
    await this.#scope.atomic(async (scope) => {
      for (let at = 0; at < encoded.length; at += size) {
        await scope.db
          .insertInto(this.name)
          .values(encoded.slice(at, at + size))
          .onConflict((oc) => oc.column(KEY_COLUMN).doUpdateSet((eb) => Object.fromEntries(columns.map((column) => [column, eb.ref(`excluded.${column}`)]))))
          .execute();
      }
    });
  }

  async update(input: Key, patch: Partial<Row>): Promise<Row> {
    const key = this.#codec.storedKey(input);
    return this.#scope.atomic(async (scope) => {
      const cells = await this.#read(scope, key);
      if (cells === undefined) throw new StoreError('missing', `table ${this.name} has no ${key}`);
      const encoded = this.#codec.encode(Object.assign({}, this.#codec.decode(cells), patch));
      if (encoded.key !== key) throw new StoreError('key-change', `table ${this.name}: the patch changes the key ${key} to ${encoded.key}`);
      const { [KEY_COLUMN]: _key, ...fields } = encoded.cells;
      await scope.db.updateTable(this.name).set(fields).where(KEY_COLUMN, '=', key).execute();
      return encoded.row;
    });
  }

  async remove(key: Key): Promise<boolean> {
    const result = await this.#scope.db.deleteFrom(this.name).where(KEY_COLUMN, '=', this.#codec.storedKey(key)).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async #read(scope: Scope, key: string): Promise<StoredRow | undefined> {
    return scope.db.selectFrom(this.name).selectAll().where(KEY_COLUMN, '=', key).executeTakeFirst();
  }
}
