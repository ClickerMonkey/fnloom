import { fn, g } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { addSample, sampleOf } from './stats.ts';
import { ALICE, executionRig, until, type ExecutionRig } from './testing.ts';

const NONE = { runs: 0, failures: 0, averageCost: 0, averageTime: 0 };

describe('fn numbers', () => {
  it('keep running means of cost and whole-ms time, counting failures', () => {
    const once = addSample(NONE, { failed: false, cost: 0.02, time: 100, at: 10 });
    expect(once).toEqual({ runs: 1, failures: 0, averageCost: 0.02, averageTime: 100, lastRunAt: 10 });
    const twice = addSample(once, { failed: true, cost: 0.04, time: 301, at: 5 });
    expect(twice).toMatchObject({ runs: 2, failures: 1, averageTime: 201, lastRunAt: 10 });
    expect(twice.averageCost).toBeCloseTo(0.03);
  });

  it('time a run from its start, or its creation when it never started, to its end', () => {
    const base = { createdAt: 1_000, totalCost: 0.5, status: 'done' } as const;
    expect(sampleOf({ ...base, status: 'failed' })).toEqual({ failed: true, cost: 0.5, time: 0, at: 1_000 });
    expect(sampleOf({ ...base, startedAt: 1_200, endedAt: 1_700 })).toEqual({ failed: false, cost: 0.5, time: 500, at: 1_700 });
  });
});

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

describe('runs settling', () => {
  it('add to their fn’s numbers and announce them', async () => {
    const r = await executionRig();
    rig = r;
    const record = r.catalog.add('fs', 'read', fn({ description: 'Read.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
    await r.store.table('fns').put(record);
    await r.module.start();
    const fs = r.connect('fs');
    const turn = await r.turn();
    const start = (key: string) => r.module.runs.start({ fn: 'fs/read', args: { path: key }, turn: turn.id, key, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] });
    await (await start('a')).settled;
    fs.behaviour.run = () => Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'no such file' } });
    await (await start('b')).settled;
    await until(() => r.bus.of('fn.stats').length === 2, 'both runs to be counted');
    expect((await r.store.table('fns').get('fs/read'))?.stats).toMatchObject({ runs: 2, failures: 1, averageCost: 0, lastRunAt: r.time.now });
    expect(r.bus.of('fn.stats').at(-1)).toMatchObject({ fn: 'fs/read', system: 'fs', stats: { runs: 2, failures: 1 } });
  });
});
