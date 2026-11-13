/**
 * Build 8, rendered: a widget in a chat (its bar chart, the table with a button per row, a row's actions), a plain
 * result table with Save as widget, the Data page's stored types and saved widgets, a saved widget on its fn page, a
 * type's records in the widget view (as a chart from the URL, then the table with a cell edited in place and the one
 * confirm), one record open beside them, and an item's version history. Layout at phone and desktop width (nothing overlaps, no sideways scroll)
 * can only be checked rendered; the behaviour itself is covered by component tests. Against the mock hub's samples.
 */
import type { Page } from 'puppeteer';
import { check, feature, inEachScheme, open, settle, tid } from '../kit.ts';

/** Whether the page scrolls sideways (it never should). */
function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

export default feature({
  id: 'build8-data', ref: 'build-8 design §1, §2, §6', title: 'Widgets, the Data pages and version history', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await inEachScheme(ctx, async (shot) => {
      await open(ctx, '/data', tid('data-set'));
      check(!await scrollsSideways(page), 'the Data page fits the screen');
      await shot('data');
    }, { still: true });

    await open(ctx, '/data/widgets', tid('data-widget'));
    await settle(page);
    await ctx.shot('widgets');

    // a saved widget's fn page: its latest run drawn as the widget, Open in chat beside it
    await page.click(tid('data-widget-page'));
    await page.waitForSelector(tid('fn-widget'));
    await settle(page);
    check(!await scrollsSideways(page), 'the fn page with its widget fits the screen');
    await ctx.shot('widget-fn-page');

    // the records in the widget view: the visual picked is in the URL
    await open(ctx, '/data/notes/Note?sort=-words&view=category.bar', `${tid('records-widget')} [data-visual="category"]`);
    await settle(page);
    check(!await scrollsSideways(page), 'the records page with a chart fits the screen');
    await ctx.shot('records-chart');
    await open(ctx, '/data/notes/Note?sort=-words&view=table', tid('result-grid'));
    await settle(page);
    check(!await scrollsSideways(page), 'the records page fits the screen');
    await ctx.shot('records');
    // a cell edited in place: the change is staged, Save asks once naming it
    const cell = `${tid('result-cell-edit')}[data-column="title"]`;
    await page.click(cell, { count: 3 });
    await page.type(cell, 'Plan the walk');
    await page.keyboard.press('Tab');
    await page.waitForSelector(tid('record-edits-review'));
    check(!await scrollsSideways(page), 'the records page with a staged change fits the screen');
    await ctx.shot('records-edited');
    await page.click(tid('record-edits-review'));
    await page.waitForSelector(tid('record-edits-confirm'));
    await settle(page);
    await ctx.shot('records-edit-confirm');
    await page.keyboard.press('Escape');
    await page.waitForSelector(tid('record-edits-confirm'), { hidden: true });
    await settle(page);
    await page.click(tid('record-edits-discard'));
    await page.waitForSelector(tid('record-edits-review'), { hidden: true });
    await page.click(tid('result-row-open'));
    await page.waitForSelector(tid('record-panel'));
    await settle(page);
    await ctx.shot('record');

    // the chat with a saved widget and a plain result table
    await open(ctx, '/chat', tid('session-row'));
    const session = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((row) => row.textContent.includes('Notes widget'))?.dataset['session']);
    check(typeof session === 'string', 'the mock lists the widget chat');
    await open(ctx, `/chat/${session}`, tid('widget-view'));
    await settle(page, 800);
    const widget = await page.$(tid('widget-view'));
    await widget?.scrollIntoView();
    check(await page.$(`${tid('widget-view')} [data-testid="result-view"]:not([data-visual="table"])`) !== null, 'the widget draws its best visual, not the table, first');
    check(await page.$(tid('save-as-widget')) !== null, 'a plain result table offers Save as widget');
    check(!await scrollsSideways(page), 'the chat with a widget fits the screen');
    await ctx.shot('chat-widget');
    // the widget with chips, presets and the buffered pager: each chip with its value, a chip's popover, the proposal card
    const chips = await page.$(tid('widget-chips'));
    check(chips !== null, 'a widget with controls shows its chip row');
    await chips.scrollIntoView();
    await settle(page);
    const shown = await page.$$eval(`${tid('widget-chips')} ${tid('widget-chip')}`, (all) => all.map((el) => el.getAttribute('data-arg') ?? ''));
    check(shown.join(',') === 'status,owner,since', 'every shown control is a chip');
    check((await page.$$(tid('widget-preset'))).length === 2, 'the presets lead the row');
    check(!await scrollsSideways(page), 'the widget with chips fits the screen');
    await ctx.shot('chat-widget-chips');
    await page.click(`${tid('widget-chip')}[data-arg="since"]`);
    await page.waitForSelector(tid('widget-chip-relative'));
    await settle(page);
    await ctx.shot('chat-widget-chip-dates');
    await page.keyboard.press('Escape');
    const proposal = await page.$(tid('widget-proposal'));
    check(proposal !== null && await page.$(tid('widget-proposal-save')) !== null, 'a proposal shows its preview with Save');
    await proposal.scrollIntoView();
    await settle(page);
    await ctx.shot('chat-widget-proposal');
    await page.click(`${tid('widget-view')} ${tid('result-visuals')} button:last-child`);
    await page.waitForSelector(`${tid('widget-view')} ${tid('result-row-open')}`);
    await settle(page);
    await page.click(`${tid('widget-view')} ${tid('result-row-open')}`);
    await page.waitForSelector(tid('widget-action-choice'));
    await settle(page);
    await ctx.shot('row-actions');
    await page.keyboard.press('Escape');

    await open(ctx, '/context', 'a[href^="/context/"]');
    const item = await page.$eval('a[href^="/context/"]', (a) => a.getAttribute('href') ?? '');
    await open(ctx, item, tid('item-history-toggle'));
    await page.click(tid('item-history-toggle'));
    await page.waitForSelector(tid('item-version'));
    await (await page.$(tid('item-history')))?.scrollIntoView();
    await settle(page);
    await ctx.shot('history');
  },
});
