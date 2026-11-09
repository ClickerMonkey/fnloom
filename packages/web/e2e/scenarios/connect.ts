/**
 * Build 4's per-person and provider screens, which only rendering can check: the Calendar page before and after
 * connecting (fn switches, settings, sharing), its OAuth setup beside the admin config, a web crawl in the resource
 * browser, and the Amazon Bedrock provider form.
 */
import type { Scenario } from '../harness.ts';
import { adminPage, check, settle, signedIn, tracked } from './steps.ts';

/** The mock crawl's folder. */
const CRAWL = 'hub://resources/web/crawls/docs.example.com-20261108-1430/';

export const connect: Scenario = {
  name: 'connect',
  description: 'The Calendar page, its admin setup, a web crawl among resources, and the AWS provider form.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await signedIn(ctx, '/connect/google-calendar');
      await page.waitForSelector('[data-testid="connection-account"]');
      // the mock keeps the connection between runs: start each from not connected
      if (await page.$('[data-testid="connect-remove"]') !== null) { await page.click('[data-testid="connect-remove"]'); }
      await page.waitForSelector('[data-testid="connect-start"]');
      await settle(page);
      await shot('calendar-new');

      await page.click('[data-testid="connect-start"]');
      await page.waitForSelector('[data-testid="connection-sharing"]');
      // centred, so the "Connected" toast at the foot of a phone doesn't cover it
      await page.$eval('[data-testid="connection-fn-delete_event"]', (el) => { el.scrollIntoView({ block: 'center' }); });
      await page.click('[data-testid="connection-fn-delete_event"] [data-testid="fn-on"] button');
      await page.waitForSelector('[data-testid="connection-fn-delete_event"] .ui-badge');
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await settle(page);
      await shot('calendar-connected');

      await adminPage(ctx, '/admin/systems/google-calendar/config', '[data-testid="connect-setup"]');
      check((await page.$eval('[data-testid="connect-redirect"]', (el) => el.textContent)).endsWith('/connect/callback'), 'the redirect should be the hub’s callback');
      await shot('calendar-setup');

      await page.goto(url(`/resources?under=${encodeURIComponent(CRAWL)}`), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="crawl-summary"]');
      await settle(page);
      await shot('crawl');

      await adminPage(ctx, '/admin/models', '[data-testid="providers"]');
      await page.click('[data-testid="providers"] [data-testid="add"]');
      await page.waitForSelector('[data-testid="provider-form"] select');
      await page.select('[data-testid="provider-form"] select', 'aws');
      await page.waitForSelector('[data-testid="provider-aws-auth"]');
      await page.click('[data-testid="provider-save"]');
      await settle(page);
      await shot('provider-aws');
    });
  },
};
