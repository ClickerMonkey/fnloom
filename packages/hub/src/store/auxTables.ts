/**
 * The store's own bookkeeping tables: what the migrations made (`_tables`), each embedder's vector table and size
 * (`_vectors`), and the text index (`_text_docs` mapping items to rowids, `_text_fts` holding their text). Each has
 * one zod schema, the single source of truth: Kysely sees these tables through `AuxDb`, derived from the schemas, so
 * their column names and cell types are checked; their `create table` columns come from the same schemas. Renaming a
 * field breaks every query on it at compile time.
 */
import { IndexedKind } from '@harness/core';
import { type CreateTableBuilder, sql } from 'kysely';
import { z } from 'zod';
import type { Db } from './db.ts';
import { type ColumnKind, layoutOf } from './schema.ts';

/** A row of `_tables`: one per hub table the store made, with the columns and indexes it made last time (JSON text). */
export const TableMeta = z.object({ name: z.string(), columns: z.string(), indexes: z.string() });
export type TableMeta = z.infer<typeof TableMeta>;
/** A row of `_vectors`: one per embedder, naming its `vec0` table and the size its vectors were made at. */
export const VectorMeta = z.object({ embedder: z.string(), table: z.string(), dimensions: z.number().int() });
export type VectorMeta = z.infer<typeof VectorMeta>;
/** A row of `_text_docs`: an indexed item and the rowid its text has in `_text_fts`. */
export const TextDoc = z.object({ id: z.number().int(), kind: IndexedKind, key: z.string() });
/** A row of the FTS5 table `_text_fts`: an item's text, under the rowid of its doc. */
export const TextFts = z.object({ rowid: z.number().int(), text: z.string() });

/**
 * The bookkeeping tables made with `create table`: the row schema, its primary key, the key SQLite assigns when it is
 * left out (an `integer primary key`), and unique column sets.
 */
export const AUX_TABLES = {
  _tables: { row: TableMeta, key: 'name' } satisfies AuxTableDef<typeof TableMeta>,
  _vectors: { row: VectorMeta, key: 'embedder' } satisfies AuxTableDef<typeof VectorMeta>,
  _text_docs: { row: TextDoc, key: 'id', generated: true, unique: [['kind', 'key']] } satisfies AuxTableDef<typeof TextDoc>,
} as const;

/** The FTS5 table: a virtual table, made by `createTextFts`. */
export const TEXT_FTS = '_text_fts';

/** A field of a row schema. */
type FieldOf<R extends z.ZodObject> = keyof z.output<R> & string;

/** How one bookkeeping table is declared: its key and unique column sets are fields of its row. */
interface AuxTableDef<R extends z.ZodObject> {
  readonly row: R;
  readonly key: FieldOf<R>;
  /** Whether SQLite assigns the key when an insert leaves it out. */
  readonly generated?: boolean;
  readonly unique?: ReadonlyArray<readonly [FieldOf<R>, ...Array<FieldOf<R>>]>;
}

/** Any bookkeeping table's declaration, as the code that makes them reads it. */
interface AnyAuxTableDef {
  readonly row: z.ZodObject;
  readonly key: string;
  readonly generated?: boolean;
  readonly unique?: ReadonlyArray<readonly string[]>;
}

/** The name of a bookkeeping table made with `create table`. */
export type AuxTableName = keyof typeof AUX_TABLES;

/** A table's row as Kysely sees it: its schema's output, with a generated key optional (SQLite assigns it). */
type AuxRow<D> = D extends { readonly row: infer R extends z.ZodObject; readonly key: infer K extends string }
  ? D extends { readonly generated: true }
    ? { [F in keyof z.output<R> as F extends K ? never : F]: z.output<R>[F] } & { [F in keyof z.output<R> as F extends K ? F : never]?: z.output<R>[F] }
    : z.output<R>
  : never;

/** The bookkeeping tables as Kysely sees them, derived from their schemas. */
export type AuxDb = { [N in AuxTableName]: AuxRow<(typeof AUX_TABLES)[N]> } & { [TEXT_FTS]: z.output<typeof TextFts> };

/** How each column kind is declared in SQLite. */
export const SQL_TYPE = { text: 'text', integer: 'integer', real: 'real', bool: 'integer', json: 'text' } as const satisfies Record<ColumnKind, string>;

/** Make a bookkeeping table if it doesn't exist, its columns derived from its row schema (every one required). */
export async function createAuxTable(db: Db, name: AuxTableName): Promise<void> {
  const def: AnyAuxTableDef = AUX_TABLES[name];
  let create: CreateTableBuilder<string, string> = db.schema.createTable(name).ifNotExists();
  for (const [column, kind] of layoutOf(name, def.row)) {
    if (column !== def.key) {
      create = create.addColumn(column, SQL_TYPE[kind], (c) => c.notNull());
    } else {
      // an `integer primary key` left out of an insert gets a fresh rowid, so a generated key may be left out
      create = create.addColumn(column, SQL_TYPE[kind], (c) => (def.generated === true ? c.primaryKey() : c.primaryKey().notNull()));
    }
  }
  for (const columns of def.unique ?? []) { create = create.addUniqueConstraint(`${name}_${columns.join('_')}`, [...columns]); }
  await create.execute();
}

/** The FTS5 table's text columns: every field of its schema but the implicit rowid. */
const FTS_COLUMNS = Object.keys(TextFts.shape).filter((column) => column !== 'rowid');

/** Make the FTS5 table if it doesn't exist: Porter stemming over Unicode words, diacritics folded. */
export async function createTextFts(db: Db): Promise<void> {
  const columns = sql.join(FTS_COLUMNS.map((column) => sql.ref(column)));
  await sql`create virtual table if not exists ${sql.table(TEXT_FTS)} using fts5(${columns}, tokenize = 'porter unicode61 remove_diacritics 2')`.execute(db);
}
