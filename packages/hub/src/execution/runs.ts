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
  ARGS_CHECK_KEY_PREFIX, clip, compact, CONCISE_LIMITS, FN_MODES, type ArgRepair, type GinCheck, INVALID_INPUT_CODE, isSettled, isUnsettled, MAIN_INSTANCE, mintId, problemLine, splitName, SystemName, type ActorId, type AllowedOperations, type FnRecord, type Json, type OutcomeWire, type ProgressReport,
  type ProgressWire, type ResumeWire, type Run, type RunId, type RunInfo, type RunRequest, type RunSettled, type RunStatus, type RunText, type RunUpdate,
  type Turn, type UndoOutcome, type Usd, type RunControlAction, type FnError, type InputProblem, type InvalidInput, type Compact,
  flagsVerdict, proposalSubjectOf, type CompareFork, type SessionId, type ApprovalPreview, type ProposalAsk, type Approver, type PreviewPart, type SensitivityFlag, type InstanceName, type ProposedRun, type ProposeRun, type UserInfo, type QualifiedName, qualify,
} from '@harness/core';
import { HUB_SYSTEM, systemAvailability } from '../catalog/availability.ts';
import { installCard } from '../link/install.ts';
import { agentNames } from '../catalog/injections.ts';
import { DeadlineTimers, deadlineError, runDeadline, type RunDeadline } from './deadlines.ts';
import { fnError, HubStopping, messageOf, notConnected, RunRefused, RunStopped, RunTimedOut } from './errors.ts';
import { rows } from '../store/rows.ts';
import { SystemGone } from './executors.ts';
import { AGENT_KIND, type Ledger, type LimitResolver, type PolicyEngine, type RunInput, type RunService } from './index.ts';
import type { ControlAnswer, ExecutionDeps, RunCosts, RunEvents, RunExecutor, RunSettler } from './ports.ts';
import type { ExecutionQueues } from './queues.ts';
import { timeInfo } from './time.ts';
import { RunWording } from './wording.ts';
import type { FnModeGate, ModeVerdict } from '../fns/index.ts';
import { fnMode } from '../link/review-summary.ts';

/**
 * Whether a run is the chat's own (`RunInfo.inChat`): a chat turn's agent or a fn it called directly, on a session, not
 * in the background (not a nested agent's own calls, a background run or an MCP call, which has no session). A person
 * watches it when they also have the session open (`RunInfo.watched`).
 */
export function chatOwn(run: Pick<Run, 'session' | 'background'>, parent: Pick<Run, 'parent'> | undefined): boolean {
  return run.session !== undefined && !run.background && parent?.parent === undefined;
}

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
 * The problems of args that don't fit a fn's args (its signature's `check`), as refused input (`schema`), each at its
 * dotted path with `@aeye/schema`'s words for it, a few at most; none when they fit.
 */
export function invalidArgs(checked: GinCheck<unknown>): InvalidInput | undefined {
  if (checked.ok) return undefined;
  const [first, ...rest] = checked.problems.slice(0, CONCISE_LIMITS.max).map((problem): InputProblem => ({ path: problem.path, message: clip(problem.message, CONCISE_LIMITS.chars) }));
  return { source: 'schema', problems: first === undefined ? [{ path: '', message: clip(checked.message, CONCISE_LIMITS.chars) }] : [first, ...rest] };
}

/**
 * What a check repaired in args, found by comparing them as sent with the value it decoded: a string where the decoded
 * value has an object or a list is an object or list sent as a string holding its JSON (`json-string`), at its dotted
 * path. None when the args were taken as sent.
 */
export function repairsOf(sent: unknown, decoded: unknown, path: readonly string[] = []): ArgRepair[] {
  if (sent === decoded) return [];
  if (typeof sent === 'string' && typeof decoded === 'object' && decoded !== null) return [{ path: path.join('.'), repair: 'json-string' }];
  if (Array.isArray(sent) && Array.isArray(decoded)) return sent.flatMap((item: unknown, at) => repairsOf(item, decoded[at], [...path, String(at)]));
  if (isRecord(sent) && isRecord(decoded)) return Object.entries(sent).flatMap(([key, value]) => (key in decoded ? repairsOf(value, decoded[key], [...path, key]) : []));
  return [];
}

/** Whether a value is a JSON object (not null, not a list). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Repairs at the same path as one already noted are noted once. */
function mergedRepairs(...lists: ReadonlyArray<readonly ArgRepair[]>): ArgRepair[] {
  const seen = new Set<string>();
  return lists.flat().filter((repair) => !seen.has(repair.path) && (seen.add(repair.path), true));
}

/** Which executor runs a run. */
export type ExecutorKind = 'system' | 'hub' | 'agent';

/** A `status` update, with the run's words for its new phase when it has one. */
function statusUpdate(status: RunStatus, text: RunText | undefined): RunUpdate {
  return { type: 'status', status, ...(text === undefined ? {} : { text }) };
}

/** Refused input as an error's JSON data: compacted, its block too. */
function invalidData(invalid: InvalidInput): Compact<Omit<InvalidInput, 'blocked'>> & { blocked?: Compact<NonNullable<InvalidInput['blocked']>> } {
  const { blocked, ...rest } = invalid;
  return { ...compact(rest), ...(blocked === undefined ? {} : { blocked: compact(blocked) }) };
}

/** How a caller hears about a settled run. */
export function settledOf(outcome: OutcomeWire | undefined, run: RunId): RunSettled {
  if (outcome === undefined) return { status: 'background', run };
  switch (outcome.status) {
    case 'done': return { status: 'done', result: outcome.result };
    // a code caller hears refused input as a caller error carrying the problems; agents read the run's own status
    case 'invalid-input': return { status: 'failed', error: { class: 'caller', code: INVALID_INPUT_CODE, message: outcome.invalid.problems.map(problemLine).join('; '), data: invalidData(outcome.invalid) } };
    case 'failed': return { status: 'failed', error: outcome.error };
    case 'cancelled': return outcome.error === undefined ? { status: 'cancelled' } : { status: 'cancelled', error: outcome.error };
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

/** How many runs up a call's tree a policy's `via` is looked for. */
const MAX_VIA_DEPTH = 32;

/** The error code of a call a fn's args check may not make (not a declared check dep, or not a `read` fn). */
export const CHECK_CALL_CODE = 'check-call';
/** The error code of a run a policy denied or its approver declined. */
export const DECLINED_CODE = 'denied';

/** Build 6: the hub fn whose runs hold the model calls a system makes outside its own runs (`systemWork`). */
export const SYSTEM_CALLS_FN: QualifiedName = 'hub/system_calls';

/**
 * Secrets in a run's args (`boot/admin-secrets.ts`): the args of a fn that carries secret values (a system's config,
 * a provider's keys) are sealed before the run is stored, so its row, its approval and anything shown from them hold
 * none in plain text; the executor gets them unsealed, and they are removed once the run settles.
 */
export interface RunArgSecrets {
  /**
   * The args to store for a new run: each secret value sealed (in a secret named for the run), anything else as given;
   * `invalid` when the caller wrote a `{ $secret }` reference of its own, which is refused (never revealed).
   */
  seal(input: { readonly run: RunId; readonly fn: QualifiedName; readonly args: Json; readonly owner: ActorId }): Promise<{ args: Json; invalid?: InvalidInput }>;
  /** A run's args as its executor gets them: the secrets sealed for this run revealed. */
  unseal(run: Pick<Run, 'id' | 'fn' | 'args'>): Promise<Json>;
  /** Remove the secrets sealed for a settled run. */
  release(run: Pick<Run, 'id' | 'fn' | 'args'>): Promise<void>;
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
  /** Seals the secrets in the args of the fns that carry them (boot sets it with the admin fns). */
  #argSecrets: RunArgSecrets | undefined;
  /**
   * Runs whose args their system is checking now (`check`: their calls must be the check's declared read deps), and
   * the calls made under them until each settles (`under`: their calls must read). Neither ever waits for approval.
   */
  readonly #checking = new Map<RunId, 'check' | 'under'>();

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

  /** Seal the secrets in run args with this from now on, removing a run's once it settles. */
  sealArgsWith(secrets: RunArgSecrets): void {
    this.#argSecrets = secrets;
    this.onSettled((run) => {
      void secrets.release(run).catch((error: unknown) => { this.#deps.log.error('run.arg-secrets.release-failed', { run: run.id, error: messageOf(error) }); });
    });
  }

  /** Set the executor for one kind of target. */
  use(kind: ExecutorKind, executor: RunExecutor): void {
    this.#executors.set(kind, executor);
  }

  async start(given: RunInput): Promise<{ run: RunId; settled: Promise<RunSettled> }> {
    const { catalog, store, clock } = this.#deps;
    let input = given;
    const fn = await catalog.fn(input.fn);
    if (fn === undefined) throw new RunRefused(fnError('caller', `There is no fn ${input.fn}.`, 'not-found'));
    // a call its caller already refused because the fn is blocked (held, off, offline, an account to connect) is still
    // kept, settled invalid-input at once and never run, so the chat sees what blocked it (`InvalidInput.blocked`)
    const blockedCall = input.invalid?.blocked !== undefined;
    if (fn.disabled && !blockedCall) throw new RunRefused(fnError('caller', `${input.fn} is turned off.`, 'disabled'));
    // an admin's test call (and what it calls) runs on an installed system, which offers nothing else yet
    const test = input.test === true || (input.parent !== undefined && (await store.table('runs').get(input.parent))?.test === true);
    if (fn.available !== true && !blockedCall && !(test && await this.#testable(fn))) throw new RunRefused(fnError('retry', `${input.fn} is unavailable: ${fn.available.detail}`, 'unavailable'));
    const turn = await store.table('turns').get(input.turn);
    if (turn === undefined) throw new RunRefused(fnError('fatal', `There is no turn ${input.turn}.`, 'not-found'));
    // a fn the turn's person may not see is as good as missing to them; a per-person fn needs a connection to act as
    const access = await this.#deps.access.scope(turn.user.id);
    if (!access.seesFn(fn)) throw new RunRefused(fnError('caller', `There is no fn ${input.fn}.`, 'not-found'));
    // the args checked against the fn's (its signature's `check`, every caller's): an object or list sent as a string
    // holding its JSON is read as that JSON, and the run says so, with what the caller repaired already (a model's call
    // core decoded); input already refused is not checked (a blocked fn's signature may not even resolve, its kind gone)
    const argsCheck = input.invalid === undefined ? (await catalog.signature(fn.name)).check(input.args) : undefined;
    const found = argsCheck?.ok === true ? repairsOf(input.args, argsCheck.value) : [];
    const repairs = mergedRepairs(input.repairs ?? [], found);
    if (argsCheck?.ok === true && found.length > 0) input = { ...input, args: argsCheck.value };
    if (repairs.length > 0) {
      this.#deps.log.info('run.args-repaired', { fn: fn.name, turn: input.turn, repairs: repairs.map((repair) => `${repair.path || '(args)'}: ${repair.repair}`) });
    }
    const connection = access.connection(fn, input.args);
    if (connection?.state === 'missing' && !blockedCall) throw new RunRefused(fnError('retry', `${input.fn} acts as you: connect your account on the ${connection.page} page first.`, 'unavailable'));
    // a call through a key that signs in, with no connection to it, could only fail in the run: refused before any
    // approval is asked for it
    const unconnected = connection === undefined && !blockedCall ? await this.#deps.connections.unconnected(fn, input.args) : undefined;
    if (unconnected !== undefined) throw new RunRefused(notConnected(unconnected));
    const parent = input.parent === undefined ? undefined : await store.table('runs').get(input.parent);
    if (input.parent !== undefined && parent === undefined) throw new RunRefused(fnError('fatal', `There is no parent run ${input.parent}.`, 'not-found'));
    if (parent !== undefined) {
      const existing = await this.#child(parent.id, input.key);
      if (existing !== undefined) return { run: existing.id, settled: this.#waitFor(existing) };
      await this.#checkDep(parent, fn);
    }
    // a call made while its parent's args are checked (or under such a call) only reads, and never waits for anyone
    const checking = parent === undefined ? undefined : this.#checking.get(parent.id);
    if (parent !== undefined && checking !== undefined) await this.#checkCall(parent, fn, checking);
    // a check's call that comes once the hub stopped waiting for it (its deadline passed) is never run unchecked
    if (parent !== undefined && checking === undefined && input.key.startsWith(ARGS_CHECK_KEY_PREFIX)) {
      throw new RunRefused(fnError('caller', `${parent.fn}'s args check is over, so its calls are no longer taken.`, CHECK_CALL_CODE));
    }
    const handlers = suppliedHandlers(fn, parent, input.handlers);
    const missing = Object.entries(fn.decl.handlers).filter(([name, decl]) => decl.required && !handlers.includes(name)).map(([name]) => name);
    if (missing.length > 0) throw new RunRefused(fnError('fatal', `${fn.name} needs its caller to answer ${missing.join(', ')}, which this caller can't.`, 'needs-handlers'));
    // input already refused is not checked again (a blocked fn's signature may not even resolve, its kind gone)
    const checked = input.invalid ?? (argsCheck === undefined ? undefined : invalidArgs(argsCheck));
    const system = SystemName.parse(executingSystem(fn));
    // the one place a system's run is given its instance: a fleet with no clear pick is refused input the caller can fix
    const routed = checked === undefined && executorKind(fn) === 'system'
      ? await this.#deps.instances.route({ system, args: input.args, on: input.on, session: input.session, routing: fn.decl.routing })
      : undefined;
    const refused = checked ?? (routed !== undefined && 'invalid' in routed ? routed.invalid : undefined);
    const instance = routed !== undefined && 'instance' in routed ? routed.instance.instance : undefined;

    const id = mintId('run', this.#deps.random);
    // secrets in the args never rest in plain text: the row, its approval and its views hold them sealed
    const sealing = this.#argSecrets === undefined ? { args: input.args } : await this.#argSecrets.seal({ run: id, fn: fn.name, args: input.args, owner: input.actor });
    const { args } = sealing;
    // a hub fn's own check (a record's value against its type) runs on the args as given, before anyone is asked
    const early = refused ?? sealing.invalid ?? await this.#executors.get(executorKind(fn))?.check?.({ id, fn: fn.name, args: input.args }, turn.user.id);
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
      args,
      ...(repairs.length === 0 ? {} : { repairs: [...repairs] }),
      ...(test ? { test: true } : {}),
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
    // what a call under an args check calls is held to the same rules, until it settles
    if (checking !== undefined) this.#underCheck(id, settled);

    // a fn that checks its own args (`FnDecl.check`) does so once the run exists, before anyone is asked
    const invalid = early ?? await this.#argsCheck(run, fn, turn.user);
    if (invalid !== undefined) {
      // refused input never reaches the policies or the fn: the caller hears the problems and may try again
      this.#deps.log.info('run.invalid-input', { run: id, fn: fn.name, source: invalid.source, problems: invalid.problems.length });
      await this.settle(id, { status: 'invalid-input', invalid });
      return { run: id, settled };
    }
    // a fn that touches files says first which sensitive ones the call would touch: a refusal stops it here
    const flagged = fn.decl.flags === true ? await this.#flags(run, fn, turn.user) : { flags: [] };
    if ('refused' in flagged) {
      await this.settle(id, flagged.refused);
      return { run: id, settled };
    }
    const sensitive = flagsVerdict(flagged.flags);
    if (sensitive.effect === 'refuse') {
      this.#deps.log.info('run.flags-refused', { run: id, fn: fn.name, flags: flagged.flags.length });
      await this.settle(id, { status: 'invalid-input', invalid: { source: 'validation', problems: [{ path: '', message: sensitive.reason }] } });
      return { run: id, settled };
    }
    // a chat's fn mode stands in front of the policies for the calls its agent makes
    const mode = await this.#mode(run, fn, parent, flagged.flags);
    if (mode.effect === 'refuse') {
      await this.settle(id, { status: 'failed', error: fnError('caller', mode.reason, 'chat-mode') });
      return { run: id, settled };
    }
    // the preview is asked for only when an approval is made; a refusal settles the run with the system's reason
    const previewed: { refused?: OutcomeWire; ask?: ProposalAsk } = {};
    // the flags lead the card of a call that touches sensitive files, before what the system or auto mode says
    const flagParts: PreviewPart[] = sensitive.effect === 'ask' ? [{ type: 'flags', flags: flagged.flags }] : [];
    const modeParts: PreviewPart[] = mode.effect === 'ask' ? [{ type: 'text', text: mode.reason }] : [];
    const asked: ApprovalPreview | undefined = flagParts.length > 0
      ? { title: `${fn.name} touches sensitive files`, parts: [...flagParts, ...modeParts], irreversible: false }
      : mode.effect === 'ask' ? { title: `Auto mode asks you about ${fn.name}`, parts: modeParts, irreversible: false } : undefined;
    const preview = fn.decl.approval?.preview === true
      ? async (): Promise<ApprovalPreview | undefined> => {
        const answer = await this.#preview(run, fn, turn.user);
        if ('preview' in answer) {
          if (answer.ask !== undefined) previewed.ask = answer.ask;
          return { ...answer.preview, parts: [...flagParts, ...modeParts, ...answer.preview.parts] };
        }
        previewed.refused = answer.refused;
        return undefined;
      }
      : asked === undefined ? undefined : () => Promise.resolve(asked);
    const decision = await this.#deps.policies.decide({
      fn: fn.name, actor: input.actor, turnUser: turn.user.id, args, run: id, caller: input.caller, ...(input.session === undefined ? {} : { session: input.session }),
      ...(preview === undefined ? {} : { preview, form: () => previewed.ask }),
      ...(sensitive.effect === 'ask' ? { sensitive: true } : {}),
      ...(mode.effect === 'ask' ? { ask: { by: 'turn-user' } } : {}),
      ...(mode.effect === 'allow' ? { autoAllowed: true } : {}),
      ...(await this.#withinParent(fn, parent) ? { withinParent: true } : {}),
      // an A/B compare's variant (its session is a fork): what would change something asks in each variant
      ...(await this.#variantOf(input.session)),
      // the fns of the runs this call is made under, for policies that match by caller (`FnMatch.via`)
      ...(parent === undefined ? {} : { via: await this.#via(parent) }),
      // a per-person fn its person keeps on 'ask first' waits for the connection's owner
      ...(connection?.state === 'ready' && connection.option.ask ? { ask: connection.connection.owner === turn.user.id ? { by: 'turn-user' } : { by: 'actor', actor: connection.connection.owner } } : {}),
      ...(checking === undefined || parent === undefined ? {} : { noAsk: `${fn.name} would wait for approval, and a call made to check ${parent.fn}'s args can't wait for anyone.` }),
    });
    if (previewed.refused !== undefined) {
      await this.settle(id, previewed.refused);
    } else if (decision.effect === 'deny') {
      await this.settle(id, { status: 'failed', error: fnError('caller', `Not allowed: ${decision.reason}`, DECLINED_CODE) });
    } else if (decision.effect === 'ask') {
      await this.#moveTo(run, { status: 'awaiting-approval' }, fn);
    } else {
      this.#enqueue(run);
    }
    if (input.background) await this.background(id);
    return { run: id, settled };
  }

  /** The fns of a run and the runs above it, nearest first (what a policy's `via` is matched against). */
  async #via(parent: Run): Promise<QualifiedName[]> {
    const fns: QualifiedName[] = [];
    let run: Run | undefined = parent;
    // a tree is shallow; the bound only guards against a broken parent chain
    for (let depth = 0; run !== undefined && depth < MAX_VIA_DEPTH; depth++) {
      fns.push(run.fn);
      run = run.parent === undefined ? undefined : await this.#deps.store.table('runs').get(run.parent);
    }
    return fns;
  }

  /** The compare variant a session is the fork of, if it is one (`Session.fork`). */
  async #variantOf(session: SessionId | undefined): Promise<{ variant?: CompareFork }> {
    const fork = session === undefined ? undefined : (await this.#deps.store.table('sessions').get(session))?.fork;
    return fork === undefined ? {} : { variant: fork };
  }

  /** Whether a run of the fn's own system calls it, and that run's fn declares at least the fn's mode (`withinParent`). */
  async #withinParent(fn: FnRecord, parent: Run | undefined): Promise<boolean> {
    if (parent === undefined || parent.system !== fn.system || fn.system === HUB_SYSTEM) return false;
    const mode = fn.decl.effects?.mode;
    const parentMode = (await this.#deps.catalog.fn(parent.fn))?.decl.effects?.mode;
    return mode !== undefined && parentMode !== undefined && FN_MODES.indexOf(parentMode) >= FN_MODES.indexOf(mode);
  }

  /** What the run's chat's fn mode says about it: only calls an agent makes in a session are checked. */
  async #mode(run: Run, fn: FnRecord, parent: Run | undefined, flags: readonly SensitivityFlag[]): Promise<ModeVerdict> {
    if (this.#gate === undefined || parent?.kind !== AGENT_KIND || run.session === undefined) return { effect: 'pass' };
    const session = await this.#deps.store.table('sessions').get(run.session);
    if (session === undefined) return { effect: 'pass' };
    const verdict = await this.#gate.check({ session, fn, args: run.args, run: run.id, flags });
    if (verdict.effect !== 'pass') this.#deps.log.info('run.chat-mode', { run: run.id, fn: fn.name, mode: session.fnMode ?? null, effect: verdict.effect });
    return verdict;
  }

  /**
   * A native fn's own check of a call's args (`FnDecl.check`, `checkArgs` on the system link), after they parse and
   * before the policies: its problems as refused input (a few at most, each clipped), or undefined when it found none.
   * A check that can't run (its system not connected, an error, `HARNESS_ARGS_CHECK_TIMEOUT` passed) is logged and
   * the call goes on as if the fn had none: it is checked again by the run itself.
   */
  async #argsCheck(run: Run, fn: FnRecord, user: UserInfo): Promise<InvalidInput | undefined> {
    if (fn.decl.check === undefined || fn.decl.kind !== 'native') return undefined;
    const { log, clock } = this.#deps;
    const connection = this.#deps.link.connection(run.system, run.instance);
    if (connection === undefined) {
      log.warn('run.args-check-skipped', { run: run.id, fn: fn.name, reason: `${run.system} is not connected` });
      return undefined;
    }
    const timeout = this.#deps.settings.execution.HARNESS_ARGS_CHECK_TIMEOUT;
    this.#checking.set(run.id, 'check');
    try {
      const answer = await connection.peer.call('checkArgs', {
        run: run.id, fn: splitName(run.fn).local, args: run.args, user, deadline: clock() + timeout,
      }, { signal: AbortSignal.any([connection.signal, AbortSignal.timeout(timeout)]) });
      const [first, ...rest] = answer.problems.slice(0, CONCISE_LIMITS.max).map((problem): InputProblem => ({ path: problem.path, message: clip(problem.message, CONCISE_LIMITS.chars) }));
      if (first === undefined) return undefined;
      log.info('run.args-check-refused', { run: run.id, fn: fn.name, problems: answer.problems.length });
      return { source: 'validation', problems: [first, ...rest] };
    } catch (error) {
      log.warn('run.args-check-skipped', { run: run.id, fn: fn.name, reason: messageOf(error) });
      return undefined;
    } finally {
      this.#checking.delete(run.id);
    }
  }

  /**
   * Refuse a call an args check may not make: the checked run's calls must be the deps its check declares
   * (`FnArgsCheck.deps`), and every call under a check must be of a fn whose mode is `read`.
   */
  async #checkCall(parent: Run, fn: FnRecord, checking: 'check' | 'under'): Promise<void> {
    if (checking === 'check') {
      const declared = (await this.#deps.catalog.fn(parent.fn))?.decl.check?.deps ?? [];
      if (!declared.includes(fn.name)) {
        throw new RunRefused(fnError('caller', `${parent.fn}'s args check may call only the deps its check declares (${declared.join(', ') || 'none'}), not ${fn.name}.`, CHECK_CALL_CODE));
      }
    }
    const mode = fnMode(fn.decl);
    if (mode !== 'read') throw new RunRefused(fnError('caller', `A call made to check ${parent.fn}'s args may only read, and ${fn.name} is a ${mode} fn.`, CHECK_CALL_CODE));
  }

  /** Hold a call made under an args check to the check's rules until it settles. */
  #underCheck(run: RunId, settled: Promise<RunSettled>): void {
    this.#checking.set(run, 'under');
    void settled.finally(() => { this.#checking.delete(run); });
  }

  /**
   * What a run of a fn that always asks would do, from its system (`preview` on the system link), before anyone is
   * asked; or how the run settles instead: invalid input with the system's reason, or a retryable failure when the
   * system can't be reached. An install card is checked against the hub's instances and gets its summary (`installCard`).
   */
  async #preview(run: Run, fn: FnRecord, user: UserInfo): Promise<{ preview: ApprovalPreview; ask?: ProposalAsk } | { refused: OutcomeWire }> {
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
      // an install card is checked against the hub's own instances, which the system can't see
      const checked = await installCard(answer, run.args, { instance: (ref) => this.#deps.store.table('instances').get(ref), manifest: (name) => this.#deps.catalog.manifest(name), agents: () => agentNames(this.#deps.store) });
      // a choice the system offers on the card goes with its preview
      if ('preview' in checked) return 'preview' in answer && answer.ask !== undefined ? { ...checked, ask: answer.ask } : checked;
      return { refused: { status: 'invalid-input', invalid: { source: 'validation', problems: [{ path: '', message: checked.refused }] } } };
    } catch (error) {
      return away(messageOf(error));
    }
  }

  /**
   * The sensitive files a run of a fn that declares `flags` would touch, from its system (`flags` on the system link);
   * or, when the system can't be reached or answers wrongly, a retryable failure: an unchecked call never goes ahead.
   */
  async #flags(run: Run, fn: FnRecord, user: UserInfo): Promise<{ flags: SensitivityFlag[] } | { refused: OutcomeWire }> {
    const system = executingSystem(fn);
    const connection = system === run.system ? this.#deps.link.connection(run.system, run.instance) : this.#deps.link.connection(SystemName.parse(system));
    const away = (why: string): { refused: OutcomeWire } => ({ refused: { status: 'failed', error: fnError('retry', `${run.fn} can't check which sensitive files it would touch: ${why}`, 'unavailable') } });
    if (connection === undefined) return away(`${system} is not connected`);
    try {
      const answer = await connection.peer.call('flags', {
        run: run.id, fn: splitName(run.fn).local, args: run.args, user,
        ...(fn.decl.kind === 'native' ? {} : { kind: fn.decl.kind }),
        ...(fn.decl.payload === undefined ? {} : { payload: fn.decl.payload }),
      }, { signal: connection.signal });
      return { flags: answer.flags };
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
    const invalid = invalidArgs((await catalog.signature(name)).check(input.args));
    if (invalid !== undefined) throw new RunRefused(fnError('caller', `The args don't fit ${name}: ${invalid.problems.map(problemLine).join('; ')}`, INVALID_INPUT_CODE));
    // build 9: outside a run, a proposal may wait for a person (a Claude session's owner) instead of the admins
    const person = parent === undefined && input.for !== undefined ? await this.#waitsFor(input, input.for) : undefined;
    const chat = person !== undefined && input.chat !== undefined && await this.#inChat(input.chat, person) ? input.chat : undefined;
    const turn = parent === undefined ? await this.#systemTurn(input.system) : await this.#turn(parent);
    const id = mintId('run', this.#deps.random);
    const { operations } = fn.decl;
    const run: Run = {
      id, fn: name, fnVersion: fn.version, kind: fn.decl.kind, system: input.system, instance: input.instance, root: parent?.root ?? id, turn: turn.id,
      ...(parent?.session === undefined ? {} : { session: parent.session }),
      ...(chat === undefined ? {} : { session: chat }),
      ...(parent === undefined ? {} : { parent: parent.id }),
      key, actor: parent?.actor ?? person ?? turn.actor, caller: turn.actor, args: input.args, status: 'awaiting-approval',
      allowed: { cancel: operations.cancel, pause: operations.pause, background: operations.background },
      cost: 0, totalCost: 0, priority: parent?.priority ?? turn.limits.priority, background: false, attempt: 1, errors: [], stateChanges: [], createdAt: clock(),
    };
    const text = await this.#wording.text(run, { status: 'awaiting-approval' }, fn);
    await store.table('runs').insert(text === undefined ? run : { ...run, text });
    if (parent === undefined) await store.table('turns').update(turn.id, { root: id });
    this.#publish(run, statusUpdate('awaiting-approval', text));
    this.#deps.log.info('run.proposed', { run: id, fn: name, parent: parent?.id ?? null, approver: input.approver });
    const approver: Approver = person !== undefined ? { by: 'actor', actor: person } : input.approver === 'admins' ? { by: 'admins' } : { by: 'turn-user' };
    const approval = await this.#deps.policies.propose({
      run: id, fn: name, approver, preview: input.preview, turnUser: turn.user.id, ...(run.session === undefined ? {} : { session: run.session }),
      ...(input.ask === undefined ? {} : { ask: input.ask }),
    });
    return { run: id, approval: approval.id };
  }

  /**
   * Build 9: the person a proposal outside a run waits for, when its key names (`proposalKeyFor`) a record of one of
   * the system's stored types they own, or a run of the system they started. Anything else is refused and logged: a
   * system can't put cards in the inbox of someone it does no work for.
   */
  async #waitsFor(input: ProposeRun & { system: SystemName }, person: ActorId): Promise<ActorId> {
    const { store } = this.#deps;
    const subject = proposalSubjectOf(input.key);
    const actor = await store.table('actors').get(person);
    const owns = actor?.kind !== 'user' || actor.disabled || subject === undefined ? false
      : 'record' in subject
        ? await store.table('records').get(subject.record).then((record) => record?.owner === person && splitName(record.type).system === input.system)
        : await store.table('runs').get(subject.run).then((run) => run?.system === input.system && run.actor === person);
    if (!owns) {
      this.#deps.log.warn('run.propose.for-refused', { system: input.system, fn: input.fn, for: person });
      throw new RunRefused(fnError('caller', `${input.system} can only ask ${person} about a session or run of theirs: the key must start with its id.`, 'not-yours'));
    }
    return person;
  }

  /** Whether a person is in a chat (a proposal's card shows there only then). */
  async #inChat(chat: SessionId, person: ActorId): Promise<boolean> {
    const session = await this.#deps.store.table('sessions').get(chat);
    const there = session?.participants.some((participant) => participant.actor === person) === true;
    if (!there) this.#deps.log.warn('run.propose.chat-skipped', { chat, for: person });
    return there;
  }

  /**
   * A run proposed outside any run under this key that is still open (waiting or running), if one is. A settled one
   * (done, declined, cancelled) doesn't count: nothing replays a system's own proposal, so the same key proposes afresh
   * (a rescan finding the same changes again after an admin declined them, or after they were applied).
   */
  async #proposedBefore(fn: Run['fn'], key: string): Promise<Run | undefined> {
    // the same key may also name a child proposed under some run, so look past those
    for await (const run of rows(this.#deps.store.table('runs'), { where: { fn, key } })) {
      if (run.parent === undefined && isUnsettled(run.status)) { return run; }
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

  async systemWork(system: SystemName, instance: InstanceName): Promise<Run> {
    const { store, clock, catalog } = this.#deps;
    const turn = await this.#systemTurn(system);
    const fn = await catalog.fn(SYSTEM_CALLS_FN);
    const id = mintId('run', this.#deps.random);
    const run: Run = {
      id, fn: SYSTEM_CALLS_FN, fnVersion: fn?.version ?? '', kind: 'native', system, instance, root: id, turn: turn.id, key: `system-calls:${id}`,
      actor: turn.actor, caller: turn.actor, args: {}, status: 'running', allowed: { cancel: false, pause: false, background: false },
      cost: 0, totalCost: 0, priority: turn.limits.priority, background: false, attempt: 1, errors: [], stateChanges: [], createdAt: clock(),
    };
    await store.table('runs').insert(run);
    await store.table('turns').update(turn.id, { root: id });
    return run;
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
    const error = outcome.status === 'failed' || outcome.status === 'cancelled' ? outcome.error : undefined;
    const errors = error === undefined ? run.errors : [...run.errors, { attempt: run.attempt, error, cost, at: now }];
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

  /**
   * Run a stopped run again from the loop state given (`resume`): a failed or cancelled run goes back to the queue as
   * a resume, its outcome and end cleared. False when it hasn't stopped that way. The agent loop's Continue uses it.
   */
  async reopen(id: RunId, resume: Json, by: ActorId): Promise<boolean> {
    const run = await this.get(id);
    if (run === undefined || (run.status !== 'failed' && run.status !== 'cancelled')) return false;
    const { outcome: _outcome, endedAt: _endedAt, ...kept } = run;
    const reopened = await this.#deps.store.table('runs').put({ ...kept, resume });
    this.#resumes.set(id, 'resumed');
    const queued = await this.#moveTo(reopened, { status: 'queued' });
    this.#deps.log.info('run.reopen', { run: id, by, was: run.status });
    this.#enqueue(queued);
    return true;
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
      args: this.#argSecrets === undefined ? run.args : await this.#argSecrets.unseal(run),
      budget: { cost: left.cost, time: Math.max(0, turnDeadline - now), limitedBy: left.limitedBy },
      handlers: [...(this.#handlers.get(run.id) ?? [])],
      ...(resume === undefined ? {} : { resume }),
      deadline: deadline.at,
      configVersion: configured?.version ?? 0,
      ...(await this.#connection(run, fn, turn)),
      ...(await this.#approvedOn(run, fn)),
    };
  }

  /**
   * The approval a run of a fn with `approval` or `flags` went ahead on (`ctx.approved`): who approved it and the
   * preview they saw, so the system can check it runs what was approved (fs shows sensitive files only to a run the
   * person approved after a flags ask). Nothing for other fns or runs that weren't asked about.
   */
  async #approvedOn(run: Run, fn: FnRecord): Promise<Pick<RunRequest, 'approved'>> {
    if ((fn.decl.approval === undefined && fn.decl.flags !== true) || run.approvedAt === undefined) return {};
    const page = await this.#deps.store.table('approvals').find({ where: { run: run.id, status: 'approved' }, order: [['createdAt', 'desc']], limit: 1 });
    const approval = page.items[0];
    const by = approval?.decisions.findLast((d) => d.approve)?.by;
    return approval?.preview === undefined || by === undefined ? {} : { approved: { by, preview: approval.preview } };
  }

  /**
   * The connection a per-person fn's run acts as, credentials revealed; nothing for any other fn. It is the one pinned
   * when the run started, so the account approved is the account used: if that one is gone, off or no longer shared,
   * the run fails rather than act as another.
   */
  async #connection(run: Run, fn: FnRecord, turn: Turn): Promise<Pick<RunRequest, 'connection'>> {
    const gate = (await this.#deps.access.scope(turn.user.id)).connection(fn, run.args);
    if (gate === undefined) return {};
    if (gate.state !== 'ready' || gate.connection.id !== run.connection) {
      throw new RunRefused(fnError('retry', `${fn.name} was started to act as an account that is no longer connected or shared with you; ask again.`, 'unavailable'));
    }
    return { connection: await this.#deps.connections.forRun(gate.connection) };
  }

  /** Who and when a run is for, as its system reads it (`RunInfo`). */
  info(run: Run): Promise<RunInfo> {
    return this.#info(run);
  }

  async #info(run: Run, known?: Turn): Promise<RunInfo> {
    const turn = known ?? (await this.#turn(run));
    const parent = run.parent === undefined ? undefined : await this.get(run.parent);
    const connection = this.#deps.link.connection(run.system, run.instance);
    const inChat = chatOwn(run, parent);
    const watched = inChat && run.session !== undefined && await this.#deps.presence.active(run.session);
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
      ...(watched ? { watched } : {}),
      ...(inChat ? { inChat } : {}),
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

  /**
   * Whether a test call (or a child of one) may run a fn that is unavailable: only when the one thing keeping it off is
   * that its executing system is installed and not live yet. A fn switched off, a system paused or away, and anything on
   * a live system (held for review, a kind switched off) stays unavailable to tests too.
   */
  async #testable(fn: FnRecord): Promise<boolean> {
    if (fn.disabled) return false;
    const system = SystemName.parse(executingSystem(fn));
    const record = await this.#deps.store.table('systems').get(system);
    return record?.stage === 'installed' && systemAvailability(system, record, { staged: false }) === true;
  }

  /**
   * A child call must be to one of its parent's declared deps. Agents call what their tools allow (checked by the agent
   * loop), and the hub's own fns call what the hub's code does (`hub/resource_import` fetching a URL through
   * `web/fetch_raw`): no system declares those.
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
    // a declined run did not fail: it is cancelled, with who declined and why in its errors and the caller's reply
    await this.settle(id, { status: 'cancelled', error: fnError('caller', message, DECLINED_CODE) });
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
    const proposed = run.key.startsWith(PROPOSED_KEY);
    if (!proposed && (run.session === undefined || run.kind !== AGENT_KIND)) return;
    const status = run.status === 'done' || run.status === 'undone' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'failed';
    await this.#deps.turns.settle(run.turn, status);
  }

  /** Move a run to a new status (with what changes alongside), worded for its phase, stored and published. */
  async #moveTo(run: Run, patch: Partial<Run> & Pick<Run, 'status'>, fn?: FnRecord): Promise<Run> {
    // a declined run carries who declined it and why, so a system that proposed it hears the reason
    const declined = patch.outcome?.status === 'cancelled' && patch.outcome.error?.code === DECLINED_CODE ? patch.outcome.error.message : undefined;
    const text = declined === undefined ? await this.#wording.text(run, patch, fn) : { phase: 'failed' as const, one: declined, many: declined };
    const updated = await this.#deps.store.table('runs').update(run.id, text === undefined ? patch : { ...patch, text });
    this.#publish(updated, statusUpdate(updated.status, text));
    return updated;
  }

  #publish(run: Run, update: RunUpdate): void {
    this.#deps.bus.publish('run.update', { run: run.id, fn: run.fn, update, ...(run.session === undefined ? {} : { session: run.session }) });
  }
}
