/** Timestamps (chat-features 3.11): a day separator, and every message has a time with the full date on hover. */
import { check, count, feature, openSession } from '../kit.ts';

export default feature({
  id: 'timestamps', ref: 'chat-features 3.11', title: 'Times and day separators',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    check(await count(page, 'day-separator') >= 1, 'the thread has a day separator');
    const times = await page.$$eval('[data-testid="thread"] time[datetime]', (els) => els.filter((el) => el.getAttribute('title') !== null).length);
    check(times >= 2, 'messages carry times with a full-date title');
    await ctx.shot('times');
  },
});
