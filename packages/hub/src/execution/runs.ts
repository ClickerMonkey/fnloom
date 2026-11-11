/**
 * Runs: every call of a fn, from an agent's tool call, a person's `!`, or a run's child call. A run is checked (the fn
 * exists, is available and is a declared dep of its caller) and recorded; when its args don't fit (or its caller found
 * them unusable, as JSON that didn't parse) it settles at once as `invalid-input`, which the caller hears and may
 * retry. Otherwise it is put through the policies (it may wait for approval), queued at its priority, executed by the right executor (the system that owns its kind, the
 * hub's own fns, or the agent loop), and settled exactly once. Everything about it is in the store, so the fn tree of
 * a turn is a query away, and every change is published on the bus as a `run.update`.
 *
 * A child call has a key within its parent. Calling again with a key that already has a run gets that run back, so a
 * resumed fn that repeats its calls in order gets finished results instead of running them twice. Cancel, pause and
 * resume go as far as the run allows (`allowed`). Undo hands the run's undo payload back to its executor.
 */
import {
  compact, INVALID_INPUT_CODE, isSettled, MAIN_INSTANCE, mintId, problemLine, splitName, SystemName, type ActorId, type AllowedOperations, type FnRecord, type Json, type OutcomeWire, type ProgressReport,
  type ProgressWire, type ResumeWire, type Run, type RunId, type RunInfo, type RunRequest, type RunSettled, type RunStatus, type RunText, type RunUpdate,
  type Turn, type UndoOutcome, type Usd, type RunControlAction, type FnError, type InputProblem, type InvalidInput,
  type ApprovalPreview, type Approver, type InstanceName, type ProposedRun, type ProposeRun, type UserInfo, qualify,
} from '@harness/core';
import { z } from 'zod';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { DeadlineTimers, deadlineError, runDeadline, type RunDeadline } from './deadlines.ts';
import { fnError, HubStopping, messageOf, RunRefused, RunStopped, RunTimedOut } from './errors.ts';
import { rows } from './pages.ts';
import { SystemGone } from './executors.ts';
import { AGENT_KIND, type Ledger, type LimitResolver, type PolicyEngine, type RunInput, type RunService } from './index.ts';
import type { ControlAnswer, ExecutionDeps, RunCosts, RunEvents, RunExecutor, RunSettler } from './ports.ts';
import type { ExecutionQueues } from './queues.ts';
import { timeInfo } from './time.ts';
import { RunWording } from './wording.ts';
import type { FnModeGate, ModeVerdict } from '../fns/index.ts';

/** Why a signal aborted, as an error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(`stopped: ${String(reason)}`);
}

/** `work`, or the stop reason as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { reject(abortError(signal)); };
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', stop); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', stop); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

/**
 * The problems of args that don't fit a fn's args schema, as refused input (`schema`), each at its dotted path; none
 * when they fit.
 */
export function invalidArgs(checked: z.ZodSafeParseResult<unknown>): InvalidInput | undefined {
  if (checked.success) return undefined;
  const [first, ...rest] = checked.error.issues.map((issue): InputProblem => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  return first === undefined ? { source: 'schema', problems: [{ path: '', message: z.prettifyError(checked.error) }] } : { source: 'schema', problems: [first, ...rest] };
}

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
    // a code caller hears refused input as a caller error carrying the problems; agents read the run's own status
    case 'invalid-input': return { status: 'failed', error: { class: 'caller', code: INVALID_INPUT_CODE, message: outcome.invalid.problems.map(problemLine).join('; '), data: compact(outcome.invalid) } };
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

/** The key prefix of a run a system proposed (`propose`), apart from the keys of the calls it makes. */
export const PROPOSED_KEY = 'propose:';

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
  readonly policies: Pick<PolicyEngine, 'decide' | 'propose'>;
  readonly ledger: Pick<Ledger, 'remaining'>;
  /** The limits of a turn the hub makes for a run a system proposed outside any run. */
  readonly limits: Pick<LimitResolver, 'resolve'>;
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
  /** A timer per started run, at its deadline (`deadlines.ts`). */
  readonly #deadlines: DeadlineTimers;
  /** What a chat's fn mode lets its agent run (the fns module sets it at start). */
  #gate: FnModeGate | undefined;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
    this.#wording = new RunWording(deps.catalog);
    this.#deadlines = new DeadlineTimers(deps.clock);
    deps.bus.subscribe('approval', ({ approval }) => {
      if (approval.status === 'pending') return;
      void this.#approved(approval.run, approval.status === 'approved', approval.decisions.at(-1)).catch((error: unknown) => {
        deps.log.error('run.approval-failed', { run: approval.run, error: messageOf(error) });
      });
    });
  }

  gateWith(gate: FnModeGate): void {
    this.#gate = gate;
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
    const turn = await store.table('turns').get(input.turn);
    if (turn === undefined) throw new RunRefused(fnError('fatal', `There is no turn ${input.turn}.`, 'not-found'));
    // a fn the turn's person may not see is as good as missing to them; a per-person fn needs a connection to act as
    const access = await this.#deps.access.scope(turn.user.id);
    if (!access.seesFn(fn)) throw new RunRefused(fnError('caller', `There is no fn ${input.fn}.`, 'not-found'));
    const connection = access.connection(fn);
    if (connection?.state === 'missing') throw new RunRefused(fnError('retry', `${input.fn} acts as you: connect your account on the ${connection.page} page first.`, 'unavailable'));
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
    const checked = input.invalid ?? invalidArgs(signature.argsSchema.safeParse(input.args));
    const system = SystemName.parse(executingSystem(fn));
    // the one place a system's run is given its instance: a fleet with no clear pick is refused input the caller can fix
    const routed = checked === undefined && executorKind(fn) === 'system'
      ? await this.#deps.instances.route({ system, args: input.args, on: input.on, session: input.session, routing: fn.decl.routing })
      : undefined;
    const invalid = checked ?? (routed !== undefined && 'invalid' in routed ? routed.invalid : undefined);
    const instance = routed !== undefined && 'instance' in routed ? routed.instance.instance : undefined;

    const id = mintId('run', this.#deps.random);
    const { operations } = fn.decl;
    const run: Run = {
      id,
      fn: fn.name,
      fnVersion: fn.version,
      kind: fn.decl.kind,
      system,
      ...(instance === undefined ? {} : { instance }),
      root: parent?.root ?? id,
      turn: input.turn,
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(parent === undefined ? {} : { parent: parent.id }),
      key: input.key,
      actor: input.actor,
      caller: input.caller,
      ...(connection?.state === 'ready' ? { connection: connection.connection.id } : {}),
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

    if (invalid !== undefined) {
      // refused input never reaches the policies or the fn: the caller hears the problems and may try again
      this.#deps.log.info('run.invalid-input', { run: id, fn: fn.name, source: invalid.source, problems: invalid.problems.length });
      await this.settle(id, { status: 'invalid-input', invalid });
      return { run: id, settled };
    }
    // a chat's fn mode stands in front of the policies for the calls its agent makes
    const mode = await this.#mode(run, fn, parent);
    if (mode.effect === 'refuse') {
      await this.settle(id, { status: 'failed', error: fnError('caller', mode.reason, 'chat-mode') });
      return { run: id, settled };
    }
    // the preview is asked for only when an approval is made; a refusal settles the run with the system's reason
    const previewed: { refused?: OutcomeWire } = {};
    const asked: ApprovalPreview | undefined = mode.effect === 'ask' ? { title: `Auto mode asks you about ${fn.name}`, parts: [{ type: 'text', text: mode.reason }], irreversible: false } : undefined;
    const preview = fn.decl.approval?.preview === true
      ? async (): Promise<ApprovalPreview | undefined> => {
        const answer = await this.#preview(run, fn, turn.user);
        if ('preview' in answer) return answer.preview;
        previewed.refused = answer.refused;
        return undefined;
      }
      : asked === undefined ? undefined : () => Promise.resolve(asked);
    const decision = await this.#deps.policies.decide({
      fn: fn.name, actor: input.actor, turnUser: turn.user.id, args: input.args, run: id, caller: input.caller, ...(input.session === undefined ? {} : { session: input.session }),
      ...(preview === undefined ? {} : { preview }),
      ...(mode.effect === 'ask' ? { ask: { by: 'turn-user' } } : {}),
      ...(mode.effect === 'allow' ? { autoAllowed: true } : {}),
      // a per-person fn its person keeps on 'ask first' waits for the connection's owner
      ...(connection?.state === 'ready' && connection.option.ask ? { ask: connection.connection.owner === turn.user.id ? { by: 'turn-user' } : { by: 'actor', actor: connection.connection.owner } } : {}),
    });
    if (previewed.refused !== undefined) {
      await this.settle(id, previewed.refused);
    } else if (decision.effect === 'deny') {
      await this.settle(id, { status: 'failed', error: fnError('caller', `Not allowed: ${decision.reason}`, 'denied') });
    } else if (decision.effect === 'ask') {
      await this.#moveTo(run, { status: 'awaiting-approval' }, fn);
    } else {
      this.#enqueue(run);
    }
    if (input.background) await this.background(id);
    return { run: id, settled };
  }

  /** What the run's chat's fn mode says about it: only calls an agent makes in a session are checked. */
  async #mode(run: Run, fn: FnRecord, parent: Run | undefined): Promise<ModeVerdict> {
    if (this.#gate === undefined || parent?.kind !== AGENT_KIND || run.session === undefined) return { effect: 'pass' };
    const session = await this.#deps.store.table('sessions').get(run.session);
    if (session === undefined) return { effect: 'pass' };
    const verdict = await this.#gate.check({ session, fn, args: run.args, run: run.id });
    if (verdict.effect !== 'pass') this.#deps.log.info('run.chat-mode', { run: run.id, fn: fn.name, mode: session.fnMode ?? null, effect: verdict.effect });
    return verdict;
  }

  /**
   * What a run of a fn that always asks would do, from its system (`preview` on the system link), before anyone is
   * asked; or how the run settles instead: invalid input with the system's reason, or a retryable failure when the
   * system can't be reached.
   */
  async #preview(run: Run, fn: FnRecord, user: UserInfo): Promise<{ preview: ApprovalPreview } | { refused: OutcomeWire }> {
    // a kind fn's preview comes from its kind's system, which works it out from the payload
    const system = executingSystem(fn);
    const connection = system === run.system ? this.#deps.link.connection(run.system, run.instance) : this.#deps.link.connection(SystemName.parse(system));
    const away = (why: string): { refused: OutcomeWire } => ({ refused: { status: 'failed', error: fnError('retry', `${run.fn} can't show what it would do: ${why}`, 'unavailable') } });
    if (connection === undefined) return away(`${system} is not connected`);
    try {
      const answer = await connection.peer.call('preview', {
        run: run.id, fn: splitName(run.fn).local, args: run.args, user,
        ...(fn.decl.kind === 'native' ? {} : { kind: fn.decl.kind }),
        ...(fn.decl.payload === undefined ? {} : { payload: fn.decl.payload }),
      }, { signal: connection.signal });
      if ('preview' in answer) return answer;
      return { refused: { status: 'invalid-input', invalid: { source: 'validation', problems: [{ path: '', message: answer.refused }] } } };
    } catch (error) {
      return away(messageOf(error));
    }
  }

  async propose(input: ProposeRun & { system: SystemName; instance: InstanceName }): Promise<ProposedRun> {
    const { catalog, store, clock } = this.#deps;
    const name = qualify(input.system, input.fn);
    const fn = await catalog.fn(name);
    if (fn?.system !== input.system) throw new RunRefused(fnError('caller', `There is no fn ${name}.`, 'not-found'));
    const parent = input.parent === undefined ? undefined : await store.table('runs').get(input.parent);
    if (input.parent !== undefined && parent?.system !== input.system) throw new RunRefused(fnError('caller', `Run ${input.parent} is not ${input.system}'s.`, 'not-found'));
    const key = `${PROPOSED_KEY}${input.key}`;
    const existing = parent === undefined ? await this.#proposedBefore(name, key) : await this.#child(parent.id, key);
    if (existing !== undefined) return this.#proposal(existing);
    const invalid = invalidArgs((await catalog.signature(name)).argsSchema.safeParse(input.args));
    if (invalid !== undefined) throw new RunRefused(fnError('caller', `The args don't fit ${name}: ${invalid.problems.map(problemLine).join('; ')}`, INVALID_INPUT_CODE));
    const turn = parent === undefined ? await this.#systemTurn(input.system) : await this.#turn(parent);
    const id = mintId('run', this.#deps.random);
    const { operations } = fn.decl;
    const run: Run = {
      id, fn: name, fnVersion: fn.version, kind: fn.decl.kind, system: input.system, instance: input.instance, root: parent?.root ?? id, turn: turn.id,
      ...(parent?.session === undefined ? {} : { session: parent.session }),
      ...(parent === undefined ? {} : { parent: parent.id }),
      key, actor: parent?.actor ?? turn.actor, caller: turn.actor, args: input.args, status: 'awaiting-approval',
      allowed: { cancel: operations.cancel, pause: operations.pause, background: operations.background },
      cost: 0, totalCost: 0, priority: parent?.priority ?? turn.limits.priority, background: false, attempt: 1, errors: [], stateChanges: [], createdAt: clock(),
    };
    const text = await this.#wording.text(run, { status: 'awaiting-approval' }, fn);
    await store.table('runs').insert(text === undefined ? run : { ...run, text });
    if (parent === undefined) await store.table('turns').update(turn.id, { root: id });
    this.#publish(run, statusUpdate('awaiting-approval', text));
    this.#deps.log.info('run.proposed', { run: id, fn: name, parent: parent?.id ?? null, approver: input.approver });
    const approver: Approver = input.approver === 'admins' ? { by: 'admins' } : { by: 'turn-user' };
    const approval = await this.#deps.policies.propose({
      run: id, fn: name, approver, preview: input.preview, turnUser: turn.user.id, ...(run.session === undefined ? {} : { session: run.session }),
    });
    return { run: id, approval: approval.id };
  }

  /** A run proposed outside any run under this key, if one was. */
  async #proposedBefore(fn: Run['fn'], key: string): Promise<Run | undefined> {
    // the same key may also name a child proposed under some run, so look past those
    for await (const run of rows(this.#deps.store.table('runs'), { where: { fn, key } })) {
      if (run.parent === undefined) { return run; }
    }
    return undefined;
  }

  /** A proposed run and its approval. */
  async #proposal(run: Run): Promise<ProposedRun> {
    const page = await this.#deps.store.table('approvals').find({ where: { run: run.id }, order: [['createdAt', 'desc']], limit: 1 });
    const approval = page.items[0];
    if (approval === undefined) throw new Error(`proposed run ${run.id} has no approval`);
    return { run: run.id, approval: approval.id };
  }

  /** A turn of a system's own, for a run it proposed outside any run; it ends when the run settles. */
  async #systemTurn(system: SystemName): Promise<Turn> {
    const { store, clock } = this.#deps;
    const actor = (await store.table('systems').get(system))?.actor;
    if (actor === undefined) throw new RunRefused(fnError('fatal', `${system} has no actor to propose as.`, 'not-found'));
    const user: UserInfo = { id: actor, name: system, email: '', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' };
    const limits = await this.#deps.limits.resolve({ user, requested: 'background' });
    const now = clock();
    return store.table('turns').insert({
      id: mintId('turn', this.#deps.random), actor, user, time: timeInfo(now, user.timeZone), status: 'running', limits, cost: 0, errors: { max: 1 }, createdAt: now,
    });
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
      const turn = await this.#turn(run);
      const deadline = runDeadline(clock(), turn, fn);
      if (deadline.at <= clock()) {
        await this.settle(run.id, { status: 'failed', error: deadlineError(deadline, run, turn, fn) });
        return;
      }
      this.#watch(run, turn, fn, deadline);
      const request = await this.#request(run, fn, turn, deadline);
      // a stop (cancel, pause, timeout, shutdown) ends the wait even when the executor ignores its signal
      const outcome = await untilAborted(executor.execute({ run, fn, request }, controller.signal), controller.signal);
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
    if (signal.aborted && signal.reason instanceof RunTimedOut) {
      await this.settle(run.id, { status: 'failed', error: signal.reason.error });
      return;
    }
    const stopped = signal.aborted && signal.reason instanceof RunStopped ? signal.reason : error instanceof RunStopped ? error : undefined;
    if (stopped?.how === 'cancel') {
      await this.settle(run.id, { status: 'cancelled' });
    } else if (stopped?.how === 'pause') {
      await this.settle(run.id, { status: 'paused', resume: run.resume ?? null });
    } else if (error instanceof SystemGone || (signal.aborted && signal.reason instanceof HubStopping)) {
      // The system may have started it, so it is sent again as a restart, with the child calls that finished.
      this.#resumes.set(run.id, 'restart');
      this.#deadlines.disarm(run.id);
      await this.#moveTo(run, { status: 'queued' });
      this.#deps.log.warn('run.system-gone', { run: run.id, system: run.system });
    } else {
      await this.settle(run.id, { status: 'failed', error: error instanceof RunRefused ? error.error : fnError('retry', messageOf(error), 'executor') });
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
    // settled, paused or queued to retry: either way this attempt's deadline no longer applies
    this.#deadlines.disarm(id);
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

  async #stop(id: RunId, how: RunControlAction, by: ActorId): Promise<ControlAnswer> {
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
    this.#deadlines.clear();
    for (const controller of this.#running.values()) controller.abort(new HubStopping());
  }

  /**
   * Watch the deadline of every run that was started before the hub restarted and is still running or waiting (an
   * agent waiting for its tools), timed from when it started. A run the worker starts again gets a fresh deadline.
   */
  async watchDeadlines(): Promise<void> {
    const { store, catalog, clock } = this.#deps;
    for await (const run of rows(store.table('runs'), { where: { status: { in: ['running', 'waiting'] } } })) {
      if (this.#deadlines.armed(run.id)) continue;
      const [turn, fn] = await Promise.all([store.table('turns').get(run.turn), catalog.fn(run.fn)]);
      if (turn === undefined || fn === undefined) continue;
      this.#watch(run, turn, fn, runDeadline(run.startedAt ?? clock(), turn, fn));
    }
  }

  /** Arm a run's deadline: when it passes, the hub stops the run. */
  #watch(run: Run, turn: Turn, fn: FnRecord, deadline: RunDeadline): void {
    const error = deadlineError(deadline, run, turn, fn);
    this.#deadlines.arm(run.id, deadline.at, () => {
      void this.#timeOut(run.id, error).catch((thrown: unknown) => { this.#deps.log.error('run.timeout-failed', { run: run.id, error: messageOf(thrown) }); });
    });
  }

  /**
   * A run's deadline passed. The worker's wait on its executor is ended (the worker settles the run from there), the
   * executor is told to stop the work, and a run no worker waits on (an agent between iterations) is settled here.
   */
  async #timeOut(id: RunId, error: FnError): Promise<void> {
    const { catalog, log } = this.#deps;
    const run = await this.get(id);
    if (run === undefined || (run.status !== 'running' && run.status !== 'waiting')) return;
    log.warn('run.timed-out', { run: id, fn: run.fn, class: error.class, error: error.message });
    const worker = this.#running.get(id);
    worker?.abort(new RunTimedOut(error));
    const fn = await catalog.fn(run.fn);
    if (fn !== undefined) {
      try {
        await this.#executor(fn).stop(run, error);
      } catch (thrown) {
        log.warn('run.stop-failed', { run: id, fn: run.fn, error: messageOf(thrown) });
      }
    }
    if (worker === undefined) await this.settle(id, { status: 'failed', error });
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
    if (!run.background) this.#publish(await this.#deps.store.table('runs').update(id, { background: true }), { type: 'background' });
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

  async addTokens(id: RunId, tokens: number): Promise<void> {
    const run = await this.get(id);
    if (run === undefined || tokens <= 0) return;
    await this.#deps.store.table('runs').update(id, { tokens: (run.tokens ?? 0) + tokens });
  }

  /**
   * The run request an executor gets: who and when, the args, the budget left (money, and the turn's time), the
   * deadline the hub enforces, and what to resume from.
   */
  async #request(run: Run, fn: FnRecord, turn: Turn, deadline: RunDeadline): Promise<RunRequest> {
    const { ledger, config, clock } = this.#deps;
    const info = await this.#info(run, turn);
    const left = await ledger.remaining(turn.limits, { turn: turn.id, actor: run.actor });
    const now = clock();
    const turnDeadline = turn.createdAt + turn.limits.turn.time;
    const reason = this.#resumes.get(run.id);
    this.#resumes.delete(run.id);
    const resume = reason === undefined ? undefined : { state: run.resume ?? null, calls: await this.#finishedCalls(run.id), reason };
    const configured = run.system === HUB_SYSTEM ? undefined : await config.current(run.system, run.instance);
    return {
      run: info,
      fn: splitName(fn.name).local,
      kind: fn.decl.kind,
      ...(fn.decl.payload === undefined ? {} : { payload: fn.decl.payload }),
      args: run.args,
      budget: { cost: left.cost, time: Math.max(0, turnDeadline - now), limitedBy: left.limitedBy },
      handlers: [...(this.#handlers.get(run.id) ?? [])],
      ...(resume === undefined ? {} : { resume }),
      deadline: deadline.at,
      configVersion: configured?.version ?? 0,
      ...(await this.#connection(run, fn, turn)),
    };
  }

  /**
   * The connection a per-person fn's run acts as, credentials revealed; nothing for any other fn. It is the one pinned
   * when the run started, so the account approved is the account used: if that one is gone, off or no longer shared,
   * the run fails rather than act as another.
   */
  async #connection(run: Run, fn: FnRecord, turn: Turn): Promise<Pick<RunRequest, 'connection'>> {
    const gate = (await this.#deps.access.scope(turn.user.id)).connection(fn);
    if (gate === undefined) return {};
    if (gate.state !== 'ready' || gate.connection.id !== run.connection) {
      throw new RunRefused(fnError('retry', `${fn.name} was started to act as an account that is no longer connected or shared with you; ask again.`, 'unavailable'));
    }
    return { connection: await this.#deps.connections.forRun(gate.connection) };
  }

  /** Who and when a run is for. */
  /** Who and when a run is for, as its system reads it (`RunInfo`). */
  info(run: Run): Promise<RunInfo> {
    return this.#info(run);
  }

  async #info(run: Run, known?: Turn): Promise<RunInfo> {
    const turn = known ?? (await this.#turn(run));
    const parent = run.parent === undefined ? undefined : await this.get(run.parent);
    const connection = this.#deps.link.connection(run.system, run.instance);
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
        instance: run.instance ?? connection?.instance ?? MAIN_INSTANCE,
        boot: connection?.boot ?? HUB_SYSTEM,
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
  /**
   * A system's fn may call only the deps it declares. Agents call what their tools allow, and the hub's own fns call
   * what the hub's code does (`hub/resource_import` fetching a URL through `web/fetch_raw`): no system declares those.
   */
  async #checkDep(parent: Run, fn: FnRecord): Promise<void> {
    if (parent.kind === AGENT_KIND || parent.system === HUB_SYSTEM) return;
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
  async #approved(id: RunId, approved: boolean, decided: { by: ActorId; reason?: string | undefined } | undefined): Promise<void> {
    const run = await this.get(id);
    if (run?.status !== 'awaiting-approval') return;
    if (approved) {
      this.#enqueue(await this.#moveTo(run, { status: 'queued', approvedAt: this.#deps.clock() }));
      return;
    }
    // the caller (a model, most often) hears who declined and why, so it can say so or ask differently
    const who = decided === undefined ? undefined : (await this.#deps.store.table('actors').get(decided.by))?.name;
    const reason = decided?.reason?.trim() ?? '';
    const message = `Declined by ${who ?? 'the approver'}${reason === '' ? ' (no reason given).' : `: ${reason}`}`;
    await this.settle(id, { status: 'failed', error: fnError('caller', message, 'denied') });
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
    if (run.parent !== undefined) return;
    // a system's own turn, made for a run it proposed, ends with that run
    const proposed = run.session === undefined && run.key.startsWith(PROPOSED_KEY);
    if (!proposed && (run.session === undefined || run.kind !== AGENT_KIND)) return;
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
