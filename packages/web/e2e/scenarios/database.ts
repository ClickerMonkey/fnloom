/**
 * The database system's admin pages: an instance's config (the Postgres URL a saved secret), its table types with the
 * rescan's change waiting above them (the type diff, approve or decline), its saved query fns, and one query fn's page
 * with what it runs.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn, tracked } from './steps.ts';

export const database: Scenario = {
  name: 'database',
  description: 'A database instance: config with a secret, types with a proposed change, saved query fns, a query fn.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await signedIn(ctx, '/admin/systems/database/instances/shop/config');
      await page.waitForSelector('[data-testid="gin-form"] [data-secret]');
      check(await page.$eval('[data-secret] input', (el) => el instanceof HTMLInputElement && el.type === 'password' && el.value === '' && el.placeholder === 'Saved'), 'the kept URL should read "Saved" in a password input');
      await settle(page);
      await shot('config');

      await page.goto(url('/admin/systems/database/instances/shop/types'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="instance-types"] [data-type]');
      await page.waitForSelector('[data-testid="inbox-approvals"] [data-testid="approval-preview"]');
      check(await page.$('[data-type="database/shop.Orders"] .row') !== null, 'Orders should be listed');
      await settle(page);
      await shot('types');

      await page.goto(url('/admin/systems/database/instances/shop/fns'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="fns"] [data-testid="fn-page"]');
      await settle(page);
      await shot('fns');

      await page.goto(url('/admin/systems/database/fns/shop.orders_by_city'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="fn-payload"]');
      // the saved query reads as its SQL, the stored JSON one switch away
      const shown = await page.$eval('[data-testid="fn-payload"]', (card) => { card.scrollIntoView({ block: 'center' }); return card.textContent; });
      if (!shown.includes('SELECT o.city')) { throw new Error('the query fn page should show its SQL'); }
      await settle(page);
      await shot('query-fn');
    });
  },
};
