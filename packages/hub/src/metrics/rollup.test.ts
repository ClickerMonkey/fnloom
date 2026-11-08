import { DURATION_BUCKETS, FnStats, RunId, SystemName, TurnId, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ALICE } from '../execution/testing.ts';
import { addDuration, addSample, bucketOf, dayOf, emptyDurations, firstDay, foldDay, mean, mergeDurations, percentile, rollup, sampleOf, type RunSample } from './rollup.ts';

const NONE = FnStats.parse({ averageCost: 0, averageTime: 0 });
const DAY = Date.UTC(2026, 10, 7, 12);

/** A settled run of `fs/read`. */
function run(fields: Partial<Run> = {}): Run {
  return {
    id: RunId.parse('run_1'), fn: 'fs/read', fnVersion: 'v1', kind: 'native', system: SystemName.parse('fs'), root: RunId.parse('run_1'), turn: TurnId.parse('trn_1'), key: 'k',
    actor: ALICE, caller: ALICE, args: {}, status: 'done', allowed: { cancel: true, pause: false, background: false }, cost: 0.01, totalCost: 0.02, priority: 'interactive',
    background: false, attempt: 1, errors: [], stateChanges: [], createdAt: DAY, ...fields,
  };
}

/** A sample of an outcome with a run time. */
function sample(outcome: RunSample['outcome'], ran: number, extra: Partial<RunSample> = {}): RunSample {
  return { fn: 'fs/read', system: SystemName.parse('fs'), outcome, at: DAY, ran, queued: 10, cost: 0.01, tokens: 5, retries: 0, modelCalls: 1, ...extra };
}

describe('samples', () => {
  it('split the queue wait from the approval wait, and time the run from its start', () => {
    expect(sampleOf(run({ approvedAt: DAY + 400, startedAt: DAY + 500, endedAt: DAY + 1_500, attempt: 3, tokens: 42 }), 2)).toEqual({
      fn: 'fs/read', system: 'fs', outcome: 'done', at: DAY + 1_500, approval: 400, queued: 100, ran: 1_000, cost: 0.02, tokens: 42, retries: 2, modelCalls: 2,
    });
  });

  it('leave out the phases a run never reached, and skip statuses that are no outcome', () => {
    expect(sampleOf(run({ status: 'invalid-input', endedAt: DAY }), 0)).toEqual({
      fn: 'fs/read', system: 'fs', outcome: 'invalid-input', at: DAY, cost: 0.02, tokens: 0, retries: 0, modelCalls: 0,
    });
    expect(sampleOf(run({ status: 'undone' }), 0)).toBeUndefined();
    expect(sampleOf(run({ status: 'running' }), 0)).toBeUndefined();
  });
});

describe('durations', () => {
  it('fall in the first bucket they fit, with an overflow bucket past the last bound', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(50)).toBe(0);
    expect(bucketOf(51)).toBe(1);
    expect(bucketOf(300_000)).toBe(DURATION_BUCKETS.length - 1);
    expect(bucketOf(300_001)).toBe(DURATION_BUCKETS.length);
  });

  it('give percentiles within one bucket of the real value, never above the longest', () => {
    let stats = emptyDurations();
    const values = [12, 40, 70, 90, 120, 300, 800, 1_200, 4_000, 9_000];
    for (const value of values) stats = addDuration(stats, value);
    expect(stats).toMatchObject({ count: 10, sum: values.reduce((a, b) => a + b, 0), max: 9_000 });
    expect(percentile(stats, 0.5)).toBe(250);
    expect(percentile(stats, 0.95)).toBe(9_000);
    expect(percentile(addDuration(emptyDurations(), 400_000), 0.5)).toBe(400_000);
    expect(percentile(emptyDurations(), 0.5)).toBeUndefined();
    expect(mean(stats)).toBe(1_563);
    expect(addDuration(stats, undefined)).toBe(stats);
  });

  it('merge by adding counts, sums and buckets and keeping the longest', () => {
    const a = addDuration(emptyDurations(), 10);
    const b = addDuration(addDuration(emptyDurations(), 2_000), 20);
    const merged = mergeDurations(a, b);
    expect(merged).toMatchObject({ count: 3, sum: 2_030, max: 2_000 });
    expect(merged.histogram[0]).toBe(2);
  });
});

describe('days', () => {
  it('are UTC dates, and a period of n days starts n − 1 days back', () => {
    expect(dayOf(DAY)).toBe('2026-11-07');
    expect(firstDay(DAY, 1)).toBe('2026-11-07');
    expect(firstDay(DAY, 7)).toBe('2026-11-01');
  });

  it('fold each run in by its outcome, durations, cost, tokens, retries and model calls', () => {
    const once = foldDay(undefined, sample('done', 100), 5);
    const twice = foldDay(once, sample('invalid-input', 30, { retries: 1, queued: undefined }), 6);
    expect(twice).toMatchObject({
      fn: 'fs/read', system: 'fs', day: '2026-11-07', outcomes: { done: 1, 'invalid-input': 1, failed: 0, cancelled: 0 }, cost: 0.02, tokens: 10, retries: 1, modelCalls: 2, updatedAt: 6,
    });
    expect(twice.ran.count).toBe(2);
    expect(twice.queued.count).toBe(1);
  });

  it('roll up into a period with percentiles, means and the average cost', () => {
    const days = [foldDay(undefined, sample('done', 100), 1), foldDay(foldDay(undefined, sample('failed', 3_000), 1), sample('cancelled', 20), 1)];
    const metrics = rollup('fs/read', SystemName.parse('fs'), days, { from: '2026-11-01', to: '2026-11-07' }, DAY);
    expect(metrics).toMatchObject({
      fn: 'fs/read', from: '2026-11-01', to: '2026-11-07', runs: 3, outcomes: { done: 1, 'invalid-input': 0, failed: 1, cancelled: 1 }, p50: 100, p95: 3_000,
      averageQueued: 10, cost: 0.03, tokens: 15, lastRunAt: DAY,
    });
    expect(metrics.averageCost).toBeCloseTo(0.01);
    expect(rollup('fs/read', SystemName.parse('fs'), [], { from: '2026-11-07', to: '2026-11-07' })).toMatchObject({ runs: 0, averageCost: 0 });
  });
});

describe('a fn’s running numbers', () => {
  it('count each outcome apart, keep running means and add up tokens', () => {
    const once = addSample(NONE, sample('done', 100, { queued: 20 }), 100);
    expect(once).toEqual({ outcomes: { done: 1, 'invalid-input': 0, failed: 0, cancelled: 0 }, averageCost: 0.01, averageTime: 100, lastRunAt: DAY, tokens: 5, averageQueued: 20, p95: 100 });
    const twice = addSample(once, sample('invalid-input', 301, { queued: 40, at: DAY - 5 }), undefined);
    expect(twice).toMatchObject({ outcomes: { done: 1, 'invalid-input': 1, failed: 0 }, averageTime: 201, averageQueued: 30, lastRunAt: DAY, tokens: 10 });
    const thrice = addSample(twice, sample('failed', 0, { queued: undefined }), 250);
    expect(thrice).toMatchObject({ outcomes: { done: 1, 'invalid-input': 1, failed: 1, cancelled: 0 }, averageQueued: 30, p95: 250 });
  });
});
