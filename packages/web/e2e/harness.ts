/**
 * Reusable puppeteer checks for the web app. A `Scenario` drives one UI feature; `runScenarios` runs every scenario at
 * every viewport (phone, tablet, desktop) in light and dark, saves a screenshot of each step under `e2e/shots/`, and
 * checks the layout rules the owner asked for: no horizontal scroll, no overlapping controls, nothing clipped off
 * screen. Scenarios live in `e2e/scenarios/` and are added there as features land.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { z } from 'zod';

/** Where the app under test runs, and where shots go. */
export const e2eEnv = env({
  HARNESS_E2E_URL: z.string().default('http://127.0.0.1:4310'),
  HARNESS_E2E_HEADLESS: z.boolean().default(true),
  /** A comma list of scenario names to run; empty runs them all. */
  HARNESS_E2E_ONLY: z.string().default(''),
});

/** The screen sizes every scenario is checked at, in the order they run. */
export const VIEWPORT_NAMES = ['phone', 'tablet', 'desktop'] as const;
export type ViewportName = (typeof VIEWPORT_NAMES)[number];

/** Each screen size. */
export const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
} as const satisfies Record<ViewportName, { width: number; height: number; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean }>;

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** A layout problem found on a page. */
export interface LayoutProblem {
  readonly rule: 'horizontal-scroll' | 'overlap' | 'offscreen';
  readonly detail: string;
}

/** What a scenario step gets. */
export interface StepContext {
  readonly page: Page;
  readonly url: (path: string) => string;
  readonly viewport: ViewportName;
  readonly theme: Theme;
  /** Save a screenshot of the current state and check its layout. */
  readonly shot: (name: string) => Promise<void>;
}

/** One UI feature to drive and check. */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  run(ctx: StepContext): Promise<void>;
}

/** The result of one scenario at one viewport and theme. */
export interface ScenarioResult {
  readonly scenario: string;
  readonly viewport: ViewportName;
  readonly theme: Theme;
  readonly shots: readonly string[];
  readonly problems: readonly LayoutProblem[];
  readonly error?: string;
}

/** Check the page against the layout rules. Runs in the browser. */
export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(() => {
    const problems: Array<{ rule: 'horizontal-scroll' | 'overlap' | 'offscreen'; detail: string }> = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      problems.push({ rule: 'horizontal-scroll', detail: `page is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window` });
    }
    const describe = (el: Element): string => `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}${el.getAttribute('aria-label') === null ? '' : `[${String(el.getAttribute('aria-label'))}]`} "${el.textContent.trim().slice(0, 30)}"`;
    const controls = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 || r.left < -1) { problems.push({ rule: 'offscreen', detail: describe(el) }); }
    }
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a === undefined || b === undefined || a.contains(b) || b.contains(a)) { continue; }
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 2 && overlapY > 2) { problems.push({ rule: 'overlap', detail: `${describe(a)} overlaps ${describe(b)}` }); }
      }
    }
    return problems;
  });
}

/** Run scenarios at every viewport and theme. Returns every result; the caller decides how to report. */
export async function runScenarios(scenarios: readonly Scenario[], options: { browser?: Browser } = {}): Promise<ScenarioResult[]> {
  const settings = e2eEnv.parse();
  const only = new Set(settings.HARNESS_E2E_ONLY.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  const browser = options.browser ?? await puppeteer.launch({ headless: settings.HARNESS_E2E_HEADLESS });
  const shotsDir = fileURLToPath(new URL('./shots/', import.meta.url));
  await mkdir(shotsDir, { recursive: true });
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      if (only.size > 0 && !only.has(scenario.name)) { continue; }
      for (const viewport of VIEWPORT_NAMES) {
        for (const theme of THEMES) {
          const page = await browser.newPage();
          // tsx keeps function names with a `__name` helper, which code passed to page.evaluate would call in the browser
          await page.evaluateOnNewDocument('globalThis.__name = (fn) => fn;');
          await page.setViewport(VIEWPORTS[viewport]);
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          const shots: string[] = [];
          const problems: LayoutProblem[] = [];
          const ctx: StepContext = {
            page, viewport, theme,
            url: (path) => new URL(path, settings.HARNESS_E2E_URL).toString(),
            shot: async (name) => {
              const file = `${shotsDir}${scenario.name}-${name}-${viewport}-${theme}.png`;
              await page.screenshot({ path: file, fullPage: true });
              shots.push(file);
              problems.push(...await layoutProblems(page));
            },
          };
          try {
            await scenario.run(ctx);
            results.push({ scenario: scenario.name, viewport, theme, shots, problems });
          } catch (error) {
            results.push({ scenario: scenario.name, viewport, theme, shots, problems, error: error instanceof Error ? error.message : 'failed' });
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    if (options.browser === undefined) { await browser.close(); }
  }
  return results;
}
