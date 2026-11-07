/** The sign-in page: it loads, shows its form, and fits every screen. */
import type { Scenario } from '../harness.ts';

export const signIn: Scenario = {
  name: 'sign-in',
  description: 'The sign-in (or first admin) form loads and fits every screen size.',
  async run({ page, url, shot }) {
    await page.goto(url('/sign-in'), { waitUntil: 'networkidle0' });
    await page.waitForSelector('form');
    await shot('form');
  },
};
