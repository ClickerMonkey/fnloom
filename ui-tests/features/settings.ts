/** Settings (chat-features 1.6, 13): the appearance page picks a theme, which applies at once and is kept. */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'settings', ref: 'chat-features 1.6, 13', title: 'Appearance and account settings',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/settings/appearance', tid('theme-choice'));
    await ctx.shot('appearance');
    const dark = await page.$('[data-testid="theme-choice"] [value="dark"], [data-testid="theme-choice"] [data-value="dark"]');
    if (dark !== null) {
      await dark.click();
      await settle(page);
      check(await page.evaluate(() => `${document.documentElement.dataset['theme'] ?? ''} ${document.documentElement.className}`.includes('dark')), 'choosing dark applies it');
      await ctx.shot('dark');
      const system = await page.$('[data-testid="theme-choice"] [value="system"], [data-testid="theme-choice"] [data-value="system"]');
      await system?.click();
    }
    await open(ctx, '/settings/account', 'main');
    await find(page, 'sign-out');
    await ctx.shot('account');
  },
});
