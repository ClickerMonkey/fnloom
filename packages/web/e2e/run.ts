/**
 * `npm run e2e`: run every scenario against the app at `HARNESS_E2E_URL` (start it with `npm run dev`), print each
 * result, and exit non-zero on any error or layout problem. Screenshots are written to `packages/web/e2e/shots/`.
 */
import { runScenarios } from './harness.ts';
import { scenarios } from './scenarios/index.ts';

const results = await runScenarios(scenarios);
let failed = 0;
for (const result of results) {
  const bad = result.error !== undefined || result.problems.length > 0;
  if (bad) { failed++; }
  console.info(bad ? 'e2e.failed' : 'e2e.passed', { scenario: result.scenario, viewport: result.viewport, theme: result.theme, error: result.error ?? null, problems: result.problems.map((p) => `${p.rule}: ${p.detail}`) });
}
process.exitCode = failed === 0 ? 0 : 1;
