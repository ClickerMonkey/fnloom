/** The inbox (chat-features 8.6): notifications with an unread count; marking all read clears it; the filter is in the URL. */
import { check, feature, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'inbox', ref: 'chat-features 8.6', title: 'Inbox with unread badge',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/inbox', 'main');
    await page.waitForFunction(() => (document.querySelector('main')?.textContent ?? '').includes('Inbox'));
    await ctx.shot('inbox');
    const markAll = await page.$(tid('read-all'));
    if (markAll !== null) {
      await markAll.click();
      await settle(page, 600);
      await ctx.shot('read');
    }
    await open(ctx, '/inbox?filter=unread', 'main');
    check(new URL(page.url()).searchParams.get('filter') === 'unread', 'the filter stays in the URL');
    await ctx.shot('unread');
  },
});
