/**
 * The fs system's process: builds the implementation with the real shell, git, file manager, snapshots and watcher,
 * builds its renderers into its cache folder, then serves both to the hub. Its undo snapshots are its data (kept
 * across upgrades and exported with it); its data and cache folders come from the SDK's `placeFolders`, the same
 * ones `ctx.dataDir` and `ctx.cacheDir` give. `npm run dev` starts it; `restart` restarts it through the running
 * system, which builds the renderers again so changes to them go live too.
 */
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { loggedHost, placeFolders, rendererFolder, serve, type RunningSystem } from '@harness/sdk/server';
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
const { dataDir, cacheDir } = placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
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

// a packed fs runs the bundle built beside it; from source the renderers are built on every start
const started = performance.now();
const clientFolder = await rendererFolder({ main: import.meta.url, outDir: join(cacheDir, 'client') });
log.info('fs.client.ready', { folder: clientFolder, took: Math.round(performance.now() - started) });

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
