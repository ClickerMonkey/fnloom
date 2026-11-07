/**
 * Restarting and exiting the system process. A system the hub installed runs under the hub's supervisor: restarting
 * is exiting with the restart code, and the hub starts it again. A system started by hand restarts itself: it starts
 * a copy of the same command, then exits.
 */
import { spawn } from 'node:child_process';

/** What the runtime does to the process. An interface so tests don't end the test runner. */
export interface ProcessControl {
  /** Replace this process with a fresh one running the same code. Never returns. */
  restart(): Promise<never>;
  /** End this process. Never returns. */
  exit(code: number): Promise<never>;
}

/** The parts of Node that `NodeProcess` uses. The defaults are the real ones; tests pass their own. */
export interface ProcessSeams {
  /** Start a detached copy of this process's command, sharing its terminal. */
  spawnCopy(): void;
  /** End this process with an exit code. */
  exit(code: number): never;
}

/** Node's own process: spawn the same node binary with the same flags and arguments, and `process.exit`. */
const nodeSeams: ProcessSeams = {
  spawnCopy: () => {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', detached: true });
    child.unref();
  },
  exit: (code) => process.exit(code),
};

/** The real process. */
export class NodeProcess implements ProcessControl {
  readonly #supervised: boolean;
  readonly #restartCode: number;
  readonly #seams: ProcessSeams;

  constructor(options: { supervised: boolean; restartCode: number }, seams: ProcessSeams = nodeSeams) {
    this.#supervised = options.supervised;
    this.#restartCode = options.restartCode;
    this.#seams = seams;
  }

  restart(): Promise<never> {
    if (!this.#supervised) { this.#seams.spawnCopy(); }
    return this.exit(this.#supervised ? this.#restartCode : 0);
  }

  exit(code: number): Promise<never> {
    return this.#seams.exit(code);
  }
}
