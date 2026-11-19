/**
 * Test doubles for what the chat module leans on, beside the shared store, bus and logger (`../testing.ts`): a catalog
 * fed by fixtures, a link whose systems answer with a handler per endpoint, and recording run, agent, limit, search
 * and push fakes. `chatRig` wires them into a full `ChatDeps` over a real in-memory store. Tests only.
 */
import { StoreAccessService } from '../access/service.ts';
import { ApiError, type CallReturn, type Peer, type PeerCallArgs, type PeerKeys, type WsConn } from '@ayepi/core';
import {
  GinTypeDef, IDS, MAIN_INSTANCE, noFnStats, SystemName, qualify, splitName, type ActorId, type Availability, type ContextDecl, type ContextRecord, type FnDecl, type FnRecord, type ManifestSection,
  type Notification, type QualifiedName, type ResolvedLimits, type Run, type RunId, type RunSettled, type SearchHit, type SectionDecl,
  type Suggestion, type SystemLinkSpec, type TypeRecord, type UndoOutcome, type UserActor, type SessionControlAction, type ModelRole, type ModelRoleView, type RoleModel,
  type RoleResolution,
} from '@harness/core';
import type { DecisionResponse } from '@aeye/ai';
import type { Catalog, CatalogEntry, FnFilter, FnSignature } from '../catalog/index.ts';
import { AGENT_KIND, type AgentKind, type AgentLoop, type LimitResolver, type RunInput, type RunService } from '../execution/index.ts';
import type { Considered, Search, Suggester } from '../index/index.ts';
import type { LlmGateway, Recorded } from '../execution/index.ts';
import type { DecideCall } from '../execution/media.ts';
import type { EngineModel } from '../execution/ports.ts';
import { HubDecider } from '../models/decide.ts';
import type { ModelRoles } from '../models/index.ts';
import type { ConnectionChange, LinkService, SystemConnection } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import { FaultyStore, RecordingBus, memoryLog, settle, testStore } from '../testing.ts';
import type { ChatDeps } from './deps.ts';
import { createChat } from './chat.ts';
import { chatEnv } from './env.ts';

export { settle };

/** A gin type definition from its JSON. */
export function gin(def: unknown): GinTypeDef {
  return GinTypeDef.parse(def);
}

/**
 * The one unchecked step of these doubles: a value whose type a test double knows from how it stored it (a table's
 * rows under that table's name, an event's data under that event's name), where TypeScript can't follow a generic key.
 */
function known<T>(value: unknown): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see the doc comment: every caller stores and reads under the same key
  return value as T;
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

/** A fn declaration with every field filled with a plain default. */
export function fnDecl(overrides: Partial<FnDecl> & Pick<FnDecl, 'name'>): FnDecl {
  return {
    description: `The ${overrides.name} fn.`, kind: 'native', args: gin({ name: 'obj', props: {} }), returns: gin({ name: 'any' }), deps: [], handlers: {},
    progress: { type: 'none' }, operations: { cancel: true, pause: false, undo: false, background: true }, display: 'card', limits: {}, visibility: 'both', tags: [],
    ...overrides,
  };
}

/** A catalog fed by fixtures. What tests don't need refuses. */
export class FixtureCatalog implements Catalog {
  readonly fnRecords = new Map<QualifiedName, FnRecord>();
  readonly contexts = new Map<QualifiedName, ContextRecord>();
  readonly typeRecords = new Map<QualifiedName, TypeRecord>();
  readonly unavailable = new Map<QualifiedName, Exclude<Availability, true>>();
  readonly #entries = new Map<ManifestSection, unknown[]>();
  /** Checks a value against a type; default: every value fits. */
  checker: (system: SystemName, type: GinTypeDef, value: unknown) => string[] = () => [];

  /** Add a fn of a system. */
  addFn(system: string, decl: Partial<FnDecl> & Pick<FnDecl, 'name'>): FnRecord {
    const record: FnRecord = {
      name: qualify(system, decl.name), system: SystemName.parse(system), decl: fnDecl(decl), version: 'v1', origin: 'contract', available: true, paused: false, disabled: false,
      stats: noFnStats(), updatedAt: 0,
    };
    this.fnRecords.set(record.name, record);
    return record;
  }

  /** Add a context of a system. */
  addContext(system: string, decl: Partial<ContextDecl> & Pick<ContextDecl, 'name'>): ContextRecord {
    const record: ContextRecord = {
      name: qualify(system, decl.name), system: SystemName.parse(system), mentions: { context: [], fns: [] }, stale: false, updatedAt: 0,
      decl: { description: '', imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [], ...decl },
    };
    this.contexts.set(record.name, record);
    return record;
  }

  /** Add a manifest entry (a hook, a mention provider, an action) under its qualified name. */
  addEntry<S extends ManifestSection>(section: S, name: QualifiedName, decl: SectionDecl<S>): void {
    const entry: CatalogEntry<S> = { name, system: SystemName.parse(splitName(name).system), decl };
    this.#entries.set(section, [...(this.#entries.get(section) ?? []), entry]);
  }

  async entries<S extends ManifestSection>(section: S, filter?: { system?: SystemName }): Promise<Array<CatalogEntry<S>>> {
    return Promise.resolve(known<Array<CatalogEntry<S>>>(this.#entries.get(section) ?? []).filter((e) => filter?.system === undefined || e.system === filter.system));
  }

  async fn(name: QualifiedName): Promise<FnRecord | undefined> { return Promise.resolve(this.fnRecords.get(name)); }
  async fns(filter: FnFilter): Promise<FnRecord[]> {
    return Promise.resolve([...this.fnRecords.values()].filter((f) => (filter.system === undefined || f.system === filter.system) && (filter.systems === undefined || filter.systems.includes(f.system))
      && (filter.names === undefined || filter.names.includes(f.name)) && (filter.available !== true || f.available === true)));
  }
  async *eachFn(filter: Omit<FnFilter, 'names'>): AsyncGenerator<FnRecord> {
    yield* (await this.fns(filter)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async type(name: QualifiedName): Promise<TypeRecord | undefined> { return Promise.resolve(this.typeRecords.get(name)); }
  async typesOf(system: SystemName): Promise<TypeRecord[]> { return Promise.resolve([...this.typeRecords.values()].filter((type) => type.system === system)); }
  async context(name: QualifiedName): Promise<ContextRecord | undefined> { return Promise.resolve(this.contexts.get(name)); }
  async availability(name: QualifiedName): Promise<Availability> { return Promise.resolve(this.unavailable.get(name) ?? true); }
  async check(system: SystemName, type: GinTypeDef, value: unknown): Promise<string[]> { return Promise.resolve(this.checker(system, type, value)); }

  importManifest = refuse; importPatch = refuse; forgetInstance = refuse; reimport = refuse; refreshAvailability = refuse; refreshRoles = refuse; indexStoredFns = refuse; manifest = refuse; kind = refuse; typeClosure = refuse; declare = refuse;
  signature = (): Promise<FnSignature> => refuse();
}

/** What the fixtures don't provide. */
async function refuse(): Promise<never> {
  return Promise.reject(new Error('Not provided by this test double.'));
}

// ─── Link ─────────────────────────────────────────────────────────────────────

type Endpoints = SystemLinkSpec['endpoints'];
type PeerName = PeerKeys<SystemLinkSpec>;

/** How a fake system answers each endpoint it serves. */
export type SystemHandlers = {
  [K in PeerName]?: (data: PeerCallArgs<Endpoints[K]>[0], signal: AbortSignal | undefined) => Promise<Awaited<CallReturn<Endpoints[K]>>>;
};

/** Any handler, called loosely (method parameters are bivariant, so every typed handler fits). */
interface LooseHandler {
  run(data: unknown, signal: AbortSignal | undefined): Promise<unknown>;
}

/** One fake system on the other end of a link. */
export class FakePeer implements Peer<SystemLinkSpec> {
  readonly conn: WsConn = { id: 1, req: new Request('http://peer.invalid/'), send: () => undefined, subs: new Set(), streams: new Map(), calls: new Map() };
  readonly calls: Array<{ name: PeerName; data: unknown }> = [];
  readonly #abort = new AbortController();
  handlers: SystemHandlers;

  constructor(handlers: SystemHandlers) {
    this.handlers = handlers;
  }

  get open(): boolean { return !this.#abort.signal.aborted; }
  get signal(): AbortSignal { return this.#abort.signal; }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a test double: each call goes to the handler of the same endpoint, typed by `SystemHandlers` exactly as `call` is
  readonly call = ((name: PeerName, data?: unknown, options?: { signal?: AbortSignal }) => this.#dispatch(name, data, options?.signal)) as Peer<SystemLinkSpec>['call'];

  readonly on: Peer<SystemLinkSpec>['on'] = () => { throw new Error('The fake peer has no events.'); };

  /** Close the connection: open calls reject as disconnected. */
  close(): void {
    this.#abort.abort(new ApiError(0, 'DISCONNECTED'));
  }

  async #dispatch(name: PeerName, data: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    this.calls.push({ name, data });
    if (!this.open) { return Promise.reject(new ApiError(0, 'DISCONNECTED')); }
    const handler = this.handlers[name];
    if (handler === undefined) { return Promise.reject(new ApiError(501, 'NOT_SERVED')); }
    const loose: LooseHandler = { run: handler };
    const disconnected = new Promise<never>((_, reject) => {
      this.#abort.signal.addEventListener('abort', () => { reject(new ApiError(0, 'DISCONNECTED')); }, { once: true });
    });
    return Promise.race([loose.run(data, signal), disconnected]);
  }
}

/** A link whose systems are fake peers. */
export class FakeLink implements Pick<LinkService, 'connection' | 'connected' | 'onChange'> {
  readonly #connections = new Map<SystemName, SystemConnection & { peer: FakePeer }>();
  readonly #listeners = new Set<(change: ConnectionChange) => void>();

  connect(system: string, handlers: SystemHandlers): FakePeer {
    const name = SystemName.parse(system);
    const peer = new FakePeer(handlers);
    this.#connections.set(name, { system: name, instance: MAIN_INSTANCE, boot: `${system}-1`, connectedAt: 0, peer, signal: peer.signal });
    for (const listener of this.#listeners) { listener({ system: name, instance: MAIN_INSTANCE, connected: true }); }
    return peer;
  }

  disconnect(system: string): void {
    const name = SystemName.parse(system);
    this.#connections.get(name)?.peer.close();
    this.#connections.delete(name);
    for (const listener of this.#listeners) { listener({ system: name, instance: MAIN_INSTANCE, connected: false }); }
  }

  connection(system: SystemName): SystemConnection | undefined { return this.#connections.get(system); }
  connected(): readonly SystemConnection[] { return [...this.#connections.values()]; }
  onChange(listener: (change: ConnectionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}

// ─── Runs and agents ──────────────────────────────────────────────────────────

/** A run row with plain defaults. */
export function makeRun(input: Partial<Run> & Pick<Run, 'id' | 'fn' | 'turn' | 'actor'>): Run {
  return {
    fnVersion: 'v1', kind: 'native', system: SystemName.parse(splitName(input.fn).system), root: input.id, key: 'k', caller: input.actor, args: {}, status: 'done',
    allowed: { cancel: true, pause: false, background: true }, cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [],
    createdAt: 0, ...input,
  };
}

/** Records runs it is asked to start, writes their rows, and settles them when a test says. */
export class FakeRuns implements RunService {
  readonly started: RunInput[] = [];
  readonly controlled: Array<{ action: SessionControlAction | 'undo'; run: RunId }> = [];
  readonly undoOutcomes = new Map<RunId, UndoOutcome | Error>();
  /** When set, the next start is refused with this error (a policy denial, an unknown fn). */
  refuseStart: Error | undefined;
  readonly #settle = new Map<RunId, { resolve: (settled: RunSettled) => void; reject: (error: Error) => void }>();
  readonly #store: HubStore;
  readonly #ids: () => RunId;

  constructor(store: HubStore, ids: () => RunId) {
    this.#store = store;
    this.#ids = ids;
  }

  propose(): Promise<never> { return Promise.reject(new Error('proposals are not in chat tests')); }
  systemWork(): Promise<never> { return Promise.reject(new Error('system work is not in chat tests')); }
  settle(): Promise<void> { return Promise.resolve(); }

  gateWith(): void {
    // chat tests have no fn mode gate
  }

  async start(input: RunInput): Promise<{ run: RunId; settled: Promise<RunSettled> }> {
    this.started.push(input);
    const refused = this.refuseStart;
    if (refused !== undefined) { this.refuseStart = undefined; throw refused; }
    const id = this.#ids();
    await this.#store.table('runs').insert(makeRun({ id, fn: input.fn, turn: input.turn, actor: input.actor, caller: input.caller, args: input.args, status: 'running', ...(input.session === undefined ? {} : { session: input.session }) }));
    const settled = new Promise<RunSettled>((resolve, reject) => { this.#settle.set(id, { resolve, reject }); });
    return { run: id, settled };
  }

  /** Settle a started run. */
  finish(run: RunId, settled: RunSettled): void {
    this.#settle.get(run)?.resolve(settled);
  }

  /** Make a started run's result reject, as if the hub lost track of it. */
  lose(run: RunId, error: Error): void {
    this.#settle.get(run)?.reject(error);
  }

  async get(run: RunId): Promise<Run | undefined> { return this.#store.table('runs').get(run); }
  async cancel(run: RunId): Promise<{ accepted: boolean }> { this.controlled.push({ action: 'cancel', run }); return Promise.resolve({ accepted: true }); }
  async pause(run: RunId): Promise<{ accepted: boolean }> { this.controlled.push({ action: 'pause', run }); return Promise.resolve({ accepted: true }); }
  async resume(run: RunId): Promise<void> { this.controlled.push({ action: 'resume', run }); return Promise.resolve(); }
  async undo(run: RunId): Promise<UndoOutcome> {
    this.controlled.push({ action: 'undo', run });
    const outcome = this.undoOutcomes.get(run) ?? { status: 'undone', summary: 'Undid it.' };
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
  background = refuse; progress = refuse; allow = refuse; undoWith = refuse; resend = refuse;
}

/** Records agent starts (writing their runs), interrupts and continues (putting the run back to running). */
export class FakeAgents implements Pick<AgentLoop, 'start' | 'interrupt' | 'continue'> {
  readonly started: RunInput[] = [];
  readonly interrupted: RunId[] = [];
  readonly continued: RunId[] = [];
  /** When set, the next continue is refused with this error. */
  refuseContinue: Error | undefined;
  failWith: Error | undefined;
  readonly #store: HubStore;
  readonly #ids: () => RunId;

  constructor(store: HubStore, ids: () => RunId) {
    this.#store = store;
    this.#ids = ids;
  }

  async start(input: RunInput & { kind: AgentKind }): Promise<{ run: RunId }> {
    if (this.failWith !== undefined) { return Promise.reject(this.failWith); }
    this.started.push(input);
    const id = this.#ids();
    await this.#store.table('runs').insert(makeRun({
      id, fn: input.fn, kind: AGENT_KIND, turn: input.turn, actor: input.actor, caller: input.caller, status: 'running', ...(input.session === undefined ? {} : { session: input.session }),
    }));
    return { run: id };
  }

  async interrupt(run: RunId): Promise<void> {
    this.interrupted.push(run);
    return Promise.resolve();
  }

  async continue(run: RunId): Promise<void> {
    const refused = this.refuseContinue;
    if (refused !== undefined) { this.refuseContinue = undefined; throw refused; }
    this.continued.push(run);
    await this.#store.table('runs').update(run, { status: 'running' });
  }
}

/** The limits every turn gets in tests. */
export const LIMITS: ResolvedLimits = { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 0.5, time: 600_000 }, budgets: [] };

/** Resolves every turn to `LIMITS`. */
export class FixedLimits implements LimitResolver {
  readonly asked: Array<Parameters<LimitResolver['resolve']>[0]> = [];
  async resolve(input: Parameters<LimitResolver['resolve']>[0]): Promise<ResolvedLimits> {
    this.asked.push(input);
    return Promise.resolve(LIMITS);
  }
}

/** Search and suggestions from fixtures. */
export class FixtureIndex implements Search, Suggester {
  hits: SearchHit[] = [];
  suggestions: Suggestion[] | Error = [];
  readonly searched: Array<Parameters<Search['search']>[0]> = [];

  async search(query: Parameters<Search['search']>[0]): Promise<SearchHit[]> {
    this.searched.push(query);
    const kept: SearchHit[] = [];
    for (const hit of this.hits) {
      if (query.kinds.includes(hit.kind) && (query.keep === undefined || await query.keep(hit))) { kept.push(hit); }
    }
    return kept;
  }

  /** Candidates a rule hides, for `consider`. */
  hidden: Considered['hidden'] = [];

  async suggest(): Promise<Suggestion[]> {
    return this.suggestions instanceof Error ? Promise.reject(this.suggestions) : Promise.resolve(this.suggestions);
  }

  /** What `consider` was asked, in order. */
  readonly considered: Array<Parameters<Suggester['consider']>[0]> = [];

  async consider(query: Parameters<Suggester['consider']>[0]): Promise<Considered> {
    this.considered.push(query);
    return this.suggestions instanceof Error ? Promise.reject(this.suggestions) : Promise.resolve({ offered: this.suggestions, hidden: this.hidden });
  }
}

/** The hub's own chat calls from fixtures: each call takes the next answer (text, or an error to throw). */
export class FixtureLlm implements Pick<LlmGateway, 'chat'> {
  answers: Array<string | Error> = [];
  readonly asked: Array<Parameters<LlmGateway['chat']>[0]> = [];

  async chat(input: Parameters<LlmGateway['chat']>[0]): Promise<Recorded<string>> {
    this.asked.push(input);
    const answer = this.answers.shift() ?? new Error('no answer');
    if (answer instanceof Error) { return Promise.reject(answer); }
    return Promise.resolve({ value: answer, call: IDS.modelCall.parse(`mdl_${this.asked.length}`), cost: 0.0001, model: 'fixture' });
  }
}

/**
 * The decide role and the gateway's decision calls, for the real `HubDecider`: the role's model (none until `role` is
 * set) with its threshold and question cap, and each predicate answered by `answer` from its instructions. Records
 * every call's question names.
 */
export class FixtureDecisions implements Pick<ModelRoles, 'get' | 'resolveModel'>, Pick<LlmGateway, 'decide' | 'models'> {
  /** The decide role's model and threshold; none until a test sets it. */
  role: { model: string; threshold: number; maxQuestions?: number } | undefined;
  /** The probability each predicate is answered with, from its instructions; a thrown error fails the call. */
  answer: (instructions: string) => number = () => 0;
  /** Each call's question names, in order. */
  readonly asked: string[][] = [];

  get(role: ModelRole): Promise<ModelRoleView> {
    const set = this.role;
    if (role !== 'decide' || set === undefined) { return Promise.resolve({ role, from: 'none' }); }
    return Promise.resolve({
      role, from: 'setting', choice: { role: 'decide', model: { model: set.model }, threshold: set.threshold }, resolved: { model: set.model, provider: 'fixture/decisions' },
    });
  }

  resolveModel(_role: ModelRole, wanted: RoleModel): Promise<RoleResolution> {
    return Promise.resolve('model' in wanted.model ? { model: wanted.model.model, provider: 'fixture/decisions' } : { problem: 'Pick a model by name.' });
  }

  models(): Promise<EngineModel[]> {
    const set = this.role;
    return Promise.resolve(set === undefined ? [] : [{
      id: set.model, provider: 'fixture/decisions', name: set.model, contextWindow: 8_192, capabilities: ['decision'], ...(set.maxQuestions === undefined ? {} : { maxQuestions: set.maxQuestions }),
    }]);
  }

  decide(input: DecideCall): Promise<Recorded<DecisionResponse>> {
    const names = Object.keys(input.questions);
    const max = this.role?.maxQuestions;
    if (max !== undefined && names.length > max) { return Promise.reject(new Error(`${names.length} questions is over the model's ${max}`)); }
    this.asked.push(names);
    try {
      const answers = Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, { type: 'predicate' as const, probability: this.answer(question.instructions) }]));
      return Promise.resolve({ value: { answers, model: input.metadata.model ?? 'fixture' }, call: IDS.modelCall.parse(`mdl_d${this.asked.length}`), cost: 0.00001, model: input.metadata.model ?? 'fixture' });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Records pushes; users in `subscribed` have a browser that takes them. */
export class FakePush {
  readonly sent: Array<{ user: ActorId; notification: Notification }> = [];
  readonly subscribed = new Set<ActorId>();
  failWith: Error | undefined;

  async send(user: ActorId, notification: Notification): Promise<{ sent: number; gone: number }> {
    if (this.failWith !== undefined) { return Promise.reject(this.failWith); }
    this.sent.push({ user, notification });
    return Promise.resolve({ sent: this.subscribed.has(user) ? 1 : 0, gone: 0 });
  }
}

// ─── The rig ──────────────────────────────────────────────────────────────────

/** A full `ChatDeps` of test doubles, with an admin user and the `hub/chat` agent fn. */
export async function chatRig() {
  let counter = 0;
  const random = (): string => String(++counter).padStart(6, '0');
  let now = Date.UTC(2026, 10, 7, 14, 30);
  const store = new FaultyStore(await testStore());
  const bus = new RecordingBus();
  const catalog = new FixtureCatalog();
  const link = new FakeLink();
  const runIds = (): RunId => IDS.run.parse(`run_${random()}`);
  const runs = new FakeRuns(store, runIds);
  const agents = new FakeAgents(store, runIds);
  const limits = new FixedLimits();
  const index = new FixtureIndex();
  const push = new FakePush();
  const llm = new FixtureLlm();
  const decisions = new FixtureDecisions();
  const { log, records: logs } = memoryLog();
  catalog.addFn('hub', { name: 'chat', kind: AGENT_KIND, description: 'The chat agent.' });
  const deps: ChatDeps = {
    // notices go out at once here; the grace has its own test
    settings: { chat: { ...chatEnv.parse(), HARNESS_CONFIG_NOTICE_GRACE: 0 }, queue: { HARNESS_ACTIVE_WINDOW: 120_000 }, model: { HARNESS_SUGGESTIONS: 6 } },
    log, clock: () => now, random, bus, store, catalog, link, runs, agents, limits, search: index, suggest: index, llm, push, hubActor: actorId('act_hub'),
    // the real decider (its batching by `maxQuestions`) over a fixture decide role and gateway
    decider: new HubDecider({ roles: decisions, llm: decisions }),
    // the real visibility over the rig's store, with no per-person systems
    access: new StoreAccessService({
      store, bus, clock: () => now, catalog, hubActor: actorId('act_hub'), gate: () => Promise.resolve({ fn: () => undefined }), systemOf: () => undefined,
    }),
  };
  const admin: UserActor = { id: actorId('act_admin'), kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'admin', about: '', createdAt: 0, disabled: false };
  return {
    deps, store, bus, catalog, link, runs, agents, limits, index, llm, decisions, push, logs, admin,
    /** Move the clock forward. */
    advance(ms: number): void { now += ms; },
    /** Add a user (a member unless given). */
    async user(name: string, overrides: Partial<UserActor> = {}): Promise<UserActor> {
      const row = await store.table('actors').insert({ id: actorId(`act_${name.toLowerCase()}`), kind: 'user', name, email: `${name.toLowerCase()}@example.com`, role: 'member', about: '', createdAt: 0, disabled: false, ...overrides });
      if (row.kind !== 'user') { throw new Error('expected a user'); }
      return row;
    },
    async init(): Promise<void> { await store.table('actors').insert(admin); },
  };
}

/** The rig's type. */
export type ChatRig = Awaited<ReturnType<typeof chatRig>>;

/** An actor id from a string. */
export function actorId(id: string): ActorId {
  return IDS.actor.parse(id);
}

/** The rig with the chat module built on it, the admin signed up, and a session of theirs. */
export async function chatWorld(options: { systems?: SystemName[] | 'all' } = {}) {
  const rig = await chatRig();
  await rig.init();
  const chat = createChat(rig.deps);
  const session = await chat.sessions.create({ owner: rig.admin.id, ...(options.systems === undefined ? {} : { systems: options.systems }) });
  return { ...rig, chat, session };
}

/** What a browser reports with a message. */
export const CLIENT = { timeZone: 'America/New_York', locale: 'en-US', now: 0 } as const;
