/**
 * `npm run e2e:mock -w @harness/web`: build the web app, serve the build (`vite preview`, as the hub will serve it)
 * and the mock hub on their own ports, run every scenario against them, print each result, stop both, and exit
 * non-zero on any error or layout problem. Nothing else needs to be running. Ports come from `withMockEnv`.
 */
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import { build, preview } from 'vite';
import { z } from 'zod';
import { runScenarios } from './harness.ts';
import { serveMockHub } from './mockHub.ts';
import { scenarios } from './scenarios/index.ts';

const withMockEnv = env({
  HARNESS_E2E_HUB_PORT: z.number().int().default(4351),
  HARNESS_E2E_WEB_PORT: z.number().int().default(4352),
});
const settings = withMockEnv.parse();
const hubUrl = `http://127.0.0.1:${settings.HARNESS_E2E_HUB_PORT}`;
const webUrl = `http://127.0.0.1:${settings.HARNESS_E2E_WEB_PORT}`;

const root = fileURLToPath(new URL('..', import.meta.url));
await build({ root, logLevel: 'warn' });
const hub = serveMockHub(settings.HARNESS_E2E_HUB_PORT, { needsAdmin: false, notifyEvery: 0, logEvery: 2_000 });
const web = await preview({
  root,
  logLevel: 'warn',
  preview: {
    host: '0.0.0.0', port: settings.HARNESS_E2E_WEB_PORT, strictPort: true,
    proxy: { '/api': { target: hubUrl, changeOrigin: true }, '/ws': { target: hubUrl.replace('http', 'ws'), ws: true } },
  },
});

let failed = 0;
try {
  const results = await runScenarios(scenarios, { url: webUrl });
  for (const result of results) {
    const bad = result.error !== undefined || result.problems.length > 0;
    if (bad) { failed++; }
    console.info(bad ? 'e2e.failed' : 'e2e.passed', { scenario: result.scenario, viewport: result.viewport, theme: result.theme, error: result.error ?? null, problems: [...new Set(result.problems.map((p) => `${p.rule}: ${p.detail}`))] });
  }
  console.info('e2e.done', { runs: results.length, failed });
} finally {
  await web.close();
  await hub.stop();
}
process.exitCode = failed === 0 ? 0 : 1;
