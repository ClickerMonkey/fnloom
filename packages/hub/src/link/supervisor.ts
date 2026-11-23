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
 *
 * Each process's network is held to its system's `grants.network` the way fs holds the systems it hosts: it gets an
 * `AllowlistProxy` of its own letting through those hosts (the approved grants once the system is live, else what its
 * contract declares: `SystemGrantGuard.grants`) and the hub's, is pointed at it (`guardedEnv`; the hub link goes
 * direct), and preloads the SDK's socket guard (`NETWORK_GUARD`), so a raw socket reaches only the proxy and the hub.
 * A host the proxy or the guard refuses is kept as that instance's refusal (`SystemGrantGuard.refused`, as fs's
 * `reportRefusal` is). The proxy lives as long as the process: it is closed once the process has exited (stopped,
 * crashed or restarting) and a new start gets a new one. A grant that changes while it runs (its contract imported,
 * approved or rejected) changes what its proxy lets through at once; the guard it started with stays until it restarts.
 * Node's permission model (files, child processes) is not applied to these instances, so unlike fs's hosted systems
 * nothing denies `process.binding`, the way around the guard: the guard holds honest code, not a determined one.
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  AllowlistProxy, CrashPolicy, NETWORK_GUARD, RESTART_CODE, SYSTEM_ENV, endpointOf, guardedEnv, refusedOfLine,
  type Endpoint, type NetworkGate, type ProcessCommand, type ProcessExit, type ProcessStarter, type ProxyRefusal, type SupervisedProcess,
} from '@harness/sdk/server';
import {
  MAIN_INSTANCE, instanceLabel, mapConcurrent, type InstallSource, type InstalledSystem, type InstanceDirs, type InstanceName, type InstanceRecord, type InstanceRef,
  type HostRefusal, type StopReason, type SystemName,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import { allRows } from '../store/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { StoreConfigService } from './config.ts';
import type { SystemGrantGuard } from './grants.ts';
import type { InstallInput, LinkService, PairingService, Supervisor } from './index.ts';
import { KEY_FILE, makeKeyPair, randomToken } from './keys.ts';
import type { Installer, SystemPackage } from './process.ts';
import type { InstanceKeeper } from './status.ts';

/**
 * The `tsx` ESM loader, by absolute URL: a system's `server/main.ts` runs under it, so its TypeScript imports resolve
 * the way they do in the dev stack. Absolute, because the system runs from its own folder.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
/** The socket guard, as a URL: an ESM module, so it loads with `--import` (a `--require` of it fails under the loader). */
const NETWORK_GUARD_LOADER = pathToFileURL(NETWORK_GUARD).href;

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
  /** The longest wait between restarts. */
  readonly maxBackoff: number;
}

/** How the supervisor holds each process's network to its grant. */
export interface SupervisorNetwork {
  /** The hosts an instance of `system` may reach (`grants.network`; none declared, none). */
  hosts(system: SystemName): Promise<readonly string[]>;
  /** A gate letting through `allow` and telling `refused` of every other host: an `AllowlistProxy`. */
  gate(allow: readonly string[], refused: (refusal: ProxyRefusal) => void): NetworkGate;
  /** Keep a host an instance was refused as its refusal. */
  refused(refusal: HostRefusal): Promise<unknown>;
  /** Calls `listener` whenever grants may have changed. */
  onChange(listener: () => void): void;
}

/**
 * The supervisor's network over the grant guard: the grants it enforces over the link, its refusals (kept as
 * `reportRefusal` keeps fs's), and the bus events a contract import, approval or rejection publishes.
 */
export function grantedNetwork(grants: Pick<SystemGrantGuard, 'grants' | 'refused'>, bus: Pick<EventBus, 'subscribe'>): SupervisorNetwork {
  return {
    hosts: async (system) => (await grants.grants(system)).network ?? [],
    gate: (allow, refused) => new AllowlistProxy({ allow, onRefused: refused }),
    refused: (refusal) => grants.refused(refusal.instance, { rule: refusal.rule, attempt: refusal.attempt, detail: refusal.detail }),
    onChange: (listener) => {
      bus.subscribe('capabilities.changed', listener);
      bus.subscribe('catalog.changed', listener);
    },
  };
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
  /** Starts processes: the SDK's `NodeStarter` (a scrubbed environment) in production. */
  readonly launcher: ProcessStarter;
  readonly installer: Installer;
  /** Each process's network gate (`grantedNetwork` in production). */
  readonly network: SupervisorNetwork;
  readonly settings: SupervisorSettings;
}

/** One running process. */
interface Running {
  readonly ref: InstanceRef;
  readonly process: SupervisedProcess;
  /** Its network gate, closed once it has exited. */
  readonly gate: NetworkGate;
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
  /** The shared restart rule, keyed by `system@instance`. */
  readonly #crashes: CrashPolicy;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Starts still opening their gate, so a second start or a stop waits for them. */
  readonly #starting = new Map<string, Promise<void>>();
  /** The hub's link endpoint, which every process reaches directly (never through its proxy). */
  readonly #hub: Endpoint;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#hub = endpointOf(options.settings.hubLink);
    this.#crashes = new CrashPolicy({ maxWait: options.settings.maxBackoff, restartCode: RESTART_CODE, clock: options.clock });
    options.links.onChange((change) => {
      if (change.connected && this.#running.has(instanceLabel(change))) { void this.#connected(change); }
    });
    options.network.onChange(() => { void this.#regrant(); });
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
  async install(input: InstallInput): Promise<InstalledSystem> {
    const { instances, pairing, config, settings, clock, log } = this.#options;
    const fetched = await this.#fetch(input.source);
    const name = fetched.pkg.manifest.name;
    const ref: InstanceRef = { system: name, instance: input.instance ?? MAIN_INSTANCE };
    const installed = (await instances.of(name)).filter((i) => i.installed !== undefined && i.status !== 'removed');
    const refusal = input.system !== undefined && input.system !== name ? refuse(422, 'WRONG_SYSTEM', `the folder holds ${name}, not ${input.system}`)
      : installed.some((i) => i.instance === ref.instance) ? refuse(409, 'ALREADY_INSTALLED', `${instanceLabel(ref)} is already installed`)
      : installed.length > 0 && fetched.pkg.manifest.instances === 'one' ? refuse(409, 'ONE_INSTANCE', `${name} runs one instance, and it is installed`)
        : input.fleet === true && fetched.pkg.manifest.instances === 'one' ? refuse(409, 'ONE_INSTANCE', `${name} runs one instance, so it takes no added instances`)
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
    await instances.sync(ref, { installed: entry, dirs, version: pkg.manifest.version, ...(input.description === undefined ? {} : { description: input.description }) });
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
      this.#crashes.forget(instanceLabel(ref));
      this.#options.log.info('supervisor.upgraded', { system, instance: ref.instance, from: installed.version, to: pkg.manifest.version });
      if (wasRunning || installed.autoStart) { await this.#start({ ...installed, command: this.#command(pkg, ref, this.dirsOf(ref)) }); }
    }
    return { from: first.version, to: pkg.manifest.version };
  }

  async uninstall(system: SystemName, instance?: InstanceName): Promise<void> {
    const targets = await this.#targets(system, instance);
    // each instance stops (up to the stop timeout) and is removed on its own, all at once
    await mapConcurrent(targets, async (installed) => {
      const ref = refOf(installed);
      await this.#stop(ref, 'removed');
      await this.#options.instances.sync(ref, (record) => {
        const { installed: _gone, ...rest } = record;
        return { ...rest, status: 'removed' };
      });
      this.#crashes.forget(instanceLabel(ref));
      this.#options.log.info('supervisor.uninstalled', { system, instance: ref.instance });
    });
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

  #start(installed: InstalledSystem): Promise<void> {
    const key = instanceLabel(refOf(installed));
    const pending = this.#starting.get(key);
    if (pending !== undefined) { return pending; }
    // released once the process is running, so an exit at once can start it again
    const release = (): void => { if (this.#starting.get(key) === starting) { this.#starting.delete(key); } };
    const starting: Promise<void> = this.#launch(installed, release).finally(release);
    this.#starting.set(key, starting);
    return starting;
  }

  /** Open the instance's gate, then launch it pointed at it (`launched` once it is running). */
  async #launch(installed: InstalledSystem, launched: () => void): Promise<void> {
    const ref = refOf(installed);
    const key = instanceLabel(ref);
    this.#clearTimer(key);
    if (this.#running.has(key)) { return; }
    if (installed.status === 'disabled') { this.#crashes.forget(key); }
    const gate = this.#options.network.gate(await this.#allowed(ref), (refusal) => { this.#refusedHost(ref, refusal.host, `${refusal.host}:${String(refusal.port)}`); });
    const url = await gate.start();
    let process: SupervisedProcess;
    try {
      process = this.#options.launcher.launch(this.#guarded(installed.command, url, ref));
    } catch (error) {
      await gate.close();
      throw error;
    }
    const handled = process.exited.then((exit) => this.#exited(ref, exit)).catch((error: unknown) => {
      this.#options.log.error('supervisor.exit.failed', { system: ref.system, instance: ref.instance, error: messageOf(error) });
    });
    this.#running.set(key, { ref, process, gate, handled, stopping: false });
    launched();
    await this.#update(ref, { status: 'starting', ...(process.pid === undefined ? {} : { pid: process.pid }) });
    this.#options.log.info('supervisor.started', { system: ref.system, instance: ref.instance, version: installed.version, pid: process.pid });
  }

  async #stop(ref: InstanceRef, reason: StopReason): Promise<void> {
    const { links, settings, log } = this.#options;
    const key = instanceLabel(ref);
    // a start still opening its gate launches first, then is stopped
    await this.#starting.get(key)?.catch(() => undefined);
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

  /** A started instance connected: this version starts cleanly (and its contract may be new, so its grant too). */
  async #connected(ref: InstanceRef): Promise<void> {
    void this.#regrant();
    const installed = await this.#installed(ref);
    if (installed === undefined) { return; }
    await this.#update(ref, { status: 'running', goodVersion: installed.version });
  }

  async #exited(ref: InstanceRef, exit: ProcessExit): Promise<void> {
    const { clock, log } = this.#options;
    const key = instanceLabel(ref);
    const running = this.#running.get(key);
    this.#running.delete(key);
    // the gate goes with its process; a restart gets a new one
    await running?.gate.close();
    const installed = await this.#installed(ref);
    if (installed === undefined) { return; }
    const lastExit = { code: exit.code, at: clock(), output: exit.output };
    const fields = { system: ref.system, instance: ref.instance, version: installed.version };
    const decision = this.#crashes.decide(key, installed.restart, exit, running?.stopping !== false);
    switch (decision.action) {
      case 'stopped':
        await this.#update(ref, { status: running?.stopping !== false || exit.code === 0 ? 'stopped' : 'crashed', lastExit });
        return;
      case 'restart-now':
        log.info('supervisor.restarting', fields);
        await this.#update(ref, { status: 'starting', lastExit });
        await this.#start(installed);
        return;
      case 'give-up':
        log.warn('supervisor.crashed', { ...fields, code: exit.code, crashes: decision.crashes });
        await this.#giveUp(ref, installed, lastExit);
        return;
      case 'restart':
        break;
    }
    log.warn('supervisor.crashed', { ...fields, code: exit.code, crashes: decision.crashes });
    await this.#update(ref, { status: 'crashed', lastExit });
    const wait = decision.wait;
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
      this.#crashes.forget(instanceLabel(ref));
      log.error('supervisor.rolled.back', { system: ref.system, instance: ref.instance, from: installed.version, to: good });
      await this.#start({ ...installed, version: good, command });
      return;
    }
    await this.#update(ref, { status: 'disabled', lastExit });
    log.error('supervisor.gave.up', { system: ref.system, instance: ref.instance, version: installed.version, crashes: installed.restart.maxPerHour + 1 });
  }

  // ─── Network ──────────────────────────────────────────────────────────────

  /** What an instance's proxy lets through: its grant's hosts and the hub's. */
  async #allowed(ref: InstanceRef): Promise<string[]> {
    return [...await this.#options.network.hosts(ref.system), this.#hub.host];
  }

  /** Give every running process's proxy its grant as it is now. */
  async #regrant(): Promise<void> {
    for (const running of [...this.#running.values()]) {
      try {
        running.gate.setAllowed(await this.#allowed(running.ref));
      } catch (error) {
        this.#options.log.warn('supervisor.regrant.failed', { system: running.ref.system, instance: running.ref.instance, error: messageOf(error) });
      }
    }
  }

  /**
   * An installed command as it is launched: pointed at its proxy (the hub direct), with the socket guard preloaded when
   * it runs on Node, and what it prints read for the guard's refusal lines.
   */
  #guarded(command: InstalledSystem['command'], url: string, ref: InstanceRef): ProcessCommand {
    let partial = '';
    const onOutput = (text: string): void => {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const target = refusedOfLine(line);
        if (target !== undefined) { this.#refusedHost(ref, target.replace(/:\d+$/, ''), target); }
      }
    };
    return { ...command, env: { ...command.env, ...guardedEnv(url, [this.#hub]) }, onOutput };
  }

  /** Keep that the instance tried to reach `host` (`attempt` is what it asked for), which its grant doesn't name. */
  #refusedHost(ref: InstanceRef, host: string, attempt: string): void {
    const refusal: HostRefusal = { instance: ref, rule: 'network', attempt, detail: `${ref.system} tried to reach ${host}, which its grants.network doesn't name` };
    this.#options.network.refused(refusal).catch((error: unknown) => {
      this.#options.log.warn('supervisor.refusal.unkept', { system: ref.system, instance: ref.instance, attempt, error: messageOf(error) });
    });
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
      args: ['--import', TSX_LOADER, '--import', NETWORK_GUARD_LOADER, pkg.entry],
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
