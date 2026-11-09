/**
 * `npm run dev`: builds the web app, then runs the hub (serving that build), the fs system (with this repository as
 * its root), the embedder and input systems, the web system when `TAVILY_API_KEY` is set and the calendar system when
 * `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are, all bound to the LAN and
 * restarting when their source changes. Output is prefixed and coloured per process; Ctrl+C stops them all. Settings
 * come from the environment or `.env`:
 *
 *   HARNESS_ADMIN_EMAIL / HARNESS_ADMIN_PASSWORD   the single admin account (required; made on first start)
 *   HARNESS_PORT       hub and web app port (default 4300)
 *   HARNESS_DATA       data folder (default .harness)
 *   HARNESS_DEV_ONLY   comma list of what to run: web (the build), hub, fs, embedder, web-system, input, calendar (default all)
 *   HARNESS_DEV_ROOT   the folder fs serves (default this repository)
 *   HARNESS_EMBEDDER_URL  the EmbeddingGemma service (default http://127.0.0.1:8760)
 *   TAVILY_API_KEY     the web system's search key; without it the web system doesn't run
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   the calendar's OAuth client; without them it doesn't run
 *
 * For the web app with hot reload instead of a build, run `npm run dev:web` beside it (Vite on HARNESS_WEB_PORT).
 */
import { env, mergeEnvs } from '@ayepi/env';
import { loadEnv } from '@ayepi/env/load';
import { HUB_PORT } from '@harness/core';
import { z } from 'zod';
import { COMPONENTS, devEnv } from './dev-env.ts';
import { fsConfig, ROOT, startStack, type ComponentName } from './stack.ts';

/** What the stack needs of the hub's settings; the admin account is required here, since dev signs in as it. */
const stackEnv = env({
  ...HUB_PORT,
  HARNESS_DATA: z.string().default('.harness'),
  HARNESS_ADMIN_EMAIL: z.email(),
  HARNESS_ADMIN_PASSWORD: z.string().min(10),
});
const devSettings = mergeEnvs(stackEnv, devEnv);
devSettings.set({ ...loadEnv({ files: ['.env'] }), ...process.env });
const settings = devSettings.parse();

const COLOURS = { web: 36, hub: 35, fs: 33, embedder: 32, 'web-system': 34, input: 94, calendar: 95 } as const satisfies Record<ComponentName, number>;
const isComponent = (name: string): name is ComponentName => COMPONENTS.some((c) => c === name);

const only = new Set(settings.HARNESS_DEV_ONLY.split(',').map((s) => s.trim()).filter(isComponent));
// the web system searches with Tavily; without a key every search would fail, so it isn't started
if (settings.TAVILY_API_KEY === undefined && only.delete('web-system')) { console.info('dev.web-system.skipped', { reason: 'TAVILY_API_KEY is not set' }); }
// the calendar connects people through an OAuth client; without one it can't, so it isn't started
const google = settings.GOOGLE_CLIENT_ID === undefined || settings.GOOGLE_CLIENT_SECRET === undefined ? undefined : { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET };
if (google === undefined && only.delete('calendar')) { console.info('dev.calendar.skipped', { reason: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set' }); }

const stack = await startStack({
  port: settings.HARNESS_PORT,
  data: settings.HARNESS_DATA,
  admin: { email: settings.HARNESS_ADMIN_EMAIL, password: settings.HARNESS_ADMIN_PASSWORD },
  build: true,
  watch: true,
  only,
  systems: {
    fs: fsConfig(settings.HARNESS_DEV_ROOT ?? ROOT), embedder: { url: settings.HARNESS_EMBEDDER_URL },
    ...(google === undefined ? {} : { calendar: { ...google, hubUrl: `http://127.0.0.1:${settings.HARNESS_PORT}` } }),
  },
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
