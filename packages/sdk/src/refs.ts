/**
 * Refs: the typed handles a contract exports for everything it declares (`fs.fns.read`, `fs.types.Entry`). A
 * reference between things is always a ref, never a string, so a reference to something that doesn't exist doesn't
 * compile, and a call through a ref has typed args, result and handlers.
 */
import type { Extension } from '@aeye/gin';
import type { Json, QualifiedName, StatusTemplates, TypeDisplay } from '@harness/core';
import type { FnDef, FnTypes, Handlers, KindFnInput, KindFnTypes } from './fn.ts';
import type { GinType } from './gin.ts';
import type { Simplify } from './util.ts';

/**
 * Give a fn or context ref the text it writes in model-facing text: `${fns.read}` is `fn:fs/read`, which the hub renders
 * as the name the model calls the fn by (`fs__read`, or a static tool's name), and `${ctx.guide}` is `context:fs/guide`,
 * rendered as the plain key. So a rename is a compile error, never a stale sentence. Not enumerable, so a ref's JSON
 * and equality are unchanged.
 */
export function withRefText<T extends { readonly ref: 'fn' | 'context'; readonly name: string }>(ref: T): T {
  Object.defineProperty(ref, 'toString', { value: () => `${ref.ref}:${ref.name}`, enumerable: false, configurable: true });
  return ref;
}

/**
 * A typed handle to a fn: declare it as a dep, then call it with checked args, result and handlers. In a template
 * string it writes `fn:<its name>` (`withRefText`), which the hub renders as the name the model calls it by.
 */
export interface FnRef<N extends QualifiedName, A, R, H extends Handlers = {}> {
  readonly ref: 'fn';
  readonly name: N;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  readonly handlers: H;
  /** `fn:<its name>`, for model-facing text (`withRefText`). */
  toString(): string;
}
export type AnyFnRef = FnRef<QualifiedName, unknown, unknown, Handlers>;

/**
 * An agent fn's ref: a fn of the hub's `llm` kind (`agent()`, `hub.kinds.llm.fn()`), marked with its kind so only
 * agents fit where an agent is asked for (an injection's target). A plain fn's ref has no `kind` and doesn't compile.
 */
export type AgentRef<N extends QualifiedName = QualifiedName, A = unknown, R = unknown, H extends Handlers = Handlers> = FnRef<N, A, R, H> & { readonly kind: 'hub/llm' };

/** The ref of a fn as its contract declares it: an agent's carries its kind (`AgentRef`), any other fn's is a `FnRef`. */
export type FnRefOf<N extends QualifiedName, T extends FnTypes> = T['kind'] extends { readonly name: 'hub/llm' }
  ? AgentRef<N, T['args'], T['result'], T['handlers']>
  : FnRef<N, T['args'], T['result'], T['handlers']>;

/** A type's methods by name. Each is declared with `fn()` and implemented with the value it is called on. */
export type Methods = Record<string, FnDef<FnTypes>>;

/** A method's qualified name: `fs/Entry.reveal`. */
export type MethodName<N extends QualifiedName, K> = N extends `${infer S}/${infer L}` ? QualifiedName<S, `${L}.${K & string}`> : never;

/** The args of a method call: the value it is called on, as `self`, plus the method's own args. */
export type MethodArgs<T, A> = Simplify<{ self: T } & A>;

/** The fn refs of a type's methods. */
export type MethodRefs<N extends QualifiedName, T, M extends Methods> = {
  readonly [K in keyof M]: M[K] extends FnDef<infer F> ? FnRef<MethodName<N, K>, MethodArgs<T, F['args']>, F['result'], F['handlers']> : never;
};

/**
 * A typed handle to a named type (`fs.types.Entry`). It is a real gin type itself (a named gin extension, registered
 * in `g`), so other types can use it as a field: `g.obj({ entry: fs.types.Entry })`. Its methods are typed fn refs
 * that code calls with the value as `self`.
 */
export type TypeRef<N extends QualifiedName, T, M extends Methods = {}> = Extension<T> & {
  readonly ref: 'type';
  readonly name: N;
  readonly display: TypeDisplay;
  readonly description: string;
  readonly methods: MethodRefs<N, T, M>;
};
export type AnyTypeRef = TypeRef<QualifiedName, unknown, Methods>;

/** A typed handle to a fn kind. `kinds.api.fn({...})` declares a fn of that kind. */
export interface KindRef<N extends QualifiedName, P> {
  readonly ref: 'kind';
  readonly name: N;
  readonly payload: GinType<P>;
  /**
   * Declare a fn of this kind. Only the payload is needed; the kind derives the rest. Give `args`/`returns` to type
   * the ref (the hub checks them against what the kind derives); without them the ref takes and returns JSON.
   */
  fn<A = Json, R = Json, const T extends StatusTemplates = StatusTemplates>(def: KindFnInput<P, A, R, T>): FnDef<KindFnTypes<KindRef<N, P>, P, A, R>>;
}
export type AnyKindRef = KindRef<QualifiedName, unknown>;

/** A typed handle to context. A `/command`'s args are typed. In a template string it writes `context:<its key>`, rendered as the key. */
export interface ContextRef<N extends QualifiedName, A> {
  readonly ref: 'context';
  readonly name: N;
  /** Phantom: the command's args. Never set at runtime. */
  readonly args?: A;
  /** `context:<its key>`, for model-facing text (`withRefText`). */
  toString(): string;
}
export type AnyContextRef = ContextRef<QualifiedName, unknown>;

/** A typed handle to an actor setting. `ctx.setting(fs.settings.shell)` returns its typed value. */
export interface SettingRef<N extends QualifiedName, T> {
  readonly ref: 'setting';
  readonly name: N;
  readonly type: GinType<T>;
}

/** A typed handle to an attachment kind. `ctx.attach(fs.attachments.diff, data, title)` checks the data. */
export interface AttachmentRef<N extends QualifiedName, T> {
  readonly ref: 'attachment';
  readonly name: N;
  readonly data: GinType<T>;
}

/** A handle to a user-message hook. */
export interface HookRef<N extends QualifiedName> {
  readonly ref: 'hook';
  readonly name: N;
}
export type AnyHookRef = HookRef<QualifiedName>;

/** A typed handle to an `@` mention provider. */
export interface MentionRef<N extends QualifiedName, T> {
  readonly ref: 'mention';
  readonly name: N;
  readonly target: GinType<T>;
}

/** A handle to a model provider a system brings; the hub registers it under this name. */
export interface ProviderRef<N extends QualifiedName> {
  readonly ref: 'provider';
  readonly name: N;
}

/** A handle to a sectioner. */
export interface SectionerRef<N extends QualifiedName> {
  readonly ref: 'sectioner';
  readonly name: N;
}

/**
 * A typed handle to one of a system's pages (`schedule.page.item`), named `<system>/<segment>`: links to pages are
 * refs, never segment strings, so a link to a page that isn't declared, or to another system's page, doesn't compile.
 */
export interface PageRef<N extends QualifiedName> {
  readonly ref: 'page';
  readonly name: N;
  /** The system that declares it. */
  readonly system: string;
  /** Its segment: the page is at `/s/<system>/<segment>`. */
  readonly segment: string;
}
export type AnyPageRef = PageRef<QualifiedName>;

/** A typed handle to an action a system's renderers may send. */
export interface ActionRef<N extends QualifiedName, I, R> {
  readonly ref: 'action';
  readonly name: N;
  readonly input: GinType<I>;
  readonly returns: GinType<R>;
}
