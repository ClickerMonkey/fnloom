/**
 * Running commands: the shell `bash` uses (Git Bash on Windows when it is installed), programs run without a shell
 * (git, the file manager), the safe-command check, and output kept to a size with its end preserved.
 */
import { spawn } from 'node:child_process';
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

/** Characters that chain, redirect or substitute, so a command with them is never "safe" by its prefix. */
const CHAINING = [';', '&', '|', '>', '<', '`', '$(', '\n', '\r'];

/** Whether a command runs without asking: exactly a safe prefix, or one followed by arguments, with no chaining. */
export function isSafe(command: string, safe: readonly string[]): boolean {
  const line = command.trim();
  if (CHAINING.some((mark) => line.includes(mark))) { return false; }
  return safe.some((prefix) => line === prefix || line.startsWith(`${prefix} `));
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

/** Stop a process and everything it started. */
function killTree(pid: number | undefined, kill: () => void): void {
  if (pid === undefined) { kill(); return; }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', kill);
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { kill(); }
}

/** Exit codes reported when a command didn't end on its own: 124 (timeout) and 130 (interrupted), as shells do. */
const END_CODES: Record<Exclude<CommandEnd, 'exit'>, number> = { timeout: 124, cancelled: 130 };
/** The exit code shells report for a program that couldn't be started. */
export const NOT_STARTED = 127;

/** Run a program to the end, its timeout or its signal, keeping the end of its output. */
export function runProcess(
  file: string, args: readonly string[],
  options: { cwd?: string | undefined; timeout: number; signal?: AbortSignal | undefined; onOutput?: CommandProgress | undefined; shell?: boolean },
  limits: ProcessLimits,
): Promise<CommandRun> {
  return new Promise((done) => {
    const stdout = new TailBuffer(limits.outputMax);
    const stderr = new TailBuffer(limits.outputMax);
    const started = performance.now();
    let ended: CommandEnd = 'exit';
    const child = spawn(file, args, { cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32', shell: options.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (why: Exclude<CommandEnd, 'exit'>) => {
      if (ended !== 'exit') { return; }
      ended = why;
      killTree(child.pid, () => child.kill('SIGKILL'));
    };
    const timer = setTimeout(() => { stop('timeout'); }, options.timeout);
    const onAbort = () => { stop('cancelled'); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const report = () => { options.onOutput?.(Math.min((performance.now() - started) / options.timeout, 0.99), stdout.lastLine() || stderr.lastLine()); };
    const ticker = options.onOutput === undefined ? undefined : setInterval(report, limits.progressEvery);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout.push(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr.push(chunk); });
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      if (ticker !== undefined) { clearInterval(ticker); }
      options.signal?.removeEventListener('abort', onAbort);
      done({ exitCode, stdout: stdout.toString(), stderr: stderr.toString(), ended });
    };
    child.on('error', (error) => { stderr.push(error.message); finish(NOT_STARTED); });
    child.on('close', (code) => { finish(ended === 'exit' ? (code ?? 1) : END_CODES[ended]); });
    if (options.signal?.aborted === true) { onAbort(); }
  });
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
      ? runProcess(this.choice.path, ['-c', input.command], options, this.limits)
      : runProcess(input.command, [], { ...options, shell: true }, this.limits);
  }
}

/** Runs programs directly. */
export class NodeExec implements Exec {
  private readonly limits: ProcessLimits;
  constructor(limits: ProcessLimits) {
    this.limits = limits;
  }

  exec(file: string, args: readonly string[], options: Parameters<Exec['exec']>[2]): Promise<CommandRun> {
    return runProcess(file, args, options, this.limits);
  }
}
