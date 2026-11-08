import { SystemName, type Json } from '@harness/core';
import { fn, g } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ALICE, executionRig, until, type ExecutionRig } from '../execution/testing.ts';

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** A rig with `fs/read` in the catalog and the store, fs connected and the module started. */
async function started() {
  const r = await executionRig();
  rig = r;
  const record = r.catalog.add('fs', 'read', fn({ description: 'Read.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  await r.store.table('fns').put(record);
  await r.module.start();
  const fs = r.connect('fs');
  const turn = await r.turn();
  const start = (key: string, args: Json = { path: key }) => r.module.runs.start({
    fn: 'fs/read', args, turn: turn.id, key, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
  });
  return { r, fs, start };
}

describe('fn metrics', () => {
  it('fold every settled run into its fn’s day and running numbers, and announce them', async () => {
    const { r, fs, start } = await started();
    await (await start('a')).settled;
    fs.behaviour.run = () => Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'no such file' } });
    await (await start('b')).settled;
    // a refused input is its own outcome, not a failure
    await (await start('c', { path: 3 })).settled;
    await until(() => r.bus.of('fn.stats').length === 3, 'every run to be counted');
    expect((await r.store.table('fns').get('fs/read'))?.stats).toMatchObject({ outcomes: { done: 1, 'invalid-input': 1, failed: 1, cancelled: 0 }, averageCost: 0, lastRunAt: r.time.now });
    expect(r.bus.of('fn.stats').at(-1)).toMatchObject({ fn: 'fs/read', system: 'fs', stats: { outcomes: { done: 1, 'invalid-input': 1, failed: 1 } } });
    const [day] = await r.metrics.days('fs/read', 1);
    expect(day).toMatchObject({ fn: 'fs/read', system: 'fs', outcomes: { done: 1, 'invalid-input': 1, failed: 1, cancelled: 0 } });
    expect(day?.ran.count).toBe(2);
    const [rolled] = await r.metrics.metrics({ system: SystemName.parse('fs') });
    expect(rolled).toMatchObject({ fn: 'fs/read', runs: 3, outcomes: { done: 1, 'invalid-input': 1, failed: 1 } });
  });

  it('fold a run once, however often it is handed in', async () => {
    const { r, start } = await started();
    const { run } = await start('a');
    await until(() => r.bus.of('fn.stats').length === 1, 'the run to be counted');
    const settled = await r.store.table('runs').get(run);
    if (settled === undefined) throw new Error('the run is gone');
    await r.metrics.settled(settled);
    await r.metrics.settled(settled);
    expect((await r.store.table('fns').get('fs/read'))?.stats.outcomes.done).toBe(1);
    expect((await r.metrics.days('fs/read', 1))[0]?.outcomes.done).toBe(1);
  });

  it('roll up only the days asked for, newest fns by runs first', async () => {
    const { r, start } = await started();
    await (await start('a')).settled;
    await until(() => r.bus.of('fn.stats').length === 1, 'the run to be counted');
    r.time.now += 10 * 86_400_000;
    expect(await r.metrics.metrics({ fn: 'fs/read', days: 7 })).toEqual([]);
    expect(await r.metrics.metrics({ fn: 'fs/read', days: 30 })).toMatchObject([{ runs: 1 }]);
  });
});
