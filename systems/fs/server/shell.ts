/**
 * Running commands: the shell `bash` uses (Git Bash on Windows when it is installed), programs run without a shell
 * (git, the file manager), the scrubbed environment commands start with, and output kept to a size with its end preserved.
 * The safe-command check is in `safe.ts`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { scrubbedEnv } from '@harness/sdk/server';
import type { CommandEnd, CommandProgress, CommandRun, Exec, Shell } from './index.ts';

/** Which shell runs command lines: a POSIX shell by path, or the platform's own (`cmd.exe`, `/bin/sh`). */
export type ShellChoice = { readonly type: 'posix'; readonly path: string } | { readonly type: 'system' };

/** Where Git for Windows puts bash. */
const WINDOWS_BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'];
const POSIX_BASH = ['/bin/bash', '/usr/bin/bash'];

/** Pick the shell: the configured one (`system` for the platform's own), else bash where it exists. */
export function chooseShell(configured: string | undefined, platform: NodeJS.Platform, exists: (path: string) => boolean): ShellChoice {
  if (configured === 'system') { return { type: 'system' }; }
  if (configured !== undefined) { return { type: 'posix', path: configured }; }
  const found = (platform === 'win32' ? WINDOWS_BASH : POSIX_BASH).find(exists);
  return found === undefined ? { type: 'system' } : { type: 'posix', path: found };
}

/**
 * The OS variables every command keeps besides those `scrubbedEnv` keeps (`PATH`, the temp folders): home, user,
 * locale, terminal, and the ones Windows programs need to start. Nothing that holds a key.
 */
export const COMMAND_BASICS: readonly string[] = [
  'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM', 'TZ',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT', 'WINDIR',
];

/**
 * The environment a `bash` command starts with: `scrubbedEnv` of fs's own (`PATH`, the OS basics), the
 * `COMMAND_BASICS`, and the names an admin allows (the fs config's `commandEnv`), matched without case. Never fs's
 * keys or anything else it was started with.
 */
export function commandEnv(base: Readonly<Record<string, string | undefined>>, allowed: readonly string[]): Record<string, string> {
  const wanted: ReadonlySet<string> = new Set([...COMMAND_BASICS, ...allowed].map((name) => name.toUpperCase()));
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && wanted.has(name.toUpperCase())) { extra[name] = value; }
  }
  return scrubbedEnv(base, extra);
}

/** Keeps the last `max` characters of a stream and counts what was cut. */
export class TailBuffer {
  private text = '';
  private cut = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max) {
      this.cut += this.text.length - this.max;
      this.text = this.text.slice(this.text.length - this.max);
    }
  }

  /** The last non-empty line so far. */
  lastLine(): string {
    const lines = this.text.split(/\r?\n/).filter((line) => line.trim() !== '');
    return lines[lines.length - 1] ?? '';
  }

  toString(): string {
    return this.cut === 0 ? this.text : `[${this.cut} earlier characters cut]\n${this.text}`;
  }
}

/** How processes are run. */
export interface ProcessLimits {
  /** Characters kept per stream. */
  readonly outputMax: number;
  /** How often progress is reported. */
  readonly progressEvery: number;
}

/** How long taskkill gets on Windows before the process itself is killed. */
const TREE_KILL_WAIT = 1_000;
/** How long a stopped process's output may stay open after it exits, held by something it started, before the run ends anyway. */
const CLOSE_GRACE = 250;

/** How a process and everything it started are stopped. One per run, since a tree may mark its processes. */
export interface ProcessTree {
  /** The environment the process starts with; `undefined` inherits this one. */
  readonly env: NodeJS.ProcessEnv | undefined;
  /** Stop the process and everything it started; `kill` ends the process itself. */
  stop(pid: number | undefined, kill: () => void): void;
}

/** A POSIX process group: the process starts detached as its leader, and the whole group is killed. */
export class GroupTree implements ProcessTree {
  readonly env: NodeJS.ProcessEnv | undefined;
  constructor(env?: NodeJS.ProcessEnv) {
    this.env = env;
  }

  stop(pid: number | undefined, kill: () => void): void {
    if (pid === undefined) { kill(); return; }
    try { process.kill(-pid, 'SIGKILL'); } catch { kill(); }
  }
}

/** A Windows process tree, walked by taskkill from the live parent. */
export class TaskTree implements ProcessTree {
  readonly env: NodeJS.ProcessEnv | undefined;
  constructor(env?: NodeJS.ProcessEnv) {
    this.env = env;
  }

  stop(pid: number | undefined, kill: () => void): void {
    if (pid === undefined) { kill(); return; }
    // the parent is killed directly only once taskkill is done (or has had long enough on a loaded machine), since
    // taskkill walks the tree from it; killing a dead process is a no-op.
    const fallback = setTimeout(kill, TREE_KILL_WAIT);
    const after = () => { clearTimeout(fallback); kill(); };
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', after).on('exit', after);
  }
}

/** The variable that marks every process of one MSYS run. */
const RUN_MARK = 'HARNESS_FS_RUN';

/**
 * A POSIX shell from MSYS or Cygwin (Git Bash) on Windows. Its programs are started the MSYS way, so taskkill can't
 * follow them from the shell: `sleep` under `bash -c` outlives the shell and holds its output open. Every process of a
 * run carries a marker variable instead, and stopping kills each MSYS process that has it, as well as the taskkill tree.
 */
export class MsysTree extends TaskTree {
  override readonly env: NodeJS.ProcessEnv;
  private readonly bash: string;
  private readonly mark: string;

  constructor(bash: string, env: NodeJS.ProcessEnv = process.env) {
    super();
    this.bash = bash;
    this.mark = randomUUID();
    this.env = { ...env, [RUN_MARK]: this.mark };
  }

  override stop(pid: number | undefined, kill: () => void): void {
    // the sweeping shell starts with this process's environment, which has no marker, so it never matches itself
    const sweep = `for p in /proc/[0-9]*; do grep -qz '^${RUN_MARK}=${this.mark}$' "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`;
    spawn(this.bash, ['-c', sweep], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    super.stop(pid, kill);
  }
}

/** The tree for programs this platform starts itself. */
export function platformTree(env?: NodeJS.ProcessEnv): ProcessTree {
  return process.platform === 'win32' ? new TaskTree(env) : new GroupTree(env);
}

/** Exit codes reported when a command didn't end on its own: 124 (timeout) and 130 (interrupted), as shells do. */
const END_CODES: Record<Exclude<CommandEnd, 'exit'>, number> = { timeout: 124, cancelled: 130 };
/** The exit code shells report for a program that couldn't be started. */
export const NOT_STARTED = 127;

/** Run a program to the end, its timeout or its signal, keeping the end of its output. */
export function runProcess(
  file: string, args: readonly string[],
  options: {
    cwd?: string | undefined; timeout: number; signal?: AbortSignal | undefined; onOutput?: CommandProgress | undefined; shell?: boolean;
    /** How it and what it starts are stopped; the platform's own way by default. */
    tree?: ProcessTree | undefined;
  },
  limits: ProcessLimits,
): Promise<CommandRun> {
  return new Promise((done) => {
    const stdout = new TailBuffer(limits.outputMax);
    const stderr = new TailBuffer(limits.outputMax);
    const started = performance.now();
    const tree = options.tree ?? platformTree();
    let ended: CommandEnd = 'exit';
    let settled = false;
    const child = spawn(file, args, {
      cwd: options.cwd, env: tree.env, windowsHide: true, detached: process.platform !== 'win32', shell: options.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = (why: Exclude<CommandEnd, 'exit'>) => {
      if (ended !== 'exit') { return; }
      ended = why;
      tree.stop(child.pid, () => child.kill('SIGKILL'));
    };
    const timer = setTimeout(() => { stop('timeout'); }, options.timeout);
    const onAbort = () => { stop('cancelled'); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const report = () => { options.onOutput?.(Math.min((performance.now() - started) / options.timeout, 0.99), stdout.lastLine() || stderr.lastLine()); };
    const ticker = options.onOutput === undefined ? undefined : setInterval(report, limits.progressEvery);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout.push(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr.push(chunk); });
    const finish = (exitCode: number) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (ticker !== undefined) { clearInterval(ticker); }
      options.signal?.removeEventListener('abort', onAbort);
      done({ exitCode, stdout: stdout.toString(), stderr: stderr.toString(), ended });
    };
    child.on('error', (error) => { stderr.push(error.message); finish(NOT_STARTED); });
    child.on('close', (code) => { finish(ended === 'exit' ? (code ?? 1) : END_CODES[ended]); });
    // a stopped process may leave something behind that still holds its output open; the run ends shortly after it does
    child.on('exit', () => {
      if (ended === 'exit') { return; }
      const why = ended;
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(END_CODES[why]);
      }, CLOSE_GRACE).unref();
    });
    if (options.signal?.aborted === true) { onAbort(); }
  });
}

/** The tree for a POSIX shell: on Windows it is an MSYS one (Git Bash, Cygwin), whose programs taskkill can't follow. */
export function posixTree(path: string, platform: NodeJS.Platform = process.platform, env?: NodeJS.ProcessEnv): ProcessTree {
  return platform === 'win32' ? new MsysTree(path, env) : new GroupTree(env);
}

/** The real shell. */
export class NodeShell implements Shell {
  private readonly choice: ShellChoice;
  private readonly limits: ProcessLimits;
  constructor(choice: ShellChoice, limits: ProcessLimits) {
    this.choice = choice;
    this.limits = limits;
  }

  run(input: Parameters<Shell['run']>[0]): Promise<CommandRun> {
    const options = { cwd: input.cwd, timeout: input.timeout, signal: input.signal, onOutput: input.onOutput };
    return this.choice.type === 'posix'
      ? runProcess(this.choice.path, ['-c', input.command], { ...options, tree: posixTree(this.choice.path, process.platform, input.env) }, this.limits)
      : runProcess(input.command, [], { ...options, shell: true, tree: platformTree(input.env) }, this.limits);
  }
}

/** Runs programs directly. */
export class NodeExec implements Exec {
  private readonly limits: ProcessLimits;
  constructor(limits: ProcessLimits) {
    this.limits = limits;
  }

  exec(file: string, args: readonly string[], options: Parameters<Exec['exec']>[2]): Promise<CommandRun> {
    const { env, ...rest } = options;
    return runProcess(file, args, { ...rest, ...(env === undefined ? {} : { tree: platformTree(env) }) }, this.limits);
  }
}
