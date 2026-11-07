/**
 * Notifications: the bell's count, its popover sized to its content and kept on screen, the inbox page with its
 * filter in the URL (so a reload keeps it), and opening a notification going where it leads.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn } from './steps.ts';

export const inbox: Scenario = {
  name: 'inbox',
  description: 'The bell opens the latest notifications; the inbox page filters by URL and opens what a notification is about.',
  async run(ctx) {
    const { page, url, shot } = ctx;
    await signedIn(ctx, '/chat');
    await page.click('[data-testid="open-inbox"]');
    await page.waitForSelector('[data-testid="inbox-panel"] li');
    await settle(page);
    await shot('popover');
    const fits = await page.$eval('.ui-popover', (el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    check(fits, 'the inbox popover should sit inside the screen');
    await page.keyboard.press('Escape');

    await page.goto(url('/inbox'), { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid^="notification-"]');
    await settle(page);
    await shot('page');

    const unreadTab = await page.$$('[role="tab"]');
    await unreadTab[1]?.click();
    await page.waitForFunction(() => new URLSearchParams(location.search).get('filter') === 'unread');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('[role="tab"][aria-selected="true"]');
    const selected = await page.$eval('[role="tab"][aria-selected="true"]', (el) => el.textContent.trim());
    check(selected.startsWith('Unread'), `after a reload the Unread tab should still be chosen, got "${selected}"`);
    await settle(page);
    await shot('unread');

    await page.goto(url('/inbox'), { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid^="notification-"] button');
    const before = page.url();
    await page.click('[data-testid^="notification-"] button');
    await page.waitForFunction((was) => location.href !== was, {}, before);
  },
};
