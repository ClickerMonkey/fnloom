/**
 * The web API: what the browser calls on the hub (HTTP and the browser's WebSocket), and the realtime events it
 * receives. `hubWebSpec` is the one source of truth; the hub implements it and the Vue app calls it through
 * ayepi client callers built from its manifest.
 */
import { bearerAuth } from '@ayepi/auth';
import { middleware, spec, use } from '@ayepi/core';
import { telemetry } from '@ayepi/otel';
import { z } from 'zod';
import { MentionHover, MentionOption, ImportReport } from './manifest.ts';
import {
  ActorId, ApprovalId, DeliveryId, Duration, ProviderId, HandlerCallId, Json, LlmInteractionId, MessageId, PageRequest, PairingId, Priority, QualifiedName,
  RunId, SessionId, SystemName, Timestamp, TurnId, page,
} from './primitives.ts';
import { ReadWant, ResourceRead, ResourceUri, ContentRef } from './resources.ts';
import { ClientInfo, RunUpdate } from './run.ts';
import { Approval, Remember, UserRole, UserView, type AccessClaims } from './records/actors.ts';
import { ChatCapabilities, ChatMessage, NotifyChoice, OutgoingPart, Presence, Session, SessionControls, SessionSummary } from './records/chat.ts';
import { IndexedKind, Notification, SearchHit } from './records/content.ts';
import { DeliveryView, HandlerCall, LlmInteraction, Run, TreeNode, UndoReport } from './records/runs.ts';
import { BudgetRule, ModelCategory, PriorityRule, ProviderKind, ResolvedLimits } from './records/spend.ts';
import { InstallSource, PairingRequest, SystemEnabled, SystemRecord, SystemStatus } from './records/systems.ts';
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
  score: z.number(),
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

/** A system as the admin pages show it. */
export const SystemView = SystemRecord.omit({ publicKey: true }).extend({
  fns: z.number().int(),
  needsConfig: z.boolean(),
  configType: Json.optional(),
});
export type SystemView = z.infer<typeof SystemView>;

// ─── Endpoints ────────────────────────────────────────────────────────────────

const open = use(tel).group({
  setup: { method: 'GET', response: SetupState, ws: 'setup' },
  /** Make the single admin account. Only works while `setup.needsAdmin`. */
  createAdmin: { body: z.object({ email: z.email(), name: z.string().min(1), password: z.string().min(10) }), response: Tokens, ws: 'createAdmin' },
  signIn: { body: z.object({ email: z.email(), password: z.string() }), response: Tokens, errors: { 401: z.object({ reason: z.string() }) }, ws: 'signIn' },
  refresh: { body: z.object({ refresh: z.string() }), response: Tokens, ws: 'refresh' },
});

const signedIn = use(tel, hubAuth).group({
  signOut: { ws: 'signOut' },
  me: { method: 'GET', response: UserView, ws: 'me' },
  capabilities: { body: z.object({ session: SessionId.optional() }), response: ChatCapabilities, ws: 'capabilities' },
  sessions: { body: PageRequest.extend({ search: z.string().optional(), archived: z.boolean().optional() }), response: page(SessionSummary), ws: 'sessions' },
  session: { body: z.object({ session: SessionId }), response: Session, ws: 'session' },
  createSession: { body: z.object({ agent: QualifiedName.optional(), systems: z.union([z.array(SystemName), z.literal('all')]).optional(), title: z.string().optional() }), response: Session, ws: 'createSession' },
  updateSession: {
    body: z.object({
      session: SessionId,
      title: z.string().optional(),
      systems: z.union([z.array(SystemName), z.literal('all')]).optional(),
      agent: QualifiedName.optional(),
      priority: Priority.optional(),
      archived: z.boolean().optional(),
      notify: NotifyChoice.optional(),
    }),
    response: Session,
    ws: 'updateSession',
  },
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
  /** Move a run to the background so the agent stops waiting for it. */
  background: { body: z.object({ run: RunId }), response: z.object({ accepted: z.boolean() }), ws: 'background' },
  undoTurn: { body: z.object({ turn: TurnId }), response: UndoReport, ws: 'undoTurn' },
  tree: { body: z.object({ turn: TurnId }), response: TreeNode, ws: 'tree' },
  run: { body: z.object({ run: RunId }), response: Run, ws: 'run' },
  llmCall: { body: z.object({ id: LlmInteractionId }), response: LlmInteraction, ws: 'llmCall' },
  /** Fns and context that match a draft message by meaning (and words), for the composer's suggestions. */
  suggest: { body: z.object({ session: SessionId, text: z.string(), limit: z.number().int().min(1).max(20).optional() }), response: z.array(Suggestion), ws: 'suggest' },
  search: { body: z.object({ query: z.string(), kinds: z.array(IndexedKind).optional(), limit: z.number().int().min(1).max(50).optional() }), response: z.array(SearchHit), ws: 'search' },
  mentions: { body: z.object({ session: SessionId, provider: QualifiedName, query: z.string() }), response: z.array(MentionOption), ws: 'mentions' },
  mentionHover: { body: z.object({ session: SessionId, provider: QualifiedName, target: Json }), response: z.object({ hover: MentionHover.optional() }), ws: 'mentionHover' },
  approve: { body: z.object({ approval: ApprovalId, approve: z.boolean(), remember: Remember, reason: z.string().optional() }), response: Approval, ws: 'approve' },
  /** Answer a handler a run asked a person for. */
  answer: { body: z.object({ call: HandlerCallId, value: Json }), ws: 'answer' },
  presence: { body: Presence.omit({ user: true, lastActiveAt: true }), ws: 'presence' },
  notifications: { body: PageRequest.extend({ unread: z.boolean().optional() }), response: page(Notification), ws: 'notifications' },
  readNotifications: { body: z.object({ ids: z.array(z.string()) }), ws: 'readNotifications' },
  pushKey: { method: 'GET', response: z.object({ publicKey: z.string() }), ws: 'pushKey' },
  subscribePush: { body: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), device: z.string() }), response: z.object({ id: z.string() }), ws: 'subscribePush' },
  resource: { body: z.object({ uri: ResourceUri, want: z.array(ReadWant) }), response: ResourceRead, ws: 'resource' },
  /** A presigned URL to upload a file to; then send it as a `file` part with the returned ref. */
  upload: { body: z.object({ name: z.string(), mime: z.string(), size: z.number().int().min(0) }), response: z.object({ url: z.string(), upload: z.string() }), ws: 'upload' },
  /** Finish an upload: the hub hashes it and returns its content ref. */
  uploaded: { body: z.object({ upload: z.string() }), response: ContentRef, ws: 'uploaded' },
  transcribe: { body: z.object({ audio: ContentRef }), response: z.object({ text: z.string() }), ws: 'transcribe' },
  /** Send an action from a renderer. Stored, then delivered when the system is online. */
  act: { body: z.object({ session: SessionId, system: SystemName, action: z.string(), input: Json, run: RunId.optional(), client: ClientInfo }), response: z.object({ delivery: DeliveryId }), ws: 'act' },
  /** Submit a fn's form to its waiting run. */
  submit: { body: z.object({ run: RunId, value: Json }), response: z.object({ delivery: DeliveryId }), ws: 'submit' },
  /** The state fields a renderer's fn declared, for its first render; changes then arrive as events. */
  state: { body: z.object({ run: RunId }), response: z.object({ values: z.record(z.string(), Json) }), ws: 'state' },
});

const admin = use(tel, hubAuth, adminOnly).group({
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
  /** Add or replace a provider. Keys arrive in plain text over TLS and are stored encrypted as secrets. */
  configureProvider: { body: ProviderInput, response: z.object({ models: z.number().int() }), ws: 'configureProvider' },
  providers: { body: z.object({}), response: z.array(z.object({ id: ProviderId, provider: ProviderKind, models: z.number().int() })), ws: 'providers' },
  setModelCategory: { body: ModelCategory.omit({ id: true }), response: z.object({ id: z.string() }), ws: 'setModelCategory' },
  setBudget: { body: BudgetRule.omit({ id: true, setBy: true }), response: z.object({ id: z.string() }), ws: 'setBudget' },
  setPriority: { body: PriorityRule.omit({ id: true, setBy: true }), response: z.object({ id: z.string() }), ws: 'setPriority' },
  setPolicy: { body: Policy.omit({ id: true, createdBy: true, createdAt: true }), response: z.object({ id: z.string() }), ws: 'setPolicy' },
  setActorSetting: { body: z.object({ setting: QualifiedName, actor: ActorId, value: Json }), response: z.object({ ok: z.boolean() }), ws: 'setActorSetting' },
  addUser: { body: z.object({ email: z.email(), name: z.string(), role: UserRole, groups: z.array(ActorId).optional() }), response: z.object({ id: ActorId }), ws: 'addUser' },
  addGroup: { body: z.object({ name: z.string(), about: z.string(), members: z.array(ActorId).optional() }), response: z.object({ id: ActorId }), ws: 'addGroup' },
});

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
  z.object({ type: z.literal('state'), system: SystemName, fields: z.array(z.object({ name: z.string(), type: z.string(), value: Json.optional() })) }),
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
]);
export type UserEvent = z.infer<typeof UserEvent>;

/** The web API: every endpoint and event the browser uses. */
export const hubWebSpec = spec({
  endpoints: { ...open, ...signedIn, ...admin },
  events: {
    // Event channel ids share the ws namespace with endpoint ids (`session` is an endpoint's), so events get an `on.` prefix.
    session: { params: z.object({ session: SessionId }), data: SessionEvent, guard: [hubAuth], ws: 'on.session' },
    user: { data: UserEvent, guard: [hubAuth], ws: 'on.user' },
  },
});
export type HubWebSpec = typeof hubWebSpec;
