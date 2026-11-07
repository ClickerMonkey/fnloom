// # Station SDK
// Everything a station author touches: the contract they declare in `shared/`, the implementation they write in
// `server/`, the context a fn runs with, and the renderers they register in `client/`. This is the part of the
// harness other people build on, so it is typed end to end:
//
//   - Every name an author declares is inferred as a literal, and every cross-reference is a typed handle (a ref),
//     never a string. A ref to something that doesn't exist doesn't compile.
//   - The contract declares; the server implements. Everything declared must be implemented, and nothing can be
//     implemented that wasn't declared.
//   - Types are written once, as gin types with the `g` builder. Args, results, handler shapes, payloads, settings
//     and renderer props are all inferred from them.
//
// The only library type in this file is gin's wire `TypeDef`, which is what a gin type is on the wire.

import type { TypeDef } from '@aeye/gin';

// ═══ Basics ═══

declare const brand: unique symbol;
declare const phantom: unique symbol;

/** An opaque id for an entity of kind K. Ids of different kinds can't be mixed up. */
export type Id<K extends string> = string & { readonly [brand]: K };
export type RunId = Id<'run'>;
export type TurnId = Id<'turn'>;
export type SessionId = Id<'session'>;
export type ActorId = Id<'actor'>;
export type MessageId = Id<'message'>;

/** Milliseconds. */
export type Duration = number;
/** Milliseconds since the epoch. */
export type Timestamp = number;
/** US dollars. */
export type Usd = number;

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A name qualified by its station: `fs/read`, `hub/search_fns`, `fs/FileInfo`. */
export type QualifiedName<S extends string = string, N extends string = string> = `${S}/${N}`;

/** How urgent queued work is. */
export type Priority = 'urgent' | 'interactive' | 'normal' | 'background';

/** Who can see a thing: people in the UI, the LLM, both, or neither. */
export type Audience = 'user' | 'llm' | 'both' | 'none';

/** What kind of thing an actor is. */
export type ActorKind = 'user' | 'group' | 'agent' | 'station' | 'system';

/** A page of results with a cursor for the next page. */
export interface Page<T> {
  items: T[];
  /** Absent on the last page. */
  cursor?: string;
}

// ═══ Gin types ═══

/** A gin type in its JSON wire form. This is how types travel to the hub and are stored. */
export type GinTypeDef = TypeDef;

/**
 * A gin type that also carries the TypeScript type of its values. `g.obj({ path: g.text() })` is a
 * `GinType<{ path: string }>`. Everything typed in the SDK is inferred from these.
 */
export interface GinType<T> {
  /** The wire definition. */
  readonly def: GinTypeDef;
  /** Phantom: the TS type of a value. Never set at runtime. */
  readonly [phantom]?: T;
}

/** An object field that may be absent. Made with `g.optional(t)`. */
export interface GinOptional<T> extends GinType<T | undefined> {
  readonly optional: true;
}

/** The TS value type of a gin type. */
export type Infer<G> = G extends GinType<infer T> ? T : never;

type OptionalKeys<P> = { [K in keyof P]: P[K] extends GinOptional<unknown> ? K : never }[keyof P];
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The TS object type of `g.obj(fields)`: fields made with `g.optional` become optional keys. */
export type ObjOf<P extends Record<string, GinType<unknown>>> = Simplify<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } &
  { [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined> }
>;

/** Options on a number type. */
export interface NumOptions { min?: number; max?: number; whole?: boolean }
/** Options on a text type. */
export interface TextOptions { minLength?: number; maxLength?: number; pattern?: string; /** Shown as a multi-line input. */ multiline?: boolean }

/**
 * The gin type builder, exported as `g`. Each method makes a gin type and keeps its TS type. Every type made
 * here has a chat input, so any fn can be run by hand with `!`.
 */
export interface GinBuilder {
  text(options?: TextOptions): GinType<string>;
  num(options?: NumOptions): GinType<number>;
  bool(): GinType<boolean>;
  /** A calendar date, `2026-11-07`. */
  date(): GinType<string>;
  timestamp(): GinType<Timestamp>;
  duration(): GinType<Duration>;
  /** Any JSON. The LLM and the input form get no structure, so prefer a real type. */
  json(): GinType<Json>;
  list<T>(item: GinType<T>, options?: { minLength?: number; maxLength?: number }): GinType<T[]>;
  map<V>(value: GinType<V>): GinType<Record<string, V>>;
  obj<const P extends Record<string, GinType<unknown>>>(fields: P, docs?: { [K in keyof P]?: string }): GinType<ObjOf<P>>;
  optional<T>(type: GinType<T>): GinOptional<T>;
  nullable<T>(type: GinType<T>): GinType<T | null>;
  enum<const V extends readonly [string, ...string[]]>(...values: V): GinType<V[number]>;
  literal<const V extends string | number | boolean>(value: V): GinType<V>;
  or<const A extends readonly [GinType<unknown>, GinType<unknown>, ...GinType<unknown>[]]>(...types: A): GinType<Infer<A[number]>>;
  /** A resource URI. Its input is a resource picker. */
  resource(): GinType<ResourceUri>;
  /** Stored content by reference (an upload, a previous file version). */
  content(): GinType<ContentRef>;
  /** An actor id. Its input is a people picker. */
  actor(): GinType<ActorId>;
  /** Add a description, shown to the LLM and in input forms. */
  docs<T>(type: GinType<T>, docs: string): GinType<T>;
}

/** The gin type builder. */
export declare const g: GinBuilder;

// ═══ Refs ═══

/**
 * A typed handle to a fn. Exported from a station's contract (`fs.fns.read`); used to declare a dep and to call
 * the fn with checked args, result and handlers.
 */
export interface FnRef<N extends QualifiedName, A, R, H extends Handlers = {}> {
  readonly name: N;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  readonly handlers: H;
}

/** A typed handle to a named type (`fs.types.FileInfo`). Use it in other stations' gin types with `g`-built fields. */
export interface TypeRef<N extends QualifiedName, T> extends GinType<T> {
  readonly name: N;
}

/** A typed handle to a fn kind. `kinds.api.fn({...})` declares a fn of that kind. */
export interface KindRef<N extends QualifiedName, P> {
  readonly name: N;
  readonly payload: GinType<P>;
  /** Declare a fn of this kind. The args and result types are what you expect the payload to produce; the hub checks them against what the kind derives. */
  fn<A, R>(def: KindFnInput<P, A, R>): FnDef<KindFnTypes<KindRef<N, P>, P, A, R>>;
}

/** A typed handle to context. A `/command`'s args are typed. */
export interface ContextRef<N extends QualifiedName, A> {
  readonly name: N;
  readonly [phantom]?: A;
}

/** A typed handle to an actor setting. `ctx.setting(fs.settings.limits)` returns its typed value. */
export interface SettingRef<N extends QualifiedName, T> {
  readonly name: N;
  readonly type: GinType<T>;
}

/** A typed handle to an attachment kind. `ctx.attach(fs.attachments.diff, data)` checks the data. */
export interface AttachmentRef<N extends QualifiedName, T> {
  readonly name: N;
  readonly data: GinType<T>;
}

/** A handle to a user-message hook. */
export interface HookRef<N extends QualifiedName> { readonly name: N; readonly kind: 'hook' }
/** A handle to an `@` mention provider. */
export interface MentionRef<N extends QualifiedName> { readonly name: N; readonly kind: 'mention' }
/** A handle to an embedder. */
export interface EmbedderRef<N extends QualifiedName> { readonly name: N; readonly kind: 'embedder' }
/** A handle to a sectioner. */
export interface SectionerRef<N extends QualifiedName> { readonly name: N; readonly kind: 'sectioner' }

export type AnyFnRef = FnRef<QualifiedName, unknown, unknown, Handlers>;
export type AnyContextRef = ContextRef<QualifiedName, unknown>;
export type AnyHookRef = HookRef<QualifiedName>;

// ═══ Declaring fns ═══

/**
 * Everything the type system knows about one fn. A fn's def, its ref, its context and its renderer props are all
 * computed from this, so they can't disagree.
 */
export interface FnTypes {
  /** `system` (implemented in code by its station) or the ref of the kind that runs it. */
  kind: 'system' | AnyKindRef;
  /** The kind's payload; `undefined` for system fns. */
  payload: unknown;
  args: unknown;
  result: unknown;
  deps: Deps;
  handlers: Handlers;
  progress: ProgressDef;
  /** The resume payload type; `never` when the fn can't pause. */
  resume: unknown;
  /** The undo payload type; `never` when the fn can't be undone. */
  undo: unknown;
}

/** A fn's deps by local name: `{ stat: fs.fns.stat }`. */
export type Deps = Record<string, AnyFnRef>;

/** A fn's contract as declared in `shared/`. Made with `fn()`, `agent()` or `kinds.x.fn()`. */
export interface FnDef<T extends FnTypes> {
  readonly kind: T['kind'];
  readonly payload: T['payload'];
  readonly description: string;
  readonly instructions?: string;
  readonly args: GinType<T['args']>;
  readonly returns: GinType<T['result']>;
  readonly deps: T['deps'];
  readonly handlers: T['handlers'];
  readonly progress: T['progress'];
  readonly resume?: GinType<T['resume']>;
  readonly undo?: GinType<T['undo']>;
  readonly operations: Operations;
  readonly limits: FnLimits;
  readonly visibility: Audience;
  readonly tags: readonly string[];
  /** Phantom: lets the SDK read T back out of a def. */
  readonly [phantom]?: T;
}

export type AnyFnDef = FnDef<FnTypes>;

/** The types of a fn def. */
export type TypesOf<F> = F extends FnDef<infer T> ? T : never;

/** What `fn()` takes. Only `description`, `args` and `returns` are required. */
export interface FnInput<A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U> {
  description: string;
  /** Extra guidance the LLM sees when the fn is in its toolset. */
  instructions?: string;
  args: GinType<A>;
  returns: GinType<R>;
  /** Fns the implementation may call. Nothing else can be called. */
  deps?: D;
  /** Callbacks the caller may supply. */
  handlers?: H;
  progress?: P;
  /** Declaring a resume type makes the fn pausable. */
  resume?: GinType<S>;
  /** Declaring an undo type makes the fn undoable, and requires an `undo` implementation. */
  undo?: GinType<U>;
  /** Defaults: cancel yes, background yes. Pause and undo follow `resume` and `undo`. */
  operations?: Partial<Pick<Operations, 'cancel' | 'background'>>;
  limits?: FnLimits;
  /** Default `both`. */
  visibility?: Audience;
  tags?: string[];
}

/** The types of a system fn. */
export interface SystemFnTypes<A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U> {
  kind: 'system'; payload: undefined; args: A; result: R; deps: D; handlers: H; progress: P; resume: S; undo: U;
}

/** Declare a system fn: a fn its station implements in code. */
export declare function fn<A, R, const D extends Deps = {}, const H extends Handlers = {}, const P extends ProgressDef = NoProgress, S = never, U = never>(
  def: FnInput<A, R, D, H, P, S, U>,
): FnDef<SystemFnTypes<A, R, NoInfer<D>, NoInfer<H>, NoInfer<P>, NoInfer<S>, NoInfer<U>>>;

/** What a fn's runs support. Pause and undo are set by declaring `resume` and `undo` types. */
export interface Operations {
  cancel: boolean;
  pause: boolean;
  undo: boolean;
  /** Can be moved to the background so the agent stops waiting. */
  background: boolean;
}

/** Limits and estimates for a fn's runs. */
export interface FnLimits {
  /** Hard limit for one run. The hub's global tool timeout still applies. */
  timeout?: Duration;
  /** Retries for failures classed `retry`. */
  retries?: number;
  /** A rough cost per run, for budget checks before the first measurement. */
  cost?: Usd;
}

// ═══ Handlers ═══

/** A callback a fn may ask its caller for mid-run ("overwrite?", "pick a folder"). */
export interface HandlerDef<A, R, Req extends boolean> {
  readonly description: string;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  /** A caller that can't answer a required handler can't call the fn. */
  readonly required: Req;
}

/** A fn's handlers by name. */
export type Handlers = Record<string, HandlerDef<unknown, unknown, boolean>>;

/** Declare a handler. People answer handlers with a form; agents and code answer them with a function. */
export declare function handler<A, R, const Req extends boolean>(def: HandlerDef<A, R, Req>): HandlerDef<A, R, Req>;

/** A handler as a function. */
export type HandlerFn<HD> = HD extends HandlerDef<infer A, infer R, boolean> ? (args: A) => Promise<R> : never;

type RequiredKeys<H extends Handlers> = { [K in keyof H]: H[K]['required'] extends true ? K : never }[keyof H];
type OptionalKeysOf<H extends Handlers> = Exclude<keyof H, RequiredKeys<H>>;

/** The handlers a caller passes: every required one, any optional one. */
export type HandlerArgs<H extends Handlers> =
  Simplify<{ [K in RequiredKeys<H>]: HandlerFn<H[K]> } & { [K in OptionalKeysOf<H>]?: HandlerFn<H[K]> }>;

/** A fn's own handlers as it sees them: required ones are always there; optional ones may be missing. */
export type HandlersInRun<H extends Handlers> =
  Simplify<{ readonly [K in RequiredKeys<H>]: HandlerFn<H[K]> } & { readonly [K in OptionalKeysOf<H>]: HandlerFn<H[K]> | undefined }>;

// ═══ Progress ═══

/** How a fn reports progress. */
export type ProgressDef = NoProgress | LinearProgress | StepsProgress<Record<string, string>>;
export interface NoProgress { readonly type: 'none' }
export interface LinearProgress { readonly type: 'linear' }
/** Named steps; the record maps each step to its title. */
export interface StepsProgress<S extends Record<string, string>> { readonly type: 'steps'; readonly steps: S }

/** Progress as a fraction from 0 to 1. */
export declare const linear: LinearProgress;
/** Progress as named steps: `steps({ read: 'Read the file', write: 'Write the copy' })`. */
export declare function steps<const S extends Record<string, string>>(steps: S): StepsProgress<S>;

/** The status of one step. */
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

/** How a run reports progress, shaped by its fn's progress def. A fn with no progress def gets nothing to call. */
export type ProgressReporter<P extends ProgressDef> =
  P extends LinearProgress ? { set(fraction: number, message?: string): void } :
  P extends StepsProgress<infer S> ? { step(name: keyof S & string, status: StepStatus, detail?: string): void } :
  { readonly type: 'none' };

/** Progress as the UI sees it, shaped the same way. */
export type ProgressState<P extends ProgressDef> =
  P extends LinearProgress ? { fraction: number; message?: string } :
  P extends StepsProgress<infer S> ? { steps: { [K in keyof S]: { status: StepStatus; detail?: string } } } :
  undefined;

// ═══ Running a fn ═══

/** How the hub should treat a failure. */
export type ErrorClass =
  /** Try again (up to the fn's retries). */
  | 'retry'
  /** Give it back to the caller, so the LLM can fix its call. */
  | 'caller'
  /** Stop the whole turn. */
  | 'fatal';

/** A failure. */
export interface FnError {
  class: ErrorClass;
  message: string;
  /** A stable code for programs: `not-found`, `denied`, `timeout`, `budget`. */
  code?: string;
  data?: Json;
}

/**
 * How a run ended. Build it with the ctx helpers (`ctx.done(result)`, `ctx.fail(...)`, `ctx.pause(state)`,
 * `ctx.cancelled()`), which are typed to the fn.
 */
export type Outcome<T extends FnTypes> =
  | { status: 'done'; result: T['result']; undo?: T['undo']; cost?: Usd }
  | { status: 'paused'; resume: T['resume']; cost?: Usd }
  | { status: 'failed'; error: FnError; undo?: T['undo']; cost?: Usd }
  | { status: 'cancelled'; partial?: T['result']; undo?: T['undo']; cost?: Usd };

/** The result of undoing a run. */
export type UndoOutcome =
  | { status: 'undone'; summary: string }
  | { status: 'failed'; error: FnError }
  /** Nothing left to undo. */
  | { status: 'gone' };

/** The implementation of a system fn. `undo` is required exactly when the fn declares an undo type. */
export type FnImpl<T extends FnTypes> =
  { run(args: T['args'], ctx: FnCtx<T>): Promise<Outcome<T>> } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx): Promise<UndoOutcome> });

/**
 * What a run gets besides its args. Typed by its fn: only its deps can be called, only its handlers exist, only
 * its progress steps can be reported, and the outcome helpers take its result, undo and resume types.
 */
export interface FnCtx<T extends FnTypes> extends Services {
  /** Which run this is, whom it acts for, and where it sits in the tree. */
  readonly run: RunInfo;
  /** Money and time left for this run and everything it calls. */
  readonly budget: Budget;
  /** Aborts on cancel, timeout or an empty budget. */
  readonly signal: AbortSignal;
  /** Call the fn's deps. */
  readonly fns: Callers<T['deps']>;
  /** The handlers the caller supplied. */
  readonly handlers: HandlersInRun<T['handlers']>;
  /** Report progress in the shape the fn declared. */
  readonly progress: ProgressReporter<T['progress']>;
  /** Set when this run is resuming after a pause or a hub restart. */
  readonly resume: Resume<T['resume']> | undefined;
  /** Called when the run is asked to pause: return the state to resume from. Only fns with a resume type can pause. */
  onPause(hook: () => T['resume'] | Promise<T['resume']>): void;
  /** Narrow what can be done to this run right now ("no cancelling during the commit"). */
  allow(operations: Partial<Pick<Operations, 'cancel' | 'pause' | 'background'>>): void;
  /** Record an undo payload before finishing (after the first irreversible step). The last one wins. */
  undoWith(payload: T['undo']): void;
  done(result: T['result'], extra?: { undo?: T['undo']; cost?: Usd }): Outcome<T>;
  fail(cls: ErrorClass, message: string, extra?: { code?: string; data?: Json; undo?: T['undo']; cost?: Usd }): Outcome<T>;
  pause(state: T['resume'], extra?: { cost?: Usd }): Outcome<T>;
  cancelled(extra?: { partial?: T['result']; undo?: T['undo']; cost?: Usd }): Outcome<T>;
}

/** What an undo implementation gets. */
export interface UndoCtx extends Services {
  readonly run: RunInfo;
  readonly signal: AbortSignal;
}

/** Facts about the current run. */
export interface RunInfo {
  readonly id: RunId;
  readonly fn: QualifiedName;
  readonly parent?: RunId;
  readonly turn: TurnId;
  readonly session?: SessionId;
  /** Whom the run acts for: permissions and settings are theirs. */
  readonly actor: ActorId;
  /** Who called: the agent, the user (with `!`), or the parent run's fn. */
  readonly caller: ActorId;
  readonly attempt: number;
  readonly priority: Priority;
}

/** A run's budget. */
export interface Budget {
  readonly cost: Usd;
  readonly time: Duration;
  /** What's left now, after what this run and its children spent. */
  remaining(): { cost: Usd; time: Duration };
  /** Report a cost the hub can't see (a paid API call). LLM calls through `ctx.llm` are counted automatically. */
  spend(cost: Usd, what: string): void;
}

/** What a resuming run receives. */
export interface Resume<S> {
  readonly state: S;
  /** Results of calls that finished, by call key, so they aren't made again. */
  readonly calls: Readonly<Record<string, Settled<Json>>>;
  readonly reason: 'resumed' | 'restart';
}

/** How a call ended, without throwing. */
export type Settled<R> =
  | { status: 'done'; result: R }
  | { status: 'failed'; error: FnError }
  | { status: 'cancelled' };

// ═══ Calling fns ═══

/** Options for calling a dep. */
export interface CallOptions<H extends Handlers> {
  /** Names the call within this run. A resumed run gets a finished call's result back by key instead of calling again. Default: the dep name and a counter. */
  key?: string;
  /** Give the child less than what's left. */
  budget?: { cost?: Usd; time?: Duration };
  /** Don't wait: the call continues even if this run finishes. */
  background?: boolean;
  handlers?: HandlerArgs<H>;
}

/** Calls a dep. When the dep has required handlers, the options (with those handlers) are required too. */
export type Caller<A, R, H extends Handlers> =
  [RequiredKeys<H>] extends [never]
    ? (args: A, options?: CallOptions<H>) => FnCall<R>
    : (args: A, options: CallOptions<H> & { handlers: HandlerArgs<H> }) => FnCall<R>;

/** Callers for a fn's deps, by local name. */
export type Callers<D extends Deps> = {
  readonly [K in keyof D]: D[K] extends FnRef<QualifiedName, infer A, infer R, infer H> ? Caller<A, R, H> : never;
};

/**
 * A call in flight. Await it for the result; it rejects with `CallFailed` on failure or cancel. When this run is
 * paused while waiting, it rejects with `Suspended`: let that propagate (the run resumes later with the call's
 * result by key).
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
export declare class Suspended extends Error {
  readonly run: RunId;
}

/** Thrown when a called fn fails or is cancelled. */
export declare class CallFailed extends Error {
  readonly run: RunId;
  readonly error: FnError | { class: 'cancelled' };
}

/** A live change to a run. */
export type RunUpdate =
  | { type: 'status'; status: RunStatus }
  | { type: 'progress'; progress: Json }
  | { type: 'allowed'; operations: Pick<Operations, 'cancel' | 'pause' | 'background'> }
  | { type: 'cost'; cost: Usd; total: Usd };

/** Where a run is. */
export type RunStatus = 'awaiting-approval' | 'queued' | 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled' | 'undone';

// ═══ Services ═══

/** What every run, hook and handler gets from the hub. */
export interface Services {
  /** LLM calls through the hub, counted against the run's budget. */
  readonly llm: Llm;
  /** File operations, limited to what the station allows. */
  readonly files: Files;
  /** fetch, through the station's outbound rules. */
  readonly fetch: typeof fetch;
  /** Resources from any station the actor may see. */
  readonly resources: Resources;
  /** Attach something to the assistant message this run belongs to. */
  attach<A>(attachment: AttachmentRef<QualifiedName, A>, data: A, title: string): void;
  /** Attach a link to a resource, URL, file or run. */
  link(link: Link): void;
  /** The effective value of an actor setting for the run's actor (user, merged with their groups). */
  setting<V>(setting: SettingRef<QualifiedName, V>): Promise<V | undefined>;
  readonly log: Log;
}

/** A link attachment. */
export type Link =
  | { resource: ResourceUri; section?: SectionKey; title?: string }
  | { url: string; title: string }
  | { file: ContentRef; title: string }
  | { run: RunId; title: string };

/** Which model to use. */
export type ModelChoice =
  | { model: string }
  | { category: string }
  | { auto: { cost?: number; speed?: number; accuracy?: number } };

/** LLM calls. They always go through the hub, which picks the model, enforces spend limits and records them. */
export interface Llm {
  text(input: { prompt: string; system?: string; model?: ModelChoice }): Promise<string>;
  /** An answer checked against a gin type. */
  object<T>(input: { prompt: string; output: GinType<T>; system?: string; model?: ModelChoice }): Promise<T>;
  stream(input: { prompt: string; system?: string; model?: ModelChoice }): AsyncIterable<string>;
  embed(texts: string[]): Promise<number[][]>;
}

/** File operations. */
export interface Files {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string): Promise<ResourceStat[]>;
  remove(path: string): Promise<void>;
  /** Upload to the hub so it can be attached or passed by ref. */
  share(path: string): Promise<ContentRef>;
}

/** Reading resources. The hub routes each URI to the station that serves it. */
export interface Resources {
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  text(uri: ResourceUri, sections?: SectionKey[]): Promise<string>;
  links(uri: ResourceUri): Promise<ResourceLink[]>;
  sections(uri: ResourceUri): Promise<Section[]>;
  search(query: string, options?: { roots?: ResourceUri[]; limit?: number }): Promise<Array<{ uri: ResourceUri; section?: SectionKey; title: string; preview: string; score: number }>>;
}

/** Structured logging: a unique key, then fields. */
export interface Log {
  debug(key: string, fields?: Record<string, Json>): void;
  info(key: string, fields?: Record<string, Json>): void;
  warn(key: string, fields?: Record<string, Json>): void;
  error(key: string, fields?: Record<string, Json> & { error?: Error }): void;
}

// ═══ Kinds ═══

/** A fn kind as declared in a contract: what its payload looks like and when to use it. */
export interface KindDef<P> {
  readonly description: string;
  /** When an agent should pick this kind for a new fn. */
  readonly applicability: string;
  readonly payload: GinType<P>;
  /** Whether declaring or changing a fn of this kind at runtime needs approval. Default true. */
  readonly approveChanges: boolean;
}

/** Declare a kind. */
export declare function kind<P>(def: { description: string; applicability: string; payload: GinType<P>; approveChanges?: boolean }): KindDef<P>;

export type AnyKindRef = KindRef<QualifiedName, unknown>;

/** What `kinds.x.fn()` takes. */
export interface KindFnInput<P, A, R> {
  description: string;
  instructions?: string;
  payload: P;
  /** What the payload should produce; checked by the hub against the kind's own description of it. */
  args: GinType<A>;
  returns: GinType<R>;
  visibility?: Audience;
  tags?: string[];
}

/** The types of a fn of some kind. Its deps, handlers and progress come from the kind at runtime. */
export interface KindFnTypes<K extends AnyKindRef, P, A, R> {
  kind: K; payload: P; args: A; result: R; deps: {}; handlers: {}; progress: NoProgress; resume: never; undo: never;
}

/** What a kind works out from one payload. */
export interface KindDescription {
  args: GinTypeDef;
  returns: GinTypeDef;
  /** The fns a payload calls (a program's calls, an agent's tools). The hub refuses calls outside these. */
  deps: QualifiedName[];
  operations: Operations;
}

/**
 * A kind's implementation. The payload is typed; a fn's args and result aren't (they depend on the payload), so
 * they arrive as JSON the hub has already checked against `describe`'s types.
 */
export interface KindImpl<P> {
  /** Problems with a payload beyond its type (an unknown fn, a program that doesn't type-check). */
  check(payload: P, ctx: KindCheckCtx): Promise<string[]>;
  describe(payload: P, ctx: KindCheckCtx): Promise<KindDescription>;
  run(payload: P, args: Json, ctx: KindRunCtx): Promise<Outcome<UntypedFn>>;
  undo?(payload: P, undo: Json, ctx: UndoCtx): Promise<UndoOutcome>;
}

/** What a kind can look up while checking a payload. */
export interface KindCheckCtx {
  type(name: QualifiedName): Promise<GinTypeDef | undefined>;
  fn(name: QualifiedName): Promise<{ args: GinTypeDef; returns: GinTypeDef; description: string } | undefined>;
}

/** The types of a fn known only at runtime. */
export interface UntypedFn {
  kind: AnyKindRef; payload: unknown; args: Json; result: Json; deps: {}; handlers: Handlers; progress: ProgressDef; resume: Json; undo: Json;
}

/** A kind's run context: like `FnCtx`, but calls are by name (limited to the deps `describe` returned). */
export interface KindRunCtx extends Omit<FnCtx<UntypedFn>, 'fns' | 'handlers' | 'progress'> {
  call(fn: QualifiedName, args: Json, options?: { key?: string; background?: boolean }): FnCall<Json>;
  handler(name: string, args: Json): Promise<Json>;
  progress(state: { fraction: number; message?: string } | { step: string; status: StepStatus; detail?: string }): void;
}

// ═══ Agents ═══

/** The payload of a `hub/llm` fn, as stored. Built from refs by `agent()`. */
export interface LlmPayload {
  instructions: string;
  model?: ModelChoice;
  tools: QualifiedName[];
  /** Fns the agent may add to its toolset while running. */
  canLoad: { fns?: QualifiedName[]; stations?: string[]; tags?: string[] } | 'none';
  maxTools: number;
  context: QualifiedName[];
  hooks: QualifiedName[];
  toolExecution: 'parallel' | 'sequential';
  maxIterations: number;
}

/** The types of an agent fn. */
export type AgentFnTypes<A, R> = KindFnTypes<KindRef<'hub/llm', LlmPayload>, LlmPayload, A, R>;

/**
 * Declare an agent: an LLM with instructions, tools and context, callable like any fn. A station can ship its
 * own agents (a code reviewer, a planner) with tools from any station.
 */
export declare function agent<A, R>(def: {
  description: string;
  args: GinType<A>;
  /** Text for a chat-style agent; any type for a structured answer. */
  returns: GinType<R>;
  /** Handlebars; `{{args.x}}` reads the args. */
  instructions: string;
  model?: ModelChoice;
  tools?: AnyFnRef[];
  canLoad?: { fns?: AnyFnRef[]; stations?: string[]; tags?: string[] } | 'none';
  maxTools?: number;
  context?: AnyContextRef[];
  hooks?: AnyHookRef[];
  toolExecution?: 'parallel' | 'sequential';
  maxIterations?: number;
  visibility?: Audience;
  tags?: string[];
}): FnDef<AgentFnTypes<A, R>>;

// ═══ Context ═══

/** An argument of a `/command`. */
export interface ArgDef<Req extends boolean> {
  readonly hint: string;
  readonly required: Req;
}

/** Declare a `/command` argument. */
export declare function arg<const Req extends boolean = true>(hint: string, options?: { required?: Req }): ArgDef<Req>;

/** The args object of a command. */
export type ArgsOf<A extends Record<string, ArgDef<boolean>>> =
  Simplify<{ -readonly [K in keyof A as A[K]['required'] extends true ? K : never]: string } & { -readonly [K in keyof A as A[K]['required'] extends true ? never : K]?: string }>;

/**
 * Content for the LLM. Static content is written in the contract; dynamic content (no `content`) is produced by
 * the station when loaded, so the server must implement it. Context can bring other context and fns along: with
 * fns it is a skill.
 */
export interface ContextDef<A, Dynamic extends boolean> {
  readonly description: string;
  readonly dynamic: Dynamic;
  readonly content?: string;
  readonly command?: { readonly name: string };
  readonly imports: readonly AnyContextRef[];
  readonly fns: readonly AnyFnRef[];
  readonly suggestFns: readonly AnyFnRef[];
  /** Who it may be suggested to. Default `both`. */
  readonly suggest: Audience;
  /** Who can find it in searches. Default `both`. */
  readonly visible: Audience;
  /** Always loaded for these agents. */
  readonly alwaysFor: readonly AnyFnRef[];
  readonly tags: readonly string[];
  readonly [phantom]?: A;
}

/** What `context()` takes. */
export interface ContextInput<Args extends Record<string, ArgDef<boolean>>> {
  description: string;
  /** Makes it a `/name` command. Args are filled into `{{name}}` in the content (or passed to a dynamic impl). */
  command?: { name: string; args?: Args };
  imports?: AnyContextRef[];
  fns?: AnyFnRef[];
  suggestFns?: AnyFnRef[];
  suggest?: Audience;
  visible?: Audience;
  alwaysFor?: AnyFnRef[];
  tags?: string[];
}

/** Declare static context. */
export declare function context<const Args extends Record<string, ArgDef<boolean>> = {}>(def: ContextInput<Args> & { content: string }): ContextDef<ArgsOf<Args>, false>;
/** Declare dynamic context: the server implements it. */
export declare function context<const Args extends Record<string, ArgDef<boolean>> = {}>(def: ContextInput<Args>): ContextDef<ArgsOf<Args>, true>;

export type AnyContextDef = ContextDef<unknown, boolean>;

/** A dynamic context's implementation: its content for these args. */
export type ContextImpl<A> = (args: A, ctx: StationCtx & { session?: SessionId; actor: ActorId }) => Promise<string>;

// ═══ Settings and attachments ═══

/**
 * A typed control admins (or fns) attach to actors: a database station's access rules per group, a quota per user.
 * A run reads the effective value with `ctx.setting(ref)`.
 */
export interface SettingDef<T> {
  readonly description: string;
  readonly type: GinType<T>;
  readonly appliesTo: readonly ActorKind[];
  /** How a user's value combines with their groups'. */
  readonly merge: 'user-wins' | 'union' | 'intersect' | 'most-restrictive';
  /** Besides admins, who may set it. */
  readonly editableBy: readonly ('self' | 'fns')[];
}

/** Declare an actor setting. */
export declare function setting<T>(def: { description: string; type: GinType<T>; appliesTo: ActorKind[]; merge: SettingDef<T>['merge']; editableBy?: ('self' | 'fns')[] }): SettingDef<T>;

/** A kind of attachment a station's fns add to assistant messages, drawn by its client renderer. */
export interface AttachmentDef<T> {
  readonly description: string;
  readonly data: GinType<T>;
}

/** Declare an attachment kind. */
export declare function attachment<T>(def: { description: string; data: GinType<T> }): AttachmentDef<T>;

// ═══ Hooks, mentions, embedders, sectioners ═══

/** A user-message hook: adds information to a message before the LLM sees it. */
export interface HookDef {
  readonly description: string;
  /** Lower runs first. */
  readonly order: number;
  /** After this the message goes on without it. */
  readonly timeout: Duration;
}

/** Declare a hook. */
export declare function hook(def: { description: string; order?: number; timeout?: Duration }): HookDef;

/** What a hook sees. */
export interface HookInput {
  readonly session: SessionId;
  readonly turn: TurnId;
  readonly author: ActorId;
  readonly text: string;
  /** What the browser reported. */
  readonly client: { localTime: string; timeZone: string; locale: string };
}

/** What a hook adds. Each becomes a tagged block the LLM can tell apart from the user's words. */
export type HookContribution =
  | { type: 'text'; tag: string; text: string }
  | { type: 'suggest-context'; items: Array<{ context: AnyContextRef; why?: string }> }
  | { type: 'suggest-fns'; items: Array<{ fn: AnyFnRef; why?: string }> }
  /** Load these now. */
  | { type: 'load'; context?: AnyContextRef[]; fns?: AnyFnRef[] };

/** A hook's implementation. */
export type HookImpl = (input: HookInput, ctx: StationCtx) => Promise<HookContribution[]>;

/** An `@` mention provider. */
export interface MentionDef {
  readonly title: string;
  readonly description: string;
}

/** Declare a mention provider. */
export declare function mention(def: { title: string; description: string }): MentionDef;

/** One `@` result. */
export interface MentionOption {
  label: string;
  description?: string;
  /** What it points at. */
  target: { resource: ResourceUri } | { context: AnyContextRef } | { fn: AnyFnRef } | { actor: ActorId } | { custom: Json };
  /** The text the LLM sees in place of the mention. */
  text: string;
}

/** A mention provider's implementation. */
export type MentionImpl = (query: string, ctx: StationCtx & { session: SessionId; actor: ActorId }) => Promise<MentionOption[]>;

/** An embed function the hub can index with. */
export interface EmbedderDef {
  readonly dimensions: number;
  /** Most characters per text. */
  readonly maxInput: number;
  readonly pricePerMillionTokens: Usd;
}

/** Declare an embedder. */
export declare function embedder(def: EmbedderDef): EmbedderDef;

/** An embedder's implementation. */
export type EmbedderImpl = (texts: string[]) => Promise<number[][]>;

/** Which resources a sectioner is for. */
export interface SectionMatch {
  format?: string;
  mime?: string;
  /** Glob over the URI. */
  glob?: string;
}

/** A way of cutting resources into sections, offered to users as a choice for matching resources. */
export interface SectionerDef {
  readonly description: string;
  readonly match: SectionMatch;
}

/** Declare a sectioner. */
export declare function sectioner(def: { description: string; match: SectionMatch }): SectionerDef;

/** A sectioner's implementation. Keys must come from structure (`sectionKey(path)`), never from position. */
export type SectionerImpl = (text: string, stat: ResourceStat) => Promise<Section[]>;

/** Make a section key from an outline path; duplicates get `~2`, `~3`. */
export declare function sectionKey(path: string[]): SectionKey;

// ═══ Resources ═══

/** An absolute URI. A station serves the URIs under its roots. */
export type ResourceUri = `${string}://${string}`;

/** A stable section key, made from structure so it survives content moving. */
export type SectionKey = string & { readonly [brand]: 'SectionKey' };

/** A place a station offers resources from, initially a folder. */
export interface ResourceRoot {
  uri: ResourceUri;
  name: string;
  description: string;
  /** Index everything, only what gets opened, or nothing. */
  index: 'all' | 'on-read' | 'none';
  /** Globs to leave out. */
  ignore: string[];
  watch: boolean;
}

/** What is known about a resource without reading it. Folders, files and pages are all resources. */
export interface ResourceStat {
  uri: ResourceUri;
  name: string;
  type: 'folder' | 'file' | 'page' | 'record' | 'other';
  mime?: string;
  /** Used to pick a sectioner and a renderer: `markdown`, `typescript`, `pdf`. */
  format?: string;
  size?: number;
  modifiedAt?: Timestamp;
  /** Changes whenever the content does. */
  version: string;
}

/** A link between resources: a folder's child, a code import, a page link. */
export interface ResourceLink {
  /** Absolute, when the station could resolve it. */
  uri?: ResourceUri;
  /** As written: `./foo`, `react`. */
  raw: string;
  kind: 'child' | 'import' | 'link' | 'embed' | 'external';
  title?: string;
}

/** What the hub asks for when reading. */
export type ReadWant = 'links' | 'text' | 'bytes';

/** A read. A station may include more than was asked for if it had it anyway. */
export interface ResourceRead {
  stat: ResourceStat;
  links?: ResourceLink[];
  /** Converted text (markdown for documents). Small text is inline; large text goes by ref. */
  text?: { inline: string } | { ref: ContentRef };
  bytes?: ContentRef;
}

/** Content moved by reference, fetched in chunks when needed. Keeps every message small. */
export interface ContentRef {
  /** sha-256 of the bytes. */
  hash: string;
  size: number;
  mime: string;
}

/** A stable piece of a resource. */
export interface Section {
  key: SectionKey;
  /** Its place in the outline. */
  path: string[];
  title: string;
  /** Character offsets in the text at this version. */
  start: number;
  end: number;
  /** What gets embedded: the text plus its headings and the resource name. Default: built for you. */
  embedText?: string;
}

/** A change seen by a watch. */
export interface ResourceChange {
  uri: ResourceUri;
  change: 'added' | 'changed' | 'removed';
  version?: string;
}

/** How a station serves resources. Built on `@aeye/resources` parsers where they fit. */
export interface ResourceProvider {
  roots(): Promise<ResourceRoot[]>;
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead>;
  /** Report changes until the returned function is called. */
  watch?(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void;
}

// ═══ Declaring a station ═══

/** Everything a contract can hold, by section. */
export interface ContractShape {
  types: Record<string, GinType<unknown>>;
  settings: Record<string, SettingDef<unknown>>;
  attachments: Record<string, AttachmentDef<unknown>>;
  kinds: Record<string, KindDef<unknown>>;
  fns: Record<string, AnyFnDef>;
  context: Record<string, AnyContextDef>;
  hooks: Record<string, HookDef>;
  mentions: Record<string, MentionDef>;
  embedders: Record<string, EmbedderDef>;
  sectioners: Record<string, SectionerDef>;
}

/** A contract with nothing in it yet. */
export interface EmptyContract {
  types: {}; settings: {}; attachments: {}; kinds: {}; fns: {}; context: {}; hooks: {}; mentions: {}; embedders: {}; sectioners: {};
}

/** A contract with more sections merged in. */
type Merge<C extends ContractShape, P extends Partial<ContractShape>> = {
  [K in keyof ContractShape]: Simplify<C[K] & (K extends keyof P ? NonNullable<P[K]> : {})>;
};
type Q<N extends string, K> = QualifiedName<N, K & string>;

/** The typed refs of everything in a contract. */
export interface StationRefs<N extends string, C extends ContractShape> {
  readonly name: N;
  readonly types: { readonly [K in keyof C['types']]: TypeRef<Q<N, K>, Infer<C['types'][K]>> };
  readonly settings: { readonly [K in keyof C['settings']]: C['settings'][K] extends SettingDef<infer T> ? SettingRef<Q<N, K>, T> : never };
  readonly attachments: { readonly [K in keyof C['attachments']]: C['attachments'][K] extends AttachmentDef<infer T> ? AttachmentRef<Q<N, K>, T> : never };
  readonly kinds: { readonly [K in keyof C['kinds']]: C['kinds'][K] extends KindDef<infer P> ? KindRef<Q<N, K>, P> : never };
  readonly fns: { readonly [K in keyof C['fns']]: C['fns'][K] extends FnDef<infer T> ? FnRef<Q<N, K>, T['args'], T['result'], T['handlers']> : never };
  readonly context: { readonly [K in keyof C['context']]: C['context'][K] extends ContextDef<infer A, boolean> ? ContextRef<Q<N, K>, A> : never };
  readonly hooks: { readonly [K in keyof C['hooks']]: HookRef<Q<N, K>> };
  readonly mentions: { readonly [K in keyof C['mentions']]: MentionRef<Q<N, K>> };
  readonly embedders: { readonly [K in keyof C['embedders']]: EmbedderRef<Q<N, K>> };
  readonly sectioners: { readonly [K in keyof C['sectioners']]: SectionerRef<Q<N, K>> };
}

/**
 * A station's contract, in `shared/`: its name and everything it offers, with no implementation. Safe to import
 * from anywhere. Built with `with`, any number of times; each call can use the refs from the calls before it, so a
 * fn can depend on a fn declared earlier and context can bring along the station's own fns.
 *
 * ```ts
 * export const fs = station('fs', { description: 'Files and a shell.' })
 *   .with({ types: { Entry }, fns: { read: fn({...}), grep: fn({...}) } })
 *   .with(({ fns }) => ({ context: { guide: context({ description: '…', content: '…', fns: [fns.read, fns.grep] }) } }));
 * ```
 */
export interface StationContract<N extends string, C extends ContractShape> extends StationRefs<N, C> {
  readonly description: string;
  /** The declarations themselves. */
  readonly defs: C;
  /** Add declarations: any sections, given directly or built from the refs so far. */
  with<const P extends Partial<ContractShape>>(part: P | ((self: StationRefs<N, C>) => P)): StationContract<N, Merge<C, P>>;
}

/** Start a contract. The name must be unique among the hub's stations: lowercase letters, digits and dashes. */
export declare function station<const N extends string>(name: N, info: { description: string }): StationContract<N, EmptyContract>;

export type AnyContract = StationContract<string, ContractShape>;

// ═══ Implementing a station ═══

type SystemFnKeys<F> = { [K in keyof F]: F[K] extends FnDef<infer T> ? (T['kind'] extends 'system' ? K : never) : never }[keyof F];
type DynamicContextKeys<X> = { [K in keyof X]: X[K] extends ContextDef<unknown, true> ? K : never }[keyof X];

/** A section of the implementation: required when the contract declares something there, forbidden when it doesn't. */
type Needs<K extends string, T> = [keyof T] extends [never] ? { readonly [P in K]?: never } : { readonly [P in K]: T };

/**
 * A station's implementation, computed from its contract. It must implement exactly what the contract declares:
 * every system fn, every kind, every dynamic context, hook, mention provider, embedder and sectioner.
 */
export type StationImpl<C extends ContractShape> =
  Needs<'fns', { readonly [K in SystemFnKeys<C['fns']>]: FnImpl<TypesOf<C['fns'][K]>> }> &
  Needs<'kinds', { readonly [K in keyof C['kinds']]: C['kinds'][K] extends KindDef<infer P> ? KindImpl<P> : never }> &
  Needs<'context', { readonly [K in DynamicContextKeys<C['context']>]: C['context'][K] extends ContextDef<infer A, true> ? ContextImpl<A> : never }> &
  Needs<'hooks', { readonly [K in keyof C['hooks']]: HookImpl }> &
  Needs<'mentions', { readonly [K in keyof C['mentions']]: MentionImpl }> &
  Needs<'embedders', { readonly [K in keyof C['embedders']]: EmbedderImpl }> &
  Needs<'sectioners', { readonly [K in keyof C['sectioners']]: SectionerImpl }> &
  {
    /** Resources this station serves. */
    readonly resources?: ResourceProvider;
    /** Hub events to receive. Subscriptions follow the handlers given. */
    readonly events?: { readonly [E in StationEvent['type']]?: (event: Extract<StationEvent, { type: E }>, ctx: StationCtx) => Promise<void> };
  };

/** What hooks, mentions, dynamic context and event handlers get. */
export interface StationCtx {
  readonly station: string;
  readonly llm: Llm;
  readonly resources: Resources;
  readonly log: Log;
  readonly signal: AbortSignal;
}

/** How a station process connects. */
export interface ServeOptions {
  /** The hub's WebSocket URL. */
  hub: string;
  /** Where the station keeps its key pair. */
  state: string;
  /** A one-time pairing token, if an admin made one. Otherwise the station prints a pairing code. */
  pairingToken?: string;
  /** The built client assets, if the station has renderers. */
  client?: string;
  /** Also serve the station as an MCP server. */
  mcp?: { stdio: true } | { http: { port: number } };
}

/**
 * Run a station: connect to the hub (pairing the first time), send the contract, and serve the implementation.
 * The implementation is checked against the contract at compile time.
 */
export declare function serve<N extends string, C extends ContractShape>(
  contract: StationContract<N, C>,
  impl: StationImpl<C>,
  options: ServeOptions,
): Promise<RunningStation<N>>;

/** A running station. */
export interface RunningStation<N extends string> {
  readonly name: N;
  readonly status: 'pairing' | 'connected' | 'disconnected';
  /** Resolves once connected and the contract is imported. */
  ready(): Promise<void>;
  /** Add a system fn at runtime. Returns its ref. */
  add<const K extends string, T extends FnTypes & { kind: 'system' }>(name: K, def: FnDef<T>, impl: FnImpl<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  /** Add a fn of some kind at runtime (no implementation: its kind runs it). */
  add<const K extends string, T extends FnTypes>(name: K, def: FnDef<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  /** Remove a fn added at runtime. */
  remove(fn: AnyFnRef): Promise<void>;
  /** Restart the process. It reconnects and the hub imports what changed. */
  restart(reason: string): Promise<never>;
  stop(): Promise<void>;
}

// ═══ Station events ═══

/** A message as stations see it. */
export interface MessageView {
  id: MessageId;
  session: SessionId;
  author: ActorId;
  role: 'user' | 'assistant' | 'note';
  text: string;
  createdAt: Timestamp;
}

/** Hub events a station can subscribe to. */
export type StationEvent =
  | { type: 'message'; message: MessageView }
  | { type: 'run'; run: RunId; fn: QualifiedName; update: RunUpdate }
  | { type: 'resources'; changes: ResourceChange[] }
  | { type: 'station'; station: string; status: 'connected' | 'disconnected' | 'removed' }
  | { type: 'fns'; added: QualifiedName[]; removed: QualifiedName[] };

// ═══ Client renderers ═══

/** A renderer: draw into `el` and return a cleanup. Any UI library works. */
export type Mount<P> = (el: HTMLElement, props: P) => (() => void) | void;

/** What a fn renderer gets: the run's typed args, result and progress. */
export interface FnView<T extends FnTypes> {
  run: RunId;
  status: RunStatus;
  args: T['args'];
  result?: T['result'];
  error?: FnError;
  progress?: ProgressState<T['progress']>;
  /** Called with the new view whenever the run changes. */
  subscribe(listener: (view: FnView<T>) => void): () => void;
}

/** What an attachment renderer gets. */
export interface AttachmentView<T> {
  data: T;
  title: string;
}

/** What a custom input gets. */
export interface InputView<T> {
  value: T | undefined;
  onChange(value: T): void;
  /** Problems with the current value. */
  problems: string[];
}

/** What a resource renderer gets. */
export interface ResourceView {
  stat: ResourceStat;
  section?: SectionKey;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/** A station's renderers, typed by its contract. */
export interface ClientRenderers<C extends ContractShape> {
  /** How calls of a fn are drawn in the chat. */
  fns?: { readonly [K in keyof C['fns']]?: Mount<FnView<TypesOf<C['fns'][K]>>> };
  /** How a fn of a kind is drawn when the fn has no renderer of its own. */
  kinds?: { readonly [K in keyof C['kinds']]?: Mount<FnView<UntypedFn>> };
  attachments?: { readonly [K in keyof C['attachments']]?: Mount<AttachmentView<Infer<C['attachments'][K]['data']>>> };
  /** Inputs for the station's named types (used in `!` forms and handler prompts). */
  inputs?: { readonly [K in keyof C['types']]?: Mount<InputView<Infer<C['types'][K]>>> };
  /** Previews for resource formats. */
  resources?: Record<string, Mount<ResourceView>>;
}

/** A built client module. The chat UI loads it from the hub. */
export interface ClientModule {
  readonly station: string;
}

/** Declare a station's renderers in `client/`. */
export declare function client<N extends string, C extends ContractShape>(contract: StationContract<N, C>, renderers: ClientRenderers<C>): ClientModule;

// ═══ The hub's contract ═══

/** The types of a hub system fn. */
type HubFn<A, R> = FnDef<SystemFnTypes<A, R, {}, {}, NoProgress, never, never>>;

/**
 * The hub is a station too, built with the same SDK. Its contract is exported so other stations can depend on its
 * fns, use its `llm` kind, and refer to its hooks and sectioners.
 */
export interface HubContract extends EmptyContract {
  kinds: { llm: KindDef<LlmPayload> };
  fns: {
    search_fns: HubFn<{ query: string; limit?: number }, Array<{ fn: QualifiedName; description: string; available: boolean }>>;
    load_fns: HubFn<{ fns: QualifiedName[] }, { loaded: QualifiedName[]; refused: Array<{ fn: QualifiedName; reason: string }> }>;
    drop_fns: HubFn<{ fns: QualifiedName[] }, { dropped: QualifiedName[] }>;
    search_context: HubFn<{ query: string; limit?: number }, Array<{ context: QualifiedName; description: string }>>;
    load_context: HubFn<{ context: QualifiedName[] }, { loaded: QualifiedName[] }>;
    search_resources: HubFn<{ query: string; roots?: ResourceUri[]; limit?: number }, Array<{ uri: ResourceUri; section?: SectionKey; title: string; preview: string }>>;
    run_status: HubFn<{ run: RunId }, { status: RunStatus; progress?: Json; result?: Json; error?: FnError }>;
    run_wait: HubFn<{ run: RunId; timeout?: Duration }, { status: RunStatus; result?: Json; error?: FnError }>;
    ask_user: HubFn<{ question: string; user?: ActorId }, { answer: string }>;
  };
  hooks: { local_time: HookDef; suggest_context: HookDef; suggest_fns: HookDef };
  mentions: { fns: MentionDef; context: MentionDef; resources: MentionDef; people: MentionDef };
  sectioners: { whole: SectionerDef; headings: SectionerDef; symbols: SectionerDef; pages: SectionerDef; paragraphs: SectionerDef };
}

/** The hub's contract. */
export declare const hub: StationContract<'hub', HubContract>;
