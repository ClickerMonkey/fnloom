/**
 * Responsive at every size (chat-features 1.3): no sideways scroll, the composer on screen, a huge token wraps, and
 * the thread keeps a usable share of the height (a phone on its side gets the compact shell, not a pinned sidebar).
 * Runs at every layout the app has, including a wide screen and a phone on its side.
 */
import { check, clearComposer, compose, feature, onScreen, openSession, tid } from '../kit.ts';

/** The least share of the window's height the thread's scroller keeps, so there is always a thread to read. */
const THREAD_SHARE = 0.4;

export default feature({
  id: 'responsive', ref: 'chat-features 1.3', title: 'Fits the screen at every size',
  also: ['wide', 'landscape'],
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    check(await onScreen(page, 'composer'), 'the composer is fully on screen');
    const room = await page.$eval(tid('thread'), (el) => ({
      thread: el.getBoundingClientRect().height / window.innerHeight,
      sidebar: document.querySelector('.shell .side')?.getBoundingClientRect().width ?? 0,
      short: window.innerHeight < 500,
    }));
    check(room.thread >= THREAD_SHARE, `the thread keeps at least ${THREAD_SHARE * 100}% of the height (has ${Math.round(room.thread * 100)}%)`);
    check(!room.short || room.sidebar === 0, `a short screen gets the compact shell, not a pinned sidebar (${Math.round(room.sidebar)}px wide)`);
    await ctx.shot('fits');
    await compose(page, `path/${'x'.repeat(300)}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!wide, 'a 300-character token must not widen the page');
    await ctx.shot('long-draft');
    // drafts are kept per chat: leave none behind for the features after this one
    await clearComposer(page);
  },
});
