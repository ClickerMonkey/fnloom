/**
 * Fn metrics (build 2 design 3.18): a system's fn list links each fn to its page, which shows its metrics strip
 * (runs, retried input apart from failures, typical and p95 time, waiting, cost, tokens) and its runs and typical
 * time per day, over a period in the URL (`?days=`), with a tooltip on the pointed day.
 */
import { runCount } from '@harness/core';
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, isTouch, open, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'fn-metrics', ref: 'build-2 3.18', title: 'Fn metrics', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    // the busiest fn of any connected system (some systems, like an embedder, have no fns)
    const connected = (await api.hub.call('systems', {})).filter((s) => s.status === 'connected');
    const fns = (await Promise.all(connected.map((s) => api.hub.call('systemFns', { system: s.name })))).flat();
    const fn = [...fns].sort((a, b) => runCount(b.stats.outcomes) - runCount(a.stats.outcomes))[0];
    check(fn !== undefined, 'a system has fns');
    const [system, local] = fn.name.split('/');

    await open(ctx, `/admin/systems/${system ?? ''}/fns`, tid('fns'));
    await page.click(`${tid('fns')} ${tid('fn-page')}`);
    await page.waitForFunction(() => location.pathname.includes('/fns/'), { timeout: 10_000 });
    await find(page, 'fn-period');

    await inEachScheme(ctx, async (shot) => {
      await open(ctx, `/admin/systems/${system ?? ''}/fns/${local ?? ''}`, tid('fn-period'));
      await shot('fn');
      if (await page.$(tid('fn-runs-chart')) !== null) {
        await show(page, tid('fn-runs-chart'));
        if (!isTouch(ctx)) {
          await page.hover(`${tid('fn-runs-chart')} .column:last-child`);
          await find(page, 'fn-runs-chart');
          check(await page.$(`${tid('fn-runs-chart')} .tip`) !== null, 'pointing at a day shows its numbers');
        }
        await settle(page);
        await shot('chart');
      }
      await open(ctx, `/admin/systems/${system ?? ''}/fns/${local ?? ''}?days=30`, tid('fn-period'));
      check(new URL(page.url()).searchParams.get('days') === '30', 'the period is in the URL');
      await shot('thirty-days');
    });
  },
});
