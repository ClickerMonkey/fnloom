/**
 * Tests. Three projects:
 * - `unit`: every package's `*.test.ts` in Node, with injected seams and no live network.
 * - `web`: the Vue app's `*.test.ts` in happy-dom.
 * - `live`: `*.live.test.ts`, which call real services (OpenRouter with `OPENROUTER_API_KEY`, GPT-6 Luna; the local
 *   embedder). They are skipped by `npm test`; run them with `npm run test:live`.
 * - `e2e`: `e2e/*.e2e.test.ts`, the whole stack booted by `e2e/global-setup.ts` with GPT-6 Luna; `npm run e2e`.
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
          include: ['packages/{core,sdk,hub,cli,build}/src/**/*.test.ts', 'systems/*/{shared,server}/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [live, '**/node_modules/**'],
          // a file's first test pays for its imports' transform; under coverage on a full parallel run that can pass 5 s
          testTimeout: 20_000,
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['packages/web/src/**/*.test.ts', 'systems/*/client/**/*.test.ts'],
          exclude: [live, '**/node_modules/**'],
          // the first test in a file that mounts App.vue pays for vite's transform of a lazy route's whole tree (and
          // coverage instrumentation under `npm run check`); on a full parallel run that can pass the 5 s default
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'live',
          environment: 'node',
          include: [live],
          // `.harness-test` holds scratch copies of the repo; their tests are not this checkout's
          exclude: ['**/node_modules/**', '.harness-test/**'],
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
      // process entry points only wire the real parts together and start them; the e2e suite runs them. The kit's real
      // model and preview shots need OpenRouter and Chrome, so `kit.live.test.ts` runs them; fs's shots script is a CLI.
      exclude: ['**/*.test.ts', '**/manifest.gen.ts', '**/*.d.ts', 'systems/*/server/main.ts', 'systems/fs/server/manifest-probe.ts', 'packages/cli/src/main.ts', 'packages/cli/src/io.ts',
        'packages/sdk/src/testing/openrouter.ts', 'packages/sdk/src/testing/preview.ts', 'systems/fs/client/preview/shots.ts'],
      // floors a little under today's numbers, so coverage can't quietly fall; `npm run check` runs with coverage.
      // Each glob counts every file it matches (so `packages/hub/src/**` includes execution); the execution engine, the
      // SDK runtime and build 2's modules (the contextor, hub MCPs, resources, the CLI, the web system) have floors of
      // their own, so a drop there can't hide behind the rest of their package.
      thresholds: {
        statements: 84, branches: 73, functions: 78, lines: 88,
        'packages/core/src/**': { statements: 99, branches: 88, functions: 99, lines: 99 },
        'packages/hub/src/**': { statements: 91, branches: 82, functions: 90, lines: 94 },
        'packages/hub/src/execution/**': { statements: 86, branches: 74, functions: 85, lines: 91 },
        'packages/hub/src/contextor/**': { statements: 90, branches: 80, functions: 89, lines: 93 },
        'packages/hub/src/mcp/**': { statements: 88, branches: 78, functions: 88, lines: 94 },
        'packages/hub/src/resources/**': { statements: 90, branches: 78, functions: 88, lines: 92 },
        'packages/cli/src/**': { statements: 87, branches: 76, functions: 79, lines: 90 },
        'packages/sdk/src/**': { statements: 88, branches: 80, functions: 88, lines: 92 },
        'packages/sdk/src/server/**': { statements: 87, branches: 78, functions: 87, lines: 92 },
        'packages/web/src/**': { statements: 76, branches: 65, functions: 67, lines: 80 },
        'systems/embedder/**': { statements: 85, branches: 79, functions: 79, lines: 86 },
        'systems/fs/**': { statements: 86, branches: 81, functions: 86, lines: 87 },
        'systems/web/**': { statements: 83, branches: 85, functions: 79, lines: 85 },
      },
    },
  },
});
