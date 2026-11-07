/**
 * `npm run dev`: builds the web app, then runs the hub (serving that build), the fs system (with this repository as
 * its root) and the embedder system, all bound to the LAN and restarting when their source changes. Output is
 * prefixed and coloured per process; Ctrl+C stops them all. Settings come from the environment or `.env`:
 *
 *   HARNESS_ADMIN_EMAIL / HARNESS_ADMIN_PASSWORD   the single admin account (required; made on first start)
 *   HARNESS_PORT       hub and web app port (default 4300)
 *   HARNESS_DATA       data folder (default .harness)
 *   HARNESS_DEV_ONLY   comma list of what to run: web (the build), hub, fs, embedder (default all)
 *   HARNESS_DEV_ROOT   the folder fs serves (default this repository)
 *   HARNESS_EMBEDDER_URL  the EmbeddingGemma service (default http://127.0.0.1:8760)
 *
 * For the web app with hot reload instead of a build, run `npm run dev:web` beside it (Vite on HARNESS_WEB_PORT).
 */
import { env } from '@ayepi/env';
import { loadEnv } from '@ayepi/env/load';
import { HUB_PORT } from '@harness/core';
import { z } from 'zod';
import { fsConfig, ROOT, startStack, type ComponentName } from './stack.ts';

for (const [key, value] of Object.entries(loadEnv({ files: ['.env'] }))) {
  process.env[key] ??= typeof value === 'string' ? value : JSON.stringify(value);
}

const COMPONENTS = ['web', 'hub', 'fs', 'embedder'] as const satisfies readonly ComponentName[];

const devEnv = env({
  ...HUB_PORT,
  HARNESS_DATA: z.string().default('.harness'),
  HARNESS_DEV_ONLY: z.string().default(COMPONENTS.join(',')),
  HARNESS_DEV_ROOT: z.string().default(ROOT),
  HARNESS_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760'),
  HARNESS_ADMIN_EMAIL: z.email(),
  HARNESS_ADMIN_PASSWORD: z.string().min(10),
});
const settings = devEnv.parse();

const COLOURS = { web: 36, hub: 35, fs: 33, embedder: 32 } as const satisfies Record<ComponentName, number>;
const isComponent = (name: string): name is ComponentName => COMPONENTS.some((c) => c === name);

const stack = await startStack({
  port: settings.HARNESS_PORT,
  data: settings.HARNESS_DATA,
  admin: { email: settings.HARNESS_ADMIN_EMAIL, password: settings.HARNESS_ADMIN_PASSWORD },
  build: true,
  watch: true,
  only: new Set(settings.HARNESS_DEV_ONLY.split(',').map((s) => s.trim()).filter(isComponent)),
  systems: { fs: fsConfig(settings.HARNESS_DEV_ROOT), embedder: { url: settings.HARNESS_EMBEDDER_URL } },
  output: (component, line, stream) => {
    (stream === 'err' ? process.stderr : process.stdout).write(`\u001b[${COLOURS[component]}m${component.padEnd(9)}\u001b[0m ${line}\n`);
  },
});
console.info('dev.ready', { local: stack.url, network: stack.lanUrls, data: settings.HARNESS_DATA, admin: settings.HARNESS_ADMIN_EMAIL });

let stopping = false;
const stop = (): void => {
  if (stopping) { return; }
  stopping = true;
  stack.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
