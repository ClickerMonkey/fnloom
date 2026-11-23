/**
 * Dependency-ordered async work that reads as its data flow. A `flow()` is a list of named steps; a step names the
 * steps it needs and receives their values, so the call itself shows what waits on what:
 *
 * ```ts
 * const { record, usable, unit } = await flow({ signal })
 *   .step('record', () => catalog.context(name))
 *   .step('usable', ['record'], ({ record }) => record !== undefined && usable(record))
 *   .step('imports', () => withImports(catalog, [name]))
 *   .step('unit', ['record', 'imports'], ({ record, imports }) => unitOf(record, imports))
 *   .run();
 * ```
 *
 * `record` and `imports` start together; `usable` starts the moment `record` is known, `unit` once both of its inputs
 * are. A step can only name steps added before it, so a flow has no cycles and every result is typed from its step.
 *
 * `mapConcurrent` is the same for a list: one call per item, at most `limit` at a time, results in the items' order.
 *
 * Both share the same rules:
 * - **Errors**: the first step (or item) to fail aborts the flow's signal (`StepContext.signal`), nothing that has
 *   not started yet starts, the ones already running are waited for (no work outlives the call), then the call rejects
 *   with that first error.
 * - **Abort**: `signal` aborting stops the same way and rejects with its reason.
 * - **Concurrency**: unbounded by default; `limit` caps how many run at once, or `doer` hands the work to a doer that
 *   is shared further (an `@ayepi/core/doer` policy such as the hub's own). A step waiting on its inputs holds no slot,
 *   so a limit never deadlocks a flow. Waiting steps start in the order they were added.
 */
import { doWith, priorityDoer, type Doer } from '@ayepi/core/doer';

/** What a step or item is given besides its inputs: the flow's signal, aborted when the caller's is or a step fails. */
export interface StepContext {
  readonly signal: AbortSignal;
}

/** How a flow or a map runs. */
export interface ConcurrencyOptions {
  /** Stops the work: nothing more starts and the call rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** The most steps or items running at once (unbounded when neither this nor `doer` is set). */
  readonly limit?: number | undefined;
  /** Runs each step or item through this doer instead (its own cap and order apply); wins over `limit`. */
  readonly doer?: Doer | undefined;
}

/** An object type spelled out (so a flow's result reads as `{ a: A; b: B }`, not an intersection). */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/** One step as a flow keeps it. */
interface StepDef {
  readonly name: string;
  readonly after: readonly string[];
  readonly run: (inputs: Readonly<Record<string, unknown>>, ctx: StepContext) => unknown;
}

/** A flow being built: add steps, then `run` it. `T` is every step's value by name so far. */
export class Flow<T extends object = {}> {
  readonly #options: ConcurrencyOptions;
  readonly #steps: readonly StepDef[];

  constructor(options: ConcurrencyOptions = {}, steps: readonly StepDef[] = []) {
    this.#options = options;
    this.#steps = steps;
  }

  /** A step that needs nothing: it starts when the flow runs. */
  step<const K extends string, R>(name: NewName<K, T>, run: (ctx: StepContext) => R | PromiseLike<R>): Flow<Flat<T & { readonly [P in K]: Awaited<R> }>>;
  /** A step that needs the named steps: it starts once they all have values, and receives them. */
  step<const K extends string, const D extends readonly (keyof T & string)[], R>(
    name: NewName<K, T>, after: D, run: (inputs: Flat<Pick<T, D[number]>>, ctx: StepContext) => R | PromiseLike<R>,
  ): Flow<Flat<T & { readonly [P in K]: Awaited<R> }>>;
  step(name: string, afterOrRun: readonly string[] | ((ctx: StepContext) => unknown), maybeRun?: StepDef['run']): Flow<object> {
    if (this.#steps.some((step) => step.name === name)) throw new Error(`flow: the step "${name}" is added twice`);
    const def: StepDef = typeof afterOrRun === 'function'
      ? { name, after: [], run: (_inputs, ctx) => afterOrRun(ctx) }
      : { name, after: afterOrRun, run: maybeRun ?? (() => undefined) };
    for (const needed of def.after) {
      if (!this.#steps.some((step) => step.name === needed)) throw new Error(`flow: the step "${name}" needs "${needed}", which is not added before it`);
    }
    return new Flow(this.#options, [...this.#steps, def]);
  }

  /** Run every step, each as soon as its inputs are ready; every step's value by name. */
  async run(): Promise<T> {
    this.#options.signal?.throwIfAborted();
    const values: Record<string, unknown> = {};
    const steps = this.#steps;
    if (steps.length === 0) return values as T;
    return new Promise<T>((resolve, reject) => {
      const work = new Work(this.#options);
      const done = new Set<string>();
      const started = new Set<string>();
      const startReady = (): void => {
        for (const step of steps) {
          if (work.stopped) return;
          if (started.has(step.name) || !step.after.every((name) => done.has(name))) continue;
          started.add(step.name);
          const inputs = Object.fromEntries(step.after.map((name) => [name, values[name]]));
          work.start(() => step.run(inputs, { signal: work.signal }), (value) => {
            values[step.name] = value;
            done.add(step.name);
            if (done.size === steps.length) work.finish();
            else startReady();
          });
        }
      };
      work.settled.then(() => resolve(values as T), reject);
      startReady();
    });
  }
}

/** A step's name, refused when a step of that name is already added. */
type NewName<K extends string, T> = K extends keyof T ? never : K;

/** A new flow: add steps with `step`, then `run`. */
export function flow(options: ConcurrencyOptions = {}): Flow {
  return new Flow(options);
}

/** `run` on each item, at most `limit` (or the doer's cap) at a time; the results in the items' order. */
export async function mapConcurrent<I, R>(
  items: Iterable<I>, run: (item: I, index: number, ctx: StepContext) => R | PromiseLike<R>, options: ConcurrencyOptions = {},
): Promise<Awaited<R>[]> {
  options.signal?.throwIfAborted();
  const list = [...items];
  const results = new Array<Awaited<R>>(list.length);
  if (list.length === 0) return results;
  const work = new Work(options);
  let left = list.length;
  list.forEach((item, index) => {
    work.start(() => run(item, index, { signal: work.signal }), (value) => {
      results[index] = value as Awaited<R>;
      left -= 1;
      if (left === 0) work.finish();
    });
  });
  await work.settled;
  return results;
}

/** The shared machinery: starts tasks through the doer, tracks the running ones, stops on the first error or abort. */
class Work {
  readonly #doer: Doer | undefined;
  readonly #controller = new AbortController();
  readonly #outer: AbortSignal | undefined;
  readonly #onAbort = (): void => this.#fail(this.#outer?.reason);
  #running = 0;
  #failed: { readonly error: unknown } | undefined;
  #finished = false;
  #resolve!: () => void;
  #reject!: (error: unknown) => void;
  /** Settles once every task is done (resolves) or the work stopped and nothing is running any more (rejects). */
  readonly settled: Promise<void>;

  constructor(options: ConcurrencyOptions) {
    this.#doer = options.doer ?? (options.limit === undefined ? undefined : priorityDoer({ max: Math.max(1, Math.floor(options.limit)) }));
    this.#outer = options.signal;
    this.settled = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // a caller that awaits nothing yet must not see an unhandled rejection; `settled` is still awaited by the caller
    this.settled.catch(() => undefined);
    if (this.#outer?.aborted === true) this.#fail(this.#outer.reason);
    else this.#outer?.addEventListener('abort', this.#onAbort, { once: true });
  }

  /** The signal tasks are given: aborted on the caller's abort or the first failure. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Whether the work has stopped (a failure or an abort): nothing more starts. */
  get stopped(): boolean {
    return this.#failed !== undefined;
  }

  /** Start one task (through the doer when there is one); `then` gets its value unless the work has stopped. */
  start(task: () => unknown, then: (value: unknown) => void): void {
    if (this.stopped) return;
    this.#running += 1;
    const body = async (): Promise<unknown> => {
      // queued behind a limit while the work stopped: it never starts
      if (this.stopped) return undefined;
      return task();
    };
    const running = this.#doer === undefined ? body() : doWith(this.#doer, body);
    running.then(
      (value) => {
        this.#running -= 1;
        if (this.stopped) this.#settleStopped();
        else then(value);
      },
      (error: unknown) => {
        this.#running -= 1;
        this.#fail(error);
      },
    );
  }

  /** Every task is done. */
  finish(): void {
    if (this.#finished || this.stopped) return;
    this.#finished = true;
    this.#outer?.removeEventListener('abort', this.#onAbort);
    this.#resolve();
  }

  #fail(error: unknown): void {
    if (this.#finished) return;
    if (this.#failed === undefined) {
      this.#failed = { error };
      this.#outer?.removeEventListener('abort', this.#onAbort);
      this.#controller.abort(error);
    }
    this.#settleStopped();
  }

  /** Once stopped, reject when the last running task has settled. */
  #settleStopped(): void {
    if (this.#running > 0 || this.#failed === undefined || this.#finished) return;
    this.#finished = true;
    this.#reject(this.#failed.error);
  }
}
