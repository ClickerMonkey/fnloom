/**
 * The fs system's process: builds the implementation with the real shell, git, file manager, snapshots and watcher,
 * builds its renderers into its cache folder, then serves both to the hub. Its undo snapshots are its data (kept
 * across upgrades and exported with it); its data and cache folders come from the SDK's `placeFolders`, the same
 * ones `ctx.dataDir` and `ctx.cacheDir` give. The systems it hosts (`install_system`) are built with `@harness/build` and
 * run as its children under the SDK's shared supervision, each known to be connected by its own status lines. `npm run dev` starts it; `restart` restarts it through the running
 * system, which builds the renderers again so changes to them go live too.
 */
import { existsSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFiles, ViteBuilder } from '@harness/build';
import { SystemName } from '@harness/core';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { AllowlistProxy, CrashPolicy, RESTART_CODE, endpointOf, loggedHost, placeFolders, rendererFolder, scrubbedEnv, serve, type RunningSystem } from '@harness/sdk/server';
import { SNAPSHOT_DEFAULTS, fs } from '../shared/index.ts';
import { CommandChanges } from './changes.ts';
import { AeyeDocuments } from './documents.ts';
import { fsEnv } from './env.ts';
import { CliGit } from './git.ts';
import { HarnessBuilds } from './builds.ts';
import { Hosting } from './hosting.ts';
import { tsxLoader } from './loader.ts';
import { createFsImpl } from './impl.ts';
import type { Restarter, WatchFolder } from './index.ts';
import { PlatformOpener } from './reveal.ts';
import { GitIgnores } from './sensitive.ts';
import { SupervisedRunner, hostedStarter } from './runner.ts';
import { platformProbe } from './stale.ts';
import { ProcessSystemTests } from './tests.ts';
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

// a folder's own tests run under the loader fs runs under (tsx), whose packages they may read; a hosted system's
// built bundle runs on plain node (`hostedStarter`: a loader's worker is refused under the permission model)
const loader = tsxLoader(import.meta.url);
const hosting = new Hosting({
  builds: new HarnessBuilds({ builder: new ViteBuilder({ probeTimeout: settings.FS_HOSTED_PROBE_TIMEOUT, probeEnv: scrubbedEnv(process.env) }), files: new NodeFiles(), readParallel: settings.FS_READ_PARALLEL }),
  runner: new SupervisedRunner({
    starter: hostedStarter(process.env, settings.FS_HOSTED_OUTPUT_TAIL),
    policy: new CrashPolicy({ maxWait: settings.FS_HOSTED_BACKOFF_MAX, restartCode: RESTART_CODE }),
    restart: { policy: 'on-failure', backoff: settings.FS_HOSTED_BACKOFF, maxPerHour: settings.FS_HOSTED_CRASHES_PER_HOUR },
    reads: [],
    every: settings.FS_HOSTED_CHECK_EVERY,
    wait: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    now: () => Date.now(),
    log: (key, fields) => { log.info(key, fields); },
    gate: (allow, refused) => new AllowlistProxy({ allow, onRefused: refused }),
    // the hub link goes direct, never through a hosted system's proxy
    direct: [endpointOf(settings.HARNESS_HUB)],
    refused: (refusal) => {
      running.reportRefusal(refusal).catch((error: unknown) => { log.warn('fs.hosted.refusal-unsent', { system: refusal.instance.system, rule: refusal.rule, error: error instanceof Error ? error.message : String(error) }); });
    },
  }),
  // a folder's own tests run in a sandboxed child before its install card is shown
  tests: new ProcessSystemTests({ nodeArgs: loader.nodeArgs, baseEnv: process.env, timeout: settings.FS_TESTS_TIMEOUT }),
  hubUrl: settings.HARNESS_HUB,
  host: { system: SystemName.parse(fs.name), instance: settings.HARNESS_INSTANCE },
  dataDir,
  probe: platformProbe(exec, process.platform, settings.FS_HOSTED_STALE_TIMEOUT),
  onStale: (key, outcome) => { if ('failed' in outcome) { log.warn('fs.hosted.stale-failed', { key, error: outcome.failed }); } else if (outcome.killed) { log.info('fs.hosted.stale-killed', { key, pid: outcome.pid }); } },
  limits: {
    connectTimeout: settings.FS_HOSTED_CONNECT_TIMEOUT, problems: settings.FS_HOSTED_PROBLEMS, outputTail: settings.FS_HOSTED_OUTPUT_TAIL,
    renameTries: settings.FS_HOSTED_RENAME_TRIES, renameWait: settings.FS_HOSTED_RENAME_WAIT,
  },
});

// change capture and gitignore checks read whole statuses and diffs, so their git keeps more output than a command's
const gitExec = new NodeExec({ outputMax: settings.FS_GIT_OUTPUT_MAX, progressEvery: settings.FS_PROGRESS_EVERY });
const ignores = new GitIgnores(gitExec, settings.FS_GIT_WORK_TIMEOUT);
const changes = new CommandChanges({
  exec: gitExec,
  ignores,
  watch: watchFolder,
  now: () => Date.now(),
  limits: {
    maxFiles: settings.FS_CHANGES_MAX_FILES, diffMaxBytes: settings.FS_DIFF_MAX_BYTES, diffTotalBytes: settings.FS_CHANGES_DIFF_TOTAL,
    gitTimeout: settings.FS_GIT_WORK_TIMEOUT, settle: settings.FS_CHANGES_SETTLE, ignore: settings.FS_IGNORE, scratch: join(cacheDir, 'changes'),
  },
});

const server = createFsImpl({
  settings,
  shell: new NodeShell(shell, processLimits),
  git: new CliGit(exec, settings.FS_GIT_TIMEOUT),
  opener: new PlatformOpener(exec, process.platform, settings.FS_REVEAL_TIMEOUT),
  // pruned by the limits in the config fs runs with; saves happen only in runs, once `server` is set
  snapshots: new DiskSnapshots(join(dataDir, 'snapshots'), () => server.config().snapshots ?? SNAPSHOT_DEFAULTS),
  documents: new AeyeDocuments(createDefaultResourceRegistry()),
  restarter,
  watch: watchFolder,
  changes,
  ignores,
  hosting,
  grantPairing: (request) => running.grantPairing(request),
  now: () => Date.now(),
  baseEnv: process.env,
});

// a packed fs runs the bundle built beside it; from source the renderers are built on every start
const started = performance.now();
const clientFolder = await rendererFolder({ main: import.meta.url, outDir: join(cacheDir, 'client') });
log.info('fs.client.ready', { folder: clientFolder, took: Math.round(performance.now() - started) });

log.info('fs.serving', { hub: settings.HARNESS_HUB, shell: shell.type === 'posix' ? shell.path : 'system' });
// its own folder (the one with system.json and context/: systems/fs from source, dist/ when packed), wherever it was
// started from, so every instance sends the same context folder
const running: RunningSystem<'fs'> = await serve(fs, server.impl, {
  package: dirname(dirname(fileURLToPath(import.meta.url))),
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
