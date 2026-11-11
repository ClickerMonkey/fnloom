/**
 * The fs system's process: builds the implementation with the real shell, git, file manager, snapshots and watcher,
 * builds its renderers into its cache folder, then serves both to the hub. Its undo snapshots are its data (kept
 * across upgrades and exported with it); its data and cache folders come from the SDK's `placeFolders`, the same
 * ones `ctx.dataDir` and `ctx.cacheDir` give. The systems it hosts (`install_system`) are built with `@harness/build` and
 * run as its children under the SDK's shared supervision, each found in the hub through fs's own search. `npm run dev` starts it; `restart` restarts it through the running
 * system, which builds the renderers again so changes to them go live too.
 */
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { NodeFiles, ViteBuilder } from '@harness/build';
import { SystemName } from '@harness/core';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { CrashPolicy, NodeStarter, RESTART_CODE, loggedHost, placeFolders, rendererFolder, scrubbedEnv, serve, type RunningSystem } from '@harness/sdk/server';
import { fs } from '../shared/index.ts';
import { AeyeDocuments } from './documents.ts';
import { fsEnv } from './env.ts';
import { CliGit } from './git.ts';
import { HarnessBuilds } from './builds.ts';
import { Hosting } from './hosting.ts';
import { tsxLoader } from './loader.ts';
import { createFsImpl } from './impl.ts';
import type { Restarter, WatchFolder } from './index.ts';
import { PlatformOpener } from './reveal.ts';
import { SupervisedRunner, type ConnectProbe } from './runner.ts';
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

// a hosted system is there once the hub lists its fns: usable (connected), or held back waiting for its config. Not
// filtered by instance: that filter finds a fleet instance's own fns (saved queries), not the contract's.
const probe: ConnectProbe = async (key) => {
  const name = SystemName.safeParse(key.split('/')[0]);
  if (!name.success) { return undefined; }
  const page = await running.searchFns({ systems: [name.data], available: false, limit: 20 });
  if (page.items.some((hit) => hit.available)) { return 'connected'; }
  return page.items.some((hit) => /config/i.test(hit.unavailable ?? '')) ? 'needs-config' : undefined;
};
// the hosted systems run under the loader fs runs under (tsx), whose packages they may read
const loader = tsxLoader(import.meta.url);
const hosting = new Hosting({
  builds: new HarnessBuilds({ builder: new ViteBuilder(), files: new NodeFiles(), probeTimeout: settings.FS_HOSTED_PROBE_TIMEOUT, probeEnv: scrubbedEnv(process.env) }),
  runner: new SupervisedRunner({
    starter: new NodeStarter({ baseEnv: process.env, nodeArgs: loader.nodeArgs, outputTail: settings.FS_HOSTED_OUTPUT_TAIL }),
    policy: new CrashPolicy({ maxWait: settings.FS_HOSTED_BACKOFF_MAX, restartCode: RESTART_CODE }),
    restart: { policy: 'on-failure', backoff: settings.FS_HOSTED_BACKOFF, maxPerHour: settings.FS_HOSTED_CRASHES_PER_HOUR },
    reads: loader.reads,
    probe,
    every: settings.FS_HOSTED_CHECK_EVERY,
    wait: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    now: () => Date.now(),
    log: (key, fields) => { log.info(key, fields); },
  }),
  hubUrl: settings.HARNESS_HUB,
  host: { system: SystemName.parse(fs.name), instance: settings.HARNESS_INSTANCE },
  dataDir,
  limits: { connectTimeout: settings.FS_HOSTED_CONNECT_TIMEOUT, problems: settings.FS_HOSTED_PROBLEMS, outputTail: settings.FS_HOSTED_OUTPUT_TAIL },
});

const server = createFsImpl({
  settings,
  shell: new NodeShell(shell, processLimits),
  git: new CliGit(exec, settings.FS_GIT_TIMEOUT),
  opener: new PlatformOpener(exec, process.platform, settings.FS_REVEAL_TIMEOUT),
  snapshots: new DiskSnapshots(join(dataDir, 'snapshots')),
  documents: new AeyeDocuments(createDefaultResourceRegistry()),
  restarter,
  watch: watchFolder,
  hosting,
  grantPairing: (request) => running.grantPairing(request),
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
