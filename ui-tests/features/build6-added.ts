/**
 * What a system added, rendered: its context on its own tab (titles, where each was declared, who sees each, choices;
 * never a key), its named types on theirs, a context file's item with its choices (each the title and size of the item
 * it opens, never a key), and the models list with the hub roles each model fills.
 * Against the mock hub (fs's sample authoring folder), or a real stack whose fs has a `context/` folder.
 */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'build6-added', ref: 'build-6 feedback 2026-11-11', title: 'What a system added', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/systems/fs/context', tid('system-context'));
    await find(page, 'context-row');
    const rows = await page.$$eval(`${tid('system-context')} ${tid('context-row')}`, (all) => all.map((row) => ({
      declared: row.querySelector('[data-testid="context-declared"]') !== null, seen: row.querySelector('[data-testid="context-seen-by"]') !== null, text: row.textContent,
    })));
    check(rows.every((row) => row.declared && row.seen), 'every context row says where it was declared and who sees it');
    check(rows.every((row) => !row.text.includes('authoring.')), 'no context row shows a key');
    await settle(page);
    await ctx.shot('context');

    await open(ctx, '/admin/systems/database/types', tid('instance-types'));
    await settle(page);
    await ctx.shot('types');

    await open(ctx, '/context/fs/authoring.index', tid('context-choices'));
    check(await page.$(tid('context-key')) === null, 'the item page shows no key');
    const choices = await page.$$eval(tid('context-choice'), (all) => all.map((choice) => choice.textContent));
    check(choices.length > 0 && choices.every((text) => !text.includes('fs/authoring')), 'each choice is labelled by the item it opens, not its key');
    check(choices.some((text) => text.includes('tokens')), 'choices show the size of the item they open');
    await settle(page);
    await ctx.shot('item');

    await open(ctx, '/admin/models/models', tid('models'));
    await page.waitForSelector(tid('model-role'), { timeout: 10_000 });
    await settle(page);
    await ctx.shot('models');
  },
});
