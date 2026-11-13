/**
 * A system under test in one line: `testHub(contract, impl)` serves it to a fake hub in memory (the real link,
 * handshake, runtime and wire checks; every `ctx.*` call the system makes reaches the fake hub and is recorded), and
 * `call` runs a fn with typed args and gives back its typed result, its progress and what it asked the hub for.
 *
 * ```ts
 * const kit = await testHub(notes, impl, { config: { folder: 'x' }, model: mockModel(['Hello.']) });
 * const { result, hubCalls } = await kit.call('echo', { text: 'hi' });
 * await kit.stop();
 * ```
 */
import { qualify, type Json, type DataRecord, type KindDescription, type MentionOption as WireMentionOption, type OutcomeWire, type QualifiedName, type ResultTable, type RunRequest, type SensitivityFlag, type VisualRank } from '@harness/core';
import type { KindDef } from '../declare.ts';
import type { AnyFnDef, FnDef, TypesOf } from '../fn.ts';
import { encodeValue, parseValue } from '../gin.ts';
import type { ModelLink } from '../server/llm.ts';
import type { RunningSystem, ServeOptions } from '../server/index.ts';
import { FakeHub, type FakeHubOptions } from '../server/testing.ts';
import type { ContractShape, SystemContract, SystemImpl } from '../system.ts';
import { BUILT_IN_CONTRIBUTIONS, rankedVisuals, resultFacts } from '../widgets.ts';

/** A fn of the contract, by local name. */
export type FnNameOf<C extends ContractShape> = keyof C['fns'] & string;
/** A fn's args, as its implementation receives them. */
export type FnArgsOf<C extends ContractShape, K extends FnNameOf<C>> = TypesOf<C['fns'][K]>['args'];
/** A fn's result, as its implementation returns it. */
export type FnResultOf<C extends ContractShape, K extends FnNameOf<C>> = TypesOf<C['fns'][K]>['result'];
/** A kind of the contract, by local name. */
export type KindNameOf<C extends ContractShape> = keyof C['kinds'] & string;
/** A kind's payload. */
export type KindPayloadOf<C extends ContractShape, K extends KindNameOf<C>> = C['kinds'][K] extends KindDef<infer P> ? P : never;

/** What a run asked of the hub, by endpoint, in order: the records the fake hub made while it ran. */
export interface HubCalls {
  /** Child fn calls (`ctx.call`, deps, `hub/*` fns). */
  readonly calls: FakeHub['calls'];
  /** Chat model requests (`ctx.ai()`, `ctx.llm`). */
  readonly forwards: FakeHub['forwards'];
  /** Other model calls: embeddings, images, speech. */
  readonly models: FakeHub['models'];
  /** Questions for the decision model (`ctx.decide`). */
  readonly decisions: FakeHub['decisions'];
  /** Runs it proposed (`ctx.propose`). */
  readonly proposals: FakeHub['proposals'];
  /** Handlers it asked its caller to answer. */
  readonly handled: FakeHub['handled'];
  readonly attachments: FakeHub['attachments'];
  readonly shares: FakeHub['shares'];
  /** Type definitions it asked for (`ctx.types.definitions`). */
  readonly typeRequests: FakeHub['typeRequests'];
  /** Example changes it sent. */
  readonly examples: FakeHub['exampleChanges'];
  /** Runtime contract changes (fns, context, … added or removed). */
  readonly patches: FakeHub['patches'];
}

/** How a run ended, with a done result decoded to the fn's own result type. */
export type TestOutcome<R> = (Omit<Extract<OutcomeWire, { status: 'done' }>, 'result'> & { readonly result: R }) | Exclude<OutcomeWire, { status: 'done' }>;

/** A run of a fn under test: how it ended, the progress it reported and what it asked the hub for. */
export interface TestRun<R> {
  readonly outcome: TestOutcome<R>;
  readonly progress: FakeHub['progress'];
  readonly hubCalls: HubCalls;
}

/** A finished run: its typed result, the progress it reported and what it asked the hub for. */
export interface TestCall<R> {
  readonly result: R;
  readonly progress: FakeHub['progress'];
  readonly hubCalls: HubCalls;
}

/** A run that `call` expected to finish but didn't; `outcome` says how it ended. */
export class CallNotDone extends Error {
  readonly outcome: Exclude<OutcomeWire, { status: 'done' }>;

  constructor(fn: string, outcome: Exclude<OutcomeWire, { status: 'done' }>) {
    super(`${fn} ended ${outcome.status}: ${JSON.stringify(outcome).slice(0, 600)}`);
    this.name = 'CallNotDone';
    this.outcome = outcome;
  }
}

/** What a kind makes of a payload: the problems with it, and the fn props it derives (signature, facts, display, …). */
export interface KindProps {
  readonly problems: readonly string[];
  readonly description: KindDescription | undefined;
}

/** How `testHub` sets up the fake hub and the system. */
export interface TestHubOptions {
  /** The system's config, as a plain value (absent: none, so a system that needs one waits as `needs-config`). */
  readonly config?: unknown;
  /** The model behind `ctx.ai()` and `ctx.llm`: `mockModel(...)`, `realModel.link()`, … (default: answers `ok`). */
  readonly model?: ModelLink | undefined;
  /** More fake hub options (pairing, instance, auto-pair, …). */
  readonly hub?: Omit<FakeHubOptions, 'config'>;
  /** More serve options (its context folder, files, fetch, version, …). */
  readonly serve?: Partial<Omit<ServeOptions, 'hub' | 'state'>>;
  /** Records the hub keeps before the system starts (what a restarted system finds), as stored. */
  readonly records?: readonly DataRecord[];
}

/** A system served to a fake hub: run its fns and kinds, read what it asked the hub for, and stop it. */
export class TestSystem<N extends string, C extends ContractShape> {
  /** The fake hub, to script (`onCall`, `onDecide`, …) and read everything it recorded. */
  readonly hub: FakeHub;
  readonly running: RunningSystem<N>;
  readonly contract: SystemContract<N, C>;

  constructor(contract: SystemContract<N, C>, hub: FakeHub, running: RunningSystem<N>) {
    this.contract = contract;
    this.hub = hub;
    this.running = running;
  }

  /** Run a fn with typed args; its outcome (a done result decoded to its type), progress and hub calls. */
  async run<K extends FnNameOf<C>>(name: K, args: FnArgsOf<C, K>, extra: Partial<Omit<RunRequest, 'fn' | 'args'>> = {}): Promise<TestRun<FnResultOf<C, K>>> {
    const def = this.#fn(name);
    const before = this.#marks();
    const progressFrom = this.hub.progress.length;
    const outcome = await this.hub.run(qualify(this.contract.name, name), encodeValue(def.args, args), extra);
    const typed: TestOutcome<FnResultOf<C, K>> = outcome.status === 'done'
      ? { ...outcome, result: parseValue(def.returns, outcome.result) }
      : outcome;
    return { outcome: typed, progress: this.hub.progress.slice(progressFrom), hubCalls: this.#since(before) };
  }

  /** Run a fn that should finish: its typed result, progress and hub calls; `CallNotDone` when it doesn't. */
  async call<K extends FnNameOf<C>>(name: K, args: FnArgsOf<C, K>, extra: Partial<Omit<RunRequest, 'fn' | 'args'>> = {}): Promise<TestCall<FnResultOf<C, K>>> {
    const { outcome, progress, hubCalls } = await this.run(name, args, extra);
    if (outcome.status !== 'done') { throw new CallNotDone(qualify(this.contract.name, name), outcome); }
    return { result: outcome.result, progress, hubCalls };
  }

  /**
   * Run a fn of one of the contract's kinds, as the hub runs a saved fn of the kind (a code program, an API request):
   * `fn` is its local name, `payload` the kind's typed payload, `args` the fn's args as JSON. Its outcome (the result
   * as JSON, since a kind fn's result type is its own), progress and hub calls.
   */
  async runKind<K extends KindNameOf<C>>(kind: K, fn: string, payload: KindPayloadOf<C, K>, args: Json, extra: Partial<Omit<RunRequest, 'fn' | 'args' | 'kind' | 'payload'>> = {}): Promise<TestRun<Json>> {
    const def = this.#kind(kind);
    const before = this.#marks();
    const progressFrom = this.hub.progress.length;
    const outcome = await this.hub.run(qualify(this.contract.name, fn), args, { ...extra, kind: qualify(this.contract.name, kind), payload: encodeValue(def.payload, payload) });
    return { outcome, progress: this.hub.progress.slice(progressFrom), hubCalls: this.#since(before) };
  }

  /** Approve a run the system proposed (by its key, approval id or run id), with the answer its `ask` wants; see `FakeHub.approveProposal`. */
  approve(proposal: string, answer?: Json): Promise<OutcomeWire> {
    return this.hub.approveProposal(proposal, answer === undefined ? {} : { answer });
  }

  /** Decline a run the system proposed, with the approver's reason; see `FakeHub.declineProposal`. */
  decline(proposal: string, reason?: string): Promise<void> {
    return this.hub.declineProposal(proposal, reason);
  }

  /** What a kind makes of a payload, as the hub asks it when a fn of the kind is saved. */
  async kindProps<K extends KindNameOf<C>>(kind: K, payload: KindPayloadOf<C, K>): Promise<KindProps> {
    const def = this.#kind(kind);
    const answer = await this.hub.peer().call('check', { kind, payload: encodeValue(def.payload, payload) });
    return { problems: answer.problems, description: answer.description };
  }

  /**
   * The sensitive files a run of a fn with these args would touch, as the hub asks before running it (`flags`): the fn's
   * own `flags(args, ctx)`; none for a fn that declares no `flags`.
   */
  async flags<K extends FnNameOf<C>>(name: K, args: FnArgsOf<C, K>): Promise<SensitivityFlag[]> {
    const def = this.#fn(name);
    const fn = qualify(this.contract.name, name);
    const request = this.hub.request(fn, encodeValue(def.args, args));
    const answer = await this.hub.flags({ fn: name, kind: 'native', args: request.args, run: request.run.id, user: request.run.user });
    return answer.flags;
  }

  /** A mention provider's options for what the person typed after `@`, with any resource searches it made. */
  async mentions(provider: keyof C['mentions'] & string, query: string): Promise<{ readonly options: WireMentionOption[]; readonly searches: FakeHub['mentionSearches'] }> {
    const from = this.hub.mentionSearches.length;
    const options = await this.hub.mentions(provider, query);
    return { options, searches: this.hub.mentionSearches.slice(from) };
  }

  /** The records of one of the system's stored types the run left in the fake hub, newest change first. */
  records(type: keyof C['types'] & string): DataRecord[] {
    const name: QualifiedName = qualify(this.contract.name, type);
    return this.hub.data.of(name);
  }

  /**
   * The visuals that would draw a table, best first, as the hub, the widget agent and the web app rank them: the
   * built-in families and this system's own `HUB_VISUALS` contributions (`rankedVisuals` over `resultFacts`). Check that
   * a visual you declare is offered for the data it is for, and with the binding you expect.
   */
  visuals(table: ResultTable): VisualRank[] {
    return rankedVisuals([...BUILT_IN_CONTRIBUTIONS, ...this.contract.contributes], resultFacts(table), table).map((ranked) => ranked.rank);
  }

  /** Stop the system. */
  stop(): Promise<void> {
    return this.running.stop();
  }

  /**
   * A fn's def with its own types. `fn()` builds every `C['fns'][K]` as a `FnDef<TypesOf<C['fns'][K]>>`, which
   * TypeScript can't see through the deferred conditional; the values crossing it are checked by `parseValue`.
   */
  #fn<K extends FnNameOf<C>>(name: K): FnDef<TypesOf<C['fns'][K]>> {
    const def: AnyFnDef | undefined = this.contract.defs.fns[name];
    if (def === undefined) { throw new Error(`${this.contract.name} has no fn ${name}.`); }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- fn() built this def with exactly these types (see above)
    return def as FnDef<TypesOf<C['fns'][K]>>;
  }

  #kind(name: KindNameOf<C>): KindDef<unknown> {
    const def: KindDef<unknown> | undefined = this.contract.defs.kinds[name];
    if (def === undefined) { throw new Error(`${this.contract.name} has no kind ${name}.`); }
    return def;
  }

  #marks(): Record<keyof HubCalls, number> {
    const hub = this.hub;
    return {
      calls: hub.calls.length, forwards: hub.forwards.length, models: hub.models.length, decisions: hub.decisions.length,
      proposals: hub.proposals.length, handled: hub.handled.length, attachments: hub.attachments.length, shares: hub.shares.length,
      typeRequests: hub.typeRequests.length, examples: hub.exampleChanges.length, patches: hub.patches.length,
    };
  }

  #since(marks: Record<keyof HubCalls, number>): HubCalls {
    const hub = this.hub;
    return {
      calls: hub.calls.slice(marks.calls), forwards: hub.forwards.slice(marks.forwards), models: hub.models.slice(marks.models),
      decisions: hub.decisions.slice(marks.decisions), proposals: hub.proposals.slice(marks.proposals), handled: hub.handled.slice(marks.handled),
      attachments: hub.attachments.slice(marks.attachments), shares: hub.shares.slice(marks.shares), typeRequests: hub.typeRequests.slice(marks.typeRequests),
      examples: hub.exampleChanges.slice(marks.examples), patches: hub.patches.slice(marks.patches),
    };
  }
}

/** Serve a system to a fake hub in memory and wait until it is ready (connected, configured, its contract imported). */
export async function testHub<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: TestHubOptions = {}): Promise<TestSystem<N, C>> {
  const hub = new FakeHub({ ...options.hub, ...(options.config === undefined ? {} : { config: options.config }) });
  for (const record of options.records ?? []) { hub.data.records.set(record.id, record); }
  const model = options.model;
  if (model !== undefined) {
    hub.onLlm = (forward) => model.llm(forward);
    hub.onModel = (forward) => model.model(forward);
    hub.onModels = () => model.models();
  }
  const running = await hub.host().start(contract, impl, { version: '0.0.0-test', ...options.serve, hub: 'ws://hub.test/link', state: '.harness-test/state' });
  await running.ready();
  return new TestSystem(contract, hub, running);
}

/** Serve a system, call one fn and stop: the typed result, its progress and what it asked the hub for. */
export async function callFn<N extends string, C extends ContractShape, K extends FnNameOf<C>>(
  contract: SystemContract<N, C>, impl: SystemImpl<C>, name: K, args: FnArgsOf<C, K>, options: TestHubOptions = {},
): Promise<TestCall<FnResultOf<C, K>>> {
  const kit = await testHub(contract, impl, options);
  try {
    return await kit.call(name, args);
  } finally {
    await kit.stop();
  }
}
