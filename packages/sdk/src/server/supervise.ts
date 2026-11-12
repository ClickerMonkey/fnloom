/**
 * Supervising system processes, shared by the hub's supervisor and by systems that host others (fs's
 * `install_system`): a launcher that gives a child only an allowlisted environment and runs it under Node's
 * permission model, and the crash policy (restart with backoff, give up after too many crashes in an hour).
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { backoff } from '@ayepi/core/retry';
import type { RestartPolicy, SystemPackageManifest } from '@harness/core';
import { z } from 'zod';
import { SYSTEM_ENV, sdkEnv } from './env.ts';

/** Where a running system is (`RunningSystem.status`). */
export const RunningStatus = z.enum(['connecting', 'pairing', 'needs-config', 'connected', 'disconnected', 'stopped']);
export type RunningStatus = z.infer<typeof RunningStatus>;

/** The log key a system writes its status changes under. A supervisor reads them from a child's JSON log lines (`HARNESS_LOG_JSON`). */
export const STATUS_LOG = 'system.status';

/** A status change as a JSON log line. */
const StatusLine = z.object({ msg: z.literal(STATUS_LOG), status: RunningStatus });

/** The status a line of a child's JSON log reports, if it is a status line. */
export function statusOfLine(line: string): RunningStatus | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) { return undefined; }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = StatusLine.safeParse(json);
  return parsed.success ? parsed.data.status : undefined;
}

/** A file access Node's permission model refused, as the child printed it. */
export interface AccessDenied {
  /** `FileSystemRead` or `FileSystemWrite` (or another of Node's permission scopes). */
  readonly permission: string;
  /** The path, when the error named it. */
  readonly resource?: string;
}

/** A quoted value in an error's printed fields (`  resource: '...'`), unescaped. */
function fieldOf(line: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}: '(.*)',?$`).exec(line);
  return match?.[1]?.replace(/\\\\/g, '\\');
}

/**
 * Reads a child's output for the errors Node's permission model throws (`code: 'ERR_ACCESS_DENIED'` with its
 * `permission` and `resource` fields, as an uncaught error prints them), so a supervisor can report the refusal.
 */
export class AccessDeniedReader {
  #open = false;
  #permission: string | undefined;

  /** Feed one line; returns the refusal once its error has been read through. */
  line(line: string): AccessDenied | undefined {
    if (/code: 'ERR_ACCESS_DENIED'/.test(line)) {
      this.#open = true;
      this.#permission = undefined;
      return undefined;
    }
    if (!this.#open) { return undefined; }
    const permission = fieldOf(line, 'permission');
    if (permission !== undefined) { this.#permission = permission; return undefined; }
    // Windows paths come in their long form (`\\?\C:\...`)
    const resource = fieldOf(line, 'resource')?.replace(/^\\\\\?\\/, '');
    if (resource === undefined && !/^\s*\}/.test(line)) { return undefined; }
    this.#open = false;
    return { permission: this.#permission ?? 'FileSystem', ...(resource === undefined ? {} : { resource }) };
  }
}

/** How to run a process: the program, its arguments, its working folder and the variables it adds. */
export interface ProcessCommand {
  readonly run: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  /** Set on top of the scrubbed environment (the instance's identity, `SYSTEM_ENV`, goes here). */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Called with each piece of what it prints (stdout and stderr) as it comes; pieces may split lines. */
  readonly onOutput?: ((text: string) => void) | undefined;
}

/** How a process ended. */
export interface ProcessExit {
  /** Its exit code: 1 for a signal, -1 when it never started. */
  readonly code: number;
  /** The end of what it printed. */
  readonly output: string;
}

/** A running process. */
export interface SupervisedProcess {
  readonly pid: number | undefined;
  /** Settles once, when the process exits (or fails to start, with code -1). */
  readonly exited: Promise<ProcessExit>;
  kill(): void;
}

/** Starts processes. An interface so supervisors can be tested without real processes. */
export interface ProcessStarter {
  launch(command: ProcessCommand): SupervisedProcess;
}

/** The OS variables a child keeps (matched without case, as Windows names them `Path`, `SystemRoot`, ...). */
export const BASIC_ENV = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'] as const;

/** The instance identity variables: a child never inherits these from its parent, only from its own command. */
const IDENTITY_ENV: ReadonlySet<string> = new Set(Object.values(SYSTEM_ENV));

/**
 * The harness variables a child inherits, by name: the SDK runtime tunables (`sdkEnv`: link timing, log level, ...),
 * never the parent's instance identity. An explicit list, not a `HARNESS_` prefix, so a parent's own settings and
 * secrets (the hub's admin password, signing and encryption keys) never reach a child.
 */
export const SHARED_ENV: readonly string[] = sdkEnv.describe().flatMap((field) => field.vars).filter((name) => !IDENTITY_ENV.has(name));

/**
 * The environment a supervised child gets: from `base`, only `PATH`, the OS basics (`BASIC_ENV`) and the SDK
 * tunables (`SHARED_ENV`), never the parent's identity, keys or anything else, then `extra` on top.
 */
export function scrubbedEnv(base: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const basics: ReadonlySet<string> = new Set(BASIC_ENV);
  const shared: ReadonlySet<string> = new Set(SHARED_ENV);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) { continue; }
    if (basics.has(name.toUpperCase()) || shared.has(name)) { kept[name] = value; }
  }
  return { ...kept, ...extra };
}

/** What a child may touch under Node's permission model. */
export interface ProcessGrants {
  /** Folders and files it may read (its bundle, its folders, the loader it runs under). */
  readonly read: readonly string[];
  /** Folders it may write (its state, data and cache). Writable folders are readable too. */
  readonly write: readonly string[];
  /** What `system.json`'s `permissions` declares; both default to no. */
  readonly permissions?: SystemPackageManifest['permissions'];
}

/**
 * The Node flags that run a child under the permission model (stable in Node 22.13+): `--permission`, one
 * `--allow-fs-read` / `--allow-fs-write` per absolute path, and `--allow-child-process` / `--allow-worker` only when
 * declared.
 */
export function permissionArgs(grants: ProcessGrants): string[] {
  const unique = (paths: readonly string[]) => [...new Set(paths.map((path) => resolve(path)))];
  const writes = unique(grants.write);
  const reads = unique([...grants.read, ...grants.write]);
  return [
    '--permission',
    ...reads.map((path) => `--allow-fs-read=${path}`),
    ...writes.map((path) => `--allow-fs-write=${path}`),
    ...(grants.permissions?.childProcess === true ? ['--allow-child-process'] : []),
    ...(grants.permissions?.workers === true ? ['--allow-worker'] : []),
  ];
}

/** How `NodeStarter` starts children. */
export interface NodeStarterOptions {
  /** The parent's environment; a child gets only what `scrubbedEnv` keeps of it. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Node flags put first when a command runs this Node binary (the parent's loader, e.g. tsx; `permissionArgs`). */
  readonly nodeArgs?: readonly string[] | undefined;
  /** Characters of output kept for the exit report (`HARNESS_SUPERVISE_OUTPUT_TAIL`). */
  readonly outputTail: number;
}

/** Starts processes with `child_process.spawn`, with a scrubbed environment, keeping the tail of their output. */
export class NodeStarter implements ProcessStarter {
  readonly #options: NodeStarterOptions;

  constructor(options: NodeStarterOptions) {
    this.#options = options;
  }

  launch(command: ProcessCommand): SupervisedProcess {
    const { baseEnv, nodeArgs = [], outputTail } = this.#options;
    const args = command.run === process.execPath ? [...nodeArgs, ...command.args] : [...command.args];
    const child = spawn(command.run, args, {
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      env: scrubbedEnv(baseEnv, command.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const keep = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-outputTail);
      command.onOutput?.(text);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const exited = new Promise<ProcessExit>((done) => {
      child.once('error', (error) => { done({ code: -1, output: `${output}\n${error.message}`.slice(-outputTail) }); });
      child.once('exit', (code, signal) => { done({ code: code ?? (signal === null ? 0 : 1), output }); });
    });
    return { pid: child.pid, exited, kill: () => { child.kill(); } };
  }
}

/** What to do after a process exits. */
export type ExitDecision =
  | { readonly action: 'stopped' }
  | { readonly action: 'restart-now' }
  | { readonly action: 'restart'; readonly wait: number; readonly crashes: number }
  | { readonly action: 'give-up'; readonly crashes: number };

/** An hour, the window crashes are counted in. */
const HOUR = 3_600_000;

/** How `CrashPolicy` decides. */
export interface CrashPolicyOptions {
  /** The longest wait between restarts (`HARNESS_SUPERVISE_BACKOFF_MAX`). */
  readonly maxWait: number;
  /** The exit code that asks for an immediate restart (`RESTART_CODE` unless the supervisor sets another). */
  readonly restartCode: number;
  readonly clock?: (() => number) | undefined;
}

/**
 * The restart rule for supervised processes, one per supervisor, keyed by instance: an asked-for stop or a clean exit
 * (for `on-failure`) stops; the restart code restarts at once; a crash restarts after `backoff`, doubling with each
 * crash in the last hour, and more than `maxPerHour` crashes in an hour gives up (the caller may roll back).
 */
export class CrashPolicy {
  readonly #options: CrashPolicyOptions;
  readonly #crashes = new Map<string, number[]>();

  constructor(options: CrashPolicyOptions) {
    this.#options = options;
  }

  /** Decide what follows `exit` of the instance `key`, run under `policy`; `stopping` when the stop was asked for. */
  decide(key: string, policy: RestartPolicy, exit: Pick<ProcessExit, 'code'>, stopping: boolean): ExitDecision {
    if (stopping) { return { action: 'stopped' }; }
    if (exit.code === this.#options.restartCode) { return { action: 'restart-now' }; }
    if (policy.policy === 'never' || (policy.policy === 'on-failure' && exit.code === 0)) { return { action: 'stopped' }; }
    const now = (this.#options.clock ?? Date.now)();
    const crashes = [...(this.#crashes.get(key) ?? []).filter((at) => at > now - HOUR), now];
    this.#crashes.set(key, crashes);
    if (crashes.length > policy.maxPerHour) { return { action: 'give-up', crashes: crashes.length }; }
    const wait = backoff(crashes.length, { base: policy.backoff, max: this.#options.maxWait, jitter: 0 });
    return { action: 'restart', wait, crashes: crashes.length };
  }

  /** Forget an instance's crashes (after a rollback, a new version or an uninstall). */
  forget(key: string): void {
    this.#crashes.delete(key);
  }
}
