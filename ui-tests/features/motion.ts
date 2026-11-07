/** Motion (chat-features 1.8): with reduced motion asked for, nothing animates. */
import { check, feature, openSession, settle } from '../kit.ts';

export default feature({
  id: 'motion', ref: 'chat-features 1.8', title: 'Motion respects reduced motion',
  async run(ctx) {
    const { page } = ctx;
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await openSession(ctx);
    await settle(page);
    const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && Number(a.effect?.getComputedTiming().duration ?? 0) > 1).length);
    check(moving === 0, `${moving} animations still run with reduced motion`);
    await ctx.shot('reduced');
  },
});
