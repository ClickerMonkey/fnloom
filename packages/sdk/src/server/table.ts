/**
 * The runtime's view of a system: its declarations and its implementation, looked up by the local names the hub
 * sends. `SystemImpl<C>` is computed from the contract so authors get exact types; the runtime dispatches by string,
 * so it reads the implementation through `ImplTable`, the same functions with their contexts widened to what the
 * runtime builds. `implTable` is the one place that bridge is made.
 */
import type {
  AllowedOperations, ApprovedRun, ConnectFinish, CostEstimate, Manifest, ManifestPatch, ManifestSection, ProviderModelDecl, SectionDecl, ConnectionUpdate, ConnectResult, ConnectStart, Detail, ErrorClass, HookInput, InputProblem, Json, KindDescription, MentionHover, PreviewAnswer, RunConnection, RunInfo, SensitivityFlag, ShareRule, StepStatus, TypeDecl, StopReason, SystemEvent, UndoOutcome, Usd,
} from '@harness/core';
import { MANIFEST_SECTIONS, MANIFEST_SECTION_NAMES } from '@harness/core';
import type { ActionCtx, AskerCtx, BudgetInfo, CallOptions, Decisions, FnCall, Fleets, FnCtx, FnSearch, PreviewCtx, ClaimsCtx, Proposals, Resume, RunNotices, Services, SessionState, SystemCtx, UndoCtx } from '../ctx.ts';
import type {
  ActionImpl, AnyTypeDef, ContextImpl, HookContribution, HookImpl, KindCheckCtx, KindDef, KindEstimateInput, KindImpl, KindRunCtx, MentionCtx, MentionImpl,
  MentionOption, MethodImpl, SectionerImpl,
} from '../declare.ts';
import type { AnyFnDef, FnTypes, Handlers, Outcome, ProgressDef, UntypedFn } from '../fn.ts';
import type { FnImpl } from '../impl.ts';
import type { AnyFnRef } from '../refs.ts';
import type { ResourceProvider } from '../resources.ts';
import { checkedModels, runtimeProviderOf, type ProviderImpl } from '../providers.ts';
import type { Provider } from '@aeye/ai';
import type { ToolClaims } from '@aeye/core';
import { refuseOldEmbedders, type AnyContract, type ConnectImpl, type ContractShape, type EventHandlers, type Lifecycle, type SystemImpl } from '../system.ts';
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
  invalid(problems: string | readonly InputProblem[], extra?: { cost?: Usd }): AnyOutcome;
  fail(cls: ErrorClass, message: string, extra?: { code?: string; data?: Json; undo?: unknown; cost?: Usd }): AnyOutcome;
  pause(state: unknown, extra?: { cost?: Usd }): AnyOutcome;
  cancelled(extra?: { partial?: unknown; undo?: unknown; cost?: Usd }): AnyOutcome;
}

/** What every run context has besides its calls, handlers and progress. */
export interface RuntimeRunBase extends Services, OutcomeHelpers, Proposals, Decisions, Fleets, FnSearch, RunNotices {
  readonly config: unknown;
  readonly run: RunInfo;
  readonly budget: BudgetInfo;
  readonly signal: AbortSignal;
  readonly state: SessionState<Record<string, unknown>>;
  readonly form: (() => Promise<unknown>) | undefined;
  readonly resume: Resume<unknown> | undefined;
  readonly connection: RunConnection | undefined;
  readonly approved: ApprovedRun | undefined;
  updateConnection(update: ConnectionUpdate['update']): Promise<void>;
  shareFn(fn: string, share: ShareRule): Promise<void>;
  usableFns(fns: readonly string[]): Promise<string[]>;
  onPause(hook: () => unknown): void;
  allow(operations: Partial<AllowedOperations>): void;
  undoWith(payload: unknown): void;
  expose(fn: AnyFnRef, detail?: Detail): void;
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
  preview?(args: unknown, ctx: PreviewCtx): Promise<PreviewAnswer>;
  flags?(args: unknown, ctx: PreviewCtx): Promise<SensitivityFlag[]>;
  claims?(args: unknown, ctx: ClaimsCtx): ToolClaims | Promise<ToolClaims>;
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
  preview?(payload: unknown, args: Json, ctx: PreviewCtx): Promise<PreviewAnswer>;
  estimate?(payload: unknown, input: KindEstimateInput, ctx: SystemCtx): Promise<CostEstimate | undefined>;
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
  exporting?(ctx: SystemCtx & { readonly timeout: number }): Promise<void>;
}

/** A per-person system's connect flow, as the runtime calls it. */
export interface RuntimeConnectImpl {
  start(request: ConnectStart, ctx: SystemCtx): Promise<{ url: string }> | { url: string };
  finish(request: ConnectFinish, ctx: SystemCtx): Promise<ConnectResult>;
  disconnect(connection: Pick<RunConnection, 'id' | 'owner' | 'credentials'>, ctx: SystemCtx): Promise<void>;
}

/** A system's implementation by section and local name. */
export interface ImplTable {
  readonly fns?: Readonly<Record<string, RuntimeFnImpl>>;
  readonly types?: Readonly<Record<string, Readonly<Record<string, RuntimeMethodImpl>>>>;
  readonly kinds?: Readonly<Record<string, RuntimeKindImpl>>;
  readonly context?: Readonly<Record<string, (args: Record<string, string>, ctx: RuntimeContextCtx) => Promise<string>>>;
  readonly hooks?: Readonly<Record<string, (input: HookInput, ctx: SystemCtx) => Promise<HookContribution[]>>>;
  readonly mentions?: Readonly<Record<string, RuntimeMentionImpl>>;
  readonly sectioners?: Readonly<Record<string, SectionerImpl>>;
  readonly actions?: Readonly<Record<string, (input: unknown, ctx: ActionCtx<Record<string, unknown>>) => Promise<unknown>>>;
  readonly resources?: ResourceProvider;
  readonly providers?: Readonly<Record<string, (ctx: SystemCtx) => Provider>>;
  readonly connect?: RuntimeConnectImpl;
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
expectType<Equal<RuntimeSection<'sectioners'>, AuthorSection<SectionerImpl>>>(true);
expectType<Equal<RuntimeSection<'actions'>, AuthorSection<ActionImpl<unknown, unknown, Record<string, unknown>, object>>>>(true);
expectType<Equal<RuntimeSection<'resources'>, Erased<ResourceProvider>>>(true);
expectType<Equal<RuntimeSection<'providers'>, AuthorSection<ProviderImpl<object>>>>(true);
expectType<Equal<RuntimeSection<'connect'>, Erased<ConnectImpl<object>>>>(true);
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

/**
 * A change to a running system's declarations, in core's shapes (`RunningSystem.patch`): entries to add or replace
 * by name in any section, names to remove (the contract's own entries too), the top-level lists (providers,
 * registries, contributions) each replaced whole, and `roots` when its resource roots changed.
 */
export interface SystemPatch {
  readonly upsert?: { readonly [S in ManifestSection]?: readonly SectionDecl<S>[] };
  readonly remove?: { readonly [S in ManifestSection]?: readonly string[] };
  readonly lists?: ManifestPatch['lists'];
  readonly roots?: true;
}

/** Sections whose entries the system runs: a new entry needs an implementation already there. */
const IMPLEMENTED: { readonly [S in ManifestSection]?: (impl: ImplTable, name: string) => boolean } = {
  kinds: (impl, name) => impl.kinds?.[name] !== undefined,
  hooks: (impl, name) => impl.hooks?.[name] !== undefined,
  mentions: (impl, name) => impl.mentions?.[name] !== undefined,
  sectioners: (impl, name) => impl.sectioners?.[name] !== undefined,
  actions: (impl, name) => impl.actions?.[name] !== undefined,
};

/** The runtime's lookup of declarations and implementations. Runtime-added native fns join the contract's. */
export class SystemTable {
  readonly contract: AnyContract;
  readonly impl: ImplTable;
  readonly #added = new Map<string, { def: AnyFnDef; impl: RuntimeFnImpl | undefined }>();
  readonly #types = new Map<string, TypeDecl>();
  /** Entries a runtime patch added or replaced, by section and name. */
  readonly #patched: { readonly [S in ManifestSection]: Map<string, SectionDecl<S>> } = {
    types: new Map(), settings: new Map(), attachments: new Map(), kinds: new Map(), fns: new Map(), context: new Map(), hooks: new Map(), mentions: new Map(),
    sectioners: new Map(), actions: new Map(),
  };
  /** Contract entries a runtime patch removed, by section. */
  readonly #hidden = new Map<ManifestSection, Set<string>>();
  #lists: ManifestPatch['lists'];
  readonly #listeners = new Set<() => void>();
  /** The contract's runtime provider (`provider({ models: 'runtime' })`), if it has one. */
  readonly runtimeProvider: string | undefined;
  /** The models the running system set for its runtime provider (`RunningSystem.models`). */
  #runtimeModels: readonly ProviderModelDecl[] = [];

  constructor(contract: AnyContract, impl: ImplTable) {
    refuseOldEmbedders(`system ${contract.name}'s implementation`, impl);
    this.contract = contract;
    this.impl = impl;
    this.runtimeProvider = runtimeProviderOf(contract.name, contract.defs.providers);
    for (const [local, def] of Object.entries(contract.defs.fns)) { checkHooks(contract.name, local, def, impl.fns?.[local]); }
    for (const [local, def] of Object.entries(contract.defs.kinds)) {
      if (def.estimates && impl.kinds?.[local] !== undefined && impl.kinds[local].estimate === undefined) {
        throw new Error(`kind ${contract.name}/${local} says it estimates, so its implementation needs an estimate(payload, input, ctx).`);
      }
    }
  }

  /** Add a fn at runtime; native fns bring their implementation. */
  add(local: string, def: AnyFnDef, impl: RuntimeFnImpl | undefined): void {
    if (local in this.contract.defs.fns || this.#added.has(local)) { throw new Error(`fn ${local} already exists in ${this.contract.name}`); }
    checkHooks(this.contract.name, local, def, impl);
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

  /** Add or replace types at runtime (a database's table types), and remove ones added earlier by local name. */
  setTypes(upsert: readonly TypeDecl[], remove: readonly string[]): void {
    for (const name of remove) { this.#types.delete(name); }
    for (const decl of upsert) {
      if (decl.name in this.contract.defs.types) { throw new Error(`type ${decl.name} is part of ${this.contract.name}'s contract`); }
      this.#types.set(decl.name, decl);
    }
  }

  /**
   * Apply a runtime patch's declarations, checked first (nothing changes when one is wrong): upserts replace by name or
   * add, removes drop runtime entries and hide contract ones (a removed contract fn no longer runs). A native fn is
   * added with `add` (it brings its code); a new kind, hook, mention, sectioner or action needs its
   * implementation already in the system.
   */
  patch(change: SystemPatch): void {
    const upsert = change.upsert ?? {};
    const remove = change.remove ?? {};
    for (const section of MANIFEST_SECTION_NAMES) {
      for (const decl of upsert[section] ?? []) { this.#checkUpsert(section, MANIFEST_SECTIONS[section].parse(decl)); }
      for (const name of remove[section] ?? []) {
        if (!this.#declares(section, name)) { throw new Error(`${this.contract.name} has no ${section} entry ${name} to remove.`); }
      }
    }
    for (const section of MANIFEST_SECTION_NAMES) {
      for (const name of remove[section] ?? []) { this.#removeEntry(section, name); }
      this.#upsertAll(section, upsert[section] ?? []);
    }
    if (change.lists !== undefined) { this.#lists = { ...this.#lists, ...change.lists }; }
    this.#changed();
  }

  /** A section as it is now: `base` (the contract's and `add`/`setTypes` entries) with the patch's removes and upserts. */
  overlay<S extends ManifestSection>(section: S, base: readonly SectionDecl<S>[]): SectionDecl<S>[] {
    const hidden = this.#hidden.get(section);
    const patched: Map<string, SectionDecl<S>> = this.#patched[section];
    const kept = base.filter((decl) => hidden?.has(decl.name) !== true).map((decl) => patched.get(decl.name) ?? decl);
    const names = new Set(kept.map((decl) => decl.name));
    return [...kept, ...[...patched.values()].filter((decl) => !names.has(decl.name))];
  }

  /** Set the runtime provider's models (checked: each one's shape, no id twice). */
  setRuntimeModels(models: readonly ProviderModelDecl[]): void {
    if (this.runtimeProvider === undefined) { throw new Error(`${this.contract.name} has no runtime provider: declare one with provider({ description, models: 'runtime' }).`); }
    this.#runtimeModels = checkedModels(models);
    this.#changed();
  }

  /** The runtime provider's models now. */
  runtimeModels(): readonly ProviderModelDecl[] {
    return this.#runtimeModels;
  }

  /** The lists a patch replaced (each one whole), if any. */
  lists(): ManifestPatch['lists'] {
    return this.#lists;
  }

  #checkUpsert<S extends ManifestSection>(section: S, decl: SectionDecl<S>): void {
    if (section === 'types' && decl.name in this.contract.defs.types) { throw new Error(`type ${decl.name} is part of ${this.contract.name}'s contract`); }
    if (section === 'fns' && 'kind' in decl && decl.kind === 'native' && this.impl.fns?.[decl.name] === undefined && this.#added.get(decl.name)?.impl === undefined) {
      throw new Error(`fn ${decl.name} is native: add it with its implementation (add()).`);
    }
    const implemented = IMPLEMENTED[section];
    if (implemented !== undefined && !implemented(this.impl, decl.name)) {
      throw new Error(`${this.contract.name} has no implementation for the ${section} entry ${decl.name}.`);
    }
  }

  #upsertAll<S extends ManifestSection>(section: S, decls: readonly SectionDecl<S>[]): void {
    const patched: Map<string, SectionDecl<S>> = this.#patched[section];
    for (const decl of decls) {
      patched.set(decl.name, decl);
      this.#hidden.get(section)?.delete(decl.name);
    }
  }

  #removeEntry(section: ManifestSection, name: string): void {
    this.#patched[section].delete(name);
    if (section === 'fns' && this.#added.delete(name)) { return; }
    if (section === 'types' && this.#types.delete(name)) { return; }
    if (this.#inContract(section, name)) { this.#hidden.set(section, new Set([...(this.#hidden.get(section) ?? []), name])); }
  }

  /** Whether the system declares an entry now (its contract's, unless hidden, or a runtime one). */
  #declares(section: ManifestSection, name: string): boolean {
    if (this.#patched[section].has(name)) { return true; }
    if (section === 'fns' && this.#added.has(name)) { return true; }
    if (section === 'types' && this.#types.has(name)) { return true; }
    return this.#inContract(section, name) && !this.#isHidden(section, name);
  }

  #inContract(section: ManifestSection, name: string): boolean {
    return name in this.contract.defs[section];
  }

  /** Whether a patch removed this contract fn, so it no longer runs. */
  #isHidden(section: ManifestSection, name: string): boolean {
    return this.#hidden.get(section)?.has(name) === true;
  }

  /**
   * The entries added or replaced while running, by local name per section (`Manifest.runtime`): fns from `add`,
   * types from `setTypes`, and every patch upsert still in place. The hub keeps their records' origin `runtime`.
   */
  runtimeEntries(): NonNullable<Manifest['runtime']> {
    const out: { [S in ManifestSection]?: string[] } = {};
    for (const section of MANIFEST_SECTION_NAMES) {
      const names = new Set<string>(this.#patched[section].keys());
      if (section === 'fns') { for (const name of this.#added.keys()) { names.add(name); } }
      if (section === 'types') { for (const name of this.#types.keys()) { names.add(name); } }
      if (names.size > 0) { out[section] = [...names].sort(); }
    }
    return out;
  }

  /** The types added at runtime, by local name. */
  addedTypes(): ReadonlyMap<string, TypeDecl> {
    return this.#types;
  }

  /** The fns added at runtime, by local name. */
  added(): ReadonlyMap<string, { def: AnyFnDef; impl: RuntimeFnImpl | undefined }> {
    return this.#added;
  }

  /** A fn's declaration by local name: the contract's, a runtime one, or a type's method (`Entry.reveal`). */
  fnDef(local: string): AnyFnDef | undefined {
    const method = splitMethod(local);
    if (method !== undefined) { return this.#isHidden('types', method.type) ? undefined : this.typeDef(method.type)?.methods[method.method]; }
    if (this.#isHidden('fns', local)) { return undefined; }
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

/**
 * A native fn that asks for approval with a preview must implement `preview`; one that declares `flags` must implement
 * `flags`, and one that declares `dynamicClaims` must implement `claims`. Only a native fn can declare `flags` or
 * `dynamicClaims` (its system knows what its args name).
 */
function checkHooks(system: string, local: string, def: AnyFnDef, impl: RuntimeFnImpl | undefined): void {
  if (def.kind === 'native' && def.approval?.preview === true && impl !== undefined && impl.preview === undefined) {
    throw new Error(`${system}/${local} asks for approval with a preview, so its implementation needs a preview(args, ctx).`);
  }
  if (def.flags && def.kind !== 'native') {
    throw new Error(`${system}/${local} declares flags, but only a native fn can say which files it touches.`);
  }
  if (def.flags && impl !== undefined && impl.flags === undefined) {
    throw new Error(`${system}/${local} declares flags, so its implementation needs a flags(args, ctx).`);
  }
  if (def.dynamicClaims && def.kind !== 'native') {
    throw new Error(`${system}/${local} declares dynamicClaims, but only a native fn can work out its claims.`);
  }
  if (def.dynamicClaims && impl !== undefined && impl.claims === undefined) {
    throw new Error(`${system}/${local} declares dynamicClaims, so its implementation needs a claims(args, ctx).`);
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

