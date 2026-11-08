/**
 * `npm run ui-tests`: run every UI feature against the harness at `HARNESS_UI_URL` (boots nothing), at each viewport
 * it runs at (`viewportsOf`), signed in as `HARNESS_UI_EMAIL`. Shots go to `ui-tests/shots/<feature>/<viewport>-<step>.png`, a summary to
 * `ui-tests/shots/report.json`. Exits 1 when a feature fails or a shot breaks a layout rule.
 *
 *   HARNESS_UI_URL=http://127.0.0.1:4300 HARNESS_UI_EMAIL=… HARNESS_UI_PASSWORD=… npm run ui-tests
 *   HARNESS_UI_ONLY=chat-shell,composer npm run ui-tests     # just these features
 *   HARNESS_UI_VIEWPORTS=tablet,landscape npm run ui-tests   # just these viewports
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer';
import { layoutProblems, type LayoutProblem } from '../packages/web/e2e/harness.ts';
import { signIn, type SignedIn } from '../scripts/hub-client.ts';
import { FEATURES } from './features/index.ts';
import { fixtures } from './fixtures.ts';
import { settle, tid, uiEnv, viewportsOf, VIEWPORTS, type Feature, type FeatureResult, type Fixtures, type UiSettings, type ViewportName } from './kit.ts';

const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url));

/** A page set up for one viewport: its size, and the helper code `page.evaluate` needs under tsx. */
async function pageFor(context: BrowserContext, viewport: ViewportName): Promise<Page> {
  const page = await context.newPage();
  // tsx keeps function names with a `__name` helper, which code passed to page.evaluate would call in the browser
  await page.evaluateOnNewDocument('globalThis.__name = (fn) => fn;');
  const { width, height, deviceScaleFactor, isMobile, hasTouch } = VIEWPORTS[viewport];
  await page.setViewport({ width, height, deviceScaleFactor, isMobile, hasTouch });
  return page;
}

/** A browser context signed in through the sign-in page (the token lives in its storage). */
async function signedInContext(browser: Browser, settings: UiSettings, viewport: ViewportName): Promise<BrowserContext> {
  const context = await browser.createBrowserContext();
  const page = await pageFor(context, viewport);
  await page.goto(new URL('/sign-in', settings.HARNESS_UI_URL).toString(), { waitUntil: 'networkidle0' });
  await page.waitForSelector(tid('sign-in-form'));
  await page.type('input[type="email"]', settings.HARNESS_UI_EMAIL);
  await page.type('input[type="password"]', settings.HARNESS_UI_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname !== '/sign-in', { timeout: 20_000 });
  await page.close();
  return context;
}

/** Run one feature at one viewport. */
async function runOne(feature: Feature, viewport: ViewportName, context: BrowserContext, base: string, api: SignedIn, made: Fixtures): Promise<FeatureResult> {
  const dir = join(SHOTS, feature.id);
  mkdirSync(dir, { recursive: true });
  const page = await pageFor(context, viewport);
  const shots: string[] = [];
  const problems: LayoutProblem[] = [];
  let step = 'start';
  const started = Date.now();
  try {
    await feature.run({
      page, viewport, fixtures: made, api,
      url: (path) => new URL(path, base).toString(),
      shot: async (name) => {
        step = name;
        await settle(page, 250);
        const file = join(dir, `${viewport}-${name}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
        problems.push(...(await layoutProblems(page)).map((p) => ({ ...p, detail: `${name}: ${p.detail}` })));
      },
    });
    return { feature: feature.id, viewport, shots, problems, took: Date.now() - started };
  } catch (error) {
    await page.screenshot({ path: join(dir, `${viewport}-failed.png`) }).catch(() => undefined);
    return { feature: feature.id, viewport, shots, problems, took: Date.now() - started, error: `after "${step}": ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await page.close();
  }
}

const settings = uiEnv.parse();
const only = new Set(settings.HARNESS_UI_ONLY.split(',').map((s) => s.trim()).filter((s) => s !== ''));
const chosen = FEATURES.filter((f) => only.size === 0 || only.has(f.id));
const screens = new Set(settings.HARNESS_UI_VIEWPORTS.split(',').map((s) => s.trim()).filter((s) => s !== ''));
const base = settings.HARNESS_UI_URL;

const api = await signIn(base, { email: settings.HARNESS_UI_EMAIL, password: settings.HARNESS_UI_PASSWORD });
console.info('ui.fixtures', { base });
const made = await fixtures(api, base, settings.HARNESS_UI_TURN_TIMEOUT);
for (const f of chosen) { rmSync(join(SHOTS, f.id), { recursive: true, force: true }); }

const browser = await puppeteer.launch({ headless: settings.HARNESS_UI_HEADLESS });
const results: FeatureResult[] = [];
try {
  for (const viewport of Object.keys(VIEWPORTS).filter((v): v is ViewportName => v in VIEWPORTS && (screens.size === 0 || screens.has(v)))) {
    const here = chosen.filter((f) => viewportsOf(f).includes(viewport));
    if (here.length === 0) { continue; }
    const context = await signedInContext(browser, settings, viewport);
    for (const f of here) {
      const own = f.signedOut === true ? await browser.createBrowserContext() : undefined;
      const result = await runOne(f, viewport, own ?? context, base, api, made);
      await own?.close();
      results.push(result);
      const status = result.error !== undefined ? 'FAIL' : result.problems.length > 0 ? 'LAYOUT' : 'ok';
      console.info(`${status.padEnd(6)} ${viewport.padEnd(7)} ${f.id.padEnd(28)} ${result.error ?? result.problems.map((p) => `${p.rule}: ${p.detail}`).join(' | ')}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  api.close();
}

writeFileSync(join(SHOTS, 'report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.error !== undefined || r.problems.length > 0);
console.info('ui.done', { features: chosen.length, runs: results.length, failed: failed.length, report: join(SHOTS, 'report.json') });
process.exitCode = failed.length > 0 ? 1 : 0;
