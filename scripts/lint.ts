/**
 * `npm run lint`: ESLint over the whole repository, one area at a time (each workspace, then `scripts`, `e2e`,
 * `ui-tests` and the root config), each in a process of its own. Type-aware rules load a TypeScript program per
 * project, and the whole tree in one process runs out of memory; one area at a time keeps each small and lets the
 * memory go between them. Extra arguments go to every run (`npm run lint -- --fix`). Exits 1 when any area has
 * problems.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './stack.ts';

/** The workspaces, read from the root `package.json` (the one list of them). */
const Workspaces = z.object({ workspaces: z.array(z.string()) });
const workspaces = Workspaces.parse(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))).workspaces;

/** What is linted, in order: every workspace, then the code outside them. */
export const LINT_AREAS: readonly string[] = [...workspaces, 'scripts', 'e2e', 'ui-tests', 'vitest.config.ts'];

/** The heap each area's ESLint gets, in MB. */
const HEAP_MB = 6_144;

const eslint = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const extra = process.argv.slice(2);
const failed: string[] = [];
for (const area of LINT_AREAS) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, eslint, area, ...extra], { cwd: ROOT, stdio: 'inherit' });
  const took = Math.round(performance.now() - started);
  if (run.status !== 0) { failed.push(area); }
  console.info('lint.area', { area, ok: run.status === 0, took });
}
if (failed.length > 0) {
  console.error('lint.failed', { areas: failed });
  process.exit(1);
}
