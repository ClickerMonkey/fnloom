/**
 * Running `ollama serve` as a child process of the system: started on the instance's port with its models in the
 * instance's data folder, waited on until it answers, restarted after a crash with a growing wait (and left down,
 * `failed`, after too many crashes in an hour), stopped on request, and described for `ollama/status`. The program runs
 * directly (no shell) with a bare environment: the OS's essentials, the GPU names an admin passes on, and Ollama's own
 * settings. The process is behind `ChildRunner`, so tests use a fake; `NodeChildRunner` is the real one.
 */
import { spawn } from 'node:child_process';
import type { Log } from '@harness/sdk';
import type { ServerState } from '../shared/index.ts';

/** A started child process. */
export interface ChildHandle {
  readonly pid: number | undefined;
  /** Each line it prints, on stdout or stderr. */
  onLine(listener: (line: string) => void): void;
  /** Settles when it exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** Ask it to stop; `force` kills it. */
  kill(force: boolean): void;
}

/** Starts child processes. */
export interface ChildRunner {
  spawn(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): ChildHandle;
}

/** What to run: the program, where, and how. */
export interface ServeSpec {
  readonly binary: string;
  readonly host: string;
  readonly port: number;
  readonly modelsDir: string;
  readonly cwd: string;
  readonly contextLength?: number | undefined;
  readonly keepAlive?: string | undefined;
}

/** The tunables of running a server. */
export interface ServeLimits {
  readonly startTimeout: number;
  readonly healthEvery: number;
  readonly stopGrace: number;
  readonly restartDelay: number;
  readonly restartMax: number;
  readonly restartsPerHour: number;
  readonly outputLines: number;
}

/** A log line's fields, as the SDK's log takes them. */
export type LogFields = Parameters<Log['info']>[1];

/** What the supervisor is built from. */
export interface ServeParts {
  readonly runner: ChildRunner;
  /** Whether a server answers at an address now. */
  readonly answers: (url: string) => Promise<boolean>;
  /** This process's environment, from which the essentials and `passEnv` are copied. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly passEnv: readonly string[];
  readonly limits: ServeLimits;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (event: string, fields: LogFields) => void;
}

/** The OS essentials a program needs to run at all (temp folders, home, Windows' system folders). */
const ESSENTIAL_ENV = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LD_LIBRARY_PATH'];

/** The environment `ollama serve` runs with: the essentials and the passed names from `from`, then Ollama's own settings. */
export function serveEnv(spec: ServeSpec, from: Readonly<Record<string, string | undefined>>, pass: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ESSENTIAL_ENV, ...pass]) {
    const value = from[name];
    if (value !== undefined && value !== '') { env[name] = value; }
  }
  env['OLLAMA_HOST'] = `${spec.host.includes(':') && !spec.host.startsWith('[') ? `[${spec.host}]` : spec.host}:${spec.port}`;
  env['OLLAMA_MODELS'] = spec.modelsDir;
  if (spec.contextLength !== undefined) { env['OLLAMA_CONTEXT_LENGTH'] = String(spec.contextLength); }
  if (spec.keepAlive !== undefined) { env['OLLAMA_KEEP_ALIVE'] = spec.keepAlive; }
  return env;
}

/** The address a server listening on `host:port` answers at from this machine. */
export function localUrl(host: string, port: number): string {
  const reach = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${reach}:${port}`;
}

/** How the server is, for `ollama/status`. */
export interface ServeStatus {
  readonly state: ServerState;
  readonly pid?: number;
  readonly since?: number;
  readonly restartsLastHour: number;
  readonly lastExit?: { readonly code: number | null; readonly signal: string | null; readonly at: number };
  readonly problem?: string;
  readonly output: readonly string[];
}

/** One `ollama serve`, kept running while it is wanted. */
export class OllamaProcess {
  readonly #parts: ServeParts;
  #spec: ServeSpec | undefined;
  #state: ServerState = 'stopped';
  #child: ChildHandle | undefined;
  #since: number | undefined;
  #lastExit: ServeStatus['lastExit'];
  #problem: string | undefined;
  #crashes: number[] = [];
  /** Crashes in a row (without a run as long as the longest wait between), for the backoff. */
  #streak = 0;
  /** When it last started answering. */
  #runningSince: number | undefined;
  #wanted = false;
  #restart: AbortController | undefined;
  readonly #output: string[] = [];
  readonly #listeners = new Set<(state: ServerState) => void>();

  constructor(parts: ServeParts) {
    this.#parts = parts;
  }

  /** Hear every change of state (the system offers models once it is `running`). */
  onState(listener: (state: ServerState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  status(): ServeStatus {
    const hour = this.#parts.clock() - 3_600_000;
    return {
      state: this.#state,
      ...(this.#child?.pid === undefined ? {} : { pid: this.#child.pid }),
      ...(this.#since === undefined ? {} : { since: this.#since }),
      restartsLastHour: this.#crashes.filter((at) => at > hour).length,
      ...(this.#lastExit === undefined ? {} : { lastExit: this.#lastExit }),
      ...(this.#problem === undefined ? {} : { problem: this.#problem }),
      output: [...this.#output],
    };
  }

  /** Whether it runs (or is starting) with this spec. */
  runs(spec: ServeSpec): boolean {
    return this.#wanted && this.#spec !== undefined && JSON.stringify(this.#spec) === JSON.stringify(spec);
  }

  /**
   * Start it and wait until it answers. Refused while something else answers on its port (another Ollama), so a server
   * already running there is never disturbed. Resolves with the status; a start that fails leaves it `stopped` with why.
   */
  async start(spec: ServeSpec): Promise<ServeStatus> {
    if (this.#wanted && this.#state === 'running' && this.runs(spec)) { return this.status(); }
    if (this.#wanted) { await this.stop(); }
    const url = localUrl(spec.host, spec.port);
    if (await this.#parts.answers(url)) {
      this.#problem = `Something already answers at ${url}: another Ollama, or another program on port ${spec.port}. Stop it, or give this instance another port.`;
      this.#set('stopped');
      throw new Error(this.#problem);
    }
    this.#spec = spec;
    this.#wanted = true;
    this.#crashes = [];
    this.#streak = 0;
    this.#problem = undefined;
    await this.#launch();
    return this.status();
  }

  /** Stop it (no restart), killing it if it hasn't exited after the grace period. */
  async stop(): Promise<ServeStatus> {
    this.#wanted = false;
    this.#restart?.abort();
    this.#restart = undefined;
    const child = this.#child;
    if (child === undefined) {
      if (this.#state !== 'stopped') { this.#set('stopped'); }
      return this.status();
    }
    this.#set('stopping');
    child.kill(false);
    const exited = await Promise.race([child.exited.then(() => true), this.#parts.sleep(this.#parts.limits.stopGrace).then(() => false)]);
    if (!exited) {
      child.kill(true);
      await child.exited;
    }
    return this.status();
  }

  /** Start the child and wait for it to answer; a child that never answers is stopped and the start fails. */
  async #launch(): Promise<void> {
    const spec = this.#spec;
    if (spec === undefined) { return; }
    const { runner, env, passEnv, limits, clock, log } = this.#parts;
    this.#set('starting');
    const child = runner.spawn(spec.binary, ['serve'], { cwd: spec.cwd, env: serveEnv(spec, env, passEnv) });
    this.#child = child;
    this.#since = clock();
    child.onLine((line) => { this.#remember(line); });
    void child.exited.then((exit) => { this.#exited(child, exit); });
    log('ollama.server.spawned', { pid: child.pid ?? null, port: spec.port });
    const url = localUrl(spec.host, spec.port);
    const until = clock() + limits.startTimeout;
    while (this.#starting(child)) {
      if (await this.#parts.answers(url)) {
        if (this.#starting(child)) {
          this.#runningSince = clock();
          this.#set('running');
          log('ollama.server.running', { pid: child.pid ?? null, url });
        }
        return;
      }
      if (clock() >= until) {
        this.#problem = `Ollama didn't answer at ${url} within ${Math.round(limits.startTimeout / 1000)} s.`;
        await this.stop();
        throw new Error(this.#problem);
      }
      await this.#parts.sleep(limits.healthEvery);
    }
    if (this.#child !== child && this.#state !== 'running') { throw new Error(this.#problem ?? 'Ollama exited while starting.'); }
  }

  /** Whether this child is the one starting now (it may have exited, or been stopped, while it was waited on). */
  #starting(child: ChildHandle): boolean {
    return this.#child === child && this.#state === 'starting';
  }

  /** The child exited: if it was still wanted, that is a crash, restarted after a wait unless it crashes too often. */
  #exited(child: ChildHandle, exit: { code: number | null; signal: string | null }): void {
    if (this.#child !== child) { return; }
    const { clock, limits, log } = this.#parts;
    this.#child = undefined;
    this.#lastExit = { ...exit, at: clock() };
    this.#since = clock();
    if (!this.#wanted) {
      this.#set('stopped');
      return;
    }
    const now = clock();
    this.#crashes = [...this.#crashes.filter((at) => at > now - 3_600_000), now];
    // a run as long as the longest wait ends the streak: the next wait starts short again
    if (this.#runningSince !== undefined && now - this.#runningSince >= limits.restartMax) { this.#streak = 0; }
    this.#runningSince = undefined;
    this.#streak += 1;
    if (this.#crashes.length >= limits.restartsPerHour) {
      this.#wanted = false;
      this.#problem = `Ollama crashed ${this.#crashes.length} times in an hour (last exit code ${String(exit.code)}); it stays stopped until it is started again.`;
      log('ollama.server.failed', { crashes: this.#crashes.length, code: exit.code });
      this.#set('failed');
      return;
    }
    const wait = Math.min(limits.restartMax, limits.restartDelay * 2 ** (this.#streak - 1));
    this.#problem = `Ollama exited (code ${String(exit.code)}${exit.signal === null ? '' : `, ${exit.signal}`}); starting it again in ${Math.round(wait / 1000)} s.`;
    log('ollama.server.crashed', { code: exit.code, signal: exit.signal, wait });
    this.#set('crashed');
    const restart = new AbortController();
    this.#restart = restart;
    void this.#parts.sleep(wait, restart.signal).then(async () => {
      if (restart.signal.aborted || !this.#wanted) { return; }
      this.#restart = undefined;
      await this.#launch().catch((error: unknown) => { log('ollama.server.restart-failed', { error: error instanceof Error ? error.message : String(error) }); });
    }, () => undefined);
  }

  #remember(line: string): void {
    const max = this.#parts.limits.outputLines;
    if (max === 0) { return; }
    this.#output.push(line);
    if (this.#output.length > max) { this.#output.splice(0, this.#output.length - max); }
  }

  #set(state: ServerState): void {
    if (this.#state === state) { return; }
    this.#state = state;
    for (const listener of this.#listeners) { listener(state); }
  }
}

/** Real child processes: no shell, no window, output read line by line. */
export class NodeChildRunner implements ChildRunner {
  spawn(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): ChildHandle {
    const child = spawn(command, [...args], { cwd: options.cwd, env: { ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const listeners = new Set<(line: string) => void>();
    const read = (stream: NodeJS.ReadableStream): void => {
      let rest = '';
      stream.on('data', (chunk: Buffer) => {
        const lines = (rest + chunk.toString()).split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) { if (line !== '') { for (const listener of listeners) { listener(line); } } }
      });
    };
    read(child.stdout);
    read(child.stderr);
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
      child.on('exit', (code, signal) => { done({ code, signal }); });
      child.on('error', (error) => {
        for (const listener of listeners) { listener(`could not start ${command}: ${error.message}`); }
        done({ code: null, signal: null });
      });
    });
    return {
      pid: child.pid,
      onLine: (listener) => { listeners.add(listener); },
      exited,
      kill: (force) => {
        if (process.platform === 'win32' && child.pid !== undefined) {
          // Windows has no SIGTERM: end the process tree (ollama serve starts runners of its own)
          spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
          return;
        }
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
    };
  }
}
