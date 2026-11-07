/** Steps the scenarios share: signing in and out of the mock hub, waiting for motion to settle, finding things. */
import type { Page } from 'puppeteer';
import type { StepContext } from '../harness.ts';
import { MOCK_ADMIN } from '../mockHub.ts';

/** Let transitions finish before a screenshot or a check. */
export async function settle(page: Page, ms = 450): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve); }); }));
}

/** Start signed out, with the device's theme. */
export async function signedOut({ page, url }: StepContext): Promise<void> {
  await page.goto(url('/sign-in'), { waitUntil: 'networkidle0' });
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(url('/sign-in'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="sign-in-form"]');
}

/** Fill in and send the sign-in form. */
export async function submitSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

/** Be signed in as the mock admin, then open `path`. */
export async function signedIn(ctx: StepContext, path: string): Promise<void> {
  const { page, url } = ctx;
  await page.goto(url(path), { waitUntil: 'networkidle0' });
  if (new URL(page.url()).pathname === '/sign-in') {
    await page.waitForSelector('[data-testid="sign-in-form"]');
    await submitSignIn(page, MOCK_ADMIN.email, MOCK_ADMIN.password);
    await page.waitForFunction(() => location.pathname !== '/sign-in');
  }
  await page.waitForSelector('main');
  await settle(page);
}

/** Whether this run is on a phone-sized screen, where the sidebar is a drawer. */
export const isPhone = (ctx: StepContext): boolean => ctx.viewport === 'phone';

/** Fail the scenario with `message` unless `ok`. */
export function check(ok: boolean, message: string): void {
  if (!ok) { throw new Error(message); }
}

/**
 * Run a scenario's steps with each screenshot naming the step, so a failure says where it happened
 * ("after \"pairing\": …").
 */
export async function tracked(ctx: StepContext, steps: (shot: (name: string) => Promise<void>) => Promise<void>): Promise<void> {
  let at = 'start';
  const shot = async (name: string): Promise<void> => { at = name; await ctx.shot(name); };
  try {
    await steps(shot);
  } catch (error) {
    throw new Error(`after "${at}": ${error instanceof Error ? error.message : 'failed'}`, { cause: error });
  }
}

/** Open an admin page and wait for its content to settle. */
export async function adminPage(ctx: StepContext, path: string, ready: string): Promise<void> {
  await signedIn(ctx, path);
  await ctx.page.waitForSelector(ready);
  await settle(ctx.page);
}

/** Close the dialog on top with Escape and wait for it to go. */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[role="dialog"], [role="alertdialog"]') === null);
  await settle(page, 250);
}
