/** Sign in (chat-features 1.5, auth): the form refuses a wrong password plainly, then signs in and lands in the chat. */
import { check, feature, find, open, settle, tid } from '../kit.ts';
import { uiEnv } from '../kit.ts';

export default feature({
  id: 'sign-in', ref: 'auth', title: 'Sign in with the admin account', signedOut: true,
  async run(ctx) {
    const { page } = ctx;
    const settings = uiEnv.parse();
    await open(ctx, '/sign-in', tid('sign-in-form'));
    await ctx.shot('form');
    await page.type('input[type="email"]', settings.HARNESS_UI_EMAIL);
    await page.type('input[type="password"]', 'not-the-password');
    await page.click('button[type="submit"]');
    await find(page, 'sign-in-problem');
    await ctx.shot('refused');
    await page.$eval('input[type="password"]', (el) => { if (el instanceof HTMLInputElement) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.type('input[type="password"]', settings.HARNESS_UI_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.pathname.startsWith('/chat'), { timeout: 20_000 });
    await settle(page);
    check(new URL(page.url()).pathname.startsWith('/chat'), 'signing in should land in the chat');
    await ctx.shot('signed-in');
  },
});
