/**
 * Build 4's chat and gin changes that only rendering can check: the wavy cache-miss rule across the thread, debug mode
 * showing a form's hidden answers (and the URL keeping it), and the expression editor reading as code.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn, tracked } from './steps.ts';

export const build4: Scenario = {
  name: 'build4',
  description: 'The cache-miss rule, debug mode with hidden messages, and the expression editor as code.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await signedIn(ctx, '/chat');
      await page.waitForSelector('[data-testid="session-row"] .open');
      await page.click('[data-testid="session-row"] .open');
      await page.waitForSelector('[data-testid="cache-miss"]');
      check(await page.$('[data-testid="hidden-message"]') === null, 'a form’s answers should be hidden outside debug mode');
      await page.$eval('[data-testid="cache-miss"]', (el) => { el.scrollIntoView({ block: 'center' }); });
      await settle(page);
      await shot('cache-miss');

      await page.click('[data-testid="chat-menu"]');
      await page.waitForSelector('[role="menuitem"]');
      const items = await page.$$('[role="menuitem"]');
      for (const item of items) {
        if ((await item.evaluate((el) => el.textContent)).includes('Debug')) { await item.click(); break; }
      }
      await page.waitForSelector('[data-testid="hidden-message"]');
      check(new URL(page.url()).searchParams.get('debug') === '1', 'debug mode should be in the URL');
      await page.$eval('[data-testid="hidden-message"]', (el) => { el.scrollIntoView({ block: 'center' }); });
      await settle(page);
      await shot('debug');

      await page.goto(url('/design/gin'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="design-expr-edit"] [data-testid="gin-expr-node"]');
      await page.$eval('[data-testid="design-expr-edit"]', (el) => { el.scrollIntoView({ block: 'start' }); });
      await settle(page);
      await shot('expr-editor');
    });
  },
};
