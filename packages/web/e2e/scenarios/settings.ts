/** Settings: each section is a URL, and the theme choice applies at once and is kept on this device. */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn } from './steps.ts';

export const settings: Scenario = {
  name: 'settings',
  description: 'Settings sections are URLs; choosing a theme applies it now and after a reload.',
  async run(ctx) {
    const { page, url, shot, theme } = ctx;
    await signedIn(ctx, '/settings/appearance');
    await shot('appearance');

    const other = theme === 'dark' ? 'Light' : 'Dark';
    const radios = await page.$$('[data-testid="theme-choice"] [role="radio"]');
    for (const radio of radios) {
      if ((await radio.evaluate((el) => el.textContent.trim())) === other) { await radio.click(); }
    }
    await settle(page);
    const shown = await page.evaluate(() => document.documentElement.dataset['theme']);
    check(shown === other.toLowerCase(), `the page should show the ${other} theme, shows ${String(shown)}`);
    await page.reload({ waitUntil: 'networkidle0' });
    check(await page.evaluate(() => document.documentElement.dataset['theme']) === other.toLowerCase(), 'the theme should stay after a reload');
    await settle(page);
    await shot('switched');
    const device = await page.$('[data-testid="theme-choice"] [role="radio"]');
    await device?.click();
    await settle(page);

    await page.goto(url('/settings/account'), { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="sign-out"]');
    await settle(page);
    await shot('account');
  },
};
