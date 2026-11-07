/**
 * The ports the supervisor runs installed systems through, and their Node implementations: `ProcessLauncher` starts
 * a system's process and reports its exit with the end of its output; `Installer` fetches a system from a folder, an
 * npm package or a git repository and reads what it is from its `package.json` (`harness.name`, `harness.main`).
 */
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SystemName, type InstallSource, type InstalledSystem } from '@harness/core';
import { z } from 'zod';

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

/** What an installed folder holds: the system's name, version and entry file (absolute). */
export interface SystemPackage {
  readonly name: SystemName;
  readonly version: string;
  readonly entry: string;
  /** The folder the package is in. */
  readonly dir: string;
}

/** Fetches systems and reads what they are. */
export interface Installer {
  /** Put the system a source names into `dir` (for a folder source, nothing is copied) and describe it. */
  fetch(source: InstallSource, dir: string): Promise<SystemPackage>;
  /** Describe the system in a folder. */
  describe(dir: string): Promise<SystemPackage>;
}

/** The part of a system's `package.json` the hub reads. */
export const SystemPackageJson = z.object({
  name: z.string(),
  version: z.string(),
  harness: z.object({ name: SystemName, main: z.string().min(1) }),
});

/** How much of a process's output is kept for the admin page. */
export const OUTPUT_TAIL = 8_192;

/** Starts processes with `child_process.spawn`, keeping the tail of their output. */
export class NodeLauncher implements ProcessLauncher {
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;

  /** `baseEnv` is what every system process inherits (boot passes the hub's own environment). */
  constructor(options: { baseEnv: Readonly<Record<string, string | undefined>> }) {
    this.#baseEnv = options.baseEnv;
  }

  launch(command: SystemCommand): SystemProcess {
    const child = spawn(command.run, command.args, {
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

/** Fetches systems with npm and git, and reads their `package.json`. */
export class NodeInstaller implements Installer {
  readonly #npm: string;
  readonly #git: string;

  constructor(options: { npm?: string; git?: string } = {}) {
    this.#npm = options.npm ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    this.#git = options.git ?? 'git';
  }

  async fetch(source: InstallSource, dir: string): Promise<SystemPackage> {
    if ('path' in source) { return this.describe(resolve(source.path)); }
    if ('package' in source) {
      await run(this.#npm, ['install', '--prefix', dir, '--omit=dev', '--no-save', `${source.package}@${source.version}`], { shell: process.platform === 'win32' });
      return this.describe(join(dir, 'node_modules', ...source.package.split('/')));
    }
    await run(this.#git, ['clone', '--depth', '1', '--branch', source.ref, source.git, dir]);
    await run(this.#npm, ['install', '--omit=dev'], { cwd: dir, shell: process.platform === 'win32' });
    return this.describe(dir);
  }

  async describe(dir: string): Promise<SystemPackage> {
    const json = SystemPackageJson.parse(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')));
    return { name: json.harness.name, version: json.version, entry: resolve(dir, json.harness.main), dir };
  }
}
