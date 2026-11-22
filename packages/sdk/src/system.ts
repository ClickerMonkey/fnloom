/**
 * Declaring a system: `system(name, info)` starts a contract and `.with(...)` adds to it, any number of times; each
 * call can use the refs declared before it. The implementation's type (`SystemImpl`) is computed from the contract,
 * so everything declared must be implemented and nothing undeclared can be.
 */
import { ApiGroupDecl, ConfigComponentDecl, ConfigPath, ConnectDecl, ContributionDecl, SystemGrants, SystemName, SystemPageDecl, qualify, systemPageProblems, type SystemPageInput, type ConnectFinish, type ConnectResult, type ConnectStart, type Duration, type RunConnection, type QualifiedName, type SystemEvent, type StopReason } from '@harness/core';
import type { SystemCtx } from './ctx.ts';
import type {
  ActionDef, ActionImpl, AnyContextDef, AnyTypeDef, AttachmentDef, ContextDef, ContextImpl, HookDef, HookImpl,
  KindDef, KindImpl, MentionDef, MentionImpl, MethodImpl, SectionerDef, SectionerImpl, SettingDef, TypeDef,
} from './declare.ts';
import { kindFn, type AnyFnDef, type FnDef, type FnTypes, type TypesOf } from './fn.ts';
import type { FnImpl } from './impl.ts';
import { g, type GinType, type Infer } from './gin.ts';
import type {
  ActionRef, AttachmentRef, ContextRef, FnRef, HookRef, KindRef, MentionRef, Methods, MethodRefs, ProviderRef, SectionerRef, SettingRef, TypeRef,
} from './refs.ts';
import { entriesOf, mapValues, type Simplify } from './util.ts';
import type { ResourceProvider } from './resources.ts';
import type { ProviderDef, ProviderImpl } from './providers.ts';

/** Everything a contract can hold, by section. */
export interface ContractShape {
  /** What the system needs before it can be used; see `ConfigOf`. */
  config: GinType<object>;
  types: Record<string, AnyTypeDef>;
  settings: Record<string, SettingDef<unknown>>;
  attachments: Record<string, AttachmentDef<unknown>>;
  kinds: Record<string, KindDef<unknown>>;
  fns: Record<string, AnyFnDef>;
  context: Record<string, AnyContextDef>;
  hooks: Record<string, HookDef>;
  mentions: Record<string, MentionDef<unknown, unknown>>;
  sectioners: Record<string, SectionerDef>;
  actions: Record<string, ActionDef<unknown, unknown, object>>;
  /** Model providers it brings (`provider()`), served by its implementation. */
  providers: Record<string, ProviderDef>;
  /**
   * A per-person system's `connect` declaration (manifest `connect`): each person connects their own account and its
   * fns act as them. `undefined` for a system everyone shares. The implementation then serves `connect`.
   */
  connect: ConnectDecl | undefined;
}

/** The sections of a contract that add named declarations (all but `config` and `connect`). */
export type ContractSection = Exclude<keyof ContractShape, 'config' | 'connect'>;

/** The contract sections, in the order the manifest lists them. */
export const CONTRACT_SECTIONS = ['types', 'settings', 'attachments', 'kinds', 'fns', 'context', 'hooks', 'mentions', 'sectioners', 'actions', 'providers'] as const satisfies readonly ContractSection[];

/** A contract with nothing in it yet. Its config is the empty object. */
export interface EmptyContract {
  config: GinType<{}>;
  types: {}; settings: {}; attachments: {}; kinds: {}; fns: {}; context: {}; hooks: {}; mentions: {}; sectioners: {}; actions: {}; providers: {};
  connect: undefined;
}

/** A contract with more sections merged in: `config` and `connect` are replaced, every other section adds to what was declared. */
export type Merge<C extends ContractShape, P extends Partial<ContractShape>> = {
  [K in keyof ContractShape]: K extends 'config'
    ? (P extends { config: infer X extends GinType<object> } ? X : C['config'])
    : K extends 'connect'
      ? (P extends { connect: infer X extends ConnectDecl } ? X : C['connect'])
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
  readonly sectioners: { readonly [K in keyof C['sectioners']]: SectionerRef<Q<N, K>> };
  readonly actions: { readonly [K in keyof C['actions']]: C['actions'][K] extends ActionDef<infer I, infer R, object> ? ActionRef<Q<N, K>, I, R> : never };
  readonly providers: { readonly [K in keyof C['providers']]: ProviderRef<Q<N, K>> };
}

/**
 * A system's contract, in `shared/`: its name and everything it offers, with no implementation. Safe to import from
 * anywhere, the browser included.
 *
 * ```ts
 * export const fs = system('fs', { description: 'Files and a shell.' })
 *   .with({ types: { Entry }, fns: { read: fn({...}), grep: fn({...}) } })
 *   .with(({ fns }) => ({ context: { guide: context({ description: '…', content: '…', fns: [fns.read, fns.grep] }) } }));
 * ```
 */
export interface SystemContract<N extends string, C extends ContractShape> extends SystemRefs<N, C> {
  readonly description: string;
  /** What the chat model is told about it in its `<systems>` list (`SystemInfo.about`); absent, its description. */
  readonly about: string | undefined;
  /** Registries it hosts, by local name. */
  readonly registries: Readonly<Record<string, RegistryDef>>;
  /** Entries it adds to registries, its own or another system's. */
  readonly contributes: readonly ContributionDecl[];
  /** The dot paths of its config's secret text fields. */
  readonly configSecrets: readonly ConfigPath[];
  /** What it may do through the hub (and, hosted, on its machine); `undefined` gets the base only. */
  readonly grants: SystemGrants | undefined;
  /** Its own config component (a client export), drawn instead of or beside the gin form. */
  readonly configComponent: ConfigComponentDecl | undefined;
  /** Whole pages it adds to the web app (`/s/<system>/<segment>`), each drawn by a component in `client({ pages })`. */
  readonly pages: readonly SystemPageDecl[];
  /** Its API groups, each described once; a fn names its group with `fn({ group })`. */
  readonly groups: readonly ApiGroupDecl[];
  /** The declarations themselves. */
  readonly defs: C;
  /** Add declarations: any sections, given directly or built from the refs so far. */
  with<const P extends Partial<ContractShape>>(part: P | ((self: SystemRefs<N, C>) => P)): SystemContract<N, Merge<C, P>>;
}

export type AnyContract = SystemContract<string, ContractShape>;

/** A system's config type: what it needs before it can be used. The value is in every context as `ctx.config`. */
export type ConfigOf<C extends ContractShape> = Infer<C['config']>;

// ─── Building contracts ───────────────────────────────────────────────────────

type AnyRefs = { -readonly [K in ContractSection]: Record<string, unknown> };

const EMPTY_SECTIONS = (): { [K in ContractSection]: {} } => ({
  types: {}, settings: {}, attachments: {}, kinds: {}, fns: {}, context: {}, hooks: {}, mentions: {}, sectioners: {}, actions: {}, providers: {},
});

/** A registry a system hosts: what it is for and the data each entry is drawn with (a `ResultTable` for query visuals). */
export interface RegistryDef {
  readonly description: string;
  readonly data: GinType;
}

/** What `system()` takes besides its name. */
export interface SystemInfo {
  description: string;
  /**
   * What a chat model that has never seen this app is told about the system in its system prompt's `<systems>` list,
   * in place of the one-line `description`: what it is for, what sort of fns it has, whether it defines fn kinds and
   * what authoring one gives the person, and when to reach for it (and when not). A few plain sentences; the hub
   * shows it as written. Absent, the list shows `description`.
   */
  about?: string;
  /**
   * Registries this system hosts, by local name. Any system, this one included, adds entries from its client bundle
   * (`client({ visuals })`) and lists them in `contributes`.
   */
  registries?: Record<string, RegistryDef>;
  /** Entries this system adds to registries (`{ registry: 'hub/visuals', name: 'map', label: 'Map' }`). */
  contributes?: ContributionDecl[];
  /**
   * The dot paths of its config's secret text fields (`connection.password`). The hub seals them when the config is
   * saved and only `configure` carries the plain value. Each must be a text field of the config type.
   */
  configSecrets?: ConfigPath[];
  /**
   * What the system may do through the hub beyond the base: the hub capabilities it calls (`ai`, `embed`, `fns`,
   * …), model roles and spend, secrets, the fns it calls, and (when fs hosts it) the hosts and paths it reaches. The
   * hub enforces them over the link, logs every refusal, and shows them on the review page. Absent, the base only.
   */
  grants?: SystemGrants;
  /**
   * Its own config component: the name of a Vue component its client exports (`client({ components })`), drawn
   * `replace` (instead of the gin form) or `beside` it on the review, system and pairing pages. The hub still checks
   * the value with the config's gin type before saving.
   */
  configComponent?: ConfigComponentDecl;
  /**
   * Whole pages it adds to the web app, each at `/s/<system>/<segment>`: `{ segment: 'sessions', title: 'Claude', icon:
   * 'code', nav: 'main', access: 'everyone', component: 'SessionsPage' }`. The component is drawn from the client build
   * (`client({ pages: { SessionsPage } })`), which must have every one named. The nav shows a `main` page while the
   * system is live; a `hidden` one is reached by link (a detail page). Segments are unique.
   */
  pages?: SystemPageInput[];
  /**
   * Its API groups: a name, a title and what the group's fns are for (`{ name: 'files', title: 'Files', description:
   * 'Read, write and search files.' }`). The hub keeps an index item for the system (`<system>/api`, the groups as
   * choices) and one per group listing its fns, so a model walks the API like a context folder. A fn names its group
   * with `fn({ group })`; a fn with none is in the general group. Every group a fn names must be declared here.
   */
  groups?: ApiGroupDecl[];
}

/** The parts of a contract that are not declaration sections. */
type ContractExtras = Pick<SystemContract<string, ContractShape>, 'description' | 'about' | 'registries' | 'contributes' | 'configSecrets' | 'grants' | 'configComponent' | 'pages' | 'groups'>;

/** The ref of a named type: a gin extension registered in `g` under its qualified name, carrying display and methods. */
function typeRef(system: string, local: string, def: AnyTypeDef): TypeRef<QualifiedName, unknown, Methods> {
  const name = qualify(system, local);
  const base = g.extend(def.shape, { name, docs: def.description });
  const methods: MethodRefs<QualifiedName, unknown, Methods> = mapValues(def.methods, (method, key) => ({
    ref: 'fn' as const,
    name: `${name}.${key}` as const,
    args: g.and([g.obj({ self: base }), method.args]),
    returns: method.returns,
    handlers: method.handlers,
  }));
  const ref = Object.assign(base, { ref: 'type' as const, name, display: def.display, description: def.description, methods });
  g.register(ref);
  return ref;
}

function kindRef(system: string, local: string, def: KindDef<unknown>): KindRef<QualifiedName, unknown> {
  const ref: KindRef<QualifiedName, unknown> = {
    ref: 'kind',
    name: qualify(system, local),
    payload: def.payload,
    fn: (input) => kindFn(ref, input),
  };
  return ref;
}

/** Make the refs for one part of a contract. */
function refsOf(system: string, part: Partial<ContractShape>): AnyRefs {
  const out = EMPTY_SECTIONS();
  const q = (local: string) => qualify(system, local);
  return {
    types: part.types === undefined ? out.types : mapValues(part.types, (def, key) => typeRef(system, key, def)),
    settings: part.settings === undefined ? out.settings : mapValues(part.settings, (def, key) => ({ ref: 'setting', name: q(key), type: def.type })),
    attachments: part.attachments === undefined ? out.attachments : mapValues(part.attachments, (def, key) => ({ ref: 'attachment', name: q(key), data: def.data })),
    kinds: part.kinds === undefined ? out.kinds : mapValues(part.kinds, (def, key) => kindRef(system, key, def)),
    fns: part.fns === undefined ? out.fns : mapValues(part.fns, (def, key) => ({ ref: 'fn', name: q(key), args: def.args, returns: def.returns, handlers: def.handlers })),
    context: part.context === undefined ? out.context : mapValues(part.context, (_def, key) => ({ ref: 'context', name: q(key) })),
    hooks: part.hooks === undefined ? out.hooks : mapValues(part.hooks, (_def, key) => ({ ref: 'hook', name: q(key) })),
    mentions: part.mentions === undefined ? out.mentions : mapValues(part.mentions, (def, key) => ({ ref: 'mention', name: q(key), target: def.target })),
    sectioners: part.sectioners === undefined ? out.sectioners : mapValues(part.sectioners, (_def, key) => ({ ref: 'sectioner', name: q(key) })),
    actions: part.actions === undefined ? out.actions : mapValues(part.actions, (def, key) => ({ ref: 'action', name: q(key), input: def.input, returns: def.returns })),
    providers: part.providers === undefined ? out.providers : mapValues(part.providers, (_def, key) => ({ ref: 'provider', name: q(key) })),
  };
}

/**
 * Embedders are model providers now. A contract part or an implementation that still holds the old `embedders` section
 * is refused, since the hub would never call it; the message says what to write instead.
 */
export function refuseOldEmbedders(where: string, part: object): void {
  if (!('embedders' in part)) { return; }
  throw new Error(
    `${where}: \`embedders\` is no longer a section, so the hub would never call these. An embedder is a model provider now: `
    + 'declare it under `providers` with provider({ description, models: [{ id, capabilities: [\'embedding\'], dimensions, maxInput, contextWindow, pricing, caching }] }) '
    + 'and implement it as a function giving an aeye Provider whose `embed` answers (AUTHORING.md, "Model providers").',
  );
}

/** Problems with one part of a contract: names declared twice, in this part or before it. */
function clashes(defs: ContractShape, part: Partial<ContractShape>): string[] {
  const problems: string[] = [];
  for (const section of CONTRACT_SECTIONS) {
    const added = part[section];
    if (added === undefined) { continue; }
    for (const [key] of entriesOf(added)) {
      if (key in defs[section]) { problems.push(`${section}.${key} is declared twice`); }
    }
  }
  return problems;
}

function assemble<N extends string, C extends ContractShape>(name: N, extras: ContractExtras, defs: C, refs: AnyRefs): SystemContract<N, C> {
  const contract = {
    name,
    ...extras,
    defs,
    ...refs,
    with<const P extends Partial<ContractShape>>(part: P | ((self: SystemRefs<N, C>) => P)): SystemContract<N, Merge<C, P>> {
      const added = typeof part === 'function' ? part(self) : part;
      refuseOldEmbedders(`system ${name}`, added);
      const problems = clashes(defs, added);
      if (problems.length > 0) { throw new Error(`system ${name}: ${problems.join('; ')}`); }
      const more = refsOf(name, added);
      if (added.connect !== undefined && defs.connect !== undefined) { throw new Error(`system ${name}: connect is declared twice`); }
      const connect = added.connect === undefined ? defs.connect : ConnectDecl.parse(added.connect);
      const merged = { config: added.config ?? defs.config, connect } as Record<string, unknown>; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- filled per section just below
      const mergedRefs: AnyRefs = EMPTY_SECTIONS();
      for (const section of CONTRACT_SECTIONS) {
        merged[section] = { ...defs[section], ...added[section] };
        mergedRefs[section] = { ...refs[section], ...more[section] };
      }
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `merged` holds every section of C with P's added: exactly Merge<C, P>
      return assemble(name, extras, merged as Merge<C, P>, mergedRefs);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the refs were built from `defs` section by section, which is what SystemRefs<N, C> maps
  const self = contract as unknown as SystemContract<N, C>;
  madeContracts().add(self);
  return self;
}

const CONTRACTS_KEY = Symbol.for('harness.contracts');

/** Every contract `system()` made, in this process, shared by every copy of the SDK loaded in it. */
function madeContracts(): WeakSet<object> {
  const kept: unknown = Reflect.get(globalThis, CONTRACTS_KEY);
  if (kept instanceof WeakSet) { return kept; }
  const made = new WeakSet<object>();
  Reflect.set(globalThis, CONTRACTS_KEY, made);
  return made;
}

/** Whether a value is a contract `system()` made (a module's exports, read by a build). */
export function isSystemContract(value: unknown): value is AnyContract {
  return typeof value === 'object' && value !== null && madeContracts().has(value);
}

/** A contract's pages, checked: segments are unique. */
function checkedPages(system: string, pages: SystemPageDecl[]): SystemPageDecl[] {
  const problems = systemPageProblems(pages);
  if (problems.length > 0) { throw new Error(`system ${system}: ${problems.join('; ')}.`); }
  return pages;
}

/** Start a contract. The name must be unique among the hub's systems: lowercase letters, digits and dashes. */
export function system<const N extends string>(name: N, info: SystemInfo): SystemContract<N, EmptyContract> {
  SystemName.parse(name);
  const defs: EmptyContract = { config: g.obj({}), connect: undefined, ...EMPTY_SECTIONS() };
  const extras: ContractExtras = {
    description: info.description,
    about: info.about,
    registries: { ...info.registries },
    contributes: (info.contributes ?? []).map((c) => ContributionDecl.parse(c)),
    configSecrets: (info.configSecrets ?? []).map((p) => ConfigPath.parse(p)),
    grants: info.grants === undefined ? undefined : SystemGrants.parse(info.grants),
    configComponent: info.configComponent === undefined ? undefined : ConfigComponentDecl.parse(info.configComponent),
    pages: checkedPages(name, (info.pages ?? []).map((page) => SystemPageDecl.parse(page))),
    groups: (info.groups ?? []).map((group) => ApiGroupDecl.parse(group)),
  };
  return assemble(name, extras, defs, EMPTY_SECTIONS());
}

// ─── Implementing a system ────────────────────────────────────────────────────

type NativeFnKeys<F> = { [K in keyof F]: F[K] extends FnDef<infer T> ? (T['kind'] extends 'native' ? K : never) : never }[keyof F];
type TypesWithMethods<X> = { [K in keyof X]: X[K] extends TypeDef<unknown, infer M> ? ([keyof M] extends [never] ? never : K) : never }[keyof X];
type DynamicContextKeys<X> = { [K in keyof X]: X[K] extends ContextDef<unknown, true> ? K : never }[keyof X];

/** A section of the implementation: required when the contract declares something there, forbidden when it doesn't. */
type Needs<K extends string, T> = [keyof T] extends [never] ? { readonly [P in K]?: never } : { readonly [P in K]: T };

/** Hub events a system handles, by event type. Subscriptions follow the handlers given. */
export type EventHandlers<Cfg> = {
  readonly [E in SystemEvent['type']]?: (event: Extract<SystemEvent, { type: E }>, ctx: SystemCtx<Cfg>) => Promise<void>;
};

/** Moments in a system's life. All optional; each gets the system's context with its current config. */
export interface Lifecycle<Cfg> {
  /** The first time it connects after being paired or installed (with a valid config). */
  installed?(ctx: SystemCtx<Cfg>): Promise<void>;
  /** Every time it connects with a valid config and its contract is imported. */
  started?(ctx: SystemCtx<Cfg>): Promise<void>;
  /**
   * Someone changed the config. `previous` is the value it replaced, or undefined when there was none (the first
   * config it gets while already running). Runs already going keep the value they started with.
   */
  configured?(ctx: SystemCtx<Cfg> & { readonly previous: Cfg | undefined }): Promise<void>;
  /** Before it stops. The hub waits up to `timeout`. */
  stopping?(ctx: SystemCtx<Cfg> & { readonly reason: StopReason; readonly timeout: Duration }): Promise<void>;
  /** The first start of a new version; `from` is the version it replaced. */
  upgraded?(ctx: SystemCtx<Cfg> & { readonly from: string }): Promise<void>;
  /** An admin removed it; clean up anything it keeps outside the hub. */
  uninstalled?(ctx: SystemCtx<Cfg>): Promise<void>;
  /**
   * The hub is about to copy `ctx.dataDir` for a data export: flush what is buffered and checkpoint an open database
   * so the copy is whole. The hub waits up to `timeout`; runs keep going.
   */
  exporting?(ctx: SystemCtx<Cfg> & { readonly timeout: Duration }): Promise<void>;
}

/**
 * A system's implementation, computed from its contract. It must implement exactly what the contract declares: every
 * native fn, every method of its types, every kind, every dynamic context, hook, mention provider,
 * sectioner, action and model provider.
 */
export type SystemImpl<C extends ContractShape> =
  Needs<'fns', { readonly [K in NativeFnKeys<C['fns']>]: FnImpl<TypesOf<C['fns'][K]>, ConfigOf<C>> }> &
  Needs<'kinds', { readonly [K in keyof C['kinds']]: C['kinds'][K] extends KindDef<infer P> ? KindImpl<P, ConfigOf<C>> : never }> &
  Needs<'context', { readonly [K in DynamicContextKeys<C['context']>]: C['context'][K] extends ContextDef<infer A, true> ? ContextImpl<A, ConfigOf<C>> : never }> &
  Needs<'hooks', { readonly [K in keyof C['hooks']]: HookImpl<ConfigOf<C>> }> &
  Needs<'mentions', { readonly [K in keyof C['mentions']]: C['mentions'][K] extends MentionDef<infer T, infer V> ? MentionImpl<T, V, ConfigOf<C>> : never }> &
  Needs<'types', { readonly [K in TypesWithMethods<C['types']>]: C['types'][K] extends TypeDef<infer V, infer M extends Methods> ? { readonly [J in keyof M]: MethodImpl<V, TypesOf<M[J]>, ConfigOf<C>> } : never }> &
  Needs<'sectioners', { readonly [K in keyof C['sectioners']]: SectionerImpl }> &
  Needs<'actions', { readonly [K in keyof C['actions']]: C['actions'][K] extends ActionDef<infer I, infer R, infer St> ? ActionImpl<I, R, St, ConfigOf<C>> : never }> &
  Needs<'providers', { readonly [K in keyof C['providers']]: ProviderImpl<ConfigOf<C>> }> &
  (C['connect'] extends ConnectDecl ? { readonly connect: ConnectImpl<ConfigOf<C>> } : { readonly connect?: never }) &
  {
    /** Resources this system serves. */
    readonly resources?: ResourceProvider;
    /** Hub events to receive. */
    readonly events?: EventHandlers<ConfigOf<C>>;
    readonly lifecycle?: Lifecycle<ConfigOf<C>>;
  };

/**
 * A per-person system's connect flow, as the hub's connect page drives it. `start` gives the URL to send the person
 * to (OAuth; `state` must come back unchanged on the hub's redirect); `finish` turns what came back (the redirect's
 * query, or the form) into the account and credentials, or a problem in words; `disconnect` revokes the credentials
 * where the provider can (best effort).
 */
export interface ConnectImpl<Cfg> {
  start(request: ConnectStart, ctx: SystemCtx<Cfg>): Promise<{ url: string }> | { url: string };
  finish(request: ConnectFinish, ctx: SystemCtx<Cfg>): Promise<ConnectResult>;
  disconnect(connection: Pick<RunConnection, 'id' | 'owner' | 'credentials'>, ctx: SystemCtx<Cfg>): Promise<void>;
}

/** Re-export for authors who write `FnTypes` by hand. */
export type { FnTypes };

/**
 * A contract's config type, typed by its value. `ConfigOf<C>` is gin's `Infer` of `C['config']`, which TypeScript
 * can't evaluate for a generic `C`; it is that type's value by definition.
 */
export function configTypeOf<C extends ContractShape>(defs: C): GinType<ConfigOf<C>> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Infer<C['config']> is exactly the value type of C['config']
  return defs.config as GinType<ConfigOf<C>>;
}
