import { doWith } from '@ayepi/core/doer';
import { describe, expect, it } from 'vitest';
import { priorityRank } from './limits.ts';
import { llmDoer } from './queues.ts';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the LLM doer', () => {
  it('admits the most urgent call first when the rate cap frees, so it never waits behind queued background calls', async () => {
    let now = 1_000;
    const doer = llmDoer({ max: 4, limit: 1, window: 50, now: () => now });
    const ran: string[] = [];
    const call = (name: string, priority: Parameters<typeof priorityRank>[0]) =>
      doWith(doer, () => { ran.push(name); return Promise.resolve(); }, { priority: priorityRank(priority) });
    const all = [call('background 1', 'background'), call('background 2', 'background'), call('background 3', 'background')];
    await wait(5);
    expect(ran).toEqual(['background 1']); // one start per window
    all.push(call('chat', 'interactive'));
    for (let i = 0; i < 3; i++) {
      now += 120; // past the sliding window, so the previous one no longer counts
      await wait(80);
    }
    await Promise.all(all);
    expect(ran).toEqual(['background 1', 'chat', 'background 2', 'background 3']);
    await doer.done();
  });

  it('admits only into a free slot, picking by priority when one frees', async () => {
    const doer = llmDoer({ max: 1, limit: 100, window: 60_000 });
    const ran: string[] = [];
    let release = (): void => undefined;
    const busy = doWith(doer, () => new Promise<void>((resolve) => { ran.push('busy'); release = resolve; }));
    await wait(5);
    const later = [
      doWith(doer, () => { ran.push('background'); return Promise.resolve(); }, { priority: priorityRank('background') }),
      doWith(doer, () => { ran.push('chat'); return Promise.resolve(); }, { priority: priorityRank('interactive') }),
    ];
    await wait(5);
    expect(ran).toEqual(['busy']);
    release();
    await Promise.all([busy, ...later]);
    expect(ran).toEqual(['busy', 'chat', 'background']);
    await doer.done();
  });

  it('passes a failing call\'s error to its caller, and keeps going', async () => {
    const doer = llmDoer({ max: 2, limit: 10, window: 60_000 });
    await expect(doWith(doer, () => Promise.reject(new Error('provider down')))).rejects.toThrow('provider down');
    await expect(doWith(doer, () => Promise.resolve('fine'))).resolves.toBe('fine');
    expect(doer.available()).toBeGreaterThan(0);
    await doer.done();
  });
});
