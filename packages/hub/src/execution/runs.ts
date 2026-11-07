/**
 * Runs: every call of a fn, from an agent's tool call, a person's `!`, or a run's child call. A run is checked (the fn
 * exists, is available, is a declared dep of its caller, and its args fit), recorded, put through the policies (it
 * may wait for approval), queued at its priority, executed by the right executor (the system that owns its kind, the
 * hub's own fns, or the agent loop), and settled exactly once. Everything about it is in the store, so the fn tree of
 * a turn is a query away, and every change is published on the bus as a `run.update`.
 *
 * A child call has a key within its parent. Calling again with a key that already has a run gets that run back, so a
 * resumed fn that repeats its calls in order gets finished results instead of running them twice. Cancel, pause and
 * resume go as far as the run allows (`allowed`). Undo hands the run's undo payload back to its executor.
 */
import {
  isSettled, mintId, splitName, SystemName, type ActorId, type AllowedOperations, type FnRecord, type Json, type OutcomeWire, type ProgressReport,
  type ProgressWire, type ResumeWire, type Run, type RunId, type RunInfo, type RunRequest, type RunSettled, type RunStatus, type RunText, type RunUpdate,
  type Turn, type UndoOutcome, type Usd,
} from '@harness/core';
import { z } from 'zod';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { fnError, HubStopping, messageOf, RunRefused, RunStopped } from './errors.ts';
import { rows } from './pages.ts';
import { SystemGone } from './executors.ts';
import { AGENT_KIND, type Ledger, type PolicyEngine, type RunInput, type RunService } from './index.ts';
import type { ControlAnswer, ExecutionDeps, RunCosts, RunEvents, RunExecutor, RunSettler } from './ports.ts';
import type { ExecutionQueues } from './queues.ts';
import { timeInfo } from './time.ts';
import { RunWording } from './wording.ts';

/** Which executor runs a run. */
export type ExecutorKind = 'system' | 'hub' | 'agent';

/** A `status` update, with the run's words for its new phase when it has one. */
function statusUpdate(status: RunStatus, text: RunText | undefined): RunUpdate {
  return { type: 'status', status, ...(text === undefined ? {} : { text }) };
}

/** How a caller hears about a settled run. */
export function settledOf(outcome: OutcomeWire | undefined, run: RunId): RunSettled {
  if (outcome === undefined) return { status: 'background', run };
  switch (outcome.status) {
    case 'done': return { status: 'done', result: outcome.result };
    case 'failed': return { status: 'failed', error: outcome.error };
    case 'cancelled': return { status: 'cancelled' };
    case 'paused': return { status: 'background', run };
  }
}

/** The system that executes a fn: its own for native fns, else the system that defines its kind. */
export function executingSystem(fn: FnRecord): string {
  return fn.decl.kind === 'native' ? fn.system : splitName(fn.decl.kind).system;
}

/** The executor kind for a fn. */
export function executorKind(fn: FnRecord): ExecutorKind {
  if (fn.decl.kind === AGENT_KIND) return 'agent';
  return executingSystem(fn) === HUB_SYSTEM ? 'hub' : 'system';
}

/** A run's progress after one report: a fraction replaces the last; a step's status joins the others. */
export function mergeProgress(current: ProgressWire | undefined, report: ProgressReport): ProgressWire {
  if ('fraction' in report) return report.message === undefined ? { fraction: report.fraction } : { fraction: report.fraction, message: report.message };
  const steps = current !== undefined && 'steps' in current ? current.steps : {};
  return { steps: { ...steps, [report.step]: report.detail === undefined ? { status: report.status } : { status: report.status, detail: report.detail } } };
}

/**
 * The handlers a caller can answer for a fn: all of them when a person answers (a run they started, or one an agent
 * called on their behalf), else those the calling run named.
 */
export function suppliedHandlers(fn: FnRecord, parent: Run | undefined, named: readonly string[]): string[] {
  return parent === undefined || parent.kind === AGENT_KIND ? Object.keys(fn.decl.handlers) : named.filter((name) => name in fn.decl.handlers);
}

/** A promise with its resolver. */
interface Waiter {
  readonly promise: Promise<RunSettled>;
  readonly resolve: (settled: RunSettled) => void;
}

function waiter(): Waiter {
  let resolve: (settled: RunSettled) => void = () => undefined;
  const promise = new Promise<RunSettled>((r) => { resolve = r; });
  return { promise, resolve };
}

/** What the run service uses besides the other modules. */
export interface RunServiceDeps extends ExecutionDeps {
  readonly policies: Pick<PolicyEngine, 'decide'>;
  readonly ledger: Pick<Ledger, 'remaining'>;
  readonly queues: Pick<ExecutionQueues, 'enqueueRun' | 'cancel' | 'slot'>;
}


/** The run service on the hub store and the run queue. */
export class HubRunService implements RunService, RunSettler, RunEvents, RunCosts {
  readonly #deps: RunServiceDeps;
  readonly #executors = new Map<ExecutorKind, RunExecutor>();
  readonly #waiters = new Map<RunId, Waiter>();
  readonly #jobs = new Map<RunId, string>();
  readonly #running = new Map<RunId, AbortController>();
  readonly #handlers = new Map<RunId, readonly string[]>();
  readonly #resumes = new Map<RunId, ResumeWire['reason']>();
  readonly #settling = new Set<RunId>();
  /** Runs a queue job is handling now, so a second job for the same run (a resend, a redelivery) stands aside. */
  readonly #executing = new Set<RunId>();
  readonly #listeners = new Set<(run: Run, settled: RunSettled) => void>();
  readonly #wording: RunWording;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
    this.#wording = new RunWording(deps.catalog);
    deps.bus.subscribe('approval', ({ approval }) => {
      if (approval.status === 'pending') return;
      void this.#approved(approval.run, approval.status === 'approved', approval.decisions.at(-1)?.reason).catch((error: unknown) => {
        deps.log.error('run.approval-failed', { run: approval.run, error: messageOf(error) });
      });
    });
  }

  /** Set the executor for one kind of target. */
  use(kind: ExecutorKind, executor: RunExecutor): void {
    this.#executors.set(kind, executor);
  }

  async start(input: RunInput): Promise<{ run: RunId; settled: Promise<RunSettled> }> {
    const { catalog, store, clock } = this.#deps;
    const fn = await catalog.fn(input.fn);
    if (fn === undefined) throw new RunRefused(fnError('caller', `There is no fn ${input.fn}.`, 'not-found'));
    if (fn.disabled) throw new RunRefused(fnError('caller', `${input.fn} is turned off.`, 'disabled'));
    if (fn.available !== true) throw new RunRefused(fnError('retry', `${input.fn} is unavailable: ${fn.available.detail}`, 'unavailable'));
    const parent = input.parent === undefined ? undefined : await store.table('runs').get(input.parent);
    if (input.parent !== undefined && parent === undefined) throw new RunRefused(fnError('fatal', `There is no parent run ${input.parent}.`, 'not-found'));
    if (parent !== undefined) {
      const existing = await this.#child(parent.id, input.key);
      if (existing !== undefined) return { run: existing.id, settled: this.#waitFor(existing) };
      await this.#checkDep(parent, fn);
    }
    const handlers = suppliedHandlers(fn, parent, input.handlers);
    const missing = Object.entries(fn.decl.handlers).filter(([name, decl]) => decl.required && !handlers.includes(name)).map(([name]) => name);
    if (missing.length > 0) throw new RunRefused(fnError('fatal', `${fn.name} needs its caller to answer ${missing.join(', ')}, which this caller can't.`, 'needs-handlers'));
    const signature = await catalog.signature(fn.name);
    const checked = signature.argsSchema.safeParse(input.args);
    if (!checked.success) throw new RunRefused(fnError('caller', `The args for ${fn.name} don't fit: ${z.prettifyError(checked.error)}`, 'bad-args'));
    const turn = await store.table('turns').get(input.turn);
    if (turn === undefined) throw new RunRefused(fnError('fatal', `There is no turn ${input.turn}.`, 'not-found'));

    const id = mintId('run', this.#deps.random);
    const { operations } = fn.decl;
    const run: Run = {
      id,
      fn: fn.name,
      fnVersion: fn.version,
      kind: fn.decl.kind,
      system: SystemName.parse(executingSystem(fn)),
      root: parent?.root ?? id,
      turn: input.turn,
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(parent === undefined ? {} : { parent: parent.id }),
      key: input.key,
      actor: input.actor,
      caller: input.caller,
      ...(input.llmCall === undefined ? {} : { llmCall: input.llmCall }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      args: input.args,
      status: 'queued',
      allowed: { cancel: operations.cancel, pause: operations.pause, background: operations.background },
      cost: 0,
      totalCost: 0,
      priority: input.priority,
      background: false,
      attempt: 1,
      errors: [],
      stateChanges: [],
      createdAt: clock(),
    };
    const text = await this.#wording.text(run, { status: 'queued' }, fn);
    await store.table('runs').insert(text === undefined ? run : { ...run, text });
    this.#handlers.set(id, handlers);
    const settled = this.#waitFor(run);
    this.#publish(run, statusUpdate('queued', text));
    this.#deps.log.info('run.created', { run: id, fn: fn.name, turn: input.turn, parent: input.parent ?? null, key: input.key });

    const decision = await this.#deps.policies.decide({
      fn: fn.name, actor: input.actor, turnUser: turn.user.id, args: input.args, run: id, caller: input.caller, ...(input.session === undefined ? {} : { session: input.session }),
    });
    if (decision.effect === 'deny') {
      await this.settle(id, { status: 'failed', error: fnError('caller', `Not allowed: ${decision.reason}`, 'denied') });
    } else if (decision.effect === 'ask') {
      await this.#moveTo(run, { status: 'awaiting-approval' }, fn);
    } else {
      this.#enqueue(run);
    }
    if (input.background) await this.background(id);
    return { run: id, settled };
  }

  get(run: RunId): Promise<Run | undefined> {
    return this.#deps.store.table('runs').get(run);
  }

  /** The handlers a run's caller answers. */
  handlersOf(run: RunId): readonly string[] {
    return this.#handlers.get(run) ?? [];
  }

  /** Wait for a run to settle (or go to the background). */
  async wait(run: RunId): Promise<RunSettled> {
    const row = await this.get(run);
    if (row === undefined) return { status: 'failed', error: fnError('caller', `There is no run ${run}.`, 'not-found') };
    return this.#waitFor(row);
  }

  onSettled(listener: (run: Run, settled: RunSettled) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Run a queued run (the run queue's handler). */
  async execute(job: { run: RunId }, signal: AbortSignal): Promise<void> {
    if (this.#executing.has(job.run)) return;
    this.#executing.add(job.run);
    try {
      await this.#execute(job.run, signal);
    } finally {
      this.#executing.delete(job.run);
    }
  }

  async #execute(id: RunId, signal: AbortSignal): Promise<void> {
    const { store, catalog, queues } = this.#deps;
    const queued = await store.table('runs').get(id);
    if (queued?.status !== 'queued') return;
    this.#jobs.delete(queued.id);
    const fn = await catalog.fn(queued.fn);
    if (fn === undefined) {
      await this.settle(queued.id, { status: 'failed', error: fnError('fatal', `${queued.fn} no longer exists.`, 'not-found') });
      return;
    }
    if (fn.paused) {
      this.#enqueue(queued, this.#deps.settings.execution.HARNESS_RUN_RETRY_BASE);
      return;
    }
    await queues.slot(queued.system, queued.priority, () => this.#run(queued, fn, signal));
  }

  async #run(queued: Run, fn: FnRecord, signal: AbortSignal): Promise<void> {
    const { clock } = this.#deps;
    const executor = this.#executor(fn);
    const run = await this.#moveTo(queued, { status: 'running', startedAt: queued.startedAt ?? clock() }, fn);
    const controller = new AbortController();
    const stop = (): void => { controller.abort(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    this.#running.set(run.id, controller);
    try {
      const request = await this.#request(run, fn);
      const outcome = await executor.execute({ run, fn, request }, controller.signal);
      if (outcome !== 'detached') await this.settle(run.id, outcome);
    } catch (error) {
      await this.#failed(run, error, controller.signal);
    } finally {
      signal.removeEventListener('abort', stop);
      this.#running.delete(run.id);
    }
  }

  /** An executor threw: a stop request settles as asked, a lost system waits for it to come back, else the run fails. */
  async #failed(run: Run, error: unknown, signal: AbortSignal): Promise<void> {
    const stopped = signal.aborted && signal.reason instanceof RunStopped ? signal.reason : error instanceof RunStopped ? error : undefined;
    if (stopped?.how === 'cancel') {
      await this.settle(run.id, { status: 'cancelled' });
    } else if (stopped?.how === 'pause') {
      await this.settle(run.id, { status: 'paused', resume: run.resume ?? null });
    } else if (error instanceof SystemGone || (signal.aborted && signal.reason instanceof HubStopping)) {
      // The system may have started it, so it is sent again as a restart, with the child calls that finished.
      this.#resumes.set(run.id, 'restart');
      await this.#moveTo(run, { status: 'queued' });
      this.#deps.log.warn('run.system-gone', { run: run.id, system: run.system });
    } else {
      await this.settle(run.id, { status: 'failed', error: fnError('retry', messageOf(error), 'executor') });
    }
  }

  async settle(id: RunId, outcome: OutcomeWire): Promise<void> {
    if (this.#settling.has(id)) return;
    this.#settling.add(id);
    try {
      await this.#settle(id, outcome);
    } finally {
      this.#settling.delete(id);
    }
  }

  async #settle(id: RunId, outcome: OutcomeWire): Promise<void> {
    const { store, clock, catalog, log } = this.#deps;
    const run = await store.table('runs').get(id);
    if (run === undefined || isSettled(run.status)) return;
    const now = clock();
    const cost = outcome.cost ?? 0;
    const errors = outcome.status === 'failed' ? [...run.errors, { attempt: run.attempt, error: outcome.error, cost, at: now }] : run.errors;
    if (outcome.status === 'failed' && outcome.error.class === 'retry') {
      const fn = await catalog.fn(run.fn);
      if (run.attempt <= (fn?.decl.limits.retries ?? 0)) {
        const retried = await this.#moveTo(run, { status: 'queued', attempt: run.attempt + 1, errors, cost: run.cost + cost, totalCost: run.totalCost + cost }, fn);
        if (cost > 0) await this.#addToAncestors(run, cost);
        this.#enqueue(retried, this.#deps.settings.execution.HARNESS_RUN_RETRY_BASE * 2 ** (run.attempt - 1));
        log.info('run.retry', { run: id, fn: run.fn, attempt: retried.attempt });
        return;
      }
    }
    const paused = outcome.status === 'paused';
    const updated = await this.#moveTo(run, {
      status: outcome.status,
      outcome,
      errors,
      cost: run.cost + cost,
      totalCost: run.totalCost + cost,
      ...(paused ? { resume: outcome.resume } : { endedAt: now }),
      ...('undo' in outcome && outcome.undo !== undefined ? { undo: outcome.undo } : {}),
    });
    if (cost > 0) await this.#addToAncestors(run, cost);
    log.info('run.settled', { run: id, fn: run.fn, status: updated.status, cost: updated.totalCost });
    if (paused) return;
    const settled = settledOf(outcome, id);
    this.#waiters.get(id)?.resolve(settled);
    this.#waiters.delete(id);
    this.#handlers.delete(id);
    for (const listener of [...this.#listeners]) {
      try { listener(updated, settled); } catch (error) { log.error('run.listener-failed', { run: id, error: messageOf(error) }); }
    }
    await this.#settleTurn(updated);
  }

  async cancel(id: RunId, by: ActorId): Promise<{ accepted: boolean; reason?: string }> {
    return this.#stop(id, 'cancel', by);
  }

  async pause(id: RunId, by: ActorId): Promise<{ accepted: boolean; reason?: string }> {
    return this.#stop(id, 'pause', by);
  }

  async #stop(id: RunId, how: 'cancel' | 'pause', by: ActorId): Promise<ControlAnswer> {
    const run = await this.get(id);
    if (run === undefined) return { accepted: false, reason: `There is no run ${id}.` };
    if (isSettled(run.status)) return { accepted: false, reason: 'The run has already finished.' };
    if (how === 'cancel' ? !run.allowed.cancel : !run.allowed.pause) return { accepted: false, reason: `This run can't be ${how === 'cancel' ? 'cancelled' : 'paused'} now.` };
    // Resuming re-queues a run, so pausing one that waits for approval would skip the approval.
    if (how === 'pause' && run.status === 'awaiting-approval') return { accepted: false, reason: 'The run is waiting for approval; cancel it instead.' };
    this.#deps.log.info(`run.${how}`, { run: id, by, status: run.status });
    if (run.status === 'running' || run.status === 'waiting') {
      const fn = await this.#deps.catalog.fn(run.fn);
      if (fn === undefined) return { accepted: false, reason: `${run.fn} no longer exists.` };
      const answer = await this.#executor(fn).control(run, how);
      if (answer.accepted && executorKind(fn) === 'hub') this.#running.get(id)?.abort(new RunStopped(how));
      return answer;
    }
    if (run.status === 'paused') {
      if (how === 'pause') return { accepted: true };
      await this.settle(id, { status: 'cancelled' });
      return { accepted: true };
    }
    const job = this.#jobs.get(id);
    if (job !== undefined) await this.#deps.queues.cancel(job, how);
    this.#jobs.delete(id);
    await this.settle(id, how === 'cancel' ? { status: 'cancelled' } : { status: 'paused', resume: run.resume ?? null });
    return { accepted: true };
  }

  /** Stop every run in flight for a shutdown; each stays queued, to be sent again when its system is back. */
  drain(): void {
    for (const controller of this.#running.values()) controller.abort(new HubStopping());
  }

  async resume(id: RunId, by: ActorId): Promise<void> {
    const run = await this.get(id);
    if (run?.status !== 'paused') return;
    this.#resumes.set(id, 'resumed');
    const queued = await this.#moveTo(run, { status: 'queued' });
    this.#deps.log.info('run.resume', { run: id, by });
    this.#enqueue(queued);
  }

  async background(id: RunId): Promise<boolean> {
    const run = await this.get(id);
    if (run === undefined || isSettled(run.status) || !run.allowed.background) return false;
    if (!run.background) await this.#deps.store.table('runs').update(id, { background: true });
    this.#waiters.get(id)?.resolve({ status: 'background', run: id });
    this.#waiters.delete(id);
    this.#deps.log.info('run.background', { run: id, fn: run.fn });
    return true;
  }

  async progress(id: RunId, report: ProgressReport): Promise<void> {
    const run = await this.get(id);
    if (run === undefined || isSettled(run.status)) return;
    const progress = mergeProgress(run.progress, report);
    this.#publish(await this.#deps.store.table('runs').update(id, { progress }), { type: 'progress', progress });
  }

  async allow(id: RunId, operations: Partial<AllowedOperations>): Promise<void> {
    const run = await this.get(id);
    if (run === undefined || isSettled(run.status)) return;
    const allowed: AllowedOperations = {
      cancel: operations.cancel ?? run.allowed.cancel,
      pause: operations.pause ?? run.allowed.pause,
      background: operations.background ?? run.allowed.background,
    };
    this.#publish(await this.#deps.store.table('runs').update(id, { allowed }), { type: 'allowed', operations: allowed });
  }

  async undoWith(id: RunId, undo: Json): Promise<void> {
    if ((await this.get(id)) === undefined) return;
    await this.#deps.store.table('runs').update(id, { undo });
  }

  async undo(id: RunId, by: ActorId): Promise<UndoOutcome> {
    const { catalog, log } = this.#deps;
    const run = await this.get(id);
    if (run === undefined) return { status: 'failed', error: fnError('caller', `There is no run ${id}.`, 'not-found') };
    if (run.status === 'undone' || run.undo === undefined) return { status: 'gone' };
    if (!isSettled(run.status)) return { status: 'failed', error: fnError('caller', 'The run has not finished yet.', 'running') };
    const fn = await catalog.fn(run.fn);
    if (fn?.decl.operations.undo !== true) return { status: 'failed', error: fnError('caller', `${run.fn} can't be undone.`, 'not-undoable') };
    const info = await this.#info(run);
    const outcome = await this.#executor(fn).undo({ run, fn, info, payload: run.undo });
    if (outcome.status === 'undone') await this.#moveTo(run, { status: 'undone' }, fn);
    log.info('run.undo', { run: id, fn: run.fn, by, status: outcome.status });
    return outcome;
  }

  /**
   * Agent runs are skipped: they come back through their LLM jobs (which the work queue delivers again) and
   * `HubAgentLoop.recover`, and queuing one again would run an iteration twice.
   */
  async resend(system: string): Promise<void> {
    const { store, log } = this.#deps;
    for await (const run of rows(store.table('runs'), { where: { status: { in: ['running', 'queued'] } } })) {
      if (run.system !== system || run.kind === AGENT_KIND || this.#running.has(run.id) || this.#jobs.has(run.id) || this.#executing.has(run.id)) continue;
      if (run.status === 'running') this.#resumes.set(run.id, 'restart');
      this.#enqueue(run.status === 'running' ? await store.table('runs').update(run.id, { status: 'queued' }) : run);
      log.info('run.resent', { run: run.id, system });
    }
  }

  async addCost(id: RunId, cost: Usd): Promise<void> {
    const run = await this.get(id);
    if (run === undefined || cost === 0) return;
    const updated = await this.#deps.store.table('runs').update(id, { cost: run.cost + cost, totalCost: run.totalCost + cost });
    this.#publish(updated, { type: 'cost', cost: updated.cost, total: updated.totalCost });
    await this.#addToAncestors(run, cost);
  }

  /** The run request an executor gets: who and when, the args, the budget left, and what to resume from. */
  async #request(run: Run, fn: FnRecord): Promise<RunRequest> {
    const { ledger, config, clock } = this.#deps;
    const turn = await this.#turn(run);
    const info = await this.#info(run, turn);
    const left = await ledger.remaining(turn.limits, { turn: turn.id, actor: run.actor });
    const now = clock();
    const turnDeadline = turn.createdAt + turn.limits.turn.time;
    const deadline = fn.decl.limits.timeout === undefined ? turnDeadline : Math.min(turnDeadline, now + fn.decl.limits.timeout);
    const reason = this.#resumes.get(run.id);
    this.#resumes.delete(run.id);
    const resume = reason === undefined ? undefined : { state: run.resume ?? null, calls: await this.#finishedCalls(run.id), reason };
    const configured = run.system === HUB_SYSTEM ? undefined : await config.current(run.system);
    return {
      run: info,
      fn: splitName(fn.name).local,
      kind: fn.decl.kind,
      ...(fn.decl.payload === undefined ? {} : { payload: fn.decl.payload }),
      args: run.args,
      budget: { cost: left.cost, time: Math.max(0, turnDeadline - now), limitedBy: left.limitedBy },
      handlers: [...(this.#handlers.get(run.id) ?? [])],
      ...(resume === undefined ? {} : { resume }),
      deadline,
      configVersion: configured?.version ?? 0,
    };
  }

  /** Who and when a run is for. */
  async #info(run: Run, known?: Turn): Promise<RunInfo> {
    const turn = known ?? (await this.#turn(run));
    const parent = run.parent === undefined ? undefined : await this.get(run.parent);
    const connection = this.#deps.link.connection(run.system);
    return {
      id: run.id,
      fn: run.fn,
      turn: run.turn,
      ...(run.parent === undefined ? {} : { parent: run.parent }),
      ...(run.session === undefined ? {} : { session: run.session }),
      user: turn.user,
      time: timeInfo(this.#deps.clock(), turn.user.timeZone),
      system: {
        name: run.system,
        instance: connection?.instance ?? 'hub',
        ...(parent === undefined ? {} : { from: { system: parent.system, fn: parent.fn, run: parent.id } }),
      },
      caller: run.caller,
      attempt: run.attempt,
      priority: run.priority,
    };
  }

  async #turn(run: Run): Promise<Turn> {
    const turn = await this.#deps.store.table('turns').get(run.turn);
    if (turn === undefined) throw new Error(`run ${run.id} names no turn ${run.turn}`);
    return turn;
  }

  /** The child calls of a run that already finished, by key (what a resumed fn gets back instead of calling again). */
  async #finishedCalls(parent: RunId): Promise<Record<string, RunSettled>> {
    const calls: Record<string, RunSettled> = {};
    for await (const child of rows(this.#deps.store.table('runs'), { where: { parent } })) {
      if (isSettled(child.status) && child.outcome !== undefined) calls[child.key] = settledOf(child.outcome, child.id);
    }
    return calls;
  }

  /** A parent's existing child under a key. */
  async #child(parent: RunId, key: string): Promise<Run | undefined> {
    const page = await this.#deps.store.table('runs').find({ where: { parent, key }, limit: 1 });
    return page.items[0];
  }

  /** A child call must be to one of its parent's declared deps (agents call their tools, checked by the agent loop). */
  async #checkDep(parent: Run, fn: FnRecord): Promise<void> {
    if (parent.kind === AGENT_KIND) return;
    const parentFn = await this.#deps.catalog.fn(parent.fn);
    if (parentFn?.decl.deps.includes(fn.name) !== true) {
      throw new RunRefused(fnError('fatal', `${parent.fn} doesn't declare ${fn.name} as a dep, so it can't call it.`, 'not-a-dep'));
    }
  }

  #waitFor(run: Run): Promise<RunSettled> {
    if (isSettled(run.status)) return Promise.resolve(settledOf(run.outcome, run.id));
    if (run.background) return Promise.resolve({ status: 'background', run: run.id });
    let entry = this.#waiters.get(run.id);
    if (entry === undefined) {
      entry = waiter();
      this.#waiters.set(run.id, entry);
    }
    return entry.promise;
  }

  #enqueue(run: Run, delay?: number): void {
    this.#jobs.set(run.id, this.#deps.queues.enqueueRun({ run: run.id, priority: run.priority }, delay === undefined ? {} : { delay }));
  }

  #executor(fn: FnRecord): RunExecutor {
    const kind = executorKind(fn);
    const executor = this.#executors.get(kind);
    if (executor === undefined) throw new Error(`no executor for ${kind} runs`);
    return executor;
  }

  /** An approval was answered: queue the run, or fail it. */
  async #approved(id: RunId, approved: boolean, reason: string | undefined): Promise<void> {
    const run = await this.get(id);
    if (run?.status !== 'awaiting-approval') return;
    if (approved) {
      this.#enqueue(await this.#moveTo(run, { status: 'queued' }));
    } else {
      await this.settle(id, { status: 'failed', error: fnError('caller', reason === undefined ? 'The person refused this.' : `The person refused this: ${reason}`, 'denied') });
    }
  }

  async #addToAncestors(run: Run, cost: Usd): Promise<void> {
    let parentId = run.parent;
    while (parentId !== undefined) {
      const parent = await this.get(parentId);
      if (parent === undefined) return;
      const updated = await this.#deps.store.table('runs').update(parent.id, { totalCost: parent.totalCost + cost });
      this.#publish(updated, { type: 'cost', cost: updated.cost, total: updated.totalCost });
      parentId = parent.parent;
    }
  }

  /** A turn's root agent run settled: the turn has ended (chat settles the turns of fns people run themselves). */
  async #settleTurn(run: Run): Promise<void> {
    if (run.parent !== undefined || run.session === undefined || run.kind !== AGENT_KIND) return;
    const status = run.status === 'done' || run.status === 'undone' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'failed';
    await this.#deps.turns.settle(run.turn, status);
  }

  /** Move a run to a new status (with what changes alongside), worded for its phase, stored and published. */
  async #moveTo(run: Run, patch: Partial<Run> & Pick<Run, 'status'>, fn?: FnRecord): Promise<Run> {
    const text = await this.#wording.text(run, patch, fn);
    const updated = await this.#deps.store.table('runs').update(run.id, text === undefined ? patch : { ...patch, text });
    this.#publish(updated, statusUpdate(updated.status, text));
    return updated;
  }

  #publish(run: Run, update: RunUpdate): void {
    this.#deps.bus.publish('run.update', { run: run.id, fn: run.fn, update, ...(run.session === undefined ? {} : { session: run.session }) });
  }
}
