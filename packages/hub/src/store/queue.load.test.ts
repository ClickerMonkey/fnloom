/**
 * Load test for the SQLite work queue (design risk 8): many consumers leasing at once, transactions holding the
 * connection while they do, two connections on one file, and the whole work engine on top. Every item must be
 * delivered exactly once (no lease lapses here), none lost, none leased twice.
 */
import type { PulledWork } from '@ayepi/work';
import { balancedDoer, createWork, defineWork } from '@ayepi/work';
import { describe, expect, it } from 'vitest';
import { openTestStore, tempDir, user } from './fixtures.ts';
import type { HubQueue } from './index.ts';
import type { SqliteStore } from './sqlite.ts';

const ITEMS = 2_000;

/** Drain a queue with `consumers` concurrent workers; returns every body each worker acked. */
async function drain(queues: readonly HubQueue[], consumers: number, onBatch?: (batch: readonly PulledWork[]) => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  let idle = 0;
  const worker = async (queue: HubQueue): Promise<void> => {
    for (;;) {
      const batch = await queue.pop(10, 60_000);
      if (batch.length === 0) {
        if (++idle > consumers * 3) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      idle = 0;
      await onBatch?.(batch);
      for (const item of batch) {
        seen.push(item.body);
        expect(item.attempt).toBe(1);
        await queue.ack(item);
      }
    }
  };
  await Promise.all(Array.from({ length: consumers }, (_, i) => worker(queues[i % queues.length] ?? queues[0] ?? fail())));
  return seen;
}

const fail = (): never => {
  throw new Error('no queue');
};

function expectExactlyOnce(seen: readonly string[], count: number): void {
  expect(seen).toHaveLength(count);
  expect(new Set(seen).size).toBe(count);
}

async function fill(queue: HubQueue, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, i) => queue.push(`item-${i}`)));
}

describe('queue under load', () => {
  it('delivers every item exactly once to 16 concurrent consumers while transactions hold the connection', async () => {
    const store = await openTestStore();
    try {
      await fill(store.ports.work.queue, ITEMS);
      expect(await store.ports.work.queue.size()).toBe(ITEMS);
      let n = 0;
      const started = performance.now();
      const seen = await drain([store.ports.work.queue], 16, async () => {
        // every few batches, a transaction that spans awaits: consumers must wait for it, not interleave with it
        if (++n % 5 !== 0) return;
        await store.tx(async (tx) => {
          await tx.table('actors').put(user(n));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await tx.ports.work.store.increment('tx-count', 1);
        });
      });
      const elapsed = performance.now() - started;
      expectExactlyOnce(seen, ITEMS);
      expect(await store.ports.work.queue.size()).toBe(0);
      expect(await store.ports.work.store.get('tx-count')).toBe(String(Math.floor(n / 5)));
      // a generous bound: it catches a pathological slowdown, not machine speed
      expect(elapsed).toBeLessThan(20_000);
    } finally {
      await store.close();
    }
  }, 60_000);

  it('never leases an item twice across two connections to one file', async () => {
    const tmp = tempDir();
    const stores: SqliteStore[] = [];
    try {
      const file = tmp.file('queue.sqlite');
      stores.push(await openTestStore({ file }), await openTestStore({ file }));
      const [a, b] = stores;
      if (a === undefined || b === undefined) throw new Error('two stores');
      await Promise.all([fill(a.ports.queue('shared'), ITEMS / 2), b.ports.queue('shared').push('from-b')]);
      const seen = await drain([a.ports.queue('shared'), b.ports.queue('shared')], 8);
      expectExactlyOnce(seen, ITEMS / 2 + 1);
    } finally {
      for (const store of stores) await store.close();
      tmp.dispose();
    }
  }, 60_000);

  it('runs a thousand jobs through the work engine, each once, eight at a time', async () => {
    const store = await openTestStore();
    try {
      const runs = new Map<number, number>();
      let running = 0;
      let peak = 0;
      const job = defineWork('job', async (input: { n: number }, ctx) => {
        running++;
        peak = Math.max(peak, running);
        runs.set(input.n, (runs.get(input.n) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running--;
        return ctx.result(input.n);
      });
      const work = createWork({ work: [job] as const, ...store.ports.work, pollInterval: 2, doer: balancedDoer({ max: 8 }) });
      const results = await Promise.all(Array.from({ length: 1_000 }, (_, n) => work.enqueue(job({ n })).result()));
      await work.stop();
      expect(results).toEqual(Array.from({ length: 1_000 }, (_, n) => n));
      expect([...runs.values()].every((count) => count === 1)).toBe(true);
      expect(runs.size).toBe(1_000);
      expect(peak).toBeLessThanOrEqual(8);
      expect(await store.ports.work.queue.size()).toBe(0);
    } finally {
      await store.close();
    }
  }, 60_000);
});
