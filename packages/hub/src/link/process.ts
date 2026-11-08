/**
 * The ports the supervisor runs installed instances through, and their Node implementations: `ProcessLauncher`
 * starts a system's process and reports its exit with the end of its output; `Installer` fetches a system from a
 * folder, an npm package, a git repository or an uploaded package zip, and reads what it is from its `system.json`
 * (`SystemPackageManifest`, the one source of a system's name, version and entries).
 */
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LINK_PROTOCOL, PACKAGE_MANIFEST_FILE, type InstallSource, type InstalledSystem, type SystemPackageManifest } from '@harness/core';
import { PackageError, checkManifest } from './package/format.ts';
import { readPackage, unzip, writeTree } from './package/index.ts';

/** How to run a system's process. */
export type SystemCommand = InstalledSystem['command'];

/** How a process ended. */
export interface ProcessExit {
  readonly code: number;
  /** The end of what it printed. */
  readonly output: string;
}

/** A running system process. */
export interface SystemProcess {
  readonly pid: number | undefined;
  /** Settles once, when the process exits (or fails to start, with code -1). */
  readonly exited: Promise<ProcessExit>;
  kill(): void;
}

/** Starts system processes. */
export interface ProcessLauncher {
  launch(command: SystemCommand): SystemProcess;
}

/** What an installed folder holds: its manifest, its server entry file (absolute) and the folder. */
export interface SystemPackage {
  readonly manifest: SystemPackageManifest;
  /** The server entry, absolute. */
  readonly entry: string;
  /** The folder the package is in. */
  readonly dir: string;
}

/** Fetches systems and reads what they are. */
export interface Installer {
  /** Put the system a source names into `dir` (for a folder source, nothing is copied) and describe it. */
  fetch(source: InstallSource, dir: string): Promise<SystemPackage>;
  /** Describe the system in a folder (its `system.json`). */
  describe(dir: string): Promise<SystemPackage>;
}

/** Where package zips come from: the hub's content store, by hash. */
export interface ZipSource {
  /** The bytes stored under a hash; refused when there are none. */
  bytes(hash: string): Promise<Uint8Array>;
}

/** How much of a process's output is kept for the admin page. */
export const OUTPUT_TAIL = 8_192;

/**
 * Starts processes with `child_process.spawn`, keeping the tail of their output. Commands that run this Node binary
 * get `nodeArgs` first, so systems run with the hub's own Node flags (under `tsx`, its loader, so a system can run
 * from its TypeScript source).
 */
export class NodeLauncher implements ProcessLauncher {
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #nodeArgs: readonly string[];

  /** `baseEnv` is what every system process inherits (boot passes the hub's own environment and `process.execArgv`). */
  constructor(options: { baseEnv: Readonly<Record<string, string | undefined>>; nodeArgs?: readonly string[] }) {
    this.#baseEnv = options.baseEnv;
    this.#nodeArgs = options.nodeArgs ?? [];
  }

  launch(command: SystemCommand): SystemProcess {
    const args = command.run === process.execPath ? [...this.#nodeArgs, ...command.args] : command.args;
    const child = spawn(command.run, args, {
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      env: { ...this.#baseEnv, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const exited = new Promise<ProcessExit>((done) => {
      child.once('error', (error) => { done({ code: -1, output: `${output}\n${error.message}`.slice(-OUTPUT_TAIL) }); });
      child.once('exit', (code, signal) => { done({ code: code ?? (signal === null ? 0 : 1), output }); });
    });
    return { pid: child.pid, exited, kill: () => { child.kill(); } };
  }
}

const run = promisify(execFile);

/** Read and check a folder's `system.json`: it parses and speaks this hub's link protocol. */
export async function readManifest(dir: string, protocol: number = LINK_PROTOCOL): Promise<SystemPackageManifest> {
  const { manifest, problems } = checkManifest(new Uint8Array(await readFile(join(dir, PACKAGE_MANIFEST_FILE))), protocol);
  if (manifest === undefined || problems.length > 0) { throw new PackageError(problems); }
  return manifest;
}

/** Fetches systems with npm and git, unpacks package zips, and reads their `system.json`. */
export class NodeInstaller implements Installer {
  readonly #npm: string;
  readonly #git: string;
  readonly #zips: ZipSource | undefined;
  readonly #maxBytes: number;

  /** `npm` and `maxBytes` are the packaging settings (`HARNESS_NPM`, `HARNESS_PACKAGE_MAX`). */
  constructor(options: { npm: string; maxBytes: number; git?: string; zips?: ZipSource }) {
    this.#npm = options.npm;
    this.#git = options.git ?? 'git';
    this.#zips = options.zips;
    this.#maxBytes = options.maxBytes;
  }

  async fetch(source: InstallSource, dir: string): Promise<SystemPackage> {
    if ('path' in source) { return this.describe(resolve(source.path)); }
    if ('package' in source) {
      await run(this.#npm, ['install', '--prefix', dir, '--omit=dev', '--no-save', `${source.package}@${source.version}`], { shell: process.platform === 'win32' });
      return this.describe(join(dir, 'node_modules', ...source.package.split('/')));
    }
    if ('zip' in source) { return this.#unpack(source.zip, dir); }
    await run(this.#git, ['clone', '--depth', '1', '--branch', source.ref, source.git, dir]);
    await run(this.#npm, ['install', '--omit=dev'], { cwd: dir, shell: process.platform === 'win32' });
    return this.describe(dir);
  }

  async describe(dir: string): Promise<SystemPackage> {
    const manifest = await readManifest(dir);
    return { manifest, entry: resolve(dir, manifest.server.entry), dir };
  }

  /** Unpack a checked package zip into `dir` and install the npm packages its bundle left out. */
  async #unpack(hash: string, dir: string): Promise<SystemPackage> {
    if (this.#zips === undefined) { throw new PackageError(['this hub was not given a place to read package zips from']); }
    const entries = unzip(await this.#zips.bytes(hash), this.#maxBytes);
    const checked = readPackage(entries);
    await writeTree(entries, dir);
    const externals = Object.entries(checked.manifest.server.external).map(([name, range]) => `${name}@${range}`);
    if (externals.length > 0) {
      await run(this.#npm, ['install', '--prefix', dir, '--omit=dev', '--no-save', '--no-package-lock', ...externals], { shell: process.platform === 'win32' });
    }
    return this.describe(dir);
  }
}
