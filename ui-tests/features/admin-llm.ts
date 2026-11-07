/** Admin LLM calls: every call with its model, tokens, cost and time; one opens with the messages the model saw. */
import { check, feature, open, settle } from '../kit.ts';

export default feature({
  id: 'admin-llm', ref: 'admin llm calls', title: 'LLM calls browser',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/llm', '.browser-row');
    check((await page.$eval('main', (el) => el.textContent)).includes(':free'), 'calls are listed with their model');
    await ctx.shot('list');
    await page.click('.browser-row button.open');
    await page.waitForFunction(() => new URL(location.href).searchParams.has('call'));
    await settle(page, 600);
    check((await page.$eval('body', (el) => el.textContent)).toLowerCase().includes('system'), 'the call shows the messages the model saw');
    await ctx.shot('call');
  },
});
