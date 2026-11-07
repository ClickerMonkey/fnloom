/**
 * The shell: on wide screens the sidebar beside the page, collapsing to icons and back (kept after a reload); on
 * phones a top bar whose menu opens the navigation drawer, which Escape closes.
 */
import type { Scenario } from '../harness.ts';
import { check, isPhone, settle, signedIn } from './steps.ts';

export const shell: Scenario = {
  name: 'shell',
  description: 'The sidebar collapses on wide screens and is a drawer on phones; navigation moves between pages.',
  async run(ctx) {
    const { page, shot } = ctx;
    await signedIn(ctx, '/chat');
    await shot('chat');

    if (isPhone(ctx)) {
      await page.click('[data-testid="open-nav"]');
      await page.waitForSelector('[role="dialog"][aria-label="Navigation"]');
      await settle(page);
      await shot('drawer');
      await page.click('[data-testid="nav-inbox"]');
      await page.waitForFunction(() => location.pathname === '/inbox' && document.querySelector('[aria-label="Navigation"]') === null);
      await settle(page);
      await page.click('[data-testid="open-nav"]');
      await page.waitForSelector('[role="dialog"][aria-label="Navigation"]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('[aria-label="Navigation"]') === null);
      return;
    }

    await page.click('[data-testid="toggle-sidebar"]');
    await settle(page);
    await shot('collapsed');
    await page.reload({ waitUntil: 'networkidle0' });
    await settle(page);
    check(await page.$eval('.shell', (el) => el.classList.contains('collapsed')), 'the collapsed sidebar should stay collapsed after a reload');
    await page.click('[data-testid="toggle-sidebar"]');
    await settle(page);
    await page.click('[data-testid="nav-settings"]');
    await page.waitForFunction(() => location.pathname === '/settings/appearance');
  },
};
