/**
 * Tests. Three projects:
 * - `unit`: every package's `*.test.ts` in Node, with injected seams and no live network.
 * - `web`: the Vue app's `*.test.ts` in happy-dom.
 * - `live`: `*.live.test.ts`, which call real services (OpenRouter with `OPENROUTER_API_KEY`, a free model; the local
 *   embedder). They are skipped by `npm test`; run them with `npm run test:live`.
 * - `e2e`: `e2e/*.e2e.test.ts`, the whole stack booted by `e2e/global-setup.ts` with a free model; `npm run e2e`.
 */
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

const live = '**/*.live.test.ts';
const e2e = 'e2e/**/*.e2e.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/{core,sdk,hub}/src/**/*.test.ts', 'systems/*/{shared,server}/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [live, '**/node_modules/**'],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['packages/web/src/**/*.test.ts', 'systems/*/client/**/*.test.ts'],
          exclude: [live, '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'live',
          environment: 'node',
          include: [live],
          exclude: ['**/node_modules/**'],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: [e2e],
          globalSetup: ['e2e/global-setup.ts'],
          // one shared stack and session: files and tests run in order
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 300_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: { provider: 'v8', include: ['packages/*/src/**', 'systems/*/{shared,server,client}/**'], exclude: ['**/*.test.ts', '**/manifest.gen.ts'] },
  },
});
