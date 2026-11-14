/**
 * Build 9 feedback, widget chrome, rendered: by default a widget shows only what says what data it is (its title, its
 * chips and filters, the visual toggle when it offers a chosen few); the rest sits in the 3-dot menu at its top right,
 * shown on hover (and always, faintly, on touch screens): export image, JSON or CSV, full screen and Settings. Shots of
 * a widget with chips, a plain result table, a chart and the Data page's records at rest, hovered, with the menu open,
 * in full screen and with Settings open. Against the mock hub's samples.
 */
import type { Page } from 'puppeteer';
import { check, feature, open, settle, tid } from '../kit.ts';

/** Whether the page scrolls sideways (it never should). */
function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

/** Scroll the `index`th result view's widget to the top of the screen. */
async function bringUp(page: Page, index: number): Promise<void> {
  await page.evaluate((at) => {
    const view = document.querySelectorAll<HTMLElement>('[data-testid="result-view"]')[at];
    const whole = view?.closest<HTMLElement>('[data-testid="widget-view"]') ?? view;
    whole?.scrollIntoView({ block: 'start', behavior: 'instant' });
    // clear of the sticky header above the thread
    let scroller = whole?.parentElement ?? null;
    while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight) { scroller = scroller.parentElement; }
    scroller?.scrollBy({ top: -72, behavior: 'instant' });
  }, index);
  await settle(page, 300);
}

export default feature({
  id: 'widget-chrome', ref: 'build-9 feedback 2026-11-14 (widget chrome)', title: 'Widget chrome: data context visible, the rest in a menu', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await open(ctx, '/chat', tid('session-row'));
    const session = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((row) => row.textContent.includes('Notes widget'))?.dataset['session']);
    check(typeof session === 'string', 'the mock lists the widget chat');
    await open(ctx, `/chat/${session}`, tid('widget-view'));
    await settle(page, 800);

    // the widget with chips and presets
    const chipped = await page.evaluate(() => [...document.querySelectorAll('[data-testid="result-view"]')].findIndex((view) => view.closest('[data-testid="widget-view"]')?.querySelector('[data-testid="widget-chips"]') !== null));
    check(chipped >= 0, 'a widget with chips is in the chat');
    await bringUp(page, chipped);
    check(!await scrollsSideways(page), 'the chat with a widget fits the screen');
    await ctx.shot('chips-widget');
    const views = await page.$$(tid('result-view'));
    const view = views[chipped];
    check(view !== undefined, 'the widget is drawn');
    await view.hover();
    await settle(page, 300);
    await ctx.shot('chips-widget-hover');
    const more = await view.$(tid('widget-more'));
    if (more !== null) {
      await more.click();
      await page.waitForSelector('[role="menu"]', { visible: true });
      await settle(page, 300);
      await ctx.shot('chips-widget-menu');
      await page.keyboard.press('Escape');
      await settle(page, 200);
      // full screen from the menu, Escape leaves
      await more.click();
      await page.waitForSelector('[role="menu"]', { visible: true });
      await page.click(`[role="menu"] [data-value="full"]`);
      await page.waitForSelector(`${tid('result-view')}.full`);
      await settle(page, 500);
      await ctx.shot('chips-widget-full');
      await page.keyboard.press('Escape');
      await page.waitForSelector(`${tid('result-view')}.full`, { hidden: true });
      // settings
      await bringUp(page, chipped);
      await more.click();
      await page.waitForSelector('[role="menu"]', { visible: true });
      await page.click(`[role="menu"] [data-value="settings"]`);
      await page.waitForSelector(tid('result-settings'), { visible: true });
      await settle(page, 400);
      await ctx.shot('chips-widget-settings');
      await page.keyboard.press('Escape');
      await page.waitForSelector(tid('result-settings'), { hidden: true });
    }

    // a plain result table (Make a widget lives in its menu now)
    const plain = await page.evaluate(() => [...document.querySelectorAll('[data-testid="result-view"]')].findIndex((v) => v.closest('[data-testid="widget-view"]')?.querySelector('[data-testid="widget-chips"]') === null && v.querySelector('[data-testid="result-visuals"]') === null && v.closest('[data-testid="widget-proposal"]') === null));
    if (plain >= 0) {
      await bringUp(page, plain);
      await ctx.shot('plain-table');
    }

    // a chart from the gallery
    await open(ctx, '/chat', tid('session-row'));
    const gallery = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((row) => row.textContent.includes('Chart gallery'))?.dataset['session']);
    if (typeof gallery === 'string') {
      await open(ctx, `/chat/${gallery}`, tid('result-view'));
      await settle(page, 800);
      await bringUp(page, 0);
      await ctx.shot('chart');
    }

    // the Data page's records: its search and filters lead the widget
    await open(ctx, '/data/notes/Note?sort=-words&view=category.bar', `${tid('records-widget')} [data-visual="category"]`);
    await settle(page);
    check(!await scrollsSideways(page), 'the records page with a chart fits the screen');
    await ctx.shot('records');
  },
});
