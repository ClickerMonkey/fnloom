/**
 * The UI test kit. A `Feature` drives one UI feature of a running harness (the base URL in `HARNESS_UI_URL`; nothing
 * is booted here) and asserts it works. `run.ts` runs every feature at each of the app's layouts (`EVERY_FEATURE`: a
 * desktop, a narrow laptop, a tablet and a phone), and the features that ask for them (`also`) at a wide screen and a
 * phone on its side, signed in as the admin in one browser context per viewport, saving each step's screenshot to
 * `ui-tests/shots/<feature>/<viewport>-<step>.png` and checking the layout rules there (no sideways scroll, no
 * overlapping or off-screen controls).
 */
import { env } from '@ayepi/env';
import type { MessageId, RunId, SessionId, TurnId } from '@harness/core';
import type { ElementHandle, Page } from 'puppeteer';
import { z } from 'zod';
import type { LayoutProblem } from '../packages/web/e2e/harness.ts';
import type { SignedIn } from '../scripts/hub-client.ts';

/** The UI tests' settings. */
export const uiEnv = env({
  /** The harness under test (the hub, which serves the web app). Required. */
  HARNESS_UI_URL: z.url(),
  HARNESS_UI_EMAIL: z.email(),
  HARNESS_UI_PASSWORD: z.string().min(1),
  /** A comma list of feature ids to run; empty runs them all. */
  HARNESS_UI_ONLY: z.string().default(''),
  /** A comma list of viewports to run (`tablet,phone`); empty runs them all. */
  HARNESS_UI_VIEWPORTS: z.string().default(''),
  HARNESS_UI_HEADLESS: z.boolean().default(true),
  /** How long the fixture's agent turn may take. */
  HARNESS_UI_TURN_TIMEOUT: z.number().int().min(10_000).default(240_000),
  /** The app talks to the web app's mock hub (`ui-tests/mock.ts` sets it): features skip what only a real hub does. */
  HARNESS_UI_MOCK: z.boolean().default(false),
});
export type UiSettings = ReturnType<typeof uiEnv.parse>;

/**
 * The screens features are checked at, one for each layout the app has (its breakpoints: the compact shell below 760px
 * wide or 500px tall, the chat list's own column from 1100px, a side panel beside the list from 1360px, and both
 * with room to spare from 1720px). `compact` says the app shows its compact shell there (drawer navigation, sheets).
 */
export const VIEWPORTS = {
  /** 1360-1719px: a side panel takes the chat list's column. */
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, compact: false },
  /** 1100-1359px: the list has its column, a panel is a sheet over the thread. */
  laptop: { width: 1180, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, compact: false },
  /** 760-1099px: the sidebar, with the chat list as a drawer. */
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, compact: false },
  /** A tall tablet (an iPad Air upright), the tablet size build 2's features are checked at. */
  tabletTall: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true, compact: false },
  /** Below 760px: the compact shell. */
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, compact: true },
  /** From 1720px: the list and a side panel side by side. */
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false, compact: false },
  /** A phone on its side: wide enough for the sidebar, too short for it, so the compact shell. */
  landscape: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, compact: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** The viewports every feature runs at; a feature adds others with `also`, or names its own with `viewports`. */
export const EVERY_FEATURE: readonly ViewportName[] = ['desktop', 'laptop', 'tablet', 'phone'];

/** The viewports build 2's features are checked at: a desktop, a tall tablet and a phone (each in light and dark). */
export const BUILD_2_VIEWPORTS: readonly ViewportName[] = ['desktop', 'tabletTall', 'phone'];

/** What the fixture session holds, made once through the API so features have something real to look at. */
export interface Fixtures {
  readonly session: SessionId;
  /** The agent turn that read README.md with fs/read. */
  readonly readTurn: TurnId;
  readonly userMessage: MessageId;
  readonly answer: MessageId;
  /** A fs/bash run invoked by hand, approved, done. */
  readonly bashRun: RunId;
  readonly bashTurn: TurnId;
}

/** What a feature's steps get. */
export interface FeatureContext {
  readonly page: Page;
  readonly viewport: ViewportName;
  readonly fixtures: Fixtures;
  /** Signed in to the API as the admin, to set things up or check what the UI did. */
  readonly api: SignedIn;
  /** Whether the hub behind the app is the mock (`HARNESS_UI_MOCK`), so a feature can't start real systems on it. */
  readonly mock: boolean;
  /** An absolute URL on the harness under test. */
  url(path: string): string;
  /** Save a screenshot of this step and check its layout. */
  shot(step: string): Promise<void>;
}

/** One UI feature to drive and check. */
export interface Feature {
  /** The folder its shots go in (`chat-shell`). */
  readonly id: string;
  /** Where the feature is specified (`chat-features 1.1`, `admin systems`). */
  readonly ref: string;
  readonly title: string;
  /** Start signed out, in a browser context of its own (sign-in, sign-out). */
  readonly signedOut?: boolean;
  /** Viewports to run at besides `EVERY_FEATURE` (`wide` for panel-heavy features, `landscape` for the shell). */
  readonly also?: readonly ViewportName[];
  /** The viewports to run at instead of `EVERY_FEATURE` (and `also`). */
  readonly viewports?: readonly ViewportName[];
  run(ctx: FeatureContext): Promise<void>;
}

/** Declare a feature. */
export function feature(def: Feature): Feature {
  return def;
}

/** The result of one feature at one viewport. */
export interface FeatureResult {
  readonly feature: string;
  readonly viewport: ViewportName;
  readonly shots: readonly string[];
  readonly problems: readonly LayoutProblem[];
  readonly error?: string;
  readonly took: number;
}

// ─── Steps the features share ─────────────────────────────────────────────────

/** A `[data-testid]` selector. */
export const tid = (id: string): string => `[data-testid="${id}"]`;

/** Fail the feature with `message` unless `ok`. */
export function check(ok: boolean, message: string): asserts ok {
  if (!ok) { throw new Error(message); }
}

/** Let transitions finish before a screenshot or a check. */
export async function settle(page: Page, ms = 400): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve); }); }));
}

/** Open a page and wait for the app to have drawn it. */
export async function open(ctx: FeatureContext, path: string, ready: string = 'main'): Promise<void> {
  await ctx.page.goto(ctx.url(path), { waitUntil: 'networkidle0' });
  await ctx.page.waitForSelector(ready, { timeout: 20_000 });
  await settle(ctx.page);
}

/** Wait for an element by test id and return it. */
export async function find(page: Page, id: string, timeout = 15_000): Promise<ElementHandle> {
  const found = await page.waitForSelector(tid(id), { timeout, visible: true });
  check(found !== null, `no ${id} on the page`);
  return found;
}

/** How many elements with a test id are on the page. */
export function count(page: Page, id: string): Promise<number> {
  return page.$$eval(tid(id), (els) => els.length);
}

/** Whether an element with a test id is visible now. */
export function visible(page: Page, id: string): Promise<boolean> {
  return page.$$eval(tid(id), (els) => els.some((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }));
}

/** Type into a picker (`UiPicker`, by its test id), wait for an option to show, and pick the first with Enter. */
export async function pickIn(page: Page, id: string, text: string): Promise<void> {
  await page.type(`${tid(id)} input`, text);
  await page.waitForSelector('[data-testid="picker-option"]', { timeout: 15_000, visible: true });
  await page.keyboard.press('Enter');
}

/** The text of the first element with a test id. */
export async function textOf(page: Page, id: string): Promise<string> {
  const handle = await find(page, id);
  return handle.evaluate((el) => el.textContent.trim());
}

/** Open a session's thread. */
export function openSession(ctx: FeatureContext, session: SessionId = ctx.fixtures.session): Promise<void> {
  return open(ctx, `/chat/${session}`, tid('thread'));
}

/** Whether the app shows its compact shell at this viewport (a phone, upright or on its side). */
export const isPhone = (ctx: FeatureContext): boolean => VIEWPORTS[ctx.viewport].compact;

/** Whether this viewport is a touch screen (taps, not hovers; the send button, not Enter). */
export const isTouch = (ctx: FeatureContext): boolean => VIEWPORTS[ctx.viewport].hasTouch;

/** Whether the chat list has its own column beside the thread here (1100px and wider, outside the compact shell). */
export const hasListColumn = (ctx: FeatureContext): boolean => !VIEWPORTS[ctx.viewport].compact && VIEWPORTS[ctx.viewport].width >= 1100;

/** The viewports a feature runs at. */
export function viewportsOf(feature: Feature): readonly ViewportName[] {
  return feature.viewports ?? [...EVERY_FEATURE, ...(feature.also ?? [])];
}

/** The colour schemes a feature is shot in. */
export const SCHEMES = ['light', 'dark'] as const;
export type Scheme = (typeof SCHEMES)[number];

/**
 * Run steps once in each colour scheme (the device's preference, which the app follows unless a theme was chosen), so
 * every shot of a feature exists in light and dark. Shots name their scheme: `shot(name)` saves `<name>-<scheme>`.
 */
export async function inEachScheme(ctx: FeatureContext, steps: (shot: (name: string) => Promise<void>, scheme: Scheme) => Promise<void>): Promise<void> {
  for (const scheme of SCHEMES) {
    await ctx.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await steps((name) => ctx.shot(`${name}-${scheme}`), scheme);
  }
  await ctx.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
}

/** Empty the composer (a draft from an earlier run is kept per chat). */
export async function clearComposer(page: Page): Promise<void> {
  await page.$eval(tid('composer-input'), (el) => {
    if (el instanceof HTMLTextAreaElement) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}

/** Type into an empty composer. */
export async function compose(page: Page, text: string): Promise<void> {
  await find(page, 'composer-input');
  await clearComposer(page);
  await page.click(tid('composer-input'));
  await page.type(tid('composer-input'), text);
}

/** Send what is in the composer (Enter on desktop; the button on touch screens, where Enter breaks the line). */
export async function sendComposer(ctx: FeatureContext): Promise<void> {
  if (isTouch(ctx)) { await ctx.page.click(tid('send')); } else { await ctx.page.keyboard.press('Enter'); }
}

/** Start a new, empty chat through the UI and return its id (from the URL). */
export async function newChat(ctx: FeatureContext): Promise<SessionId> {
  const session = await ctx.api.hub.call('createSession', { title: `UI ${Date.now().toString(36)}` });
  await openSession(ctx, session.id);
  return session.id;
}

/** Whether an element is wholly inside the window. */
export function onScreen(page: Page, id: string): Promise<boolean> {
  return page.$eval(tid(id), (el) => { const r = el.getBoundingClientRect(); return r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1; });
}

/** Hover an element on desktop, or tap it on a phone (where hover actions show on tap). */
export async function point(ctx: FeatureContext, selector: string): Promise<void> {
  if (isTouch(ctx)) { await ctx.page.tap(selector); } else { await ctx.page.hover(selector); }
  await settle(ctx.page, 250);
}

/** Scroll the first match of `selector` to the middle of its scroller, so a shot shows it. */
export async function show(page: Page, selector: string): Promise<void> {
  const found = await page.waitForSelector(selector, { timeout: 15_000 });
  check(found !== null, `no ${selector} on the page`);
  await found.evaluate((el) => { el.scrollIntoView({ block: 'center', behavior: 'instant' }); });
  await settle(page, 250);
}

/**
 * Record every `data-status` the run cards in the page take from now on, keyed by run id (a `MutationObserver`, so
 * states that last a moment are still seen). Read them back with `statusesSeen`.
 */
export async function watchStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = new Map<string, string[]>();
    const note = (el: Element) => {
      const run = el.getAttribute('data-run');
      const status = el.getAttribute('data-status');
      if (run === null || status === null) { return; }
      const list = seen.get(run) ?? [];
      if (list.at(-1) !== status) { list.push(status); }
      seen.set(run, list);
    };
    const scan = () => { for (const el of document.querySelectorAll('[data-testid="run-card"]')) { note(el); } };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
    scan();
    Object.assign(window, { harnessStatuses: seen });
  });
}

/** The statuses `watchStatuses` saw, by run id. */
export function statusesSeen(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const seen: unknown = Reflect.get(window, 'harnessStatuses');
    if (!(seen instanceof Map)) { return {}; }
    return Object.fromEntries([...seen.entries()].map(([run, list]: [unknown, unknown]) => [String(run), Array.isArray(list) ? list.map(String) : []]));
  });
}
