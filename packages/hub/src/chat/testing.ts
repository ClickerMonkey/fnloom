/**
 * Test doubles for what the chat module leans on: an in-memory `HubStore` whose tables parse every row with core's
 * schemas (like the real store) and whose transactions roll back, a recording `EventBus`, a catalog fed by fixtures,
 * a link whose systems answer with a handler per endpoint, and recording run, agent, limit, search and push fakes.
 * `chatRig` wires them into a full `ChatDeps`. Tests only.
 */
import { ApiError, type CallReturn, type Peer, type PeerCallArgs, type PeerKeys, type WsConn } from '@ayepi/core';
import { createLogger, type LogRecord } from '@ayepi/log';
import {
  GinTypeDef, HUB_TABLES, IDS, SystemName, qualify, splitName, type ActorId, type Availability, type ContextDecl, type ContextRecord, type FnDecl, type FnRecord, type ManifestSection,
  type Notification, type Page, type QualifiedName, type ResolvedLimits, type RowOf, type Run, type RunId, type RunSettled, type SearchHit, type SectionDecl,
  type Suggestion, type SystemLinkSpec, type TableName, type TypeRecord, type UndoOutcome, type UserActor,
} from '@harness/core';
import type { EventBus, HubEventName, HubEvents } from '../bus.ts';
import type { Catalog, CatalogEntry, FnSignature } from '../catalog/index.ts';
import { AGENT_KIND, type AgentKind, type AgentLoop, type LimitResolver, type RunInput, type RunService } from '../execution/index.ts';
import type { Search, Suggester } from '../index/index.ts';
import type { LinkService, SystemConnection } from '../link/index.ts';
import type { AyepiPorts, HubStore, Table, TableQuery, TextIndex, VectorIndex, Where } from '../store/index.ts';
import type { ChatDeps } from './deps.ts';
import { createChat } from './chat.ts';
import { chatEnv } from './env.ts';

/** Let queued microtasks and timers run (bus listeners, background flushes). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) { await new Promise((resolve) => setTimeout(resolve, 0)); }
}

/** A gin type definition from its JSON. */
export function gin(def: unknown): GinTypeDef {
  return GinTypeDef.parse(def);
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * The one unchecked step of these doubles: a value whose type a test double knows from how it stored it (a table's
 * rows under that table's name, an event's data under that event's name), where TypeScript can't follow a generic key.
 */
function known<T>(value: unknown): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see the doc comment: every caller stores and reads under the same key
  return value as T;
}

/** How a memory table reads and keys its rows. */
interface RowDef<Row> {
  readonly row: { parse(value: unknown): Row };
  readonly key: (row: Row) => string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether a column value passes one filter: equal, `in`, a bound, or `exists`. */
function passes(value: unknown, filter: unknown): boolean {
  if (filter !== null && typeof filter === 'object' && !Array.isArray(filter)) {
    if ('in' in filter && Array.isArray(filter.in)) { return filter.in.some((item: unknown) => same(item, value)); }
    if ('exists' in filter && typeof filter.exists === 'boolean') { return (value !== undefined) === filter.exists; }
    if ('gt' in filter) { return compare(value, filter.gt) > 0; }
    if ('gte' in filter) { return compare(value, filter.gte) >= 0; }
    if ('lt' in filter) { return compare(value, filter.lt) < 0; }
    if ('lte' in filter) { return compare(value, filter.lte) <= 0; }
  }
  return same(value, filter);
}

/** Order two cells: absent first, then numbers, strings and booleans by value. */
function compare(a: unknown, b: unknown): number {
  if (a === b) { return 0; }
  if (a === undefined) { return -1; }
  if (b === undefined) { return 1; }
  if (typeof a === 'number' && typeof b === 'number') { return a - b; }
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function matches<Row extends object>(row: Row, where: Where<Row> | undefined): boolean {
  const cells = new Map(Object.entries(row));
  return Object.entries(where ?? {}).every(([column, filter]) => filter === undefined || passes(cells.get(column), filter));
}

/** One table over a shared row map. Rows are stored as JSON and parsed on every read. */
class MemoryTable<Row extends object> implements Table<Row> {
  readonly #def: RowDef<Row>;
  readonly #rows: Map<string, string>;
  readonly #failing: () => boolean;

  constructor(def: RowDef<Row>, rows: Map<string, string>, failing: () => boolean) {
    this.#def = def;
    this.#rows = rows;
    this.#failing = failing;
  }

  async get(key: string): Promise<Row | undefined> {
    const raw = this.#rows.get(key);
    return Promise.resolve(raw === undefined ? undefined : this.#parse(raw));
  }

  async find(query: TableQuery<Row>): Promise<Page<Row>> {
    const rows = [...this.#rows.entries()].map(([key, raw]) => ({ key, row: this.#parse(raw) })).filter(({ row }) => matches(row, query.where));
    rows.sort((a, b) => {
      const ca = new Map(Object.entries(a.row));
      const cb = new Map(Object.entries(b.row));
      for (const [column, direction] of query.order ?? []) {
        const order = compare(ca.get(column), cb.get(column));
        if (order !== 0) { return direction === 'asc' ? order : -order; }
      }
      return a.key.localeCompare(b.key);
    });
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = offset + query.limit;
    const items = rows.slice(offset, end).map((r) => r.row);
    return Promise.resolve(end < rows.length ? { items, cursor: String(end) } : { items });
  }

  async count(where?: Where<Row>): Promise<number> {
    return Promise.resolve([...this.#rows.values()].filter((raw) => matches(this.#parse(raw), where)).length);
  }

  async insert(row: Row): Promise<Row> {
    const parsed = this.#def.row.parse(row);
    const key = this.#def.key(parsed);
    if (this.#rows.has(key)) { return Promise.reject(new Error(`${key} already exists`)); }
    this.#rows.set(key, JSON.stringify(parsed));
    return Promise.resolve(parsed);
  }

  async put(row: Row): Promise<Row> {
    const parsed = this.#def.row.parse(row);
    this.#rows.set(this.#def.key(parsed), JSON.stringify(parsed));
    return Promise.resolve(parsed);
  }

  async update(key: string, patch: Partial<Row>): Promise<Row> {
    const raw = this.#rows.get(key);
    if (raw === undefined) { return Promise.reject(new Error(`${key} does not exist`)); }
    if (this.#failing()) { return Promise.reject(new Error(`The update of ${key} failed (on purpose).`)); }
    const parsed = this.#def.row.parse({ ...this.#parse(raw), ...patch });
    this.#rows.set(key, JSON.stringify(parsed));
    return Promise.resolve(parsed);
  }

  async remove(key: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(key));
  }

  #parse(raw: string): Row {
    return this.#def.row.parse(JSON.parse(raw));
  }
}

/** An in-memory store: tables only. Transactions run one at a time and put every table back when they throw. */
export class MemoryStore implements HubStore {
  readonly #data = new Map<TableName, Map<string, string>>();
  readonly #failing = new Set<TableName>();
  #lock: Promise<void> = Promise.resolve();

  /** Make the next update of a table fail, to test what a transaction puts back. */
  failNextUpdate(table: TableName): void {
    this.#failing.add(table);
  }

  table<K extends TableName>(name: K): Table<RowOf<K>> {
    let rows = this.#data.get(name);
    if (rows === undefined) {
      rows = new Map();
      this.#data.set(name, rows);
    }
    return new MemoryTable(known<RowDef<RowOf<K>>>(HUB_TABLES[name]), rows, () => this.#failing.delete(name));
  }

  async tx<T>(fn: (store: HubStore) => Promise<T>): Promise<T> {
    const run = this.#lock.then(async () => {
      const saved = new Map([...this.#data].map(([name, rows]) => [name, new Map(rows)]));
      try {
        return await fn(this);
      } catch (error) {
        for (const [name, live] of this.#data) {
          live.clear();
          for (const [key, raw] of saved.get(name) ?? []) { live.set(key, raw); }
        }
        throw error;
      }
    });
    this.#lock = run.then(() => undefined, () => undefined);
    return run;
  }

  get vectors(): VectorIndex { throw new Error('The memory store has no vector index.'); }
  get text(): TextIndex { throw new Error('The memory store has no text index.'); }
  get ports(): AyepiPorts { throw new Error('The memory store has no ayepi ports.'); }
  async migrate(): Promise<void> { return Promise.resolve(); }
  async close(): Promise<void> { return Promise.resolve(); }
}

// ─── Bus ──────────────────────────────────────────────────────────────────────

/** A bus that records what is published and delivers to listeners on a microtask. */
export class RecordingBus implements EventBus {
  readonly #published = new Map<HubEventName, unknown[]>();
  readonly #listeners = new Map<HubEventName, Set<(data: never) => void>>();

  publish<E extends HubEventName>(event: E, data: HubEvents[E]): void {
    const list = this.#published.get(event) ?? [];
    list.push(data);
    this.#published.set(event, list);
    for (const listener of this.#set(event)) { queueMicrotask(() => { listener(data); }); }
  }

  subscribe<E extends HubEventName>(event: E, listener: (data: HubEvents[E]) => void): () => void {
    const set = this.#set(event);
    set.add(listener);
    return () => { set.delete(listener); };
  }

  /** Everything published under one event, in order. */
  of<E extends HubEventName>(event: E): ReadonlyArray<HubEvents[E]> {
    return known<Array<HubEvents[E]>>(this.#published.get(event) ?? []);
  }

  #set<E extends HubEventName>(event: E): Set<(data: HubEvents[E]) => void> {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    return known<Set<(data: HubEvents[E]) => void>>(set);
  }
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
      stats: { runs: 0, failures: 0, averageCost: 0, averageTime: 0 }, updatedAt: 0,
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
  async fns(filter: { system?: SystemName; available?: boolean }): Promise<FnRecord[]> {
    return Promise.resolve([...this.fnRecords.values()].filter((f) => (filter.system === undefined || f.system === filter.system) && (filter.available !== true || f.available === true)));
  }
  async type(name: QualifiedName): Promise<TypeRecord | undefined> { return Promise.resolve(this.typeRecords.get(name)); }
  async context(name: QualifiedName): Promise<ContextRecord | undefined> { return Promise.resolve(this.contexts.get(name)); }
  async availability(name: QualifiedName): Promise<Availability> { return Promise.resolve(this.unavailable.get(name) ?? true); }
  async check(system: SystemName, type: GinTypeDef, value: unknown): Promise<string[]> { return Promise.resolve(this.checker(system, type, value)); }

  importManifest = refuse; importPatch = refuse; reimport = refuse; refreshAvailability = refuse; manifest = refuse; kind = refuse; typeClosure = refuse; declare = refuse;
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
  readonly #listeners = new Set<(change: { system: SystemName; connected: boolean }) => void>();

  connect(system: string, handlers: SystemHandlers): FakePeer {
    const name = SystemName.parse(system);
    const peer = new FakePeer(handlers);
    this.#connections.set(name, { system: name, instance: `${system}-1`, connectedAt: 0, peer, signal: peer.signal });
    for (const listener of this.#listeners) { listener({ system: name, connected: true }); }
    return peer;
  }

  disconnect(system: string): void {
    const name = SystemName.parse(system);
    this.#connections.get(name)?.peer.close();
    this.#connections.delete(name);
    for (const listener of this.#listeners) { listener({ system: name, connected: false }); }
  }

  connection(system: SystemName): SystemConnection | undefined { return this.#connections.get(system); }
  connected(): readonly SystemConnection[] { return [...this.#connections.values()]; }
  onChange(listener: (change: { system: SystemName; connected: boolean }) => void): () => void {
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
  readonly controlled: Array<{ action: 'cancel' | 'pause' | 'resume' | 'undo'; run: RunId }> = [];
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

/** Records agent starts (writing their runs) and interrupts. */
export class FakeAgents implements Pick<AgentLoop, 'start' | 'interrupt'> {
  readonly started: RunInput[] = [];
  readonly interrupted: RunId[] = [];
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
    return Promise.resolve(this.hits.filter((h) => query.kinds.includes(h.kind)));
  }

  async suggest(): Promise<Suggestion[]> {
    return this.suggestions instanceof Error ? Promise.reject(this.suggestions) : Promise.resolve(this.suggestions);
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
export function chatRig() {
  let counter = 0;
  const random = (): string => String(++counter).padStart(6, '0');
  let now = Date.UTC(2026, 10, 7, 14, 30);
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const catalog = new FixtureCatalog();
  const link = new FakeLink();
  const runIds = (): RunId => IDS.run.parse(`run_${random()}`);
  const runs = new FakeRuns(store, runIds);
  const agents = new FakeAgents(store, runIds);
  const limits = new FixedLimits();
  const index = new FixtureIndex();
  const push = new FakePush();
  const logs: LogRecord[] = [];
  const log = createLogger({ level: 'debug', transports: [{ name: 'memory', write: (record) => { logs.push(record); } }] });
  catalog.addFn('hub', { name: 'chat', kind: AGENT_KIND, description: 'The chat agent.' });
  const deps: ChatDeps = {
    settings: { chat: chatEnv.parse(), queue: { HARNESS_ACTIVE_WINDOW: 120_000 }, model: { HARNESS_SUGGESTIONS: 6 } },
    log, clock: () => now, random, bus, store, catalog, link, runs, agents, limits, search: index, suggest: index, push, hubActor: actorId('act_hub'),
  };
  const admin: UserActor = { id: actorId('act_admin'), kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'admin', about: '', createdAt: 0, disabled: false };
  return {
    deps, store, bus, catalog, link, runs, agents, limits, index, push, logs, admin,
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
export type ChatRig = ReturnType<typeof chatRig>;

/** An actor id from a string. */
export function actorId(id: string): ActorId {
  return IDS.actor.parse(id);
}

/** The rig with the chat module built on it, the admin signed up, and a session of theirs. */
export async function chatWorld(options: { systems?: SystemName[] | 'all' } = {}) {
  const rig = chatRig();
  await rig.init();
  const chat = createChat(rig.deps);
  const session = await chat.sessions.create({ owner: rig.admin.id, ...(options.systems === undefined ? {} : { systems: options.systems }) });
  return { ...rig, chat, session };
}

/** What a browser reports with a message. */
export const CLIENT = { timeZone: 'America/New_York', locale: 'en-US', now: 0 } as const;
