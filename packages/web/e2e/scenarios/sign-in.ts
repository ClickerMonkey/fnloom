/** Sign-in: the form loads and fits, a wrong password says so in place, the right one lands in the app. */
import type { Scenario } from '../harness.ts';
import { MOCK_ADMIN } from '../mockHub.ts';
import { check, settle, signedOut, submitSignIn } from './steps.ts';

export const signIn: Scenario = {
  name: 'sign-in',
  description: 'The sign-in form loads, refuses a wrong password inline, and signs in to the page that asked.',
  async run(ctx) {
    const { page, url, shot } = ctx;
    await signedOut(ctx);
    await settle(page);
    await shot('form');

    await submitSignIn(page, MOCK_ADMIN.email, 'wrong-password');
    await page.waitForSelector('[data-testid="sign-in-problem"]');
    await settle(page);
    await shot('wrong-password');

    await page.goto(url('/settings/account'), { waitUntil: 'networkidle0' });
    check(new URL(page.url()).searchParams.get('next') === '/settings/account', `sign-in should remember where you were going, at ${page.url()}`);
    await page.waitForSelector('[data-testid="sign-in-form"]');
    await submitSignIn(page, MOCK_ADMIN.email, MOCK_ADMIN.password);
    await page.waitForFunction(() => location.pathname === '/settings/account');
    await settle(page);
    await shot('returned');
  },
};
