import { limiter } from '@ayepi/rate';
import { createWork, defineWork, balancedDoer } from '@ayepi/work';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestStore } from './fixtures.ts';
import type { SqliteStore } from './sqlite.ts';

let clock = 1_000_000;
const now = (): number => clock;
let store: SqliteStore;
beforeEach(async () => {
  clock = 1_000_000;
  store = await openTestStore({ now });
});
afterEach(async () => {
  await store.close();
});

describe('work store', () => {
  it('gets, sets, expires and deletes', async () => {
    const kv = store.ports.work.store;
    expect(await kv.get('a')).toBeUndefined();
    await kv.set('a', '1', 100);
    expect(await kv.get('a')).toBe('1');
    clock += 101;
    expect(await kv.get('a')).toBeUndefined();
    await kv.set('b', '2');
    await kv.delete('b');
    expect(await kv.get('b')).toBeUndefined();
  });

  it('claims a key once, and again after it expires', async () => {
    const kv = store.ports.work.store;
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => kv.setIfNotExists('lease', String(i), 50)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    clock += 51;
    expect(await kv.setIfNotExists('lease', 'late', 50)).toBe(true);
    expect(await kv.get('lease')).toBe('late');
  });

  it('increments atomically under concurrency', async () => {
    const kv = store.ports.work.store;
    const values = await Promise.all(Array.from({ length: 200 }, () => kv.increment('n', 1)));
    expect(new Set(values).size).toBe(200);
    expect(await kv.get('n')).toBe('200');
    expect(await kv.increment('n', -50)).toBe(150);
  });
});

describe('rate store', () => {
  it('backs a limiter: allows up to the limit per window, and resets', async () => {
    const limit = limiter({ limit: 3, window: 1_000, store: store.ports.rate });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limit.check('ip', { now: clock }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]?.retryAfter).toBeGreaterThan(0);
    expect((await limit.check('other', { now: clock })).allowed).toBe(true);
    expect((await limit.check('ip', { now: clock + 1_001 })).allowed).toBe(true);
    await limit.reset('ip');
    expect((await limit.check('ip', { now: clock + 1_001 })).remaining).toBe(2);
  });

  it('weighs hits by cost', async () => {
    const spend = limiter({ limit: 100, window: 60_000, store: store.ports.rate });
    expect((await spend.check('turn', { now: clock, cost: 60 })).allowed).toBe(true);
    expect((await spend.check('turn', { now: clock, cost: 60 })).allowed).toBe(false);
    expect((await spend.check('turn', { now: clock, cost: 40 })).remaining).toBe(0);
  });
});

describe('queue', () => {
  it('leases, acks, retries and dead-letters', async () => {
    const queue = store.ports.work.queue;
    await queue.push('a');
    await queue.push('b', { delay: 100 });
    expect(await queue.size()).toBe(2);
    const [a] = await queue.pop(10, 1_000);
    expect(a).toMatchObject({ body: 'a', attempt: 1 });
    expect(await queue.pop(10, 1_000)).toEqual([]);
    clock += 100;
    const [b] = await queue.pop(10, 1_000);
    expect(b?.body).toBe('b');
    if (a === undefined || b === undefined) throw new Error('expected two items');
    await queue.ack(a);
    await queue.fail(b, 10);
    clock += 10;
    const [again] = await queue.pop(1, 1_000);
    expect(again).toMatchObject({ body: 'b' });
    if (again === undefined) throw new Error('expected a redelivery');
    await queue.heartbeat(again, 5_000);
    await queue.ack(again);
    await queue.deadLetter('c', 'gave up');
    expect(await queue.size()).toBe(0);
    expect(await queue.dead()).toEqual([{ body: 'c', error: 'gave up', at: clock }]);
  });

  it('redelivers an item whose lease lapsed, with the next attempt, and ignores the stale lease', async () => {
    const queue = store.ports.work.queue;
    await queue.push('x');
    const [first] = await queue.pop(1, 100);
    if (first === undefined) throw new Error('expected an item');
    clock += 101;
    const [second] = await queue.pop(1, 100);
    expect(second).toMatchObject({ body: 'x', attempt: 2 });
    await queue.ack(first);
    expect(await queue.size()).toBe(1);
    if (second === undefined) throw new Error('expected a redelivery');
    await queue.ack(second);
    expect(await queue.size()).toBe(0);
  });

  it('dedupes pushes while the first is queued', async () => {
    const queue = store.ports.work.queue;
    await queue.push('once', { dedupeKey: 'k' });
    await queue.push('twice', { dedupeKey: 'k' });
    expect(await queue.size()).toBe(1);
  });

  it('keeps named queues apart, each made once', async () => {
    const bulk = store.ports.queue('bulk');
    await bulk.push('in bulk');
    expect(await bulk.size()).toBe(1);
    expect(await store.ports.queue('bulk').size()).toBe(1);
    expect(await store.ports.work.queue.size()).toBe(0);
    await store.tx(async (tx) => {
      await tx.ports.queue('bulk').push('in tx');
    });
    expect(await bulk.size()).toBe(2);
  });

  it('only queues work pushed in a transaction if it commits', async () => {
    await store.tx(async (tx) => { await tx.ports.work.queue.push('committed'); });
    await store.tx(async (tx) => {
      await tx.ports.work.store.set('k', 'v');
      await tx.ports.work.queue.push('rolled back');
      throw new Error('no');
    }).catch(() => undefined);
    const items = await store.ports.work.queue.pop(10, 1_000);
    expect(items.map((i) => i.body)).toEqual(['committed']);
    expect(await store.ports.work.store.get('k')).toBeUndefined();
  });

  it('shares pub/sub in process', async () => {
    const heard: string[] = [];
    const stop = store.ports.work.pubsub.subscribe((m) => heard.push(m));
    store.ports.work.pubsub.publish('wake');
    stop();
    store.ports.work.pubsub.publish('unheard');
    expect(heard).toEqual(['wake']);
  });
});

describe('createWork on the store', () => {
  it('runs work through the sqlite ports', async () => {
    const real = await openTestStore();
    try {
      const double = defineWork('double', (input: { n: number }, ctx) => ctx.result(input.n * 2));
      const work = createWork({ work: [double] as const, ...real.ports.work, pollInterval: 5, doer: balancedDoer({ max: 4 }) });
      const results = await Promise.all(Array.from({ length: 20 }, (_, n) => work.enqueue(double({ n })).result()));
      expect(results).toEqual(Array.from({ length: 20 }, (_, n) => n * 2));
      await work.stop();
      expect(await real.ports.work.queue.size()).toBe(0);
    } finally {
      await real.close();
    }
  });
});
