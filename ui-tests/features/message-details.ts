/** Message details (chat-features 3.7, 3.8): usage, cost, model and timing, and what the model saw. */
import { check, count, feature, find, isPhone, openSession, point, settle, tid } from '../kit.ts';

const DETAILS = '[data-testid="assistant-answer"] [data-testid="msg-actions"] [data-action="details"]';

export default feature({
  id: 'message-details', ref: 'chat-features 3.7, 3.8', title: 'Turn details and what the model saw',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    if (!isPhone(ctx)) { await point(ctx, tid('assistant-answer')); }
    await page.waitForSelector(DETAILS, { visible: true });
    await page.click(DETAILS);
    await find(page, 'turn-details');
    await settle(page);
    await find(page, 'turn-cost');
    await ctx.shot('details');
    await page.click(tid('turn-llm'));
    await find(page, 'llm-messages');
    check(await count(page, 'llm-messages') > 0, 'the LLM call shows the messages the model saw');
    await settle(page);
    await ctx.shot('model-saw');
  },
});
