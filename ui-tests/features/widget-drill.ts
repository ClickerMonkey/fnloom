/**
 * Build 9 feedback, drill-downs through the query, rendered: in the mock's chart gallery a grouped result (a bar chart
 * of orders by city) says it can be drilled (`ResultTable.drill`); a click on a bar opens the rows behind that city in a
 * modal, as a widget of its own drawn as a table first, with its 3-dot menu and its pager. Shots of the chart, the
 * modal, its menu and its next page; a result that can't be drilled (the network) opens nothing.
 */
import type { Page } from 'puppeteer';
import { check, feature, open, settle, tid } from '../kit.ts';

/** The index of the gallery's result drawn by `family`'s chart. */
function chartIndex(page: Page, family: string): Promise<number> {
  return page.evaluate((name) => [...document.querySelectorAll('[data-testid="result-view"]')].findIndex((view) => view.querySelector(`[data-testid="chart-visual"][data-family="${name}"]`) !== null), family);
}

/** Scroll the `index`th result view to the top of the screen, clear of the header. */
async function bringUp(page: Page, index: number): Promise<void> {
  await page.evaluate((at) => {
    const view = document.querySelectorAll<HTMLElement>('[data-testid="result-view"]')[at];
    view?.scrollIntoView({ block: 'start', behavior: 'instant' });
    let scroller = view?.parentElement ?? null;
    while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight) { scroller = scroller.parentElement; }
    scroller?.scrollBy({ top: -72, behavior: 'instant' });
  }, index);
  await settle(page, 400);
}

/**
 * Click the first mark of the `index`th result's chart that points (one a click opens): the chart sets its pointer
 * cursor on hover over such a mark, so the pointer sweeps the plot until it does. False when no mark points.
 */
async function clickMark(page: Page, index: number): Promise<boolean> {
  const box = await page.evaluate((i) => {
    const chart = document.querySelectorAll<HTMLElement>('[data-testid="result-view"]')[i]?.querySelector<HTMLElement>('[data-testid="chart-visual"]');
    const rect = chart?.getBoundingClientRect();
    return rect === undefined ? undefined : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, index);
  if (box === undefined) { return false; }
  for (const down of [0.85, 0.7, 0.55, 0.4]) {
    for (let across = 0.06; across < 0.97; across += 0.03) {
      const x = box.x + box.width * across;
      const y = box.y + box.height * down;
      await page.mouse.move(x, y);
      const points = await page.evaluate((i) => {
        const chart = document.querySelectorAll<HTMLElement>('[data-testid="result-view"]')[i]?.querySelector<HTMLElement>('[data-testid="chart-visual"]');
        return [...(chart?.querySelectorAll<HTMLElement>('div') ?? [])].some((layer) => layer.style.cursor === 'pointer');
      }, index);
      if (points) {
        await page.mouse.click(x, y);
        return true;
      }
    }
  }
  return false;
}

export default feature({
  id: 'widget-drill', ref: 'build-9 feedback 2026-11-14 (drill-downs from every widget)', title: 'Drill into a group: its rows in a modal, a table first', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await open(ctx, '/chat', tid('session-row'));
    const gallery = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((row) => row.textContent.includes('Chart gallery'))?.dataset['session']);
    check(typeof gallery === 'string', 'the mock lists the chart gallery');
    await open(ctx, `/chat/${gallery}`, tid('chart-visual'));
    await settle(page, 1000);

    // a result its query can't drill into: its marks don't point, and a click opens nothing
    const network = await chartIndex(page, 'network');
    if (network >= 0) {
      await bringUp(page, network);
      check(!await clickMark(page, network), 'a result that cannot be drilled has no mark that points');
    }

    const bars = await chartIndex(page, 'category');
    check(bars >= 0, 'the gallery has a bar chart');
    await bringUp(page, bars);
    await ctx.shot('chart');
    check(await clickMark(page, bars), 'a bar of the grouped result can be clicked');
    await page.waitForSelector(`${tid('drill-dialog')} ${tid('result-row')}, ${tid('drill-dialog')} ${tid('result-card')}`, { visible: true });
    await settle(page, 600);
    const title = await page.$eval(tid('drill-dialog'), (dialog) => dialog.textContent);
    check(title.includes('City:'), 'the modal names the group it opened, its key humanized');
    const hint = await page.$eval(`${tid('drill-dialog')} h2`, (heading) => heading.getAttribute('title') ?? '');
    check(hint.startsWith('city: '), 'its title keeps the raw key for anyone curious');
    const visual = await page.$eval(`${tid('drill-dialog')} ${tid('result-view')}`, (view) => (view instanceof HTMLElement ? view.dataset['visual'] : undefined));
    check(visual === 'table', 'the rows behind the group show as a table first');
    await ctx.shot('modal');

    // its own 3-dot menu, as any widget's
    const more = await page.$(`${tid('drill-dialog')} ${tid('widget-more')}`);
    check(more !== null, 'the modal widget has its menu');
    await more.click();
    await page.waitForSelector('[role="menu"]', { visible: true });
    await settle(page, 300);
    await ctx.shot('modal-menu');
    await page.keyboard.press('Escape');
    await settle(page, 200);

    // the next page of the rows behind it
    const next = await page.$(`${tid('drill-dialog')} ${tid('result-next')}`);
    if (next !== null && await next.evaluate((button) => button instanceof HTMLButtonElement && !button.disabled)) {
      await next.click();
      await settle(page, 800);
      await ctx.shot('modal-next');
    }
    await page.click(`${tid('drill-dialog')} button[aria-label="Close"]`);
    await page.waitForSelector(tid('drill-dialog'), { hidden: true });
  },
});
