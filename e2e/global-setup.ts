/**
 * Boots the stack once for the whole e2e run (unless `HARNESS_E2E_URL` points at one already running) and hands its
 * URL and admin account to the tests through vitest's `provide`. The data folder starts empty each run, so the suite is
 * repeatable. Process output goes to `<data>/stack.log`.
 */
import { appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { liveModels } from '@harness/sdk/server/testing';
import type { TestProject } from 'vitest/node';
import { fsConfig, ROOT, startStack, type Stack } from '../scripts/stack.ts';
import { e2eEnv } from './env.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The hub under test and its admin account. */
    e2eHub: { url: string; email: string; password: string };
  }
}

let stack: Stack | undefined;

export async function setup(project: TestProject): Promise<void> {
  const settings = e2eEnv.parse();
  const credentials = { email: settings.HARNESS_E2E_EMAIL, password: settings.HARNESS_E2E_PASSWORD };
  if (settings.HARNESS_E2E_URL !== undefined) {
    project.provide('e2eHub', { url: settings.HARNESS_E2E_URL, ...credentials });
    return;
  }
  const data = resolve(ROOT, settings.HARNESS_E2E_DATA);
  rmSync(data, { recursive: true, force: true });
  const log = join(data, 'stack.log');
  stack = await startStack({
    port: settings.HARNESS_E2E_PORT, data, admin: credentials, build: false, watch: false,
    only: new Set(['hub', 'fs', 'embedder']), systems: { fs: fsConfig(ROOT), embedder: {} },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: liveModels()[0] ?? '' },
    output: (component, line) => { appendFileSync(log, `${component.padEnd(9)} ${line}\n`); },
  });
  project.provide('e2eHub', { url: stack.url, ...credentials });
}

export async function teardown(): Promise<void> {
  await stack?.stop();
}
