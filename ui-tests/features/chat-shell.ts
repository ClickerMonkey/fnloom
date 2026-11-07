/** The app shell (chat-features 1.1): the session list beside the thread on desktop, a drawer on phone, and the composer. */
import { check, feature, find, isPhone, openSession, settle, tid, visible } from '../kit.ts';

export default feature({
  id: 'chat-shell', ref: 'chat-features 1.1', title: 'Session list, thread and composer',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await find(page, 'composer');
    await ctx.shot('thread');
    if (isPhone(ctx)) {
      check(!(await visible(page, 'session-list')), 'on a phone the session list is a drawer, closed at first');
      await page.click(tid('open-sessions'));
      await page.waitForSelector('[role="dialog"] [data-testid="session-row"]', { visible: true });
      await settle(page);
      await ctx.shot('drawer');
      await page.keyboard.press('Escape');
    } else {
      check(await visible(page, 'session-list'), 'on desktop the session list shows beside the thread');
      check(await page.$$eval(tid('session-row'), (rows) => rows.length) >= 1, 'the list should hold the fixture session');
    }
  },
});
