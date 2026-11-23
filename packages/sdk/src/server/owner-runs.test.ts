/**
 * `ctx.runs` and `ctx.notify` in a served system (`owner-runs.ts`): kind fns come parsed by the kind's payload type
 * and branded (a payload the kind no longer reads is left out), only a listed fn can be started or notified about, a
 * start carries its key, and a notice's page link is written from a page ref of the system's own.
 */
import { ActorId, QualifiedName, type KindFnWire } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { KIND_FN } from '../ctx.ts';
import { kind } from '../declare.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system, type SystemImpl } from '../system.ts';
import { testHub, type TestSystem } from '../testing/hub.ts';

const timer = system('timer', { description: 'Timers.', pages: [{ segment: 'item', title: 'Item', nav: 'hidden', component: 'ItemPage' }] })
  .with({ kinds: { plan: kind({ description: 'A plan.', applicability: 'Plans.', payload: g.obj({ every: g.text() }) }) } })
  .with({ fns: { ping: fn({ description: 'Tell the person.', args: g.obj({ text: g.text() }), returns: g.bool() }) } });

/** The ctx the system's own implementation gets: its own kinds and pages. */
type TimerCtx = Parameters<NonNullable<NonNullable<SystemImpl<(typeof timer)['defs']>['lifecycle']>['started']>>[0];

const ADA = ActorId.parse('act_ada');
const item = (name: string, payload: KindFnWire['payload']): KindFnWire => ({
  fn: QualifiedName.parse(name), kind: QualifiedName.parse('timer/plan'), owner: ADA, title: 'Weekly', version: 2, payload, removed: false, updatedAt: 10,
});

describe('ctx.runs and ctx.notify', () => {
  let kit: TestSystem<'timer', (typeof timer)['defs']> | undefined;
  afterEach(async () => { await kit?.stop(); kit = undefined; });

  async function served() {
    let ctx: TimerCtx | undefined;
    kit = await testHub(timer, {
      kinds: { plan: { check: () => Promise.resolve([]), describe: () => Promise.reject(new Error('not here')), run: (_p, _a, c) => Promise.resolve(c.done({})) } },
      fns: {
        ping: { run: async (args, c) => { await c.notify({ title: 'Ping', body: args.text, link: { page: timer.page.item, path: ['weekly'], query: { tab: 'history' } } }); return c.done(true); } },
      },
      lifecycle: { started: (c) => { ctx = c; return Promise.resolve(); } },
    });
    if (ctx === undefined) throw new Error('not started');
    return { kit, ctx };
  }

  it('lists kind fns parsed and branded, leaving out one the kind no longer reads, and starts and notifies only those', async () => {
    const { kit: k, ctx } = await served();
    k.hub.kindFns = [item('timer/weekly', { every: 'monday' }), item('timer/broken', { every: 7 })];
    const { items } = await ctx.runs.kindFns(timer.kinds.plan);
    expect(items.map((i) => [i.fn, i.payload, i.version])).toEqual([['timer/weekly', { every: 'monday' }, 2]]);
    const weekly = items[0];
    if (weekly === undefined) throw new Error('none');
    const first = await ctx.runs.start(weekly, { args: { at: 5 }, key: 'weekly@5', maxSpend: 0.5 });
    const again = await ctx.runs.start(weekly, { args: { at: 5 }, key: 'weekly@5' });
    expect(again.run).toBe(first.run);
    expect(k.hub.starts).toEqual([
      { fn: 'timer/weekly', args: { at: 5 }, key: 'weekly@5', maxSpend: 0.5 },
      { fn: 'timer/weekly', args: { at: 5 }, key: 'weekly@5' },
    ]);
    await ctx.runs.notify(weekly, {
      title: 'Weekly ran', body: '12 rows', tone: 'ok', key: 'weekly', link: { run: first.run },
      also: { label: 'History', link: { page: timer.page.item, path: ['weekly'], query: { tab: 'history' } } },
    });
    expect(k.hub.ownerNotices).toEqual([{
      fn: 'timer/weekly',
      notice: { title: 'Weekly ran', body: '12 rows', tone: 'ok', key: 'weekly', link: { run: first.run }, also: { label: 'History', link: { page: { system: 'timer', segment: 'item', path: ['weekly'], query: { tab: 'history' } } } } },
    }]);
    // a fn built by hand (not listed, so without its brand) is refused before anything reaches the hub
    const forged = { ...weekly };
    Reflect.deleteProperty(forged, KIND_FN);
    await expect(ctx.runs.start(forged, { args: {}, key: 'k' })).rejects.toThrow(/only a fn ctx.runs.kindFns listed/);
    expect(k.hub.starts).toHaveLength(2);
  });

  it('tells the run’s person from inside a run, its page link written from the ref', async () => {
    const { kit: k } = await served();
    expect((await k.run('ping', { text: 'Take the bins out.' })).outcome).toMatchObject({ status: 'done' });
    expect(k.hub.runNotices.map((sent) => sent.notice)).toEqual([
      { title: 'Ping', body: 'Take the bins out.', link: { page: { system: 'timer', segment: 'item', path: ['weekly'], query: { tab: 'history' } } } },
    ]);
  });
});
