/**
 * Keeps a dev process up: when it exits, or stops answering while its process still runs (under `tsx watch` a crashed
 * script leaves the watcher waiting for a change, so the process never exits), it is restarted after a short delay,
 * and why is written to the crash log with the last lines it printed. Only `npm run dev` supervises; tests don't.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** How long a process may stay silent before it is restarted, and how long to wait before restarting. */
export interface SuperviseOptions {
  /** Wait this long after a crash before starting again (ms). */
  readonly delay: number;
  /** Check that it answers this often (ms). */
  readonly every: number;
  /** Restart after this many checks in a row that it didn't answer. */
  readonly misses: number;
  /** The crash log (`<data>/logs/crashes.log`). */
  readonly log: string;
}

/** A process under supervision: started by `start`, checked by `alive`, stopped by `halt`. */
export interface SupervisedProcess<C> {
  readonly name: string;
  start(): C;
  /** Whether it answers (the hub's `/readyz`, a system connected to the hub). */
  alive(): Promise<boolean>;
  exited(child: C): Promise<number | null>;
  halt(child: C): Promise<void>;
  /** Its last lines of output, for the crash log. */
  recent(): readonly string[];
}

/** Write one crash to the log. */
export function logCrash(file: string, name: string, why: string, lines: readonly string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${new Date().toISOString()} ${name} restarted: ${why}\n${lines.map((line) => `  ${line}`).join('\n')}\n\n`);
}

/** The supervisor of one process; `stop()` ends supervision and the process. */
export class Supervisor<C> {
  readonly #target: SupervisedProcess<C>;
  readonly #options: SuperviseOptions;
  #child: C;
  #stopped = false;
  #missed = 0;
  #restarting = false;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(target: SupervisedProcess<C>, options: SuperviseOptions) {
    this.#target = target;
    this.#options = options;
    this.#child = this.#run();
    this.#timer = setInterval(() => { void this.#check(); }, options.every);
  }

  /** The current process. */
  get child(): C {
    return this.#child;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#target.halt(this.#child);
  }

  /** Read through a method, so a check after an `await` sees a stop that happened meanwhile. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  #run(): C {
    const child = this.#target.start();
    void this.#target.exited(child).then((code) => {
      if (!this.#stopped && child === this.#child) { void this.#restart(`it exited with code ${String(code)}`); }
    });
    return child;
  }

  async #check(): Promise<void> {
    if (this.#stopped || this.#restarting) { return; }
    const alive = await this.#target.alive().catch(() => false);
    this.#missed = alive ? 0 : this.#missed + 1;
    if (this.#missed >= this.#options.misses) { await this.#restart(`it did not answer for ${String(this.#missed)} checks in a row`); }
  }

  async #restart(why: string): Promise<void> {
    if (this.#restarting || this.#stopped) { return; }
    this.#restarting = true;
    logCrash(this.#options.log, this.#target.name, why, this.#target.recent());
    console.warn('dev.restarting', { component: this.#target.name, why, log: this.#options.log });
    await this.#target.halt(this.#child);
    await new Promise((done) => setTimeout(done, this.#options.delay));
    this.#missed = 0;
    if (!this.#isStopped()) { this.#child = this.#run(); }
    this.#restarting = false;
  }
}
