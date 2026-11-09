/**
 * Boots the whole harness on this machine: builds the web app, starts the hub (which serves the build), signs in as
 * the single admin account, pairs the fs, embedder, web, input and (when its OAuth client is given) google-calendar
 * systems with one-time pairing tokens the first time, starts them, and configures each with its config. `npm run dev` and the e2e tests both use it; `stop()` stops every
 * process it started.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemName, type Json, type SystemView } from '@harness/core';
import { encodeValue, type ConfigOf } from '@harness/sdk';
import { SYSTEM_ENV } from '@harness/sdk/server';
import { embedderSystem, type EmbedderContract } from '../systems/embedder/shared/index.ts';
import { fs } from '../systems/fs/shared/index.ts';
import { googleCalendar, type CalendarContract } from '../systems/google-calendar/shared/index.ts';
import { input } from '../systems/input/shared/index.ts';
import { web, type WebContract } from '../systems/web/shared/index.ts';
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
}

/** The process each system runs as: its own name, but `web-system` for the web system (`web` is the app's build). */
export const SYSTEM_COMPONENTS = { fs: 'fs', embedder: 'embedder', web: 'web-system', input: 'input', calendar: 'calendar' } as const satisfies Record<keyof StackSystems | 'input', string>;

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
  /** Which of hub, fs, embedder, web-system, input and calendar to run (`web` is the build step). */
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

/** The system named `name` as the hub sees it, or undefined. */
async function systemOf(admin: SignedIn, name: SystemName, timeout: number): Promise<SystemView | undefined> {
  return (await whileBusy(() => admin.hub.call('systems'), timeout)).find((s) => s.name === name);
}

/** Boot the stack. */
export async function startStack(options: StackOptions): Promise<Stack> {
  const timeout = options.timeout ?? 60_000;
  const data = resolve(ROOT, options.data);
  mkdirSync(data, { recursive: true });
  const children: Child[] = [];
  const stop = async (): Promise<void> => {
    // systems first, so they don't see the hub go away and start reconnecting
    for (const child of [...children].reverse()) { await halt(child, 10_000); }
    children.length = 0;
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
      children.push(runComponent('hub', options.watch ? [TSX, 'watch', entry] : [TSX, entry], {
        cwd: ROOT, output: options.output,
        env: {
          HARNESS_PORT: String(options.port), HARNESS_HOST: '0.0.0.0', HARNESS_DATA: data, HARNESS_URL: lanUrls[0] ?? url,
          HARNESS_ADMIN_EMAIL: options.admin.email, HARNESS_ADMIN_PASSWORD: options.admin.password, ...options.hubEnv,
        },
      }));
    }
    await waitFor('the hub to be ready', async () => ((await fetch(`${url}/readyz`)).ok ? true : undefined), { timeout });
    const admin = await signIn(url, options.admin);

    const link = `ws://127.0.0.1:${options.port}/link`;
    const systems = [
      { name: 'fs', entry: join(ROOT, 'systems', 'fs', 'server', 'main.ts'), config: encodeValue(fs.defs.config, options.systems.fs) },
      { name: 'embedder', entry: join(ROOT, 'systems', 'embedder', 'server', 'main.ts'), config: encodeValue(embedderSystem.defs.config, options.systems.embedder) },
      { name: 'web', entry: join(ROOT, 'systems', 'web', 'server', 'main.ts'), config: encodeValue(web.defs.config, options.systems.web ?? {}) },
      { name: 'input', system: input.name, entry: join(ROOT, 'systems', 'input', 'server', 'main.ts'), config: encodeValue(input.defs.config, {}) },
      ...(options.systems.calendar === undefined ? [] : [{
        name: 'calendar', system: googleCalendar.name, entry: join(ROOT, 'systems', 'google-calendar', 'server', 'main.ts'), config: encodeValue(googleCalendar.defs.config, options.systems.calendar),
      } as const]),
    ] as const satisfies ReadonlyArray<{ name: keyof typeof SYSTEM_COMPONENTS; system?: string; entry: string; config: Json }>;
    for (const system of systems) {
      const component = SYSTEM_COMPONENTS[system.name];
      if (!options.only.has(component)) { continue; }
      const name = SystemName.parse('system' in system ? system.system : system.name);
      const known = await systemOf(admin, name, timeout);
      // a system the hub already knows reconnects with its key; a new one pairs with a one-time token made for its name
      const token = known === undefined || known.status === 'removed'
        ? (await whileBusy(() => admin.hub.call('createPairingToken', { name, expiresIn: 600_000 }), timeout)).token
        : undefined;
      children.push(runComponent(component, options.watch ? [TSX, 'watch', system.entry] : [TSX, system.entry], {
        cwd: ROOT, output: options.output,
        env: {
          [SYSTEM_ENV.hub]: link, [SYSTEM_ENV.state]: join(data, 'dev-systems', system.name), ...(token === undefined ? {} : { [SYSTEM_ENV.pairingToken]: token }),
          ...options.systemEnv,
        },
      }));
      const seen = await waitFor(`${system.name} to connect`, async () => {
        const view = await systemOf(admin, name, timeout);
        // needs-config only counts once its contract (and so its config type) has arrived
        return view?.status === 'connected' || (view?.status === 'needs-config' && view.configType !== undefined) ? view : undefined;
      }, { timeout });
      if (seen.needsConfig) {
        const result = await whileBusy(() => admin.hub.call('configureSystem', { system: name, config: system.config }), timeout);
        if ('problems' in result) { throw new Error(`${system.name} config refused: ${result.problems.join('; ')}`); }
        await waitFor(`${system.name} to be configured`, async () => ((await systemOf(admin, name, timeout))?.status === 'connected' ? true : undefined), { timeout });
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
