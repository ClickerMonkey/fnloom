/** Empty state (chat-features 1.5, 10.4): a new chat shows starters; picking one starts the message in the composer or sends it. */
import { check, count, feature, find, newChat, settle, tid } from '../kit.ts';

export default feature({
  id: 'states', ref: 'chat-features 1.5, 10.4', title: 'Empty chat with starters',
  async run(ctx) {
    const { page } = ctx;
    await newChat(ctx);
    await find(page, 'starters');
    check(await count(page, 'starter') > 0, 'an empty chat offers starter questions');
    await ctx.shot('empty');
    await page.click(tid('starter'));
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="composer-input"]');
      return document.querySelector('[data-testid="user-message"]') !== null || (input instanceof HTMLTextAreaElement && input.value.trim() !== '');
    }, { timeout: 15_000 });
    await settle(page);
    await ctx.shot('started');
  },
});
