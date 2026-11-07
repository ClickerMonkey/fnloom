/**
 * System renderers (chat-features 4.8, 4.9): the bash run's card is drawn by the fs system's own renderer, and its
 * "Run again" button starts a new fs/bash run with the same args, which gets a run card of its own in the thread.
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

    const cards = await count(page, 'run-card');
    const again = await page.waitForSelector(`${renderer} ::-p-text(Run again)`, { timeout: 10_000 });
    check(again !== null, 'the bash card offers Run again');
    await again.click();
    const started = `${renderer} .note.started`;
    await page.waitForSelector(started, { timeout: 15_000 });
    await show(page, started);
    await ctx.shot('rerun');
    await page.waitForFunction((before) => document.querySelectorAll('[data-testid="run-card"]').length > before, { timeout: 15_000 }, cards);
    check(await count(page, 'run-card') > cards, 'Run again added a run card of its own');
  },
});
