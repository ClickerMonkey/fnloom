/**
 * A system folder's own tests (the SDK test kit), run with vitest's node API and reported as a `SystemTestReport`:
 * every test with its status, time and first lines of failure, the `real` mark of tests that call a real model, and,
 * with `previews`, the component previews the tests shot. `harness test` prints it; fs's `install_system` puts it on
 * the install card (running `harness test --json` in a sandboxed process).
 */
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SystemTestReport, type PreviewShot, type TestCase } from '@harness/core';
import { PREVIEW_INDEX, PreviewIndex } from '@harness/sdk/build';
import type { BuildFiles } from './files.ts';
import { readSystemJson } from './folder.ts';
// the kit's `real` mark on vitest's TaskMeta
import type {} from '@harness/sdk/testing';

/** The most cases a report lists; the rest are counted in `more`. */
const MAX_CASES = 500;
/** The most previews a report lists. */
const MAX_PREVIEWS = 200;
/** The most characters of a failure kept. */
const MAX_ERROR = 4_000;
/** Where vitest looks for tests in a system folder. */
const TEST_FILES = ['**/*.test.ts'];
/** Where previews go by default, inside the system folder. */
export const PREVIEW_DIR = '.harness-test/previews';
const NOT_TESTS = ['**/node_modules/**', '**/dist/**', '**/.harness*/**'];
/** A folder's own vitest or vite config, which `harness test` uses instead of its defaults. */
const CONFIG_FILES = ['vitest.config.ts', 'vitest.config.mts', 'vite.config.ts', 'vite.config.mts'];

/** How to run a folder's tests. */
export interface TestRunOptions {
  /** Shoot the component previews (`HARNESS_PREVIEWS`) and add them to the report. */
  readonly previews?: boolean;
  /** Where previews and their gallery go (default `<dir>/.harness-test/previews`). */
  readonly previewDir?: string;
  /** Only test files whose path contains one of these. */
  readonly filters?: readonly string[];
}

/** Runs a system folder's tests. An interface so the CLI's tests use a fake. */
export interface SystemTestRunner {
  /** The folder's test report; `undefined` when it has no tests. */
  run(dir: string, options?: TestRunOptions): Promise<SystemTestReport | undefined>;
}

/** The real runner: vitest's node API over the disk. */
export class VitestRunner implements SystemTestRunner {
  readonly #files: BuildFiles;

  constructor(files: BuildFiles) {
    this.#files = files;
  }

  run(dir: string, options: TestRunOptions = {}): Promise<SystemTestReport | undefined> {
    return runSystemTests(dir, this.#files, options);
  }
}

/** A test error's message and first stack lines, cut short. */
function errorText(errors: readonly { message: string; stack?: string | undefined }[] | undefined): string | undefined {
  const first = errors?.[0];
  if (first === undefined) { return undefined; }
  const stack = (first.stack ?? '').split('\n').filter((line) => line.trim().startsWith('at ')).slice(0, 4).join('\n');
  return `${first.message}${stack === '' ? '' : `\n${stack}`}`.slice(0, MAX_ERROR);
}

/** Run a system folder's tests; `undefined` when it has none. */
export async function runSystemTests(dir: string, files: BuildFiles, options: TestRunOptions = {}): Promise<SystemTestReport | undefined> {
  const manifest = await readSystemJson(files, dir);
  const previewDir = options.previews === true ? options.previewDir ?? join(dir, PREVIEW_DIR) : undefined;
  const hasConfig = (await Promise.all(CONFIG_FILES.map((file) => files.stat(join(dir, file))))).some((stat) => stat !== undefined);
  const { createVitest } = await import('vitest/node');
  const plugins = hasConfig ? [] : [(await import('@vitejs/plugin-vue')).default()];
  const started = Date.now();
  const vitest = await createVitest({
    root: dir,
    watch: false,
    passWithNoTests: true,
    reporters: [],
    ...(hasConfig ? {} : { config: false, include: TEST_FILES, exclude: NOT_TESTS }),
    env: { HARNESS_PREVIEWS: options.previews === true ? 'true' : 'false', ...(previewDir === undefined ? {} : { HARNESS_PREVIEW_DIR: previewDir }) },
    // a named fs allow-list stops vite searching the folders above for a workspace root, which a sandboxed run
    // (fs's install checks, under Node's permission model) may not look at
  }, { plugins, server: { fs: { allow: [dir] } } });
  try {
    const specs = await vitest.globTestSpecifications(options.filters === undefined ? [] : [...options.filters]);
    if (specs.length === 0) { return undefined; }
    const run = await vitest.runTestSpecifications(specs, true);
    const cases: TestCase[] = [];
    for (const module of run.testModules) {
      const file = relative(dir, module.moduleId).replaceAll('\\', '/');
      const broken = errorText(module.errors());
      // a file that failed before its tests ran (an import or syntax error) is one failed case
      if (broken !== undefined) { cases.push({ file, name: '(the file)', status: 'failed', duration: 0, error: broken }); }
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === 'pending') { continue; }
        const error = result.state === 'failed' ? errorText(result.errors) : undefined;
        cases.push({
          file, name: test.fullName, status: result.state, duration: Math.round(test.diagnostic()?.duration ?? 0),
          ...(test.meta().real === true ? { real: true } : {}),
          ...(error === undefined ? {} : { error }),
        });
      }
    }
    const count = (status: TestCase['status']): number => cases.filter((c) => c.status === status).length;
    const ordered = [...cases.filter((c) => c.status === 'failed'), ...cases.filter((c) => c.status !== 'failed')];
    const previews = previewDir === undefined ? undefined : await readPreviews(previewDir);
    return SystemTestReport.parse({
      system: manifest.name, version: manifest.version, ranAt: started, duration: Date.now() - started,
      passed: count('passed'), failed: count('failed') + run.unhandledErrors.length, skipped: count('skipped'),
      cases: ordered.slice(0, MAX_CASES),
      ...(ordered.length > MAX_CASES ? { more: ordered.length - MAX_CASES } : {}),
      ...(previews === undefined ? {} : { previews: previews.slice(0, MAX_PREVIEWS) }),
    });
  } finally {
    await vitest.close();
  }
}

/** The previews a run shot, from the kit's index; none when it shot none. */
async function readPreviews(dir: string): Promise<PreviewShot[]> {
  const text = await readFile(join(dir, PREVIEW_INDEX), 'utf8').catch(() => undefined);
  return text === undefined ? [] : PreviewIndex.parse(JSON.parse(text)).shots;
}

