/**
 * Build 5's views that only rendering can check: query results as a bar chart and as a wide table (scrolling inside
 * its frame, never the page), the approval card with a write's preview above the composer, and the inbox's approval
 * cards.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn, tracked } from './steps.ts';

export const build5: Scenario = {
  name: 'build5',
  description: 'Query results (bar chart, wide table), an approval card with its preview, and the inbox approvals.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await signedIn(ctx, '/chat');
      await page.waitForSelector('[data-testid="session-row"] .open');
      const rows = await page.$$('[data-testid="session-row"] .open');
      for (const row of rows) {
        if ((await row.evaluate((el) => el.textContent)).includes('Orders this month')) { await row.click(); break; }
      }
      await page.waitForSelector('[data-testid="result-view"][data-visual="bar"]');
      check(await page.$('[data-testid="result-view"][data-visual="table"]') !== null, 'the wide result should show as a table');
      check(await page.$('[data-testid="approval-preview"]') !== null, 'the approval card should show what the write will do');
      await page.$eval('[data-testid="result-view"]', (el) => { el.scrollIntoView({ block: 'start' }); });
      await settle(page);
      await shot('results');
      await page.$eval('[data-testid="result-view"][data-visual="table"]', (el) => { el.scrollIntoView({ block: 'start' }); });
      await settle(page);
      await shot('table');

      await page.goto(url('/inbox'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="inbox-approvals"] [data-testid="approval-preview"]');
      await settle(page);
      await shot('inbox');
    });
  },
};
