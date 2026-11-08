/** The run drawer (chat-features 4.6, 4.13): a card opens its run's details, with args, result and JSON tabs. */
import { check, feature, find, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'run-drawer', ref: 'chat-features 4.6, 4.13', title: 'Run details from a card',
  also: ['wide'],
  async run(ctx) {
    const { page, fixtures } = ctx;
    await openSession(ctx);
    await page.click(`[data-testid="run-card"] .summary`);
    await page.waitForFunction(() => new URL(location.href).searchParams.has('run'));
    await find(page, 'run-details');
    await settle(page);
    await ctx.shot('overview');
    await page.goto(ctx.url(`/chat/${fixtures.session}?run=${fixtures.bashRun}`), { waitUntil: 'networkidle0' });
    await find(page, 'run-details');
    const tabs = await page.$$eval('[data-testid="run-details"] [role="tab"]', (els) => els.map((el) => el.textContent.trim()));
    check(['Args', 'Result', 'JSON'].every((t) => tabs.includes(t)), `the drawer has Args, Result and JSON tabs (has ${tabs.join(', ')})`);
    const result = await page.$$('[data-testid="run-details"] [role="tab"]');
    for (const tab of result) {
      if ((await tab.evaluate((el) => el.textContent.trim())) === 'Result') { await tab.click(); }
    }
    await settle(page);
    check((await page.$eval(tid('run-details'), (el) => el.textContent)).includes('ui-tests'), 'the bash run shows what it printed');
    await ctx.shot('result');
  },
});
