import { type Actor, ActorId, HUB_TABLES, type KeyOf, type LedgerEntry, type LedgerId, type Membership, type RowOf, SessionId, SystemName, type RunId } from '@harness/core';
import { expectType, type Equal } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreError } from './errors.ts';
import { actorId, ledger, notification, openTestStore, user } from './fixtures.ts';
import type { HubTable, Order, Table, Where } from './index.ts';
import type { SqliteStore } from './sqlite.ts';

let store: SqliteStore;
beforeEach(async () => {
  store = await openTestStore();
});
afterEach(async () => {
  await store.close();
});

const refusal = async (promise: Promise<unknown>): Promise<StoreError> => {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof StoreError)) throw new Error(`expected a StoreError, got ${String(error)}`);
  return error;
};

/** Every row of a table, paging with cursors. */
async function pageAll<Row, Key>(table: Table<Row, Key>, query: Omit<Parameters<Table<Row, Key>['find']>[0], 'cursor'>): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await table.find({ ...query, cursor });
    rows.push(...page.items);
    cursor = page.cursor;
    pages++;
  } while (cursor !== undefined);
  return { rows, pages };
}

describe('types', () => {
  it('types each table by its row schema', () => {
    expectType<Equal<ReturnType<typeof store.table<'ledger'>>, HubTable<'ledger'>>>(true);
    expectType<Equal<ReturnType<typeof store.table<'actors'>>, HubTable<'actors'>>>(true);
    expectType<Equal<HubTable<'ledger'>, Table<LedgerEntry, LedgerId>>>(true);
    expectType<Equal<RowOf<'actors'>, Actor>>(true);
  });

  it('keys each table by its key definition: a branded id, or the parts of a composite key by name', () => {
    expectType<Equal<KeyOf<'runs'>, RunId>>(true);
    expectType<Equal<KeyOf<'systems'>, SystemName>>(true);
    expectType<Equal<KeyOf<'memberships'>, Readonly<Pick<Membership, 'group' | 'user'>>>>(true);
    // compile-time only: each line passes a key the table doesn't take
    const typed = (): unknown[] => [
      // @ts-expect-error a plain string is not a system name
      store.table('systems').get('shop'),
      // @ts-expect-error a hand-joined string is not a composite key
      store.table('memberships').get(['act_g', 'act_1'].join('\u0000')),
      // @ts-expect-error a composite key needs every part
      store.table('stateFields').get({ session: SessionId.parse('ses_1'), system: SystemName.parse('fs'), name: 'cwd' }),
    ];
    expect(typed).toBeTypeOf('function');
    expect(HUB_TABLES.stateFields.fields).toEqual(['session', 'system', 'name', 'type']);
  });

  it('only lets scalar fields be filtered and ordered', () => {
    const ok: Where<RowOf<'notifications'>> = { user: actorId(1), read: false, createdAt: { gt: 1 } };
    expect(ok).toBeDefined();
    // @ts-expect-error `link` is an object, stored as JSON: not filterable
    const bad: Where<RowOf<'notifications'>> = { link: { session: SessionId.parse('ses_1') } };
    expect(bad).toBeDefined();
    // @ts-expect-error a filter value must be the field's type
    const wrong: Where<RowOf<'ledger'>> = { tokens: 'many' };
    expect(wrong).toBeDefined();
    // @ts-expect-error `participants` is an array: not orderable
    const order: Order<RowOf<'sessions'>> = [['participants', 'asc']];
    expect(order).toBeDefined();
  });
});

describe('rows', () => {
  it('inserts, reads, replaces and removes a row', async () => {
    const actors = store.table('actors');
    expect(await actors.insert(user(1))).toEqual(user(1));
    expect(await actors.get(actorId(1))).toEqual(user(1));
    await actors.put(user(1, { name: 'Renamed', timeZone: 'Europe/Oslo' }));
    expect(await actors.get(actorId(1))).toEqual(user(1, { name: 'Renamed', timeZone: 'Europe/Oslo' }));
    // put replaces the whole row: an optional field left out is gone
    await actors.put(user(1));
    expect(await actors.get(actorId(1))).toEqual(user(1));
    expect(await actors.remove(actorId(1))).toBe(true);
    expect(await actors.remove(actorId(1))).toBe(false);
    expect(await actors.get(actorId(1))).toBeUndefined();
  });

  it('stores every member of a union row', async () => {
    const actors = store.table('actors');
    await actors.insert({ id: actorId('g'), kind: 'group', name: 'Team', about: '', createdAt: 1, disabled: false });
    await actors.insert({ id: actorId('s'), kind: 'system', name: 'fs', about: '', createdAt: 2, disabled: true, system: SystemName.parse('fs') });
    expect(await actors.get(actorId('g'))).toEqual({ id: 'act_g', kind: 'group', name: 'Team', about: '', createdAt: 1, disabled: false });
    expect(await actors.get(actorId('s'))).toMatchObject({ kind: 'system', system: 'fs', disabled: true });
    expect(await actors.count({ kind: { in: ['group', 'system'] } })).toBe(2);
  });

  it('keeps JSON fields, booleans and absent optionals exactly', async () => {
    const notifications = store.table('notifications');
    const row = notification(1, { read: true, link: { system: SystemName.parse('fs') } });
    await notifications.insert(row);
    expect(await notifications.get(row.id)).toEqual(row);
  });

  it('keys composite tables by their parts', async () => {
    const memberships = store.table('memberships');
    const row = { group: actorId('g'), user: actorId(1), addedBy: actorId(1), addedAt: 1 };
    await memberships.insert(row);
    expect(await memberships.get({ user: actorId(1), group: actorId('g') })).toEqual(row);
  });

  it('refuses an insert of an existing key', async () => {
    await store.table('actors').insert(user(1));
    const error = await refusal(store.table('actors').insert(user(1, { name: 'Other' })));
    expect(error.code).toBe('exists');
    expect((await store.table('actors').get(actorId(1)))?.name).toBe('User 1');
  });

  it('refuses a row its schema refuses, before writing', async () => {
    const bad = { ...user(1), email: 42 };
    // @ts-expect-error the row is wrong on purpose
    const error = await refusal(store.table('actors').insert(bad));
    expect(error.code).toBe('invalid-row');
    expect(await store.table('actors').count()).toBe(0);
  });

  it('updates some fields and parses the result', async () => {
    const actors = store.table('actors');
    await actors.insert(user(1));
    const updated = await actors.update(actorId(1), { name: 'New', disabled: true });
    expect(updated).toEqual(user(1, { name: 'New', disabled: true }));
    expect(await actors.get(actorId(1))).toEqual(updated);
  });

  it('refuses an update of a missing key, a key change, or an invalid result', async () => {
    const actors = store.table('actors');
    expect((await refusal(actors.update(actorId(9), { name: 'x' }))).code).toBe('missing');
    await actors.insert(user(1));
    expect((await refusal(actors.update(actorId(1), { id: actorId(2) }))).code).toBe('key-change');
    expect((await refusal(actors.update(actorId(1), { createdAt: 1.5 }))).code).toBe('invalid-row');
    expect(await actors.get(actorId(1))).toEqual(user(1));
  });

});

describe('find', () => {
  beforeEach(async () => {
    const table = store.table('ledger');
    for (let n = 1; n <= 25; n++) {
      await table.insert(ledger(n, { session: n % 3 === 0 ? undefined : SessionId.parse(`ses_${n % 2}`), system: n <= 5 ? SystemName.parse('fs') : undefined }));
    }
  });

  it('filters by equality, lists, bounds and presence', async () => {
    const table = store.table('ledger');
    expect(await table.count()).toBe(25);
    expect(await table.count({ session: SessionId.parse('ses_1') })).toBe(9);
    expect(await table.count({ session: { exists: false } })).toBe(8);
    expect(await table.count({ session: { exists: true } })).toBe(17);
    expect(await table.count({ tokens: { gt: 100 } })).toBe(15);
    expect(await table.count({ tokens: { gte: 100 } })).toBe(16);
    expect(await table.count({ tokens: { lt: 100 } })).toBe(9);
    expect(await table.count({ tokens: { lte: 100 } })).toBe(10);
    expect(await table.count({ at: { in: [10_001, 10_002, 99] } })).toBe(2);
    expect(await table.count({ at: { in: [] } })).toBe(0);
    expect(await table.count({ system: SystemName.parse('fs'), tokens: { lte: 30 } })).toBe(3);
  });

  it('orders and pages with cursors, absent values first ascending', async () => {
    const table = store.table('ledger');
    const { rows, pages } = await pageAll(table, { order: [['session', 'asc'], ['at', 'desc']], limit: 4 });
    expect(pages).toBe(7);
    expect(rows).toHaveLength(25);
    const sessions = rows.map((r) => r.session ?? null);
    expect(sessions.slice(0, 8)).toEqual(Array(8).fill(null));
    expect(sessions.slice(8).every((s, i, all) => i === 0 || (all[i - 1] ?? '') <= (s ?? ''))).toBe(true);
    // within a session, newest first
    const ses0 = rows.filter((r) => r.session === 'ses_0').map((r) => r.at);
    expect(ses0).toEqual([...ses0].sort((a, b) => b - a));
  });

  it('pages descending with absent values last', async () => {
    const { rows } = await pageAll(store.table('ledger'), { order: [['system', 'desc']], limit: 3 });
    expect(rows.slice(0, 5).every((r) => r.system === 'fs')).toBe(true);
    expect(rows.slice(5).every((r) => r.system === undefined)).toBe(true);
    // ties are ordered by key
    expect(rows.slice(5).map((r) => r.id)).toEqual(rows.slice(5).map((r) => r.id).sort());
  });

  it('pages with a filter, and rows added while paging never shift a page', async () => {
    const table = store.table('ledger');
    const first = await table.find({ where: { session: { exists: true } }, order: [['at', 'asc']], limit: 10 });
    expect(first.items).toHaveLength(10);
    // an earlier row arrives: it sorts before the cursor, so the next page doesn't repeat or skip anything
    await table.insert(ledger(100, { at: 0, session: SessionId.parse('ses_0') }));
    const second = await table.find({ where: { session: { exists: true } }, order: [['at', 'asc']], limit: 100, cursor: first.cursor });
    expect(second.items).toHaveLength(7);
    expect(second.cursor).toBeUndefined();
    const seen = new Set([...first.items, ...second.items].map((r) => r.id));
    expect(seen.size).toBe(17);
  });

  it('defaults to key order and returns no cursor on the last page', async () => {
    const page = await store.table('ledger').find({ limit: 100 });
    expect(page.items.map((r) => r.id)).toEqual(page.items.map((r) => r.id).sort());
    expect(page.cursor).toBeUndefined();
  });

  it('refuses a cursor made for another query, or not made at all', async () => {
    const table = store.table('ledger');
    const page = await table.find({ order: [['at', 'asc']], limit: 2 });
    expect(page.cursor).toBeDefined();
    expect((await refusal(table.find({ order: [['at', 'desc']], limit: 2, cursor: page.cursor }))).code).toBe('bad-cursor');
    expect((await refusal(store.table('notifications').find({ order: [['createdAt', 'asc']], limit: 2, cursor: page.cursor }))).code).toBe('bad-cursor');
    expect((await refusal(table.find({ limit: 2, cursor: 'not a cursor' }))).code).toBe('bad-cursor');
  });

  it('refuses a limit that is not a whole number of at least 1', async () => {
    const table = store.table('ledger');
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await refusal(table.find({ limit }))).code, String(limit)).toBe('bad-query');
    }
  });

});

describe('transactions', () => {
  it('commits everything together', async () => {
    await store.tx(async (tx) => {
      await tx.table('actors').insert(user(1));
      await tx.table('actors').insert(user(2));
    });
    expect(await store.table('actors').count()).toBe(2);
  });

  it('rolls everything back when the work throws', async () => {
    await expect(store.tx(async (tx) => {
      await tx.table('actors').insert(user(1));
      await tx.text.upsert([{ kind: 'fn', key: 'fs/read', text: 'read a file' }]);
      await tx.ports.work.queue.push('job');
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(await store.table('actors').count()).toBe(0);
    expect(await store.text.search({ text: 'file', kinds: ['fn'], limit: 5 })).toEqual([]);
    expect(await store.ports.work.queue.size()).toBe(0);
  });

  it('nests as savepoints: an inner failure rolls back only the inner work', async () => {
    await store.tx(async (tx) => {
      await tx.table('actors').insert(user(1));
      await expect(tx.tx(async (inner) => {
        await inner.table('actors').insert(user(2));
        throw new Error('inner');
      })).rejects.toThrow('inner');
      await tx.tx(async (inner) => {
        await inner.table('actors').insert(user(3));
      });
    });
    const ids = (await store.table('actors').find({ limit: 10 })).items.map((a) => a.id);
    expect(ids).toEqual([actorId(1), actorId(3)]);
  });

  it('keeps other callers out until it finishes', async () => {
    const order: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tx = store.tx(async (t) => {
      await t.table('actors').insert(user(1));
      order.push('tx wrote');
      await held;
      order.push('tx done');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const outside = store.table('actors').count().then((n) => { order.push(`outside read ${n}`); });
    const port = store.ports.work.queue.push('later').then(() => { order.push('port pushed'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['tx wrote']);
    release();
    await Promise.all([tx, outside, port]);
    expect(order.slice(0, 2)).toEqual(['tx wrote', 'tx done']);
    expect(order).toContain('outside read 1');
    expect(order).toContain('port pushed');
  });

  it('tells a transaction store from the store, and only the store closes', async () => {
    expect(store.inTransaction).toBe(false);
    await store.tx(async (tx) => {
      expect(tx).not.toBe(store);
      await expect(tx.close()).rejects.toMatchObject({ code: 'in-transaction' });
    });
  });

  it('runs a transaction that returns a value', async () => {
    const value = await store.tx(async (tx) => (await tx.table('actors').insert(user(5))).id);
    expect(value).toBe(ActorId.parse('act_5'));
  });
});
