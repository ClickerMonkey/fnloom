/**
 * Declaring fns: `fn()` for native fns, handlers, progress, and the types the rest of the SDK computes from a fn's
 * declaration (its ref, its run context, its outcome helpers and its renderer's props), so they can't disagree.
 */
import type {
  Audience, Display, FnError, FnLimits, Json, Operations, ProgressDecl, StatusTemplates, StepStatus, Usd,
} from '@harness/core';
import { json, type GinType } from './gin.ts';
import type { AnyFnRef, AnyKindRef, KindRef } from './refs.ts';
import type { StatusInput } from './status.ts';
import { orDefault, type Simplify } from './util.ts';

// ─── Handlers ─────────────────────────────────────────────────────────────────

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
export function handler<A, R, const Req extends boolean>(def: HandlerDef<A, R, Req>): HandlerDef<A, R, Req> {
  return { description: def.description, args: def.args, returns: def.returns, required: def.required };
}

/** A handler as a function. */
export type HandlerFn<HD> = HD extends HandlerDef<infer A, infer R, boolean> ? (args: A) => Promise<R> : never;

type RequiredKeys<H extends Handlers> = { [K in keyof H]: H[K]['required'] extends true ? K : never }[keyof H];
type OptionalHandlerKeys<H extends Handlers> = Exclude<keyof H, RequiredKeys<H>>;

/** Whether a fn has a handler every caller must pass. */
export type HasRequiredHandlers<H extends Handlers> = [RequiredKeys<H>] extends [never] ? false : true;

/** The handlers a caller passes: every required one, any optional one. */
export type HandlerArgs<H extends Handlers> =
  Simplify<{ [K in RequiredKeys<H>]: HandlerFn<H[K]> } & { [K in OptionalHandlerKeys<H>]?: HandlerFn<H[K]> }>;

/** A fn's own handlers as it sees them: required ones are always there; optional ones may be missing. */
export type HandlersInRun<H extends Handlers> =
  Simplify<{ readonly [K in RequiredKeys<H>]: HandlerFn<H[K]> } & { readonly [K in OptionalHandlerKeys<H>]: HandlerFn<H[K]> | undefined }>;

// ─── Progress ─────────────────────────────────────────────────────────────────

/** How a fn reports progress. */
export type ProgressDef = NoProgress | LinearProgress | StepsProgress<Record<string, string>>;
export interface NoProgress { readonly type: 'none' }
export interface LinearProgress { readonly type: 'linear' }
/** Named steps; the record maps each step to its title. */
export interface StepsProgress<S extends Record<string, string>> { readonly type: 'steps'; readonly steps: S }

/** No progress reporting. The default. */
export const noProgress: NoProgress = { type: 'none' };
/** Progress as a fraction from 0 to 1: `ctx.progress.set(0.4)`. */
export const linear: LinearProgress = { type: 'linear' };
/** Progress as named steps: `steps({ read: 'Read the file', write: 'Write the copy' })`. */
export function steps<const S extends Record<string, string>>(steps: S): StepsProgress<S> {
  return { type: 'steps', steps };
}

/** A progress def on the wire. */
export function progressDecl(progress: ProgressDef): ProgressDecl {
  return progress.type === 'steps' ? { type: 'steps', steps: { ...progress.steps } } : { type: progress.type };
}

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

// ─── What the type system knows about a fn ───────────────────────────────────

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
  readonly instructions: string | undefined;
  readonly args: GinType<T['args']>;
  readonly returns: GinType<T['result']>;
  readonly deps: T['deps'];
  readonly handlers: T['handlers'];
  readonly progress: T['progress'];
  /** What its runs say they are doing; its kind's words, then the hub's, when undefined. */
  readonly status: StatusTemplates | undefined;
  readonly resume: GinType<T['resume']> | undefined;
  readonly undo: GinType<T['undo']> | undefined;
  readonly state: GinType<T['state']> | undefined;
  readonly form: GinType<T['form']> | undefined;
  /** How a run looks in the chat once it is done. */
  readonly display: Display;
  readonly operations: Operations;
  readonly limits: FnLimits;
  readonly visibility: Audience;
  readonly tags: readonly string[];
  /** Phantom: lets the SDK read T back out of a def. Never set at runtime. */
  readonly types?: T;
}

export type AnyFnDef = FnDef<FnTypes>;

/** The types of a fn def. */
export type TypesOf<F> = F extends FnDef<infer T> ? T : never;

/** What `fn()` takes. Only `description`, `args` and `returns` are required. */
export interface FnInput<A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U, St extends object, F, T extends StatusTemplates = StatusTemplates> {
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
  /**
   * What its runs say they are doing, per phase, for one run and for a group: `{ active: { one: 'Reading
   * {args.path}…', many: 'Reading {n} files…' }, … }`. Tokens are checked against its args and result.
   */
  status?: StatusInput<NoInfer<A>, NoInfer<R>, T>;
  /** Declaring a resume type makes the fn pausable. */
  resume?: GinType<S>;
  /** Declaring an undo type makes the fn undoable, and requires an `undo` implementation. */
  undo?: GinType<U>;
  /**
   * The session state fields this fn uses: `g.obj({ cwd: g.text() })`. A fn sees only the fields it declares, and a
   * field is shared only with fns that declare the same name with the same type.
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
export function fn<
  A, R, const D extends Deps = {}, const H extends Handlers = {}, const P extends ProgressDef = NoProgress, S = never, U = never, St extends object = {}, F = never,
  const T extends StatusTemplates = StatusTemplates,
>(
  def: FnInput<A, R, D, H, P, S, U, St, F, T>,
): FnDef<NativeFnTypes<A, R, NoInfer<D>, NoInfer<H>, NoInfer<P>, NoInfer<S>, NoInfer<U>, NoInfer<St>, NoInfer<F>>> {
  return {
    kind: 'native',
    payload: undefined,
    description: def.description,
    instructions: def.instructions,
    args: def.args,
    returns: def.returns,
    deps: orDefault(def.deps, {}),
    handlers: orDefault(def.handlers, {}),
    progress: orDefault<P, ProgressDef>(def.progress, noProgress),
    status: def.status,
    resume: def.resume,
    undo: def.undo,
    state: def.state,
    form: def.form,
    display: def.display ?? 'card',
    operations: {
      cancel: def.operations?.cancel ?? true,
      background: def.operations?.background ?? true,
      pause: def.resume !== undefined,
      undo: def.undo !== undefined,
    },
    limits: def.limits ?? {},
    visibility: def.visibility ?? 'both',
    tags: def.tags ?? [],
  };
}

// ─── Kinds' fns ───────────────────────────────────────────────────────────────

/**
 * What `kinds.x.fn()` takes. Only the payload is required: everything else a fn has is worked out by the kind's
 * `describe`. `args`/`returns` are optional typing hints: when given, the hub checks them against what the kind
 * derived, and the ref is typed by them (otherwise by `Json`).
 */
export interface KindFnInput<P, A, R, T extends StatusTemplates = StatusTemplates> {
  description: string;
  instructions?: string;
  payload: P;
  args?: GinType<A>;
  returns?: GinType<R>;
  /** What its runs say they are doing; the kind's words when absent. Tokens are checked against `args` and `returns`. */
  status?: StatusInput<NoInfer<A>, NoInfer<R>, T>;
  visibility?: Audience;
  tags?: string[];
}

/** The types of a fn of some kind. Its deps, handlers and progress come from the kind at runtime. */
export interface KindFnTypes<K extends AnyKindRef, P, A, R> {
  kind: K; payload: P; args: A; result: R; deps: {}; handlers: {}; progress: NoProgress; resume: never; undo: never; state: {}; form: never;
}

/** The types of a fn known only at runtime (what a kind's implementation runs). */
export interface UntypedFn {
  kind: AnyKindRef; payload: unknown; args: Json; result: Json; deps: {}; handlers: Handlers; progress: ProgressDef; resume: Json; undo: Json; state: Record<string, Json>; form: Json;
}

/** The fn def of a kind fn, built by `KindRef.fn`. The kind's `describe` fills in the rest when the hub imports it. */
export function kindFn<N extends `${string}/${string}`, P, A, R, const T extends StatusTemplates = StatusTemplates>(
  kind: KindRef<N, P>, def: KindFnInput<P, A, R, T>,
): FnDef<KindFnTypes<KindRef<N, P>, P, A, R>> {
  return {
    kind,
    payload: def.payload,
    description: def.description,
    instructions: def.instructions,
    args: orDefault<GinType<A>, GinType>(def.args, json()),
    returns: orDefault<GinType<R>, GinType>(def.returns, json()),
    deps: {},
    handlers: {},
    progress: noProgress,
    status: def.status,
    resume: undefined,
    undo: undefined,
    state: undefined,
    form: undefined,
    display: 'card',
    operations: { cancel: true, pause: false, undo: false, background: true },
    limits: {},
    visibility: def.visibility ?? 'both',
    tags: def.tags ?? [],
  };
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────

/**
 * How a run ended. Build it with the ctx helpers (`ctx.done(result)`, `ctx.fail(...)`, `ctx.pause(state)`,
 * `ctx.cancelled()`), which are typed to the fn. Its wire form is core's `OutcomeWire`.
 */
export type Outcome<T extends FnTypes> =
  | { status: 'done'; result: T['result']; undo?: T['undo']; cost?: Usd }
  | { status: 'paused'; resume: T['resume']; cost?: Usd }
  | { status: 'failed'; error: FnError; undo?: T['undo']; cost?: Usd }
  | { status: 'cancelled'; partial?: T['result']; undo?: T['undo']; cost?: Usd };
