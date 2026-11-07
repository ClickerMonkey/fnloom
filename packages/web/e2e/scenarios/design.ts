/**
 * The design gallery: every section of primitives, plus the open menu, dialog, popover and a toast, at every size
 * and in both themes. The layout rules run on each shot.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn } from './steps.ts';

const SECTIONS = ['actions', 'inputs', 'overlays', 'feedback', 'content'] as const;

export const design: Scenario = {
  name: 'design',
  description: 'Every primitive in its states, and the overlays open, fit every screen in both themes.',
  async run(ctx) {
    const { page, url, shot } = ctx;
    await signedIn(ctx, '/design/actions');
    for (const section of SECTIONS) {
      await page.goto(url(`/design/${section}`), { waitUntil: 'networkidle0' });
      await page.waitForSelector(`[data-testid="design-${section}"]`);
      await settle(page);
      await shot(section);
    }

    await page.goto(url('/design/actions'), { waitUntil: 'networkidle0' });
    await page.click('[data-testid="design-menu"]');
    await page.waitForSelector('[role="menu"]');
    await settle(page);
    await shot('menu');
    check(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), 'the menu should focus its first action');
    await page.keyboard.press('Escape');

    await page.goto(url('/design/overlays'), { waitUntil: 'networkidle0' });
    await page.click('[data-testid="design-dialog"]');
    await page.waitForSelector('[role="dialog"][aria-modal="true"]');
    await settle(page);
    await shot('dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[aria-modal="true"]') === null);
    await page.click('[data-testid="design-popover"]');
    await page.waitForSelector('[data-testid="design-popover-panel"]');
    await settle(page);
    await shot('popover');
    await page.keyboard.press('Escape');

    await page.goto(url('/design/feedback'), { waitUntil: 'networkidle0' });
    await page.click('[data-testid="design-toast"]');
    await page.waitForSelector('.toast');
    await settle(page);
    await shot('toast');
  },
};
