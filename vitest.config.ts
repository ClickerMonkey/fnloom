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
          include: ['packages/{core,sdk,hub,cli}/src/**/*.test.ts', 'systems/*/{shared,server}/**/*.test.ts', 'scripts/**/*.test.ts'],
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
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,vue}', 'systems/*/{shared,server,client}/**/*.{ts,vue}'],
      exclude: ['**/*.test.ts', '**/manifest.gen.ts', '**/*.d.ts'],
      // floors a little under today's numbers, so coverage can't quietly fall; `npm run check` runs with coverage.
      // Each glob counts every file it matches (so `packages/hub/src/**` includes execution); the execution engine and
      // the SDK runtime have floors of their own, so a drop there can't hide behind the rest of their package.
      thresholds: {
        statements: 82, branches: 70, functions: 76, lines: 86,
        'packages/core/src/**': { statements: 99, branches: 88, functions: 99, lines: 99 },
        'packages/hub/src/**': { statements: 90, branches: 80, functions: 89, lines: 93 },
        'packages/hub/src/execution/**': { statements: 86, branches: 74, functions: 85, lines: 91 },
        'packages/sdk/src/**': { statements: 88, branches: 80, functions: 88, lines: 92 },
        'packages/sdk/src/server/**': { statements: 87, branches: 78, functions: 87, lines: 92 },
        'packages/web/src/**': { statements: 70, branches: 61, functions: 61, lines: 75 },
        'systems/embedder/**': { statements: 85, branches: 79, functions: 79, lines: 86 },
        'systems/fs/**': { statements: 86, branches: 81, functions: 86, lines: 87 },
      },
    },
  },
});
