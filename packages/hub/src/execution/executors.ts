/**
 * The executors that don't need the agent loop: a connected system (over its link), and the hub's own native fns
 * (registered here with typed implementations from the hub's contract refs).
 *
 * A system fn that declares validation hooks (`FnDecl.validate`) is checked by its system around the run: its input
 * before it starts (a refusal settles it `invalid-input` from `unavailable`, which the model reads as "not available
 * now"), its result after it is done (`retry` settles it `invalid-input` from `result` so the model tries again, up
 * to `HARNESS_VALIDATE_RETRIES` times a turn; `stop` fails it `fatal`, which ends the turn with the reason).
 */
import { encodeValue, parseValue, type FnRef } from '@harness/sdk';
import {
  splitName, type InputProblem, type InvalidInput, type Json, type OutcomeWire, type QualifiedName, type Run, type RunRequest, type UndoOutcome, type RunControlAction,
} from '@harness/core';
import type { SystemConnection } from '../link/index.ts';
import { fnError, messageOf, RunStopped } from './errors.ts';
import type { ControlAnswer, ExecutionDeps, ExecutionJob, RunExecutor, UndoJob } from './ports.ts';

/** A run's system went away while it ran; the run is sent again when the system reconnects. */
export class SystemGone extends Error {
  override readonly name = 'SystemGone';

  constructor(system: string) {
    super(`system ${system} is not connected`);
  }
}

/** The code a run stopped by its fn's output hook fails with. */
export const OUTPUT_REFUSED = 'output-refused';

/** An input refusal as the run's outcome: the fn can't run now, and why. */
export function unavailable(reason: string): OutcomeWire {
  return { status: 'invalid-input', invalid: { source: 'unavailable', problems: [{ path: '', message: reason }] } };
}

/** A refused result as the run's outcome: the model is asked to try again. */
export function refusedResult(reason: string): OutcomeWire {
  return { status: 'invalid-input', invalid: { source: 'result', problems: [{ path: '', message: `The result was refused: ${reason.replace(/[.!?]+$/, '')}. Try again.` }] } };
}

/** How many refused results a turn keeps count of before the oldest counts are dropped. */
const RETRY_COUNTS_KEPT = 1_000;

/** Runs a run on the system that owns its kind, over that system's link. */
export class SystemExecutor implements RunExecutor {
  readonly #deps: Pick<ExecutionDeps, 'link' | 'settings'>;
  /** Refused results so far, by turn and fn. */
  readonly #refused = new Map<string, number>();

  constructor(deps: Pick<ExecutionDeps, 'link' | 'settings'>) {
    this.#deps = deps;
  }

  async execute(job: ExecutionJob, signal: AbortSignal): Promise<OutcomeWire> {
    const connection = this.#deps.link.connection(job.run.system, job.run.instance);
    if (connection === undefined) throw new SystemGone(job.run.system);
    const options = { signal: AbortSignal.any([signal, connection.signal]) };
    const hooks = job.fn.decl.validate;
    const { request } = job;
    try {
      // a resumed run was checked when it first started
      if (hooks?.input === true && request.resume === undefined) {
        const verdict = await connection.peer.call('validate', { phase: 'input', run: request.run, fn: request.fn, args: request.args }, options);
        if (!verdict.ok) return unavailable(verdict.reason);
      }
      const outcome = await connection.peer.call('run', request, options);
      if (hooks?.output !== true || outcome.status !== 'done') return outcome;
      return await this.#checkResult(connection, job, outcome, options);
    } catch (error) {
      if (connection.signal.aborted) throw new SystemGone(job.run.system);
      throw error;
    }
  }

  /** Ask the fn's output hook about a result: keep it, ask for another try (while tries are left), or stop. */
  async #checkResult(connection: SystemConnection, job: ExecutionJob, done: Extract<OutcomeWire, { status: 'done' }>, options: { signal: AbortSignal }): Promise<OutcomeWire> {
    const key = `${job.run.turn}|${job.run.fn}`;
    const refused = this.#refused.get(key) ?? 0;
    const { request } = job;
    const verdict = await connection.peer.call('validate', { phase: 'output', run: request.run, fn: request.fn, args: request.args, result: done.result, attempt: refused + 1 }, options);
    if (verdict.ok) {
      this.#refused.delete(key);
      return done;
    }
    const cost = done.cost === undefined ? {} : { cost: done.cost };
    const action = 'action' in verdict ? verdict.action : 'retry';
    if (action === 'retry' && refused < this.#deps.settings.execution.HARNESS_VALIDATE_RETRIES) {
      if (this.#refused.size >= RETRY_COUNTS_KEPT) this.#refused.clear();
      this.#refused.set(key, refused + 1);
      return { ...refusedResult(verdict.reason), ...cost };
    }
    this.#refused.delete(key);
    return { status: 'failed', error: fnError('fatal', verdict.reason, OUTPUT_REFUSED), ...(done.undo === undefined ? {} : { undo: done.undo }), ...cost };
  }

  async control(run: Run, action: RunControlAction): Promise<ControlAnswer> {
    const connection = this.#deps.link.connection(run.system, run.instance);
    if (connection === undefined) return { accepted: false, reason: `${run.system} is not connected` };
    const answer = await connection.peer.call('control', { run: run.id, action });
    return answer.reason === undefined ? { accepted: answer.accepted } : { accepted: answer.accepted, reason: answer.reason };
  }

  /** Tell the system to cancel the run; a system that doesn't answer is settled by the hub all the same. */
  async stop(run: Run): Promise<void> {
    await this.control(run, 'cancel');
  }

  async undo(job: UndoJob): Promise<UndoOutcome> {
    const { run, fn, info, payload } = job;
    const connection = this.#deps.link.connection(run.system, run.instance);
    if (connection === undefined) return { status: 'failed', error: fnError('retry', `${run.system} is not connected`, 'unavailable') };
    return connection.peer.call('undo', {
      run: info, fn: splitName(fn.name).local, kind: fn.decl.kind, payload, ...(fn.decl.payload === undefined ? {} : { fnPayload: fn.decl.payload }),
    });
  }
}

/**
 * A hub fn's args were well formed but wrong (a name that isn't one, nothing by that name): the caller's mistake,
 * which it can fix and retry. The run settles `invalid-input` with these problems, not `failed`.
 */
export class InvalidArgs extends Error {
  override readonly name = 'InvalidArgs';
  readonly invalid: InvalidInput;

  constructor(problems: string | readonly [InputProblem, ...InputProblem[]]) {
    const list: [InputProblem, ...InputProblem[]] = typeof problems === 'string' ? [{ path: '', message: problems }] : [...problems];
    super(list.map((p) => p.message).join('; '));
    this.invalid = { source: 'validation', problems: list };
  }
}

/** What a hub fn's implementation gets besides its args. */
export interface HubFnCtx {
  readonly request: RunRequest;
  readonly signal: AbortSignal;
}

/** One hub fn implementation, erased to JSON in and out (its typed form is checked when it is registered). */
type HubFnImpl = (args: Json, ctx: HubFnCtx) => Promise<Json>;

/**
 * The hub's own native fns (`hub/run_status`, `hub/search_fns`, …). Each module registers the fns it implements
 * against the hub contract's refs, so args and results are typed and checked with the contract's gin types.
 */
export class HubFns implements RunExecutor {
  readonly #impls = new Map<QualifiedName, HubFnImpl>();

  /** Implement a hub fn. Its args arrive checked and in their plain form; its result is checked on the way out. */
  register<A, R>(ref: FnRef<QualifiedName, A, R>, impl: (args: A, ctx: HubFnCtx) => Promise<R>): void {
    this.#impls.set(ref.name, async (args, ctx) => encodeValue(ref.returns, await impl(parseValue(ref.args, args), ctx)));
  }

  /** Whether a hub fn has an implementation. */
  has(fn: QualifiedName): boolean {
    return this.#impls.has(fn);
  }

  async execute(job: ExecutionJob, signal: AbortSignal): Promise<OutcomeWire> {
    const impl = this.#impls.get(job.run.fn);
    if (impl === undefined) return { status: 'failed', error: fnError('fatal', `the hub has no implementation of ${job.run.fn}`, 'not-implemented') };
    try {
      const result = await impl(job.request.args, { request: job.request, signal });
      // an implementation that returns early when stopped (`run_wait`) still ends the way the stop asked
      if (signal.aborted && signal.reason instanceof RunStopped) throw signal.reason;
      return { status: 'done', result };
    } catch (error) {
      if (signal.aborted && signal.reason instanceof RunStopped) throw signal.reason;
      if (error instanceof InvalidArgs) return { status: 'invalid-input', invalid: error.invalid };
      return { status: 'failed', error: fnError('caller', messageOf(error)) };
    }
  }

  /** Hub fns stop through their signal, which the run service aborts. */
  control(): Promise<ControlAnswer> {
    return Promise.resolve({ accepted: true });
  }

  /** Hub fns stop through their signal, which the run service aborts; one that ignores it is settled all the same. */
  stop(): Promise<void> {
    return Promise.resolve();
  }

  undo(): Promise<UndoOutcome> {
    return Promise.resolve({ status: 'gone' });
  }
}
