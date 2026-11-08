import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUX_TABLES, TEXT_FTS, createAuxTable, createTextFts, type AuxTableName } from './auxTables.ts';
import { type Db, openKysely } from './db.ts';

let db: Db;
beforeEach(() => {
  db = openKysely(new Database(':memory:'));
});
afterEach(async () => {
  await db.destroy();
});

const Column = z.object({ name: z.string(), type: z.string(), notnull: z.number(), pk: z.number() });

async function tableInfo(table: string): Promise<Array<z.infer<typeof Column>>> {
  const result = await sql`select name, type, "notnull", pk from pragma_table_info(${table}) order by cid`.execute(db);
  return result.rows.map((row) => Column.parse(row));
}

describe('bookkeeping tables', () => {
  it('makes each table with one column per field of its schema, the key as primary key', async () => {
    const names: AuxTableName[] = ['_tables', '_vectors', '_text_docs'];
    for (const name of names) {
      await createAuxTable(db, name);
      const columns = await tableInfo(name);
      expect(columns.map((c) => c.name)).toEqual(Object.keys(AUX_TABLES[name].row.shape));
      expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([AUX_TABLES[name].key]);
    }
    expect(await tableInfo('_vectors')).toEqual([
      { name: 'embedder', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'table', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'dimensions', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);
  });

  it('lets SQLite assign a generated key and keeps unique column sets unique', async () => {
    await createAuxTable(db, '_text_docs');
    const first = await db.insertInto('_text_docs').values({ kind: 'fn', key: 'a' }).returning('id').executeTakeFirstOrThrow();
    expect(first.id).toBe(1);
    await expect(db.insertInto('_text_docs').values({ kind: 'fn', key: 'a' }).execute()).rejects.toThrow(/UNIQUE/);
  });

  it('makes the FTS table with the text columns of its schema', async () => {
    await createTextFts(db);
    await createTextFts(db);
    await db.insertInto(TEXT_FTS).values({ rowid: 7, text: 'hello world' }).execute();
    expect(await db.selectFrom(TEXT_FTS).select(['rowid', 'text']).execute()).toEqual([{ rowid: 7, text: 'hello world' }]);
  });

  it('checks the column names of bookkeeping tables at compile time', () => {
    // compile-time only: each line names a column the table doesn't have
    const typed = (): unknown[] => [
      // @ts-expect-error `_vectors` has no `size` column
      db.selectFrom('_vectors').select('size'),
      // @ts-expect-error `_text_docs` has no `uri` column
      db.selectFrom('_text_docs').selectAll().where('uri', '=', 'x'),
      // @ts-expect-error `dimensions` holds numbers
      db.insertInto('_vectors').values({ embedder: 'e', table: 't', dimensions: 'many' }),
      // @ts-expect-error `_text_fts` has no `body` column
      db.insertInto(TEXT_FTS).values({ rowid: 1, body: 'x' }),
    ];
    expect(typed).toBeTypeOf('function');
  });
});
