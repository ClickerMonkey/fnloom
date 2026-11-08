/**
 * The web API: what the browser calls on the hub (HTTP and the browser's WebSocket), and the realtime events it
 * receives. The slices (`authSlice`, `chatSlice`, ...) are the source of truth, one per hub plugin; `hubWebSpec` joins
 * them with `mergeSpecs`, so a name used by two slices does not compile. The hub serves each slice and the Vue app calls
 * `hubWebSpec` through ayepi client callers built from its manifest.
 */
import { bearerAuth } from '@ayepi/auth';
import { mergeSpecs, middleware, spec, use } from '@ayepi/core';
import { telemetry } from '@ayepi/otel';
import { z } from 'zod';
import { BudgetView, LlmFilter, LlmSummary, ModelInfo, OutputLine, ResourceFilter, RuleRef, RunFilter, SettingView } from './admin.ts';
import { MentionHover, MentionOption, ImportReport, SuggestionScore } from './manifest.ts';
import {
  ActorId, ActorKind, ApprovalId, DeliveryId, Duration, HubMcpId, ProviderId, HandlerCallId, InstanceName, InstanceRef, Json, LlmInteractionId, MessageId,
  ModelCallId, PageRequest, PairingId, Priority, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId, page,
} from './primitives.ts';
import { ReadWant, ResourceRead, ResourceUri, ContentRef } from './resources.ts';
import { ClientInfo, RunUpdate } from './run.ts';
import { Actor, ActorSetting, Approval, Remember, UserRole, UserView, type AccessClaims } from './records/actors.ts';
import { ChatCapabilities, ChatMessage, NotifyChoice, OutgoingPart, Presence, Session, SessionControlAction, SessionControls, SessionSummary } from './records/chat.ts';
import { IndexedKind, Notification, PushSubscription, ResourceRecord, SearchHit } from './records/content.ts';
import { DeliveryView, HandlerCall, LlmInteraction, Run, StateFieldValue, TreeNode, UndoReport } from './records/runs.ts';
import { BudgetRule, ModelCategory, PriorityRule, ProviderKind, providerVariants, ResolvedLimits } from './records/spend.ts';
import { ContextRecord, FnRecord, FnStats, InstallSource, PairingRequest, SystemEnabled, SystemRecord, SystemStatus, TypeDefinitions } from './records/systems.ts';
import { Policy } from './records/actors.ts';
import { CONTEXT_ORIGIN_TYPES, ContextFromResourceArgs, ContextFromResourceResult, ContextLink, DeclarableRelation, LinkTarget, RememberArgs } from './context-graph.ts';
import { FnMetrics, FnMetricsDay, FnMetricsQuery } from './metrics.ts';
import { ModelCall, ModelCallQuery, ModelRole, ModelRoleView, RoleChoice } from './model-calls.ts';
import { ModelLimits, ModelLimitsView, SelectionReport } from './modes.ts';
import { InstanceRecord } from './package.ts';
import { FormOffer, FormRecord, ResourceFacet, ResourceImportArgs, ResourceQuery, ResourceReadArgs, ResourceReadResult } from './resource-forms.ts';
import { HubMcpInput, HubMcpView, McpRules, McpScopePreview, McpSessionView } from './records/mcps.ts';
import { FormKind } from './resources.ts';

// ─── Middleware defs (bound once, in the hub's api module) ────────────────────

/** Request telemetry: first in every chain. */
export const tel = telemetry();
/** The signed-in user, from a bearer access token (`?access_token=` over the WebSocket). */
export const hubAuth = bearerAuth<AccessClaims, UserView>();
/** Refuses anyone who isn't an admin. Requires `hubAuth`. */
export const adminOnly = middleware('adminOnly', { requires: [hubAuth] });

// ─── Shapes only the web API uses ─────────────────────────────────────────────

/** A signed-in browser's tokens. `expiresIn` is ms until the access token expires. */
export const Tokens = z.object({ access: z.string(), refresh: z.string(), expiresIn: Duration, user: UserView });
export type Tokens = z.infer<typeof Tokens>;

/** Whether the hub still needs its admin account made. */
export const SetupState = z.object({ needsAdmin: z.boolean(), name: z.string(), version: z.string() });
export type SetupState = z.infer<typeof SetupState>;

/** A suggestion for the message being written: fns and context that match it by meaning. */
export const Suggestion = z.object({
  kind: z.enum(['fn', 'context']),
  name: QualifiedName,
  description: z.string(),
  score: SuggestionScore,
  why: z.string().optional(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** A provider as an admin enters it: like `ProviderConfig`, but with the key itself. */
export const ProviderInput = providerVariants(z.string().min(1));
export type ProviderInput = z.infer<typeof ProviderInput>;

/** What waits on a person in a session, so a reload shows it again. */
export const Waiting = z.object({ approvals: z.array(Approval), handlers: z.array(HandlerCall) });
export type Waiting = z.infer<typeof Waiting>;

/** An instance as the admin pages show it: without its public key. */
export const InstanceView = InstanceRecord.omit({ publicKey: true });
export type InstanceView = z.infer<typeof InstanceView>;

/**
 * A system as the admin pages show it: the system, every instance, and for pages that show one copy, its default
 * instance's key, config, process and last sighting (`keyFingerprint` is blank for a system with no instance).
 */
export const SystemView = SystemRecord.omit({ keyFingerprint: true, publicKey: true, config: true, pairedAt: true, pairedBy: true, lastSeenAt: true, address: true })
  .extend(InstanceRecord.pick({ keyFingerprint: true, config: true, installed: true, pairedAt: true, pairedBy: true, lastSeenAt: true, address: true }).shape)
  .extend({
    fns: z.number().int(),
    needsConfig: z.boolean(),
    configType: Json.optional(),
    instances: z.array(InstanceView),
  });
export type SystemView = z.infer<typeof SystemView>;

// ─── Events ───────────────────────────────────────────────────────────────────

/** What a browser watching one session hears. */
export const SessionEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: ChatMessage }),
  /** Streaming text of an assistant message. */
  z.object({ type: z.literal('token'), message: MessageId, text: z.string() }),
  /** Streaming reasoning of an assistant message. */
  z.object({ type: z.literal('reasoning'), message: MessageId, text: z.string() }),
  z.object({ type: z.literal('controls'), controls: SessionControls }),
  z.object({ type: z.literal('run'), run: RunId, fn: QualifiedName, update: RunUpdate }),
  /** Session state changed; each renderer picks the fields it declared. */
  z.object({ type: z.literal('state'), system: SystemName, fields: z.array(StateFieldValue) }),
  z.object({ type: z.literal('delivery'), delivery: DeliveryView }),
  z.object({ type: z.literal('handler'), call: HandlerCall }),
  z.object({ type: z.literal('approval'), approval: Approval }),
  /**
   * A budget whose rule says `ask` is used up, and a run here waits until someone raises it (an admin, with
   * `setBudget`). `reason` says which budget and how much, in words.
   */
  z.object({ type: z.literal('budget'), run: RunId, budget: BudgetRule, reason: z.string() }),
  z.object({ type: z.literal('presence'), presence: Presence }),
  z.object({ type: z.literal('session'), session: SessionSummary }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** What a signed-in browser hears about the user and the hub. */
export const UserEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notification'), notification: Notification }),
  z.object({ type: z.literal('approval'), approval: Approval }),
  z.object({ type: z.literal('system'), system: SystemName, status: SystemStatus }),
  z.object({ type: z.literal('pairing'), pairing: PairingRequest }),
  z.object({ type: z.literal('capabilities') }),
  z.object({ type: z.literal('session'), session: SessionSummary }),
  /** A session was deleted: lists drop it. */
  z.object({ type: z.literal('session-deleted'), session: SessionId }),
  /** A fn's running numbers changed (one of its runs settled). */
  z.object({ type: z.literal('fn'), fn: QualifiedName, system: SystemName, stats: FnStats }),
  /** A resource changed or a form of it was made: browsers refresh its badges and open viewer. */
  z.object({ type: z.literal('resource'), uri: ResourceUri, forms: z.array(FormKind) }),
  /** A context item was written, linked or forgotten. */
  z.object({ type: z.literal('context'), name: QualifiedName }),
]);
export type UserEvent = z.infer<typeof UserEvent>;

// ─── Slices ───────────────────────────────────────────────────────────────────

// Each slice is a spec the hub serves as one plugin. A slice under more than one middleware chain merges one spec per
// chain, so every endpoint carries its chain's guards, and `mergeSpecs` refuses a name used twice.

/** Sign-in and who is signed in. Setting up and signing in are open; the rest need a signed-in user. */
export const authSlice = mergeSpecs(
  spec({
    endpoints: use(tel).group({
      setup: { method: 'GET', response: SetupState, ws: 'setup' },
      /** Make the single admin account. Only works while `setup.needsAdmin`. */
      createAdmin: { body: z.object({ email: z.email(), name: z.string().min(1), password: z.string().min(10) }), response: Tokens, ws: 'createAdmin' },
      signIn: { body: z.object({ email: z.email(), password: z.string() }), response: Tokens, errors: { 401: z.object({ reason: z.string() }) }, ws: 'signIn' },
      refresh: { body: z.object({ refresh: z.string() }), response: Tokens, ws: 'refresh' },
    }),
  }),
  spec({
    endpoints: use(tel, hubAuth).group({
      signOut: { ws: 'signOut' },
      me: { method: 'GET', response: UserView, ws: 'me' },
    }),
  }),
);

/** What the session list is filtered and paged by. */
export const SessionListQuery = PageRequest.extend({ search: z.string().optional(), archived: z.boolean().optional() });
export type SessionListQuery = z.infer<typeof SessionListQuery>;

/** A page of a session's messages, newest first, paged backwards with the cursor. */
export const MessageListQuery = PageRequest.extend({ session: SessionId });
export type MessageListQuery = z.infer<typeof MessageListQuery>;

/** What the inbox is filtered and paged by. */
export const NotificationListQuery = PageRequest.extend({ unread: z.boolean().optional() });
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

/** Sessions, messages, turns and what the composer may offer. */
/**
 * What can change on a session: its owner's settings (title, systems, agent, archive, priority, and the agent's model,
 * chat mode and contextor here, each `null` to go back to the agent fn's own), and any participant's `notify`.
 */
export const SessionPatch = Session.pick({ title: true, systems: true, agent: true, archived: true }).partial().extend({
  priority: Priority.optional(),
  notify: NotifyChoice.optional(),
  model: Session.shape.model.unwrap().nullable().optional(),
  mode: Session.shape.mode.unwrap().nullable().optional(),
  contextor: Session.shape.contextor.unwrap().nullable().optional(),
});
export type SessionPatch = z.infer<typeof SessionPatch>;

export const chatSlice = spec({
  endpoints: use(tel, hubAuth).group({
    capabilities: { body: z.object({ session: SessionId.optional() }), response: ChatCapabilities, ws: 'capabilities' },
    /** Named type definitions and every named type they reference, dependencies first, so the browser's forms can check values with gin. */
    types: { body: z.object({ names: z.array(QualifiedName).min(1) }), response: TypeDefinitions, ws: 'types' },
    sessions: { body: SessionListQuery, response: page(SessionSummary), ws: 'sessions' },
    session: { body: z.object({ session: SessionId }), response: Session, ws: 'session' },
    createSession: { body: Session.pick({ agent: true, systems: true, title: true }).partial(), response: Session, ws: 'createSession' },
    updateSession: { body: SessionPatch.extend({ session: SessionId }), response: Session, ws: 'updateSession' },
    /** Delete a session for good, with its messages and state; its owner only. Work still running in it is cancelled. */
    deleteSession: { body: z.object({ session: SessionId }), response: z.object({ deleted: z.boolean() }), ws: 'deleteSession' },
    /** The priority and budgets the next turn in a session would get, for the budget meter. */
    limits: { body: z.object({ session: SessionId }), response: ResolvedLimits, ws: 'limits' },
    /** Messages, newest first, paged backwards with the cursor. */
    messages: { body: MessageListQuery, response: page(ChatMessage), ws: 'messages' },
    send: {
      body: z.object({ session: SessionId, parts: z.array(OutgoingPart).min(1), replyTo: MessageId.optional(), replyAll: z.boolean().optional(), client: ClientInfo }),
      response: z.object({ turn: TurnId, message: ChatMessage }),
      ws: 'send',
    },
    /** Run a fn by hand (`!fn`). */
    invoke: { body: z.object({ session: SessionId, fn: QualifiedName, args: Json, client: ClientInfo }), response: z.object({ turn: TurnId, run: RunId }), ws: 'invoke' },
    control: { body: z.object({ session: SessionId, action: SessionControlAction }), response: SessionControls, ws: 'control' },
    presence: { body: Presence.omit({ user: true, lastActiveAt: true }), ws: 'presence' },
  }),
});

/** Runs: their tree, inspectors, approvals, handler answers, actions, forms and state. */
export const runsSlice = spec({
  endpoints: use(tel, hubAuth).group({
    /** Move a run to the background so the agent stops waiting for it. */
    background: { body: z.object({ run: RunId }), response: z.object({ accepted: z.boolean() }), ws: 'background' },
    undoTurn: { body: z.object({ turn: TurnId }), response: UndoReport, ws: 'undoTurn' },
    tree: { body: z.object({ turn: TurnId }), response: TreeNode, ws: 'tree' },
    run: { body: z.object({ run: RunId }), response: Run, ws: 'run' },
    llmCall: { body: z.object({ id: LlmInteractionId }), response: LlmInteraction, ws: 'llmCall' },
    /** What waits on the signed-in person in a session: pending approvals of its runs, and questions its runs asked them. */
    waiting: { body: z.object({ session: SessionId }), response: Waiting, ws: 'waiting' },
    approve: { body: z.object({ approval: ApprovalId, approve: z.boolean(), remember: Remember, reason: z.string().optional() }), response: Approval, ws: 'approve' },
    /** Answer a handler a run asked a person for. */
    answer: { body: z.object({ call: HandlerCallId, value: Json }), ws: 'answer' },
    /** Send an action from a renderer. Stored, then delivered when the system is online. */
    act: { body: z.object({ session: SessionId, system: SystemName, action: z.string(), input: Json, run: RunId.optional(), client: ClientInfo }), response: z.object({ delivery: DeliveryId }), ws: 'act' },
    /** Submit a fn's form to its waiting run. */
    submit: { body: z.object({ run: RunId, value: Json }), response: z.object({ delivery: DeliveryId }), ws: 'submit' },
    /**
     * Every state field a run's fn declared (with its type, and its value when it has one), for its renderer's first
     * draw; changes then arrive as `state` session events, matched by name and type.
     */
    state: { body: z.object({ run: RunId }), response: z.object({ system: SystemName, fields: z.array(StateFieldValue) }), ws: 'state' },
  }),
});

/** Finding things: suggestions, search, mentions and resources. */
export const findSlice = spec({
  endpoints: use(tel, hubAuth).group({
    /** Fns and context that match a draft message by meaning (and words), for the composer's suggestions. */
    suggest: { body: z.object({ session: SessionId, text: z.string(), limit: z.number().int().min(1).max(20).optional() }), response: z.array(Suggestion), ws: 'suggest' },
    search: { body: z.object({ query: z.string(), kinds: z.array(IndexedKind).optional(), limit: z.number().int().min(1).max(50).optional() }), response: z.array(SearchHit), ws: 'search' },
    mentions: { body: z.object({ session: SessionId, provider: QualifiedName, query: z.string() }), response: z.array(MentionOption), ws: 'mentions' },
    mentionHover: { body: z.object({ session: SessionId, provider: QualifiedName, target: Json }), response: z.object({ hover: MentionHover.optional() }), ws: 'mentionHover' },
    resource: { body: z.object({ uri: ResourceUri, want: z.array(ReadWant) }), response: ResourceRead, ws: 'resource' },
  }),
});

/** The inbox and web push. */
export const inboxSlice = spec({
  endpoints: use(tel, hubAuth).group({
    notifications: { body: NotificationListQuery, response: page(Notification), ws: 'notifications' },
    readNotifications: { body: z.object({ ids: z.array(Notification.shape.id) }), ws: 'readNotifications' },
    pushKey: { method: 'GET', response: z.object({ publicKey: z.string() }), ws: 'pushKey' },
    subscribePush: { body: PushSubscription.pick({ endpoint: true, keys: true, device: true }), response: PushSubscription.pick({ id: true }), ws: 'subscribePush' },
  }),
});

/** Uploads and transcription. */
export const contentSlice = spec({
  endpoints: use(tel, hubAuth).group({
    /** A presigned URL to upload a file to; then send it as a `file` part with the returned ref. */
    upload: { body: z.object({ name: z.string(), mime: z.string(), size: z.number().int().min(0) }), response: z.object({ url: z.string(), upload: z.string() }), ws: 'upload' },
    /** Finish an upload: the hub hashes it and returns its content ref. */
    uploaded: { body: z.object({ upload: z.string() }), response: ContentRef, ws: 'uploaded' },
    transcribe: { body: z.object({ audio: ContentRef }), response: z.object({ text: z.string() }), ws: 'transcribe' },
  }),
});

/** Systems and pairing (admins). */
export const systemsSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    systems: { body: z.object({}), response: z.array(SystemView), ws: 'systems' },
    system: { body: z.object({ system: SystemName }), response: SystemView, ws: 'system' },
    pairings: { body: z.object({ status: PairingRequest.shape.status.optional() }), response: z.array(PairingRequest), ws: 'pairings' },
    /** Approve or refuse; an approval may name the instance and set the config in the same step (the QR pairing page). */
    approvePairing: {
      body: z.object({ pairing: PairingId, approve: z.boolean(), instance: InstanceName.optional(), config: Json.optional() }),
      response: z.object({ system: SystemName.optional() }),
      ws: 'approvePairing',
    },
    createPairingToken: { body: z.object({ name: SystemName.optional(), expiresIn: Duration }), response: z.object({ token: z.string(), expiresAt: Timestamp }), ws: 'createPairingToken' },
    /** Set a system's config: one instance's (each fs machine has its own folders), else its default instance's. Refused unless valid. */
    configureSystem: { body: z.object({ system: SystemName, config: Json, instance: InstanceName.optional() }), response: z.union([z.object({ version: z.number().int() }), z.object({ problems: z.array(z.string()) })]), ws: 'configureSystem' },
    /** Turn a system's functions and renderers on or off separately. */
    enableSystem: { body: z.object({ system: SystemName, functions: z.boolean().optional(), renderers: z.boolean().optional() }), response: z.object({ enabled: SystemEnabled }), ws: 'enableSystem' },
    removeSystem: { body: z.object({ system: SystemName }), response: z.object({ fnsUnavailable: z.number().int() }), ws: 'removeSystem' },
    installSystem: { body: z.object({ source: InstallSource, config: Json.optional(), autoStart: z.boolean().optional() }), response: z.object({ name: SystemName }), ws: 'installSystem' },
    /** Start an installed system's instances, or one of them. */
    startSystem: { body: z.object({ system: SystemName, instance: InstanceName.optional() }), response: z.object({ ok: z.boolean() }), ws: 'startSystem' },
    /** Stop an installed system's instances, or one of them. */
    stopSystem: { body: z.object({ system: SystemName, instance: InstanceName.optional() }), response: z.object({ ok: z.boolean() }), ws: 'stopSystem' },
    upgradeSystem: { body: z.object({ system: SystemName, version: z.string().optional() }), response: z.object({ from: z.string(), to: z.string() }), ws: 'upgradeSystem' },
    reimport: { body: z.object({ system: SystemName }), response: ImportReport, ws: 'reimport' },
  }),
});

/** Providers, models, budgets, priorities, policies, settings, users and groups (admins). */
export const settingsSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    /** Add or replace a provider. Keys arrive in plain text over TLS and are stored encrypted as secrets. */
    configureProvider: { body: ProviderInput, response: z.object({ models: z.number().int() }), ws: 'configureProvider' },
    providers: { body: z.object({}), response: z.array(z.object({ id: ProviderId, provider: ProviderKind, models: z.number().int() })), ws: 'providers' },
    /** Add a rule, or replace the one with `id` (an edit). */
    setModelCategory: { body: ModelCategory.partial({ id: true }), response: ModelCategory.pick({ id: true }), ws: 'setModelCategory' },
    setBudget: { body: BudgetRule.omit({ setBy: true }).partial({ id: true }), response: BudgetRule.pick({ id: true }), ws: 'setBudget' },
    setPriority: { body: PriorityRule.omit({ setBy: true }).partial({ id: true }), response: PriorityRule.pick({ id: true }), ws: 'setPriority' },
    setPolicy: { body: Policy.omit({ createdBy: true, createdAt: true }).partial({ id: true }), response: Policy.pick({ id: true }), ws: 'setPolicy' },
    setActorSetting: { body: z.object({ setting: QualifiedName, actor: ActorId, value: Json }), response: z.object({ ok: z.boolean() }), ws: 'setActorSetting' },
    addUser: { body: z.object({ email: z.email(), name: z.string(), role: UserRole, groups: z.array(ActorId).optional() }), response: z.object({ id: ActorId }), ws: 'addUser' },
    addGroup: { body: z.object({ name: z.string(), about: z.string(), members: z.array(ActorId).optional() }), response: z.object({ id: ActorId }), ws: 'addGroup' },
  }),
});

/** The admin pages' reads, and the output of systems as it arrives (admins). */
export const adminSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    /** A system's fns, with whether each can be used now and its running numbers. */
    systemFns: { body: z.object({ system: SystemName }), response: z.array(FnRecord), ws: 'systemFns' },
    /** The end of a system's output, oldest first; new lines arrive on `systemLog`. */
    systemLogs: { body: z.object({ system: SystemName, limit: z.number().int().min(1).max(2_000).optional() }), response: z.array(OutputLine), ws: 'systemLogs' },
    models: { body: z.object({ provider: ProviderId.optional() }), response: z.array(ModelInfo), ws: 'models' },
    modelCategories: { body: z.object({}), response: z.array(ModelCategory), ws: 'modelCategories' },
    budgets: { body: z.object({}), response: z.array(BudgetView), ws: 'budgets' },
    priorityRules: { body: z.object({}), response: z.array(PriorityRule), ws: 'priorityRules' },
    /** The priority and budgets a turn by `user` (in `session`, when given) would get now. */
    resolveLimits: { body: z.object({ user: ActorId, session: SessionId.optional() }), response: ResolvedLimits, ws: 'resolveLimits' },
    policies: { body: z.object({}), response: z.array(Policy), ws: 'policies' },
    actors: { body: z.object({ kind: ActorKind.optional() }), response: z.array(Actor), ws: 'actors' },
    actorSettings: { body: z.object({}), response: z.object({ declared: z.array(SettingView), values: z.array(ActorSetting) }), ws: 'actorSettings' },
    /** Runs, newest first. */
    runs: { body: PageRequest.extend(RunFilter.shape), response: page(Run), ws: 'runs' },
    /** LLM calls, newest first. */
    llmCalls: { body: PageRequest.extend(LlmFilter.shape), response: page(LlmSummary), ws: 'llmCalls' },
    /** Resources the hub knows, most recently seen first. */
    resources: { body: PageRequest.extend(ResourceFilter.shape), response: page(ResourceRecord), ws: 'resources' },
    removeRule: { body: RuleRef, response: z.object({ ok: z.boolean() }), ws: 'removeRule' },
  }),
  events: {
    /** New output lines of one system (admins). */
    systemLog: { params: z.object({ system: SystemName }), data: OutputLine, guard: [hubAuth, adminOnly], ws: 'on.systemLog' },
  },
});

/** The realtime events of a signed-in browser (no endpoints). */
export const eventsSlice = spec({
  endpoints: {},
  events: {
    // Event channel ids share the ws namespace with endpoint ids (`session` is an endpoint's), so events get an `on.` prefix.
    session: { params: z.object({ session: SessionId }), data: SessionEvent, guard: [hubAuth], ws: 'on.session' },
    user: { data: UserEvent, guard: [hubAuth], ws: 'on.user' },
  },
});

// ─── Build 2 slices ───────────────────────────────────────────────────────────

/** A page of resources with the counts of one grouping's values. */
export const ResourcePage = page(ResourceRecord).extend({ facets: z.array(ResourceFacet) });
export type ResourcePage = z.infer<typeof ResourcePage>;

/** A resource's forms: the record, what has been made, and what could be. */
export const ResourceForms = z.object({ record: ResourceRecord, forms: z.array(FormRecord), offers: z.array(FormOffer) });
export type ResourceForms = z.infer<typeof ResourceForms>;

/**
 * Resources: browsing with groups and facets, reading any form, making forms, importing URLs and uploads, renaming
 * and deleting hub resources, and making context from a resource. Each endpoint runs the same operation as the hub
 * fn of the same purpose (`hub/resource_read` and `readResource`), so the chat LLM and the browser see the same.
 */
export const resourcesSlice = spec({
  endpoints: use(tel, hubAuth).group({
    browseResources: { body: ResourceQuery, response: ResourcePage, ws: 'browseResources' },
    resourceForms: { body: z.object({ uri: ResourceUri }), response: ResourceForms, ws: 'resourceForms' },
    readResource: { body: ResourceReadArgs, response: ResourceReadResult, ws: 'readResource' },
    /** Make a form now (describe, OCR, transcribe, convert) and answer when it is made. */
    convertResource: { body: z.object({ uri: ResourceUri, kind: FormKind }), response: FormRecord, ws: 'convertResource' },
    /** A presigned download of the raw content or one form (with Range, for audio and video). */
    downloadResource: { body: z.object({ uri: ResourceUri, form: FormKind.optional() }), response: z.object({ url: z.string(), mime: z.string(), size: z.number().int().min(0) }), ws: 'downloadResource' },
    importResource: { body: ResourceImportArgs, response: ResourceRecord, ws: 'importResource' },
    renameResource: { body: z.object({ uri: ResourceUri, name: z.string().min(1) }), response: ResourceRecord, ws: 'renameResource' },
    /** Hub resources only. `referencedBy` counts the messages, context and runs that still point at it. */
    deleteResource: { body: z.object({ uri: ResourceUri }), response: z.object({ deleted: z.boolean(), referencedBy: z.number().int().min(0) }), ws: 'deleteResource' },
    contextFromResource: { body: ContextFromResourceArgs, response: ContextFromResourceResult, ws: 'contextFromResource' },
  }),
});

/** What the context list narrows by. */
export const ContextQuery = PageRequest.extend({ search: z.string().optional(), origin: z.enum(CONTEXT_ORIGIN_TYPES).optional(), system: SystemName.optional() });
export type ContextQuery = z.infer<typeof ContextQuery>;

/** One context item with its edges both ways and its text (dynamic context is asked for). */
export const ContextItemView = z.object({ record: ContextRecord, links: z.array(ContextLink), backlinks: z.array(ContextLink), text: z.string().optional() });
export type ContextItemView = z.infer<typeof ContextItemView>;

/** Context: browse every item and its links, write and forget memory, draw and remove links. */
export const contextSlice = spec({
  endpoints: use(tel, hubAuth).group({
    contexts: { body: ContextQuery, response: page(ContextRecord), ws: 'contexts' },
    contextItem: { body: z.object({ name: QualifiedName }), response: ContextItemView, ws: 'contextItem' },
    remember: { body: RememberArgs, response: z.object({ name: QualifiedName }), ws: 'remember' },
    forget: { body: z.object({ name: QualifiedName }), response: z.object({ ok: z.boolean() }), ws: 'forget' },
    linkContext: { body: z.object({ from: QualifiedName, to: LinkTarget, relation: DeclarableRelation, weight: z.number().min(0).max(1) }), response: ContextLink, ws: 'linkContext' },
    unlinkContext: { body: ContextLink.pick({ from: true, toKey: true, relation: true }), response: z.object({ ok: z.boolean() }), ws: 'unlinkContext' },
  }),
});

/** Chat modes and contextors: model limits, and a dry run of what a message's prompt would hold. */
export const contextorSlice = mergeSpecs(
  spec({
    endpoints: use(tel, hubAuth).group({
      /** Each model's resolved limits with where each came from (all chat models when `model` is absent). */
      modelLimits: { body: z.object({ model: z.string().optional() }), response: z.array(ModelLimitsView), ws: 'modelLimits' },
      /** What the session's contextor would put in the prompt for this text, without calling the model. */
      previewSelection: { body: z.object({ session: SessionId, text: z.string() }), response: SelectionReport, ws: 'previewSelection' },
    }),
  }),
  spec({
    endpoints: use(tel, hubAuth, adminOnly).group({
      /** Set (or, with every field absent, clear) the limits of one model. */
      setModelLimits: { body: z.object({ model: z.string().min(1), limits: ModelLimits }), response: ModelLimitsView, ws: 'setModelLimits' },
    }),
  }),
);

/** Model roles: which model and provider transcribes, dictates, speaks, describes images and reads text in them (admins). */
export const modelsSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    modelRoles: { body: z.object({}), response: z.array(ModelRoleView), ws: 'modelRoles' },
    setModelRole: { body: RoleChoice, response: ModelRoleView, ws: 'setModelRole' },
    clearModelRole: { body: z.object({ role: ModelRole }), response: ModelRoleView, ws: 'clearModelRole' },
  }),
});

/** Every model call of every modality, and fn metrics (admins). */
export const metricsSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    modelCalls: { body: ModelCallQuery, response: page(ModelCall), ws: 'modelCalls' },
    modelCall: { body: z.object({ id: ModelCallId }), response: ModelCall, ws: 'modelCall' },
    fnMetrics: { body: FnMetricsQuery, response: z.array(FnMetrics), ws: 'fnMetrics' },
    /** One fn's daily rollups, oldest first, for its charts. */
    fnMetricsDays: { body: z.object({ fn: QualifiedName, days: z.number().int().min(1).max(365).optional() }), response: z.array(FnMetricsDay), ws: 'fnMetricsDays' },
  }),
});

/** Hub MCPs (admins). `createMcp` and `rotateMcpSecret` return the secret: the only time it is shown. */
export const mcpsSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    mcps: { body: z.object({}), response: z.array(HubMcpView), ws: 'mcps' },
    mcp: { body: z.object({ mcp: HubMcpId }), response: HubMcpView, ws: 'mcp' },
    createMcp: { body: HubMcpInput, response: z.object({ mcp: HubMcpView, secret: z.string() }), ws: 'createMcp' },
    updateMcp: { body: HubMcpInput.partial().extend({ mcp: HubMcpId }), response: HubMcpView, ws: 'updateMcp' },
    /** A new secret; every open session of the MCP ends. */
    rotateMcpSecret: { body: z.object({ mcp: HubMcpId }), response: z.object({ secret: z.string() }), ws: 'rotateMcpSecret' },
    deleteMcp: { body: z.object({ mcp: HubMcpId }), response: z.object({ ok: z.boolean() }), ws: 'deleteMcp' },
    /** What draft rules would expose now, before saving. */
    previewMcp: { body: z.object({ rules: McpRules }), response: McpScopePreview, ws: 'previewMcp' },
    mcpSessions: { body: z.object({ mcp: HubMcpId }), response: z.array(McpSessionView), ws: 'mcpSessions' },
  }),
});

/** Pairing pages, a fleet's instances, and data exports (admins). */
export const packagingSlice = spec({
  endpoints: use(tel, hubAuth, adminOnly).group({
    /** One pairing request for the `/pair/:pairing` page, with what the system said about itself. */
    pairing: { body: z.object({ pairing: PairingId }), response: PairingRequest, ws: 'pairing' },
    instances: { body: z.object({ system: SystemName }), response: z.array(InstanceView), ws: 'instances' },
    /**
     * Install a package zip (`harness system pack`) uploaded with `upload`: checked (format, protocol, file hashes, no
     * path leaving the folder), placed under `systems/<name>/versions/<version>`, paired, configured and started. A
     * name already installed adds an instance (for a fleet); the same instance takes a newer version as an upgrade and
     * refuses anything else. `data` is a data export (`exportSystemData`) to restore into the new instance.
     */
    installPackage: {
      body: z.object({ zip: ContentRef, instance: InstanceName.optional(), config: Json.optional(), data: ContentRef.optional(), autoStart: z.boolean().optional() }),
      response: InstanceRef,
      ws: 'installPackage',
    },
    removeInstance: { body: InstanceRef, response: z.object({ ok: z.boolean() }), ws: 'removeInstance' },
    /**
     * Zip an instance's data folder (its config only when `withSecrets`, since the hub can't tell secret fields apart).
     * Returns the zip's ref and a presigned download of it, which the CLI and the admin page fetch.
     */
    exportSystemData: { body: InstanceRef.extend({ withSecrets: z.boolean().optional() }), response: ContentRef.extend({ url: z.string() }), ws: 'exportSystemData' },
  }),
});

/** The web API: every endpoint and event the browser uses, joined from the slices (a name used twice doesn't compile). */
export const hubWebSpec = mergeSpecs(
  authSlice, chatSlice, runsSlice, findSlice, inboxSlice, contentSlice, systemsSlice, settingsSlice, adminSlice, eventsSlice,
  resourcesSlice, contextSlice, contextorSlice, modelsSlice, metricsSlice, mcpsSlice, packagingSlice,
);
export type HubWebSpec = typeof hubWebSpec;
