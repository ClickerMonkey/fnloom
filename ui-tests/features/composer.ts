/** The composer (chat-features 5.1, 5.11, 5.12): it grows with its text, keeps a draft across reloads, and shows its meta row. */
import { check, clearComposer, compose, feature, find, isPhone, openSession, tid } from '../kit.ts';

export default feature({
  id: 'composer', ref: 'chat-features 5.1, 5.11, 5.12', title: 'Growing input, drafts and the meta row',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await compose(page, '');
    const before = await page.$eval(tid('composer-input'), (el) => el.getBoundingClientRect().height);
    await page.type(tid('composer-input'), 'line one');
    for (let i = 2; i <= 5; i++) {
      // on touch Enter breaks the line; on a keyboard it sends, so Shift+Enter breaks it
      if (isPhone(ctx)) { await page.keyboard.press('Enter'); } else { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
      await page.keyboard.type(`line ${i}`);
    }
    const after = await page.$eval(tid('composer-input'), (el) => el.getBoundingClientRect().height);
    check(after > before, `the input grows as lines are added (${before}px → ${after}px)`);
    await find(page, 'composer-meta');
    await ctx.shot('draft');
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'composer-input');
    const kept = await page.$eval(tid('composer-input'), (el) => (el instanceof HTMLTextAreaElement ? el.value : ''));
    check(kept.includes('line 5'), 'the draft is back after a reload');
    await ctx.shot('restored');
    await clearComposer(page);
  },
});
