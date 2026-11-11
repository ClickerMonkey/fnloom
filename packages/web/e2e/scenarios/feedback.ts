/**
 * The owner's build 5 feedback that only rendering can check: an answer's fn calls folded into one section, opened;
 * a fn looked into from a run in a modal over the chat (its overview and examples); the fn page built from the same
 * overview; and the auto mode classifier dialog in the admin's model roles.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn, tracked } from './steps.ts';

export const feedback: Scenario = {
  name: 'feedback',
  description: 'Grouped fn calls, the fn modal and page, and the auto mode classifier setting.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await signedIn(ctx, '/chat');
      await page.waitForSelector('[data-testid="session-row"] .open');
      for (const row of await page.$$('[data-testid="session-row"] .open')) {
        if ((await row.evaluate((el) => el.textContent)).includes('Refactor the router')) { await row.click(); break; }
      }
      await page.waitForSelector('[data-testid="run-group"]');
      check(await page.$('[data-testid="run-group"] [data-testid="run-card"]') === null, 'settled fn calls should start folded');
      await page.$eval('[data-testid="run-group"]', (el) => { el.scrollIntoView({ block: 'center' }); });
      await settle(page);
      await shot('group');
      await page.click('[data-testid="run-group-toggle"]');
      await page.waitForSelector('[data-testid="run-group"] [data-testid="run-card"]');
      await settle(page, 250);
      await shot('group-open');

      const cards = await page.$$('[data-testid="run-group"] [data-testid="run-card"] .summary');
      await cards.at(-1)?.click();
      await page.waitForSelector('[data-testid="run-about-fn"]', { visible: true });
      await settle(page, 300);
      await page.click('[data-testid="run-about-fn"]');
      await page.waitForSelector('[data-testid="fn-overview"] [data-testid="fn-examples"] li');
      await settle(page);
      check(await page.$('[data-testid="fn-open-page"]') !== null, 'an admin should be offered the fn page');
      await shot('fn-modal');

      await page.goto(url('/admin/systems/fs/fns/read_file'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="fn-overview"] [data-testid="fn-signature"]');
      await settle(page);
      await shot('fn-page');

      await page.goto(url('/admin/models/roles?classifier=1'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="classifier-form"]');
      await settle(page);
      await shot('classifier');
    });
  },
};
