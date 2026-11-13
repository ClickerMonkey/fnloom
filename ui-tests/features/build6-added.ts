/**
 * What a system added, rendered: one switch for all of its context beside functions and renderers, its fns and its context
 * on their own tabs, each with its own switch (titles, where each was declared, its version, who sees each, choices;
 * never a key), its named types on theirs, everything else it added (resource roots, kinds, commands, components,
 * examples) under its Other parts tab, each opening to its declaration, a context file's item with its choices (each the title and size of the item
 * it opens, never a key), and the models list with the hub roles each model fills.
 * Against the mock hub (fs's sample authoring folder), or a real stack whose fs has a `context/` folder.
 */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'build6-added', ref: 'build-6 feedback 2026-11-11', title: 'What a system added', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/systems/fs', tid('enable-context'));
    check(await page.$(tid('enable-functions')) !== null && await page.$(tid('enable-renderers')) !== null, 'the Switches card has functions, renderers and context');
    await open(ctx, '/admin/systems/fs/fns', tid('fns'));
    check(await page.$$eval(`${tid('fns')} > li`, (all) => all.every((row) => row.querySelector('[data-testid="fn-switch"]') !== null)), 'every fn has its own switch');

    await open(ctx, '/admin/systems/fs/context', tid('system-context'));
    await find(page, 'context-row');
    const rows = await page.$$eval(`${tid('system-context')} ${tid('context-row')}`, (all) => all.map((row) => ({
      declared: row.querySelector('[data-testid="context-declared"]') !== null, seen: row.querySelector('[data-testid="context-seen-by"]') !== null, text: row.textContent,
    })));
    check(rows.every((row) => row.declared && row.seen), 'every context row says where it was declared and who sees it');
    check(rows.every((row) => !row.text.includes('authoring.')), 'no context row shows a key');
    const switches = await page.$$(`${tid('system-context')} ${tid('context-switch')} [role="switch"]`);
    check(switches.length === rows.length, `every context row has its own switch (${switches.length} of ${rows.length})`);
    // flipping the first row's switch dims the row, or brightens it (the mock keeps what the last viewport left); shot, then flipped back
    const first = `${tid('system-context')} .switch-row:first-child`;
    const wasOn = await page.$eval(`${first} [role="switch"]`, (el) => el.getAttribute('aria-checked') === 'true');
    await page.click(`${first} [role="switch"]`);
    await page.waitForFunction((row, on) => document.querySelector(`${row} [data-testid="context-row"]`)?.classList.contains('off') === on, { timeout: 10_000 }, first, wasOn);
    await settle(page);
    await ctx.shot('context');
    await page.click(`${first} [role="switch"]`);
    await page.waitForFunction((row, on) => document.querySelector(`${row} [data-testid="context-row"]`)?.classList.contains('off') === on, { timeout: 10_000 }, first, !wasOn);

    await open(ctx, '/admin/systems/database/types', tid('instance-types'));
    await settle(page);
    await ctx.shot('types');

    await open(ctx, '/admin/systems/fs/parts', tid('system-parts'));
    // one kind at a time, chosen by a chip: roots, kinds, commands, components and examples each have one
    const chips = await page.$$eval('[data-part-tab]', (all) => all.map((one) => one.getAttribute('data-part-tab')));
    check(['roots', 'kinds', 'commands', 'components', 'examples'].every((section) => chips.includes(section)), `roots, kinds, commands, components and examples each have a chip (${chips.join(', ')})`);
    await page.click('[data-part-tab="commands"]');
    await page.waitForSelector(`[data-section="commands"] ${tid('system-part')}`);
    await page.click(`[data-section="commands"] ${tid('system-part')}`);
    await find(page, 'system-part-owner');
    await settle(page);
    await ctx.shot('parts');

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
