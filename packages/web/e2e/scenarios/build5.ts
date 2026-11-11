/**
 * Build 5's views that only rendering can check: query results as a bar chart and as a wide table (scrolling inside
 * its frame, never the page), the approval card with a write's preview above the composer, the inbox's approval
 * cards, and the resources page across the whole width: the folder tree in its own column with a divider that drags
 * its width (wide screens), and no scroll area inside another.
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

      await page.goto(url('/resources?uri=fs://work/README.md'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="chat-panel"]');
      await settle(page);
      // no scroll area holds another that scrolls too
      const nested = await page.evaluate(() => {
        const scrolls = (el: Element): boolean => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
        return [...document.querySelectorAll('[data-testid="resources-page"] *')].filter((el) => scrolls(el) && [...el.querySelectorAll('*')].some(scrolls)).length;
      });
      check(nested === 0, 'the resources page should have no scroll area inside another');
      const splitter = await page.$('[data-testid="splitter"]');
      const box = await splitter?.boundingBox();
      if (box !== undefined && box !== null) {
        const before = await page.$eval('[data-testid="resources-page"] .tree', (el) => el.getBoundingClientRect().width);
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 80, box.y + 100, { steps: 4 });
        await page.mouse.up();
        const after = await page.$eval('[data-testid="resources-page"] .tree', (el) => el.getBoundingClientRect().width);
        check(Math.round(after - before) === 80, 'dragging the divider should widen the folder tree');
      }
      await shot('resources');
    });
  },
};
