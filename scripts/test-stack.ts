/**
 * `npm run test:stack`: a development stack with the test account and the fixture databases the e2e suite uses, kept
 * running until Ctrl+C. Unlike `npm run e2e` it keeps its data between runs (`HARNESS_TEST_DATA`, default
 * `.harness-test/dev`), and the fixture databases are only created when missing. Settings come from the environment:
 *
 *   HARNESS_TEST_PORT       the hub's port (default 4340)
 *   HARNESS_TEST_DATA       the data folder (default .harness-test/dev)
 *   HARNESS_TEST_EMAIL / HARNESS_TEST_PASSWORD   the test account (default e2e@harness.local / e2e-admin-password),
 *                           made on first start; it is the hub's admin
 *   HARNESS_TEST_EMBEDDER   the EmbeddingGemma service (default http://127.0.0.1:8760)
 */
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env } from '@ayepi/env';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { fsConfig, ROOT, startStack } from './stack.ts';
import { PROJECTS_SQL, SHOP_SQL } from '../systems/database/server/fixture.ts';
import type { DatabaseConfig } from '../systems/database/shared/shapes.ts';

const testEnv = env({
  HARNESS_TEST_PORT: z.coerce.number().int().min(4301).max(65535).default(4340),
  HARNESS_TEST_DATA: z.string().default('.harness-test/dev'),
  HARNESS_TEST_EMAIL: z.email().default('e2e@harness.local'),
  HARNESS_TEST_PASSWORD: z.string().min(10).default('e2e-admin-password'),
  HARNESS_TEST_EMBEDDER: z.string().default('http://127.0.0.1:8760'),
});

/** The same database settings the e2e suite gives its fixtures: writable, schema changes allowed, for everyone. */
const TEST_DATABASE: Pick<DatabaseConfig, 'data' | 'schema' | 'enrich' | 'audience'> = {
  data: 'read-write', schema: 'allowed', enrich: { on: false }, audience: { visibility: 'public', with: [] },
};

const settings = testEnv.parse();
const data = resolve(ROOT, settings.HARNESS_TEST_DATA);
mkdirSync(data, { recursive: true });

/** Create a fixture database once; later runs keep whatever the developer changed in it. */
const seed = (name: string, sql: string): string => {
  const file = join(data, name);
  if (!existsSync(file)) {
    const db = new BetterSqlite3(file);
    db.exec(sql);
    db.close();
  }
  return file;
};
const shop = seed('shop.db', SHOP_SQL);
const work = seed('work.db', PROJECTS_SQL);
const log = join(data, 'stack.log');

const stack = await startStack({
  port: settings.HARNESS_TEST_PORT,
  data,
  admin: { email: settings.HARNESS_TEST_EMAIL, password: settings.HARNESS_TEST_PASSWORD },
  build: true,
  watch: false,
  only: new Set(['hub', 'fs', 'embedder', 'database', 'input']),
  systems: {
    fs: fsConfig(ROOT),
    embedder: { url: settings.HARNESS_TEST_EMBEDDER },
    databases: {
      main: { ...TEST_DATABASE, label: 'Scratch', connection: { kind: 'sqlite-new', path: 'scratch.db' } },
      shop: { ...TEST_DATABASE, label: 'Shop', connection: { kind: 'sqlite-file', path: shop } },
      work: { ...TEST_DATABASE, label: 'Projects', connection: { kind: 'sqlite-file', path: work } },
    },
  },
  hubEnv: { HARNESS_LOG_FILES: 'false' },
  output: (component, line) => { appendFileSync(log, `${component.padEnd(9)} ${line}\n`); },
});

console.log(`test stack ready\n  local: ${stack.url}\n  network: ${stack.lanUrls.join(', ') || '(none)'}\n  account: ${settings.HARNESS_TEST_EMAIL} / ${settings.HARNESS_TEST_PASSWORD}\n  data: ${data}\n  log: ${log}`);

const shutdown = async (): Promise<void> => {
  await stack.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await new Promise(() => undefined);
