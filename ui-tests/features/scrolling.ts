/** Scrolling (chat-features 2.1, 2.2, 2.7): a session opens at the bottom; scrolling up offers Jump to latest. */
import type { Page } from 'puppeteer';
import { check, feature, find, openSession, settle, tid } from '../kit.ts';

/** How far the thread is from its bottom, in px. */
function fromBottom(page: Page): Promise<number> {
  return page.$eval(tid('thread'), (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

export default feature({
  id: 'scrolling', ref: 'chat-features 2.1, 2.2, 2.7', title: 'Lands at the bottom; jump to latest',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await settle(page, 800);
    check(await fromBottom(page) < 40, 'a session opens scrolled to its latest message');
    await ctx.shot('bottom');
    const scrollable = await page.$eval(tid('thread'), (el) => el.scrollHeight > el.clientHeight + 80);
    if (!scrollable) { return; }
    await page.$eval(tid('thread'), (el) => { el.scrollTop = 0; });
    await find(page, 'jump-latest');
    await ctx.shot('scrolled-up');
    await page.click(tid('jump-latest'));
    await settle(page, 900);
    check(await fromBottom(page) < 40, 'Jump to latest returns to the bottom');
  },
});
