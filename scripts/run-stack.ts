/**
 * Running the whole stack from the command line, shared by `npm run dev` (from source, watched) and `npm run live`
 * (a pinned build, unwatched): the settings from the environment or `.env`, which processes run, their output
 * prefixed and coloured per process, and Ctrl+C stopping them all.
 */
import { env, mergeEnvs } from '@ayepi/env';
import { loadEnv } from '@ayepi/env/load';
import { HUB_PORT } from '@harness/core';
import { z } from 'zod';
import { COMPONENTS, devEnv } from './dev-env.ts';
import { fsConfig, ROOT, startStack, type ComponentName, type StackOptions } from './stack.ts';

/** What the stack needs of the hub's settings; the admin account is required here, since the script signs in as it. */
const stackEnv = env({
  ...HUB_PORT,
  HARNESS_DATA: z.string().default('.harness'),
  HARNESS_ADMIN_EMAIL: z.email(),
  HARNESS_ADMIN_PASSWORD: z.string().min(8),
});

/** Every setting the scripts read: the stack's and the dev tunables. */
const scriptEnv = mergeEnvs(stackEnv, devEnv);

/** The parsed settings. */
export type StackSettings = ReturnType<typeof scriptEnv.parse>;

/** The stack's settings: the environment over `.env`. */
export function stackSettings(): StackSettings {
  scriptEnv.set({ ...loadEnv({ files: ['.env'] }), ...process.env });
  return scriptEnv.parse();
}

/** The database the stack pairs when asked: a new SQLite file in its data folder, writable, its schema changeable. */
const DEV_DATABASE = {
  label: 'Dev database', connection: { kind: 'sqlite-new', path: 'dev.db' }, data: 'read-write', schema: 'allowed', enrich: { on: false },
  audience: { visibility: 'private', with: [] },
} as const satisfies NonNullable<StackOptions['systems']['databases']>[string];

const COLOURS = { web: 36, hub: 35, fs: 33, embedder: 32, 'web-system': 34, input: 94, widgets: 92, code: 93, calendar: 95, database: 96, claude: 91 } as const satisfies Record<ComponentName, number>;
const isComponent = (name: string): name is ComponentName => COMPONENTS.some((c) => c === name);

/** How this run differs: dev builds the web app and watches the source; live runs a pinned build and watches nothing. */
export interface RunMode {
  /** The name its log lines start with (`dev.ready`, `live.ready`). */
  readonly name: 'dev' | 'live';
  readonly watch: boolean;
  /** The bundled hub and built web app to run (live); absent: the web app is built and the hub runs from source. */
  readonly pinned?: StackOptions['pinned'];
}

/** Start the stack the settings describe, and stop it on Ctrl+C or SIGTERM. */
export async function runStack(mode: RunMode, settings: StackSettings = stackSettings()): Promise<void> {
  const only = new Set(settings.HARNESS_DEV_ONLY.split(',').map((s) => s.trim()).filter(isComponent));
  // the web system searches with Tavily; without a key every search would fail, so it isn't started
  if (settings.TAVILY_API_KEY === undefined && only.delete('web-system')) { console.info(`${mode.name}.web-system.skipped`, { reason: 'TAVILY_API_KEY is not set' }); }
  // the calendar connects people through an OAuth client; without one it can't, so it isn't started
  const google = settings.GOOGLE_CLIENT_ID === undefined || settings.GOOGLE_CLIENT_SECRET === undefined ? undefined : { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET };
  if (google === undefined && only.delete('calendar')) { console.info(`${mode.name}.calendar.skipped`, { reason: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set' }); }

  const stack = await startStack({
    port: settings.HARNESS_PORT,
    data: settings.HARNESS_DATA,
    admin: { email: settings.HARNESS_ADMIN_EMAIL, password: settings.HARNESS_ADMIN_PASSWORD },
    build: mode.pinned === undefined,
    watch: mode.watch,
    ...(mode.pinned === undefined ? {} : { pinned: mode.pinned }),
    only,
    timeout: settings.HARNESS_DEV_START_TIMEOUT,
    restart: { delay: settings.HARNESS_DEV_RESTART_DELAY, every: settings.HARNESS_DEV_CHECK_EVERY, misses: settings.HARNESS_DEV_CHECK_MISSES },
    systems: {
      fs: fsConfig(settings.HARNESS_DEV_ROOT ?? ROOT), embedder: { url: settings.HARNESS_EMBEDDER_URL },
      ...(google === undefined ? {} : { calendar: { ...google, hubUrl: `http://127.0.0.1:${settings.HARNESS_PORT}` } }),
      ...(only.has('database') ? { databases: { main: DEV_DATABASE } } : {}),
    },
    output: (component, line, stream) => {
      (stream === 'err' ? process.stderr : process.stdout).write(`\u001b[${COLOURS[component]}m${component.padEnd(9)}\u001b[0m ${line}\n`);
    },
  });
  console.info(`${mode.name}.ready`, { local: stack.url, network: stack.lanUrls, data: settings.HARNESS_DATA, admin: settings.HARNESS_ADMIN_EMAIL });

  let stopping = false;
  const stop = (): void => {
    if (stopping) { return; }
    stopping = true;
    stack.stop().finally(() => { process.exit(0); }).catch(() => undefined);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
