/**
 * `npx tsx ui-tests/mock.ts`: run the UI features against the web app's mock hub instead of a real stack. It builds
 * the web app, serves the build (`vite preview`, proxying `/api` and `/ws` as the hub would) beside the mock hub on
 * ports of their own, runs `ui-tests/run.ts` against them signed in as the mock's admin, stops both and exits with
 * the run's code. `HARNESS_UI_ONLY` and `HARNESS_UI_VIEWPORTS` pass through. Nothing else needs to be running.
 *
 *   HARNESS_UI_ONLY=context-graph,viewers npx tsx ui-tests/mock.ts
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import { build, preview } from 'vite';
import { z } from 'zod';
import { MOCK_ADMIN, serveMockHub } from '../packages/web/e2e/mockHub.ts';

/** The ports the mock run uses (the web lane's range, clear of the owner's stack). */
const mockRunEnv = env({
  HARNESS_UI_MOCK_HUB_PORT: z.number().int().default(4481),
  HARNESS_UI_MOCK_WEB_PORT: z.number().int().default(4480),
  /** Skip the web build and serve the `dist` already there. */
  HARNESS_UI_MOCK_NO_BUILD: z.boolean().default(false),
});
const settings = mockRunEnv.parse();
const hubUrl = `http://127.0.0.1:${settings.HARNESS_UI_MOCK_HUB_PORT}`;
const webUrl = `http://127.0.0.1:${settings.HARNESS_UI_MOCK_WEB_PORT}`;
const web = fileURLToPath(new URL('../packages/web/', import.meta.url));
const runner = fileURLToPath(new URL('./run.ts', import.meta.url));

if (!settings.HARNESS_UI_MOCK_NO_BUILD) { await build({ root: web, logLevel: 'warn' }); }
const hub = serveMockHub(settings.HARNESS_UI_MOCK_HUB_PORT, { needsAdmin: false, notifyEvery: 0, logEvery: 0 });
const server = await preview({
  root: web,
  logLevel: 'warn',
  preview: {
    host: '0.0.0.0', port: settings.HARNESS_UI_MOCK_WEB_PORT, strictPort: true,
    proxy: { '/api': { target: hubUrl, changeOrigin: true }, '/ws': { target: hubUrl.replace('http', 'ws'), ws: true } },
  },
});
console.info('ui.mock', { web: webUrl, hub: hubUrl });

try {
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', runner], {
      stdio: 'inherit',
      env: { ...process.env, HARNESS_UI_URL: webUrl, HARNESS_UI_EMAIL: MOCK_ADMIN.email, HARNESS_UI_PASSWORD: MOCK_ADMIN.password },
    });
    child.on('exit', (exit) => { resolve(exit ?? 1); });
  });
  process.exitCode = code;
} finally {
  await server.close();
  await hub.stop();
}
