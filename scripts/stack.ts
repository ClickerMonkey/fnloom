/**
 * Boots the whole harness on this machine: builds the web app, starts the hub (which serves the build), signs in as
 * the single admin account, pairs the fs, embedder, web, input, widgets, code, api, claude, (when its OAuth client is given) google-calendar,
 * (when its config is given) ollama and
 * (one process per configured database instance) database systems with one-time pairing tokens the first time, starts them, and configures
 * each with its config. `npm run dev` and the e2e tests both use it; `stop()` stops every process it started. With
 * `restart`, each process is supervised: restarted when it crashes or stops answering, with why in the crash log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceName, SystemName, type Json, type SystemView } from '@harness/core';
import { encodeValue, type ConfigOf } from '@harness/sdk';
import { SYSTEM_ENV } from '@harness/sdk/server';
import { database, type DatabaseContract } from '../systems/database/shared/index.ts';
import { embedderSystem, type EmbedderContract } from '../systems/embedder/shared/index.ts';
import { fs } from '../systems/fs/shared/index.ts';
import { googleCalendar, type CalendarContract } from '../systems/google-calendar/shared/index.ts';
import { input } from '../systems/input/shared/index.ts';
import { widgets } from '../systems/widgets/shared/index.ts';
import { claude } from '../systems/claude/shared/index.ts';
import { ollama, type OllamaConfigInput } from '../systems/ollama/shared/index.ts';
import { code } from '../systems/code/shared/index.ts';
import { api } from '../systems/api/shared/index.ts';
import { web, type WebContract } from '../systems/web/shared/index.ts';
import { Supervisor, type SuperviseOptions } from './supervise.ts';
import { signIn, waitFor, type Credentials, type SignedIn } from './hub-client.ts';

/** The repository root. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** The systems the stack runs, with the config each gets once it has connected. */
export interface StackSystems {
  readonly fs: ConfigOf<(typeof fs)['defs']>;
  readonly embedder: ConfigOf<EmbedderContract['defs']>;
  /** The web system's config; absent, its defaults (it reads `TAVILY_API_KEY` from the environment). */
  readonly web?: ConfigOf<WebContract['defs']>;
  /** The Google Calendar system's OAuth client; absent, it isn't started (it can't connect anyone without one). */
  readonly calendar?: ConfigOf<CalendarContract['defs']>;
  /** The Ollama system's config (where its Ollama runs); absent, it isn't started. */
  readonly ollama?: OllamaConfigInput;
  /** The database fleet: one process per instance (by instance name), each with its database's config; absent, none runs. */
  readonly databases?: Readonly<Record<string, ConfigOf<DatabaseContract['defs']>>>;
}

/** The process each system runs as: its own name, but `web-system` for the web system (`web` is the app's build). */
export const SYSTEM_COMPONENTS = { fs: 'fs', embedder: 'embedder', web: 'web-system', input: 'input', widgets: 'widgets', code: 'code', api: 'api', calendar: 'calendar', database: 'database', claude: 'claude', ollama: 'ollama' } as const satisfies Record<Exclude<keyof StackSystems, 'databases'> | 'input' | 'widgets' | 'code' | 'api' | 'database' | 'claude', string>;

/** A process the stack runs. */
export type ComponentName = 'web' | 'hub' | (typeof SYSTEM_COMPONENTS)[keyof typeof SYSTEM_COMPONENTS];

/** How to boot the stack. */
export interface StackOptions {
  /** The hub's port; the web app is served by the hub on the same port. */
  readonly port: number;
  /** The data folder (database, files, keys, logs, system state). */
  readonly data: string;
  readonly admin: Credentials;
  /** Build the web app first (`vite build`). */
  readonly build: boolean;
  /** Restart the hub and systems when their source changes (`tsx watch`). */
  readonly watch: boolean;
  /**
   * A bundled hub to run with plain Node instead of the hub's source (`npm run live`), and the built web app it serves.
   * Never watched.
   */
  readonly pinned?: { readonly hub: string; readonly web: string };
  /** Which of hub, fs, embedder, web-system, input, widgets, code, api, claude, calendar, ollama and database to run (`web` is the build step). */
  readonly only: ReadonlySet<ComponentName>;
  readonly systems: StackSystems;
  /** Extra environment for the hub (models, tunables). */
  readonly hubEnv?: Readonly<Record<string, string>>;
  /** Extra environment for every system. */
  readonly systemEnv?: Readonly<Record<string, string>>;
  /** Where each process's output goes. */
  readonly output: (component: ComponentName, line: string, stream: 'out' | 'err') => void;
  /** How long to wait for the hub and each system. */
  readonly timeout?: number;
  /** Supervise each process (dev): restart it when it crashes or stops answering, logging why to `<data>/logs/crashes.log`. */
  readonly restart?: Omit<SuperviseOptions, 'log'>;
}

/** A running stack. */
export interface Stack {
  /** The hub on this machine. */
  readonly url: string;
  /** The hub at each of this machine's network addresses (Wi-Fi, VPN), for other devices. */
  readonly lanUrls: readonly string[];
  /** Signed in as the admin. */
  readonly admin: SignedIn;
  stop(): Promise<void>;
}

/** This machine's IPv4 addresses other devices can reach (every interface but loopback). */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().flatMap((n) => (n?.family === 'IPv4' && !n.internal ? [n.address] : []));
}

/** How many of a process's last output lines the crash log keeps. */
const RECENT_LINES = 40;

/** A started child process and the promise of its exit code. */
export interface Child {
  readonly name: ComponentName;
  readonly process: ChildProcess;
  readonly exited: Promise<number | null>;
}

/** Spawn a Node script, routing its output line by line. */
export function runComponent(name: ComponentName, args: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>>; output: StackOptions['output'] }): Child {
  const child = spawn(process.execPath, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = (stream: 'out' | 'err') => (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) { if (line !== '') { options.output(name, line, stream); } }
  };
  child.stdout.on('data', lines('out'));
  child.stderr.on('data', lines('err'));
  const exited = new Promise<number | null>((done) => { child.on('exit', (code) => { done(code); }); });
  return { name, process: child, exited };
}

/**
 * Stop a child and wait for it (killing it hard after `grace` ms). On Windows signals can't be sent and `tsx` runs the
 * script in a grandchild, so the whole process tree is ended with `taskkill /T`.
 */
export async function halt(child: Child, grace: number): Promise<void> {
  if (child.process.exitCode !== null) { return; }
  const pid = child.process.pid;
  if (process.platform === 'win32' && pid !== undefined) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    await child.exited;
    return;
  }
  child.process.kill('SIGTERM');
  const timer = setTimeout(() => { child.process.kill('SIGKILL'); }, grace);
  await child.exited;
  clearTimeout(timer);
}

/** Whether an error is the hub shedding load (503), which passes once its startup work (indexing catch-up) settles. */
function isBusy(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 503;
}

/** Run a hub call, retrying while the hub is busy, for up to `timeout`. */
async function whileBusy<T>(call: () => Promise<T>, timeout: number): Promise<T> {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isBusy(error) || Date.now() > until) { throw error; }
      await new Promise((done) => setTimeout(done, 1_000));
    }
  }
}

/** One instance of a system (its default instance when `instance` is absent) as the hub sees it, or undefined. */
async function instanceOf(admin: SignedIn, name: SystemName, instance: InstanceName | undefined, timeout: number): Promise<{ status: SystemView['status']; needsConfig: boolean; ready: boolean } | undefined> {
  const view = await systemOf(admin, name, timeout);
  if (view === undefined) { return undefined; }
  // needs-config only counts once its contract (and so its config type) has arrived
  const ready = (status: SystemView['status']): boolean => status === 'connected' || (status === 'needs-config' && view.configType !== undefined);
  if (instance === undefined) { return { status: view.status, needsConfig: view.needsConfig, ready: ready(view.status) }; }
  const found = view.instances.find((i) => i.instance === instance);
  return found === undefined ? undefined : { status: found.status, needsConfig: found.config === undefined, ready: ready(found.status) };
}

/** The system named `name` as the hub sees it, or undefined. */
async function systemOf(admin: SignedIn, name: SystemName, timeout: number): Promise<SystemView | undefined> {
  return (await whileBusy(() => admin.hub.call('systems'), timeout)).find((s) => s.name === name);
}

/** Boot the stack. */
export async function startStack(options: StackOptions): Promise<Stack> {
  const timeout = options.timeout ?? 60_000;
  const data = resolve(ROOT, options.data);
  mkdirSync(data, { recursive: true });
  const children: Array<{ stop(): Promise<void> }> = [];
  const stop = async (): Promise<void> => {
    // systems first, so they don't see the hub go away and start reconnecting
    for (const child of [...children].reverse()) { await child.stop(); }
    children.length = 0;
  };
  const crashLog = join(data, 'logs', 'crashes.log');
  // the last lines each process printed, for the crash log
  const recent = new Map<ComponentName, string[]>();
  const output: StackOptions['output'] = (component, line, stream) => {
    const lines = recent.get(component) ?? [];
    lines.push(line);
    if (lines.length > RECENT_LINES) { lines.shift(); }
    recent.set(component, lines);
    options.output(component, line, stream);
  };
  /**
   * Start a process: supervised when `restart` is set (`alive` says whether it answers), else once. A system runs in its
   * own folder, as the hub and fs start installed ones, so `serve` finds its `system.json` and its context folder.
   */
  const launch = (name: ComponentName, args: readonly string[], env: Readonly<Record<string, string>>, alive: () => Promise<boolean>, cwd = ROOT): void => {
    const start = (): Child => runComponent(name, args, { cwd, env, output });
    if (options.restart === undefined) {
      const child = start();
      children.push({ stop: () => halt(child, 10_000) });
      return;
    }
    children.push(new Supervisor<Child>({
      name, start, alive, exited: (child) => child.exited, halt: (child) => halt(child, 10_000), recent: () => recent.get(name) ?? [],
    }, { ...options.restart, log: crashLog }));
  };

  try {
    if (options.only.has('web') && options.build) {
      const build = runComponent('web', [VITE, 'build'], { cwd: join(ROOT, 'packages', 'web'), env: {}, output: options.output });
      if (await build.exited !== 0) { throw new Error('the web build failed'); }
    }

    const url = `http://127.0.0.1:${options.port}`;
    const lanUrls = lanAddresses().map((address) => `http://${address}:${options.port}`);
    if (options.only.has('hub')) {
      const entry = join(ROOT, 'packages', 'hub', 'src', 'main.ts');
      const args = options.pinned !== undefined ? [options.pinned.hub] : options.watch ? [TSX, 'watch', entry] : [TSX, entry];
      launch('hub', args, {
        ...(options.pinned === undefined ? {} : { HARNESS_WEB_DIST: options.pinned.web }),
        HARNESS_PORT: String(options.port), HARNESS_HOST: '0.0.0.0', HARNESS_DATA: data, HARNESS_URL: lanUrls[0] ?? url,
        HARNESS_ADMIN_EMAIL: options.admin.email, HARNESS_ADMIN_PASSWORD: options.admin.password, ...options.hubEnv,
      }, async () => (await fetch(`${url}/readyz`)).ok);
    }
    await waitFor('the hub to be ready', async () => ((await fetch(`${url}/readyz`)).ok ? true : undefined), { timeout });
    const admin = await signIn(url, options.admin);

    const link = `ws://127.0.0.1:${options.port}/link`;
    const systems = [
      { name: 'fs', entry: join(ROOT, 'systems', 'fs', 'server', 'main.ts'), config: encodeValue(fs.defs.config, options.systems.fs) },
      { name: 'embedder', entry: join(ROOT, 'systems', 'embedder', 'server', 'main.ts'), config: encodeValue(embedderSystem.defs.config, options.systems.embedder) },
      { name: 'web', entry: join(ROOT, 'systems', 'web', 'server', 'main.ts'), config: encodeValue(web.defs.config, options.systems.web ?? {}) },
      { name: 'input', system: input.name, entry: join(ROOT, 'systems', 'input', 'server', 'main.ts'), config: encodeValue(input.defs.config, {}) },
      { name: 'widgets', system: widgets.name, entry: join(ROOT, 'systems', 'widgets', 'server', 'main.ts'), config: encodeValue(widgets.defs.config, {}) },
      { name: 'code', system: code.name, entry: join(ROOT, 'systems', 'code', 'server', 'main.ts'), config: encodeValue(code.defs.config, {}) },
      { name: 'api', system: api.name, entry: join(ROOT, 'systems', 'api', 'server', 'main.ts'), config: encodeValue(api.defs.config, {}) },
      // Claude Code sessions may start in any folder beside this repository
      { name: 'claude', system: claude.name, entry: join(ROOT, 'systems', 'claude', 'server', 'main.ts'), config: encodeValue(claude.defs.config, { folders: [{ path: dirname(ROOT), label: basename(dirname(ROOT)) }] }) },
      ...(options.systems.calendar === undefined ? [] : [{
        name: 'calendar', system: googleCalendar.name, entry: join(ROOT, 'systems', 'google-calendar', 'server', 'main.ts'), config: encodeValue(googleCalendar.defs.config, options.systems.calendar),
      } as const]),
      ...(options.systems.ollama === undefined ? [] : [{
        name: 'ollama', system: ollama.name, entry: join(ROOT, 'systems', 'ollama', 'server', 'main.ts'), config: encodeValue(ollama.defs.config, options.systems.ollama),
      } as const]),
      ...Object.entries(options.systems.databases ?? {}).map(([instance, config]) => ({
        name: 'database', system: database.name, instance: InstanceName.parse(instance), entry: join(ROOT, 'systems', 'database', 'server', 'main.ts'), config: encodeValue(database.defs.config, config),
      } as const)),
    ] as const satisfies ReadonlyArray<{ name: keyof typeof SYSTEM_COMPONENTS; system?: string; instance?: InstanceName; entry: string; config: Json }>;
    for (const system of systems) {
      const component = SYSTEM_COMPONENTS[system.name];
      if (!options.only.has(component)) { continue; }
      const name = SystemName.parse('system' in system ? system.system : system.name);
      const instance = 'instance' in system ? system.instance : undefined;
      const label = instance === undefined ? system.name : `${system.name} ${instance}`;
      const known = await instanceOf(admin, name, instance, timeout);
      // an instance the hub already knows reconnects with its key; a new one pairs with a one-time token made for its system's name
      const token = known === undefined || known.status === 'removed'
        ? (await whileBusy(() => admin.hub.call('createPairingToken', { name, expiresIn: 600_000 }), timeout)).token
        : undefined;
      launch(component, options.watch ? [TSX, 'watch', system.entry] : [TSX, system.entry], {
        [SYSTEM_ENV.hub]: link, [SYSTEM_ENV.state]: join(data, 'dev-systems', instance === undefined ? system.name : `${system.name}-${instance}`),
        ...(instance === undefined ? {} : { [SYSTEM_ENV.instance]: instance }),
        ...(token === undefined ? {} : { [SYSTEM_ENV.pairingToken]: token }),
        ...options.systemEnv,
      }, async () => {
        const status = (await instanceOf(admin, name, instance, timeout))?.status;
        return status === 'connected' || status === 'needs-config';
      }, dirname(dirname(system.entry)));
      const seen = await waitFor(`${label} to connect`, async () => {
        const view = await instanceOf(admin, name, instance, timeout);
        return view?.ready === true ? view : undefined;
      }, { timeout });
      // a new instance gets its config even when its defaults let it start without one (the embedder's service URL)
      if (seen.needsConfig || token !== undefined) {
        const result = await whileBusy(() => admin.hub.call('configureSystem', { system: name, config: system.config, ...(instance === undefined ? {} : { instance }) }), timeout);
        if ('problems' in result) { throw new Error(`${label} config refused: ${result.problems.join('; ')}`); }
        await waitFor(`${label} to be configured`, async () => ((await instanceOf(admin, name, instance, timeout))?.status === 'connected' ? true : undefined), { timeout });
      }
    }
    return { url, lanUrls, admin, stop: async () => { admin.close(); await stop(); } };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The fs config the dev and e2e stacks use: one writable, indexed root at `folder`, and its own source folder. */
export function fsConfig(folder: string): StackSystems['fs'] {
  return { roots: [{ name: 'harness', path: folder, writable: true, index: 'all' }], self: join(ROOT, 'systems', 'fs') };
}
