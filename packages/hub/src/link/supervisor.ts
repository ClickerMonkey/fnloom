/**
 * Installed instances. A system's package is kept under the hub's data folder in `<systems>/<name>/versions/<version>`
 * (shared by its instances); each instance has its own `<systems>/<name>/instances/<instance>/{state,data,cache}`
 * outside the package, so upgrades and rollbacks keep them: `state` holds the key pair the hub made at install and
 * the SDK's journal, `data` is the system's own (`ctx.dataDir`), `cache` is rebuildable. Instances start with the
 * hub and are restarted when they exit unexpectedly: after `backoff`, doubling with each crash in the last hour,
 * until `maxPerHour` crashes. An instance that exits with the restart code asked for a restart (its `restart` fn, or
 * the hub's): it is started again at once and that doesn't count as a crash. Then an instance that has a last good
 * version (the last one that connected) rolls back to it; one that doesn't is disabled until an admin starts it.
 * Stopping asks over the link first, then ends the process.
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { reject as refuse } from '@ayepi/core';
import { backoff } from '@ayepi/core/retry';
import type { Logger } from '@ayepi/log';
import { RESTART_CODE, SYSTEM_ENV } from '@harness/sdk/server';
import {
  MAIN_INSTANCE, instanceLabel, type ActorId, type InstallSource, type InstalledSystem, type InstanceDirs, type InstanceName, type InstanceRecord, type InstanceRef,
  type Json, type StopReason, type SystemName,
} from '@harness/core';
import { allRows } from '../catalog/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { StoreConfigService } from './config.ts';
import type { LinkService, PairingService, Supervisor } from './index.ts';
import { KEY_FILE, makeKeyPair, randomToken } from './keys.ts';
import type { Installer, ProcessExit, ProcessLauncher, SystemPackage, SystemProcess } from './process.ts';
import type { InstanceKeeper } from './status.ts';

/** An hour, the window crashes are counted in. */
const HOUR = 3_600_000;
/** The longest wait between restarts. */
const MAX_BACKOFF = 300_000;

/** Supervisor tunables (from the link env slice). */
export interface SupervisorSettings {
  /** Where installed systems live. */
  readonly systemsDir: string;
  /** The link URL systems connect to (`ws://host:port/link`). */
  readonly hubLink: string;
  /** How long a system gets to stop before its process is ended. */
  readonly stopTimeout: number;
  /** The first wait before a restart. */
  readonly backoff: number;
  /** Crashes in an hour before giving up (or rolling back). */
  readonly perHour: number;
}

/** What the supervisor needs. */
export interface SupervisorOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly clock: () => number;
  readonly links: LinkService;
  readonly pairing: PairingService;
  readonly config: StoreConfigService;
  readonly instances: InstanceKeeper;
  readonly launcher: ProcessLauncher;
  readonly installer: Installer;
  readonly settings: SupervisorSettings;
}

/** One running process. */
interface Running {
  readonly process: SystemProcess;
  /** Settles once the exit has been handled (status written, restart started), so a stop can wait for all of it. */
  readonly handled: Promise<void>;
  stopping: boolean;
}

/** An installed instance's ref. */
function refOf(installed: Pick<InstalledSystem, 'name' | 'instance'>): InstanceRef {
  return { system: installed.name, instance: installed.instance };
}

/** Starts, watches and restarts installed instances. */
export class ProcessSupervisor implements Supervisor {
  readonly #options: SupervisorOptions;
  /** By `system@instance`. */
  readonly #running = new Map<string, Running>();
  readonly #crashes = new Map<string, number[]>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: SupervisorOptions) {
    this.#options = options;
    options.links.onChange((change) => {
      if (change.connected && this.#running.has(instanceLabel(change))) { void this.#connected(change); }
    });
  }

  /** A system's folder (absolute, since each process runs in its own package folder). */
  dirOf(system: SystemName): string {
    return resolve(this.#options.settings.systemsDir, system);
  }

  /** An instance's state, data and cache folders. */
  dirsOf(ref: InstanceRef): InstanceDirs {
    const base = join(this.dirOf(ref.system), 'instances', ref.instance);
    return { state: join(base, 'state'), data: join(base, 'data'), cache: join(base, 'cache') };
  }

  /**
   * Install an instance. A system already installed takes a new instance only when its package allows a fleet
   * (`instances: 'many'`); the same instance twice is refused (upgrade is `upgrade`). The package is fetched into a
   * staging folder, placed under `versions/<version>` (a version another instance already runs is shared), and the
   * instance gets its folders and a key the hub made, is paired, has its config preset, and starts.
   */
  async install(input: { source: InstallSource; config?: Json; autoStart?: boolean; instance?: InstanceName; by: ActorId }): Promise<InstalledSystem> {
    const { instances, pairing, config, settings, clock, log } = this.#options;
    const fetched = await this.#fetch(input.source);
    const name = fetched.pkg.manifest.name;
    const ref: InstanceRef = { system: name, instance: input.instance ?? MAIN_INSTANCE };
    const installed = (await instances.of(name)).filter((i) => i.installed !== undefined && i.status !== 'removed');
    const refusal = installed.some((i) => i.instance === ref.instance) ? refuse(409, 'ALREADY_INSTALLED', `${instanceLabel(ref)} is already installed`)
      : installed.length > 0 && fetched.pkg.manifest.instances === 'one' ? refuse(409, 'ONE_INSTANCE', `${name} runs one instance, and it is installed`)
        : undefined;
    if (refusal !== undefined) {
      await fetched.discard();
      throw refusal;
    }
    const pkg = await fetched.place();
    const dirs = this.dirsOf(ref);
    for (const folder of Object.values(dirs)) { await mkdir(folder, { recursive: true }); }
    const keys = makeKeyPair();
    await writeFile(join(dirs.state, KEY_FILE), JSON.stringify(keys), { mode: 0o600 });
    await pairing.pairInstalled(ref, keys.publicKey, pkg.manifest.version, input.by);
    const entry: InstalledSystem = {
      name, instance: ref.instance, source: input.source, dir: this.dirOf(name), command: this.#command(pkg, ref, dirs), version: pkg.manifest.version,
      autoStart: input.autoStart ?? true, restart: { policy: 'on-failure', backoff: settings.backoff, maxPerHour: settings.perHour },
      status: 'stopped', installedBy: input.by, installedAt: clock(),
    };
    await instances.sync(ref, { installed: entry, dirs, version: pkg.manifest.version });
    if (input.config !== undefined) { config.preset(ref, input.config, input.by); }
    log.info('supervisor.installed', { system: name, instance: ref.instance, version: pkg.manifest.version, by: input.by });
    if (entry.autoStart) { await this.start(name, ref.instance); }
    return (await this.#installed(ref)) ?? entry;
  }

  async start(system: SystemName, instance?: InstanceName): Promise<void> {
    for (const installed of await this.#targets(system, instance)) { await this.#start(installed); }
  }

  async stop(system: SystemName, reason: StopReason, instance?: InstanceName): Promise<void> {
    const targets = instance === undefined ? await this.#targets(system).catch(() => []) : [];
    const refs: InstanceRef[] = instance === undefined ? targets.map(refOf) : [{ system, instance }];
    await Promise.all(refs.map((ref) => this.#stop(ref, reason)));
  }

  async upgrade(system: SystemName, version?: string): Promise<{ from: string; to: string }> {
    const targets = await this.#targets(system);
    const first = targets[0];
    if (first === undefined) { throw refuse(404, 'NOT_INSTALLED', `${system} is not installed`); }
    const source: InstallSource = 'package' in first.source ? { ...first.source, version: version ?? 'latest' }
      : 'git' in first.source ? { ...first.source, ref: version ?? first.source.ref }
        : first.source;
    return this.upgradeTo(system, source);
  }

  /** Move every installed instance of a system to the package a source names (a new zip, a new npm version). */
  async upgradeTo(system: SystemName, source: InstallSource): Promise<{ from: string; to: string }> {
    const targets = await this.#targets(system);
    const first = targets[0];
    if (first === undefined) { throw refuse(404, 'NOT_INSTALLED', `${system} is not installed`); }
    const fetched = await this.#fetch(source);
    if (fetched.pkg.manifest.name !== system) {
      await fetched.discard();
      throw refuse(422, 'WRONG_SYSTEM', `the new version is ${fetched.pkg.manifest.name}, not ${system}`);
    }
    const pkg = await fetched.place();
    for (const installed of targets) {
      const ref = refOf(installed);
      const wasRunning = this.#running.has(instanceLabel(ref));
      await this.#stop(ref, 'upgrade');
      await this.#update(ref, { source, version: pkg.manifest.version, command: this.#command(pkg, ref, this.dirsOf(ref)) });
      this.#crashes.delete(instanceLabel(ref));
      this.#options.log.info('supervisor.upgraded', { system, instance: ref.instance, from: installed.version, to: pkg.manifest.version });
      if (wasRunning || installed.autoStart) { await this.#start({ ...installed, command: this.#command(pkg, ref, this.dirsOf(ref)) }); }
    }
    return { from: first.version, to: pkg.manifest.version };
  }

  async uninstall(system: SystemName, instance?: InstanceName): Promise<void> {
    const targets = await this.#targets(system, instance);
    for (const installed of targets) {
      const ref = refOf(installed);
      await this.#stop(ref, 'removed');
      await this.#options.instances.sync(ref, (record) => {
        const { installed: _gone, ...rest } = record;
        return { ...rest, status: 'removed' };
      });
      this.#crashes.delete(instanceLabel(ref));
      this.#options.log.info('supervisor.uninstalled', { system, instance: ref.instance });
    }
    // the package goes with the last installed instance; data folders stay, so the data can still be exported
    const left = (await this.list()).filter((i) => i.name === system);
    const first = targets[0];
    if (left.length === 0 && first !== undefined && !('path' in first.source)) { await rm(join(first.dir, 'versions'), { recursive: true, force: true }); }
  }

  async startAll(): Promise<void> {
    const ready = (await this.list()).filter((s) => s.autoStart && s.status !== 'disabled');
    await Promise.allSettled(ready.map((s) => this.#start(s)));
  }

  async stopAll(reason: StopReason): Promise<void> {
    const running = (await this.list()).filter((s) => this.#running.has(instanceLabel(refOf(s))));
    await Promise.allSettled(running.map((s) => this.#stop(refOf(s), reason)));
    for (const key of [...this.#timers.keys()]) { this.#clearTimer(key); }
  }

  async list(): Promise<InstalledSystem[]> {
    return (await allRows(this.#options.store.table('instances'))).flatMap((r) => (r.installed === undefined ? [] : [r.installed]));
  }

  // ─── Starting and stopping one instance ─────────────────────────────────────

  async #start(installed: InstalledSystem): Promise<void> {
    const ref = refOf(installed);
    const key = instanceLabel(ref);
    this.#clearTimer(key);
    if (this.#running.has(key)) { return; }
    if (installed.status === 'disabled') { this.#crashes.delete(key); }
    const process = this.#options.launcher.launch(installed.command);
    const handled = process.exited.then((exit) => this.#exited(ref, exit)).catch((error: unknown) => {
      this.#options.log.error('supervisor.exit.failed', { system: ref.system, instance: ref.instance, error: messageOf(error) });
    });
    this.#running.set(key, { process, handled, stopping: false });
    await this.#update(ref, { status: 'starting', ...(process.pid === undefined ? {} : { pid: process.pid }) });
    this.#options.log.info('supervisor.started', { system: ref.system, instance: ref.instance, version: installed.version, pid: process.pid });
  }

  async #stop(ref: InstanceRef, reason: StopReason): Promise<void> {
    const { links, settings, log } = this.#options;
    const key = instanceLabel(ref);
    this.#clearTimer(key);
    const running = this.#running.get(key);
    if (running === undefined) {
      if ((await this.#installed(ref)) !== undefined) { await this.#update(ref, { status: 'stopped' }); }
      return;
    }
    running.stopping = true;
    const connection = links.connection(ref.system, ref.instance);
    if (connection !== undefined) {
      try {
        await connection.peer.call('stop', { reason, timeout: settings.stopTimeout }, { signal: AbortSignal.timeout(settings.stopTimeout) });
      } catch (error) {
        log.warn('supervisor.stop.ask.failed', { system: ref.system, instance: ref.instance, reason, error: messageOf(error) });
      }
    }
    const wait = new AbortController();
    const timedOut = Symbol('timeout');
    const ended = await Promise.race([running.process.exited, delay(settings.stopTimeout, wait.signal).then(() => timedOut)]);
    wait.abort();
    if (ended === timedOut) {
      log.warn('supervisor.stop.killed', { system: ref.system, instance: ref.instance, reason });
      running.process.kill();
    }
    await running.handled;
  }

  // ─── Exits, restarts and roll backs ─────────────────────────────────────────

  /** A started instance connected: this version starts cleanly. */
  async #connected(ref: InstanceRef): Promise<void> {
    const installed = await this.#installed(ref);
    if (installed === undefined) { return; }
    await this.#update(ref, { status: 'running', goodVersion: installed.version });
  }

  async #exited(ref: InstanceRef, exit: ProcessExit): Promise<void> {
    const { clock, log } = this.#options;
    const key = instanceLabel(ref);
    const running = this.#running.get(key);
    this.#running.delete(key);
    const installed = await this.#installed(ref);
    if (installed === undefined) { return; }
    const lastExit = { code: exit.code, at: clock(), output: exit.output };
    const fields = { system: ref.system, instance: ref.instance, version: installed.version };
    if (running?.stopping !== false) {
      await this.#update(ref, { status: 'stopped', lastExit });
      return;
    }
    if (exit.code === RESTART_CODE) {
      log.info('supervisor.restarting', fields);
      await this.#update(ref, { status: 'starting', lastExit });
      await this.#start(installed);
      return;
    }
    const { policy } = installed.restart;
    if (policy === 'never' || (policy === 'on-failure' && exit.code === 0)) {
      await this.#update(ref, { status: exit.code === 0 ? 'stopped' : 'crashed', lastExit });
      return;
    }
    const now = clock();
    const crashes = [...(this.#crashes.get(key) ?? []).filter((at) => at > now - HOUR), now];
    this.#crashes.set(key, crashes);
    log.warn('supervisor.crashed', { ...fields, code: exit.code, crashes: crashes.length });
    if (crashes.length > installed.restart.maxPerHour) {
      await this.#giveUp(ref, installed, lastExit);
      return;
    }
    await this.#update(ref, { status: 'crashed', lastExit });
    const wait = backoff(crashes.length, { base: installed.restart.backoff, max: MAX_BACKOFF, jitter: 0 });
    this.#timers.set(key, setTimeout(() => {
      this.#timers.delete(key);
      this.start(ref.system, ref.instance).catch((error: unknown) => { log.error('supervisor.restart.failed', { ...fields, error: messageOf(error) }); });
    }, wait));
  }

  /** Too many crashes: roll back to the last good version if there is one, else stop trying. */
  async #giveUp(ref: InstanceRef, installed: InstalledSystem, lastExit: NonNullable<InstalledSystem['lastExit']>): Promise<void> {
    const { log, installer } = this.#options;
    const good = installed.goodVersion;
    if (good !== undefined && good !== installed.version && !('path' in installed.source)) {
      const pkg = await installer.describe(this.#versionDir(ref.system, good));
      const command = this.#command(pkg, ref, this.dirsOf(ref));
      await this.#update(ref, { version: good, command, status: 'crashed', lastExit });
      this.#crashes.delete(instanceLabel(ref));
      log.error('supervisor.rolled.back', { system: ref.system, instance: ref.instance, from: installed.version, to: good });
      await this.#start({ ...installed, version: good, command });
      return;
    }
    await this.#update(ref, { status: 'disabled', lastExit });
    log.error('supervisor.gave.up', { system: ref.system, instance: ref.instance, version: installed.version, crashes: installed.restart.maxPerHour + 1 });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  #versionDir(system: SystemName, version: string): string {
    return join(this.dirOf(system), 'versions', version);
  }

  /**
   * Fetch a source into a staging folder. `place` moves it to its version folder (a folder source stays where it is;
   * a version already there is kept, since another instance may run it); `discard` drops it.
   */
  async #fetch(source: InstallSource): Promise<{ pkg: SystemPackage; place: () => Promise<SystemPackage>; discard: () => Promise<void> }> {
    const { installer, settings } = this.#options;
    const staging = resolve(settings.systemsDir, `.staging-${randomToken(6)}`);
    const discard = () => rm(staging, { recursive: true, force: true });
    let pkg: SystemPackage;
    try {
      pkg = await installer.fetch(source, staging);
    } catch (error) {
      await discard();
      throw refuse(422, 'INSTALL_FAILED', `could not fetch the system: ${messageOf(error)}`);
    }
    const place = async (): Promise<SystemPackage> => {
      if ('path' in source) { return pkg; }
      const target = this.#versionDir(pkg.manifest.name, pkg.manifest.version);
      if (await exists(target)) {
        await discard();
      } else {
        await mkdir(join(this.dirOf(pkg.manifest.name), 'versions'), { recursive: true });
        await rename(staging, target);
      }
      return installer.describe(join(target, pkg.dir.slice(staging.length)));
    };
    return { pkg, place, discard };
  }

  /** How to run an instance: Node on its server entry, told where its hub, name, instance and folders are. */
  #command(pkg: SystemPackage, ref: InstanceRef, dirs: InstanceDirs): InstalledSystem['command'] {
    return {
      run: process.execPath,
      args: [pkg.entry],
      env: {
        [SYSTEM_ENV.hub]: this.#options.settings.hubLink, [SYSTEM_ENV.name]: ref.system, [SYSTEM_ENV.instance]: ref.instance,
        [SYSTEM_ENV.state]: dirs.state, [SYSTEM_ENV.data]: dirs.data, [SYSTEM_ENV.cache]: dirs.cache,
        [SYSTEM_ENV.supervised]: 'true', [SYSTEM_ENV.restartCode]: String(RESTART_CODE),
      },
      cwd: pkg.dir,
    };
  }

  async #installed(ref: InstanceRef): Promise<InstalledSystem | undefined> {
    return (await this.#options.instances.get(ref))?.installed;
  }

  /** The installed instances of a system (one, when named); refused when there are none. */
  async #targets(system: SystemName, instance?: InstanceName): Promise<InstalledSystem[]> {
    const all = (await this.list()).filter((i) => i.name === system && (instance === undefined || i.instance === instance));
    if (all.length === 0) { throw refuse(404, 'NOT_INSTALLED', `${instance === undefined ? system : instanceLabel({ system, instance })} is not installed`); }
    return all;
  }

  /** Change an installed instance's entry on its row (through the keeper, so no write is lost); nothing once uninstalled. */
  #update(ref: InstanceRef, change: Partial<InstalledSystem>): Promise<InstanceRecord> {
    return this.#options.instances.sync(ref, (record) => (record.installed === undefined ? record : { ...record, installed: { ...record.installed, ...change } }));
  }

  #clearTimer(key: string): void {
    const timer = this.#timers.get(key);
    if (timer !== undefined) { clearTimeout(timer); }
    this.#timers.delete(key);
  }
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves after `ms`; aborting clears the timer (and leaves the promise pending, as nobody waits on it then). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
  });
}
