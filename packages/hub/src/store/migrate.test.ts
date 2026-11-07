import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Db, openKysely } from './db.ts';
import { StoreError } from './errors.ts';
import { memoryLog } from '../testing.ts';
import { actorId, openTestStore, tempDir, user } from './fixtures.ts';
import { type TablePlan, META_TABLE, ensureMeta, isChange, migrateTable } from './migrate.ts';
import { type ColumnKind, KEY_COLUMN, TABLE_NAMES, indexName } from './schema.ts';
import { SqliteStore } from './sqlite.ts';

let db: Db;
beforeEach(async () => {
  db = openKysely(new Database(':memory:'));
  await ensureMeta(db);
});
afterEach(async () => {
  await db.destroy();
});

const plan = (columns: Record<string, ColumnKind>, indexes: string[][] = []): TablePlan => ({ name: 'things', layout: new Map(Object.entries(columns)), indexes });

async function columns(): Promise<string[]> {
  const result = await sql`select name from pragma_table_info('things') order by cid`.execute(db);
  return result.rows.map((row) => z.object({ name: z.string() }).parse(row).name);
}

async function indexes(): Promise<string[]> {
  const result = await sql`select name from sqlite_master where type = 'index' and tbl_name = 'things' and name like 'ix_%' order by name`.execute(db);
  return result.rows.map((row) => z.object({ name: z.string() }).parse(row).name);
}

describe('migrateTable', () => {
  it('creates a table with a key column and its indexes', async () => {
    const change = await migrateTable(db, plan({ a: 'text', b: 'integer' }, [['a'], ['a', 'b']]));
    expect(change).toMatchObject({ created: true, rebuilt: false, added: [], indexesCreated: [indexName('things', ['a']), indexName('things', ['a', 'b'])] });
    expect(await columns()).toEqual([KEY_COLUMN, 'a', 'b']);
    expect(await indexes()).toEqual([indexName('things', ['a']), indexName('things', ['a', 'b'])].sort());
  });

  it('does nothing the second time', async () => {
    await migrateTable(db, plan({ a: 'text' }, [['a']]));
    const again = await migrateTable(db, plan({ a: 'text' }, [['a']]));
    expect(isChange(again)).toBe(false);
  });

  it('adds new fields as columns and keeps the data', async () => {
    await migrateTable(db, plan({ a: 'text' }));
    await db.insertInto('things').values({ [KEY_COLUMN]: 'k', a: 'x' }).execute();
    const change = await migrateTable(db, plan({ a: 'text', b: 'json' }));
    expect(change.added).toEqual(['b']);
    expect(await columns()).toEqual([KEY_COLUMN, 'a', 'b']);
    expect(await db.selectFrom('things').selectAll().execute()).toEqual([{ [KEY_COLUMN]: 'k', a: 'x', b: null }]);
  });

  it('keeps a removed field’s column and remembers its kind', async () => {
    await migrateTable(db, plan({ a: 'text', gone: 'integer' }));
    await db.insertInto('things').values({ [KEY_COLUMN]: 'k', a: 'x', gone: 3 }).execute();
    const change = await migrateTable(db, plan({ a: 'text' }));
    expect(change.retired).toEqual(['gone']);
    expect(await columns()).toContain('gone');
    // it comes back as another kind while rows hold it: refused
    await expect(migrateTable(db, plan({ a: 'text', gone: 'json' }))).rejects.toMatchObject({ code: 'migration' });
    // it comes back as the same kind: fine
    expect(isChange(await migrateTable(db, plan({ a: 'text', gone: 'integer' })))).toBe(false);
  });

  it('rebuilds an empty table whose column changed kind, and refuses one with rows', async () => {
    await migrateTable(db, plan({ a: 'text' }, [['a']]));
    const rebuilt = await migrateTable(db, plan({ a: 'json' }));
    expect(rebuilt).toMatchObject({ rebuilt: true, created: true, indexesDropped: [] });
    expect(await indexes()).toEqual([]);
    await db.insertInto('things').values({ [KEY_COLUMN]: 'k', a: '{}' }).execute();
    const error: unknown = await migrateTable(db, plan({ a: 'text' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(String(error)).toMatch(/a: json → text/);
  });

  it('drops indexes no longer declared and creates new ones', async () => {
    await migrateTable(db, plan({ a: 'text', b: 'real' }, [['a']]));
    const change = await migrateTable(db, plan({ a: 'text', b: 'real' }, [['b']]));
    expect(change.indexesDropped).toEqual([indexName('things', ['a'])]);
    expect(change.indexesCreated).toEqual([indexName('things', ['b'])]);
    expect(await indexes()).toEqual([indexName('things', ['b'])]);
    const meta = await db.selectFrom(META_TABLE).selectAll().where('name', '=', 'things').executeTakeFirstOrThrow();
    expect(JSON.parse(String(meta['indexes']))).toEqual([indexName('things', ['b'])]);
  });
});

describe('store migrate', () => {
  it('is safe on every start, and keeps data in a file across opens', async () => {
    const tmp = tempDir();
    try {
      const file = tmp.file('hub.sqlite');
      const first = await openTestStore({ file });
      await first.table('actors').insert(user(1));
      await first.close();
      const { log, records } = memoryLog();
      const second = SqliteStore.open({ file, dimensions: { 'embedder/test': 3 }, log });
      await second.migrate();
      await second.migrate();
      expect(await second.table('actors').get(actorId(1))).toEqual(user(1));
      // nothing changed after the first open, so only the summary is logged
      expect(records.filter((r) => r.msg === 'store.table.migrated')).toEqual([]);
      expect(records.filter((r) => r.msg === 'store.migrated')).toHaveLength(2);
      await second.close();
    } finally {
      tmp.dispose();
    }
  });

  it('logs each table it creates', async () => {
    const { log, records } = memoryLog();
    const store = SqliteStore.open({ file: ':memory:', dimensions: {}, log });
    await store.migrate();
    expect(records.filter((r) => r.msg === 'store.table.migrated')).toHaveLength(TABLE_NAMES.length);
    expect(records.find((r) => r.msg === 'store.migrated')).toMatchObject({ tables: TABLE_NAMES.length, changed: TABLE_NAMES.length, embedders: [] });
    await store.close();
  });
});
