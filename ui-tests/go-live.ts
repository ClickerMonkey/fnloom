/**
 * `npm run ui-tests:go-live`: on a hub where systems wait for review (`HARNESS_REVIEW_SYSTEMS`, on by default), shoot each
 * waiting system's review page as an admin first sees it, then put it live the way that page's Go live does; and for a
 * live system whose changed contract waits (after a code change), shoot its Pending tab and approve it the way Approve
 * all does. Run it on a fresh `npm run test:stack` before `npm run ui-tests` (the fixtures need fs live), and after
 * changing a system.
 *
 * Shots go to `ui-tests/shots/go-live/<system>.png` (`<system>-pending.png` for changes). While a system or its changed
 * client build waits, the build is not served (security review H3), so its renderers and settings page don't load yet.
 *
 *   HARNESS_UI_URL=http://127.0.0.1:4340 HARNESS_UI_EMAIL=… HARNESS_UI_PASSWORD=… npm run ui-tests:go-live
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { signIn } from '../scripts/hub-client.ts';
import { tid, uiEnv, VIEWPORTS } from './kit.ts';

const SHOTS = fileURLToPath(new URL('./shots/go-live/', import.meta.url));
const settings = uiEnv.parse();
const base = settings.HARNESS_UI_URL;
mkdirSync(SHOTS, { recursive: true });

const api = await signIn(base, { email: settings.HARNESS_UI_EMAIL, password: settings.HARNESS_UI_PASSWORD });
const browser = await puppeteer.launch({ headless: settings.HARNESS_UI_HEADLESS });
try {
  const page = await browser.newPage();
  const { width, height, deviceScaleFactor } = VIEWPORTS.desktop;
  await page.setViewport({ width, height, deviceScaleFactor });
  await page.goto(new URL('/sign-in', base).toString(), { waitUntil: 'networkidle0' });
  await page.type('input[type="email"]', settings.HARNESS_UI_EMAIL);
  await page.type('input[type="password"]', settings.HARNESS_UI_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname !== '/sign-in', { timeout: 20_000 });

  for (const system of await api.hub.call('systems', {})) {
    const review = await api.hub.call('systemReview', { system: system.name });
    if (review.stage === 'live' && review.pending !== undefined) {
      await page.goto(new URL(`/admin/systems/${system.name}/review/pending`, base).toString(), { waitUntil: 'networkidle0' });
      await page.waitForSelector(tid('approve-review'), { timeout: 15_000 });
      const file = join(SHOTS, `${system.name}-pending.png`);
      await page.screenshot({ path: file, fullPage: true });
      await api.hub.call('approveReview', { system: system.name, hash: review.pending.hash, off: [] });
      console.info(`approved ${system.name.padEnd(14)} ${review.pending.changes.map((change) => `${change.name} ${change.change}`).join(', ')}  ${file}`);
      continue;
    }
    if (review.stage !== 'installed') { continue; }
    await page.goto(new URL(`/admin/systems/${system.name}/review`, base).toString(), { waitUntil: 'networkidle0' });
    await page.waitForSelector(tid('go-live'), { timeout: 15_000 });
    const waiting = await page.$(tid('config-custom-unapproved'));
    const file = join(SHOTS, `${system.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const live = await api.hub.call('goLive', { system: system.name, hash: review.manifest.hash, off: [] });
    console.info(`live   ${system.name.padEnd(16)} ${live.stage}${waiting === null ? '' : '  (settings page held until approval)'}  ${file}`);
  }
} finally {
  await browser.close();
  api.close();
}
