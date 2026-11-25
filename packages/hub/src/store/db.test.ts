import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, RootScope, openKysely } from './db.ts';
import { tempDir } from './fixtures.ts';

/** A file database in WAL (as the hub opens it), with one table of counters. */
let temp: ReturnType<typeof tempDir>;
let db: Db;
let root: RootScope;
let other: Database.Database;

beforeEach(async () => {
  temp = tempDir();
  const file = temp.file('hub.sqlite');
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 0');
  db = openKysely(database);
  root = new RootScope(db);
  await sql`create table counters (id text primary key, n integer not null)`.execute(db);
  await sql`insert into counters (id, n) values ('a', 1)`.execute(db);
  // another process writing the same file (the scenario runner's direct insert), which won't wait for the lock
  other = new Database(file);
  other.pragma('busy_timeout = 0');
});

afterEach(async () => {
  other.close();
  await db.destroy();
  temp.dispose();
});

const count = async (scope: { db: Db }): Promise<number> => {
  const { rows } = await sql<{ n: number }>`select n from counters where id = 'a'`.execute(scope.db);
  return rows[0]?.n ?? -1;
};

describe('transactions begin immediate', () => {
  it("a read-then-write transaction holds the write lock, so another connection's write can't overtake its snapshot", async () => {
    let otherError: unknown;
    await root.atomic(async (scope) => {
      const n = await count(scope);
      // with a deferred begin this insert committed, and the update below failed with "database is locked"
      try {
        other.prepare("insert into counters (id, n) values ('b', 1)").run();
      } catch (error) {
        otherError = error;
      }
      await sql`update counters set n = ${n + 1} where id = 'a'`.execute(scope.db);
    });
    expect(otherError).toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) as unknown });
    expect(await count(root)).toBe(2);
    // once the hub commits, the other connection writes fine
    other.prepare("insert into counters (id, n) values ('b', 1)").run();
    expect(other.prepare('select count(*) as c from counters').get()).toEqual({ c: 2 });
  });

  it('nested atomic work still uses savepoints: an inner failure rolls back only the inner work', async () => {
    await root.atomic(async (scope) => {
      await sql`update counters set n = 5 where id = 'a'`.execute(scope.db);
      await expect(scope.atomic(async (inner) => {
        expect(inner.inTransaction).toBe(true);
        await sql`update counters set n = 9 where id = 'a'`.execute(inner.db);
        throw new Error('inner fails');
      })).rejects.toThrow('inner fails');
      expect(await count(scope)).toBe(5);
      await scope.atomic(async (inner) => {
        await sql`insert into counters (id, n) values ('c', 3)`.execute(inner.db);
      });
    });
    expect(await count(root)).toBe(5);
    const { rows } = await sql<{ c: number }>`select count(*) as c from counters`.execute(db);
    expect(rows[0]?.c).toBe(2);
  });

  it('a failed transaction rolls back and releases the lock', async () => {
    await expect(root.atomic(async (scope) => {
      await sql`update counters set n = 7 where id = 'a'`.execute(scope.db);
      throw new Error('fails');
    })).rejects.toThrow('fails');
    expect(await count(root)).toBe(1);
    other.prepare("insert into counters (id, n) values ('b', 1)").run();
  });
});
