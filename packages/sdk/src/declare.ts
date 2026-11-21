/**
 * Declaring everything else a contract holds: types, settings, attachments, kinds, context, hooks, mentions,
 * sectioners and actions. Each builder returns a plain declaration; `system().with()` turns them into
 * typed refs.
 */
import type {
  ActorKind, Audience, CostEstimate, DeclarableRelation, Duration, GinTypeDef, HookBlock, HookInput, Json, KindDescription, KindFnShape, MentionHover, QualifiedName, ResourceStat,
  ResourceUri, Section, SectionKey, PreviewAnswer,
  SectionMatch, SettingEditor, SettingMerge, StatusTemplates, StepStatus, TypeDisplay, UndoOutcome,
} from '@harness/core';
import { sectionKeys as structuralKeys } from '@aeye/resources/section-keys';
import { RecordStorage, SectionKey as SectionKeySchema } from '@harness/core';
import type { ActionCtx, AskerCtx, FnCall, FnCtx, PreviewCtx, SystemCtx, UndoCtx } from './ctx.ts';
import type { FnTypes, Outcome, UntypedFn } from './fn.ts';
import { g, type GinType } from './gin.ts';
import type { AnyContextRef, AnyFnRef, AnyTypeRef, Methods, TypeRef } from './refs.ts';
import { orDefault, type Simplify } from './util.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Fields of T that can name a value (text or number fields). */
export type NamingKeys<T> = { [K in keyof T]-?: T[K] extends string | number | undefined ? K : never }[keyof T] & string;

/** A named type in a contract: its shape, how it is shown, and its methods. */
export interface TypeDef<T, M extends Methods> {
  readonly description: string;
  readonly shape: GinType<T>;
  readonly display: TypeDisplay;
  readonly methods: M;
  /** Set when the hub keeps records of the type (the data system): read and write them with `ctx.data`. */
  readonly records: RecordStorage | undefined;
}

/** Top-level text fields of T: what a stored type's text search may match. */
export type TextKeys<T> = { [K in keyof T]-?: T[K] extends string | undefined ? K : never }[keyof T] & string;

/**
 * How the hub keeps records of a type (`type({ records })`), typed by the type: `table` for many records or `value`
 * for one; `shared` (everyone who sees the type sees them) or `person` (each record its owner's); `writers: 'admins'`
 * when only admins (and the system itself) change them; the text fields text search matches, in order of weight, and
 * whether records are embedded for search by meaning.
 */
export interface RecordsInput<T> {
  shape: RecordStorage['shape'];
  owner: RecordStorage['owner'];
  writers?: RecordStorage['writers'];
  search?: { text?: TextKeys<T>[]; embed?: boolean };
}
export type AnyTypeDef = TypeDef<unknown, Methods>;

/**
 * Declare a named type. Methods are native fns called on a value of the type: a person can run them from a mention's
 * card, and code can call them through the type's ref. They are offered to the LLM only when their `visibility`
 * says so.
 *
 * With `records`, the type is stored: the hub keeps its records, checks each against the type, versions every change
 * and searches them in its database (`ctx.data.find`, the Data page, `hub/records_*`). Shared data lives there, never
 * in a system's own folder.
 */
export function type<T, const M extends Methods = {}>(def: {
  description: string;
  shape: GinType<T>;
  display: Omit<TypeDisplay, 'title' | 'subtitle'> & { title?: NamingKeys<T>; subtitle?: NamingKeys<T> };
  methods?: M;
  records?: RecordsInput<T>;
}): TypeDef<T, M> {
  const records = def.records === undefined ? undefined : RecordStorage.parse({
    shape: def.records.shape,
    owner: def.records.owner,
    ...(def.records.writers === undefined ? {} : { writers: def.records.writers }),
    search: { text: [...(def.records.search?.text ?? [])], embed: def.records.search?.embed ?? false },
  });
  return { description: def.description, shape: def.shape, display: { ...def.display }, methods: orDefault(def.methods, {}), records };
}

/** The value type of a declared type. */
export type ValueOf<D> = D extends TypeDef<infer T, Methods> ? T : never;

/** A method's implementation: a native fn that also gets the value it was called on. */
export type MethodImpl<V, T extends FnTypes, Cfg = unknown> =
  { run(self: V, args: T['args'], ctx: FnCtx<T, Cfg>): Promise<Outcome<T>> } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx<Cfg>): Promise<UndoOutcome> });

// ─── Settings and attachments ─────────────────────────────────────────────────

/** A typed control admins (or fns) attach to actors. A run reads the effective value with `ctx.setting(ref)`. */
export interface SettingDef<T> {
  readonly description: string;
  readonly type: GinType<T>;
  readonly appliesTo: readonly ActorKind[];
  /** How a user's value combines with their groups'. */
  readonly merge: SettingMerge;
  /** Besides admins, who may set it. */
  readonly editableBy: readonly SettingEditor[];
}

/** Declare an actor setting. */
export function setting<T>(def: { description: string; type: GinType<T>; appliesTo: ActorKind[]; merge: SettingMerge; editableBy?: SettingEditor[] }): SettingDef<T> {
  return { description: def.description, type: def.type, appliesTo: [...def.appliesTo], merge: def.merge, editableBy: [...(def.editableBy ?? [])] };
}

/** A kind of attachment a system's fns add to assistant messages, drawn by its client renderer. */
export interface AttachmentDef<T> {
  readonly description: string;
  readonly data: GinType<T>;
}

/** Declare an attachment kind. */
export function attachment<T>(def: { description: string; data: GinType<T> }): AttachmentDef<T> {
  return { description: def.description, data: def.data };
}

// ─── Kinds ────────────────────────────────────────────────────────────────────

/** A fn kind as declared in a contract: what its payload looks like and when to use it. */
export interface KindDef<P> {
  readonly description: string;
  /** When an agent should pick this kind for a new fn. */
  readonly applicability: string;
  readonly payload: GinType<P>;
  /** Whether declaring or changing a fn of this kind at runtime needs approval. */
  readonly approveChanges: boolean;
  /** The status words of its fns that declare none. They may use `{fn}`, `{n}` and `{args}` / `{output}` paths. */
  readonly status: StatusTemplates | undefined;
  /** Its implementation's `estimate` works out what a fn of this kind costs from its payload (`FnFacts.cost`, basis `payload`). */
  readonly estimates: boolean;
}

/**
 * Declare a kind. `estimates: true` says its implementation has an `estimate` hook that works out a fn's cost from its
 * payload (a query is free; a form costs nothing until it asks a model), which the hub shows before a run.
 */
export function kind<P>(def: { description: string; applicability: string; payload: GinType<P>; approveChanges?: boolean; status?: StatusTemplates; estimates?: boolean }): KindDef<P> {
  return {
    description: def.description, applicability: def.applicability, payload: def.payload, approveChanges: def.approveChanges ?? true, status: def.status,
    estimates: def.estimates ?? false,
  };
}

/** What a kind's `estimate` is asked about: one call's args (absent for the fn in general) and the fn's run history, if any. */
export interface KindEstimateInput {
  readonly args?: Json;
  readonly history?: CostEstimate;
}

/** What a kind can look up while checking a payload. */
export interface KindCheckCtx {
  type(name: QualifiedName): Promise<GinTypeDef | undefined>;
  /** A fn's shape: this system's own from its table, another's from the hub (absent when it may not see it, or before the hub welcomed the system). */
  fn(name: QualifiedName): Promise<KindFnShape | undefined>;
}

/** A kind's run context: like `FnCtx`, but calls are by name (limited to the deps `describe` returned). */
export interface KindRunCtx<Cfg = unknown> extends Omit<FnCtx<UntypedFn, Cfg>, 'fns' | 'handlers' | 'progress'> {
  call(fn: QualifiedName, args: Json, options?: { key?: string; background?: boolean }): FnCall<Json>;
  handler(name: string, args: Json): Promise<Json>;
  progress(state: { fraction: number; message?: string } | { step: string; status: StepStatus; detail?: string }): void;
}

/**
 * A kind's implementation. The payload is typed; a fn's args and result aren't (they depend on the payload), so they
 * arrive as JSON the hub has already checked against `describe`'s types.
 */
export interface KindImpl<P, Cfg = unknown> {
  /** Problems with a payload beyond its type (an unknown fn, a program that doesn't type-check). */
  check(payload: P, ctx: KindCheckCtx): Promise<string[]>;
  describe(payload: P, ctx: KindCheckCtx): Promise<KindDescription>;
  run(payload: P, args: Json, ctx: KindRunCtx<Cfg>): Promise<Outcome<UntypedFn>>;
  undo?(payload: P, undo: Json, ctx: UndoCtx<Cfg>): Promise<UndoOutcome>;
  /** What a run of a payload's fn would do, for a fn `describe` gave an `approval` with a preview (a write query). */
  preview?(payload: P, args: Json, ctx: PreviewCtx<Cfg>): Promise<PreviewAnswer>;
  /**
   * What a fn of this payload costs, for a kind declared with `estimates: true`: an estimate with basis `payload` (or
   * `free`), blending in `history` when it helps, or `undefined` to leave it to the history.
   */
  estimate?(payload: P, input: KindEstimateInput, ctx: SystemCtx<Cfg>): Promise<CostEstimate | undefined>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

/** An argument of a `/command`. */
export interface ArgDef<Req extends boolean> {
  readonly hint: string;
  readonly required: Req;
}

/** Declare a `/command` argument. Required unless `{ required: false }`. */
export function arg<const Req extends boolean = true>(hint: string, options?: { required?: Req }): ArgDef<Req> {
  return { hint, required: orDefault(options?.required, true) };
}

/** The args object of a command. */
export type ArgsOf<A extends Record<string, ArgDef<boolean>>> =
  Simplify<{ -readonly [K in keyof A as A[K]['required'] extends true ? K : never]: string } & { -readonly [K in keyof A as A[K]['required'] extends true ? never : K]?: string }>;

/** What a context link points at: another context item, a fn, a named type, or a resource (or one of its sections). */
export type ContextLinkTarget = AnyContextRef | AnyFnRef | AnyTypeRef | { readonly uri: ResourceUri; readonly section?: string };

/**
 * A weighted edge from a context item to something it relates to, which the graph contextor follows: `imports` and
 * `brings` travel together; `suggests`, `related`, `about`, `parent` and `next` pass on some of an item's score.
 */
export interface ContextLinkDef {
  readonly to: ContextLinkTarget;
  readonly relation: DeclarableRelation;
  /** How strongly, from 0 to 1. Default 0.5. */
  readonly weight?: number;
}

/** Content for the LLM. Static content is written in the contract; dynamic content is produced by the system. */
export interface ContextDef<A, Dynamic extends boolean> {
  readonly description: string;
  readonly dynamic: Dynamic;
  readonly content: string | undefined;
  readonly command: { readonly name: string; readonly args: Readonly<Record<string, ArgDef<boolean>>> } | undefined;
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
  /** How much it counts when the graph contextor scores it: 0 leaves it out, 2 doubles it. Default 1. */
  readonly weight: number | undefined;
  /** A short form shown when the budget allows only a little of it; its description otherwise. */
  readonly summary: string | undefined;
  /** Its parent in a hierarchy (a guide over its chapters). */
  readonly parent: AnyContextRef | undefined;
  /** The next piece of a chain (a long text in ordered pieces). */
  readonly next: AnyContextRef | undefined;
  readonly links: readonly ContextLinkDef[];
  /** Phantom: the command's args. Never set at runtime. */
  readonly argsType?: A;
}
export type AnyContextDef = ContextDef<unknown, boolean>;

/** What `context()` takes. */
export interface ContextInput<Args extends Record<string, ArgDef<boolean>>> {
  description: string;
  /** Makes it a `/name` command. Args fill `{{name}}` in the content (or are passed to a dynamic implementation). */
  command?: { name: string; args?: Args };
  imports?: AnyContextRef[];
  fns?: AnyFnRef[];
  suggestFns?: AnyFnRef[];
  suggest?: Audience;
  visible?: Audience;
  alwaysFor?: AnyFnRef[];
  tags?: string[];
  /** How much it counts when scored, from 0 (left out) to 2. Default 1. */
  weight?: number;
  /** A short form shown when the budget allows only a little of it. */
  summary?: string;
  parent?: AnyContextRef;
  next?: AnyContextRef;
  /** Weighted links to other context, fns, types and resources. */
  links?: ContextLinkDef[];
}

/** Declare static context. */
export function context<const Args extends Record<string, ArgDef<boolean>> = {}>(def: ContextInput<Args> & { content: string }): ContextDef<ArgsOf<Args>, false>;
/** Declare dynamic context: the server implements it. */
export function context<const Args extends Record<string, ArgDef<boolean>> = {}>(def: ContextInput<Args>): ContextDef<ArgsOf<Args>, true>;
export function context<const Args extends Record<string, ArgDef<boolean>>>(def: ContextInput<Args> & { content?: string }): ContextDef<ArgsOf<Args>, boolean> {
  return {
    description: def.description,
    dynamic: def.content === undefined,
    content: def.content,
    command: def.command === undefined ? undefined : { name: def.command.name, args: { ...def.command.args } },
    imports: [...(def.imports ?? [])],
    fns: [...(def.fns ?? [])],
    suggestFns: [...(def.suggestFns ?? [])],
    suggest: def.suggest ?? 'both',
    visible: def.visible ?? 'both',
    alwaysFor: [...(def.alwaysFor ?? [])],
    tags: [...(def.tags ?? [])],
    weight: def.weight,
    summary: def.summary,
    parent: def.parent,
    next: def.next,
    links: [...(def.links ?? [])],
  };
}

/** A dynamic context's implementation: its content for these args. */
export type ContextImpl<A, Cfg = unknown> = (args: A, ctx: SystemCtx<Cfg> & Partial<AskerCtx> & Pick<AskerCtx, 'user' | 'time'>) => Promise<string>;

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** A system's user-message hook: adds information to a message before the LLM sees it. */
export interface HookDef {
  readonly description: string;
  /** Lower runs first. */
  readonly order: number;
  /** After this the message goes on without it. */
  readonly timeout: Duration;
}

/** Declare a hook. Defaults: order 100, timeout 1000 ms. */
export function hook(def: { description: string; order?: number; timeout?: Duration }): HookDef {
  return { description: def.description, order: def.order ?? 100, timeout: def.timeout ?? 1_000 };
}

/** What a hook adds, with refs (the wire form, `HookBlock`, carries names). */
export type HookContribution =
  | { type: 'text'; tag: string; text: string }
  | { type: 'suggest-context'; items: Array<{ context: AnyContextRef; why?: string }> }
  | { type: 'suggest-fns'; items: Array<{ fn: AnyFnRef; why?: string }> }
  /** Load these now. */
  | { type: 'load'; context?: AnyContextRef[]; fns?: AnyFnRef[] };

/** A hook contribution on the wire. */
export function hookBlock(contribution: HookContribution): HookBlock {
  switch (contribution.type) {
    case 'text': return { ...contribution };
    case 'suggest-context': return { type: 'suggest-context', items: contribution.items.map((i) => ({ context: i.context.name, ...(i.why === undefined ? {} : { why: i.why }) })) };
    case 'suggest-fns': return { type: 'suggest-fns', items: contribution.items.map((i) => ({ fn: i.fn.name, ...(i.why === undefined ? {} : { why: i.why }) })) };
    case 'load': return {
      type: 'load',
      ...(contribution.context === undefined ? {} : { context: contribution.context.map((c) => c.name) }),
      ...(contribution.fns === undefined ? {} : { fns: contribution.fns.map((f) => f.name) }),
    };
  }
}

/** A hook's implementation. */
export type HookImpl<Cfg = unknown> = (input: HookInput, ctx: SystemCtx<Cfg>) => Promise<HookContribution[]>;

// ─── Mentions ─────────────────────────────────────────────────────────────────

/** An `@` mention provider: a way to point at something a system knows about. `target` is what gets stored. */
export interface MentionDef<T, V> {
  readonly title: string;
  readonly description: string;
  readonly target: GinType<T>;
  /** The type of the things it points at: chips and cards use its display, and cards offer its methods. */
  readonly of: TypeRef<QualifiedName, V, Methods> | undefined;
}

/** Declare a mention provider. */
export function mention<T, V = never>(def: { title: string; description: string; target: GinType<T>; of?: TypeRef<QualifiedName, V, Methods> }): MentionDef<T, V> {
  return { title: def.title, description: def.description, target: def.target, of: def.of };
}

/** One search result in the `@` picker, typed by the provider's target. */
export interface MentionOption<T> {
  /** The friendly name: what the chip shows. */
  label: string;
  /** A short line under the label ("customers · Acme Corp"). */
  hint?: string;
  icon?: string;
  target: T;
}

/** What a mention provider's implementation gets: the person mentioning, so results are limited to what they may see. */
export interface MentionCtx<Cfg = unknown> extends SystemCtx<Cfg>, AskerCtx {}

/** A mention provider's implementation. */
export interface MentionImpl<T, V, Cfg = unknown> {
  /** Results for what the person typed after `@`. */
  search(query: string, ctx: MentionCtx<Cfg>): Promise<MentionOption<T>[]>;
  /** The hover card, asked for when hovered so it is current; `undefined` when the thing no longer exists. */
  hover(target: T, ctx: MentionCtx<Cfg>): Promise<(Omit<MentionHover, 'value'> & { value?: V }) | undefined>;
  /** The text the LLM gets for this mention: what the thing is, where it lives and how to reach it. */
  llm(target: T, ctx: MentionCtx<Cfg>): Promise<string>;
}

// ─── Sectioners ───────────────────────────────────────────────────────────────

/** A way of cutting resources into sections, offered to users as a choice for matching resources. */
export interface SectionerDef {
  readonly description: string;
  readonly match: SectionMatch;
}

/** Declare a sectioner. */
export function sectioner(def: { description: string; match: SectionMatch }): SectionerDef {
  return { description: def.description, match: { ...def.match } };
}

/** A sectioner's implementation. Keys must come from structure (`sectionKey(path)`), never from position. */
export type SectionerImpl = (text: string, stat: ResourceStat) => Promise<Section[]>;

/**
 * Make section keys from outline paths, in document order, by `@aeye/resources`' rules (the same keys its markdown
 * and code slicers give): each key is the path joined with ` > `, `(root)` for an empty path, and a path seen before
 * gets ` ~2`, ` ~3` so keys stay unique while still coming from structure.
 */
export function sectionKeys(paths: readonly (readonly string[])[]): SectionKey[] {
  return structuralKeys(paths).map((key) => SectionKeySchema.parse(key));
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * A typed message a system accepts from its renderers ("approve", "load more"). The hub stores each one before
 * delivering it, so nothing is lost while the system is offline.
 */
export interface ActionDef<I, R, St extends object> {
  readonly description: string;
  readonly input: GinType<I>;
  readonly returns: GinType<R>;
  readonly state: GinType<St> | undefined;
  /** Drop it if it can't be delivered within this long. Default: never. */
  readonly expires: Duration | undefined;
}

/** Declare an action. Without `returns` it returns nothing. */
export function action<I, R = undefined, St extends object = {}>(def: { description: string; input: GinType<I>; returns?: GinType<R>; state?: GinType<St>; expires?: Duration }): ActionDef<I, R, St> {
  return { description: def.description, input: def.input, returns: orDefault<GinType<R>, GinType>(def.returns, g.void()), state: def.state, expires: def.expires };
}

/** An action's implementation. */
export type ActionImpl<I, R, St extends object, Cfg = unknown> = (input: I, ctx: ActionCtx<St, Cfg>) => Promise<R>;
