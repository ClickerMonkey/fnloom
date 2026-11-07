/**
 * The runtime's view of a system: its declarations and its implementation, looked up by the local names the hub
 * sends. `SystemImpl<C>` is computed from the contract so authors get exact types; the runtime dispatches by string,
 * so it reads the implementation through `ImplTable`, the same functions with their contexts widened to what the
 * runtime builds. `implTable` is the one place that bridge is made.
 */
import type {
  AllowedOperations, ErrorClass, HookInput, Json, KindDescription, MentionHover, RunInfo, StepStatus, StopReason, SystemEvent, UndoOutcome, Usd,
} from '@harness/core';
import type { ActionCtx, AskerCtx, BudgetInfo, CallOptions, FnCall, FnCtx, Resume, Services, SessionState, SystemCtx, UndoCtx } from '../ctx.ts';
import type {
  ActionImpl, AnyTypeDef, ContextImpl, EmbedderImpl, HookContribution, HookImpl, KindCheckCtx, KindDef, KindImpl, KindRunCtx, MentionCtx, MentionImpl,
  MentionOption, MethodImpl, SectionerImpl,
} from '../declare.ts';
import type { AnyFnDef, FnTypes, Handlers, Outcome, ProgressDef, UntypedFn } from '../fn.ts';
import type { FnImpl } from '../impl.ts';
import type { ResourceProvider } from '../resources.ts';
import type { AnyContract, ContractShape, EventHandlers, Lifecycle, SystemImpl } from '../system.ts';
import { expectType, type Equal } from '../util.ts';

/** Any outcome, as the runtime handles it before encoding it for the wire. */
export type AnyOutcome = Outcome<FnTypes>;

/** Progress reporting as the runtime provides it: both forms; the fn's declaration decides which one it may call. */
export interface RuntimeProgress {
  readonly type: ProgressDef['type'];
  set(fraction: number, message?: string): void;
  step(name: string, status: StepStatus, detail?: string): void;
}

/** A dep caller as the runtime provides it. */
export type RuntimeCaller = (args: unknown, options?: CallOptions<Handlers>) => FnCall<unknown>;

/** The outcome helpers every run context has. */
export interface OutcomeHelpers {
  done(result: unknown, extra?: { undo?: unknown; cost?: Usd }): AnyOutcome;
  fail(cls: ErrorClass, message: string, extra?: { code?: string; data?: Json; undo?: unknown; cost?: Usd }): AnyOutcome;
  pause(state: unknown, extra?: { cost?: Usd }): AnyOutcome;
  cancelled(extra?: { partial?: unknown; undo?: unknown; cost?: Usd }): AnyOutcome;
}

/** What every run context has besides its calls, handlers and progress. */
export interface RuntimeRunBase extends Services, OutcomeHelpers {
  readonly config: unknown;
  readonly run: RunInfo;
  readonly budget: BudgetInfo;
  readonly signal: AbortSignal;
  readonly state: SessionState<Record<string, unknown>>;
  readonly form: (() => Promise<unknown>) | undefined;
  readonly resume: Resume<unknown> | undefined;
  onPause(hook: () => unknown): void;
  allow(operations: Partial<AllowedOperations>): void;
  undoWith(payload: unknown): void;
}

/** A native fn's (or method's) run context as the runtime builds it from the fn's declaration. */
export interface RuntimeFnCtx extends RuntimeRunBase {
  readonly fns: Readonly<Record<string, RuntimeCaller>>;
  readonly handlers: Readonly<Record<string, ((args: unknown) => Promise<unknown>) | undefined>>;
  readonly progress: RuntimeProgress;
}

/** A kind's run context: calls and handlers by name. */
export interface RuntimeKindCtx extends RuntimeRunBase {
  call(fn: `${string}/${string}`, args: Json, options?: { key?: string; background?: boolean }): FnCall<Json>;
  handler(name: string, args: Json): Promise<Json>;
  progress(state: { fraction: number; message?: string } | { step: string; status: StepStatus; detail?: string }): void;
}

export interface RuntimeFnImpl {
  run(args: unknown, ctx: RuntimeFnCtx): Promise<AnyOutcome>;
  undo?(payload: unknown, ctx: UndoCtx): Promise<UndoOutcome>;
}

export interface RuntimeMethodImpl {
  run(self: unknown, args: unknown, ctx: RuntimeFnCtx): Promise<AnyOutcome>;
  undo?(payload: unknown, ctx: UndoCtx): Promise<UndoOutcome>;
}

export interface RuntimeKindImpl {
  check(payload: unknown, ctx: KindCheckCtx): Promise<string[]>;
  describe(payload: unknown, ctx: KindCheckCtx): Promise<KindDescription>;
  run(payload: unknown, args: Json, ctx: RuntimeKindCtx): Promise<Outcome<UntypedFn>>;
  undo?(payload: unknown, undo: Json, ctx: UndoCtx): Promise<UndoOutcome>;
}

/** What dynamic context gets: the system context and who is asking (the session only when there is one). */
export type RuntimeContextCtx = SystemCtx & Partial<AskerCtx> & Pick<AskerCtx, 'user' | 'time'>;

export interface RuntimeMentionImpl {
  search(query: string, ctx: MentionCtx): Promise<MentionOption<unknown>[]>;
  hover(target: unknown, ctx: MentionCtx): Promise<(Omit<MentionHover, 'value'> & { value?: unknown }) | undefined>;
  llm(target: unknown, ctx: MentionCtx): Promise<string>;
}

export interface RuntimeLifecycle {
  installed?(ctx: SystemCtx): Promise<void>;
  started?(ctx: SystemCtx): Promise<void>;
  configured?(ctx: SystemCtx & { readonly previous: unknown }): Promise<void>;
  stopping?(ctx: SystemCtx & { readonly reason: StopReason; readonly timeout: number }): Promise<void>;
  upgraded?(ctx: SystemCtx & { readonly from: string }): Promise<void>;
  uninstalled?(ctx: SystemCtx): Promise<void>;
}

/** A system's implementation by section and local name. */
export interface ImplTable {
  readonly fns?: Readonly<Record<string, RuntimeFnImpl>>;
  readonly types?: Readonly<Record<string, Readonly<Record<string, RuntimeMethodImpl>>>>;
  readonly kinds?: Readonly<Record<string, RuntimeKindImpl>>;
  readonly context?: Readonly<Record<string, (args: Record<string, string>, ctx: RuntimeContextCtx) => Promise<string>>>;
  readonly hooks?: Readonly<Record<string, (input: HookInput, ctx: SystemCtx) => Promise<HookContribution[]>>>;
  readonly mentions?: Readonly<Record<string, RuntimeMentionImpl>>;
  readonly embedders?: Readonly<Record<string, EmbedderImpl>>;
  readonly sectioners?: Readonly<Record<string, SectionerImpl>>;
  readonly actions?: Readonly<Record<string, (input: unknown, ctx: ActionCtx<Record<string, unknown>>) => Promise<unknown>>>;
  readonly resources?: ResourceProvider;
  readonly events?: { readonly [E in SystemEvent['type']]?: (event: Extract<SystemEvent, { type: E }>, ctx: SystemCtx) => Promise<void> };
  readonly lifecycle?: RuntimeLifecycle;
}

// ─── Pins: the runtime's view follows SystemImpl ──────────────────────────────
//
// The runtime's shapes can't simply be SystemImpl's: each author context is computed from its own declaration, the
// runtime's is the union of every form. So they are pinned instead. A section added to or renamed in SystemImpl, a
// member added to or renamed in an impl or a context, or a changed parameter (other than the context) or result
// fails to compile here, so the runtime can't quietly stop dispatching something an author must write.

/** A signature with its context parameter (the last) dropped, recursively through objects and records. */
type Erased<F> = F extends (...args: infer A) => infer R
  ? (...args: A extends [...infer Head, unknown] ? Head : A) => R
  : { readonly [K in keyof F]-?: Erased<Exclude<F[K], undefined>> };
/** A section of `ImplTable`, erased. */
type RuntimeSection<K extends keyof ImplTable> = Erased<Exclude<ImplTable[K], undefined>>;
/** An author section keyed by local name, erased. */
type AuthorSection<T> = Erased<{ readonly [local: string]: T }>;

expectType<Equal<keyof ImplTable, keyof SystemImpl<ContractShape>>>(true);
expectType<Equal<RuntimeSection<'fns'>, AuthorSection<FnImpl<FnTypes, object>>>>(true);
expectType<Equal<RuntimeSection<'types'>, AuthorSection<{ readonly [method: string]: MethodImpl<unknown, FnTypes, object> }>>>(true);
expectType<Equal<RuntimeSection<'kinds'>, AuthorSection<KindImpl<unknown, object>>>>(true);
expectType<Equal<RuntimeSection<'context'>, AuthorSection<ContextImpl<Record<string, string>, object>>>>(true);
expectType<Equal<RuntimeSection<'hooks'>, AuthorSection<HookImpl<object>>>>(true);
expectType<Equal<RuntimeSection<'mentions'>, AuthorSection<MentionImpl<unknown, unknown, object>>>>(true);
expectType<Equal<RuntimeSection<'embedders'>, AuthorSection<EmbedderImpl>>>(true);
expectType<Equal<RuntimeSection<'sectioners'>, AuthorSection<SectionerImpl>>>(true);
expectType<Equal<RuntimeSection<'actions'>, AuthorSection<ActionImpl<unknown, unknown, Record<string, unknown>, object>>>>(true);
expectType<Equal<RuntimeSection<'resources'>, Erased<ResourceProvider>>>(true);
expectType<Equal<RuntimeSection<'events'>, Erased<EventHandlers<object>>>>(true);
expectType<Equal<RuntimeSection<'lifecycle'>, Erased<Lifecycle<object>>>>(true);
expectType<Equal<keyof RuntimeFnCtx, keyof FnCtx<FnTypes, object>>>(true);
expectType<Equal<keyof RuntimeKindCtx, keyof KindRunCtx<object>>>(true);

/**
 * The implementation as the runtime dispatches it. `SystemImpl<C>` gives every function its exact context type
 * (`FnCtx<T, Cfg>` for the fn's own `T`); the runtime builds each context from that same fn's declaration (callers
 * for exactly its deps, its handlers, its progress form, its form and state types, the contract's config), so it
 * provides every member the exact type promises. Function parameters are contravariant, so TypeScript can't see
 * that through a string-keyed lookup; this is the one place the SDK states it, and the pins above keep the two
 * shapes in step.
 */
export function implTable<C extends ContractShape>(impl: SystemImpl<C>): ImplTable {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see the doc comment: each context is built from its own declaration
  return impl as unknown as ImplTable;
}

/** What the runtime runs for one `RunRequest`. */
export type RunTarget =
  | { kind: 'native'; local: string; def: AnyFnDef; impl: RuntimeFnImpl }
  | { kind: 'method'; local: string; type: string; method: string; def: AnyFnDef; argsType: AnyFnDef['args']; impl: RuntimeMethodImpl }
  | { kind: 'kind'; local: string; kindName: string; def: KindDef<unknown>; impl: RuntimeKindImpl };

/** The runtime's lookup of declarations and implementations. Runtime-added native fns join the contract's. */
export class SystemTable {
  readonly contract: AnyContract;
  readonly impl: ImplTable;
  readonly #added = new Map<string, { def: AnyFnDef; impl: RuntimeFnImpl | undefined }>();
  readonly #listeners = new Set<() => void>();

  constructor(contract: AnyContract, impl: ImplTable) {
    this.contract = contract;
    this.impl = impl;
  }

  /** Add a fn at runtime; native fns bring their implementation. */
  add(local: string, def: AnyFnDef, impl: RuntimeFnImpl | undefined): void {
    if (local in this.contract.defs.fns || this.#added.has(local)) { throw new Error(`fn ${local} already exists in ${this.contract.name}`); }
    this.#added.set(local, { def, impl });
    this.#changed();
  }

  /** Remove a fn added at runtime; false when it wasn't one. */
  remove(local: string): boolean {
    const removed = this.#added.delete(local);
    if (removed) { this.#changed(); }
    return removed;
  }

  /** Hear about fns being added or removed at runtime. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) { listener(); }
  }

  /** The fns added at runtime, by local name. */
  added(): ReadonlyMap<string, { def: AnyFnDef; impl: RuntimeFnImpl | undefined }> {
    return this.#added;
  }

  /** A fn's declaration by local name: the contract's, a runtime one, or a type's method (`Entry.reveal`). */
  fnDef(local: string): AnyFnDef | undefined {
    const method = splitMethod(local);
    if (method !== undefined) { return this.typeDef(method.type)?.methods[method.method]; }
    return this.contract.defs.fns[local] ?? this.#added.get(local)?.def;
  }

  typeDef(local: string): AnyTypeDef | undefined {
    return this.contract.defs.types[local];
  }

  /** What to run for a fn, by its local name and kind (`native` or a qualified kind of this system). */
  target(local: string, kind: string): RunTarget | string {
    if (kind !== 'native') {
      const kindLocal = kind.slice(kind.indexOf('/') + 1);
      const def = this.contract.defs.kinds[kindLocal];
      const impl = this.impl.kinds?.[kindLocal];
      if (!kind.startsWith(`${this.contract.name}/`) || def === undefined || impl === undefined) { return `kind ${kind} is not one this system runs`; }
      return { kind: 'kind', local, kindName: kindLocal, def, impl };
    }
    const method = splitMethod(local);
    if (method !== undefined) {
      const def = this.typeDef(method.type)?.methods[method.method];
      const ref = this.contract.types[method.type]?.methods[method.method];
      const impl = this.impl.types?.[method.type]?.[method.method];
      if (def === undefined || ref === undefined || impl === undefined) { return `method ${local} is not implemented here`; }
      return { kind: 'method', local, type: method.type, method: method.method, def, argsType: ref.args, impl };
    }
    const def = this.fnDef(local);
    const impl = this.impl.fns?.[local] ?? this.#added.get(local)?.impl;
    if (def === undefined || impl === undefined || def.kind !== 'native') { return `fn ${local} is not a native fn implemented here`; }
    return { kind: 'native', local, def, impl };
  }
}

/** `Entry.reveal` → `{ type: 'Entry', method: 'reveal' }`; plain fn names give `undefined`. */
export function splitMethod(local: string): { type: string; method: string } | undefined {
  const dot = local.indexOf('.');
  return dot < 0 ? undefined : { type: local.slice(0, dot), method: local.slice(dot + 1) };
}

/** A runtime-added native fn's implementation as the runtime dispatches it; see `implTable` for why this holds. */
export function runtimeFnImpl<T extends FnTypes, Cfg>(impl: FnImpl<T, Cfg>): RuntimeFnImpl {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- its context is built from the same def it was added with
  return impl as unknown as RuntimeFnImpl;
}

