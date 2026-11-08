/**
 * The tunables only `npm run dev` reads (beside the hub's own, which the hub process reads itself): what to run, the
 * folder fs serves, the EmbeddingGemma service, and the Tavily key the web system needs to run.
 * `scripts/env-example.ts` lists them in `.env.example`.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';
import type { ComponentName } from './stack.ts';

/** Every process `npm run dev` can run. */
export const COMPONENTS = ['web', 'hub', 'fs', 'embedder', 'web-system'] as const satisfies readonly ComponentName[];

/** What `npm run dev` runs, and with what. */
export const devEnv = env({
  HARNESS_DEV_ONLY: z.string().default(COMPONENTS.join(',')).describe('npm run dev: a comma list of what to run (web, the build; hub; fs; embedder; web-system, which runs only with TAVILY_API_KEY).'),
  HARNESS_DEV_ROOT: z.string().optional().describe('npm run dev: the folder the fs system serves; this repository when not given.'),
  HARNESS_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760').describe('npm run dev: the EmbeddingGemma service the embedder system wraps.'),
  TAVILY_API_KEY: z.string().min(1).optional().describe('npm run dev: the Tavily key the web system searches with; without it the web system is not started.'),
});
