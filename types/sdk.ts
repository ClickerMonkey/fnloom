// # System SDK
// Everything a system author touches: the contract they declare in `shared/`, the implementation they write in
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
// Library types in this file: gin's wire `TypeDef` (what a gin type is on the wire) and Vue's `Component` (renderers
// are Vue components, like the chat UI).

import type { TypeDef as GinWireType } from '@aeye/gin';
import type { Component } from 'vue';

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

/** A name qualified by its system: `fs/read`, `hub/search_fns`, `fs/FileInfo`. */
export type QualifiedName<S extends string = string, N extends string = string> = `${S}/${N}`;

/** How urgent queued work is. */
export type Priority = 'urgent' | 'interactive' | 'normal' | 'background';

/** Who can see a thing: people in the UI, the LLM, both, or neither. */
export type Audience = 'user' | 'llm' | 'both' | 'none';

/** What kind of thing an actor is. */
export type ActorKind = 'user' | 'group' | 'agent' | 'system';

/**
 * The person a turn is for, as every system sees them. Built by the hub from the signed-in user; time zone and
 * locale come from their browser when it reports them.
 */
export interface UserInfo {
  readonly id: ActorId;
  readonly name: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly groups: ReadonlyArray<{ id: ActorId; name: string }>;
  readonly timeZone: string;
  readonly locale: string;
}

/** The current time for the person, so a system never guesses at "today". */
export interface TimeInfo {
  /** Now, as a timestamp. */
  readonly now: Timestamp;
  /** The person's time zone (IANA, `America/New_York`). */
  readonly timeZone: string;
  /** Now in the person's zone, with its offset: `2026-11-07T09:30:00-05:00`. */
  readonly local: string;
}

/** Which system something is running in, and which system asked for it. */
export interface SystemInfo {
  /** This system's name. */
  readonly name: string;
  /** This process (new on every start). */
  readonly instance: string;
  /** When another system's fn made the call: that system, fn and run. */
  readonly from?: { readonly system: string; readonly fn: QualifiedName; readonly run: RunId };
}

/** A page of results with a cursor for the next page. */
export interface Page<T> {
  items: T[];
  /** Absent on the last page. */
  cursor?: string;
}

// ═══ Gin types ═══

/** A gin type in its JSON wire form. This is how types travel to the hub and are stored. */
export type GinTypeDef = GinWireType;

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
 * A typed handle to a fn. Exported from a system's contract (`fs.fns.read`); used to declare a dep and to call
 * the fn with checked args, result and handlers.
 */
export interface FnRef<N extends QualifiedName, A, R, H extends Handlers = {}> {
  readonly name: N;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  readonly handlers: H;
}

/**
 * A typed handle to a named type (`fs.types.Entry`). It is a gin type itself, so it can be used as a field of other
 * types (`g.obj({ entry: fs.types.Entry })`). Its methods are typed fn refs that code can call with the value as
 * `self`.
 */
export interface TypeRef<N extends QualifiedName, T, M extends Methods = {}> extends GinType<T> {
  readonly name: N;
  readonly display: TypeDisplay;
  readonly methods: { readonly [K in keyof M]: M[K] extends FnDef<infer F> ? FnRef<MethodName<N, K>, MethodArgs<T, F['args']>, F['result'], F['handlers']> : never };
}

export type AnyTypeRef = TypeRef<QualifiedName, unknown, Methods>;

/** A method's qualified name: `fs/Entry.open`. */
export type MethodName<N extends QualifiedName, K> = `${N}.${K & string}` & QualifiedName;

/** The args of a method call: the value it is called on, as `self`, plus the method's own args. */
export type MethodArgs<T, A> = Simplify<{ self: T } & A>;

/** A typed handle to a fn kind. `kinds.api.fn({...})` declares a fn of that kind. */
export interface KindRef<N extends QualifiedName, P> {
  readonly name: N;
  readonly payload: GinType<P>;
  /**
   * Declare a fn of this kind. Only the payload is needed; the kind derives the rest. Give `args`/`returns` to type
   * the ref (the hub checks them against what the kind derives); without them the ref takes and returns `Json`.
   */
  fn<A = Json, R = Json>(def: KindFnInput<P, A, R>): FnDef<KindFnTypes<KindRef<N, P>, P, A, R>>;
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
/** A typed handle to an `@` mention provider. */
export interface MentionRef<N extends QualifiedName, T> { readonly name: N; readonly target: GinType<T> }
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
  /** `native` (implemented in code by its own system) or the ref of the kind that runs it. */
  kind: 'native' | AnyKindRef;
  /** The kind's payload; `undefined` for native fns. */
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
  /** The fields of its system's session state this fn reads and writes; `{}` when none. */
  state: object;
  /** What its renderer's form submits back to the run; `never` when it has no form. */
  form: unknown;
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
  readonly state?: GinType<T['state']>;
  readonly form?: GinType<T['form']>;
  /** How a run looks in the chat once it is done. */
  readonly display: Display;
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
export interface FnInput<A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U, St extends object, F> {
  description: string;
  /** Extra guidance the LLM sees when the fn is in its toolset. */
  instructions?: string;
  args: GinType<A>;
  returns: GinType<R>;
  /** Example calls, shown on the fn's card and in its invalid-input replies. Each example's args must fit `args`. */
  examples?: Array<{ args: A; note?: string }>;
  /** Fns the implementation may call. Nothing else can be called. */
  deps?: D;
  /** Callbacks the caller may supply. */
  handlers?: H;
  progress?: P;
  /** Declaring a resume type makes the fn pausable. */
  resume?: GinType<S>;
  /** Declaring an undo type makes the fn undoable, and requires an `undo` implementation. */
  undo?: GinType<U>;
  /**
   * The session state fields this fn uses: `g.obj({ cwd: g.text() })`. State is a scratch pad shared by the fns of
   * one system within one session, invisible to the LLM. A fn sees only the fields it declares, and a field is shared
   * only with fns that declare the same name with the same type.
   */
  state?: GinType<St>;
  /** Declaring a form type lets the run wait for its renderer to submit one (`await ctx.form()`). */
  form?: GinType<F>;
  /** Default `card`. */
  display?: Display;
  /** Defaults: cancel yes, background yes. Pause and undo follow `resume` and `undo`. */
  operations?: Partial<Pick<Operations, 'cancel' | 'background'>>;
  limits?: FnLimits;
  /** Default `both`. */
  visibility?: Audience;
  tags?: string[];
}

/** The types of a native fn. */
export interface NativeFnTypes<A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U, St extends object = {}, F = never> {
  kind: 'native'; payload: undefined; args: A; result: R; deps: D; handlers: H; progress: P; resume: S; undo: U; state: St; form: F;
}

/** Declare a native fn: a fn its system implements in code. */
export declare function fn<A, R, const D extends Deps = {}, const H extends Handlers = {}, const P extends ProgressDef = NoProgress, S = never, U = never, St extends object = {}, F = never>(
  def: FnInput<A, R, D, H, P, S, U, St, F>,
): FnDef<NativeFnTypes<A, R, NoInfer<D>, NoInfer<H>, NoInfer<P>, NoInfer<S>, NoInfer<U>, NoInfer<St>, NoInfer<F>>>;

/**
 * How a run looks in the chat once it is done. While it runs, its renderer (or the default card) shows.
 * - `card`: its renderer stays, live.
 * - `message`: its result is shown as a message (text results read like the agent wrote them).
 * - `hidden`: it disappears; the run is still in the tree.
 */
export type Display = 'card' | 'message' | 'hidden';

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
  /** The input was refused: retryable, fed back to the agent, shown softly as "Retried". Made with `ctx.invalid(problems)`. */
  | { status: 'invalid-input'; invalid: InvalidInput; cost?: Usd }
  | { status: 'failed'; error: FnError; undo?: T['undo']; cost?: Usd }
  | { status: 'cancelled'; partial?: T['result']; undo?: T['undo']; cost?: Usd };

/** The result of undoing a run. */
export type UndoOutcome =
  | { status: 'undone'; summary: string }
  | { status: 'failed'; error: FnError }
  /** Nothing left to undo. */
  | { status: 'gone' };

/** The implementation of a native fn. `undo` is required exactly when the fn declares an undo type. */
export type FnImpl<T extends FnTypes, Cfg = unknown> =
  { run(args: T['args'], ctx: FnCtx<T, Cfg>): Promise<Outcome<T>> } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx<Cfg>): Promise<UndoOutcome> });

/**
 * What a run gets besides its args. Typed by its fn: only its deps can be called, only its handlers exist, only
 * its progress steps can be reported, and the outcome helpers take its result, undo and resume types.
 */
export interface FnCtx<T extends FnTypes, Cfg = unknown> extends Services {
  /** The system's config, as it was when this run started. */
  readonly config: Cfg;
  /** Refuse the input (retryable, shown softly): the problems go back to the agent so it can call again. */
  invalid(problems: Array<{ path: string; message: string }>): Outcome<T>;
  /** Show the agent a fn with this result (`fs/search` exposing `fs/read` at `signature`): its card follows the reply. */
  expose(fn: AnyFnRef, detail: Detail): void;
  /** This instance's own folders: `data` (kept across upgrades, exported) and `cache` (rebuildable, never exported). */
  readonly dataDir: string;
  readonly cacheDir: string;
  /** Which instance of a fleet this is (`main` for a system that runs one copy). */
  readonly instance: string;
  /** Which run this is, whom it acts for, and where it sits in the tree. */
  readonly run: RunInfo;
  /** What is left of the turn's money and time, for information. The hub enforces LLM spend itself. */
  readonly budget: BudgetInfo;
  /** Aborts on cancel or timeout. */
  readonly signal: AbortSignal;
  /** Call the fn's deps. */
  readonly fns: Callers<T['deps']>;
  /** The handlers the caller supplied. */
  readonly handlers: HandlersInRun<T['handlers']>;
  /** Report progress in the shape the fn declared. */
  readonly progress: ProgressReporter<T['progress']>;
  /** The session state fields this fn declared. */
  readonly state: SessionState<T['state']>;
  /** Wait for the run's renderer to submit its form. Only fns that declare a `form` type have it. */
  readonly form: [T['form']] extends [never] ? undefined : () => Promise<T['form']>;
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
export interface UndoCtx<Cfg = unknown> extends Services {
  readonly config: Cfg;
  readonly run: RunInfo;
  readonly signal: AbortSignal;
}

/** Facts about the current run: what it is, who it is for, when, and where it came from. */
export interface RunInfo {
  readonly id: RunId;
  readonly fn: QualifiedName;
  readonly parent?: RunId;
  readonly turn: TurnId;
  readonly session?: SessionId;
  /** The person the turn is for: permissions and settings are theirs. */
  readonly user: UserInfo;
  readonly time: TimeInfo;
  readonly system: SystemInfo;
  /** Who called: the agent, the user (with `!`), or the parent run's fn. */
  readonly caller: ActorId;
  readonly attempt: number;
  readonly priority: Priority;
}

/**
 * What is left of the budgets that apply to this turn, for information (to choose a cheaper path, or stop early).
 * The hub enforces LLM spend itself: `ctx.llm` calls that would go over are refused or wait.
 */
export interface BudgetInfo {
  /** The least that is left across every budget that applies (turn, session, user, groups). */
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
export type RunStatus = 'awaiting-approval' | 'queued' | 'running' | 'waiting' | 'paused' | 'done' | 'invalid-input' | 'failed' | 'cancelled' | 'undone';

// ═══ Services ═══

/** What every run, hook and handler gets from the hub. */
export interface Services {
  /** LLM calls through the hub, counted against the run's budget. */
  readonly llm: Llm;
  /** File operations, limited to what the system allows. */
  readonly files: Files;
  /** fetch, through the system's outbound rules. */
  readonly fetch: typeof fetch;
  /** Resources from any system the actor may see. */
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

/** LLM calls. They always go through the hub, which picks the model, enforces budgets and records them. */
export interface Llm {
  text(input: { prompt: string; system?: string; model?: ModelChoice }): Promise<string>;
  /** An answer checked against a gin type. */
  object<T>(input: { prompt: string; output: GinType<T>; system?: string; model?: ModelChoice }): Promise<T>;
  stream(input: { prompt: string; system?: string; model?: ModelChoice }): AsyncIterable<string>;
  embed(texts: string[]): Promise<number[][]>;
  /** Every other modality, through the hub provider (each a `ModelCall` on the run). */
  image(input: { prompt: string; model?: ModelChoice; size?: string; count?: number }): Promise<ContentRef[]>;
  transcribe(input: { audio: ContentRef; model?: ModelChoice; language?: string }): Promise<{ text: string; segments?: Array<{ start: number; end: number; text: string }> }>;
  speak(input: { text: string; model?: ModelChoice; voice?: string }): Promise<ContentRef>;
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

/** Reading resources. The hub routes each URI to the system that serves it. */
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

// ═══ Session state ═══

/**
 * A system's scratch pad for one session: data fns pass to each other without the LLM seeing it (the working
 * folder, the last query's rows, a selection). Each fn, action and renderer sees only the fields it declared,
 * matched by name and type. Changes are recorded on the run, so undoing a turn puts state back, and they reach
 * renderers live. Runs outside a session (a scheduled run) get state scoped to their turn.
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

// ═══ Actions ═══

/**
 * A typed message a system accepts from its renderers ("approve", "load more", "save these settings"). The hub
 * stores each one before delivering it, so nothing is lost while the system is offline; it is delivered, in
 * order, when the system connects. The sender gets a live delivery and, when handled, the typed result.
 */
export interface ActionDef<I, R, St extends object> {
  readonly description: string;
  readonly input: GinType<I>;
  readonly returns: GinType<R>;
  readonly state?: GinType<St>;
  /** Drop it if it can't be delivered within this long. Default: never. */
  readonly expires?: Duration;
}

/** Declare an action. */
export declare function action<I, R = undefined, St extends object = {}>(def: { description: string; input: GinType<I>; returns?: GinType<R>; state?: GinType<St>; expires?: Duration }): ActionDef<I, R, St>;

/** A typed handle to an action. */
export interface ActionRef<N extends QualifiedName, I, R> {
  readonly name: N;
  readonly input: GinType<I>;
  readonly returns: GinType<R>;
}

/** What an action's implementation gets. */
export interface ActionCtx<St extends object, Cfg = unknown> extends SystemCtx<Cfg>, Omit<Services, 'log' | 'llm' | 'resources'> {
  readonly session: SessionId;
  /** Who sent it. */
  readonly user: UserInfo;
  readonly time: TimeInfo;
  /** The run whose renderer sent it, if any. */
  readonly run?: RunId;
  readonly state: SessionState<St>;
}

/** An action's implementation. */
export type ActionImpl<I, R, St extends object, Cfg = unknown> = (input: I, ctx: ActionCtx<St, Cfg>) => Promise<R>;

/** A message on its way: stored by the hub, delivered when the system is online. Its status is live. */
export interface Delivery<R> {
  readonly id: Id<'delivery'>;
  readonly status: 'queued' | 'delivered' | 'done' | 'failed' | 'expired';
  /** Resolves when the system has handled it. */
  readonly result: Promise<R>;
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

/**
 * What `kinds.x.fn()` takes. Only the payload is required: everything else a fn has (signature, deps, types it
 * references, handlers, progress, operations, limits, display) is worked out by the kind's `describe`. An input
 * kind's payload might be just a gin type, giving a fn with no deps; a program kind works out every fn and type
 * its code references. `args`/`returns` are optional typing hints: when given, the hub checks them against what
 * the kind derived, and the ref is typed by them (otherwise it is typed by `Json`).
 */
export interface KindFnInput<P, A, R> {
  description: string;
  instructions?: string;
  payload: P;
  args?: GinType<A>;
  returns?: GinType<R>;
  visibility?: Audience;
  tags?: string[];
}

/** The types of a fn of some kind. Its deps, handlers and progress come from the kind at runtime. */
export interface KindFnTypes<K extends AnyKindRef, P, A, R> {
  kind: K; payload: P; args: A; result: R; deps: {}; handlers: {}; progress: NoProgress; resume: never; undo: never; state: {}; form: never;
}

/**
 * Everything a kind works out from one payload, so the author of a fn of that kind writes only the payload. The
 * hub stores this with the fn and recomputes it whenever the payload, or anything it references, changes.
 * Optional fields fall back to the kind's defaults (no handlers, no progress, the hub's limits, a card display).
 */
export interface KindDescription {
  args: GinTypeDef;
  returns: GinTypeDef;
  /** The fns a payload calls (a program's calls, an agent's tools). The hub refuses calls outside these. Empty for an input kind. */
  deps: QualifiedName[];
  /** The named types the payload references, so the hub can load them and re-describe when one changes. */
  types?: QualifiedName[];
  /** The resources or context the payload references. */
  refs?: string[];
  operations: Operations;
  handlers?: Record<string, { required: boolean; args: GinTypeDef; returns: GinTypeDef }>;
  progress?: ProgressDef;
  limits?: Partial<FnLimits>;
  display?: Display;
}

/**
 * A kind's implementation. The payload is typed; a fn's args and result aren't (they depend on the payload), so
 * they arrive as JSON the hub has already checked against `describe`'s types.
 */
export interface KindImpl<P, Cfg = unknown> {
  /** Problems with a payload beyond its type (an unknown fn, a program that doesn't type-check). */
  check(payload: P, ctx: KindCheckCtx): Promise<string[]>;
  describe(payload: P, ctx: KindCheckCtx): Promise<KindDescription>;
  run(payload: P, args: Json, ctx: KindRunCtx<Cfg>): Promise<Outcome<UntypedFn>>;
  undo?(payload: P, undo: Json, ctx: UndoCtx<Cfg>): Promise<UndoOutcome>;
}

/** What a kind can look up while checking a payload. */
export interface KindCheckCtx {
  type(name: QualifiedName): Promise<GinTypeDef | undefined>;
  fn(name: QualifiedName): Promise<{ args: GinTypeDef; returns: GinTypeDef; description: string } | undefined>;
}

/** The types of a fn known only at runtime. */
export interface UntypedFn {
  kind: AnyKindRef; payload: unknown; args: Json; result: Json; deps: {}; handlers: Handlers; progress: ProgressDef; resume: Json; undo: Json; state: Record<string, Json>; form: Json;
}

/** A kind's run context: like `FnCtx`, but calls are by name (limited to the deps `describe` returned). */
export interface KindRunCtx<Cfg = unknown> extends Omit<FnCtx<UntypedFn, Cfg>, 'fns' | 'handlers' | 'progress'> {
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
  canLoad: { fns?: QualifiedName[]; systems?: string[]; tags?: string[] } | 'none';
  maxTools: number;
  context: QualifiedName[];
  hooks: QualifiedName[];
  toolExecution: 'parallel' | 'sequential';
  maxIterations: number;
}

/** The types of an agent fn. */
export type AgentFnTypes<A, R> = KindFnTypes<KindRef<'hub/llm', LlmPayload>, LlmPayload, A, R>;

/**
 * Declare an agent: an LLM with instructions, tools and context, callable like any fn. A system can ship its
 * own agents (a code reviewer, a planner) with tools from any system.
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
  canLoad?: { fns?: AnyFnRef[]; systems?: string[]; tags?: string[] } | 'none';
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
 * the system when loaded, so the server must implement it. Context can bring other context and fns along: with
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
  /** How much it counts when the graph contextor scores it (0 leaves it out; 1 when absent). */
  weight?: number;
  /** A short form shown at `signature` detail; its description when absent. */
  summary?: string;
  /** Its parent in a hierarchy, and the next piece of a chain. */
  parent?: AnyContextRef;
  next?: AnyContextRef;
  /** Weighted links to other context, fns, types and resources. */
  links?: DeclaredLink[];
}

/** Declare static context. */
export declare function context<const Args extends Record<string, ArgDef<boolean>> = {}>(def: ContextInput<Args> & { content: string }): ContextDef<ArgsOf<Args>, false>;
/** Declare dynamic context: the server implements it. */
export declare function context<const Args extends Record<string, ArgDef<boolean>> = {}>(def: ContextInput<Args>): ContextDef<ArgsOf<Args>, true>;

export type AnyContextDef = ContextDef<unknown, boolean>;

/** A dynamic context's implementation: its content for these args. */
export type ContextImpl<A, Cfg = unknown> = (args: A, ctx: SystemCtx<Cfg> & { readonly session?: SessionId; readonly user: UserInfo; readonly time: TimeInfo }) => Promise<string>;

// ═══ Types ═══

/** A type's methods by name. Each is declared with `fn()` and implemented with the value it is called on. */
export type Methods = Record<string, AnyFnDef>;

/** How values of a type are shown: in mention chips, hover cards, inputs and (later) widgets. */
export interface TypeDisplay {
  /** The type's name for people: "Customer". */
  readonly label: string;
  readonly plural?: string;
  /** An icon name or URL. */
  readonly icon?: string;
  /** A CSS color. */
  readonly color?: string;
  /** The field whose value names a value ("Acme Corp"). */
  readonly title?: string;
  /** The field shown under it. */
  readonly subtitle?: string;
}

/** Fields of T that can name a value. */
type NamingKeys<T> = { [K in keyof T]-?: T[K] extends string | number | undefined ? K : never }[keyof T] & string;

/** A named type in a contract: its shape, how it is shown, and its methods. */
export interface TypeDef<T, M extends Methods> {
  readonly description: string;
  readonly shape: GinType<T>;
  readonly display: TypeDisplay;
  readonly methods: M;
  readonly [phantom]?: T;
}

/**
 * Declare a named type. Methods are native fns called on a value of the type: the person can run them from a
 * mention's card (or a widget), and code can call them through the type's ref. They are offered to the LLM only
 * when their `visibility` says so.
 *
 * ```ts
 * Customer: type({
 *   description: 'A customer account.',
 *   shape: g.obj({ id: g.text(), name: g.text(), plan: g.enum('free', 'pro') }),
 *   display: { label: 'Customer', icon: 'building', color: '#2f6fde', title: 'name', subtitle: 'plan' },
 *   methods: { upgrade: fn({ description: 'Move to the pro plan.', args: g.obj({}), returns: g.bool() }) },
 * })
 * ```
 */
export declare function type<T, const M extends Methods = {}>(def: {
  description: string;
  shape: GinType<T>;
  display: Omit<TypeDisplay, 'title' | 'subtitle'> & { title?: NamingKeys<T>; subtitle?: NamingKeys<T> };
  methods?: M;
}): TypeDef<T, M>;

/** A method's implementation: a native fn that also gets the value it was called on. */
export type MethodImpl<V, T extends FnTypes, Cfg = unknown> =
  { run(self: V, args: T['args'], ctx: FnCtx<T, Cfg>): Promise<Outcome<T>> } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx<Cfg>): Promise<UndoOutcome> });

// ═══ Settings and attachments ═══

/**
 * A typed control admins (or fns) attach to actors: a database system's access rules per group, a quota per user.
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

/** A kind of attachment a system's fns add to assistant messages, drawn by its client renderer. */
export interface AttachmentDef<T> {
  readonly description: string;
  readonly data: GinType<T>;
}

/** Declare an attachment kind. */
export declare function attachment<T>(def: { description: string; data: GinType<T> }): AttachmentDef<T>;

// ═══ Hooks, mentions, embedders, sectioners ═══

/**
 * A system's user-message hook: adds information to a message before the LLM sees it (the git branch, the open
 * ticket). The hub also adds some things itself whenever it can, without any system: the person's local time and
 * suggested context and fns.
 */
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
  readonly text: string;
  readonly user: UserInfo;
  readonly time: TimeInfo;
}

/** What a hook adds. Each becomes a tagged block the LLM can tell apart from the user's words. */
export type HookContribution =
  | { type: 'text'; tag: string; text: string }
  | { type: 'suggest-context'; items: Array<{ context: AnyContextRef; why?: string }> }
  | { type: 'suggest-fns'; items: Array<{ fn: AnyFnRef; why?: string }> }
  /** Load these now. */
  | { type: 'load'; context?: AnyContextRef[]; fns?: AnyFnRef[] };

/** A hook's implementation. */
export type HookImpl<Cfg = unknown> = (input: HookInput, ctx: SystemCtx<Cfg>) => Promise<HookContribution[]>;

/**
 * An `@` mention provider: a way to point at something a system knows about, such as a file, a database row or a
 * ticket. Three views of the same thing:
 *
 * - **Chip:** the chat shows a friendly name.
 * - **Hover:** hovering the chip asks the system for details for the person.
 * - **LLM text:** when the message is sent, the system writes text for the LLM that says exactly what the thing
 *   is and where it lives. It is embedded in the user message and kept with it.
 *
 * `target` is the system's own key for a thing (a path; a table and an id). It is what gets stored.
 */
export interface MentionDef<T, V> {
  readonly title: string;
  readonly description: string;
  readonly target: GinType<T>;
  /**
   * The type of the things it points at, if the system declares one. The chip and the hover card then use the
   * type's label, icon and color, and the card offers the type's methods the person may run.
   */
  readonly of?: TypeRef<QualifiedName, V, Methods>;
}

/** Declare a mention provider. */
export declare function mention<T, V = never>(def: { title: string; description: string; target: GinType<T>; of?: TypeRef<QualifiedName, V, Methods> }): MentionDef<T, V>;

/** One search result in the `@` picker. */
export interface MentionOption<T> {
  /** The friendly name: what the chip shows. */
  label: string;
  /** A short line under the label in the picker ("customers · Acme Corp"). */
  hint?: string;
  /** An icon name or URL. */
  icon?: string;
  target: T;
}

/** What a person sees when hovering a mention. */
export interface MentionHover {
  title: string;
  subtitle?: string;
  fields?: Array<{ label: string; value: string }>;
  /** A short preview, in markdown. */
  body?: string;
  /** Where clicking the chip goes. */
  open?: Link;
}

/** What a mention provider's implementation gets. */
export interface MentionCtx<Cfg = unknown> extends SystemCtx<Cfg> {
  readonly session: SessionId;
  /** The person mentioning; results and details are limited to what they may see. */
  readonly user: UserInfo;
  readonly time: TimeInfo;
}

/** A mention provider's implementation. */
export interface MentionImpl<T, V, Cfg = unknown> {
  /** Results for what the person typed after `@`. */
  search(query: string, ctx: MentionCtx<Cfg>): Promise<MentionOption<T>[]>;
  /** The hover card. Asked for when hovered, so it is current; `undefined` when the thing no longer exists. */
  hover(target: T, ctx: MentionCtx<Cfg>): Promise<(MentionHover & { /** The thing itself, as its declared type, so the card can offer its methods. */ value?: V }) | undefined>;
  /**
   * The text the LLM gets for this mention, written when the message is sent: what the thing is, where it lives
   * and how to reach it with this system's fns (system, kind, id or path, a few key facts). The hub wraps it in a
   * tagged block with the label, so the model can match it to the words around it.
   */
  llm(target: T, ctx: MentionCtx<Cfg>): Promise<string>;
}

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

/** An absolute URI. A system serves the URIs under its roots. */
export type ResourceUri = `${string}://${string}`;

/** A stable section key, made from structure so it survives content moving. */
export type SectionKey = string & { readonly [brand]: 'SectionKey' };

/** A place a system offers resources from, initially a folder. */
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
  /** Absolute, when the system could resolve it. */
  uri?: ResourceUri;
  /** As written: `./foo`, `react`. */
  raw: string;
  kind: 'child' | 'import' | 'link' | 'embed' | 'external';
  title?: string;
}

/** What the hub asks for when reading. */
export type ReadWant = 'links' | 'text' | 'bytes';

/** A read. A system may include more than was asked for if it had it anyway. */
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

/** How a system serves resources. Built on `@aeye/resources` parsers where they fit. */
export interface ResourceProvider {
  roots(): Promise<ResourceRoot[]>;
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead>;
  /** Report changes until the returned function is called. */
  watch?(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void;
}

// ═══ Declaring a system ═══

/** Everything a contract can hold, by section. */
export interface ContractShape {
  /** What the system needs before it can be used; see `ConfigOf`. */
  config: GinType<object>;
  types: Record<string, TypeDef<unknown, Methods>>;
  settings: Record<string, SettingDef<unknown>>;
  attachments: Record<string, AttachmentDef<unknown>>;
  kinds: Record<string, KindDef<unknown>>;
  fns: Record<string, AnyFnDef>;
  context: Record<string, AnyContextDef>;
  hooks: Record<string, HookDef>;
  mentions: Record<string, MentionDef<unknown, unknown>>;
  embedders: Record<string, EmbedderDef>;
  sectioners: Record<string, SectionerDef>;
  actions: Record<string, ActionDef<unknown, unknown, object>>;
}

/** A contract with nothing in it yet. */
export interface EmptyContract {
  config: GinType<{}>;
  types: {}; settings: {}; attachments: {}; kinds: {}; fns: {}; context: {}; hooks: {}; mentions: {}; embedders: {}; sectioners: {}; actions: {};
}

/** A contract with more sections merged in. */
type Merge<C extends ContractShape, P extends Partial<ContractShape>> = {
  // config is replaced, not merged; every other section adds to what was declared before
  [K in keyof ContractShape]: K extends 'config'
    ? (P extends { config: infer X extends GinType<object> } ? X : C['config'])
    : Simplify<C[K] & (K extends keyof P ? NonNullable<P[K]> : {})>;
};
type Q<N extends string, K> = QualifiedName<N, K & string>;

/** The typed refs of everything in a contract. */
export interface SystemRefs<N extends string, C extends ContractShape> {
  readonly name: N;
  readonly types: { readonly [K in keyof C['types']]: C['types'][K] extends TypeDef<infer T, infer M> ? TypeRef<Q<N, K>, T, M> : never };
  readonly settings: { readonly [K in keyof C['settings']]: C['settings'][K] extends SettingDef<infer T> ? SettingRef<Q<N, K>, T> : never };
  readonly attachments: { readonly [K in keyof C['attachments']]: C['attachments'][K] extends AttachmentDef<infer T> ? AttachmentRef<Q<N, K>, T> : never };
  readonly kinds: { readonly [K in keyof C['kinds']]: C['kinds'][K] extends KindDef<infer P> ? KindRef<Q<N, K>, P> : never };
  readonly fns: { readonly [K in keyof C['fns']]: C['fns'][K] extends FnDef<infer T> ? FnRef<Q<N, K>, T['args'], T['result'], T['handlers']> : never };
  readonly context: { readonly [K in keyof C['context']]: C['context'][K] extends ContextDef<infer A, boolean> ? ContextRef<Q<N, K>, A> : never };
  readonly hooks: { readonly [K in keyof C['hooks']]: HookRef<Q<N, K>> };
  readonly mentions: { readonly [K in keyof C['mentions']]: C['mentions'][K] extends MentionDef<infer T, unknown> ? MentionRef<Q<N, K>, T> : never };
  readonly embedders: { readonly [K in keyof C['embedders']]: EmbedderRef<Q<N, K>> };
  readonly sectioners: { readonly [K in keyof C['sectioners']]: SectionerRef<Q<N, K>> };
  readonly actions: { readonly [K in keyof C['actions']]: C['actions'][K] extends ActionDef<infer I, infer R, object> ? ActionRef<Q<N, K>, I, R> : never };
}

/**
 * A system's contract, in `shared/`: its name and everything it offers, with no implementation. Safe to import
 * from anywhere. Built with `with`, any number of times; each call can use the refs from the calls before it, so a
 * fn can depend on a fn declared earlier and context can bring along the system's own fns.
 *
 * ```ts
 * export const fs = system('fs', { description: 'Files and a shell.' })
 *   .with({ types: { Entry }, fns: { read: fn({...}), grep: fn({...}) } })
 *   .with(({ fns }) => ({ context: { guide: context({ description: '…', content: '…', fns: [fns.read, fns.grep] }) } }));
 * ```
 */
export interface SystemContract<N extends string, C extends ContractShape> extends SystemRefs<N, C> {
  readonly description: string;
  /** The declarations themselves. */
  readonly defs: C;
  /** Add declarations: any sections, given directly or built from the refs so far. */
  with<const P extends Partial<ContractShape>>(part: P | ((self: SystemRefs<N, C>) => P)): SystemContract<N, Merge<C, P>>;
}

/** Start a contract. The name must be unique among the hub's systems: lowercase letters, digits and dashes. */
export declare function system<const N extends string>(name: N, info: { description: string }): SystemContract<N, EmptyContract>;

export type AnyContract = SystemContract<string, ContractShape>;

// ═══ Implementing a system ═══

type NativeFnKeys<F> = { [K in keyof F]: F[K] extends FnDef<infer T> ? (T['kind'] extends 'native' ? K : never) : never }[keyof F];
type TypesWithMethods<X> = { [K in keyof X]: X[K] extends TypeDef<unknown, infer M> ? ([keyof M] extends [never] ? never : K) : never }[keyof X];
type DynamicContextKeys<X> = { [K in keyof X]: X[K] extends ContextDef<unknown, true> ? K : never }[keyof X];

/** A section of the implementation: required when the contract declares something there, forbidden when it doesn't. */
type Needs<K extends string, T> = [keyof T] extends [never] ? { readonly [P in K]?: never } : { readonly [P in K]: T };

/**
 * A system's implementation, computed from its contract. It must implement exactly what the contract declares:
 * every native fn, every method of its types, every kind, every dynamic context, hook, mention provider, embedder,
 * sectioner and action.
 */
export type SystemImpl<C extends ContractShape> =
  Needs<'fns', { readonly [K in NativeFnKeys<C['fns']>]: FnImpl<TypesOf<C['fns'][K]>, ConfigOf<C>> }> &
  Needs<'kinds', { readonly [K in keyof C['kinds']]: C['kinds'][K] extends KindDef<infer P> ? KindImpl<P, ConfigOf<C>> : never }> &
  Needs<'context', { readonly [K in DynamicContextKeys<C['context']>]: C['context'][K] extends ContextDef<infer A, true> ? ContextImpl<A, ConfigOf<C>> : never }> &
  Needs<'hooks', { readonly [K in keyof C['hooks']]: HookImpl<ConfigOf<C>> }> &
  Needs<'mentions', { readonly [K in keyof C['mentions']]: C['mentions'][K] extends MentionDef<infer T, infer V> ? MentionImpl<T, V, ConfigOf<C>> : never }> &
  Needs<'types', { readonly [K in TypesWithMethods<C['types']>]: C['types'][K] extends TypeDef<infer V, infer M extends Methods> ? { readonly [J in keyof M]: MethodImpl<V, TypesOf<M[J]>, ConfigOf<C>> } : never }> &
  Needs<'embedders', { readonly [K in keyof C['embedders']]: EmbedderImpl }> &
  Needs<'sectioners', { readonly [K in keyof C['sectioners']]: SectionerImpl }> &
  Needs<'actions', { readonly [K in keyof C['actions']]: C['actions'][K] extends ActionDef<infer I, infer R, infer St> ? ActionImpl<I, R, St, ConfigOf<C>> : never }> &
  {
    /** Resources this system serves. */
    readonly resources?: ResourceProvider;
    /** Hub events to receive. Subscriptions follow the handlers given. */
    readonly events?: { readonly [E in SystemEvent['type']]?: (event: Extract<SystemEvent, { type: E }>, ctx: SystemCtx<ConfigOf<C>>) => Promise<void> };
    /** Moments in the system's life. Each gets the system's context and its config. */
    readonly lifecycle?: Lifecycle<ConfigOf<C>>;
  };

/** What hooks, mentions, actions, dynamic context, events and lifecycle events get. */
export interface SystemCtx<Cfg = unknown> {
  readonly system: string;
  /** Which instance of a fleet this is (`main` for a system that runs one copy). */
  readonly instance: string;
  /** This instance's data folder (the hub's, outside the package; kept across upgrades, exported with the data). */
  readonly dataDir: string;
  /** This instance's cache folder (rebuildable; never exported). */
  readonly cacheDir: string;
  /** The system's current config. */
  readonly config: Cfg;
  readonly llm: Llm;
  readonly resources: Resources;
  readonly log: Log;
  readonly signal: AbortSignal;
}

/** How a system process connects. */
export interface ServeOptions {
  /** The hub's WebSocket URL. */
  hub: string;
  /** Where the system keeps its key pair. */
  state: string;
  /** A one-time pairing token, if an admin made one. Otherwise the system prints a pairing code. */
  pairingToken?: string;
  /** The built client assets, if the system has renderers. */
  client?: string;
  /** Also serve the system as an MCP server. */
  mcp?: { stdio: true } | { http: { port: number } };
}

/**
 * Run a system: connect to the hub (pairing the first time), send the contract, and serve the implementation.
 * The implementation is checked against the contract at compile time.
 */
export declare function serve<N extends string, C extends ContractShape>(
  contract: SystemContract<N, C>,
  impl: SystemImpl<C>,
  options: ServeOptions,
): Promise<RunningSystem<N>>;

/**
 * A system's config type: what it needs before it can be used (the folders to serve, a database URL, an API
 * key). An admin, or a person by asking in chat, sets a value in the hub, which checks it against this type. Until
 * a valid value is set, the system shows as needing config and its fns, mentions and hooks are unavailable. The
 * current value is in every context as `ctx.config`; a run keeps the value it started with.
 */
export type ConfigOf<C extends ContractShape> = Infer<C['config']>;

/**
 * Moments in a system's life. All are optional; each gets the system's context, with its current config.
 * `stopping` has a deadline: the hub waits for it (and for runs that can't be cancelled) up to its `timeout`.
 */
export interface Lifecycle<Cfg> {
  /** The first time it connects after being paired or installed (with a valid config). */
  installed?(ctx: SystemCtx<Cfg>): Promise<void>;
  /** Every time it connects with a valid config and its contract is imported. */
  started?(ctx: SystemCtx<Cfg>): Promise<void>;
  /**
   * Someone changed the config. `ctx.config` is the new value and `previous` the old one (undefined when there was
   * none); react if it matters (watch new folders, reconnect to a new database). Runs already going keep the value
   * they started with.
   */
  configured?(ctx: SystemCtx<Cfg> & { readonly previous: Cfg | undefined }): Promise<void>;
  /** Before it stops: a restart, an upgrade, the hub shutting down, or being removed. */
  stopping?(ctx: SystemCtx<Cfg> & { readonly reason: 'restart' | 'upgrade' | 'shutdown' | 'removed'; readonly timeout: Duration }): Promise<void>;
  /** The first start of a new version; `from` is the version it replaced. */
  upgraded?(ctx: SystemCtx<Cfg> & { readonly from: string }): Promise<void>;
  /** An admin removed it; clean up anything it keeps outside the hub. */
  uninstalled?(ctx: SystemCtx<Cfg>): Promise<void>;
}

/** A running system. */
export interface RunningSystem<N extends string> {
  readonly name: N;
  readonly status: 'pairing' | 'connected' | 'disconnected';
  /** Resolves once connected and the contract is imported. */
  ready(): Promise<void>;
  /** Add a native fn at runtime. Returns its ref. */
  add<const K extends string, T extends FnTypes & { kind: 'native' }>(name: K, def: FnDef<T>, impl: FnImpl<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  /** Add a fn of some kind at runtime (no implementation: its kind runs it). */
  add<const K extends string, T extends FnTypes>(name: K, def: FnDef<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  /** Remove a fn added at runtime. */
  remove(fn: AnyFnRef): Promise<void>;
  /** Restart the process. It reconnects and the hub imports what changed. */
  restart(reason: string): Promise<never>;
  stop(): Promise<void>;
}

// ═══ System events ═══

/** A message as systems see it. */
export interface MessageView {
  id: MessageId;
  session: SessionId;
  author: ActorId;
  role: 'user' | 'assistant' | 'note';
  text: string;
  replyTo?: MessageId;
  replyAll: boolean;
  createdAt: Timestamp;
}

/** Hub events a system can subscribe to. */
export type SystemEvent =
  | { type: 'message'; message: MessageView }
  | { type: 'run'; run: RunId; fn: QualifiedName; update: RunUpdate }
  | { type: 'resources'; changes: ResourceChange[] }
  | { type: 'system'; system: string; status: 'connected' | 'disconnected' | 'removed' }
  | { type: 'fns'; added: QualifiedName[]; removed: QualifiedName[] };

// ═══ Client renderers ═══

/**
 * A renderer is a Vue component; the chat UI is Vue too. Its props are a view typed by the contract, and they are
 * reactive: when the run, attachment or value changes, the component re-renders. A system's client build keeps
 * `vue` external, so renderers share the chat's Vue.
 */
export type Renderer<P> = Component<P>;

/** The props of a fn renderer: the run's typed args, result and progress. */
export interface FnView<T extends FnTypes> {
  run: RunId;
  status: RunStatus;
  args: T['args'];
  result?: T['result'];
  error?: FnError;
  progress?: ProgressState<T['progress']>;
  /** The fn's session state fields, live. Change them through an action. */
  state: Readonly<Partial<T['state']>>;
  /** Submit the fn's form to the waiting run. Only fns that declare a `form` type have it. */
  submit: [T['form']] extends [never] ? undefined : (value: T['form']) => Delivery<void>;
}

/** What every renderer gets to talk to its own system. */
export interface SystemClient<C extends ContractShape> {
  /** Whether the system is connected now. Actions sent while it is offline wait in the hub. */
  readonly online: boolean;
  /** Send an action: `system.send.approve({ id })`. */
  readonly send: { readonly [K in keyof C['actions']]: C['actions'][K] extends ActionDef<infer I, infer R, object> ? (input: I) => Delivery<R> : never };
}

/** The props every renderer of a system gets besides its view. */
export interface WithSystem<C extends ContractShape> {
  system: SystemClient<C>;
}

/** The props of an attachment renderer. */
export interface AttachmentView<T> {
  data: T;
  title: string;
}

/**
 * The props of a custom input. It works with `v-model`: read `modelValue` and emit `update:modelValue`
 * (in a `<script setup>`, `defineModel<T>()` does both).
 */
export interface InputView<T> {
  modelValue: T | undefined;
  /** Problems with the current value, from the type's checks. */
  problems: string[];
  /** Draw the value without editing it: the same component is the type's editor and its viewer. */
  readonly: boolean;
}

/** The props of a custom mention hover card. */
export interface MentionView<T> {
  label: string;
  target: T;
  /** How the mentioned type is shown, if the provider declares one. */
  type?: TypeDisplay;
  /** What the system's `hover` returned; `undefined` when the thing no longer exists. */
  hover: MentionHover | undefined;
}

/** The props of a resource preview. */
export interface ResourceView {
  stat: ResourceStat;
  section?: SectionKey;
  /** The forms made from its raw content (`markdown`, `table`, `description`, …). */
  forms: FormKind[];
  /** The raw text (`raw`) or one form's text. */
  text(form?: FormKind | 'raw'): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/** The props of the renderer for one of a contract's fns: `defineProps<FnViewOf<typeof fs, 'bash'>>()`. */
export type FnViewOf<S extends AnyContract, K extends keyof S['defs']['fns']> = FnView<TypesOf<S['defs']['fns'][K]>> & WithSystem<S['defs']>;
/** The props of the renderer for one of a contract's attachments. */
export type AttachmentViewOf<S extends AnyContract, K extends keyof S['defs']['attachments']> = AttachmentView<Infer<S['defs']['attachments'][K]['data']>> & WithSystem<S['defs']>;
/** The props of the input for one of a contract's types. */
export type InputViewOf<S extends AnyContract, K extends keyof S['defs']['types']> = InputView<ValueOf<S['defs']['types'][K]>> & WithSystem<S['defs']>;

/** The value type of a declared type. */
export type ValueOf<D> = D extends TypeDef<infer T, Methods> ? T : never;

/** A system's renderers, typed by its contract. Every renderer also gets `system` to send its system actions. */
export interface ClientRenderers<C extends ContractShape> {
  /** How calls of a fn are drawn in the chat. */
  fns?: { readonly [K in keyof C['fns']]?: Renderer<FnView<TypesOf<C['fns'][K]>> & WithSystem<C>> };
  /** How a fn of a kind is drawn when the fn has no renderer of its own. */
  kinds?: { readonly [K in keyof C['kinds']]?: Renderer<FnView<UntypedFn> & WithSystem<C>> };
  attachments?: { readonly [K in keyof C['attachments']]?: Renderer<AttachmentView<Infer<C['attachments'][K]['data']>> & WithSystem<C>> };
  /** Inputs for the system's named types (used in `!` forms and handler prompts). */
  inputs?: { readonly [K in keyof C['types']]?: Renderer<InputView<ValueOf<C['types'][K]>> & WithSystem<C>> };
  /** Custom hover cards for mentions (otherwise the hub draws the `MentionHover`). */
  mentions?: { readonly [K in keyof C['mentions']]?: Renderer<MentionView<Infer<C['mentions'][K]['target']>> & WithSystem<C>> };
  /**
   * Viewers for resource formats (`markdown`, `csv`, a system's own format). Viewers are shared: a resource in a
   * format is shown with that format's viewer, whichever system serves it. The hub ships viewers for the common
   * formats (text, markdown, code, images, PDF, JSON, CSV, folders), so most systems need none.
   */
  resources?: Record<string, Renderer<ResourceView & WithSystem<C>> | ResourceRenderer<C>>;
}

/**
 * A resource viewer with its place: `replace` draws instead of the hub's preview for the format; `tab` adds a mode
 * beside the hub's (a "Schema" view of `.sql` files that keeps the source view).
 */
export interface ResourceRenderer<C extends ContractShape> {
  component: Renderer<ResourceView & WithSystem<C>>;
  mode: 'replace' | 'tab';
  /** The tab's label (`tab` only). */
  label?: string;
}

/**
 * Shows any resource with the viewer for its format, from the hub or any system. Use it inside a renderer:
 * `h(ResourceViewer, { uri, section })` or `<ResourceViewer :uri="uri" />`.
 */
export declare const ResourceViewer: Component<{ uri: ResourceUri; section?: SectionKey; /** Show a compact preview instead of the full view. */ compact?: boolean }>;

/** A built client module. The chat UI loads it from the hub. */
export interface ClientModule {
  readonly system: string;
}

/** Declare a system's renderers in `client/`. */
export declare function client<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, renderers: ClientRenderers<C>): ClientModule;

// ═══ The hub's contract ═══

/** The types of a hub native fn. */
type HubFn<A, R> = FnDef<NativeFnTypes<A, R, {}, {}, NoProgress, never, never>>;

/**
 * The hub is a system too, built with the same SDK. Its contract is exported so other systems can depend on its
 * fns, use its `llm` kind, and refer to its sectioners. Its built-in message extras (local time, suggestions)
 * aren't hooks: the hub adds them itself whenever it can.
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
  mentions: {
    fns: MentionDef<{ fn: QualifiedName }, never>;
    context: MentionDef<{ context: QualifiedName }, never>;
    resources: MentionDef<{ uri: ResourceUri; section?: SectionKey }, never>;
  };
  sectioners: { whole: SectionerDef; headings: SectionerDef; symbols: SectionerDef; pages: SectionerDef; paragraphs: SectionerDef };
}

/** The hub's contract. */
export declare const hub: SystemContract<'hub', HubContract>;

// ═══ Build 2: detail, links, forms, invalid input ═══
//
// FROZEN. The "Build 2" sections of types/ are the design phase's sketches, kept as the record of what was approved;
// they are not compiled against the code and are not kept up to date (several already differ from it). The one source
// of every shape is the code: the zod schemas in packages/core (types derived from them), the SDK's sources, and the
// guide generated from them, packages/sdk/AUTHORING.md (npm run docs:authoring). Read those, and extend those, not this.

/**
 * How much of a fn or context item the model sees: `listed` (its name and one line), `signature` (a fn's call
 * signature and types; a context item's summary), `full` (instructions and examples too; the whole content).
 */
export type Detail = 'listed' | 'signature' | 'full';

/** A refused input: where it came from and what was wrong, by path into the args. Retryable. */
export interface InvalidInput {
  source: 'json' | 'schema' | 'validation';
  problems: Array<{ path: string; message: string }>;
  /** The text the model wrote, when it wasn't JSON. */
  raw?: string;
}

/** The forms made from a resource's raw content: converted versions (`@aeye/resources`) and model-made ones. */
export type FormKind = 'markdown' | 'text' | 'code' | 'pages' | 'table' | 'description' | 'ocr' | 'transcript' | 'thumbnail';

/** What a context link points at. */
export type LinkTarget =
  | { kind: 'context'; name: QualifiedName }
  | { kind: 'fn'; name: QualifiedName }
  | { kind: 'type'; name: QualifiedName }
  | { kind: 'resource'; uri: ResourceUri; section?: SectionKey };

/**
 * A link a system or person declares on a context item. Hard links travel with the item (`imports`: context it
 * brings; `brings`: fns it adds); the rest only spread activation in the graph contextor.
 */
export interface DeclaredLink {
  to: LinkTarget;
  relation: 'imports' | 'brings' | 'suggests' | 'parent' | 'next' | 'related' | 'about';
  /** 0 to 1; 0.5 when absent. */
  weight?: number;
}

/** A chat mode: strict native tools, or the static toolset with fn cards and one `run` tool. */
export type ChatModeConfig =
  | { type: 'tools' }
  | { type: 'static'; protocol?: 'auto' | 'native' | 'text'; placement?: 'system-end' | 'tail'; loadDetail?: Detail };

/** A contextor: what one prompt holds. */
export type ContextorConfig =
  | { type: 'plain' }
  | { type: 'suggest'; topN?: number; autoInject?: { tokens: number; items: number } }
  | {
    type: 'graph';
    metrics?: Partial<Record<'embedding' | 'words' | 'turnsAgo' | 'age' | 'selectedBefore' | 'used', { weight: number; target?: number; k?: number }>>;
    spread?: { damping?: number; hops?: number };
    floorExchanges?: number;
    shares?: { history: number; context: number; fns: number };
    threshold?: number;
    evaluate?: 'perMessage' | 'perIteration';
  };

/**
 * What an agent's payload gains in build 2: its chat mode, contextor and reply cap. `agent({ mode: { type: 'static' },
 * contextor: { type: 'graph' } })` is the setup for small local models; the defaults (`tools` + `plain`) are build 1's.
 */
export interface LlmPayloadBuild2 {
  mode?: ChatModeConfig;
  contextor?: ContextorConfig;
  /** The most tokens one reply may take (lowered to the model's own limit). */
  maxOutput?: number;
}

// ═══ Build 2: the hub's new fns ═══

/** A hub fn tagged `admin`: never exposed through a hub MCP; asks the person unless a policy says otherwise. */
type HubAdminFn<A, R> = HubFn<A, R>;

/**
 * The hub fns build 2 adds, so the chat LLM can see and do everything the browser can. Read fns are tagged `read`;
 * the rest ask the person unless a policy allows them. Each runs the same operation as its web endpoint; its args and
 * results are that endpoint's body and response (or a core schema), so the two can't drift.
 */
export interface HubContractBuild2 {
  fns: {
    // the static toolset (also the MCP static toolset)
    find: HubFn<{ query: string; kinds?: Array<'fn' | 'context' | 'resource' | 'type'>; limit?: number }, Array<{ name: string; kind: string; line: string; loaded: boolean }>>;
    inspect: HubFn<{ name: string; detail?: Detail }, { name: string; text: string }>;
    load: HubFn<{ names: string[]; detail?: Detail }, { loaded: string[]; refused: Array<{ name: string; reason: string }> }>;
    unload: HubFn<{ names: string[] }, { unloaded: string[] }>;
    // resources
    resource_list: HubFn<{ under?: string; family?: string; source?: string; cursor?: string; limit?: number }, { items: ResourceStat[]; cursor?: string }>;
    resource_read: HubFn<{ uri: ResourceUri; form?: FormKind | 'raw'; section?: SectionKey; offset?: number; maxChars?: number }, { text: string; total: number; truncated: boolean; forms: FormKind[] }>;
    resource_outline: HubFn<{ uri: ResourceUri }, Section[]>;
    resource_convert: HubFn<{ uri: ResourceUri; kind: FormKind }, { kind: FormKind; chars: number }>;
    resource_import: HubFn<{ url: string } | { content: ContentRef; name: string }, ResourceStat>;
    resource_send: HubFn<{ uri: ResourceUri }, { parts: number }>;
    resource_rename: HubFn<{ uri: ResourceUri; name: string }, ResourceStat>;
    resource_delete: HubFn<{ uri: ResourceUri }, { deleted: boolean; referencedBy: number }>;
    // context
    context_get: HubFn<{ name: string }, { text: string; links: Array<{ to: LinkTarget; relation: string; weight: number }> }>;
    context_from_resource: HubFn<{ uri: ResourceUri; sections?: SectionKey[]; copy?: 'live' | 'snapshot'; command?: string }, { created: string[]; updated: string[]; links: number }>;
    remember: HubFn<{ text: string; title?: string; scope?: 'session' | 'user' | 'everyone'; about?: LinkTarget[] }, { name: string }>;
    forget: HubFn<{ name: string }, { ok: boolean }>;
    // looking at everything (read)
    types_get: HubFn<{ names: string[] }, Array<{ name: string; code: string }>>;
    runs_list: HubFn<{ status?: RunStatus; fn?: string; session?: SessionId; limit?: number }, Array<{ id: RunId; fn: string; status: RunStatus }>>;
    run_tree: HubFn<{ run: RunId }, Json>;
    fn_metrics: HubFn<{ fn?: string; system?: string; days?: number }, Json>;
    model_calls: HubFn<{ modality?: string; run?: RunId; limit?: number }, Json>;
    sessions_list: HubFn<{ search?: string; limit?: number }, Array<{ id: SessionId; title: string }>>;
    session_messages: HubFn<{ session: SessionId; limit?: number }, Json>;
    systems_list: HubFn<{}, Array<{ name: string; status: string; instances: number }>>;
    system_logs: HubFn<{ system: string; limit?: number }, Array<{ at: Timestamp; text: string }>>;
    // admin (tagged admin)
    set_model_role: HubAdminFn<{ role: string; model?: ModelChoice; engine?: 'browser' | 'model' }, { role: string }>;
    set_model_limits: HubAdminFn<{ model: string; contextWindow?: number; maxOutputTokens?: number }, { model: string }>;
    create_mcp: HubAdminFn<{ slug: string; name: string; rules: Json }, { id: string; secret: string }>;
    update_mcp: HubAdminFn<{ mcp: string; rules?: Json; enabled?: boolean }, { id: string }>;
    rotate_mcp_secret: HubAdminFn<{ mcp: string }, { secret: string }>;
    delete_mcp: HubAdminFn<{ mcp: string }, { ok: boolean }>;
    mint_mcp_token: HubAdminFn<{ mcp: string; label: string; ttl?: Duration }, { token: string; expiresAt: Timestamp }>;
    install_package: HubAdminFn<{ zip: ContentRef; instance?: string; config?: Json }, { system: string; instance: string }>;
    export_system_data: HubAdminFn<{ system: string; instance?: string }, ContentRef>;
  };
  sectioners: { tables: SectionerDef };
}

// ═══ Build 2: packages and the CLI ═══

/** `system.json`: what a system package is (core's `SystemPackageManifest`). */
export interface SystemPackageManifest {
  format: 1;
  name: string;
  version: string;
  description: string;
  /** The link protocol it speaks. */
  protocol: number;
  server: { entry: string; external?: Record<string, string>; node?: string };
  client?: { entry: string };
  /** `one`: a single instance named `main`; `many`: a fleet. */
  instances?: 'one' | 'many';
  /** sha-256 of every packed file, written by `pack`. */
  files?: Record<string, string>;
}

/** One `harness` CLI command: a zod-checked args schema and a run over injected io, so every command is unit tested. */
export interface CliCommand<A> {
  readonly name: string;
  readonly summary: string;
  parse(argv: readonly string[]): A;
  run(args: A, io: CliIo): Promise<number>;
}

/** What a CLI command touches, injected. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The hub's web API, signed in as an admin. */
  readonly hub: () => Promise<unknown>;
  readonly files: { read(path: string): Promise<Uint8Array>; write(path: string, data: Uint8Array | string): Promise<void>; list(dir: string): Promise<string[]> };
  readonly cwd: string;
}
