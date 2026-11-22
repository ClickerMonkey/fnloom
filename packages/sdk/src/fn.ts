/**
 * Declaring fns: `fn()` for native fns, handlers, progress, and the types the rest of the SDK computes from a fn's
 * declaration (its ref, its run context, its outcome helpers and its renderer's props), so they can't disagree.
 */
import {
  messageOf,
  type Audience, type Display, type FnError, type FnLimits, type FnValidation, type InputVerdict, type InvalidInput, type Json, type Operations, type OutputVerdict, type ProgressDecl, type ProgressWire,
  type StatusTemplates, type StepStatus, type Usd, type FnApproval, type FnEffects, type FnRouting, type FnConnectKey, type ProposalApprover, type ModelRole,
} from '@harness/core';
import { encodeValue, json, type GinType } from './gin.ts';
import type { ValidateCtx } from './ctx.ts';
import type { AnyFnRef, AnyKindRef, KindRef } from './refs.ts';
import type { ClaimsInput } from './claims.ts';
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

/** Linear progress on the wire. */
type LinearWire = Extract<ProgressWire, { fraction: number }>;
/** One step's progress on the wire. */
type StepWire = Extract<ProgressWire, { steps: unknown }>['steps'][string];

/** Progress as the UI sees it, shaped the same way: core's `ProgressWire`, with the fn's own step names. */
export type ProgressState<P extends ProgressDef> =
  P extends LinearProgress ? LinearWire :
  P extends StepsProgress<infer S> ? { steps: { [K in keyof S]: StepWire } } :
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

/**
 * One example call of a fn, shown on its card at `full` detail, in its invalid-input replies and by `hub/fns_examples`:
 * args of the fn's own args type (a wrong example does not compile), optionally the result it gave (of its returns
 * type), and what the example shows. The hub keeps every example in its own table, embedded, so the ones closest to
 * the turn go into the prompt with the fn.
 */
export interface FnExampleOf<A, R = unknown> {
  readonly args: A;
  readonly result?: R;
  readonly note?: string;
}

/** Check each example against the args (and returns) type now, so a contract with a wrong example fails as it is built. */
function checkedExamples<A, R>(what: string, args: GinType<A>, returns: GinType<R>, examples: readonly FnExampleOf<A, R>[] | undefined): readonly FnExampleOf<A, R>[] {
  const check = <T>(index: number, part: 'args' | 'returns', type: GinType<T>, value: T): void => {
    try {
      encodeValue(type, value);
    } catch (error) {
      throw new Error(`${what}: example ${index + 1} does not fit the ${part} type: ${messageOf(error)}`, { cause: error });
    }
  };
  return (examples ?? []).map((example, index) => {
    check(index, 'args', args, example.args);
    if (example.result !== undefined) { check(index, 'returns', returns, example.result); }
    return { args: example.args, ...(example.result === undefined ? {} : { result: example.result }), ...(example.note === undefined ? {} : { note: example.note }) };
  });
}

// ─── Validation hooks ─────────────────────────────────────────────────────────

/**
 * A fn's validation hooks, run in its system when the hub asks (`validate` on the system link). `input` runs before
 * a run starts: a refusal tells the caller the fn can't run now and why (it is not an error). `output` runs after a
 * run is done: `retry` gives the model the reason and asks it to try again; `stop` fails the run with the reason
 * shown to the person. Both get the session state fields the fn declares, as they are now.
 */
export interface FnValidators<A, R, St extends object> {
  input?(ctx: ValidateCtx, args: A, state: Readonly<Partial<St>>): InputVerdict | Promise<InputVerdict>;
  output?(ctx: ValidateCtx, args: A, result: R, state: Readonly<Partial<St>>): OutputVerdict | Promise<OutputVerdict>;
}

/** Which hooks a fn's validators declare, for its manifest (`FnDecl.validate`); `undefined` when it has none. */
export function validationOf(validators: { readonly input?: unknown; readonly output?: unknown } | undefined): FnValidation | undefined {
  if (validators === undefined) { return undefined; }
  const declared = { input: validators.input !== undefined, output: validators.output !== undefined };
  return declared.input || declared.output ? declared : undefined;
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
  /** Example calls, checked against its args type. */
  readonly examples: readonly FnExampleOf<T['args'], T['result']>[];
  /** Its validation hooks, run in its system before and after a run. */
  readonly validate: FnValidators<T['args'], T['result'], T['state']> | undefined;
  /** Every run waits for approval; with `preview`, its implementation's `preview` says what the run would do. */
  readonly approval: FnApproval | undefined;
  /** Which instance of a fleet runs it: always one (`{ to: 'instance', instance }`), or the first available (`{ to: 'any' }`). */
  readonly routing: FnRouting | undefined;
  /** For a key-scoped `connect` system: the key it acts through, fixed or read from an arg (`FnDecl.connectKey`). */
  readonly connectKey: FnConnectKey | undefined;
  /** What it does to data, as declared. */
  readonly effects: FnEffects | undefined;
  /** How many examples go into the prompt with it. */
  readonly promptExamples: number | undefined;
  /** The API group it is listed in (`SystemInfo.groups`); the general group when undefined. */
  readonly group: string | undefined;
  /** Whether the hub asks its implementation's `flags(args, ctx)` which sensitive files a run would touch first. */
  readonly flags: boolean;
  /** The hub model roles it needs set (`FnDecl.roles`); it is unavailable (`role-unset`) while one has no model. */
  readonly roles: readonly ModelRole[] | undefined;
  /** What its calls operate on, as claim templates the hub fills from each call's args (`FnDecl.parallelClaims`). */
  readonly parallelClaims: readonly string[];
  /** Whether the hub also asks its implementation's `claims(args, ctx)` before an agent's call starts. */
  readonly dynamicClaims: boolean;
  /** Phantom: lets the SDK read T back out of a def. Never set at runtime. */
  readonly types?: T;
}

export type AnyFnDef = FnDef<FnTypes>;

/** The types of a fn def. */
export type TypesOf<F> = F extends FnDef<infer T> ? T : never;

/** What `fn()` takes. Only `description`, `args` and `returns` are required. */
export interface FnInput<
  A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U, St extends object, F, T extends StatusTemplates = StatusTemplates, C extends readonly string[] = readonly string[],
> {
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
  /**
   * Example calls (args of its own args type, optionally the result of its returns type, and a note), shown to agents
   * on its card and when they get its args wrong. Give real, varied ones: they teach a model more than the description.
   */
  examples?: FnExampleOf<NoInfer<A>, NoInfer<R>>[];
  /**
   * Checks the hub runs before a run starts (`input`) and after it is done (`output`):
   * `{ input: (ctx, args, state) => args.path === '' ? { ok: false, reason: 'No file is open.' } : { ok: true } }`.
   */
  validate?: FnValidators<NoInfer<A>, NoInfer<R>, NoInfer<St>>;
  /**
   * Every run waits for the person's approval, whatever the policies say (writes, schema changes). `preview`
   * (default true) has the hub ask the implementation's `preview(args, ctx)` what the run would do first;
   * `remember` (default false) lets the person say "don't ask again". `approver` (default `person`): with `admins` a
   * member's call waits for an admin, who is notified (installing code).
   */
  approval?: { preview?: boolean; remember?: boolean; approver?: ProposalApprover };
  /** For a fleet: always one instance, or whichever is first available (never refused as ambiguous). */
  routing?: FnRouting;
  /**
   * For a key-scoped `connect` system (`scope: 'key'`): the key whose connection it acts as, usually the arg naming it
   * (`{ arg: 'service' }`). A call without that arg acts as no one.
   */
  connectKey?: FnConnectKey;
  /**
   * What it does to data: its mode (`read`, `write`, `delete`), the named types it reads and writes, and whether its own
   * work is free (reading a file). The hub works out the rest and folds in what it uses (`FnFacts`).
   */
  effects?: FnEffects;
  /** How many of its examples go into the model's prompt with it (the hub's default when absent); the rest page with `hub/fns_examples`. */
  promptExamples?: number;
  /** The API group it is listed in: one of the system's `groups` (`system(name, { groups })`); the general group when absent. */
  group?: string;
  /**
   * The fn touches files that may be sensitive (env files, keys, gitignored files): before every run the hub asks its
   * implementation's `flags(args, ctx)` which ones, then refuses, asks the person or goes ahead by the rules' actions.
   * Requires `flags` in the implementation.
   */
  flags?: true;
  /**
   * The hub model roles it needs set (`decide` for a fn that asks the decision model): while one has no model, the hub
   * keeps it unavailable (`role-unset`) and says which role an admin must set.
   */
  roles?: ModelRole[];
  /**
   * What its calls operate on, so an agent's calls that touch the same thing never run at once: when a model makes
   * several calls in one step they run together, except that a call whose claims conflict with an earlier call's (in
   * the model's order) waits until that call has settled. Each claim is text with `{args.x}` tokens filled from the
   * call's args and checked against them: `['file:{args.path}']`. A token naming a list gives one claim per item, and
   * `{args.dir|.}` names a fallback. Two calls conflict when they share a claim; `'*'` conflicts with every call (it
   * runs alone).
   */
  parallelClaims?: ClaimsInput<NoInfer<A>, C>;
  /**
   * The hub also asks its implementation's `claims(args, ctx)` for a call's claims before it starts (paths resolved
   * against the roots, the rows a query would touch), joined with `parallelClaims`. Requires `claims` in the
   * implementation. It costs a round trip per call, so prefer `parallelClaims` when the args say it all.
   */
  dynamicClaims?: true;
}

/** The types of a native fn. */
export interface NativeFnTypes<A, R, D extends Deps, H extends Handlers, P extends ProgressDef, S, U, St extends object = {}, F = never> {
  kind: 'native'; payload: undefined; args: A; result: R; deps: D; handlers: H; progress: P; resume: S; undo: U; state: St; form: F;
}

/** Declare a native fn: a fn its system implements in code. */
export function fn<
  A, R, const D extends Deps = {}, const H extends Handlers = {}, const P extends ProgressDef = NoProgress, S = never, U = never, St extends object = {}, F = never,
  const T extends StatusTemplates = StatusTemplates, const C extends readonly string[] = readonly string[],
>(
  def: FnInput<A, R, D, H, P, S, U, St, F, T, C>,
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
    examples: checkedExamples(def.description, def.args, def.returns, def.examples),
    validate: def.validate,
    approval: def.approval === undefined ? undefined : { preview: def.approval.preview ?? true, remember: def.approval.remember ?? false, ...(def.approval.approver === undefined ? {} : { approver: def.approval.approver }) },
    routing: def.routing,
    connectKey: def.connectKey,
    effects: def.effects,
    promptExamples: def.promptExamples,
    group: def.group,
    flags: def.flags === true,
    roles: def.roles,
    parallelClaims: [...(def.parallelClaims ?? [])],
    dynamicClaims: def.dynamicClaims === true,
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
  /** Example calls, of the `args` and `returns` types when given (JSON otherwise). */
  examples?: FnExampleOf<NoInfer<A>, NoInfer<R>>[];
  /** For a fleet: always one instance (a saved query of one database), or whichever is first available. */
  routing?: FnRouting;
  /** Checks its system runs before a run starts and after it is done (an agent's answer checked, retried with why). */
  validate?: FnValidators<NoInfer<A>, NoInfer<R>, {}>;
  /**
   * What it does to data: its mode (`read`, `write`, `delete`), the named types it reads and writes, and whether its own
   * work is free (reading a file). The hub works out the rest and folds in what it uses (`FnFacts`).
   */
  effects?: FnEffects;
  /** How many of its examples go into the model's prompt with it (the hub's default when absent); the rest page with `hub/fns_examples`. */
  promptExamples?: number;
  /** The API group it is listed in (`SystemInfo.groups`); the general group when absent. */
  group?: string;
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
    examples: def.args === undefined ? (def.examples ?? []) : checkedExamples(def.description, def.args, orDefault<GinType<R>, GinType>(def.returns, json()), def.examples),
    validate: def.validate,
    approval: undefined,
    routing: def.routing,
    connectKey: undefined,
    effects: def.effects,
    promptExamples: def.promptExamples,
    group: def.group,
    flags: false,
    roles: undefined,
    parallelClaims: [],
    dynamicClaims: false,
  };
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────

/**
 * How a run ended. Build it with the ctx helpers (`ctx.done(result)`, `ctx.invalid(problems)`, `ctx.fail(...)`,
 * `ctx.pause(state)`, `ctx.cancelled()`), which are typed to the fn. Its wire form is core's `OutcomeWire`.
 * `invalid-input` is the caller's mistake (an agent retries it, the chat shows it softly); `failed` is a real error.
 */
export type Outcome<T extends FnTypes> =
  | { status: 'done'; result: T['result']; undo?: T['undo']; cost?: Usd }
  | { status: 'invalid-input'; invalid: InvalidInput; cost?: Usd }
  | { status: 'paused'; resume: T['resume']; cost?: Usd }
  | { status: 'failed'; error: FnError; undo?: T['undo']; cost?: Usd }
  | { status: 'cancelled'; partial?: T['result']; undo?: T['undo']; cost?: Usd };
