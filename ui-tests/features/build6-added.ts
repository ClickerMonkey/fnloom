/**
 * What a system added, rendered: its context on its own tab (titles, keys, who sees each, choices), its named types
 * on theirs, a context file's item with its key and choices, and the models list with the hub roles each model fills.
 * Against the mock hub (fs's sample authoring folder), or a real stack whose fs has a `context/` folder.
 */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'build6-added', ref: 'build-6 feedback 2026-11-11', title: 'What a system added', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/systems/fs/context', tid('system-context'));
    await find(page, 'context-row');
    check(await page.$$eval(`${tid('system-context')} .key`, (keys) => keys.length) > 0, 'each context item shows its key');
    await settle(page);
    await ctx.shot('context');

    await open(ctx, '/admin/systems/database/types', tid('instance-types'));
    await settle(page);
    await ctx.shot('types');

    await open(ctx, '/context/fs/authoring.index', tid('context-choices'));
    check((await page.$eval(tid('context-key'), (el) => el.textContent)).includes('authoring.index'), 'the item shows its key to an admin');
    await settle(page);
    await ctx.shot('item');

    await open(ctx, '/admin/models/models', tid('models'));
    await page.waitForSelector(tid('model-role'), { timeout: 10_000 });
    await settle(page);
    await ctx.shot('models');
  },
});
