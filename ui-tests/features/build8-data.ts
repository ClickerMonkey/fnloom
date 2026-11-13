/**
 * Build 8, rendered: a widget in a chat (its bar chart, the table with a button per row, a row's actions), a plain
 * result table with Save as widget, the Data page's stored types and saved widgets, a type's records with one open
 * beside them, and an item's version history. Layout at phone and desktop width (nothing overlaps, no sideways scroll)
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
    });

    await open(ctx, '/data/widgets', tid('data-widget'));
    await settle(page);
    await ctx.shot('widgets');

    await open(ctx, '/data/notes/Note?sort=-words', tid('result-grid'));
    await settle(page);
    check(!await scrollsSideways(page), 'the records page fits the screen');
    await ctx.shot('records');
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
    check(await page.$(`${tid('widget-view')} [data-visual="bar"]`) !== null, 'the widget draws its bar chart first');
    check(await page.$(tid('save-as-widget')) !== null, 'a plain result table offers Save as widget');
    check(!await scrollsSideways(page), 'the chat with a widget fits the screen');
    await ctx.shot('chat-widget');
    // the widget with controls and paging: each control with its value in a row, and the pager
    const controls = await page.$(tid('widget-control-row'));
    check(controls !== null, 'a widget with controls shows them in a row');
    await controls.scrollIntoView();
    await settle(page);
    const shown = await page.$$eval(`${tid('widget-control-row')} ${tid('widget-control')}`, (all) => all.map((el) => el.getAttribute('data-arg') ?? ''));
    check(shown.join(',') === 'status,owner', 'every control is shown');
    check(await page.$eval(tid('widget-page'), (el) => el.textContent.trim()) === '4–6', 'the pager says which rows are shown');
    check(!await scrollsSideways(page), 'the widget with controls fits the screen');
    await ctx.shot('chat-widget-controls');
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
