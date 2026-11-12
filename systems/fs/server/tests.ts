/**
 * `SystemTests` in a sandboxed child process: install_system runs a folder's own tests (the SDK test kit, through
 * `@harness/build`'s `runSystemTests`) before its install card is shown, so the card carries their result beside the
 * scan. The code is not approved yet, so it runs in two layers of processes:
 *
 * - The runner (`run-tests.ts`) runs only trusted code: vitest, vite and the Vue plugin, never the folder's own config
 *   (`TestRunOptions.sandbox`). It transforms the test files and starts the processes that run them, so it needs
 *   child processes, workers and native addons (vite's bundler), and those are allowed to it alone.
 * - The test processes (vitest's `forks` pool, started with `testArgs`) run the folder's code with no child
 *   processes, workers or addons, and with the network shut (`network-guard.ts`, since Node 22's permission model
 *   doesn't limit it).
 *
 * Both get a scrubbed environment (`scrubbedEnv`: no keys, tokens or the hub's secrets), and Node's permission model
 * lets them read only the folder, the temp folder and the code the tests run on (`readRoots`: the harness install's
 * `node_modules`, `packages` and `systems`, its top-level config files, and the repos of the libraries linked into
 * `node_modules`), never the hub's or fs's data folders, and write only the folder's own `.harness-test` and the temp
 * folder. The run has a time limit (`FS_TESTS_TIMEOUT`) and the run's cancel.
 *
 * The runner prints the report as its last line; anything else is a refusal with its output.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemTestReport } from '@harness/core';
import { scrubbedEnv } from '@harness/sdk/server';
import { z } from 'zod';
import { InstallRefused, type SystemTests } from './hosting.ts';

/** What the child printed and how it ended. */
export interface ChildRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the child. An interface so tests use a fake. */
export interface ChildRunner {
  run(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; timeout: number; signal: AbortSignal }): Promise<ChildRun>;
}

/** The most output kept from the child (a big suite's report fits well inside it). */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** `ChildRunner` over `execFile`: no shell, the output kept whole up to `MAX_OUTPUT`. */
export const NODE_CHILD: ChildRunner = {
  run: (file, args, options) => new Promise((resolve) => {
    execFile(file, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeout, signal: options.signal, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout, stderr });
    });
  }),
};

/** The child script beside this file. */
const SCRIPT = fileURLToPath(new URL('./run-tests.ts', import.meta.url));
/** What the test processes load first to shut the network. */
const NETWORK_GUARD = new URL('./network-guard.ts', import.meta.url).href;

/** The child's last line: the report, or `null` when the folder has no tests. */
const ChildAnswer = z.union([SystemTestReport, z.null()]);

/** The top-level folders of an install that hold code (never its data folders, which start with a dot or are elsewhere). */
const CODE_FOLDERS = ['node_modules', 'packages', 'systems'] as const;

/** Every folder at or above `from` that holds `node_modules` (fs's own package and the harness install it is in). */
export function installRoots(from: string): string[] {
  const found: string[] = [];
  for (let dir = from, up = dirname(dir); ; dir = up, up = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) { found.push(dir); }
    if (up === dir) { return found; }
  }
}

/** The files vite looks for in each folder above a test root to find its workspace root (none of them are data). */
const WORKSPACE_PROBES = ['package.json', 'pnpm-workspace.yaml', 'lerna.json', 'deno.json', 'deno.jsonc'] as const;

/** Those files in `dir` and every folder above it, so vite's search may look at them (a file grant, not a folder's). */
export function workspaceProbes(dir: string): string[] {
  const found: string[] = [];
  for (let at = dir, up = dirname(at); ; at = up, up = dirname(at)) {
    found.push(...WORKSPACE_PROBES.map((file) => join(at, file)));
    if (up === at) { return found; }
  }
}

/** Whether `path` is inside `root`. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A folder's entries, none when it can't be read. */
function entries(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * What a sandboxed test run may read besides its folder and the temp folder: the install's code folders and top-level
 * files (not its dot folders, where data lives), and for each package linked into `node_modules` from outside the
 * install (`file:` deps such as `@aeye/*`), its repo's `packages` and `node_modules` and its root files.
 */
export function readRoots(root: string): string[] {
  const roots = new Set<string>();
  const repo = (dir: string): void => {
    for (const entry of entries(dir)) {
      if (entry.isFile() && !entry.name.startsWith('.')) { roots.add(join(dir, entry.name)); }
    }
    for (const folder of CODE_FOLDERS) { if (existsSync(join(dir, folder))) { roots.add(join(dir, folder)); } }
  };
  repo(root);
  const modules = join(root, 'node_modules');
  const linked = entries(modules).flatMap((entry) => entry.name.startsWith('@')
    ? entries(join(modules, entry.name)).map((scoped) => join(modules, entry.name, scoped.name))
    : [join(modules, entry.name)]);
  for (const path of linked) {
    if (!lstatSync(path).isSymbolicLink()) { continue; }
    const real = realpathSync(path);
    if (inside(root, real)) { continue; }
    // a monorepo package (`<repo>/packages/<name>`) brings its repo; a lone linked folder only itself
    const parent = dirname(real);
    if (basename(parent) === 'packages') { repo(dirname(parent)); } else { roots.add(real); }
  }
  return [...roots].sort();
}

/** What `ProcessSystemTests` is built from. */
export interface ProcessTestsOptions {
  /** The Node flags that load the TypeScript loader fs runs under (`tsxLoader`). */
  readonly nodeArgs: readonly string[];
  /** The environment to scrub for the child (fs's own). */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly timeout: number;
  readonly child?: ChildRunner;
  /** The temp folder the child may write (default the system's). */
  readonly tempDir?: string;
  /** What the child may read besides the folder and the temp folder (default `readRoots` of fs's install). */
  readonly reads?: readonly string[];
}

/** A folder's tests in a sandboxed child process (see the module doc). */
export class ProcessSystemTests implements SystemTests {
  readonly #options: ProcessTestsOptions;

  constructor(options: ProcessTestsOptions) {
    this.#options = options;
  }

  /** The permission model's file grants for a run of `dir`'s tests (both layers). */
  fileArgs(dir: string): string[] {
    const temp = this.#options.tempDir ?? tmpdir();
    const reads = this.#options.reads ?? installRoots(dirname(SCRIPT)).flatMap(readRoots);
    // tsx asks whether the file system is case-sensitive by looking for the cwd (the folder) with its letters' case
    // swapped; the permission model compares paths as written, so that spelling of the folder is granted too
    const swapped = dir.replace(/\p{L}/gu, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    return [
      '--permission', ...[...new Set([dir, swapped, temp, ...reads, ...workspaceProbes(dir)])].map((path) => `--allow-fs-read=${path}`),
      `--allow-fs-write=${join(dir, '.harness-test')}`, `--allow-fs-write=${temp}`,
    ];
  }

  /** The Node flags of the runner, which runs only vitest and vite: the file grants, and processes, workers and addons. */
  sandboxArgs(dir: string): string[] {
    return [...this.fileArgs(dir), '--allow-worker', '--allow-child-process', '--allow-addons'];
  }

  /**
   * The Node flags of the processes that run the test files: the file grants only, and the network shut. No TypeScript
   * loader: tsx's needs a worker, and vite transforms the test files (Node strips the guard's types itself).
   */
  testArgs(dir: string): string[] {
    return [...this.fileArgs(dir), '--import', NETWORK_GUARD];
  }

  /**
   * The child's environment: the OS basics only (`scrubbedEnv`), with the user data folder (where vitest keeps its API
   * token) moved into the temp folder the child may write.
   */
  childEnv(): Record<string, string> {
    const data = join(this.#options.tempDir ?? tmpdir(), 'harness-tests');
    return { ...scrubbedEnv(this.#options.baseEnv), LOCALAPPDATA: data, XDG_DATA_HOME: data };
  }

  async run(dir: string, signal: AbortSignal): Promise<SystemTestReport | undefined> {
    const { nodeArgs, timeout } = this.#options;
    const child = this.#options.child ?? NODE_CHILD;
    const ran = await child.run(process.execPath, [...this.sandboxArgs(dir), ...nodeArgs, SCRIPT, dir, JSON.stringify(this.testArgs(dir))], { cwd: dir, env: this.childEnv(), timeout, signal });
    const last = ran.stdout.trimEnd().split('\n').at(-1) ?? '';
    let answer: unknown;
    try {
      answer = JSON.parse(last);
    } catch {
      answer = undefined;
    }
    const parsed = ChildAnswer.safeParse(answer);
    if (!parsed.success) {
      const tail = `${ran.stderr}\n${ran.stdout}`.trim().slice(-2_000);
      throw new InstallRefused(`Its tests didn't run (${ran.code === null ? 'stopped or timed out' : `exit ${ran.code}`}):\n${tail}`);
    }
    return parsed.data ?? undefined;
  }
}
