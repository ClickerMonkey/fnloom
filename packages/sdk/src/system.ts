/**
 * Declaring a system: `system(name, info)` starts a contract and `.with(...)` adds to it, any number of times; each
 * call can use the refs declared before it. The implementation's type (`SystemImpl`) is computed from the contract,
 * so everything declared must be implemented and nothing undeclared can be.
 */
import { SystemName, qualify, type Duration, type QualifiedName, type SystemEvent, type StopReason } from '@harness/core';
import type { SystemCtx } from './ctx.ts';
import type {
  ActionDef, ActionImpl, AnyContextDef, AnyTypeDef, AttachmentDef, ContextDef, ContextImpl, EmbedderDef, EmbedderImpl, HookDef, HookImpl,
  KindDef, KindImpl, MentionDef, MentionImpl, MethodImpl, SectionerDef, SectionerImpl, SettingDef, TypeDef,
} from './declare.ts';
import { kindFn, type AnyFnDef, type FnDef, type FnTypes, type TypesOf } from './fn.ts';
import type { FnImpl } from './impl.ts';
import { g, type GinType, type Infer } from './gin.ts';
import type {
  ActionRef, AttachmentRef, ContextRef, EmbedderRef, FnRef, HookRef, KindRef, MentionRef, Methods, MethodRefs, SectionerRef, SettingRef, TypeRef,
} from './refs.ts';
import { entriesOf, mapValues, type Simplify } from './util.ts';
import type { ResourceProvider } from './resources.ts';

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
  embedders: Record<string, EmbedderDef>;
  sectioners: Record<string, SectionerDef>;
  actions: Record<string, ActionDef<unknown, unknown, object>>;
}

/** The sections of a contract other than `config`. */
export type ContractSection = Exclude<keyof ContractShape, 'config'>;

/** The contract sections, in the order the manifest lists them. */
export const CONTRACT_SECTIONS = ['types', 'settings', 'attachments', 'kinds', 'fns', 'context', 'hooks', 'mentions', 'embedders', 'sectioners', 'actions'] as const satisfies readonly ContractSection[];

/** A contract with nothing in it yet. Its config is the empty object. */
export interface EmptyContract {
  config: GinType<{}>;
  types: {}; settings: {}; attachments: {}; kinds: {}; fns: {}; context: {}; hooks: {}; mentions: {}; embedders: {}; sectioners: {}; actions: {};
}

/** A contract with more sections merged in: `config` is replaced, every other section adds to what was declared. */
export type Merge<C extends ContractShape, P extends Partial<ContractShape>> = {
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
  types: {}, settings: {}, attachments: {}, kinds: {}, fns: {}, context: {}, hooks: {}, mentions: {}, embedders: {}, sectioners: {}, actions: {},
});

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
    embedders: part.embedders === undefined ? out.embedders : mapValues(part.embedders, (def, key) => ({ ref: 'embedder', name: q(key), dimensions: def.dimensions })),
    sectioners: part.sectioners === undefined ? out.sectioners : mapValues(part.sectioners, (_def, key) => ({ ref: 'sectioner', name: q(key) })),
    actions: part.actions === undefined ? out.actions : mapValues(part.actions, (def, key) => ({ ref: 'action', name: q(key), input: def.input, returns: def.returns })),
  };
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

function assemble<N extends string, C extends ContractShape>(name: N, description: string, defs: C, refs: AnyRefs): SystemContract<N, C> {
  const contract = {
    name,
    description,
    defs,
    ...refs,
    with<const P extends Partial<ContractShape>>(part: P | ((self: SystemRefs<N, C>) => P)): SystemContract<N, Merge<C, P>> {
      const added = typeof part === 'function' ? part(self) : part;
      const problems = clashes(defs, added);
      if (problems.length > 0) { throw new Error(`system ${name}: ${problems.join('; ')}`); }
      const more = refsOf(name, added);
      const merged = { config: added.config ?? defs.config } as Record<string, unknown>; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- filled per section just below
      const mergedRefs: AnyRefs = EMPTY_SECTIONS();
      for (const section of CONTRACT_SECTIONS) {
        merged[section] = { ...defs[section], ...added[section] };
        mergedRefs[section] = { ...refs[section], ...more[section] };
      }
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `merged` holds every section of C with P's added: exactly Merge<C, P>
      return assemble(name, description, merged as Merge<C, P>, mergedRefs);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the refs were built from `defs` section by section, which is what SystemRefs<N, C> maps
  const self = contract as unknown as SystemContract<N, C>;
  return self;
}

/** Start a contract. The name must be unique among the hub's systems: lowercase letters, digits and dashes. */
export function system<const N extends string>(name: N, info: { description: string }): SystemContract<N, EmptyContract> {
  SystemName.parse(name);
  const defs: EmptyContract = { config: g.obj({}), ...EMPTY_SECTIONS() };
  return assemble(name, info.description, defs, EMPTY_SECTIONS());
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
  /** Someone changed the config. Runs already going keep the value they started with. */
  configured?(ctx: SystemCtx<Cfg> & { readonly previous: Cfg }): Promise<void>;
  /** Before it stops. The hub waits up to `timeout`. */
  stopping?(ctx: SystemCtx<Cfg> & { readonly reason: StopReason; readonly timeout: Duration }): Promise<void>;
  /** The first start of a new version; `from` is the version it replaced. */
  upgraded?(ctx: SystemCtx<Cfg> & { readonly from: string }): Promise<void>;
  /** An admin removed it; clean up anything it keeps outside the hub. */
  uninstalled?(ctx: SystemCtx<Cfg>): Promise<void>;
}

/**
 * A system's implementation, computed from its contract. It must implement exactly what the contract declares: every
 * native fn, every method of its types, every kind, every dynamic context, hook, mention provider, embedder,
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
    /** Hub events to receive. */
    readonly events?: EventHandlers<ConfigOf<C>>;
    readonly lifecycle?: Lifecycle<ConfigOf<C>>;
  };

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
