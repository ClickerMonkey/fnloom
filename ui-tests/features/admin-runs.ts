/**
 * Admin runs: every run, newest first; opening one shows its record, and the URL keeps it open. Scrolling a long list
 * keeps the admin tabs and the filters pinned at the top, so only the rows move. A session filter in the URL narrows the
 * list to that chat's runs.
 */
import { check, feature, open, settle } from '../kit.ts';

/** Whether the first element matching `selector` is wholly inside the window. */
const inView = (selector: string): string => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= -1 && r.bottom <= innerHeight + 1 && r.height > 0; })()`;

export default feature({
  id: 'admin-runs', ref: 'admin runs', title: 'Runs browser',
  also: ['wide'],
  async run(ctx) {
    const { page, fixtures } = ctx;
    await open(ctx, '/admin/runs', '.browser-row');
    check((await page.$eval('main', (el) => el.textContent)).includes('Bash'), 'fs runs are listed');
    await ctx.shot('list');
    const scrolled = await page.evaluate(() => {
      const scroller = document.querySelector('.routed');
      if (!(scroller instanceof HTMLElement)) { return 0; }
      scroller.scrollTop = 600;
      return scroller.scrollTop;
    });
    await settle(page);
    if (scrolled > 0) {
      check(await page.evaluate(inView('nav[aria-label="Admin"]')) === true, 'the admin tabs stay pinned while the list scrolls');
      check(await page.evaluate(inView('[role="search"]')) === true, 'the filters stay pinned while the list scrolls');
      await ctx.shot('scrolled');
    }
    // the fixture's run may be pages down the full list by now; the session filter (kept in the URL) narrows to it
    await open(ctx, `/admin/runs?q=session:${fixtures.session}`, `[data-testid="run-${fixtures.bashRun}"]`);
    check(new URL(page.url()).searchParams.get('q')?.includes(fixtures.session) === true, 'the session filter is in the URL');
    await page.click(`[data-testid="run-${fixtures.bashRun}"]`);
    await page.waitForFunction(() => new URL(location.href).searchParams.has('run'));
    await settle(page);
    check(new URL(page.url()).searchParams.get('run') === fixtures.bashRun, 'the open run is in the URL');
    await ctx.shot('run');
  },
});
