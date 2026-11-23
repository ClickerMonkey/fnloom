/**
 * Client renderers: a system's Vue components for its fns, kinds, attachments, inputs, mention cards and resource
 * formats. Each component's props are a view typed by the contract and are reactive, so a running fn's renderer
 * updates as progress and the result come in. A system's client build keeps `vue` external, so renderers share the
 * chat's Vue. The chat UI provides the runtime behind `SystemClient` and `ResourceViewer`.
 */
import type { ApiClient } from '@ayepi/core/client';
import { type AccessInfo, type DeliveryId, type DeliveryStatus, type FnError, type FormKind, type HubWebSpec, type Json, type MentionHover, type MessagePart, type QualifiedName, type ResourceStat, type ResourceUri, type ResultFacts, type ResultTable, type RunId, type RunStatus, type SectionKey, type SessionId, type ShareRule, type TypeDisplay, type UserView, type VisualBinding, type VisualShape } from '@harness/core';
import type { Component, InjectionKey } from 'vue';
import type { ActionDef, AttachmentDef, MentionDef, ValueOf } from './declare.ts';
import type {
  ApprovalProps, BadgeProps, BannerProps, ButtonProps, ComposerProps, ConversationProps, DialogProps, FnPillProps, PageFormat, PageInbox, PageNotify, PageRuns, PageRunsOptions, SelectProps, SkeletonProps,
  TextareaProps,
} from './page-parts.ts';
import type { FnDef, FnTypes, ProgressState, TypesOf, UntypedFn } from './fn.ts';
import type { GinType, Infer } from './gin.ts';
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

/**
 * The props of a result renderer (`client({ results })`): a finished run's result, drawn where the app shows a run's
 * result (the chat's run card) instead of its default view, under the card's own line, status and cost. A fn renderer
 * draws a whole run as it goes; a result renderer draws only what it gave.
 */
export interface ResultView<T extends FnTypes> {
  run: RunId;
  /** The fn that ran (for a kind's renderer, one of the kind's fns). */
  fn: QualifiedName;
  args: T['args'];
  result: T['result'];
  /** The run's name as the app shows it ("Make widget"). */
  title: string;
}

/** How a run the person sees ended: its output, or why it didn't finish (declined, refused, failed, stopped). */
export type RunOutcome = { readonly ok: true; readonly output: Json } | { readonly ok: false; readonly problem: string };

/**
 * What the open chat offers its renderers (`inject(CHAT_HOST)`): asking the agent, and waiting for a run (one a
 * renderer started with `system.run`) to end. Absent outside a chat.
 */
export interface ChatHost {
  /** Ask the agent: send the request now (`send`), or put it in the composer for the person to finish. False when it couldn't. */
  ask(text: string, send: boolean): Promise<boolean>;
  /** Wait for a run in the chat to end, and give how; `waiting` is called once if it stops for the person's approval. */
  settled(run: RunId, waiting?: () => void): Promise<RunOutcome>;
  /** Go to a path in the app without reloading it (a system page: `systemPagePath('widgets', 'saved')`). */
  navigate(path: string): void;
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
  /**
   * Draw the value without letting it be changed (a run card's args, a result): the same component is the type's
   * editor and its viewer everywhere a value of the type is drawn.
   */
  readonly: boolean;
}

/**
 * The props of a system's own config component (`system({ configComponent })`), drawn instead of or beside the gin
 * form on the review, system and pairing pages. It edits a draft and hands it back with `change`; the page saves it,
 * and the hub checks it with the config's gin type before it is stored. `system` (from `WithSystem`) reaches the
 * system for live checks, such as testing a connection through an action.
 */
export interface ConfigView<Cfg> {
  /** The config as saved now; undefined before the first save. */
  config: Cfg | undefined;
  /** The config's gin type, for its fields' docs and checks. */
  type: GinType<Cfg>;
  /** Check a candidate with the gin type and the hub's own checks: the problems, one per line; empty when it fits. */
  validate(value: Cfg): Promise<string[]>;
  /** Hand the edited config to the page, which saves it after checking. */
  change(value: Cfg): void;
}

// ─── System pages ─────────────────────────────────────────────────────────────

/** The hub's web API client, typed by its spec: `host.hub.caller('records').call(query)`, the same client the app uses. */
export type HubClient = ApiClient<HubWebSpec>;

/** Where a page link goes: one of the system's own pages (this one when left out), the parts under it, and its query. */
export interface PageLocation {
  readonly page?: string;
  readonly path?: readonly string[];
  readonly query?: Readonly<Record<string, string | undefined>>;
}

/** A query key bound two ways, for `v-model`: reading gives the key's value (or the fallback), writing sets it. */
export interface QueryBinding {
  value: string;
}

/**
 * The page's URL query, live: every page is a URL, so a page keeps its search, filters, tab and open item here and a
 * refresh or a shared link returns to the same place.
 */
export interface PageQuery {
  /** The query now (read reactively). */
  readonly values: Readonly<Record<string, string>>;
  get(key: string): string | undefined;
  /** Change some keys (undefined or '' removes one). It replaces the history entry unless `push` is set. */
  set(patch: Readonly<Record<string, string | undefined>>, options?: { readonly push?: boolean }): void;
  /** One key bound two ways; writing the fallback removes the key, so the URL stays short. */
  bind(key: string, fallback?: string): QueryBinding;
}

/** Props of the app's markdown view. `navigate` handles links inside the app (`/...`). */
export interface MarkdownProps { source: string; navigate?: ((href: string) => void) | undefined }
/** Props of the app's one-line text input (`v-model` is the text); `icon` is from the app's icon set, `hideLabel` keeps the label for screen readers only. */
export interface InputProps { modelValue: string; label?: string; type?: 'text' | 'search' | 'email' | 'password' | 'url' | 'number' | 'tel'; placeholder?: string; icon?: string | undefined; clearable?: boolean; hideLabel?: boolean; hint?: string; error?: string; disabled?: boolean; size?: 'sm' | 'md' }
/** Props of an app icon; `name` is from the app's icon set. */
export interface IconProps { name: string; size?: number; label?: string }
/** Props of the app's empty state. */
export interface EmptyProps { title: string; body?: string; icon?: string; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' }
/** Props of the app's load state: a skeleton while loading, the problem with Retry (`@retry`), the empty state, or its slot. */
export interface LoadStateProps { loading: boolean; problem: string; ready: boolean; empty: boolean; emptyTitle?: string; emptyBody?: string; emptyIcon?: string; lines?: number }
/** Props of the chat's reasoning block (`v-model:open`). */
export interface ReasoningProps { text: string; thinking: boolean; open: boolean }
/** Props of the chat's typing dots. */
export interface TypingProps { label?: string }
/** Props of the app's page frame: the title, a line about the page, and how wide it sits; slots `actions` and `crumb`. */
export interface FrameProps { title: string; description?: string; width?: 'readable' | 'wide' | 'full'; keepTitle?: boolean }

/**
 * The app's own components, shared with pages so a system's page looks and behaves like the rest of the app, and the
 * chat's parts are reused rather than drawn again. The app provides them; a page reads them from `host.components`.
 */
export interface SharedComponents {
  /** The frame every app page sits in, so a system's page has the same title, spacing and widths. */
  readonly Frame: Component<FrameProps>;
  /** The app's text input, for a page's search box or a field. */
  readonly Input: Component<InputProps>;
  readonly Markdown: Component<MarkdownProps>;
  readonly Icon: Component<IconProps>;
  readonly Empty: Component<EmptyProps>;
  readonly LoadState: Component<LoadStateProps>;
  readonly Reasoning: Component<ReasoningProps>;
  readonly Typing: Component<TypingProps>;
  readonly ResourceViewer: Component<ResourceViewerProps>;
  readonly ValueEditor: Component<ValueEditorProps>;
  // the app's controls, so a page's buttons, choices and dialogs are the app's own
  readonly Button: Component<ButtonProps>;
  readonly Select: Component<SelectProps>;
  readonly Textarea: Component<TextareaProps>;
  readonly Dialog: Component<DialogProps>;
  readonly Banner: Component<BannerProps>;
  readonly Badge: Component<BadgeProps>;
  readonly Skeleton: Component<SkeletonProps>;
  readonly FnPill: Component<FnPillProps>;
  /** An approval card, answered on the page (`host.runs`' approvals in a chat, or `host.inbox`'s). */
  readonly Approval: Component<ApprovalProps>;
  /** A conversation drawn with the chat's own message, answer, reasoning and run parts. */
  readonly Conversation: Component<ConversationProps>;
  /** The chat's composer. */
  readonly Composer: Component<ComposerProps>;
}

/**
 * What the app hands a system page: the person, the hub's web API (calls run as that person, so the hub's access rules
 * apply), the URL (its query, links to the system's pages and moving between them) and the app's shared components.
 * The page also gets `system` (its own system's actions and fns) like every renderer. Components under the page read
 * the same host with `inject(PAGE_HOST)`.
 */
export interface PageHost {
  /** The person looking at the page. */
  readonly user: Readonly<UserView>;
  readonly hub: HubClient;
  readonly query: PageQuery;
  /** The URL of one of the system's pages, for an `<a href>`. */
  href(to: PageLocation): string;
  /** The URL of one of the person's chats (a run's, an item's own), for an `<a href>`. */
  chatHref(session: SessionId): string;
  /** Go to one of the person's chats. */
  goChat(session: SessionId): void;
  /** The URL of a run's own page (`/run/<run>`: its result, tree, approval and Undo), for an `<a href>`. */
  runHref(run: RunId): string;
  /** Go to a run's own page. */
  goRun(run: RunId): void;
  /** Go to one of the system's pages (this one, with another path or query, when `page` is left out). */
  go(to: PageLocation, options?: { readonly replace?: boolean }): void;
  /**
   * Start a new chat as the person, run a fn there first when `run` is given (as the person's own run, so its approvals,
   * row actions and undo work), and go to it. Rejects with the reason when the chat couldn't be made.
   */
  openChat(start: ChatStart): Promise<void>;
  readonly components: SharedComponents;
  /** Runs the page starts and waits on, as the person's own runs in a harness chat (made on first use, or `attach`ed). */
  runs(options: PageRunsOptions): PageRuns;
  /** The approvals waiting on the person outside any chat. */
  readonly inbox: PageInbox;
  readonly notify: PageNotify;
  readonly format: PageFormat;
  /**
   * Keep the page live: run `refresh` every `every` ms while the page is open and in view, and once more when it comes
   * back into view. Call it while the page sets up (it stops when the page goes).
   */
  live(refresh: () => void, every: number): void;
}

/** A chat a page starts (`host.openChat`): its title, and the fn it runs first. */
export interface ChatStart {
  readonly title: string;
  readonly run?: { readonly fn: QualifiedName; readonly args: Json };
}

/** The props of a system page (`client({ pages })`), at `/s/<system>/<page>/<path...>`. */
export interface PageView {
  /** The page's segment. */
  page: string;
  /** The URL's parts under the page (`/s/claude/session/main/abc` gives `['main', 'abc']`). */
  path: readonly string[];
  host: PageHost;
}

/** The props of one of a contract's pages: `defineProps<PageViewOf<typeof claude>>()`. */
export type PageViewOf<S extends AnyContract> = PageView & WithSystem<S['defs']>;

/** The page host, for components under a page (the page itself gets it as `host`). A global symbol, like the others. */
export const PAGE_HOST: InjectionKey<PageHost> = Symbol.for('harness.pageHost');

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
  /** The forms the hub has made of it (`markdown`, `table`, `description`, …), so a viewer can offer them. */
  forms: readonly FormKind[];
  /** Its text: the raw text, or one of its forms. */
  text(form?: FormKind): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/**
 * A viewer given as a bare component. Vue's component type takes almost any object, so one shaped like an entry
 * (`{ component, mode }`) is kept out here and checked as an entry instead.
 */
export type BareViewer<R> = R & { readonly component?: never; readonly mode?: never };

/** How a system's resource viewer sits beside the hub's: instead of its preview, or as one more mode (tab). */
export const RESOURCE_VIEWER_MODES = ['replace', 'tab'] as const;
export type ResourceViewerMode = (typeof RESOURCE_VIEWER_MODES)[number];

/**
 * A system's viewer for a resource format with how it is offered: `replace` draws instead of the hub's preview for that
 * format; `tab` adds a mode named `label` beside the hub's own (Preview, Source, the forms).
 */
export interface ResourceViewerEntry<R> {
  readonly component: R;
  readonly mode: ResourceViewerMode;
  /** The mode's name in the viewer's switch. Default: the system's name. */
  readonly label?: string;
}

type FnTypesOf<C extends ContractShape, K extends keyof C['fns']> = C['fns'][K] extends FnDef<infer T> ? T : never;
type AttachmentData<C extends ContractShape, K extends keyof C['attachments']> = C['attachments'][K] extends AttachmentDef<infer T> ? T : never;
type MentionTarget<C extends ContractShape, K extends keyof C['mentions']> = C['mentions'][K] extends MentionDef<infer T, unknown> ? T : never;

/** The props of the renderer for one of a contract's fns: `defineProps<FnViewOf<typeof fs, 'bash'>>()`. */
export type FnViewOf<S extends AnyContract, K extends keyof S['defs']['fns']> = FnView<TypesOf<S['defs']['fns'][K]>> & WithSystem<S['defs']>;
/** The props of the result renderer for one of a contract's fns: `defineProps<ResultViewOf<typeof widgets, 'make_widget'>>()`. */
export type ResultViewOf<S extends AnyContract, K extends keyof S['defs']['fns']> = ResultView<TypesOf<S['defs']['fns'][K]>> & WithSystem<S['defs']>;
/** The props of one of a contract's attachments. */
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
  /** A custom input's extra props; the form adds the `InputView` ones (`modelValue`, `problems`, `readonly`) as it draws. */
  input: WithSystem<ContractShape>;
  mention: MentionView<unknown> & WithSystem<ContractShape>;
  resource: ResourceView & WithSystem<ContractShape>;
  config: ConfigView<unknown> & WithSystem<ContractShape>;
  page: PageView & WithSystem<ContractShape>;
  /** A result renderer: a fn's own gets its run decoded; a kind's gets the JSON as it is. */
  result: ResultView<DecodedFn> & WithSystem<ContractShape>;
}

/**
 * What a host (the chat) hands the runtime to build a view: the stored, wire form of every value (JSON), and what
 * finds the renderer. The runtime decodes the values with the system's gin types into `AnyViews`.
 */
export interface WireViews {
  fn: Omit<FnView<UntypedFn>, 'submit' | 'state'> & { fn: QualifiedName; kind: QualifiedName | undefined; state: Readonly<Record<string, Json>> };
  attachment: AttachmentView<Json> & { attachment: QualifiedName };
  mention: Omit<MentionView<Json>, 'type'> & { provider: QualifiedName };
  result: ResultView<UntypedFn> & { kind: QualifiedName | undefined };
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

/**
 * The colours a visual draws with, resolved for the current theme from the web app's tokens: the categorical series
 * colours (`--chart-1` … `--chart-8`, the first the accent), the text and muted text, the grid lines and the surface
 * behind the chart. Build an ECharts theme from it; it changes when the theme does.
 */
export interface VisualPalette {
  readonly series: readonly string[];
  readonly text: string;
  readonly muted: string;
  readonly grid: string;
  readonly surface: string;
  readonly dark: boolean;
}

/** A range a visual shows, as its range args take it: a calendar's month, a zoomed time axis (ISO dates or instants). */
export interface VisualRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The props of a visual (an entry of a registry such as the hub's `hub/visuals`): the rows to draw, their column facts
 * (`resultFacts`), the columns bound to each channel (`bind`, complete: the widget's or the default binding), the style
 * picked in the style picker, and the theme's colours.
 */
export interface VisualView {
  table: ResultTable;
  facts: ResultFacts;
  bind: VisualBinding;
  style: string;
  palette: VisualPalette;
}

/**
 * What a visual emits, with the checks Vue runs on each (`defineEmits(VISUAL_EMITS)`, or `emits: VISUAL_EMITS`):
 * `drill` with the index of the clicked row (a bar, slice or point: the widget runs its drill, else opens the row's
 * action menu), and `range` when the person zooms a time axis or turns a calendar's month (the widget sets its range
 * args and runs again).
 */
export const VISUAL_EMITS = {
  drill: (rowIndex: number): boolean => Number.isInteger(rowIndex) && rowIndex >= 0,
  range: (range: VisualRange): boolean => range.from <= range.to,
};
export type VisualEmits = typeof VISUAL_EMITS;

/** The axis colours of a visual theme: lines and ticks in the grid colour, labels muted. */
interface VisualAxisTheme {
  readonly axisLine: { readonly lineStyle: { readonly color: string } };
  readonly axisTick: { readonly lineStyle: { readonly color: string } };
  readonly axisLabel: { readonly color: string };
  readonly splitLine: { readonly lineStyle: { readonly color: string } };
}

/** An ECharts theme object (`init(el, visualTheme(palette))`), so a system's chart looks like the built-in ones. */
export interface VisualTheme {
  readonly color: readonly string[];
  readonly backgroundColor: string;
  readonly textStyle: { readonly color: string };
  readonly legend: { readonly textStyle: { readonly color: string } };
  readonly tooltip: { readonly backgroundColor: string; readonly borderColor: string; readonly textStyle: { readonly color: string } };
  readonly categoryAxis: VisualAxisTheme;
  readonly valueAxis: VisualAxisTheme;
  readonly timeAxis: VisualAxisTheme;
  readonly logAxis: VisualAxisTheme;
}

/** The ECharts theme for a palette: series in the palette's order, text and axes in its colours, no background of its own. */
export function visualTheme(palette: VisualPalette): VisualTheme {
  const axis: VisualAxisTheme = {
    axisLine: { lineStyle: { color: palette.grid } }, axisTick: { lineStyle: { color: palette.grid } },
    axisLabel: { color: palette.muted }, splitLine: { lineStyle: { color: palette.grid } },
  };
  return {
    color: [...palette.series], backgroundColor: 'transparent', textStyle: { color: palette.text },
    legend: { textStyle: { color: palette.muted } },
    tooltip: { backgroundColor: palette.surface, borderColor: palette.grid, textStyle: { color: palette.text } },
    categoryAxis: axis, valueAxis: axis, timeAxis: axis, logAxis: axis,
  };
}

/**
 * One visual a system adds to a registry: the component that draws it, and an optional `veto`. Whether a result fits
 * and how it ranks come from the contribution's declared shape (`visual({ shape })`, core's `rankVisuals`), the same in
 * the hub, the widget agent and the browser; `veto` can only take a fit away (a reason in words), never score one. Keep
 * it cheap and pure: it runs for every result the person sees.
 */
export interface VisualEntry<C extends ContractShape> {
  veto?(table: ResultTable, facts: ResultFacts): string | undefined;
  component: Renderer<VisualView & WithSystem<C>>;
}

/** A system's renderers, typed by its contract. Every renderer also gets `system` to send its system actions. */
export interface ClientRenderers<C extends ContractShape> {
  /** How calls of a fn are drawn in the chat. */
  fns?: { readonly [K in keyof C['fns']]?: Renderer<FnView<FnTypesOf<C, K>> & WithSystem<C>> };
  /**
   * How a finished run's result is drawn, by fn, or by kind for a fn of a kind with none of its own: only the result,
   * under the app's own run line (a fn renderer, which draws the whole run, wins over these).
   */
  results?: {
    readonly fns?: { readonly [K in keyof C['fns']]?: Renderer<ResultView<FnTypesOf<C, K>> & WithSystem<C>> };
    readonly kinds?: { readonly [K in keyof C['kinds']]?: Renderer<ResultView<UntypedFn> & WithSystem<C>> };
  };
  /** How a fn of a kind is drawn when the fn has no renderer of its own. */
  kinds?: { readonly [K in keyof C['kinds']]?: Renderer<FnView<UntypedFn> & WithSystem<C>> };
  attachments?: { readonly [K in keyof C['attachments']]?: Renderer<AttachmentView<AttachmentData<C, K>> & WithSystem<C>> };
  /** Inputs for the system's named types (used in `!` forms and handler prompts). */
  inputs?: { readonly [K in keyof C['types']]?: Renderer<InputView<ValueOf<C['types'][K]>> & WithSystem<C>> };
  /** Custom hover cards for mentions (otherwise the hub draws the `MentionHover`). */
  mentions?: { readonly [K in keyof C['mentions']]?: Renderer<MentionView<MentionTarget<C, K>> & WithSystem<C>> };
  /**
   * Viewers for resource formats (`markdown`, `csv`, a system's own), shared by format across systems. A bare
   * component replaces the hub's preview; `{ component, mode: 'tab', label }` adds a mode beside it.
   */
  resources?: Readonly<Record<string, BareViewer<Renderer<ResourceView & WithSystem<C>>> | ResourceViewerEntry<Renderer<ResourceView & WithSystem<C>>>>>;
  /**
   * Visuals this system adds to registries, by registry (`hub/visuals`) and name. Each must be listed in
   * the contract's `contributes`, which is how the hub and the web app know to load this bundle for that registry.
   */
  visuals?: Readonly<Record<QualifiedName, Readonly<Record<string, VisualEntry<C>>>>>;
  /**
   * Config components by name. The one the contract's `configComponent` names is drawn for the system's config; it must
   * be here, and every component here must be the one named.
   */
  configs?: Readonly<Record<string, Renderer<ConfigView<Infer<C['config']>> & WithSystem<C>>>>;
  /**
   * Page components by name: each page the contract declares (`system({ pages })`) names one here, and every one here
   * is named by a page.
   */
  pages?: Readonly<Record<string, Renderer<PageView & WithSystem<C>>>>;
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
  for (const [registry, entries] of Object.entries(renderers.visuals ?? {})) {
    for (const name of Object.keys(entries)) {
      const declared = contract.contributes.find((c) => c.registry === registry && c.name === name);
      if (declared === undefined) {
        throw new Error(`system ${contract.name}: visual ${registry} ${name} is not in the contract's contributes.`);
      }
      if (declared.shape === undefined) {
        throw new Error(`system ${contract.name}: visual ${registry} ${name} needs a declared shape (visual({ shape })).`);
      }
    }
  }
  const named = contract.configComponent?.component;
  for (const name of Object.keys(renderers.configs ?? {})) {
    if (name !== named) { throw new Error(`system ${contract.name}: config component ${name} is not the contract's configComponent.`); }
  }
  if (named !== undefined && renderers.configs?.[named] === undefined) {
    throw new Error(`system ${contract.name}: the contract's configComponent ${named} has no component in client({ configs }).`);
  }
  checkPages(contract, renderers.pages ?? {});
  return { system: contract.name, contract, renderers };
}

/** Every page the contract declares has its component, and every page component is named by a page. */
function checkPages(contract: AnyContract, pages: Readonly<Record<string, unknown>>): void {
  const named = new Set(contract.pages.map((page) => page.component));
  for (const name of Object.keys(pages)) {
    if (!named.has(name)) { throw new Error(`system ${contract.name}: page component ${name} is not named by any of the contract's pages.`); }
  }
  for (const page of contract.pages) {
    if (pages[page.component] === undefined) { throw new Error(`system ${contract.name}: page ${page.segment} names component ${page.component}, which client({ pages }) doesn't have.`); }
  }
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

// ─── What a form renderer reads from the chat ─────────────────────────────────

/** A form's answer as it was sent: the run's `input-answer` part, without its type tag. */
export type InputAnswer = Omit<Extract<MessagePart, { type: 'input-answer' }>, 'type'>;

/** Sending a form's answers, and the answers already sent. */
export interface InputAnswers {
  /** Add a user message whose only part is this `input-answer`; rejects with the reason when it couldn't be sent. */
  send(answer: InputAnswer): Promise<void>;
  /** The answer sent for a run's form, if one was (read reactively). */
  answerOf(run: RunId): InputAnswer | undefined;
}

/**
 * The props of the chat's gin value editor, as a renderer binds them. `type` is a gin `TypeDef`; the editor reads any
 * definition (and says when it can't), so it takes `unknown`, which a renderer's `TypeDef` fits.
 */
export interface ValueEditorProps {
  type: unknown;
  modelValue: Json | undefined;
  readonly?: boolean;
}

/**
 * Sends a form's answers as a hidden user message (one `input-answer` part, which the chat hides and the model reads
 * in `<input-answer>` tags). The chat provides it; like `RESOURCE_VIEWER`, the key is a global symbol.
 */
export const INPUT_ANSWERS: InjectionKey<InputAnswers> = Symbol.for('harness.inputAnswers');
/** The chat's gin value editor (`v-model` over the JSON value). */
export const VALUE_EDITOR: InjectionKey<Component<ValueEditorProps>> = Symbol.for('harness.valueEditor');
/** The look picked in a result's Settings (a visual and its style, by their labels), which the result may keep as its own. */
export interface ResultLook {
  readonly visual: string;
  readonly style: string;
}

/**
 * The props of the app's result view, as a renderer binds them: a result table, or a widget's result, drawn with every
 * fitting visual, its chips, pager, drill and row actions. With `fn`, it reads that fn again (chips, pager, refresh);
 * without, it draws only what it has (a preview). `keepLook` offers keeping the look picked in Settings; it resolves
 * true when it was kept (or asked for).
 */
export interface ResultViewProps {
  value: Json;
  title: string;
  fn?: QualifiedName | undefined;
  args?: Json | undefined;
  /** Where it keeps its drill levels and picks (a run's id), so two views of one result don't share them. */
  viewKey?: string | undefined;
  keepLook?: ((look: ResultLook) => Promise<boolean>) | undefined;
}

/** The app's shared components for any renderer (`inject(APP_COMPONENTS)`), in a chat or on a page; a page also has them as `host.components`. */
export const APP_COMPONENTS: InjectionKey<SharedComponents> = Symbol.for('harness.appComponents');
/** The app's result view (`inject(RESULT_VIEW)`), provided app-wide, so result renderers draw with it wherever a run card is. */
export const RESULT_VIEW: InjectionKey<Component<ResultViewProps>> = Symbol.for('harness.resultView');
/** The open chat's host for renderers (asking the agent, waiting for a run); absent outside a chat. */
export const CHAT_HOST: InjectionKey<ChatHost> = Symbol.for('harness.chatHost');
/** Whether the hub has more than one person (a reactive getter), so a renderer offers who may use what it saves. */
export const ACCESS_INFO: InjectionKey<Readonly<AccessInfo>> = Symbol.for('harness.accessInfo');

/**
 * A system's visual for a result, as the chat's client runtime finds it among every loaded contribution: not vetoed,
 * with what the result view needs to mount it. The view ranks these with the built-in visuals (`rankedVisuals`).
 */
export interface VisualOption {
  readonly system: string;
  readonly name: string;
  /** What the switcher shows ("Waffle"): the contribution's `label` in the contract. */
  readonly label: string;
  /** An icon name from the web app's icon set, when the contribution names one. */
  readonly icon?: string;
  /** The data it draws, as declared. */
  readonly shape: VisualShape;
  readonly component: Component;
  /** The `system` prop its component gets beside `VisualView`. */
  readonly client: SystemClient<ContractShape>;
}

/** The systems' visuals of a registry that a result may use: not vetoed, in load order (`ClientRuntime.visuals`). */
export interface VisualSource {
  visuals(registry: QualifiedName, table: ResultTable, facts: ResultFacts): readonly VisualOption[];
}

/**
 * Every loaded system's visuals for a registry (the chat provides its client runtime's), so a result view can offer
 * visuals other systems contribute. Without it, a view falls back on its own system's visuals.
 */
export const VISUALS: InjectionKey<VisualSource> = Symbol.for('harness.visuals');

/** The props of the chat's visibility editor, as a renderer binds them (`v-model` over the rule). */
export interface ShareEditorProps {
  modelValue: ShareRule;
  /** The editor's label ("Who can use it" when absent). */
  label?: string;
}

/**
 * The chat's visibility editor: Only me, Me and chosen people (with the hub's people-and-groups picker), or Everyone,
 * the same control as everywhere else in the app. The chat provides it on a hub with more than one person.
 */
export const SHARE_EDITOR: InjectionKey<Component<ShareEditorProps>> = Symbol.for('harness.shareEditor');
