/**
 * Client renderers: a system's Vue components for its fns, kinds, attachments, inputs, mention cards and resource
 * formats. Each component's props are a view typed by the contract and are reactive, so a running fn's renderer
 * updates as progress and the result come in. A system's client build keeps `vue` external, so renderers share the
 * chat's Vue. The chat UI provides the runtime behind `SystemClient` and `ResourceViewer`.
 */
import type { DeliveryId, DeliveryStatus, FnError, Json, MentionHover, QualifiedName, ResourceStat, ResourceUri, RunId, RunStatus, SectionKey, TypeDisplay } from '@harness/core';
import type { Component, InjectionKey } from 'vue';
import type { ActionDef, AttachmentDef, MentionDef, ValueOf } from './declare.ts';
import type { FnDef, FnTypes, ProgressState, TypesOf, UntypedFn } from './fn.ts';
import type { Infer } from './gin.ts';
import type { AnyContract, ContractShape, SystemContract } from './system.ts';

/** A renderer is a Vue component whose props are P. */
export type Renderer<P> = Component<P>;

/** A message on its way: stored by the hub, delivered when the system is online. Its status is live. */
export interface Delivery<R> {
  /** The hub's id for it, once the hub has stored it. */
  readonly id: DeliveryId | undefined;
  readonly status: DeliveryStatus;
  /** Resolves when the system has handled it. */
  readonly result: Promise<R>;
}

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
  /** Send an action: `system.send.save({ draft })`. */
  readonly send: { readonly [K in keyof C['actions']]: C['actions'][K] extends ActionDef<infer I, infer R, object> ? (input: I) => Delivery<R> : never };
  /**
   * Run one of the system's fns in the renderer's session, as a person would with `!fn`: `system.run.bash(args)`. The
   * args are checked with the fn's gin type. It resolves with the new run's id once the hub has started it; the run
   * shows in the chat like any other, with its approval, status, cost and undo.
   */
  readonly run: { readonly [K in keyof C['fns']]: (args: FnTypesOf<C, K>['args']) => Promise<RunId> };
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

/** The props of a custom input. It works with `v-model` (`defineModel<T>()` in a `<script setup>`). */
export interface InputView<T> {
  modelValue: T | undefined;
  /** Problems with the current value, from the type's checks. */
  problems: string[];
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

/** The props of a resource viewer. */
export interface ResourceView {
  stat: ResourceStat;
  section?: SectionKey;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

type FnTypesOf<C extends ContractShape, K extends keyof C['fns']> = C['fns'][K] extends FnDef<infer T> ? T : never;
type AttachmentData<C extends ContractShape, K extends keyof C['attachments']> = C['attachments'][K] extends AttachmentDef<infer T> ? T : never;
type MentionTarget<C extends ContractShape, K extends keyof C['mentions']> = C['mentions'][K] extends MentionDef<infer T, unknown> ? T : never;

/** The props of the renderer for one of a contract's fns: `defineProps<FnViewOf<typeof fs, 'bash'>>()`. */
export type FnViewOf<S extends AnyContract, K extends keyof S['defs']['fns']> = FnView<TypesOf<S['defs']['fns'][K]>> & WithSystem<S['defs']>;
/** The props of the renderer for one of a contract's attachments. */
export type AttachmentViewOf<S extends AnyContract, K extends keyof S['defs']['attachments']> = AttachmentView<Infer<S['defs']['attachments'][K]['data']>> & WithSystem<S['defs']>;
/** The props of the input for one of a contract's types. */
export type InputViewOf<S extends AnyContract, K extends keyof S['defs']['types']> = InputView<ValueOf<S['defs']['types'][K]>> & WithSystem<S['defs']>;

/** A fn's types with its values erased: what the runtime holds once it has decoded a run with the fn's own gin types. */
type DecodedFn = Omit<UntypedFn, 'args' | 'result' | 'state' | 'form'> & { args: unknown; result: unknown; state: Record<string, unknown>; form: unknown };

/**
 * The props the runtime mounts a renderer with, for any system, with the contract's types erased. Values are
 * `unknown`, not JSON: `ClientRuntime` decodes the wire JSON (`WireViews`) with the contract's gin types first (a
 * timestamp becomes a `Date`), and only its view builders make these. Each is the typed view above at its widest, so
 * a change to a view changes what the runtime must build.
 */
export interface AnyViews {
  /** A fn's renderer. `submit` is undefined for a fn that declares no form, as its typed view says. */
  fn: Omit<FnView<DecodedFn>, 'submit'> & { submit: FnView<DecodedFn>['submit'] | undefined } & WithSystem<ContractShape>;
  attachment: AttachmentView<unknown> & WithSystem<ContractShape>;
  /** A custom input's extra props; the form adds the `InputView` ones (`modelValue`, `problems`) as it draws. */
  input: WithSystem<ContractShape>;
  mention: MentionView<unknown> & WithSystem<ContractShape>;
  resource: ResourceView & WithSystem<ContractShape>;
}

/**
 * What a host (the chat) hands the runtime to build a view: the stored, wire form of every value (JSON), and what
 * finds the renderer. The runtime decodes the values with the system's gin types into `AnyViews`.
 */
export interface WireViews {
  fn: Omit<FnView<UntypedFn>, 'submit' | 'state'> & { fn: QualifiedName; kind: QualifiedName | undefined; state: Readonly<Record<string, Json>> };
  attachment: AttachmentView<Json> & { attachment: QualifiedName };
  mention: Omit<MentionView<Json>, 'type'> & { provider: QualifiedName };
}

/** A renderer and the props the runtime built for it. */
export interface Mount<K extends keyof AnyViews> {
  readonly component: Component;
  readonly props: AnyViews[K];
}

/**
 * A custom input as a form mounts it: its component and system, how a stored (JSON) value reads into what the input
 * edits, and how an edited value writes back to JSON (undefined when it doesn't fit the type).
 */
export interface InputMount extends Mount<'input'> {
  decode(value: Json | undefined): unknown;
  encode(value: unknown): Json | undefined;
}

/** A system's renderers, typed by its contract. Every renderer also gets `system` to send its system actions. */
export interface ClientRenderers<C extends ContractShape> {
  /** How calls of a fn are drawn in the chat. */
  fns?: { readonly [K in keyof C['fns']]?: Renderer<FnView<FnTypesOf<C, K>> & WithSystem<C>> };
  /** How a fn of a kind is drawn when the fn has no renderer of its own. */
  kinds?: { readonly [K in keyof C['kinds']]?: Renderer<FnView<UntypedFn> & WithSystem<C>> };
  attachments?: { readonly [K in keyof C['attachments']]?: Renderer<AttachmentView<AttachmentData<C, K>> & WithSystem<C>> };
  /** Inputs for the system's named types (used in `!` forms and handler prompts). */
  inputs?: { readonly [K in keyof C['types']]?: Renderer<InputView<ValueOf<C['types'][K]>> & WithSystem<C>> };
  /** Custom hover cards for mentions (otherwise the hub draws the `MentionHover`). */
  mentions?: { readonly [K in keyof C['mentions']]?: Renderer<MentionView<MentionTarget<C, K>> & WithSystem<C>> };
  /** Viewers for resource formats (`markdown`, `csv`, a system's own). Shared by format across systems. */
  resources?: Record<string, Renderer<ResourceView & WithSystem<C>>>;
}

/**
 * A built client module: a system's renderers, typed by its contract, and the contract itself (so the chat checks
 * action inputs and results with the system's own gin types). The chat UI loads it from the hub.
 */
export interface ClientModule<C extends ContractShape = ContractShape> {
  readonly system: string;
  readonly contract: SystemContract<string, C>;
  readonly renderers: ClientRenderers<C>;
}

/** Declare a system's renderers in `client/`. */
export function client<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, renderers: ClientRenderers<C>): ClientModule<C> {
  return { system: contract.name, contract, renderers };
}

/** The props of `ResourceViewer`. */
export interface ResourceViewerProps {
  uri: ResourceUri;
  section?: SectionKey;
  /** Show a compact preview instead of the full view. */
  compact?: boolean;
}

/**
 * Shows any resource with the viewer for its format, from the hub or any system. The chat provides it under this
 * key; inside a renderer, `inject(RESOURCE_VIEWER)` gives the component. The key is a global symbol, so a system's
 * separately built bundle sees the same one.
 */
export const RESOURCE_VIEWER: InjectionKey<Component<ResourceViewerProps>> = Symbol.for('harness.resourceViewer');
