/** `/` commands (chat-features 5.6): a slash at the start lists the context commands the session can run, like /tree. */
import { check, clearComposer, compose, feature, find, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'commands', ref: 'chat-features 5.6', title: '/ commands',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await compose(page, '/');
    await find(page, 'composer-picker');
    await page.waitForSelector(tid('picker-command'), { timeout: 10_000 });
    await settle(page);
    const options = await page.$$eval(tid('picker-command'), (els) => els.map((el) => el.textContent));
    check(options.some((o) => o.includes('/tree')), 'the fs tree context is offered as /tree');
    await ctx.shot('commands');
    await page.keyboard.press('Escape');
    await clearComposer(page);
  },
});
