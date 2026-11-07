/** Responsive at every size (chat-features 1.3): no sideways scroll, the composer on screen, a huge token wraps. */
import { check, compose, feature, onScreen, openSession } from '../kit.ts';

export default feature({
  id: 'responsive', ref: 'chat-features 1.3', title: 'Fits the screen at every size',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    check(await onScreen(page, 'composer'), 'the composer is fully on screen');
    await compose(page, `path/${'x'.repeat(300)}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!wide, 'a 300-character token must not widen the page');
    await ctx.shot('long-draft');
  },
});
