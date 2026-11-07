/** Approvals (chat-features 7.1): the agent wants to run a shell command; the approval card asks, and approving lets it run. */
import { check, compose, feature, find, newChat, sendComposer, settle, tid } from '../kit.ts';

export default feature({
  id: 'approvals', ref: 'chat-features 7.1, 7.2', title: 'Approve a command the agent wants to run',
  async run(ctx) {
    const { page } = ctx;
    await newChat(ctx);
    await compose(page, 'Use the fs/bash tool to run exactly this command: echo approved-in-ui. Then tell me what it printed.');
    await sendComposer(ctx);
    await find(page, 'approval-card', 240_000);
    await settle(page);
    check((await page.$eval(tid('approval-card'), (el) => el.textContent)).toLowerCase().includes('bash'), 'the card names the fn it asks about');
    await ctx.shot('asking');
    await page.click(tid('approve'));
    await page.waitForFunction(() => document.querySelector('[data-testid="approval-card"]') === null, { timeout: 20_000 });
    await page.waitForSelector('[data-testid="run-card"][data-status="done"]', { timeout: 240_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="session-status"]') === null, { timeout: 240_000 });
    await settle(page, 600);
    await ctx.shot('approved');
  },
});
