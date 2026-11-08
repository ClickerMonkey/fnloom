/**
 * Reusable puppeteer checks for the web app. A `Scenario` drives one UI feature; `runScenarios` runs every scenario at
 * every viewport (phone, tablet, desktop) in light and dark, saves a screenshot of each step under `e2e/shots/`, and
 * checks the layout rules the owner asked for: no horizontal scroll, no overlapping controls, nothing clipped off
 * screen. Scenarios live in `e2e/scenarios/` and are added there as features land.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import { DEFAULT_PORTS } from '@harness/core';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { z } from 'zod';

/** Where the app under test runs, and where shots go. */
export const e2eEnv = env({
  HARNESS_E2E_URL: z.string().default(`http://127.0.0.1:${DEFAULT_PORTS.web}`),
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

/**
 * Check the page against the layout rules. Runs in the browser. A control counts when it is drawn (bigger than 1px,
 * not hidden, on screen vertically) and is the top thing at its centre, so controls under an open dialog or popover
 * are not compared with the ones above them. A control inside a box that scrolls or clips sideways (a tab strip) may
 * reach past the screen's edge, since that box keeps it in. Overlays (marked `data-layer`) float over the page on
 * purpose, so only controls in the same layer are compared for overlap. A pinned bar (`position: sticky` or `fixed`, like
 * the admin tabs and filters) is drawn over the rows scrolling under it on purpose, so a row it covers is not an overlap.
 */
export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(() => {
    const problems: Array<{ rule: 'horizontal-scroll' | 'overlap' | 'offscreen'; detail: string }> = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      problems.push({ rule: 'horizontal-scroll', detail: `page is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window` });
    }
    const describe = (el: Element): string => `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}${el.getAttribute('aria-label') === null ? '' : `[${String(el.getAttribute('aria-label'))}]`} "${el.textContent.trim().slice(0, 30)}"`;
    const onTop = (el: Element, r: DOMRect): boolean => {
      const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (el === hit || el.contains(hit) || hit.contains(el));
    };
    /** The part of an element its scrolling or clipping ancestors let show (a row half scrolled out of the thread shows only its visible half). */
    const shown = (el: Element): { left: number; top: number; right: number; bottom: number } => {
      const r = el.getBoundingClientRect();
      const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (let at = el.parentElement; at !== null && at !== document.body; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') { continue; }
        const clip = at.getBoundingClientRect();
        if (style.overflowX !== 'visible') { box.left = Math.max(box.left, clip.left); box.right = Math.min(box.right, clip.right); }
        if (style.overflowY !== 'visible') { box.top = Math.max(box.top, clip.top); box.bottom = Math.min(box.bottom, clip.bottom); }
      }
      return box;
    };
    const clippedSideways = (el: Element): boolean => {
      for (let at = el.parentElement; at !== null && at !== document.body; at = at.parentElement) {
        if (getComputedStyle(at).overflowX !== 'visible') { return true; }
      }
      return false;
    };
    /** The nearest box that stays put while the page scrolls under it (`position: sticky` or `fixed`), if any. */
    const pinnedBox = (el: Element): Element | null => {
      for (let at: Element | null = el; at !== null && at !== document.body; at = at.parentElement) {
        const position = getComputedStyle(at).position;
        if (position === 'sticky' || position === 'fixed') { return at; }
      }
      return null;
    };
    /** Whether a pinned bar holding one of two controls is drawn over the other where they meet: content scrolling under it. */
    const pinnedOver = (a: Element, b: Element, x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      const box = hit === null ? null : pinnedBox(hit);
      return box !== null && box.contains(a) !== box.contains(b);
    };
    const controls = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      const visible = shown(el);
      const style = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && visible.right - visible.left > 1 && visible.bottom - visible.top > 1 && style.visibility !== 'hidden' && style.display !== 'none'
        && r.bottom > 0 && r.top < window.innerHeight && onTop(el, new DOMRect(visible.left, visible.top, visible.right - visible.left, visible.bottom - visible.top));
    });
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if ((r.right > window.innerWidth + 1 || r.left < -1) && !clippedSideways(el)) { problems.push({ rule: 'offscreen', detail: describe(el) }); }
    }
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a === undefined || b === undefined || a.contains(b) || b.contains(a)) { continue; }
        // an overlay (popover, dialog, toast; marked data-layer) floats over the page on purpose
        if (a.closest('[data-layer]') !== b.closest('[data-layer]')) { continue; }
        const ra = shown(a);
        const rb = shown(b);
        const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 2 && overlapY > 2 && !pinnedOver(a, b, Math.max(ra.left, rb.left) + overlapX / 2, Math.max(ra.top, rb.top) + overlapY / 2)) { problems.push({ rule: 'overlap', detail: `${describe(a)} at ${Math.round(ra.left)},${Math.round(ra.top)} overlaps ${describe(b)} at ${Math.round(rb.left)},${Math.round(rb.top)}` }); }
      }
    }
    return problems;
  });
}

/** Run scenarios at every viewport and theme, against `url` (default `HARNESS_E2E_URL`). Returns every result; the caller decides how to report. */
export async function runScenarios(scenarios: readonly Scenario[], options: { browser?: Browser; url?: string } = {}): Promise<ScenarioResult[]> {
  const settings = e2eEnv.parse();
  const base = options.url ?? settings.HARNESS_E2E_URL;
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
            url: (path) => new URL(path, base).toString(),
            shot: async (name) => {
              const file = `${shotsDir}${scenario.name}-${name}-${viewport}-${theme}.png`;
              await page.screenshot({ path: file, fullPage: true });
              shots.push(file);
              problems.push(...(await layoutProblems(page)).map((problem) => ({ ...problem, detail: `${name}: ${problem.detail}` })));
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
