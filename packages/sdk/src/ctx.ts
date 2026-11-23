/**
 * What implementations receive: the run context (`FnCtx`), typed by the fn it runs, and the services every run,
 * hook, mention, action and lifecycle event gets. These are interfaces; the serve runtime provides them.
 */
import type {
  ActorId, AllowedOperations, ConnectionUpdate, ContentRef, DeliveryId, Detail, InstanceName, ModelForward, ModelForwardResult, ErrorClass, FnError, InputProblem, Json, Link, ModelChoice, Operations, QualifiedName,
  ResourceHit, ResourceLink, ResourceStat, ResourceUri, RunId, RunInfo, RunStatus, RunUpdate, Section, SectionKey, SessionId, TimeInfo, Usd,
  Duration, RunConnection, ShareRule, TypeDefinitions, UserInfo, ApprovalPreview, DecideAnswer, DecideCandidate, FleetInstance, ProposalApprover, ProposedRun, FnSearchQuery, FnSearchPage, FnExamplesQuery, FnExamplesPage,
  ApprovedRun, AdminNotice, DataRecord, ListQuery, RecordId, ResultTable, InstanceConnect, ProposalAsk, StartedRun, Timestamp, NotificationTone,
} from '@harness/core';
import type { z } from 'zod';
import type { FnTypes, HandlerArgs, Handlers, HandlersInRun, HasRequiredHandlers, Outcome, ProgressReporter, Deps } from './fn.ts';
import type { GinType } from './gin.ts';
import type { AnyFnRef, AnyKindRef, AnyPageRef, AttachmentRef, FnRef, KindRef, SettingRef } from './refs.ts';
import type { HarnessAi } from './server/llm.ts';

// ─── Services ─────────────────────────────────────────────────────────────────

/** The modalities that go through the hub's `model` endpoint (chat has its own, `llm`). */
export type ForwardModality = ModelForward['modality'];
/** What a non-chat model call takes, by modality: core's `ModelForward`, without what the runtime fills in. */
export type ModelInput<M extends ForwardModality> = Omit<Extract<ModelForward, { modality: M }>, 'modality' | 'run'>;
/** What a non-chat model call gives back, by modality: core's `ModelForwardResult`, with its `ModelCall` id and cost. */
export type ModelOutput<M extends ForwardModality> = Omit<Extract<ModelForwardResult, { modality: M }>, 'modality'>;

/**
 * Model calls. They always go through the hub, which picks the model, enforces budgets and records every call, of
 * every modality, as a `ModelCall` attributed to the run.
 */
export interface Llm {
  text(input: { prompt: string; system?: string; model?: ModelChoice }): Promise<string>;
  /** An answer checked against a gin type. */
  object<T>(input: { prompt: string; output: GinType<T>; system?: string; model?: ModelChoice }): Promise<T>;
  stream(input: { prompt: string; system?: string; model?: ModelChoice }): AsyncIterable<string>;
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** Images made from a prompt, stored with the hub: pass the refs on, or read them with `ctx.resources`. */
  image(input: ModelInput<'image'>): Promise<ModelOutput<'image'>>;
  /** The words spoken in stored audio, with timed segments when the model gives them. */
  transcribe(input: ModelInput<'transcribe'>): Promise<ModelOutput<'transcribe'>>;
  /** Spoken audio of a text, stored with the hub. */
  speak(input: ModelInput<'speech'>): Promise<ModelOutput<'speech'>>;
}

/**
 * Which instance of its system this process is, and the folders it keeps things in. An installed system's folders
 * are outside its package, so upgrades and rollbacks keep them; `dataDir` is exported with the instance's data.
 */
export interface SystemPlace {
  /** This instance's name: `main`, or its name in a fleet (`laptop`). */
  readonly instance: InstanceName;
  /** The system's own data (files, a SQLite database): what it stores there and how is its own business. */
  readonly dataDir: string;
  /** What can be made again (client builds, indexes): never exported, and may be cleared. */
  readonly cacheDir: string;
}

/** File operations, limited to what the system allows. */
export interface Files {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string): Promise<ResourceStat[]>;
  remove(path: string): Promise<void>;
  /** Upload to the hub so it can be attached or passed by ref. */
  share(path: string): Promise<ContentRef>;
}

/** Reading resources. The hub routes each URI to the system that serves it. */
export interface Resources {
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  text(uri: ResourceUri, sections?: SectionKey[]): Promise<string>;
  /** A resource's raw bytes (an image, a PDF, a zip), unconverted; a text-only resource gives its text as UTF-8. */
  bytes(uri: ResourceUri): Promise<Uint8Array>;
  links(uri: ResourceUri): Promise<ResourceLink[]>;
  sections(uri: ResourceUri): Promise<Section[]>;
  /**
   * Search resources by words and meaning. Only in a mention provider's `search`: the hub ties it to the person's `@`
   * search and searches as them. Elsewhere it refuses (`LinkGap`); a fn declares `hub.fns.search_resources` as a dep.
   */
  search(query: string, options?: { roots?: ResourceUri[]; limit?: number }): Promise<ResourceHit[]>;
}

/** A record of a stored type, its value decoded to the type. */
export type StoredRecord<T> = Omit<DataRecord, 'value'> & { readonly value: T };

/** A stored type as `ctx.data` takes it: the type's ref (`contract.types.Note`, or another system's). */
export type StoredType<T> = GinType<T> & { readonly name: QualifiedName };

/** Which records `ctx.data.find` and `ctx.data.table` give: filters and sorts on the type's top-level fields, and search. */
export interface RecordFind {
  /** Filters (all must hold), sort keys and a page, on the type's top-level fields; the hub refuses an unknown field. */
  readonly query?: ListQuery;
  /** Ranks by text over the type's `records.search.text` fields, and by meaning when the type is embedded. */
  readonly search?: string;
}

/**
 * The data system: records of stored types (`type({ records })`), kept, checked, versioned and searched by the hub.
 * In a run it acts as the run's person (a `person` type gives only their records); outside a run, as the system.
 * Every read is a query with a page: never load a whole set to filter it in code. Needs the `data` hub grant.
 *
 * ```ts
 * const saved = await ctx.data.save(contract.types.Note, { title: 'Milk', body: 'Buy oat milk.' });
 * const { items } = await ctx.data.find(contract.types.Note, { search: 'launch plan', query: { limit: 5 } });
 * ```
 */
export interface Data {
  /** One page of records, best match first when searching, else by the query's sort (newest change first). */
  find<T>(type: StoredType<T>, find?: RecordFind): Promise<{ readonly items: StoredRecord<T>[]; readonly cursor?: string }>;
  /** One record by id; `undefined` when it is gone or not the asker's to see. */
  get<T>(type: StoredType<T>, id: RecordId): Promise<StoredRecord<T> | undefined>;
  /** The same records as a `ResultTable` (one column per field, then `id`), offset-paged: what widgets draw. */
  table<T>(type: StoredType<T>, find?: Omit<RecordFind, 'query'> & { readonly query?: Omit<ListQuery, 'cursor' | 'limit'>; readonly offset?: number; readonly limit?: number }): Promise<ResultTable>;
  /**
   * Add a record (no `id`) or replace one. `expect` fails the save when the record moved past that version (someone
   * else changed it meanwhile). A `value` type has one record: leave `id` out.
   */
  save<T>(type: StoredType<T>, value: T, options?: { readonly id?: RecordId; readonly expect?: number }): Promise<StoredRecord<T>>;
  /** Remove a record (its versions stay); false when there was none. */
  remove(type: StoredType<unknown>, id: RecordId): Promise<boolean>;
}

/** Named types any system declared, from the hub. */
export interface Types {
  /**
   * The definitions of these named types and of every named type they reference, dependencies first, with the names
   * the hub doesn't know. Parse them with gin to read or check values of another system's types.
   */
  definitions(names: readonly QualifiedName[]): Promise<TypeDefinitions>;
}

/** Structured logging: a stable dotted key, then fields. */
export interface Log {
  debug(key: string, fields?: Record<string, Json>): void;
  info(key: string, fields?: Record<string, Json>): void;
  warn(key: string, fields?: Record<string, Json>): void;
  error(key: string, fields?: Record<string, Json>, error?: unknown): void;
}

/**
 * aeye through the hub, in any context: `await ctx.ai()` is an `@aeye/ai` instance whose provider is the hub, with the
 * hub's models (and a `role/<role>` model per role) listed, so aeye's selection, tools, structured output, prompts,
 * agents, images, speech and embeddings work as usual. Name a model the aeye way (`metadata: { model: 'role/chat' }`)
 * or let aeye pick. The hub decides access and budgets: in a run the run pays; elsewhere (hooks, lifecycle, timers) the
 * system's own budget does, and every call is a `ModelCall` attributed to the system.
 */
export interface AiSource {
  ai(): Promise<HarnessAi>;
}

/** Telling the hub's admins something that needs a person, e.g. a hosted system disabled after too many crashes. */
export interface AdminNotices {
  /** Each admin gets an inbox item (title and plain-words body) that links to this system's page. */
  notifyAdmins(notice: AdminNotice): Promise<void>;
}

/**
 * Saying how people connect to this instance of an instance-scoped system (`connect.scope: 'instance'`: an MCP server,
 * an API service). The hub shows a card per instance on the Connections page, and a fn that runs on the instance is
 * unavailable to a person without a connection when `flow` is set. Say it at start and whenever the config changes;
 * the latest is sent again on every reconnect.
 */
export interface InstanceConnects {
  instanceConnect(connect: z.input<typeof InstanceConnect>): Promise<void>;
}

// ─── Runs of a system's own kinds, and notices to people ───────────────────────

/**
 * What a ctx knows of its own contract: the refs of its kinds and of its pages. `SystemImpl<Defs>` types every ctx it
 * hands out with its own (`OwnOf`), so another system's kind, fn or page doesn't fit where only its own do.
 */
export interface Own<K extends AnyKindRef = AnyKindRef, P extends AnyPageRef = AnyPageRef> {
  readonly kinds: K;
  readonly pages: P;
}

/** The payload type of a kind ref. */
export type PayloadOf<K> = K extends KindRef<QualifiedName, infer P> ? P : never;

/** The brand only `kindFns` puts on a fn it lists, so a `KindFn` can't be built by hand. */
export const KIND_FN: unique symbol = Symbol('harness.kindFn');

/** A fn of one of this system's kinds, as the hub lists it. Only `kindFns` makes one (branded), so it can't be built by hand. */
export interface KindFn<K extends AnyKindRef> {
  readonly [KIND_FN]: K['name'];
  readonly fn: QualifiedName;
  readonly kind: K['name'];
  /** The person who owns it: whom its runs are started as, and whom `runs.notify` reaches. */
  readonly owner: ActorId;
  /** What people call it ("Weekly sales summary"). */
  readonly title: string;
  /** Its version, from 1, counting every save. */
  readonly version: number;
  /** Parsed by the kind's payload type. */
  readonly payload: PayloadOf<K>;
  /** Removed since `changedSince` (its last payload is given). */
  readonly removed: boolean;
  readonly updatedAt: Timestamp;
}

/** How `runs.start` starts a run. */
export interface StartAsOwner {
  /** Checked by the hub against the args the kind's `describe` gives the fn. */
  readonly args: Json;
  /** Required: the same key is the same run, so a retried or doubled start never runs twice. */
  readonly key: string;
  /** Default `background`, so people's chats go first. */
  readonly priority?: 'background' | 'interactive';
  /** Lowers the turn's per-turn budget. */
  readonly maxSpend?: Usd;
}

/** Where a notice leads: a run of the person's, or one of this system's own pages (a ref, with more path and a query). */
export type NoticeLink<O extends Own = Own> =
  | { readonly run: RunId }
  | { readonly page: O['pages']; readonly path?: readonly string[]; readonly query?: Readonly<Record<string, string>> };

/** A notice to one person: the owner of a kind fn (`runs.notify`) or the person a run is for (`ctx.notify`). */
export interface Notice<O extends Own = Own> {
  readonly title: string;
  /** At most `NOTIFICATION_BODY` (160) characters; longer is clamped on a word boundary. */
  readonly body: string;
  /** How it went, for the inbox icon; default `info`. */
  readonly tone?: NotificationTone;
  /** Where it leads. Absent: from a run, that run; from `runs.notify`, the system's main page. */
  readonly link?: NoticeLink<O>;
  /** A second link, shown as a button in the inbox and as a push action. */
  readonly also?: { readonly label: string; readonly link: NoticeLink<O> };
  /** A later notice with the same key replaces this one while it is unread (and is its push tag). */
  readonly key?: string;
}

/**
 * Runs of this system's own kinds' fns, started by the system itself as each fn's owner, and notices to those owners.
 * Needs the `runs` grant (the review flags it: "Starts runs on its own, as the owners of its fns, and notifies them").
 *
 * ```ts
 * const { items } = await ctx.runs.kindFns(contract.kinds.schedule);
 * const started = await ctx.runs.start(items[0], { args: { at }, key: `schedule:${items[0].fn}@${at}` });
 * await ctx.runs.notify(items[0], { title: 'Weekly summary ran', body: '12 rows', link: { run: started.run } });
 * ```
 */
export interface KindRuns<O extends Own = Own> {
  /** The fns of one of this system's kinds, with owner, title, version and parsed payload, a page at a time. */
  kindFns<K extends O['kinds']>(kind: K, query?: { readonly changedSince?: Timestamp; readonly cursor?: string }): Promise<{ readonly items: Array<KindFn<K>>; readonly cursor?: string }>;
  /**
   * Start a run of the fn, as its owner, outside any run and any chat (a sessionless turn). Refused (with the reason)
   * unless the owner can still use the hub, the system is live and the owner may run it. The same `key` is the same run.
   */
  start(fn: KindFn<O['kinds']>, options: StartAsOwner): Promise<StartedRun>;
  /** Notify the fn's owner (inbox and push), never anyone else. */
  notify(fn: KindFn<O['kinds']>, notice: Notice<O>): Promise<void>;
}

/** `ctx.runs`: in a system's context (hooks, events, lifecycle, timers), never in a run's. */
export interface OwnerRuns<O extends Own = Own> {
  /** Runs of this system's own kinds' fns, as their owners, and notices to those owners. Needs the `runs` grant. */
  readonly runs: KindRuns<O>;
}

/** `ctx.notify`: in a run's context only. */
export interface RunNotices<O extends Own = Own> {
  /** Notify the person this run is for (inbox and push), never anyone else. The run's settled event says it did (`notified`). */
  notify(notice: Notice<O>): Promise<void>;
}

/** What every run, undo and action gets from the hub. */
export interface Services extends SystemPlace, AiSource, AdminNotices {
  /** LLM calls through the hub, counted against the run's budget. */
  readonly llm: Llm;
  readonly files: Files;
  /**
   * Plain fetch (`serve`'s `fetch` option, else the global one). It checks no address: a process the hub or fs hosts
   * is held to its `grants.network` hosts by its supervisor's proxy, and a system that fetches a URL someone else
   * named (a page, an API service's base URL) checks every hop itself with `addressVerdict` and `followRedirects`.
   */
  readonly fetch: typeof fetch;
  /** Resources from any system the actor may see. */
  readonly resources: Resources;
  /** Named types from any system, with what they reference. */
  readonly types: Types;
  /** Records of stored types, as the run's person. */
  readonly data: Data;
  /** Attach something to the assistant message this run belongs to. The data is checked. */
  attach<A>(attachment: AttachmentRef<QualifiedName, A>, data: A, title: string): void;
  /** Attach a link to a resource, URL, file or run. */
  link(link: Link): void;
  /** The effective value of an actor setting for the run's user (merged with their groups). */
  setting<V>(setting: SettingRef<QualifiedName, V>): Promise<V | undefined>;
  readonly log: Log;
}

// ─── Runs that wait for a person, and the decision model ────────────────────────

/** What a proposed run waits on. */
export interface ProposeOptions {
  /** What the run would do, as whoever approves it sees it: the SQL, the rows it touches, a type diff. */
  readonly preview: ApprovalPreview;
  /**
   * Who answers: the person of the run proposing it (the default inside a run, and outside one when `for` names
   * them), or an admin (the default outside a run otherwise, such as a schema change found at start).
   */
  readonly approver?: ProposalApprover;
  /** Makes a retried proposal the same run. Default: a hash of the fn, its args and the proposing run. */
  readonly key?: string;
  /**
   * Outside a run, the person the proposal waits for (the owner of a Claude session this system keeps a record of).
   * The hub accepts it only when that person owns a record of one of this system's stored types naming `key`, or a
   * run of it, so pass `key` too (`proposalKeyFor`); without one, `propose` throws.
   */
  readonly for?: ActorId;
  /** The harness chat whose thread shows the card too (it is always in the approver's inbox). */
  readonly chat?: SessionId;
  /**
   * A form the approver fills before approving (a question, an MCP elicitation): its value, checked against
   * `ask.type`, is set as `args[ask.into]` of the run that then goes ahead.
   */
  readonly ask?: ProposalAsk;
}

/**
 * Adding a run that waits for approval. The run is of one of this system's own fns; the hub makes it, shows the
 * preview to its approver, and runs it like any queued run once approved. A decline settles it `cancelled` with the
 * reason. Inside a run the new run is that run's child, in its turn and session.
 */
export interface Proposals {
  /** Propose a run of a fn of this system's contract, with typed args. */
  propose<A>(fn: FnRef<QualifiedName, A, unknown, Handlers>, args: NoInfer<A>, options: ProposeOptions): Promise<ProposedRun>;
  /** Propose a run of a fn this system added at runtime, by local name, with its args as JSON. */
  propose(fn: string, args: Json, options: ProposeOptions): Promise<ProposedRun>;
}

/** What `decide` takes besides the question and candidates. */
export interface DecideOptions {
  /** The most it may pick (default 1: the one to reuse, or none). */
  readonly max?: number;
}

/**
 * Asking the admin's decision model to choose: reuse one of the candidates (a saved query, a saved form) or make
 * something new. The answer is `off` when no decision model is set and `failed` when its call failed; go by the
 * candidates' own scores then. The call is a model call of this run.
 */
export interface Decisions {
  decide(question: string, candidates: readonly DecideCandidate[], options?: DecideOptions): Promise<DecideAnswer>;
}

/**
 * What a `preview` gets: the system context, the run waiting for approval and whom it is for. A preview must not
 * change anything: it reads what the run would touch and says so.
 */
export interface PreviewCtx<Cfg = unknown, O extends Own = Own> extends SystemCtx<Cfg, O> {
  readonly run: RunId;
  readonly user: UserInfo;
}

/**
 * What a fn's `claims(args, ctx)` gets: the system context, the person whose turn made the call, the agent run that
 * made it and its chat. The call isn't a run yet, so it has no run of its own.
 */
export interface ClaimsCtx<Cfg = unknown, O extends Own = Own> extends SystemCtx<Cfg, O> {
  readonly user: UserInfo;
  /** The agent run that made the call. */
  readonly caller: RunId;
  readonly session: SessionId | undefined;
}

/** What hooks, mentions, actions, dynamic context, events and lifecycle events get. */
/**
 * This system's fleet: every paired instance, whether it is online, its config (secret fields as `SECRET_KEPT`) and
 * the types it owns, so one instance can pick which of them a request is for and forward the call with `on`.
 */
export interface Fleets {
  fleet(): Promise<FleetInstance[]>;
}

/**
 * Searching what the hub keeps, in the hub's database: fns and context by words, meaning or both, with filters by kind,
 * system, instance, sharing, types and mode (`searchFns`), and a page of one fn's examples (`fnExamples`). In a run
 * the hub answers as the run's person sees them; outside one, as the system itself.
 */
export interface FnSearch {
  searchFns(query: FnSearchQuery): Promise<FnSearchPage>;
  fnExamples(query: FnExamplesQuery): Promise<FnExamplesPage>;
}

export interface SystemCtx<Cfg = unknown, O extends Own = Own> extends SystemPlace, Proposals, Fleets, FnSearch, AiSource, AdminNotices, InstanceConnects, OwnerRuns<O> {
  readonly system: string;
  /** The system's current config. */
  readonly config: Cfg;
  readonly llm: Llm;
  readonly resources: Resources;
  readonly types: Types;
  /** Records of stored types, as the system itself (no run, so no person: `person` types are refused). */
  readonly data: Data;
  readonly log: Log;
  readonly signal: AbortSignal;
}

// ─── Session state ────────────────────────────────────────────────────────────

/**
 * A system's scratch pad for one session. Each fn, action and renderer sees only the fields it declared, matched by
 * name and type. Changes are recorded on the run, so undoing a turn puts state back, and they reach renderers live.
 */
export interface SessionState<S extends object> {
  /** The current values. A field nothing has set yet is absent. */
  get(): Promise<Readonly<Partial<S>>>;
  set(patch: Partial<S>): Promise<void>;
  /** Read, change and write in one step, so concurrent runs don't overwrite each other. */
  update(change: (current: Readonly<Partial<S>>) => Partial<S>): Promise<void>;
  /** Remove fields. */
  clear(...fields: Array<keyof S & string>): Promise<void>;
}

// ─── Calling fns ──────────────────────────────────────────────────────────────

/** How a call ended, without throwing. */
export type Settled<R> =
  | { status: 'done'; result: R }
  | { status: 'failed'; error: FnError }
  | { status: 'cancelled' };

/** Options for calling a dep. */
export interface CallOptions<H extends Handlers> {
  /** Names the call within this run. A resumed run gets a finished call's result back by key. Default: the dep name and a counter. */
  key?: string;
  /** Give the child less than what's left. */
  budget?: { cost?: Usd; time?: Duration };
  /** Don't wait: the call continues even if this run finishes. */
  background?: boolean;
  handlers?: HandlerArgs<H>;
  /** Which instance of a fleet runs the call (`laptop`); absent, the hub picks by the args' resource URIs, the session's pin or the system's default. */
  on?: InstanceName;
}

/** Calls a dep. When the dep has required handlers, the options (with those handlers) are required too. */
export type Caller<A, R, H extends Handlers> =
  HasRequiredHandlers<H> extends false
    ? (args: A, options?: CallOptions<H>) => FnCall<R>
    : (args: A, options: CallOptions<H> & { handlers: HandlerArgs<H> }) => FnCall<R>;

/** Callers for a fn's deps, by local name. */
export type Callers<D extends Deps> = {
  readonly [K in keyof D]: D[K] extends FnRef<QualifiedName, infer A, infer R, infer H> ? Caller<A, R, H> : never;
};

/**
 * A call in flight. Await it for the result; it rejects with `CallFailed` on failure or cancel. When this run is
 * paused while waiting, it rejects with `Suspended`: let that propagate.
 */
export interface FnCall<R> extends PromiseLike<R> {
  readonly key: string;
  /** Resolves when the hub has created the child run. */
  readonly run: Promise<RunId>;
  /** Like awaiting the call, but never throws. */
  readonly settled: Promise<Settled<R>>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  /** Live status and progress of the child. */
  watch(listener: (update: RunUpdate) => void): () => void;
}

/** Thrown into code waiting on a call when its run is being paused. Don't catch it. */
export class Suspended extends Error {
  override readonly name = 'Suspended';
  readonly run: RunId;
  constructor(run: RunId) {
    super(`Run ${run} is pausing.`);
    this.run = run;
  }
}

/** Thrown when a called fn fails or is cancelled. `run` is the child run, when the hub reported it. */
export class CallFailed extends Error {
  override readonly name = 'CallFailed';
  readonly run: RunId | undefined;
  readonly error: FnError | { class: 'cancelled' };
  constructor(run: RunId | undefined, error: FnError | { class: 'cancelled' }) {
    super(error.class === 'cancelled' ? `Run ${run ?? '(not started)'} was cancelled.` : error.message);
    this.run = run;
    this.error = error;
  }
}

/** Thrown when a handler the run called (`ctx.handlers.confirm(...)`) gave no answer: refused, failed or timed out. */
export class HandlerFailed extends Error {
  override readonly name = 'HandlerFailed';
  readonly handler: string;
  readonly error: FnError;
  constructor(handler: string, error: FnError) {
    super(`Handler ${handler}: ${error.message}`);
    this.handler = handler;
    this.error = error;
  }
}

// ─── Running a fn ─────────────────────────────────────────────────────────────

/** What is left of the budgets that apply to this turn, for information. The hub enforces LLM spend itself. */
export interface BudgetInfo {
  /** The least that is left across every budget that applies. */
  remaining(): { cost: Usd; time: Duration };
  /** Which budget is the tightest right now (`session`, `user`, `group: Design team`). */
  limitedBy(): string;
  /** Report a cost the hub can't see (a paid API call), so budgets stay exact. */
  spend(cost: Usd, what: string): void;
}

/** What a resuming run receives. */
export interface Resume<S> {
  readonly state: S;
  /** Results of calls that finished, by call key, so they aren't made again. */
  readonly calls: Readonly<Record<string, Settled<Json>>>;
  readonly reason: 'resumed' | 'restart';
}

/**
 * What a fn's validation hooks get (`fn({ validate })`): the system's context, the run being checked (who it is for,
 * its session and time), and for an output check which attempt this is (1 for the first result).
 */
export interface ValidateCtx<Cfg = unknown, O extends Own = Own> extends SystemCtx<Cfg, O> {
  readonly run: RunInfo;
  /** The attempt whose result is checked; 1 for an input check. */
  readonly attempt: number;
}

/**
 * What a run gets besides its args. Typed by its fn: only its deps can be called, only its handlers exist, only its
 * progress steps can be reported, and the outcome helpers take its result, undo and resume types.
 */
export interface FnCtx<T extends FnTypes, Cfg = unknown, O extends Own = Own> extends Services, Proposals, Decisions, Fleets, FnSearch, RunNotices<O> {
  /** The system's config, as it was when this run started. */
  readonly config: Cfg;
  /** Which run this is, whom it acts for, and where it sits in the tree. */
  readonly run: RunInfo;
  readonly budget: BudgetInfo;
  /** Aborts on cancel or timeout. */
  readonly signal: AbortSignal;
  readonly fns: Callers<T['deps']>;
  readonly handlers: HandlersInRun<T['handlers']>;
  readonly progress: ProgressReporter<T['progress']>;
  readonly state: SessionState<T['state']>;
  /** Wait for the run's renderer to submit its form. Only fns that declare a `form` type have it. */
  readonly form: [T['form']] extends [never] ? undefined : () => Promise<T['form']>;
  /**
   * The person's connection this run acts as (a per-person system's fn, `connect` in the contract): its credentials
   * and settings, which the hub picked (the caller's own, else one shared with them). `undefined` otherwise.
   */
  readonly connection: RunConnection | undefined;
  /**
   * The approval this run went ahead on, for a fn with `approval`: who approved it and the preview they saw, so the
   * run can check it does what was approved (an install runs only the hashes on its card). `undefined` otherwise.
   */
  readonly approved: ApprovedRun | undefined;
  /**
   * Hand the hub refreshed credentials for this run's connection, or say they can't be refreshed (`expired`, with
   * why in plain words). Resolves once the hub has them; throws when the run has no connection.
   */
  updateConnection(update: ConnectionUpdate['update']): Promise<void>;
  /**
   * Give a fn of this system (one this run added, a saved form) to the run's person, with who else may use it. They
   * own it from then on and can change that on the fn's page. Resolves once the hub has it.
   */
  shareFn(fn: string, share: ShareRule): Promise<void>;
  /**
   * Which of the named fns of this system the run's person may use now, by the hub's current visibility (groups
   * included). Ask this rather than a copy of who was given a fn: its owner or an admin can change that at any time.
   */
  usableFns(fns: readonly string[]): Promise<string[]>;
  /** Set when this run is resuming after a pause or a hub restart. */
  readonly resume: Resume<T['resume']> | undefined;
  /** Called when the run is asked to pause: return the state to resume from. Only fns with a resume type can pause. */
  onPause(hook: () => T['resume'] | Promise<T['resume']>): void;
  /** Narrow what can be done to this run right now ("no cancelling during the commit"). */
  allow(operations: Partial<AllowedOperations>): void;
  /** Record an undo payload before finishing (after the first irreversible step). The last one wins. */
  undoWith(payload: T['undo']): void;
  done(result: T['result'], extra?: { undo?: T['undo']; cost?: Usd }): Outcome<T>;
  /**
   * The args were wrong in a way the fn's types can't say (a path outside the root, an end before the start): the
   * caller's mistake, not a failure. An agent gets the problems back and tries again; the chat shows the run calmly as
   * "Thinking harder", never as an error. Give a message, or problems by path (a dotted path into the args, `''` for the whole).
   */
  invalid(problems: string | readonly InputProblem[], extra?: { cost?: Usd }): Outcome<T>;
  /**
   * Show the agent another fn with this result (`fs/search` showing `fs/read`): its card at `detail` (default
   * `signature`) follows the tool reply, and it stays near the top of the next selection. Applies when the run is done.
   */
  expose(fn: AnyFnRef, detail?: Detail): void;
  fail(cls: ErrorClass, message: string, extra?: { code?: string; data?: Json; undo?: T['undo']; cost?: Usd }): Outcome<T>;
  pause(state: T['resume'], extra?: { cost?: Usd }): Outcome<T>;
  cancelled(extra?: { partial?: T['result']; undo?: T['undo']; cost?: Usd }): Outcome<T>;
}

/** What an undo implementation gets. */
export interface UndoCtx<Cfg = unknown> extends Services {
  readonly config: Cfg;
  readonly run: RunInfo;
  readonly signal: AbortSignal;
}

/** What a person-facing implementation (mentions, actions, dynamic context) knows about who is asking. */
export interface AskerCtx {
  readonly session: SessionId;
  readonly user: UserInfo;
  readonly time: TimeInfo;
}

/** What an action's implementation gets. */
export interface ActionCtx<St extends object, Cfg = unknown, O extends Own = Own> extends SystemCtx<Cfg, O>, AskerCtx, Omit<Services, 'log' | 'llm' | 'resources' | 'types'> {
  readonly delivery: DeliveryId;
  /** The run whose renderer sent it, if any. */
  readonly run: RunId | undefined;
  readonly actor: ActorId;
  readonly state: SessionState<St>;
}

/** A live view of a run's status, as a renderer and a caller see it. */
export interface RunStatusView {
  readonly status: RunStatus;
  readonly allowed: Pick<Operations, 'cancel' | 'pause' | 'background'>;
}
