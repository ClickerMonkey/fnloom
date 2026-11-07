/**
 * The UI test kit. A `Feature` drives one UI feature of a running harness (the base URL in `HARNESS_UI_URL`; nothing
 * is booted here) and asserts it works. `run.ts` runs every feature at desktop (1440x900) and phone (390x844), signed
 * in as the admin in one browser context per viewport, saving each step's screenshot to
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
  HARNESS_UI_HEADLESS: z.boolean().default(true),
  /** How long the fixture's agent turn may take. */
  HARNESS_UI_TURN_TIMEOUT: z.number().int().min(10_000).default(240_000),
});
export type UiSettings = ReturnType<typeof uiEnv.parse>;

/** The two screens every feature is checked at. */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

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

/** The text of the first element with a test id. */
export async function textOf(page: Page, id: string): Promise<string> {
  const handle = await find(page, id);
  return handle.evaluate((el) => el.textContent.trim());
}

/** Open a session's thread. */
export function openSession(ctx: FeatureContext, session: SessionId = ctx.fixtures.session): Promise<void> {
  return open(ctx, `/chat/${session}`, tid('thread'));
}

/** Whether this is the phone run. */
export const isPhone = (ctx: FeatureContext): boolean => ctx.viewport === 'phone';

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
  if (isPhone(ctx)) { await ctx.page.click(tid('send')); } else { await ctx.page.keyboard.press('Enter'); }
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
  if (isPhone(ctx)) { await ctx.page.tap(selector); } else { await ctx.page.hover(selector); }
  await settle(ctx.page, 250);
}
