import { doWith, type Doer, type DoerTaskOptions } from '@ayepi/core/doer';
import { rateLimitedDoer } from '@ayepi/rate';
import { priorityDoer } from '@ayepi/work';
import { describe, expect, it } from 'vitest';
import { priorityRank } from './limits.ts';
import { PriorityRateDoer } from './queues.ts';

/** A rate cap that admits nothing until opened, then one task per `open` call, oldest first (as the rate doer does). */
class GateDoer implements Doer {
  readonly #waiting: Array<() => Promise<void>> = [];
  readonly #running = new Set<Promise<void>>();

  available(): number {
    return 100;
  }

  do(task: () => Promise<void>, _opts?: DoerTaskOptions): void {
    this.#waiting.push(task);
  }

  /** Let the oldest waiting task start. */
  async open(): Promise<void> {
    const task = this.#waiting.shift();
    if (task === undefined) return;
    const running = task();
    this.#running.add(running);
    await running;
    this.#running.delete(running);
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  async done(): Promise<void> {
    await Promise.all(this.#running);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the LLM doer', () => {
  it('picks the most urgent call before the rate cap, so it never waits behind queued background calls', async () => {
    const gate = new GateDoer();
    const doer = new PriorityRateDoer(priorityDoer({ max: 1 }), gate);
    const ran: string[] = [];
    const call = (name: string, priority: Parameters<typeof priorityRank>[0]) =>
      doWith(doer, () => { ran.push(name); return Promise.resolve(); }, { priority: priorityRank(priority) });
    const all = [call('background 1', 'background'), call('background 2', 'background'), call('background 3', 'background')];
    await tick();
    // only the picked call waits on the rate; the others wait for the pick, by priority
    expect(gate.waiting).toBe(1);
    all.push(call('chat', 'interactive'));
    for (let i = 0; i < 4; i++) {
      await gate.open();
      await tick();
    }
    await Promise.all(all);
    expect(ran).toEqual(['background 1', 'chat', 'background 2', 'background 3']);
    await doer.done();
  });

  it('passes a failing call\'s error to its caller, and keeps going', async () => {
    const doer = new PriorityRateDoer(priorityDoer({ max: 2 }), rateLimitedDoer({ limit: 10, window: 60_000 }));
    await expect(doWith(doer, () => Promise.reject(new Error('provider down')))).rejects.toThrow('provider down');
    await expect(doWith(doer, () => Promise.resolve('fine'))).resolves.toBe('fine');
    expect(doer.available()).toBeGreaterThan(0);
    await doer.done();
  });
});
