/**
 * The tunables only `npm run dev` reads (beside the hub's own, which the hub process reads itself): what to run, the
 * folder fs serves, the EmbeddingGemma service, and the Tavily key the web system needs to run.
 * `scripts/env-example.ts` lists them in `.env.example`.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';
import type { ComponentName } from './stack.ts';

/** Every process `npm run dev` can run. */
export const COMPONENTS = ['web', 'hub', 'fs', 'embedder', 'web-system', 'input', 'widgets', 'code', 'calendar', 'database', 'claude'] as const satisfies readonly ComponentName[];

/** What runs when `HARNESS_DEV_ONLY` isn't set: everything but the database, which runs only when asked. */
const DEFAULT_COMPONENTS = COMPONENTS.filter((component) => component !== 'database');

/** What `npm run dev` runs, and with what. */
export const devEnv = env({
  HARNESS_DEV_ONLY: z.string().default(DEFAULT_COMPONENTS.join(',')).describe('npm run dev: a comma list of what to run (web, the build; hub; fs; embedder; web-system, which runs only with TAVILY_API_KEY; input; widgets; code, fns written as programs; claude, Claude Code sessions in the folders beside this repository; calendar, which runs only with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; database, a new SQLite file, only when listed).'),
  HARNESS_DEV_RESTART_DELAY: z.coerce.number().int().min(0).default(3_000).describe('npm run dev: how long to wait before restarting a crashed hub or system (ms).'),
  HARNESS_DEV_CHECK_EVERY: z.coerce.number().int().min(500).default(5_000).describe('npm run dev: how often to check that the hub and each system still answer (ms).'),
  HARNESS_DEV_START_TIMEOUT: z.coerce.number().int().min(1_000).default(60_000).describe('npm run dev: how long to wait for the hub and each system to start and connect (ms); raise it on a busy machine.'),
  HARNESS_DEV_CHECK_MISSES: z.coerce.number().int().min(1).default(6).describe('npm run dev: restart a process after this many checks in a row it did not answer.'),
  HARNESS_DEV_ROOT: z.string().optional().describe('npm run dev: the folder the fs system serves; this repository when not given.'),
  HARNESS_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760').describe('npm run dev: the EmbeddingGemma service the embedder system wraps.'),
  TAVILY_API_KEY: z.string().min(1).optional().describe('npm run dev: the Tavily key the web system searches with; without it the web system is not started.'),
  GOOGLE_CLIENT_ID: z.string().min(1).optional().describe('npm run dev: the Google OAuth client (a Web application client) the calendar system connects people with; without it the calendar system is not started.'),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional().describe('npm run dev: the secret of that Google OAuth client.'),
});
