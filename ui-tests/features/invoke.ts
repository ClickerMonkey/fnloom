/** `!` invocation (chat-features 5.7, 5.8): pick fs/bash, fill its form, run it, and watch its card finish. */
import { check, compose, feature, find, newChat, settle, tid } from '../kit.ts';

export default feature({
  id: 'invoke', ref: 'chat-features 5.7, 5.8', title: '! runs a fn from its form',
  async run(ctx) {
    const { page } = ctx;
    await newChat(ctx);
    await compose(page, '!bash');
    await page.waitForSelector(tid('picker-invoke'), { timeout: 10_000 });
    await settle(page);
    await ctx.shot('picker');
    await page.keyboard.press('Enter');
    await find(page, 'invocation-form');
    await find(page, 'gin-form');
    await ctx.shot('form');
    const field = await page.$(`${tid('invocation-form')} textarea, ${tid('invocation-form')} input[type="text"]`);
    check(field !== null, 'the form has a field for the command');
    await field.click();
    await field.type('echo invoked-from-ui');
    await page.click(tid('gin-submit'));
    await page.waitForSelector('[data-testid="run-card"][data-status="done"]', { timeout: 60_000 });
    await settle(page, 600);
    check((await page.$eval(tid('thread'), (el) => el.textContent)).includes('invoked-from-ui'), 'the card shows what the command printed');
    await ctx.shot('ran');
  },
});
