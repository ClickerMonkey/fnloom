/**
 * `!` invocation (chat-features 5.7, 5.8): pick fs/bash, fill its form, run it, and watch its card finish. Then
 * fs/write, whose text is the hub's LongText: it is a many-line text field, and plain text fills it.
 */
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
    await field.type('ls ui-tests/features/invoke.ts');
    await page.click(tid('gin-submit'));
    await page.waitForSelector('[data-testid="run-card"][data-status="done"]', { timeout: 60_000 });
    await settle(page, 600);
    check((await page.$eval(tid('thread'), (el) => el.textContent)).includes('features/invoke.ts'), 'the card shows what the command printed');
    await ctx.shot('ran');

    await compose(page, '!write');
    await page.waitForSelector(tid('picker-invoke'), { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await find(page, 'invocation-form');
    await page.type(`${tid('invocation-form')} [data-path="path"] input`, 'ui-tests/shots/invoke-write.log');
    const text = await page.waitForSelector(`${tid('invocation-form')} [data-path="text"] textarea`, { timeout: 10_000 });
    check(text !== null, 'the LongText field is a text area');
    await text.type('hello undo');
    await settle(page);
    check(await page.$eval(tid('gin-submit'), (el) => el instanceof HTMLButtonElement && !el.disabled), 'plain text fills a LongText field, so Run is enabled');
    await ctx.shot('write-form');
    await page.click(`${tid('invocation-form')} button:not([type="submit"])`);
  },
});
