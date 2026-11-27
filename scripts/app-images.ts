/**
 * `npm run app:images`: the installed app's pictures, committed under `packages/web/public/`: the PNG icons the
 * install manifest names (192 and 512, a maskable 512 with the mark inside the safe circle) and the Apple touch icon,
 * drawn from the mark (`favicon.svg`) in headless Chrome; and the install sheet's screenshots (wide 1280×800, narrow
 * 390×844 at 2×) of a chat, taken on the web app's mock hub. Ports of its own, nothing else touched; run it again
 * after the mark or the chat's look changes.
 *
 *   npm run app:images                     # icons and screenshots
 *   HARNESS_APP_IMAGES_ONLY=icons npm run app:images
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import puppeteer, { type Browser } from 'puppeteer';
import { createServer } from 'vite';
import { z } from 'zod';
import type * as MockHub from '../packages/web/e2e/mockHub.ts';

const settings = env({
  HARNESS_APP_IMAGES_ONLY: z.enum(['all', 'icons', 'screenshots']).default('all'),
  HARNESS_APP_IMAGES_HUB_PORT: z.number().int().default(4593),
  HARNESS_APP_IMAGES_WEB_PORT: z.number().int().default(4592),
}).parse();

const WEB = fileURLToPath(new URL('../packages/web/', import.meta.url));
const PUBLIC = join(WEB, 'public');
/** The mark's background, filling a maskable or Apple icon edge to edge (the platform rounds it). */
const ACCENT = '#5b5bd6';

const mark = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
/** The mark's drawing without its rounded square, to sit on a full-bleed background. */
const inner = mark.replace(/<rect[^>]*\/>/, '').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/** A page that is only `body` at `size`, screenshotted to `file`. */
async function draw(browser: Browser, body: string, size: number, file: string): Promise<void> {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${body}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.info('app.images.written', { file });
}

async function icons(browser: Browser): Promise<void> {
  const dir = join(PUBLIC, 'icons');
  mkdirSync(dir, { recursive: true });
  const plain = (size: number): string => mark.replace('<svg ', `<svg width="${String(size)}" height="${String(size)}" style="display:block" `);
  // full bleed: the mark's drawing a little smaller, inside the maskable safe circle (80%) and clear of iOS's corner rounding
  const bleed = (size: number): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${String(size)}" height="${String(size)}" style="display:block">`
    + `<rect width="32" height="32" fill="${ACCENT}"/><g transform="translate(16 16) scale(0.85) translate(-16 -16)">${inner}</g></svg>`;
  await draw(browser, plain(192), 192, join(dir, 'icon-192.png'));
  await draw(browser, plain(512), 512, join(dir, 'icon-512.png'));
  await draw(browser, bleed(512), 512, join(dir, 'maskable-512.png'));
  await draw(browser, bleed(180), 180, join(dir, 'apple-touch-icon.png'));
}

async function screenshots(browser: Browser): Promise<void> {
  const dir = join(PUBLIC, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const hubUrl = `http://127.0.0.1:${String(settings.HARNESS_APP_IMAGES_HUB_PORT)}`;
  const proxy = Object.fromEntries(['/api', '/_files', '/clients', '/manifest.webmanifest'].map((path) => [path, { target: hubUrl, changeOrigin: true }]));
  const server = await createServer({
    root: WEB, configFile: false, logLevel: 'warn',
    plugins: [(await import('@vitejs/plugin-vue')).default()],
    resolve: { dedupe: ['vue', 'zod'] },
    server: { host: '127.0.0.1', port: settings.HARNESS_APP_IMAGES_WEB_PORT, strictPort: true, proxy: { ...proxy, '/ws': { target: hubUrl.replace('http', 'ws'), ws: true } } },
  });
  await server.listen();
  // the mock hub's fixtures reach into the app's components (.vue), so Vite loads it
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- ssrLoadModule is untyped; this is the module's own type
  const mock = await server.ssrLoadModule('/e2e/mockHub.ts') as typeof MockHub;
  const { MOCK_ADMIN } = mock;
  const hub = mock.serveMockHub(settings.HARNESS_APP_IMAGES_HUB_PORT, { needsAdmin: false, notifyEvery: 0, logEvery: 0 });
  const web = `http://127.0.0.1:${String(settings.HARNESS_APP_IMAGES_WEB_PORT)}`;
  try {
    for (const shot of [{ name: 'wide', width: 1280, height: 800, scale: 1 }, { name: 'narrow', width: 390, height: 844, scale: 2 }] as const) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: shot.scale, isMobile: shot.name === 'narrow', hasTouch: shot.name === 'narrow' });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.goto(`${web}/sign-in`, { waitUntil: 'networkidle0' });
      await page.type('input[name="username"]', MOCK_ADMIN.email);
      await page.type('input[name="password"]', MOCK_ADMIN.password);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => undefined), page.keyboard.press('Enter')]);
      await page.goto(`${web}/chat`, { waitUntil: 'networkidle0' });
      // a chat with a conversation in it, on the computer
      if (shot.name === 'wide') { await page.locator('::-p-text(Refactor the router)').click(); }
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // the mock's made-up system pages have random names; they'd only distract here
      await page.evaluate(() => { for (const entry of document.querySelectorAll('.entry')) { if (/^[a-z]{16,}$/.test(entry.textContent.trim())) { entry.closest('li')?.remove(); } } });
      await page.screenshot({ path: join(dir, `${shot.name}.png`) });
      console.info('app.images.written', { file: join(dir, `${shot.name}.png`) });
      await context.close();
    }
  } finally {
    await server.close();
    await hub.stop();
  }
}

const browser = await puppeteer.launch({ headless: true });
try {
  if (settings.HARNESS_APP_IMAGES_ONLY !== 'screenshots') { await icons(browser); }
  if (settings.HARNESS_APP_IMAGES_ONLY !== 'icons') { await screenshots(browser); }
} finally {
  await browser.close();
}
