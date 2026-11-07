/** Suggestions (chat-features 10.1, 10.2): under a user message, chips name the fns and context its embedding suggested. */
import { check, feature, find, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'suggestions', ref: 'chat-features 10.1, 10.2', title: 'Suggested fns and context from the embedding',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await find(page, 'suggestion-chips');
    const text = await page.$eval(tid('suggestion-chips'), (el) => el.textContent);
    check(/fns?|context/i.test(text), 'the chips count suggested fns or context');
    await ctx.shot('chips');
    const button = await page.$(`${tid('suggestion-chips')} button`);
    check(button !== null, 'a chip opens its list');
    await button.click();
    await settle(page);
    await ctx.shot('open');
    await page.keyboard.press('Escape');
  },
});
