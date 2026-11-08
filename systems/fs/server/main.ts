/**
 * The fs system's process: builds the implementation with the real shell, git, file manager, snapshots and watcher,
 * builds its renderers into its cache folder, then serves both to the hub. Its undo snapshots are its data (kept
 * across upgrades and exported with it); a hub that runs it says where its data and cache folders are. `npm run dev` starts it; `restart` restarts it
 * through the running system, which builds the renderers again so changes to them go live too.
 */
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { loggedHost, serve, type RunningSystem } from '@harness/sdk/server';
import { fs } from '../shared/index.ts';
import { AeyeDocuments } from './documents.ts';
import { fsEnv } from './env.ts';
import { CliGit } from './git.ts';
import { createFsImpl } from './impl.ts';
import type { Restarter, WatchFolder } from './index.ts';
import { PlatformOpener } from './reveal.ts';
import { NodeExec, NodeShell, chooseShell } from './shell.ts';
import { DiskSnapshots } from './snapshots.ts';

const settings = fsEnv.parse();
const dataDir = settings.HARNESS_SYSTEM_DATA ?? join(settings.HARNESS_SYSTEM_STATE, 'data');
const cacheDir = settings.HARNESS_SYSTEM_CACHE ?? join(settings.HARNESS_SYSTEM_STATE, 'cache');
const { host, log } = loggedHost(fs.name);
const processLimits = { outputMax: settings.FS_OUTPUT_MAX, progressEvery: settings.FS_PROGRESS_EVERY };
const exec = new NodeExec(processLimits);
const shell = chooseShell(settings.FS_SHELL, process.platform, existsSync);

// `restart` is only called by a run, so `running` is set by then
const restarter: Restarter = {
  schedule(reason) {
    setTimeout(() => {
      running.restart(reason).catch((error: unknown) => { log.error('fs.restart.failed', { reason }, error); });
    }, settings.FS_RESTART_DELAY);
  },
};

const watchFolder: WatchFolder = (folder, listener) => {
  const watcher = watch(folder, { recursive: true }, (event, file) => { if (file !== null) { listener(event, file); } });
  watcher.on('error', (error) => { log.warn('fs.watch.failed', { folder, error: error.message }); });
  return () => { watcher.close(); };
};

const server = createFsImpl({
  settings,
  shell: new NodeShell(shell, processLimits),
  git: new CliGit(exec, settings.FS_GIT_TIMEOUT),
  opener: new PlatformOpener(exec, process.platform, settings.FS_REVEAL_TIMEOUT),
  snapshots: new DiskSnapshots(join(dataDir, 'snapshots')),
  documents: new AeyeDocuments(createDefaultResourceRegistry()),
  restarter,
  watch: watchFolder,
  now: () => Date.now(),
});

/**
 * Where the renderers are: a packed fs (`harness system pack`) runs the bundle built beside it; from source they are
 * built on every start, so a restart after editing them uploads the new bundle. The build tools load only then.
 */
async function renderers(): Promise<string> {
  const packed = fileURLToPath(new URL('../client/', import.meta.url));
  if (existsSync(join(packed, 'index.js'))) { return packed; }
  const folder = join(cacheDir, 'client');
  const started = performance.now();
  const { buildClient } = await import('@harness/sdk/build');
  await buildClient({ entry: fileURLToPath(new URL('../client/index.ts', import.meta.url)), outDir: folder });
  log.info('fs.client.built', { folder, took: Math.round(performance.now() - started) });
  return folder;
}
const clientFolder = await renderers();

log.info('fs.serving', { hub: settings.HARNESS_HUB, shell: shell.type === 'posix' ? shell.path : 'system' });
const running: RunningSystem<'fs'> = await serve(fs, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('fs.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
