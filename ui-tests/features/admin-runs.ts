/** Admin runs: every run, newest first; opening one shows its record, and the URL keeps it open. */
import { check, feature, open, settle } from '../kit.ts';

export default feature({
  id: 'admin-runs', ref: 'admin runs', title: 'Runs browser',
  async run(ctx) {
    const { page, fixtures } = ctx;
    await open(ctx, '/admin/runs', '.browser-row');
    check((await page.$eval('main', (el) => el.textContent)).includes('Bash'), 'fs runs are listed');
    await ctx.shot('list');
    await page.click(`[data-testid="run-${fixtures.bashRun}"]`);
    await page.waitForFunction(() => new URL(location.href).searchParams.has('run'));
    await settle(page);
    check(new URL(page.url()).searchParams.get('run') === fixtures.bashRun, 'the open run is in the URL');
    await ctx.shot('run');
  },
});
