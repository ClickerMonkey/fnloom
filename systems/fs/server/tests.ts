/**
 * `SystemTests` in a sandboxed child process: install_system runs a folder's own tests (the SDK test kit, through
 * `@harness/build`'s `runSystemTests`) before its install card is shown, so the card carries their result beside the
 * scan. The code is not approved yet, so the child gets:
 *
 * - a scrubbed environment (`scrubbedEnv`: no keys, tokens or the hub's secrets);
 * - Node's permission model: it may read files, but write only the folder's own `.harness-test` and the temp folder.
 *   Vitest needs workers, child processes and native addons (its bundler), so those are allowed, which Node says can
 *   weaken the model; the network is not limited by Node at all (see the report's open issues);
 * - a time limit (`FS_TESTS_TIMEOUT`), and the run's cancel.
 *
 * The child (`run-tests.ts`) prints the report as its last line; anything else is a refusal with its output.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  run(file: string, args: readonly string[], options: { env: Record<string, string>; timeout: number; signal: AbortSignal }): Promise<ChildRun>;
}

/** The most output kept from the child (a big suite's report fits well inside it). */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** `ChildRunner` over `execFile`: no shell, the output kept whole up to `MAX_OUTPUT`. */
export const NODE_CHILD: ChildRunner = {
  run: (file, args, options) => new Promise((resolve) => {
    execFile(file, [...args], { env: options.env, timeout: options.timeout, signal: options.signal, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout, stderr });
    });
  }),
};

/** The child script beside this file. */
const SCRIPT = fileURLToPath(new URL('./run-tests.ts', import.meta.url));

/** The child's last line: the report, or `null` when the folder has no tests. */
const ChildAnswer = z.union([SystemTestReport, z.null()]);

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
}

/** A folder's tests in a sandboxed child process (see the module doc). */
export class ProcessSystemTests implements SystemTests {
  readonly #options: ProcessTestsOptions;

  constructor(options: ProcessTestsOptions) {
    this.#options = options;
  }

  /** The Node flags that sandbox a run of `dir`'s tests. */
  sandboxArgs(dir: string): string[] {
    return [
      '--permission', '--allow-fs-read=*',
      `--allow-fs-write=${join(dir, '.harness-test')}`, `--allow-fs-write=${this.#options.tempDir ?? tmpdir()}`,
      '--allow-worker', '--allow-child-process', '--allow-addons',
    ];
  }

  async run(dir: string, signal: AbortSignal): Promise<SystemTestReport | undefined> {
    const { nodeArgs, baseEnv, timeout } = this.#options;
    const child = this.#options.child ?? NODE_CHILD;
    const ran = await child.run(process.execPath, [...this.sandboxArgs(dir), ...nodeArgs, SCRIPT, dir], { env: scrubbedEnv(baseEnv), timeout, signal });
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
