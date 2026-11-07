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
  ActorId, ActorKind, ApprovalId, DeliveryId, Duration, ProviderId, HandlerCallId, Json, LlmInteractionId, MessageId, PageRequest, PairingId, Priority, QualifiedName,
  RunId, SessionId, SystemName, Timestamp, TurnId, page,
} from './primitives.ts';
import { ReadWant, ResourceRead, ResourceUri, ContentRef } from './resources.ts';
import { ClientInfo, RunUpdate } from './run.ts';
import { Actor, ActorSetting, Approval, Remember, UserRole, UserView, type AccessClaims } from './records/actors.ts';
import { ChatCapabilities, ChatMessage, NotifyChoice, OutgoingPart, Presence, Session, SessionControls, SessionSummary } from './records/chat.ts';
import { IndexedKind, Notification, ResourceRecord, SearchHit } from './records/content.ts';
import { DeliveryView, HandlerCall, LlmInteraction, Run, StateFieldValue, TreeNode, UndoReport } from './records/runs.ts';
import { BudgetRule, ModelCategory, PriorityRule, ProviderKind, ResolvedLimits } from './records/spend.ts';
import { FnRecord, FnStats, InstallSource, PairingRequest, SystemEnabled, SystemRecord, SystemStatus } from './records/systems.ts';
import { Policy } from './records/actors.ts';

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
export const ProviderInput = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('openai'), apiKey: z.string().min(1), baseURL: z.url().optional() }),
  z.object({ provider: z.literal('openrouter'), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal('aws'), region: z.string(), credentials: z.string().optional() }),
  z.object({ provider: z.literal('replicate'), apiKey: z.string().min(1) }),
]);
export type ProviderInput = z.infer<typeof ProviderInput>;

/** What waits on a person in a session, so a reload shows it again. */
export const Waiting = z.object({ approvals: z.array(Approval), handlers: z.array(HandlerCall) });
export type Waiting = z.infer<typeof Waiting>;

/** A system as the admin pages show it. */
export const SystemView = SystemRecord.omit({ publicKey: true }).extend({
  fns: z.number().int(),
  needsConfig: z.boolean(),
  configType: Json.optional(),
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

/** Sessions, messages, turns and what the composer may offer. */
export const chatSlice = spec({
  endpoints: use(tel, hubAuth).group({
    capabilities: { body: z.object({ session: SessionId.optional() }), response: ChatCapabilities, ws: 'capabilities' },
    sessions: { body: PageRequest.extend({ search: z.string().optional(), archived: z.boolean().optional() }), response: page(SessionSummary), ws: 'sessions' },
    session: { body: z.object({ session: SessionId }), response: Session, ws: 'session' },
    createSession: { body: Session.pick({ agent: true, systems: true, title: true }).partial(), response: Session, ws: 'createSession' },
    updateSession: {
      body: Session.pick({ title: true, systems: true, agent: true, archived: true }).partial().extend({
        session: SessionId,
        priority: Priority.optional(),
        notify: NotifyChoice.optional(),
        /** The model the agent answers with here; `null` goes back to the one its fn chooses. */
        model: Session.shape.model.unwrap().nullable().optional(),
      }),
      response: Session,
      ws: 'updateSession',
    },
    /** Delete a session for good, with its messages and state; its owner only. Work still running in it is cancelled. */
    deleteSession: { body: z.object({ session: SessionId }), response: z.object({ deleted: z.boolean() }), ws: 'deleteSession' },
    /** The priority and budgets the next turn in a session would get, for the budget meter. */
    limits: { body: z.object({ session: SessionId }), response: ResolvedLimits, ws: 'limits' },
    /** Messages, newest first, paged backwards with the cursor. */
    messages: { body: PageRequest.extend({ session: SessionId }), response: page(ChatMessage), ws: 'messages' },
    send: {
      body: z.object({ session: SessionId, parts: z.array(OutgoingPart).min(1), replyTo: MessageId.optional(), replyAll: z.boolean().optional(), client: ClientInfo }),
      response: z.object({ turn: TurnId, message: ChatMessage }),
      ws: 'send',
    },
    /** Run a fn by hand (`!fn`). */
    invoke: { body: z.object({ session: SessionId, fn: QualifiedName, args: Json, client: ClientInfo }), response: z.object({ turn: TurnId, run: RunId }), ws: 'invoke' },
    control: { body: z.object({ session: SessionId, action: z.enum(['pause', 'resume', 'cancel']) }), response: SessionControls, ws: 'control' },
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
    notifications: { body: PageRequest.extend({ unread: z.boolean().optional() }), response: page(Notification), ws: 'notifications' },
    readNotifications: { body: z.object({ ids: z.array(z.string()) }), ws: 'readNotifications' },
    pushKey: { method: 'GET', response: z.object({ publicKey: z.string() }), ws: 'pushKey' },
    subscribePush: { body: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), device: z.string() }), response: z.object({ id: z.string() }), ws: 'subscribePush' },
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
    approvePairing: { body: z.object({ pairing: PairingId, approve: z.boolean() }), response: z.object({ system: SystemName.optional() }), ws: 'approvePairing' },
    createPairingToken: { body: z.object({ name: SystemName.optional(), expiresIn: Duration }), response: z.object({ token: z.string(), expiresAt: Timestamp }), ws: 'createPairingToken' },
    /** Set a system's config. Refused unless it is valid for the system's config type. */
    configureSystem: { body: z.object({ system: SystemName, config: Json }), response: z.union([z.object({ version: z.number().int() }), z.object({ problems: z.array(z.string()) })]), ws: 'configureSystem' },
    /** Turn a system's functions and renderers on or off separately. */
    enableSystem: { body: z.object({ system: SystemName, functions: z.boolean().optional(), renderers: z.boolean().optional() }), response: z.object({ enabled: SystemEnabled }), ws: 'enableSystem' },
    removeSystem: { body: z.object({ system: SystemName }), response: z.object({ fnsUnavailable: z.number().int() }), ws: 'removeSystem' },
    installSystem: { body: z.object({ source: InstallSource, config: Json.optional(), autoStart: z.boolean().optional() }), response: z.object({ name: SystemName }), ws: 'installSystem' },
    startSystem: { body: z.object({ system: SystemName }), response: z.object({ ok: z.boolean() }), ws: 'startSystem' },
    stopSystem: { body: z.object({ system: SystemName }), response: z.object({ ok: z.boolean() }), ws: 'stopSystem' },
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
    setModelCategory: { body: ModelCategory.partial({ id: true }), response: z.object({ id: z.string() }), ws: 'setModelCategory' },
    setBudget: { body: BudgetRule.omit({ setBy: true }).partial({ id: true }), response: z.object({ id: z.string() }), ws: 'setBudget' },
    setPriority: { body: PriorityRule.omit({ setBy: true }).partial({ id: true }), response: z.object({ id: z.string() }), ws: 'setPriority' },
    setPolicy: { body: Policy.omit({ createdBy: true, createdAt: true }).partial({ id: true }), response: z.object({ id: z.string() }), ws: 'setPolicy' },
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

/** The web API: every endpoint and event the browser uses, joined from the slices (a name used twice doesn't compile). */
export const hubWebSpec = mergeSpecs(authSlice, chatSlice, runsSlice, findSlice, inboxSlice, contentSlice, systemsSlice, settingsSlice, adminSlice, eventsSlice);
export type HubWebSpec = typeof hubWebSpec;
