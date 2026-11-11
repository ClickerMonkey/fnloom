/**
 * The drivers' own guarantees, without a server: a SQL Server statement that returns no rows reads as no rows (not a
 * crash), and a read-only SQLite database takes no writes, while no database's read runs a statement that writes.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_ONLY } from './drivers/database.ts';
import { SqliteDatabase } from './drivers/sqlite.ts';
import { rowsOf } from './drivers/sqlserver.ts';
import { shopFile } from './fixture.ts';

describe('SQL Server results', () => {
  it('reads a statement without a record set (an UPDATE, DDL) as no rows', () => {
    expect(rowsOf({})).toEqual({ columns: [], rows: [] });
  });
});

describe('read-only SQLite', () => {
  it('refuses writes, and a read that would write', async () => {
    const { dir, file } = shopFile('drivers-readonly');
    const db = new SqliteDatabase(join(dir, file), { create: false, readonly: true });
    try {
      await expect(db.write([{ sql: 'DELETE FROM orders', params: [] }])).rejects.toThrow(READ_ONLY);
      await expect(db.read({ sql: 'DELETE FROM orders', params: [] })).rejects.toThrow('may not change data');
      expect((await db.read({ sql: 'SELECT count(*) AS n FROM orders', params: [] })).rows[0]?.[0]).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('refuses a read that would write on a read-write database too', async () => {
    const { dir, file } = shopFile('drivers-readwrite');
    const db = new SqliteDatabase(join(dir, file), { create: false, readonly: false });
    try {
      await expect(db.read({ sql: 'UPDATE orders SET total = 0', params: [] })).rejects.toThrow('may not change data');
      expect((await db.write([{ sql: 'UPDATE orders SET total = total', params: [] }])).affected).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});
