import { Kysely, SqliteDialect, type CompiledQuery, sql } from 'kysely';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { StoredDb } from './db.ts';
import { StoreError } from './errors.ts';
import { afterCursor, makeCursor, orderColumns, whereCondition } from './query.ts';
import { KEY_COLUMN, tableLayout } from './schema.ts';

const db = new Kysely<StoredDb>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
const compile = (condition: ReturnType<typeof whereCondition>): CompiledQuery => sql`select 1 where ${condition}`.compile(db);
const layout = tableLayout('notifications');

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return error instanceof StoreError ? error.code : 'another error';
  }
};

describe('whereCondition', () => {
  it('builds each filter with encoded values', () => {
    const query = compile(whereCondition('notifications', layout, {
      user: 'act_1', read: false, createdAt: { gte: 5 }, reason: { in: ['replied', 'spend-limit'] }, title: { exists: true }, body: undefined,
    }));
    expect(query.sql).toBe('select 1 where ("user" = ? and "read" = ? and "createdAt" >= ? and "reason" in (?, ?) and "title" is not null)');
    expect(query.parameters).toEqual(['act_1', 0, 5, 'replied', 'spend-limit']);
    expect(compile(whereCondition('notifications', layout, undefined)).sql).toBe('select 1 where 1 = 1');
    expect(compile(whereCondition('notifications', layout, { read: { in: [] } })).sql).toBe('select 1 where (1 = 0)');
  });

  it('refuses JSON columns, unknown columns, unknown operators and wrong value types', () => {
    expect(codeOf(() => whereCondition('notifications', layout, { link: 'x' }))).toBe('bad-query');
    expect(codeOf(() => whereCondition('notifications', layout, { nope: 1 }))).toBe('bad-query');
    expect(codeOf(() => whereCondition('notifications', layout, { read: { between: [1, 2] } }))).toBe('bad-query');
    expect(codeOf(() => whereCondition('notifications', layout, { read: { gt: 1, lt: 2 } }))).toBe('bad-query');
    expect(codeOf(() => whereCondition('notifications', layout, { read: 'yes' }))).toBe('bad-query');
    expect(codeOf(() => whereCondition('notifications', layout, { createdAt: { in: ['soon'] } }))).toBe('bad-query');
  });
});

describe('cursors', () => {
  const columns = orderColumns('notifications', layout, [['createdAt', 'desc']]);

  it('always ends the order with the key', () => {
    expect(columns).toEqual([{ column: 'createdAt', direction: 'desc' }, { column: KEY_COLUMN, direction: 'asc' }]);
    expect(codeOf(() => orderColumns('notifications', layout, [['link', 'asc']]))).toBe('bad-query');
  });

  it('continues strictly after the last row, nulls last when descending', () => {
    const cursor = makeCursor('notifications', columns, { createdAt: 7, [KEY_COLUMN]: 'k' });
    const query = compile(afterCursor('notifications', columns, cursor));
    expect(query.sql).toBe('select 1 where (("createdAt" < ? or "createdAt" is null) or ("createdAt" = ? and "_key" > ?))');
    expect(query.parameters).toEqual([7, 7, 'k']);
    const fromNull = compile(afterCursor('notifications', columns, makeCursor('notifications', columns, { createdAt: null, [KEY_COLUMN]: 'k' })));
    expect(fromNull.sql).toBe('select 1 where (1 = 0 or ("createdAt" is null and "_key" > ?))');
  });

  it('refuses a cursor of another order, table or shape', () => {
    const cursor = makeCursor('notifications', columns, { createdAt: 7, [KEY_COLUMN]: 'k' });
    expect(codeOf(() => afterCursor('ledger', columns, cursor))).toBe('bad-cursor');
    expect(codeOf(() => afterCursor('notifications', orderColumns('notifications', layout, undefined), cursor))).toBe('bad-cursor');
    expect(codeOf(() => afterCursor('notifications', columns, Buffer.from('{"order":1}').toString('base64url')))).toBe('bad-cursor');
    expect(codeOf(() => makeCursor('notifications', columns, { createdAt: new Uint8Array(1), [KEY_COLUMN]: 'k' }))).toBe('another error');
  });
});
