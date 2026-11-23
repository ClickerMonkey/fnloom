import { priorityDoer } from '@ayepi/core/doer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { flow, mapConcurrent } from './flow.ts';

/** A promise and its settlers, so a test decides when each step finishes. */
function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Lets every queued microtask and timer run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('flow', () => {
  it('runs each step as soon as the steps it names have values, and types the result from the steps', async () => {
    const log: string[] = [];
    const a = gate<number>();
    const b = gate<string>();
    const running = flow()
      .step('a', () => { log.push('a'); return a.promise; })
      .step('b', () => { log.push('b'); return b.promise; })
      .step('double', ['a'], ({ a: value }) => { log.push('double'); return value * 2; })
      .step('both', ['double', 'b'], async ({ double, b: text }) => { log.push('both'); return `${text}${double}`; })
      .run();
    await tick();
    expect(log).toEqual(['a', 'b']);
    a.resolve(4);
    await tick();
    expect(log).toEqual(['a', 'b', 'double']);
    b.resolve('x');
    const result = await running;
    expect(log).toEqual(['a', 'b', 'double', 'both']);
    expect(result).toEqual({ a: 4, b: 'x', double: 8, both: 'x8' });
    expectTypeOf(result).toEqualTypeOf<{ readonly a: number; readonly b: string; readonly double: number; readonly both: string }>();
  });

  it('refuses at compile time a step that names a step not added before it, or a name used twice', () => {
    const one = flow().step('a', () => 1);
    // @ts-expect-error "b" is not a step yet
    expect(() => one.step('c', ['b'], () => 2)).toThrow('needs "b"');
    // @ts-expect-error "a" is already a step
    expect(() => one.step('a', () => 2)).toThrow('added twice');
    one.step('c', ['a'], ({ a }) => {
      expectTypeOf(a).toEqualTypeOf<number>();
      // @ts-expect-error only the named steps are given
      return a + inputsOf({ a }).b;
    });
  });

  it('keeps no more than `limit` steps running, and a step waiting on its inputs holds no slot', async () => {
    let running = 0;
    let most = 0;
    const work = (value: number) => async () => {
      running += 1;
      most = Math.max(most, running);
      await tick();
      running -= 1;
      return value;
    };
    const result = await flow({ limit: 2 })
      .step('a', work(1)).step('b', work(2)).step('c', work(3))
      .step('sum', ['a', 'b', 'c'], ({ a, b, c }) => a + b + c)
      .step('d', work(4))
      .run();
    expect(result.sum).toBe(6);
    expect(result.d).toBe(4);
    expect(most).toBe(2);
  });

  it('runs its steps through a shared doer when given one', async () => {
    const doer = priorityDoer({ max: 1 });
    const log: string[] = [];
    const step = (name: string) => async () => { log.push(`${name}+`); await tick(); log.push(`${name}-`); return name; };
    await flow({ doer }).step('a', step('a')).step('b', step('b')).run();
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-']);
  });

  it('rejects with the first error, aborts the steps still running, starts nothing more, and waits for the running ones', async () => {
    const slow = gate();
    let sawAbort = false;
    let later = false;
    const running = flow()
      .step('fails', async () => { await tick(); throw new Error('boom'); })
      .step('slow', async ({ signal }) => { signal.addEventListener('abort', () => { sawAbort = true; }); await slow.promise; return 1; })
      .step('after', ['fails'], () => { later = true; })
      .run();
    let settled = false;
    void running.catch(() => undefined).finally(() => { settled = true; });
    await tick();
    await tick();
    expect(sawAbort).toBe(true);
    expect(settled).toBe(false);
    slow.resolve();
    await expect(running).rejects.toThrow('boom');
    expect(later).toBe(false);
  });

  it('stops on the caller\'s abort with its reason, and refuses to start when already aborted', async () => {
    const controller = new AbortController();
    let started = 0;
    const running = flow({ signal: controller.signal, limit: 1 })
      .step('a', async ({ signal }) => { started += 1; await new Promise((resolve) => signal.addEventListener('abort', resolve)); })
      .step('b', () => { started += 1; })
      .run();
    await tick();
    controller.abort(new Error('stop'));
    await expect(running).rejects.toThrow('stop');
    expect(started).toBe(1);
    await expect(flow({ signal: controller.signal }).step('a', () => 1).run()).rejects.toThrow('stop');
  });
});

describe('mapConcurrent', () => {
  it('keeps the items\' order whatever order they finish in, and at most `limit` run at once', async () => {
    let running = 0;
    let most = 0;
    const result = await mapConcurrent([30, 10, 20, 0], async (ms, index) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return `${index}:${ms}`;
    }, { limit: 2 });
    expect(result).toEqual(['0:30', '1:10', '2:20', '3:0']);
    expect(most).toBe(2);
    expectTypeOf(result).toEqualTypeOf<string[]>();
  });

  it('runs everything at once without a limit', async () => {
    const gates = [gate(), gate(), gate()];
    let started = 0;
    const running = mapConcurrent(gates, async (item) => { started += 1; await item.promise; });
    await tick();
    expect(started).toBe(3);
    for (const item of gates) item.resolve();
    await running;
  });

  it('rejects with the first error and starts no more items', async () => {
    const seen: number[] = [];
    await expect(mapConcurrent([1, 2, 3, 4], async (item) => {
      seen.push(item);
      await tick();
      if (item === 1) throw new Error(`bad ${item}`);
      return item;
    }, { limit: 1 })).rejects.toThrow('bad 1');
    expect(seen).toEqual([1]);
  });

  it('returns an empty list for no items, and rejects when already aborted', async () => {
    expect(await mapConcurrent([], () => 1)).toEqual([]);
    await expect(mapConcurrent([1], () => 1, { signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone');
  });
});

/** Widens a step's inputs, for the compile-time check that only the named steps are typed. */
function inputsOf<T extends object>(inputs: T): T {
  return inputs;
}
