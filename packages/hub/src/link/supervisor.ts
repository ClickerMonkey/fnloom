/**
 * Installed systems: kept under the hub's data folder (`<systems>/<name>/versions/<version>`, its key pair and state
 * in `<systems>/<name>/state`), paired at install with a key the hub makes, started with the hub, and restarted
 * when they exit unexpectedly: after `backoff`, doubling with each crash in the last hour, until `maxPerHour`
 * crashes. Then a system that has a last good version (the last one that connected) rolls back to it; one that
 * doesn't is disabled until an admin starts it. Stopping asks over the link first, then ends the process.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { SYSTEM_ENV } from '@harness/sdk/server';
import type { ActorId, InstallSource, InstalledSystem, Json, StopReason, SystemName, SystemRecord } from '@harness/core';
import { allRows } from '../catalog/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { StoreConfigService } from './config.ts';
import type { LinkService, PairingService, Supervisor } from './index.ts';
import { KEY_FILE, makeKeyPair, randomToken } from './keys.ts';
import type { Installer, ProcessExit, ProcessLauncher, SystemPackage, SystemProcess } from './process.ts';
import type { SystemStatusKeeper } from './status.ts';

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
  readonly status: SystemStatusKeeper;
  readonly launcher: ProcessLauncher;
  readonly installer: Installer;
  readonly settings: SupervisorSettings;
}


/** One running process. */
interface Running {
  readonly process: SystemProcess;
  stopping: boolean;
}

/** Starts, watches and restarts installed systems. */
export class ProcessSupervisor implements Supervisor {
  readonly #options: SupervisorOptions;
  readonly #running = new Map<SystemName, Running>();
  readonly #crashes = new Map<SystemName, number[]>();
  readonly #timers = new Map<SystemName, ReturnType<typeof setTimeout>>();

  constructor(options: SupervisorOptions) {
    this.#options = options;
    options.links.onChange((change) => {
      if (change.connected && this.#running.has(change.system)) { void this.#connected(change.system); }
    });
  }

  /** A system's folder. */
  dirOf(system: SystemName): string {
    return join(this.#options.settings.systemsDir, system);
  }

  async install(input: { source: InstallSource; config?: Json; autoStart?: boolean; by: ActorId }): Promise<InstalledSystem> {
    const { installer, pairing, config, status, settings, clock, log } = this.#options;
    const staging = join(settings.systemsDir, `.staging-${randomToken(6)}`);
    let fetched: SystemPackage;
    try {
      fetched = await installer.fetch(input.source, staging);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw refuse(422, 'INSTALL_FAILED', `could not fetch the system: ${messageOf(error)}`);
    }
    const existing = await this.#options.store.table('systems').get(fetched.name);
    if (existing?.installed !== undefined) {
      await rm(staging, { recursive: true, force: true });
      throw refuse(409, 'ALREADY_INSTALLED', `${fetched.name} is already installed`);
    }
    const pkg = await this.#place(input.source, fetched, staging);
    const keys = makeKeyPair();
    await mkdir(this.#stateDir(pkg.name), { recursive: true });
    await writeFile(join(this.#stateDir(pkg.name), KEY_FILE), JSON.stringify(keys), { mode: 0o600 });
    await pairing.pairInstalled(pkg.name, keys.publicKey, input.by);
    const installed: InstalledSystem = {
      name: pkg.name,
      source: input.source,
      dir: this.dirOf(pkg.name),
      command: this.#command(pkg),
      version: pkg.version,
      autoStart: input.autoStart ?? true,
      restart: { policy: 'on-failure', backoff: settings.backoff, maxPerHour: settings.perHour },
      status: 'stopped',
      installedBy: input.by,
      installedAt: clock(),
    };
    await status.sync(pkg.name, { installed, version: pkg.version });
    if (input.config !== undefined) { config.preset(pkg.name, input.config, input.by); }
    log.info('supervisor.installed', { system: pkg.name, version: pkg.version, by: input.by });
    if (installed.autoStart) { await this.start(pkg.name); }
    return (await this.#installed(pkg.name)) ?? installed;
  }

  async start(system: SystemName): Promise<void> {
    const installed = await this.#require(system);
    this.#clearTimer(system);
    if (this.#running.has(system)) { return; }
    if (installed.status === 'disabled') { this.#crashes.delete(system); }
    const process = this.#options.launcher.launch(installed.command);
    this.#running.set(system, { process, stopping: false });
    await this.#update(system, { status: 'starting', ...(process.pid === undefined ? {} : { pid: process.pid }) });
    this.#options.log.info('supervisor.started', { system, version: installed.version, pid: process.pid });
    process.exited.then((exit) => this.#exited(system, exit)).catch((error: unknown) => {
      this.#options.log.error('supervisor.exit.failed', { system, error: messageOf(error) });
    });
  }

  async stop(system: SystemName, reason: StopReason): Promise<void> {
    const { links, settings, log } = this.#options;
    this.#clearTimer(system);
    const running = this.#running.get(system);
    if (running === undefined) {
      if ((await this.#installed(system)) !== undefined) { await this.#update(system, { status: 'stopped' }); }
      return;
    }
    running.stopping = true;
    const connection = links.connection(system);
    if (connection !== undefined) {
      try {
        await connection.peer.call('stop', { reason, timeout: settings.stopTimeout }, { signal: AbortSignal.timeout(settings.stopTimeout) });
      } catch (error) {
        log.warn('supervisor.stop.ask.failed', { system, reason, error: messageOf(error) });
      }
    }
    const wait = new AbortController();
    const timedOut = Symbol('timeout');
    const ended = await Promise.race([running.process.exited, delay(settings.stopTimeout, wait.signal).then(() => timedOut)]);
    wait.abort();
    if (ended === timedOut) {
      log.warn('supervisor.stop.killed', { system, reason });
      running.process.kill();
      await running.process.exited;
    }
  }

  async upgrade(system: SystemName, version?: string): Promise<{ from: string; to: string }> {
    const installed = await this.#require(system);
    const source: InstallSource = 'package' in installed.source ? { ...installed.source, version: version ?? 'latest' }
      : 'git' in installed.source ? { ...installed.source, ref: version ?? installed.source.ref }
        : installed.source;
    const staging = join(this.#options.settings.systemsDir, `.staging-${randomToken(6)}`);
    const fetched = await this.#options.installer.fetch(source, staging);
    if (fetched.name !== system) {
      await rm(staging, { recursive: true, force: true });
      throw refuse(422, 'WRONG_SYSTEM', `the new version is ${fetched.name}, not ${system}`);
    }
    const pkg = await this.#place(source, fetched, staging);
    const wasRunning = this.#running.has(system);
    await this.stop(system, 'upgrade');
    await this.#update(system, { source, version: pkg.version, command: this.#command(pkg) });
    this.#crashes.delete(system);
    this.#options.log.info('supervisor.upgraded', { system, from: installed.version, to: pkg.version });
    if (wasRunning || installed.autoStart) { await this.start(system); }
    return { from: installed.version, to: pkg.version };
  }

  async uninstall(system: SystemName): Promise<void> {
    const installed = await this.#require(system);
    await this.stop(system, 'removed');
    await this.#options.status.sync(system, (record) => {
      const { installed: _gone, ...rest } = record;
      return { ...rest, status: 'removed' };
    });
    await rm(installed.dir, { recursive: true, force: true });
    this.#crashes.delete(system);
    this.#options.log.info('supervisor.uninstalled', { system });
  }

  async startAll(): Promise<void> {
    const ready = (await this.list()).filter((s) => s.autoStart && s.status !== 'disabled');
    await Promise.allSettled(ready.map((s) => this.start(s.name)));
  }

  async stopAll(reason: StopReason): Promise<void> {
    await Promise.allSettled([...this.#running.keys()].map((system) => this.stop(system, reason)));
    for (const system of [...this.#timers.keys()]) { this.#clearTimer(system); }
  }

  async list(): Promise<InstalledSystem[]> {
    return (await allRows(this.#options.store.table('systems'))).flatMap((r) => (r.installed === undefined ? [] : [r.installed]));
  }

  // ─── Exits, restarts and roll backs ─────────────────────────────────────────

  /** A started system connected: this version starts cleanly. */
  async #connected(system: SystemName): Promise<void> {
    const installed = await this.#installed(system);
    if (installed === undefined) { return; }
    await this.#update(system, { status: 'running', goodVersion: installed.version });
  }

  async #exited(system: SystemName, exit: ProcessExit): Promise<void> {
    const { clock, log } = this.#options;
    const running = this.#running.get(system);
    this.#running.delete(system);
    const installed = await this.#installed(system);
    if (installed === undefined) { return; }
    const lastExit = { code: exit.code, at: clock(), output: exit.output };
    if (running?.stopping !== false) {
      await this.#update(system, { status: 'stopped', lastExit });
      return;
    }
    const { policy } = installed.restart;
    if (policy === 'never' || (policy === 'on-failure' && exit.code === 0)) {
      await this.#update(system, { status: exit.code === 0 ? 'stopped' : 'crashed', lastExit });
      return;
    }
    const now = clock();
    const crashes = [...(this.#crashes.get(system) ?? []).filter((at) => at > now - HOUR), now];
    this.#crashes.set(system, crashes);
    log.warn('supervisor.crashed', { system, version: installed.version, code: exit.code, crashes: crashes.length });
    if (crashes.length > installed.restart.maxPerHour) {
      await this.#giveUp(system, installed, lastExit);
      return;
    }
    await this.#update(system, { status: 'crashed', lastExit });
    const wait = Math.min(MAX_BACKOFF, installed.restart.backoff * 2 ** (crashes.length - 1));
    this.#timers.set(system, setTimeout(() => {
      this.#timers.delete(system);
      this.start(system).catch((error: unknown) => { log.error('supervisor.restart.failed', { system, error: messageOf(error) }); });
    }, wait));
  }

  /** Too many crashes: roll back to the last good version if there is one, else stop trying. */
  async #giveUp(system: SystemName, installed: InstalledSystem, lastExit: NonNullable<InstalledSystem['lastExit']>): Promise<void> {
    const { log, installer } = this.#options;
    const good = installed.goodVersion;
    if (good !== undefined && good !== installed.version && !('path' in installed.source)) {
      const pkg = await installer.describe(this.#versionDir(system, good));
      await this.#update(system, { version: good, command: this.#command(pkg), status: 'crashed', lastExit });
      this.#crashes.delete(system);
      log.error('supervisor.rolled.back', { system, from: installed.version, to: good });
      await this.start(system);
      return;
    }
    await this.#update(system, { status: 'disabled', lastExit });
    log.error('supervisor.gave.up', { system, version: installed.version, crashes: installed.restart.maxPerHour + 1 });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  #stateDir(system: SystemName): string {
    return join(this.dirOf(system), 'state');
  }

  #versionDir(system: SystemName, version: string): string {
    return join(this.dirOf(system), 'versions', version);
  }

  /** Move a fetched package into its version folder (a folder source stays where it is). */
  async #place(source: InstallSource, fetched: SystemPackage, staging: string): Promise<SystemPackage> {
    if ('path' in source) { return fetched; }
    const target = this.#versionDir(fetched.name, fetched.version);
    await rm(target, { recursive: true, force: true });
    await mkdir(join(this.dirOf(fetched.name), 'versions'), { recursive: true });
    await rename(staging, target);
    return this.#options.installer.describe(join(target, fetched.dir.slice(staging.length)));
  }

  #command(pkg: SystemPackage): InstalledSystem['command'] {
    return {
      run: process.execPath,
      args: [pkg.entry],
      env: { [SYSTEM_ENV.hub]: this.#options.settings.hubLink, [SYSTEM_ENV.state]: this.#stateDir(pkg.name), [SYSTEM_ENV.name]: pkg.name },
      cwd: pkg.dir,
    };
  }

  async #installed(system: SystemName): Promise<InstalledSystem | undefined> {
    return (await this.#options.store.table('systems').get(system))?.installed;
  }

  async #require(system: SystemName): Promise<InstalledSystem> {
    const installed = await this.#installed(system);
    if (installed === undefined) { throw refuse(404, 'NOT_INSTALLED', `${system} is not installed`); }
    return installed;
  }

  /** Change an installed system's entry on its row (through the status keeper, so no write is lost); nothing once uninstalled. */
  #update(system: SystemName, change: Partial<InstalledSystem>): Promise<SystemRecord> {
    return this.#options.status.sync(system, (record) => (record.installed === undefined ? record : { ...record, installed: { ...record.installed, ...change } }));
  }

  #clearTimer(system: SystemName): void {
    const timer = this.#timers.get(system);
    if (timer !== undefined) { clearTimeout(timer); }
    this.#timers.delete(system);
  }
}

/** Resolves after `ms`; aborting clears the timer (and leaves the promise pending, as nobody waits on it then). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
  });
}
