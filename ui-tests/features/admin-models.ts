/** Admin models: providers, the models they offer, and model categories, each a tab with its own URL. */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'admin-models', ref: 'admin models', title: 'Providers, models and categories',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/models', 'main');
    await ctx.shot('providers');
    await open(ctx, '/admin/models/models', 'main');
    await page.waitForFunction(() => (document.querySelector('main')?.textContent ?? '').includes(':free'), { timeout: 15_000 });
    check(new URL(page.url()).pathname.endsWith('/models'), 'the tab keeps its URL');
    await ctx.shot('models');
    await open(ctx, '/admin/models/categories', 'main');
    await ctx.shot('categories');
    await page.click(tid('add'));
    await find(page, 'category-form');
    await settle(page);
    await ctx.shot('category-form');
    await page.keyboard.press('Escape');
  },
});
