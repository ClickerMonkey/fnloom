/**
 * `npm run preview:shots -w @harness/system-fs`: serve the preview page with Vite, shoot each renderer section at
 * phone, tablet and desktop sizes in light and dark into `client/preview/shots/`, and check the web app's layout rules
 * (no page overflow, no overlapping or off-screen controls). Exits non-zero on any problem. Also clicks "Run again"
 * and opens a diff fold, so those states are shot too.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import vue from '@vitejs/plugin-vue';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { z } from 'zod';
import { THEMES, VIEWPORTS, VIEWPORT_NAMES, layoutProblems, type LayoutProblem } from '../../../../packages/web/e2e/harness.ts';

const previewEnv = env({
  /** The port the preview is served on while shooting. */
  FS_PREVIEW_PORT: z.number().int().min(1).default(4381),
  FS_PREVIEW_HEADLESS: z.boolean().default(true),
});
const settings = previewEnv.parse();
const root = fileURLToPath(new URL('.', import.meta.url));
const shots = fileURLToPath(new URL('./shots/', import.meta.url));
const SECTIONS = ['bash', 'diff', 'input'] as const;

await mkdir(shots, { recursive: true });
const server = await createServer({ root, configFile: false, plugins: [vue()], logLevel: 'warn', server: { host: '0.0.0.0', port: settings.FS_PREVIEW_PORT, strictPort: true } });
await server.listen();
const browser = await puppeteer.launch({ headless: settings.FS_PREVIEW_HEADLESS });
let failed = 0;
try {
  for (const section of SECTIONS) {
    for (const viewport of VIEWPORT_NAMES) {
      for (const theme of THEMES) {
        const page = await browser.newPage();
        // tsx keeps function names with a `__name` helper, which code passed to page.evaluate would call in the browser
        await page.evaluateOnNewDocument('globalThis.__name = (fn) => fn;');
        await page.setViewport(VIEWPORTS[viewport]);
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.goto(`http://127.0.0.1:${settings.FS_PREVIEW_PORT}/?only=${section}`, { waitUntil: 'networkidle0' });
        const problems: LayoutProblem[] = [];
        const shoot = async (step: string) => {
          await page.screenshot({ path: `${shots}${section}-${step}-${viewport}-${theme}.png`, fullPage: true });
          problems.push(...await layoutProblems(page));
        };
        await shoot('start');
        if (section === 'bash') {
          await page.click('.bash .action.primary');
          await shoot('rerun');
        }
        if (section === 'diff') {
          await page.click('.diff .fold');
          await shoot('opened');
        }
        const errors = problems.map((p) => `${p.rule}: ${p.detail}`);
        if (errors.length > 0) { failed += 1; }
        console.info(errors.length > 0 ? 'preview.failed' : 'preview.passed', { section, viewport, theme, problems: errors });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exitCode = failed === 0 ? 0 : 1;
