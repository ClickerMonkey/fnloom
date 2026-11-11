/**
 * Boots the stack once for the whole e2e run (unless `HARNESS_E2E_URL` points at one already running): hub, fs,
 * embedder, the database fleet (`main`, a new SQLite file, and `shop`, an existing one with the fixture shop), and the
 * web system when `TAVILY_API_KEY` is set. Hands its URL and admin account to the tests through
 * vitest's `provide`. The data folder starts empty each run, so the suite is
 * repeatable. Process output goes to `<data>/stack.log`.
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { liveModels } from '@harness/sdk/server/testing';
import BetterSqlite3 from 'better-sqlite3';
import type { TestProject } from 'vitest/node';
import { fsConfig, ROOT, startStack, type Stack } from '../scripts/stack.ts';
import { SHOP_SQL } from '../systems/database/server/fixture.ts';
import type { DatabaseConfig } from '../systems/database/shared/shapes.ts';
import { e2eEnv } from './env.ts';

/** What both e2e databases share: writable, schema changes allowed, not enriched, for everyone. */
const E2E_DATABASE: Pick<DatabaseConfig, 'data' | 'schema' | 'enrich' | 'audience'> = { data: 'read-write', schema: 'allowed', enrich: { on: false }, audience: { visibility: 'public', with: [] } };

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
  mkdirSync(data, { recursive: true });
  const shop = join(data, 'shop.db');
  const db = new BetterSqlite3(shop);
  db.exec(SHOP_SQL);
  db.close();
  const log = join(data, 'stack.log');
  stack = await startStack({
    port: settings.HARNESS_E2E_PORT, data, admin: credentials, build: false, watch: false,
    only: new Set(['hub', 'fs', 'embedder', 'database', ...(settings.TAVILY_API_KEY === undefined ? [] : ['web-system'] as const)]),
    systems: {
      fs: fsConfig(ROOT), embedder: { url: settings.HARNESS_E2E_EMBEDDER },
      databases: {
        main: { ...E2E_DATABASE, label: 'Scratch', connection: { kind: 'sqlite-new', path: 'scratch.db' } },
        shop: { ...E2E_DATABASE, label: 'Shop', connection: { kind: 'sqlite-file', path: shop } },
      },
    },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: liveModels()[0] ?? '' },
    output: (component, line) => { appendFileSync(log, `${component.padEnd(9)} ${line}\n`); },
  });
  project.provide('e2eHub', { url: stack.url, ...credentials });
}

export async function teardown(): Promise<void> {
  await stack?.stop();
}
