/**
 * The run queue and the LLM queue, on `@ayepi/work` (durable on the hub's SQLite ports in production, in memory in
 * tests). Every LLM call shares one doer (`llmDoer`): a rate cap on call starts across all models
 * that admits the most urgent waiting call first (interactive work before background work) into fixed call slots. Agent iterations are LLM jobs on that doer, and forwarded system requests
 * run on it too, so priorities and limits hold for both. Runs are queued by priority and run at most
 * `HARNESS_RUN_CONCURRENCY` at a time per system.
 *
 * Handlers settle their run themselves; the queue only retries what is transient (rate limits, a budget waiting for
 * its window), by rescheduling without spending an attempt.
 */
import { doWith, type Doer } from '@ayepi/core/doer';
import { rateLimitedDoer, type RateLimitedDoer, type RateLimitStore } from '@ayepi/rate';
import { createWork, defineWork, priorityDoer, unlimitedDoer, WorkDelayError, type PubSub, type Queue, type Store } from '@ayepi/work';
import type { LlmJob, Priority, RunJob, SystemName } from '@harness/core';
import { BudgetRefused, causeOf, LlmRateLimited } from './errors.ts';
import { priorityRank } from './limits.ts';
import type { ExecutionBase } from './ports.ts';

/** What the queues hand their jobs to. */
export interface QueueHandlers {
  run(job: RunJob, signal: AbortSignal): Promise<void>;
  llm(job: LlmJob, signal: AbortSignal): Promise<void>;
}

/** The ayepi ports the queues run on. */
export interface QueuePorts {
  readonly work: { readonly queue: Queue; readonly store: Store; readonly pubsub: PubSub };
  readonly rate?: RateLimitStore | undefined;
}

/** When to run a queued job. */
export interface JobOptions {
  readonly delay?: number;
  readonly deadline?: number;
}

/**
 * The wait a transient LLM failure asks for (a rate limit, or a budget whose rule says wait), or undefined when the
 * failure is not transient.
 */
export function transientDelay(error: unknown): number | undefined {
  const limited = causeOf(error, LlmRateLimited);
  if (limited !== undefined) return Math.max(1, limited.retryAfter);
  return causeOf(error, BudgetRefused)?.wait;
}

/** What the LLM doer is sized by. */
export interface LlmDoerOptions {
  /** Calls running at once. */
  readonly max: number;
  /** Call starts allowed per `window`, across all models. */
  readonly limit: number;
  readonly window: number;
  /** Where the rate is counted (the hub's SQLite rate store in production). */
  readonly store?: RateLimitStore | undefined;
  readonly now?: () => number;
}

/**
 * The LLM doer: a rate cap on call starts that admits waiting calls most urgent first, then oldest, into `max` call
 * slots. The slots take no buffer, so a call is admitted only into a free slot and an urgent call never waits
 * behind background calls already handed on.
 */
export function llmDoer(options: LlmDoerOptions): RateLimitedDoer {
  return rateLimitedDoer({
    limit: options.limit,
    window: options.window,
    algorithm: 'sliding-window',
    prefix: 'llm:all:',
    order: 'priority',
    doer: priorityDoer({ max: options.max, buffer: 0 }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** The two queues and the doers behind them. */
export class ExecutionQueues {
  readonly #deps: Pick<ExecutionBase, 'settings' | 'log'>;
  readonly #handlers: QueueHandlers;
  readonly #llmDoer: Doer;
  readonly #slots = new Map<SystemName, Doer>();
  readonly #work;
  readonly #runWork;
  readonly #llmWork;

  constructor(deps: Pick<ExecutionBase, 'settings' | 'log'>, ports: QueuePorts, handlers: QueueHandlers) {
    this.#deps = deps;
    this.#handlers = handlers;
    const { queue, execution } = deps.settings;
    this.#llmDoer = llmDoer({
      max: queue.HARNESS_LLM_CONCURRENCY,
      limit: execution.HARNESS_LLM_RATE_LIMIT,
      window: execution.HARNESS_LLM_RATE_WINDOW,
      store: ports.rate,
    });
    this.#runWork = defineWork('run', async (job: RunJob, ctx) => {
      await this.#handlers.run(job, ctx.signal);
      return ctx.void();
    }, { retry: { attempts: 1 }, doer: unlimitedDoer(), logContext: (job) => ({ run: job.run }) });
    this.#llmWork = defineWork('llm', async (job: LlmJob, ctx) => {
      try {
        await this.#handlers.llm(job, ctx.signal);
      } catch (error) {
        const delay = transientDelay(error);
        if (delay === undefined) throw error;
        this.#deps.log.info('llm.deferred', { run: job.run, iteration: job.iteration, delay });
        throw new WorkDelayError({ delay });
      }
      return ctx.void();
    }, { retry: { attempts: 1 }, doer: this.#llmDoer, logContext: (job) => ({ run: job.run, turn: job.turn, iteration: job.iteration }) });
    this.#work = createWork({
      work: [this.#runWork, this.#llmWork] as const,
      queue: ports.work.queue,
      store: ports.work.store,
      pubsub: ports.work.pubsub,
      autoStart: false,
      pollInterval: execution.HARNESS_QUEUE_POLL,
      logWith: (add, inner) => deps.log.logWith(add, inner),
      onError: (error, phase) => { deps.log.warn('work.engine', { phase, error: error instanceof Error ? error.message : String(error) }); },
    });
  }

  /** Queue a run; returns the work item id (for cancelling it while queued). */
  enqueueRun(job: RunJob, options: JobOptions = {}): string {
    return this.#work.enqueue(this.#runWork(job), { priority: priorityRank(job.priority), ...options }).id;
  }

  /** Queue an agent iteration; returns the work item id. */
  enqueueLlm(job: LlmJob, options: JobOptions = {}): string {
    return this.#work.enqueue(this.#llmWork(job), { priority: priorityRank(job.priority), ...(job.session === undefined ? {} : { group: job.session }), ...options }).id;
  }

  /** Cancel a queued or running job; false when it has already finished. */
  cancel(id: string, reason?: string): Promise<boolean> {
    return this.#work.cancel(id, reason);
  }

  /** Run an LLM call on the shared LLM doer, at a priority (forwarded system requests use this). */
  llm<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
    return doWith(this.#llmDoer, task, { priority: priorityRank(priority) });
  }

  /** Run a run's work in its system's slots, so no system runs more than its share at once. */
  slot<T>(system: SystemName, priority: Priority, task: () => Promise<T>): Promise<T> {
    let doer = this.#slots.get(system);
    if (doer === undefined) {
      doer = priorityDoer({ max: this.#deps.settings.queue.HARNESS_RUN_CONCURRENCY });
      this.#slots.set(system, doer);
    }
    return doWith(doer, task, { priority: priorityRank(priority) });
  }

  start(): void {
    this.#work.start();
  }

  stop(): Promise<void> {
    return this.#work.stop();
  }
}
