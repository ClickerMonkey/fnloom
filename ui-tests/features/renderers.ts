/**
 * System renderers (chat-features 4.8, 4.9): the bash run's card is drawn by the fs system's own renderer, and its
 * "Run again" button sends the system's `rerun` action, whose delivery shows live under the card until it is done.
 */
import { check, count, feature, find, openSession, settle, show } from '../kit.ts';

export default feature({
  id: 'renderers', ref: 'chat-features 4.8, 4.9', title: "A system's renderer in its run card, and its actions",
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await find(page, 'run-card');
    const card = `[data-testid="run-card"][data-run="${ctx.fixtures.bashRun}"]`;
    const renderer = `${card} [data-testid="renderer"]`;
    // finished cards may start folded to their summary line
    await page.waitForSelector(card, { timeout: 15_000 });
    const expand = await page.$(`${card} [aria-label="Expand"]`);
    if (expand !== null) { await expand.click(); }
    await page.waitForSelector(`${renderer}, ${card} [data-testid="renderer-broken"]`, { timeout: 20_000 });
    await settle(page, 600);
    check(await count(page, 'renderer-broken') === 0, 'no renderer is broken');
    check(await page.$(renderer) !== null, 'the fs renderer draws the bash card');
    await show(page, renderer);
    await ctx.shot('renderer');

    const again = await page.waitForSelector(`${renderer} ::-p-text(Run again)`, { timeout: 10_000 });
    check(again !== null, 'the bash card offers Run again');
    await again.click();
    const rerun = `${renderer} section[aria-label="Run again"]`;
    await page.waitForSelector(rerun, { timeout: 10_000 });
    await page.waitForFunction((selector) => {
      const section = document.querySelector(selector);
      return section !== null && section.textContent.includes('Done') && section.textContent.includes('ui-tests');
    }, { timeout: 60_000 }, rerun);
    await show(page, rerun);
    await ctx.shot('rerun');
  },
});
