/**
 * The widget pass's charts, rendered: the mock's chart gallery chat holds one result per ECharts family; each is
 * switched to its family and drawn in every style, at phone and desktop width, light and dark. Only what rendering
 * shows is checked here (the chart fits its frame, the chrome row never covers it, nothing scrolls sideways); which
 * family and series each style draws is covered by the component tests.
 */
import { BUILT_IN_VISUALS, VISUAL_FAMILIES } from '@harness/core';
import type { Page } from 'puppeteer';
import { check, feature, inEachScheme, open, settle, tid } from '../kit.ts';

/** The chart families, in the gallery's order (the mock seeds one result for each). */
const CHART_FAMILIES = VISUAL_FAMILIES.filter((family) => family !== 'table' && family !== 'value');

/** What overlaps in the `index`th result view: the chart wider than its frame, or the chrome row over the chart. */
function overlap(page: Page, index: number): Promise<string | undefined> {
  return page.evaluate((at) => {
    const view = document.querySelectorAll<HTMLElement>('[data-testid="result-view"]')[at];
    const chart = view?.querySelector<HTMLElement>('[data-testid="chart-visual"]');
    const tools = view?.querySelector<HTMLElement>('.tools');
    if (view === undefined || chart === null || chart === undefined || tools === null || tools === undefined) { return 'no chart drawn'; }
    const frame = view.getBoundingClientRect(); const box = chart.getBoundingClientRect(); const row = tools.getBoundingClientRect();
    const drawn = chart.querySelector('svg, canvas')?.getBoundingClientRect();
    if (drawn === undefined || drawn.width === 0 || drawn.height === 0) { return 'the chart drew nothing'; }
    if (drawn.right > frame.right + 1 || box.right > frame.right + 1) { return 'the chart is wider than its frame'; }
    if (row.bottom > box.top + 1) { return 'the chrome row covers the chart'; }
    return undefined;
  }, index);
}

export default feature({
  id: 'widgets-charts', ref: 'build-8 widgets design §2 Chart types, Look', title: 'Every chart family and style', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    // charts draw without their entry animation, so each shot shows the finished drawing
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await open(ctx, '/chat', tid('session-row'));
    const session = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((row) => row.textContent.includes('Chart gallery'))?.dataset['session']);
    check(typeof session === 'string', 'the mock lists the chart gallery chat');
    await open(ctx, `/chat/${session}`, tid('result-view'));
    await settle(page, 800);
    await inEachScheme(ctx, async (shot) => {
      for (const [index, family] of CHART_FAMILIES.entries()) {
        const view = (await page.$$(tid('result-view')))[index];
        check(view !== undefined, `the gallery has a result for ${family}`);
        await view.scrollIntoView();
        await view.$eval(`[data-testid="result-visuals"] [aria-label="${BUILT_IN_VISUALS[family].label}"]`, (button) => { if (button instanceof HTMLElement) { button.click(); } });
        for (const style of BUILT_IN_VISUALS[family].shape.styles) {
          const picker = await view.$('[data-testid="result-style"] select');
          if (picker !== null) { await picker.select(style.name); }
          await settle(page, 300);
          const problem = await overlap(page, index);
          check(problem === undefined, `${family} ${style.name}: ${problem ?? ''}`);
        }
        check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${family}: the chat fits the screen`);
        await shot(family);
      }
    }, { still: true });
  },
});
