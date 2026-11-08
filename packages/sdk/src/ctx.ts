/**
 * What implementations receive: the run context (`FnCtx`), typed by the fn it runs, and the services every run,
 * hook, mention, action and lifecycle event gets. These are interfaces; the serve runtime provides them.
 */
import type {
  ActorId, AllowedOperations, ContentRef, DeliveryId, Detail, InstanceName, ModelForward, ModelForwardResult, ErrorClass, FnError, InputProblem, Json, Link, ModelChoice, Operations, QualifiedName,
  ResourceHit, ResourceLink, ResourceStat, ResourceUri, RunId, RunInfo, RunStatus, RunUpdate, Section, SectionKey, SessionId, TimeInfo, Usd,
  Duration, TypeDefinitions, UserInfo,
} from '@harness/core';
import type { FnTypes, HandlerArgs, Handlers, HandlersInRun, HasRequiredHandlers, Outcome, ProgressReporter, Deps } from './fn.ts';
import type { GinType } from './gin.ts';
import type { AnyFnRef, AttachmentRef, FnRef, SettingRef } from './refs.ts';

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
  links(uri: ResourceUri): Promise<ResourceLink[]>;
  sections(uri: ResourceUri): Promise<Section[]>;
  search(query: string, options?: { roots?: ResourceUri[]; limit?: number }): Promise<ResourceHit[]>;
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

/** What every run, undo and action gets from the hub. */
export interface Services extends SystemPlace {
  /** LLM calls through the hub, counted against the run's budget. */
  readonly llm: Llm;
  readonly files: Files;
  /** fetch, through the system's outbound rules. */
  readonly fetch: typeof fetch;
  /** Resources from any system the actor may see. */
  readonly resources: Resources;
  /** Named types from any system, with what they reference. */
  readonly types: Types;
  /** Attach something to the assistant message this run belongs to. The data is checked. */
  attach<A>(attachment: AttachmentRef<QualifiedName, A>, data: A, title: string): void;
  /** Attach a link to a resource, URL, file or run. */
  link(link: Link): void;
  /** The effective value of an actor setting for the run's user (merged with their groups). */
  setting<V>(setting: SettingRef<QualifiedName, V>): Promise<V | undefined>;
  readonly log: Log;
}

/** What hooks, mentions, actions, dynamic context, events and lifecycle events get. */
export interface SystemCtx<Cfg = unknown> extends SystemPlace {
  readonly system: string;
  /** The system's current config. */
  readonly config: Cfg;
  readonly llm: Llm;
  readonly resources: Resources;
  readonly types: Types;
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
 * What a run gets besides its args. Typed by its fn: only its deps can be called, only its handlers exist, only its
 * progress steps can be reported, and the outcome helpers take its result, undo and resume types.
 */
export interface FnCtx<T extends FnTypes, Cfg = unknown> extends Services {
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
   * caller's mistake, not a failure. An agent gets the problems back and tries again; the chat shows the run softly as
   * "Retried". Give a message, or problems by path (a dotted path into the args, `''` for the whole).
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
export interface ActionCtx<St extends object, Cfg = unknown> extends SystemCtx<Cfg>, AskerCtx, Omit<Services, 'log' | 'llm' | 'resources' | 'types'> {
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
