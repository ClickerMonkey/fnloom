/**
 * The executors that don't need the agent loop: a connected system (over its link), and the hub's own native fns
 * (registered here with typed implementations from the hub's contract refs).
 */
import { encodeValue, parseValue, type FnRef } from '@harness/sdk';
import {
  splitName, type Json, type OutcomeWire, type QualifiedName, type Run, type RunRequest, type UndoOutcome, type RunControlAction,
} from '@harness/core';
import { fnError, messageOf, RunStopped } from './errors.ts';
import type { ControlAnswer, ExecutionDeps, ExecutionJob, RunExecutor, UndoJob } from './ports.ts';

/** A run's system went away while it ran; the run is sent again when the system reconnects. */
export class SystemGone extends Error {
  override readonly name = 'SystemGone';

  constructor(system: string) {
    super(`system ${system} is not connected`);
  }
}

/** Runs a run on the system that owns its kind, over that system's link. */
export class SystemExecutor implements RunExecutor {
  readonly #deps: Pick<ExecutionDeps, 'link'>;

  constructor(deps: Pick<ExecutionDeps, 'link'>) {
    this.#deps = deps;
  }

  async execute(job: ExecutionJob, signal: AbortSignal): Promise<OutcomeWire> {
    const connection = this.#deps.link.connection(job.run.system, job.run.instance);
    if (connection === undefined) throw new SystemGone(job.run.system);
    try {
      return await connection.peer.call('run', job.request, { signal: AbortSignal.any([signal, connection.signal]) });
    } catch (error) {
      if (connection.signal.aborted) throw new SystemGone(job.run.system);
      throw error;
    }
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
