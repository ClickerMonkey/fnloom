/** System renderers (chat-features 4.8, 4.9): the bash run's card is drawn by the fs system's own renderer. */
import { check, count, feature, find, openSession, settle } from '../kit.ts';

export default feature({
  id: 'renderers', ref: 'chat-features 4.8, 4.9', title: "A system's renderer in its run card",
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await find(page, 'run-card');
    await page.waitForSelector('[data-testid="renderer"], [data-testid="renderer-broken"]', { timeout: 20_000 });
    await settle(page, 600);
    check(await count(page, 'renderer-broken') === 0, 'no renderer is broken');
    check(await count(page, 'renderer') >= 1, 'the fs renderer draws the bash card');
    await ctx.shot('renderer');
  },
});
