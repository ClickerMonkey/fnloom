// The harness, as types. No implementation: what each thing holds and does, for review before the zod
// schemas and code. Read docs/harness.md first; browse both in explorer/explorer.html.
//
// Conventions
// - Shapes here become zod schemas, and the TS types are then derived from those schemas (ayepi rule).
//   Interfaces are written by hand only for this review.
// - Durations are plain milliseconds named without a unit suffix (`timeout`, `window`), as in ayepi.
// - Money is US dollars as a number (`Usd`), matching aeye's `Usage.cost`.
// - "Decl" is the JSON form a station sends over the wire. "Record" is the row the hub stores. Author-side
//   builders (what a station writes in TypeScript) are fully typed; once a thing has crossed the wire it
//   is JSON plus gin type definitions and is checked at runtime.
// - `@status` marks things that are not part of the first build: `later` (designed, built after the fs
//   station) or `future` (noted so the design leaves room).

import type { TypeDef, ExprDef } from '@aeye/gin';
import type { Usage, Message, Request as AeyeRequest, Response as AeyeResponse, Chunk } from '@aeye/core';
import type { ModelInfo, ModelCapability, Provider } from '@aeye/ai';
import type { ResourceSlicer, ResourceParser } from '@aeye/resources';
import type { Manifest } from '@ayepi/core';
import type { RetryOptions } from '@ayepi/work';
import type { FileStore } from '@ayepi/files';

// ═══ Foundations ═══

declare const brand: unique symbol;
declare const ginValue: unique symbol;

/** An opaque id for an entity of kind K (a UUID string at runtime). Ids of different kinds can't be mixed up. */
export type Id<K extends string> = string & { readonly [brand]: K };

/** Milliseconds. */
export type Duration = number;
/** Milliseconds since the epoch. */
export type Timestamp = number;
/** US dollars. */
export type Usd = number;

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A station's unique name: lowercase letters, digits and dashes (`fs`, `claude-code`). It namespaces everything the station contributes. */
export type StationName = string & { readonly [brand]: 'StationName' };

/** A name qualified by its station: `fs/read_file`, `hub/chat`, `fs/FileInfo`. Fns, kinds, types, context and hooks are all named this way. */
export type QualifiedName<S extends string = string, N extends string = string> = `${S}/${N}`;

/** How urgent a queued LLM request or run is. Higher runs first; within a priority, older runs first. */
export type Priority = 'urgent' | 'interactive' | 'normal' | 'background';

/** Who can see a thing: the user in the UI, the LLM in its prompt, or both. */
export type Audience = 'user' | 'llm' | 'both' | 'none';

/** A page of results with an opaque cursor for the next page. Every list in the hub is paged. */
export interface Page<T> {
  items: T[];
  /** Absent on the last page. */
  cursor?: string;
}

// ═══ Gin types ═══

/** A gin type definition in its JSON wire form (gin `TypeDef`). This is how types travel and are stored. */
export type GinTypeDef = TypeDef;

/** A gin program in its JSON wire form (gin `ExprDef`). */
export type GinProgram = ExprDef;

/**
 * A gin type a station author builds in TypeScript, carrying the TS type of its values.
 * gin itself has no static inference, so the harness SDK wraps gin's builders: `g.obj({ path: g.text() })`
 * is a `GinType<{ path: string }>` whose `def` is the wire `TypeDef`. Everything typed in the SDK flows from these.
 */
export interface GinType<T> {
  /** The wire definition, sent to the hub and stored there. */
  readonly def: GinTypeDef;
  /** Phantom: the TS type of a value. Never set at runtime. */
  readonly [ginValue]?: T;
}

/** A field of `g.obj` that may be absent. Made with `g.optional(t)`. */
export interface GinOptional<T> extends GinType<T | undefined> {
  readonly optional: true;
}

/** The TS value type of a gin type: `Infer<typeof args>`. */
export type Infer<G> = G extends GinType<infer T> ? T : never;

/** The keys of an object-type's fields that were built with `g.optional`. */
type OptionalKeys<P> = { [K in keyof P]: P[K] extends GinOptional<unknown> ? K : never }[keyof P];
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The TS object type of `g.obj(props)`: optional fields become optional keys. */
export type ObjOf<P extends Record<string, GinType<unknown>>> = Simplify<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } &
  { [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined> }
>;

/** Options gin allows on a number type. */
export interface GinNumOptions { min?: number; max?: number; whole?: boolean }
/** Options gin allows on a text type. */
export interface GinTextOptions { minLength?: number; maxLength?: number; pattern?: string }

/**
 * The typed gin builder the station SDK exports as `g`. Each method calls the matching gin builder and keeps
 * the TS value type. Every gin type class has a builder, so every type an author can describe can also be
 * shown as a chat input.
 */
export interface GinBuilder {
  text(options?: GinTextOptions): GinType<string>;
  num(options?: GinNumOptions): GinType<number>;
  bool(): GinType<boolean>;
  date(): GinType<string>;
  timestamp(): GinType<Timestamp>;
  duration(): GinType<Duration>;
  /** Any JSON value. Use sparingly: the LLM and the forms get no structure. */
  json(): GinType<Json>;
  list<T>(item: GinType<T>, options?: { minLength?: number; maxLength?: number }): GinType<T[]>;
  map<V>(value: GinType<V>): GinType<Record<string, V>>;
  obj<const P extends Record<string, GinType<unknown>>>(props: P, docs?: { [K in keyof P]?: string }): GinType<ObjOf<P>>;
  optional<T>(type: GinType<T>): GinOptional<T>;
  nullable<T>(type: GinType<T>): GinType<T | null>;
  enum<const V extends readonly [string, ...string[]]>(values: V): GinType<V[number]>;
  literal<const V extends string | number | boolean>(value: V): GinType<V>;
  or<const A extends readonly [GinType<unknown>, ...GinType<unknown>[]]>(...types: A): GinType<Infer<A[number]>>;
  /** A named type another station exports, by its typed handle (see `TypeRef`). */
  ref<T>(type: TypeRef<T>): GinType<T>;
  /** A resource URI. Inputs for it open a resource picker. */
  resource(): GinType<ResourceUri>;
  /** Attach docs to a type. */
  docs<T>(type: GinType<T>, docs: string): GinType<T>;
}

/** A named type a station exports (`fs/FileInfo`): its qualified name plus its typed gin type. */
export interface TypeRef<T, N extends QualifiedName = QualifiedName> {
  readonly name: N;
  readonly type: GinType<T>;
}

/** A named type as a station sends it in its manifest. */
export interface TypeDecl {
  name: string;
  description: string;
  def: GinTypeDef;
}

/** A gin fn signature: args and result types, as wire definitions. The hub builds gin types, zod schemas and LLM tool schemas from it. */
export interface FnSignature {
  args: GinTypeDef;
  returns: GinTypeDef;
}

// ═══ Actors ═══

/** What kind of thing an actor is. */
export type ActorKind = 'user' | 'group' | 'agent' | 'station' | 'system';

/**
 * Anything that can act, own, or be granted something. The core table: runs, messages and records all name
 * the actor that caused them, and policies and settings attach to actors.
 */
export interface ActorBase {
  id: Id<'actor'>;
  kind: ActorKind;
  name: string;
  /** A short description; the LLM sees it for agents and other session participants. */
  about: string;
  createdAt: Timestamp;
  disabled: boolean;
}

/** A person who signs in. */
export interface UserActor extends ActorBase {
  kind: 'user';
  email: string;
  role: 'admin' | 'member';
  /** IANA time zone, used by the local-time hook when the browser doesn't send one. */
  timeZone?: string;
}

/** A named set of users. Users can be in zero or more groups. */
export interface GroupActor extends ActorBase {
  kind: 'group';
}

/** An `llm` fn acting as a participant. Created when an llm fn is declared, so its runs and messages have an author. */
export interface AgentActor extends ActorBase {
  kind: 'agent';
  fn: QualifiedName;
}

/** A connected station acting on its own (events it emits, runs it starts). */
export interface StationActor extends ActorBase {
  kind: 'station';
  station: StationName;
}

/** The hub itself (schedules, self-healing, boot work). */
export interface SystemActor extends ActorBase {
  kind: 'system';
}

/** One of the actor kinds. */
export type Actor = UserActor | GroupActor | AgentActor | StationActor | SystemActor;

/** A user's membership in a group. */
export interface Membership {
  group: Id<'actor'>;
  user: Id<'actor'>;
  addedBy: Id<'actor'>;
  addedAt: Timestamp;
}

/** How a user signs in. Passwords are hashed by the hub (ayepi auth leaves this to the app). */
export interface Credential {
  user: Id<'actor'>;
  kind: 'password' | 'passkey';
  secretHash: string;
  createdAt: Timestamp;
}

/** A signed-in browser. Tokens are ayepi bearer JWTs; this row makes refresh and revocation possible. */
export interface AuthSession {
  id: Id<'authSession'>;
  user: Id<'actor'>;
  /** Bumped to revoke every token issued under this session. */
  version: number;
  device: string;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  /** Set when this session acts as another user (admin only). Actions are recorded under the admin. */
  actingAs?: Id<'actor'>;
}

// ═══ Permissions ═══

/** Which actors a policy applies to. */
export type ActorMatch =
  | { actor: Id<'actor'> }
  | { group: Id<'actor'> }
  | { kind: ActorKind }
  | { everyone: true };

/** Which fns a policy applies to. All given fields must match. */
export interface FnMatch {
  /** Exact name, or a glob over qualified names (`fs/*`, `*\/delete_*`). */
  fn?: string;
  station?: StationName;
  kind?: QualifiedName;
  /** Every listed tag must be on the fn. */
  tags?: string[];
  /** A gin predicate over the call's args (`args.path` starts with `/tmp`). */
  when?: GinProgram;
}

/** Who answers an "ask" policy. */
export type Approver =
  | { by: 'turn-user' }
  | { by: 'actor'; actor: Id<'actor'> }
  | { by: 'group'; group: Id<'actor'>; /** How many members must approve. Default 1. */ quorum?: number }
  | { by: 'judge'; /** An `llm` fn that returns allow or deny with a reason. */ fn: QualifiedName }
  | { by: 'system' };

/** What a policy decides. */
export type PolicyEffect = { effect: 'allow' } | { effect: 'deny'; reason: string } | { effect: 'ask'; approver: Approver };

/**
 * A permission rule: may these actors run these fns? The hub evaluates every policy that matches a call; deny
 * beats ask beats allow, and a more specific match beats a broader one. With no matching policy the default is ask
 * the turn's user. Policies are system controlled: only admins and approved `hub/system` fns change them.
 */
export interface Policy {
  id: Id<'policy'>;
  description: string;
  subject: ActorMatch;
  target: FnMatch;
  decision: PolicyEffect;
  /** Breaks ties between equally specific policies. */
  priority: number;
  expiresAt?: Timestamp;
  createdBy: Id<'actor'>;
  createdAt: Timestamp;
}

/** An outstanding "ask": a run waiting for someone to approve it. */
export interface ApprovalRequest {
  id: Id<'approval'>;
  run: Id<'run'>;
  policy?: Id<'policy'>;
  approver: Approver;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decisions: ApprovalDecision[];
  createdAt: Timestamp;
}

/** One answer to an approval request. */
export interface ApprovalDecision {
  by: Id<'actor'>;
  approve: boolean;
  /** "Always" writes a policy; "session" lasts for this session only. */
  remember: 'once' | 'session' | 'always';
  reason?: string;
  at: Timestamp;
}

/**
 * A typed control a station declares and admins attach to actors: for example a database station's row and field
 * access rules per group, or a quota. The station reads the effective value for the acting user when it runs a fn.
 */
export interface ActorSettingDecl {
  name: string;
  description: string;
  type: GinTypeDef;
  /** Which actor kinds it can be set on. */
  appliesTo: ActorKind[];
  /** How a user's value combines with their groups' values. */
  merge: 'user-wins' | 'union' | 'intersect' | 'most-restrictive';
  /** Who may set it besides admins: the actor themself, or fns (a tool call can set it). */
  editableBy: Array<'self' | 'fns'>;
}

/** A value of an actor setting attached to one actor. */
export interface ActorSetting {
  setting: QualifiedName;
  actor: Id<'actor'>;
  value: Json;
  setBy: Id<'actor'>;
  /** Set when a fn set it. */
  run?: Id<'run'>;
  updatedAt: Timestamp;
}

// ═══ Stations ═══

/** Where a station is in its life. */
export type StationStatus = 'pairing' | 'connected' | 'disconnected' | 'removed';

/** The hub's row for a station. */
export interface StationRecord {
  name: StationName;
  description: string;
  status: StationStatus;
  /** Fingerprint of the public key it paired with. A known name must prove it holds this key. */
  keyFingerprint: string;
  version: string;
  /** Hash of the last imported manifest; reconnecting with the same hash skips the import. */
  manifestHash: string;
  pairedAt?: Timestamp;
  pairedBy?: Id<'actor'>;
  lastSeenAt?: Timestamp;
  /** Where it last connected from (shown to admins). */
  address?: string;
  actor: Id<'actor'>;
}

/** How a new station gets paired. */
export type PairingMethod =
  /** The station prints a short code; an admin confirms it matches in the UI, in chat or from a push notification. */
  | { method: 'code'; code: string }
  /** An admin made a one-time token first and the station was started with it. */
  | { method: 'token'; token: string };

/** A pending pairing, waiting for an admin. */
export interface PairingRequest {
  id: Id<'pairing'>;
  name: StationName;
  keyFingerprint: string;
  version: string;
  address: string;
  method: PairingMethod['method'];
  /** Present for `code` pairing: what the admin compares. */
  code?: string;
  /** Set when the name is already paired to a different key; approving replaces the old station. */
  replaces?: StationName;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/** A one-time token an admin creates so a station can pair without a code. */
export interface PairingToken {
  id: Id<'pairingToken'>;
  /** The station name it may claim, or any name. */
  name?: StationName;
  tokenHash: string;
  createdBy: Id<'actor'>;
  expiresAt: Timestamp;
  usedAt?: Timestamp;
}

/**
 * Everything a station contributes, sent on connect (or skipped if the hash matches) and kept current with
 * `ManifestPatch`es. The hub imports it into its tables and indexes it. Names inside are unqualified; the hub
 * prefixes them with the station's name.
 */
export interface StationManifest {
  name: StationName;
  version: string;
  description: string;
  /** Hash of everything below; sent in `Hello`. */
  hash: string;
  types: TypeDecl[];
  kinds: FnKindDecl[];
  fns: FnDecl[];
  resourceRoots: ResourceRootDecl[];
  sectionRules: SectionRuleDecl[];
  context: ContextDecl[];
  mentions: MentionProviderDecl[];
  hooks: HookDecl[];
  embedders: EmbedderDecl[];
  actorSettings: ActorSettingDecl[];
  /** Hub events the station wants to receive. */
  subscriptions: HubEventName[];
  /** Browser assets (renderers, inputs). */
  client?: ClientAssetsDecl;
  /** Other stations this one calls fns of; shown to admins, and fns depending on a missing one are unavailable. */
  requires: StationName[];
  /** True when the station also serves MCP (stdio or HTTP). */
  mcp: boolean;
}

/** The parts of a manifest a patch can touch. */
export type ManifestSection = 'types' | 'kinds' | 'fns' | 'resourceRoots' | 'sectionRules' | 'context' | 'mentions' | 'hooks' | 'embedders' | 'actorSettings';

/** A runtime change to a station's manifest: things added, replaced or removed after connecting. */
export interface ManifestPatch {
  /** The manifest hash after applying it. */
  hash: string;
  upsert: Partial<Pick<StationManifest, ManifestSection>>;
  remove: Partial<Record<ManifestSection, string[]>>;
}

/** Browser assets a station serves. The hub fetches them by hash and serves them to the chat UI. */
export interface ClientAssetsDecl {
  /** The ES module the UI imports; its default export is a `StationClientModule`. */
  entry: string;
  /** Content hash of the built assets, so the hub and browsers cache them. */
  hash: string;
  files: Array<{ path: string; size: number; hash: string }>;
}

// ═══ Station link ═══

/**
 * The first frame a station sends. If the name is new, pairing starts. If it is known, the hub replies with a
 * `Challenge` the station signs with its private key.
 */
export interface Hello {
  protocol: 1;
  name: StationName;
  version: string;
  /** A fresh id per process start, so the hub can tell a restart from a reconnect. */
  instance: string;
  publicKey: string;
  manifestHash: string;
  /** Present when starting with a pairing token. */
  pairingToken?: string;
}

/** The hub's challenge to a known station. */
export interface Challenge {
  nonce: string;
}

/** The station's answer: the nonce signed with its private key. */
export interface ChallengeAnswer {
  signature: string;
}

/** The hub accepts the station. */
export interface Welcome {
  /** A short-lived station token (ayepi JWT) for HTTP fetches such as asset uploads. */
  token: string;
  /** Whether the hub wants the full manifest (the hash it holds differs). */
  sendManifest: boolean;
  /** The hub's limits for this station's messages. */
  limits: LinkLimits;
}

/** Size limits that keep station traffic small. */
export interface LinkLimits {
  /** Largest frame either side may send. Bigger content goes as a `ContentRef`. */
  maxFrame: number;
  /** Largest chunk of a content transfer. */
  maxChunk: number;
  /** Heartbeat interval. */
  heartbeat: Duration;
}

/**
 * How the one WebSocket carries both directions. ayepi's ws protocol is one-way (the client calls, the server
 * answers and pushes events), so each side runs both: the station is an ayepi client of the hub's `HubLink` spec
 * and an ayepi server of its own `StationLink` spec, with no HTTP listener. Every frame is wrapped with the
 * direction it belongs to and routed to the local ayepi server or the local ayepi client. Frames are ayepi's JSON
 * text frames; binary frames are a library ask.
 */
export interface LinkFrame {
  /** `h`: part of a call the station made to the hub (or its reply). `s`: part of a call the hub made to the station. */
  d: 'h' | 's';
  /** The ayepi frame (call, reply, chunk, end, abort, sub, event). */
  f: Json;
}

/** Large content moved by reference. The receiver fetches it in chunks over the link, or by presigned URL when the hub stores it. */
export interface ContentRef {
  /** sha-256 of the bytes. Content is deduplicated by hash. */
  hash: string;
  size: number;
  mime: string;
  /** Where to get it: from the sending station over the link, or from the hub's file store. */
  from: { station: StationName } | { hub: true };
}

/**
 * What a station calls on the hub. Becomes an ayepi spec (`HubLink`); method names become endpoint names.
 * Everything here is small: ids, typed args and results, and content refs.
 */
export interface HubLink {
  /** Send the full manifest. */
  manifest(manifest: StationManifest): Promise<{ imported: ImportReport }>;
  /** Change the manifest at runtime: add or remove fns, context, and so on. */
  patch(patch: ManifestPatch): Promise<{ imported: ImportReport }>;
  /** Call another fn from inside a run. The hub queues it like every run and replies when it settles. */
  call(input: { parent: Id<'run'>; fn: QualifiedName; args: Json; key: string; budget?: Partial<FnBudget>; handlers: string[]; background: boolean }): Promise<RunSettled>;
  /** Report a run's progress. */
  progress(input: { run: Id<'run'>; progress: ProgressState }): Promise<void>;
  /** Change what can be done to a running run (cancel, pause, ...). */
  operations(input: { run: Id<'run'>; operations: RunOperations }): Promise<void>;
  /** Attach something to the assistant message the run belongs to. */
  attach(input: { run: Id<'run'>; attachment: MessageAttachment }): Promise<void>;
  /** Answer a handler the hub forwarded (this station's run was the caller). */
  handlerResult(input: { call: Id<'handlerCall'>; result: { ok: true; value: Json } | { ok: false; error: FnError } }): Promise<void>;
  /** Report that resources changed (from a watch). */
  resourcesChanged(input: { changes: ResourceChange[] }): Promise<void>;
  /** The aeye provider forward: every LLM call a station makes goes through here so the hub can budget and record it. */
  llm(input: LlmForward): AsyncIterable<LlmForwardChunk>;
  /** Embeddings through the hub's configured embedder. */
  embed(input: { texts: string[]; embedder?: QualifiedName; run?: Id<'run'> }): Promise<{ vectors: number[][]; cost: Usd }>;
  /** Read content the hub stores (attachments, uploads) by ref. */
  content(input: { ref: ContentRef; offset: number; length: number }): Promise<{ chunk: string /* base64 */ }>;
  /** Read and search hub data the station is allowed to see (sessions, runs, context, resources). */
  query(input: HubQuery): Promise<Page<Json>>;
  /** Write a log line to the hub's log (shown on the station's admin page). */
  log(input: { level: 'debug' | 'info' | 'warn' | 'error'; key: string; fields: Record<string, Json> }): Promise<void>;
}

/** What the hub calls on a station. Becomes an ayepi spec (`StationLink`) the station serves over the link. */
export interface StationLink {
  /** Run a fn of a kind this station provides. Resolves when the run settles; progress and calls happen meanwhile. */
  run(input: RunRequest): Promise<FnOutcomeWire>;
  /** Cancel, pause or resume a run in progress. */
  control(input: { run: Id<'run'>; action: 'cancel' | 'pause' | 'resume'; resume?: ResumeInputWire }): Promise<{ accepted: boolean; reason?: string }>;
  /** Undo a finished run with the payload it registered. */
  undo(input: { run: Id<'run'>; fn: QualifiedName; payload: Json }): Promise<UndoOutcome>;
  /** Call a handler this station's fn declared, for a run another caller started (the hub relays it). */
  handler(input: { call: Id<'handlerCall'>; run: Id<'run'>; handler: string; args: Json }): Promise<{ ok: true; value: Json } | { ok: false; error: FnError }>;
  /** Derive what a kind needs from a payload: signature, deps, operations. Used when a fn of this kind is declared at runtime. */
  describe(input: { kind: string; payload: Json }): Promise<KindDescription | { problems: string[] }>;
  /** List the resources inside a root or folder. */
  list(input: { uri: ResourceUri; cursor?: string }): Promise<Page<ResourceStat>>;
  /** Stat one resource without reading it. */
  stat(input: { uri: ResourceUri }): Promise<ResourceStat | undefined>;
  /** Read a resource. The hub asks for what it needs; the station may include more for free. */
  read(input: { uri: ResourceUri; want: ReadWant[] }): Promise<ResourceRead>;
  /** Cut a resource into sections with a rule this station provides. */
  sections(input: { uri: ResourceUri; rule: QualifiedName; version: string }): Promise<Section[]>;
  /** Start or stop watching resources for changes. */
  watch(input: { uris: ResourceUri[]; on: boolean }): Promise<void>;
  /** Stream content this station holds, by ref. */
  content(input: { ref: ContentRef; offset: number; length: number }): Promise<{ chunk: string /* base64 */ }>;
  /** Embed texts with an embedder this station provides. */
  embed(input: { embedder: string; texts: string[] }): Promise<{ vectors: number[][]; cost: Usd }>;
  /** Run a user-message hook. */
  hook(input: { hook: string; message: HookInput }): Promise<HookContribution[]>;
  /** Search a mention provider. */
  mention(input: { provider: string; query: string; session: Id<'session'> }): Promise<MentionOption[]>;
  /** Deliver a subscribed hub event. */
  event(input: HubEvent): Promise<void>;
  /** Ask the station to restart itself (it reconnects and the hub re-imports). */
  restart(input: { reason: string }): Promise<void>;
}

/** What the hub imported from a manifest or patch, reported back to the station and to admins. */
export interface ImportReport {
  added: QualifiedName[];
  updated: QualifiedName[];
  removed: QualifiedName[];
  /** Things refused, with why (bad type, name clash, incompatible change). */
  refused: Array<{ name: string; problems: string[] }>;
}

/** A read of hub data by a station. Always scoped by the station's permissions. */
export interface HubQuery {
  table: 'sessions' | 'messages' | 'runs' | 'context' | 'resources' | 'fns';
  /** Text and semantic search over the table's indexed text. */
  search?: string;
  where?: Record<string, Json>;
  limit: number;
  cursor?: string;
}

// ═══ Fns ═══

/** Whether the LLM, the user (with `!fn`), or both may call a fn. Fns called only by other fns use `none`. */
export type FnVisibility = Audience;

/** A callback a fn may ask its caller for mid-run ("confirm overwrite?", "pick a folder"). */
export interface HandlerDecl {
  description: string;
  args: GinTypeDef;
  returns: GinTypeDef;
  /** A caller that can't answer a required handler can't call the fn. */
  required: boolean;
}

/** How a fn reports progress. */
export type ProgressDecl =
  | { type: 'none' }
  /** A fraction from 0 to 1 with an optional message. */
  | { type: 'linear' }
  /** Named steps, each with a status and sub-status. */
  | { type: 'steps'; steps: Array<{ name: string; title: string }> };

/** What a fn's runs can support. A run can narrow these while it runs (`RunOperations`). */
export interface OperationsDecl {
  cancel: boolean;
  pause: boolean;
  /** Resume after a pause or a hub restart, with the payload the run returned. */
  resume: boolean;
  undo: boolean;
  /** Can be moved to the background so the agent stops waiting for it. Default true. */
  background: boolean;
}

/** Limits and estimates for a fn's runs. */
export interface FnLimits {
  /** Hard time limit for one run; the global tool timeout still applies. */
  timeout?: Duration;
  retry?: Partial<RetryOptions>;
  /** Rough cost per run, used for budget checks before the first measurement. */
  estimatedCost?: Usd;
  /** Rough duration, for the same reason. */
  estimatedTime?: Duration;
}

/**
 * A fn as a station sends it. `kind` names a kind (in this station or another); `payload` is that kind's
 * definition data. For `ts` fns the payload is empty and the signature, deps and operations are written by the
 * author. For other kinds the hub asks the kind's station to `describe` the payload and fills them in.
 */
export interface FnDecl {
  name: string;
  description: string;
  /** Extra guidance the LLM sees when the fn is in its toolset. */
  instructions?: string;
  kind: QualifiedName;
  payload: Json;
  signature: FnSignature;
  /** Fns its implementation may call. Calls to anything else are refused. */
  deps: QualifiedName[];
  handlers: Record<string, HandlerDecl>;
  progress: ProgressDecl;
  operations: OperationsDecl;
  /** Type of the undo payload a finished run registers. */
  undo?: GinTypeDef;
  /** Type of the resume payload a paused run returns. */
  resume?: GinTypeDef;
  limits: FnLimits;
  visibility: FnVisibility;
  tags: string[];
  /** Context loaded whenever this fn is added to a toolset. */
  context: QualifiedName[];
  /** Searchable text the hub embeds (defaults to name + description). */
  searchText?: string;
}

/** Why a fn can't be called right now. */
export type FnUnavailable =
  | 'station-disconnected'
  | 'station-removed'
  | 'kind-missing'
  | 'kind-station-disconnected'
  | 'dep-unavailable'
  | 'disabled'
  | 'paused';

/** The hub's row for a fn: the decl plus who owns it, its state and its measured numbers. */
export interface FnRecord {
  name: QualifiedName;
  station: StationName;
  decl: FnDecl;
  /** Hash of the decl; runs record which version they used. */
  version: string;
  /** Declared by the station at boot, or added at runtime (by a station patch or a `hub/declare_fn` call). */
  origin: 'manifest' | 'runtime';
  declaredBy?: Id<'actor'>;
  available: true | { unavailable: FnUnavailable; detail: string };
  /** Paused by an admin, or automatically after repeated failures. Queued runs wait. */
  paused: boolean;
  disabled: boolean;
  stats: FnStats;
  updatedAt: Timestamp;
}

/** Measured numbers for a fn, kept up to date as runs settle. */
export interface FnStats {
  runs: number;
  failures: number;
  averageCost: Usd;
  averageTime: Duration;
  lastRunAt?: Timestamp;
}

/**
 * A typed handle to a fn, exported from a station's `shared/` folder. Other stations import it to declare a
 * dep and to call the fn with checked args and result. The hub can also generate these for any connected
 * station (`harness-station refs <name>`).
 */
export interface FnRef<N extends QualifiedName, A, R, H extends HandlerDefs = {}> {
  readonly name: N;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  readonly handlers: H;
}

/** Any fn ref. */
export type AnyFnRef = FnRef<QualifiedName, unknown, unknown, HandlerDefs>;

/** A handler as an author declares it. */
export interface HandlerDef<A, R, Req extends boolean = boolean> {
  readonly description: string;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  readonly required: Req;
}

/** A fn's handlers by name. */
export type HandlerDefs = Record<string, HandlerDef<unknown, unknown>>;

/** A fn's deps by local name: `{ stat: fs.fns.stat }`. */
export type FnDeps = Record<string, AnyFnRef>;

// ═══ Fn kinds ═══

/** A kind as a station sends it. */
export interface FnKindDecl {
  name: string;
  description: string;
  /** The type of a fn's payload for this kind. */
  payload: GinTypeDef;
  /** When an agent should choose this kind for a new fn. */
  applicability: string;
  /** Default retry for fns of this kind; a fn may override within what the kind allows. */
  retry?: Partial<RetryOptions>;
  /** How errors are classified is the kind's job; this documents the classes it can produce. */
  errors: ErrorClass[];
  /** Whether the hub must ask before a fn of this kind is declared or changed at runtime. */
  declareNeedsApproval: boolean;
}

/** What a kind derives from one payload. */
export interface KindDescription {
  signature: FnSignature;
  deps: QualifiedName[];
  handlers: Record<string, HandlerDecl>;
  progress: ProgressDecl;
  operations: OperationsDecl;
  undo?: GinTypeDef;
  resume?: GinTypeDef;
}

/**
 * A kind as an author writes it, in a station's server code. The payload is typed; the args and result of a
 * fn of this kind are not (they depend on the payload at runtime), so they arrive as JSON already validated by
 * the hub against the derived signature.
 */
export interface FnKindImpl<P> {
  readonly name: string;
  readonly description: string;
  readonly payload: GinType<P>;
  readonly applicability: string;
  /** Check a payload beyond its type (refs resolve, the program type-checks). */
  validate(payload: P, ctx: KindCtx): Promise<string[]>;
  describe(payload: P, ctx: KindCtx): Promise<KindDescription>;
  run(payload: P, args: Json, ctx: FnCtx<FnDeps, HandlerDefs, ProgressDecl, Json, Json>): Promise<FnOutcome<Json, Json, Json>>;
  undo?(payload: P, undo: Json, ctx: UndoCtx): Promise<UndoOutcome>;
  classify(error: unknown): ErrorClass;
}

/** What a kind can read while validating or describing a payload: the hub's types and fns. */
export interface KindCtx {
  resolveType(name: QualifiedName): Promise<GinTypeDef | undefined>;
  resolveFn(name: QualifiedName): Promise<FnDecl | undefined>;
}

/** The two kinds the hub provides. Every other kind comes from a station. */
export type HubKind = 'hub/system' | 'hub/llm';

/** Payload of a `hub/system` fn: just the id of the native handler compiled into the hub. */
export interface SystemPayload {
  handler: string;
}

/**
 * Payload of a `hub/llm` fn: an agent. The chat agent is one (`hub/chat`). Runs are LLM loops driven by the
 * LLM queue: each iteration is one queued LLM request, its tool calls become child runs.
 */
export interface LlmPayload {
  model: ModelChoice;
  /** Handlebars instructions (aeye prompt content). Can reference the args. */
  instructions: string;
  /** Fns available from the start. */
  tools: FnSetSpec;
  /** Fns the agent may add to its toolset during the run (with `hub/load_fns`). */
  canLoad?: FnSetSpec;
  /** Most fns loaded at once; adding more drops the least recently used. Default 20. */
  maxTools: number;
  /** Context loaded at the start. */
  context: ContextSetSpec;
  /** How context is suggested on each user message. */
  suggest: SuggestConfig;
  /** User-message hooks that run for this agent, in order. */
  hooks: QualifiedName[];
  /** Result type when the agent is called as a fn. A chat agent returns text. */
  output?: GinTypeDef;
  /** Run tool calls one at a time, or all at once. */
  toolExecution: 'parallel' | 'sequential';
  /** Most LLM iterations per turn. */
  maxIterations: number;
}

/** Which model an `llm` fn uses. */
export type ModelChoice =
  | { model: string }
  | { category: Id<'modelCategory'> }
  /** Let aeye pick by weights and required capabilities. */
  | { auto: { weights?: { cost?: number; speed?: number; accuracy?: number }; required?: ModelCapability[] } };

/** A set of fns: explicit names, whole stations, minus exclusions. Only fns that are available and allowed are offered. */
export interface FnSetSpec {
  fns?: QualifiedName[];
  stations?: StationName[];
  tags?: string[];
  exclude?: QualifiedName[];
}

/** A set of context, same shape. */
export interface ContextSetSpec {
  context?: QualifiedName[];
  stations?: StationName[];
  tags?: string[];
  exclude?: QualifiedName[];
}

/** How suggestions are added to user messages. */
export interface SuggestConfig {
  context: { top: number; minScore: number } | false;
  fns: { top: number; minScore: number } | false;
}

/**
 * The fns the hub itself provides (`hub/system` kind). Every admin action has one, so it can be done by asking
 * in chat; changes to configuration always need approval.
 */
export interface HubFns {
  /** Search fns by text and meaning. */
  search_fns: { args: { query: string; limit?: number }; result: Array<{ name: QualifiedName; description: string; available: boolean }> };
  /** Add fns to the running agent's toolset. */
  load_fns: { args: { names: QualifiedName[] }; result: { loaded: QualifiedName[]; refused: Array<{ name: QualifiedName; reason: string }> } };
  /** Remove fns from the running agent's toolset. */
  drop_fns: { args: { names: QualifiedName[] }; result: { dropped: QualifiedName[] } };
  search_context: { args: { query: string; limit?: number }; result: Array<{ name: QualifiedName; description: string }> };
  load_context: { args: { names: QualifiedName[] }; result: { loaded: QualifiedName[]; imported: QualifiedName[] } };
  search_resources: { args: { query: string; roots?: ResourceUri[]; limit?: number }; result: Array<{ uri: ResourceUri; section?: SectionKey; title: string; preview: string }> };
  /** Status of a background run. */
  run_status: { args: { run: Id<'run'> }; result: RunSummary };
  /** Wait for a background run (bounded by the global tool timeout). */
  run_wait: { args: { run: Id<'run'>; timeout?: Duration }; result: RunSummary };
  /** Declare a fn of any kind at runtime. Validated and described by the kind's station. */
  declare_fn: { args: { station: StationName; decl: Omit<FnDecl, 'signature' | 'deps' | 'handlers' | 'progress' | 'operations' | 'undo' | 'resume'> }; result: ImportReport };
  configure_provider: { args: ProviderConfig; result: { ok: boolean; models: number } };
  set_model_category: { args: ModelCategory; result: { ok: boolean } };
  configure_transcription: { args: { provider: string; model?: string } | { off: true }; result: { ok: boolean } };
  create_pairing_token: { args: { name?: StationName; expiresIn: Duration }; result: { token: string; expiresAt: Timestamp } };
  approve_pairing: { args: { pairing: Id<'pairing'>; approve: boolean }; result: { station?: StationName } };
  remove_station: { args: { station: StationName }; result: { removed: boolean; fnsUnavailable: number } };
  set_spend_limit: { args: Omit<SpendLimit, 'id' | 'createdBy'>; result: { id: Id<'spendLimit'> } };
  set_policy: { args: Omit<Policy, 'id' | 'createdBy' | 'createdAt'>; result: { id: Id<'policy'> } };
  set_actor_setting: { args: Omit<ActorSetting, 'setBy' | 'run' | 'updatedAt'>; result: { ok: boolean } };
  set_section_rule: { args: SectionRule; result: { ok: boolean } };
  /** Ask a user something mid-turn and wait (an inbox item and a push notification). */
  ask_user: { args: { question: string; type?: GinTypeDef; user?: Id<'actor'> }; result: { answer: Json } };
}

// ═══ Running fns ═══

/** Money and time a run may spend, carved out of its parent's. A child can never get more than its parent has left. */
export interface FnBudget {
  cost: Usd;
  time: Duration;
}

/** How the error should be handled. */
export type ErrorClass =
  /** Try again (per the fn's retry options). */
  | 'retry'
  /** Give the error to the caller (the LLM sees it and can fix its call). */
  | 'caller'
  /** Stop the whole turn. */
  | 'fatal';

/** An error a run reports. */
export interface FnError {
  class: ErrorClass;
  message: string;
  /** A stable code for programs (`not-found`, `budget`, `timeout`, `denied`). */
  code?: string;
  data?: Json;
}

/**
 * What a run's implementation returns. Every outcome reports what it cost beyond LLM calls (those the hub
 * counts itself) so budgets stay exact.
 */
export type FnOutcome<R, U, S> =
  | { status: 'done'; result: R; cost?: Usd; /** Registered so the run can be undone later. */ undo?: U }
  | { status: 'paused'; /** Given back to the fn when it resumes. */ resume: S; cost?: Usd }
  | { status: 'failed'; error: FnError; cost?: Usd; /** Partial work that can still be undone. */ undo?: U }
  | { status: 'cancelled'; cost?: Usd; undo?: U; partial?: R };

/** An outcome after crossing the wire. */
export type FnOutcomeWire = FnOutcome<Json, Json, Json>;

/** The result of undoing a run. */
export type UndoOutcome =
  | { status: 'undone'; summary: string }
  | { status: 'failed'; error: FnError }
  /** Nothing to undo any more (already reverted elsewhere). */
  | { status: 'gone' };

/** Progress as reported. */
export type ProgressState =
  | { type: 'linear'; fraction: number; message?: string }
  | { type: 'steps'; steps: Record<string, StepState> };

/** One step's state. */
export interface StepState {
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  /** A short line under the step ("copied 14 of 30 files"). */
  detail?: string;
}

/** Progress reporting, typed by the fn's progress decl. */
export type ProgressReporter<P extends ProgressDecl> =
  P extends { type: 'linear' } ? { set(fraction: number, message?: string): void } :
  P extends { type: 'steps'; steps: ReadonlyArray<{ name: infer N extends string }> } ? { step(name: N, status: StepState['status'], detail?: string): void } :
  { readonly none: true };

/** What can be done to a run right now. Starts from the fn's `OperationsDecl` and can only narrow it. */
export type RunOperations = Pick<OperationsDecl, 'cancel' | 'pause' | 'background'>;

/** How a caller supplies a handler: a function given the handler's typed args. */
export type HandlerImpl<HD> = HD extends HandlerDef<infer A, infer R> ? (args: A) => Promise<R> : never;

type RequiredHandlerKeys<H extends HandlerDefs> = { [K in keyof H]: H[K]['required'] extends true ? K : never }[keyof H];
type OptionalHandlerKeys<H extends HandlerDefs> = Exclude<keyof H, RequiredHandlerKeys<H>>;

/** Handlers a caller passes: required ones must be given. */
export type HandlerArgs<H extends HandlerDefs> =
  { [K in RequiredHandlerKeys<H>]: HandlerImpl<H[K]> } & { [K in OptionalHandlerKeys<H>]?: HandlerImpl<H[K]> };

/** Options for a call from inside a run. */
export interface CallOptions<H extends HandlerDefs> {
  /** Identifies the call within the run. A resumed run gets finished calls' results by key instead of calling again. Defaults to the dep name plus a counter. */
  key?: string;
  /** Narrow the child's budget. */
  budget?: Partial<FnBudget>;
  /** Don't wait: the handle's result settles later. */
  background?: boolean;
  handlers?: HandlerArgs<H>;
}

/** How a fn calls one of its deps: typed args and handlers; required handlers make the options required. */
export type Caller<A, R, H extends HandlerDefs> =
  [RequiredHandlerKeys<H>] extends [never]
    ? (args: A, options?: CallOptions<H>) => FnCall<R>
    : (args: A, options: CallOptions<H> & { handlers: HandlerArgs<H> }) => FnCall<R>;

/** Callers for every dep of a fn. */
export type Callers<D extends FnDeps> = {
  [K in keyof D]: D[K] extends FnRef<QualifiedName, infer A, infer R, infer H> ? Caller<A, R, H> : never;
};

/** A fn's own handlers as it sees them: required ones are always there, optional ones may be missing. */
export type HandlerCallers<H extends HandlerDefs> =
  { [K in RequiredHandlerKeys<H>]: HandlerImpl<H[K]> } & { [K in OptionalHandlerKeys<H>]: HandlerImpl<H[K]> | undefined };

/**
 * A call in flight, returned at once. `result` settles with the child's result, rejects with a `RunFailed`, or
 * rejects with `Suspended` when the calling run is paused while waiting (the runtime ignores that rejection;
 * the run resumes later with the child's result available by key).
 */
export interface FnCall<R> {
  readonly key: string;
  /** Resolves once the hub has created the child run. */
  readonly run: Promise<Id<'run'>>;
  readonly result: Promise<R>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  /** Live updates: status, progress, operations. */
  on(listener: (update: RunUpdate) => void): () => void;
}

/** Thrown into code that awaits a call when its run is being paused. Don't catch it. */
export declare class Suspended extends Error {
  readonly run: Id<'run'>;
}

/** Thrown when a child run fails or is cancelled. */
export declare class RunFailed extends Error {
  readonly run: Id<'run'>;
  readonly error: FnError;
}

/** What a resumed run receives. */
export interface ResumeInput<S> {
  payload: S;
  /** Results of child calls that finished, by call key. */
  calls: Record<string, RunSettled>;
  /** Why it is resuming: a user resumed it, or the hub restarted. */
  reason: 'resumed' | 'restart';
}

/** A resume input after crossing the wire. */
export type ResumeInputWire = ResumeInput<Json>;

/** How a child run ended, as the caller sees it. */
export type RunSettled =
  | { status: 'done'; result: Json }
  | { status: 'failed'; error: FnError }
  | { status: 'cancelled' }
  | { status: 'background'; run: Id<'run'> };

/**
 * Everything a fn implementation gets besides its args. Typed by the fn's deps, handlers, progress, resume
 * and undo types, so a call to a dep or a progress step that doesn't exist is a compile error.
 */
export interface FnCtx<D extends FnDeps, H extends HandlerDefs, P extends ProgressDecl, S, U> {
  /** Which run this is, who it acts for, and where it sits in the tree. */
  readonly run: RunInfo;
  /** Money and time left. */
  readonly budget: BudgetView;
  /** Aborts on cancel, timeout or budget exhaustion. */
  readonly signal: AbortSignal;
  /** Typed callers for the fn's deps, and only those. */
  readonly fns: Callers<D>;
  /** The handlers the caller supplied; optional ones may be missing. */
  readonly handlers: HandlerCallers<H>;
  /** Report progress in the shape the fn declared. */
  readonly progress: ProgressReporter<P>;
  /** Narrow what can be done to this run now ("can't cancel during the commit"). */
  operations(set: Partial<RunOperations>): void;
  /** Called when the run is asked to pause. Return the resume payload; the run then stops. Without a hook the run can't pause. */
  onPause(hook: () => S | Promise<S>): void;
  /** Present when resuming. */
  readonly resume: ResumeInput<S> | undefined;
  /** Record an undo payload early (for example after the first irreversible step). The last one recorded wins. */
  undo(payload: U): void;
  /** LLM, files, fetch, resources, attachments, settings, logging. */
  readonly services: FnServices;
}

/** Facts about the current run. */
export interface RunInfo {
  id: Id<'run'>;
  fn: QualifiedName;
  parent?: Id<'run'>;
  turn: Id<'turn'>;
  session?: Id<'session'>;
  /** Who the run acts for: the user of the turn (for permissions and actor settings). */
  actor: Id<'actor'>;
  /** Who called it: the agent, a user (with `!fn`), or another fn's run. */
  caller: Id<'actor'>;
  attempt: number;
  priority: Priority;
}

/** A run's budget as it runs. */
export interface BudgetView {
  readonly total: FnBudget;
  /** What's left now, including what children and LLM calls spent. */
  remaining(): FnBudget;
  /** Report a cost the hub can't see (a paid API call). */
  spend(cost: Usd, what: string): void;
}

/** Services every fn gets. Stations can extend this for their own kinds. */
export interface FnServices {
  /** The hub's LLMs as an aeye `AI` whose provider forwards to the hub (`HarnessProvider`). Costs count against the run. */
  readonly ai: HarnessAI;
  /** File operations, scoped by the station (the fs station limits them to its roots). */
  readonly files: FileOps;
  /** fetch, through the station's outbound rules. */
  readonly fetch: typeof fetch;
  /** Read and search resources from any station the actor may see. */
  readonly resources: ResourceService;
  /** Attach things to the assistant message (links, files, cards). */
  attach(attachment: MessageAttachment): void;
  /** Effective actor settings for the run's actor. */
  setting<T>(setting: TypeRef<T>): Promise<T | undefined>;
  /** Structured log lines with the run's trace context. */
  readonly log: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

/** What an undo implementation gets. */
export interface UndoCtx {
  readonly run: RunInfo;
  readonly signal: AbortSignal;
  readonly services: FnServices;
}

/** The aeye AI instance a station or fn uses; the only provider is the hub. */
export interface HarnessAI {
  /** A ready aeye AI (the concrete type is `AI` from `@aeye/ai` with the `harness` provider). */
  readonly instance: unknown;
  /** Shortcut for a one-shot text or structured answer, budgeted to the run. */
  ask<T = string>(input: { prompt: string; output?: GinType<T>; model?: ModelChoice }): Promise<T>;
}

/** Scoped file operations a station gives its fns. Implemented over `@ayepi/files` `FileStore` where it fits. */
export interface FileOps {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string): Promise<ResourceStat[]>;
  remove(path: string): Promise<void>;
  /** Upload to the hub's file store and get a ref (for attachments). */
  share(path: string): Promise<ContentRef>;
  /** The underlying ayepi store, for fns that want streams. */
  readonly store: FileStore;
}

// ═══ Station SDK ═══

/**
 * A fn as an author declares it in a station's `shared/` folder: the contract, with no implementation. Other
 * stations import it as an `FnRef`. The server folder implements it (`FnImpl`). This is the ayepi def/impl split.
 */
export interface FnDef<A, R, D extends FnDeps, H extends HandlerDefs, P extends ProgressDecl, S, U> {
  readonly description: string;
  readonly instructions?: string;
  readonly args: GinType<A>;
  readonly returns: GinType<R>;
  readonly deps?: D;
  readonly handlers?: H;
  readonly progress?: P;
  readonly operations?: Partial<OperationsDecl>;
  readonly resume?: GinType<S>;
  readonly undo?: GinType<U>;
  readonly limits?: FnLimits;
  readonly visibility?: FnVisibility;
  readonly tags?: string[];
}

/** Any fn def. */
export type AnyFnDef = FnDef<unknown, unknown, FnDeps, HandlerDefs, ProgressDecl, unknown, unknown>;

/** The implementation of a `ts` fn in a station's `server/` folder. */
export interface FnImpl<A, R, D extends FnDeps, H extends HandlerDefs, P extends ProgressDecl, S, U> {
  run(args: A, ctx: FnCtx<D, H, P, S, U>): Promise<FnOutcome<R, U, S>>;
  /** Required when the def declares an undo type. */
  undo?(payload: U, ctx: UndoCtx): Promise<UndoOutcome>;
}

/** The implementation a def requires: `undo` becomes required when the def has an undo type. */
export type ImplFor<F> =
  F extends FnDef<infer A, infer R, infer D, infer H, infer P, infer S, infer U>
    ? FnImpl<A, R, D, H, P, S, U> & ([U] extends [never] ? unknown : { undo(payload: U, ctx: UndoCtx): Promise<UndoOutcome> })
    : never;

/** A station's contract, from `shared/`: its name, types and fn defs. Typed refs for every fn come from it. */
export interface StationDef<N extends string, T extends Record<string, GinType<unknown>>, F extends Record<string, AnyFnDef>> {
  readonly name: N;
  readonly description: string;
  readonly types: { [K in keyof T & string]: TypeRef<Infer<T[K]>, QualifiedName<N, K>> };
  readonly fns: { [K in keyof F & string]: RefOf<N, K, F[K]> };
  readonly defs: F;
}

/** The fn ref a def produces under a station name. */
export type RefOf<N extends string, K extends string, F> =
  F extends FnDef<infer A, infer R, FnDeps, infer H, ProgressDecl, unknown, unknown> ? FnRef<QualifiedName<N, K>, A, R, H> : never;

/** Declare a station's contract. Lives in `shared/` and is safe to import anywhere (no server code). */
export declare function station<const N extends string, const T extends Record<string, GinType<unknown>>, const F extends Record<string, AnyFnDef>>(
  name: N, def: { description: string; types?: T; fns: F },
): StationDef<N, T, F>;

/** Declare one fn's contract. Infers every type from its gin types; the rest of the SDK checks against it. */
export declare function fn<A, R, const D extends FnDeps = {}, const H extends HandlerDefs = {}, const P extends ProgressDecl = { type: 'none' }, S = never, U = never>(
  def: FnDef<A, R, D, H, P, S, U>,
): FnDef<A, R, NoInfer<D>, NoInfer<H>, NoInfer<P>, NoInfer<S>, NoInfer<U>>;

/** Declare a handler for a fn's `handlers`. */
export declare function handler<A, R, const Req extends boolean>(def: HandlerDef<A, R, Req>): HandlerDef<A, R, Req>;

/** Everything a station's server provides beyond fn impls. */
export interface StationServerOptions {
  /** Where the hub is. */
  hub: string;
  /** Where the station keeps its key pair and pairing state. */
  stateDir: string;
  kinds?: FnKindImpl<unknown>[];
  resources?: ResourceProvider;
  sectionRules?: SectionRuleImpl[];
  context?: ContextDecl[];
  mentions?: MentionProviderImpl[];
  hooks?: HookImpl[];
  embedders?: EmbedderImpl[];
  actorSettings?: ActorSettingDecl[];
  /** Called for each subscribed hub event. */
  events?: Partial<{ [E in HubEventName]: (event: Extract<HubEvent, { type: E }>) => Promise<void> }>;
  /** Path to the built client assets. */
  client?: string;
  /** Also serve MCP on stdio (or on an HTTP path). */
  mcp?: { stdio: true } | { http: string };
}

/**
 * Start a station: implement every fn of its contract (a missing impl is a compile error), connect to the hub,
 * pair if needed, send the manifest, and keep it current.
 */
export declare function serve<N extends string, T extends Record<string, GinType<unknown>>, F extends Record<string, AnyFnDef>>(
  def: StationDef<N, T, F>,
  impls: { [K in keyof F]: ImplFor<F[K]> },
  options: StationServerOptions,
): Promise<StationHandle<N>>;

/** A running station. */
export interface StationHandle<N extends string> {
  readonly name: N;
  readonly status: StationStatus;
  /** Add or replace fns at runtime (sends a manifest patch). Loosely typed: the decl is JSON. */
  declare(fns: FnDecl[]): Promise<ImportReport>;
  /** Remove runtime fns. */
  retract(names: string[]): Promise<ImportReport>;
  /** Restart the process; it reconnects and the hub re-imports what changed. */
  restart(reason: string): Promise<never>;
  /** Wait until connected and imported. */
  ready(): Promise<void>;
  stop(): Promise<void>;
}

/** The folders of a station package, and what each builds to. */
export interface StationPackageLayout {
  /** The contract: `station(...)`, types and fn defs. Published for other stations to import. */
  shared: 'shared/';
  /** The process: `serve(...)`. Built for Node. */
  server: 'server/';
  /** Browser code: its entry exports a `StationClientModule`. Built to static assets. */
  client: 'client/';
}

// ═══ Runs and records ═══

/** Where a run is. */
export type RunStatus =
  | 'awaiting-approval'
  | 'queued'
  | 'running'
  /** Waiting on a handler answer or an `input`-style prompt to a person. */
  | 'waiting'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'undone';

/**
 * One call of a fn: the main record. Every run is saved with its args, outcome, timing, cost and position in
 * the tree. Background runs are ordinary runs whose caller stopped waiting.
 */
export interface Run {
  id: Id<'run'>;
  fn: QualifiedName;
  /** The fn version (decl hash) it ran. */
  fnVersion: string;
  kind: QualifiedName;
  /** The station that ran it. */
  station: StationName;
  parent?: Id<'run'>;
  /** The top of its tree (the turn's agent run, or a user-invoked run). */
  root: Id<'run'>;
  turn: Id<'turn'>;
  session?: Id<'session'>;
  /** The call key within the parent. */
  key: string;
  actor: Id<'actor'>;
  caller: Id<'actor'>;
  /** The LLM interaction whose tool call made this run, if any. */
  llmCall?: Id<'llmInteraction'>;
  toolCallId?: string;
  args: Json;
  status: RunStatus;
  outcome?: FnOutcomeWire;
  progress?: ProgressState;
  operations: RunOperations;
  budget: FnBudget;
  /** What it spent itself (not its children). */
  cost: Usd;
  /** What it and everything under it spent. */
  totalCost: Usd;
  priority: Priority;
  background: boolean;
  attempt: number;
  errors: RunError[];
  undo?: Json;
  resume?: Json;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
}

/** A failed attempt, kept for review. */
export interface RunError {
  attempt: number;
  error: FnError;
  cost: Usd;
  at: Timestamp;
}

/** A short view of a run for chat and status tools. */
export interface RunSummary {
  id: Id<'run'>;
  fn: QualifiedName;
  status: RunStatus;
  progress?: ProgressState;
  result?: Json;
  error?: FnError;
  cost: Usd;
  elapsed: Duration;
}

/** A live change to a run, pushed to the UI and to the caller. */
export type RunUpdate =
  | { type: 'status'; status: RunStatus }
  | { type: 'progress'; progress: ProgressState }
  | { type: 'operations'; operations: RunOperations }
  | { type: 'cost'; cost: Usd; totalCost: Usd };

/** What the hub sends a station to start a run. */
export interface RunRequest {
  run: RunInfo;
  fn: QualifiedName;
  kind: string;
  payload: Json;
  args: Json;
  budget: FnBudget;
  /** Names of optional handlers the caller can answer. */
  handlers: string[];
  resume?: ResumeInputWire;
  deadline: Timestamp;
}

/** A node of a turn's fn tree (runs and the LLM calls between them), for the tree view. */
export interface TreeNode {
  run: RunSummary;
  llmCalls: Array<Pick<LlmInteraction, 'id' | 'model' | 'cost' | 'status'>>;
  children: TreeNode[];
}

/**
 * One user message and everything it caused. Every run, LLM call and change traces back to a turn, which is
 * what undo, budgets and the tree view work on.
 */
export interface Turn {
  id: Id<'turn'>;
  session?: Id<'session'>;
  message?: Id<'message'>;
  actor: Id<'actor'>;
  /** The run at the top: the session's agent, or a user-invoked fn. */
  root?: Id<'run'>;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'paused' | 'undone';
  budget: FnBudget;
  cost: Usd;
  /** Stop after this many failed runs, or feed errors back to the agent. */
  errorPolicy: { maxErrors: number } | { feedBack: true };
  createdAt: Timestamp;
  endedAt?: Timestamp;
}

/** What undoing a turn did, shown in the chat. */
export interface UndoReport {
  turn: Id<'turn'>;
  undone: Array<{ run: Id<'run'>; fn: QualifiedName; summary: string }>;
  failed: Array<{ run: Id<'run'>; fn: QualifiedName; error: FnError }>;
  /** Runs that changed things but can't be undone. */
  notUndoable: Array<{ run: Id<'run'>; fn: QualifiedName }>;
}

/** Every LLM call, saved whole: what was asked, what came back, what it cost. */
export interface LlmInteraction {
  id: Id<'llmInteraction'>;
  turn: Id<'turn'>;
  /** The `llm` run this iteration belongs to, or the run whose fn called `ai` directly. */
  run: Id<'run'>;
  session?: Id<'session'>;
  /** The station that asked, when it came through the provider forward. */
  station?: StationName;
  iteration: number;
  provider: string;
  model: string;
  /** The aeye request, with tool schemas as JSON schema. */
  request: Omit<AeyeRequest, 'tools' | 'responseFormat'> & { tools?: Json; responseFormat?: Json };
  response?: AeyeResponse;
  usage?: Usage;
  cost: Usd;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  error?: string;
  priority: Priority;
  queuedAt: Timestamp;
  startedAt?: Timestamp;
  firstTokenAt?: Timestamp;
  endedAt?: Timestamp;
}

// ═══ Queues ═══

/**
 * A queued LLM request: one iteration of an `llm` run. Built on `@ayepi/work` with a priority doer, behind
 * the spend limits.
 */
export interface LlmJob {
  run: Id<'run'>;
  turn: Id<'turn'>;
  session?: Id<'session'>;
  iteration: number;
  priority: Priority;
  /** Reserved before the call, settled after. */
  reservation?: Id<'reservation'>;
}

/** A queued run: the tool-call queue. */
export interface RunJob {
  run: Id<'run'>;
  priority: Priority;
}

/** Hub-wide timing and queue settings (an ayepi env slice). */
export interface QueueSettings {
  /**
   * After this long, a running tool stops blocking the agent if a user is active in the session: it moves to
   * the background and the agent can answer.
   */
  toolTimeout: Duration;
  /** A user counts as active if they sent a message or the chat was focused within this window. */
  activeWindow: Duration;
  /** Most LLM requests running at once. */
  llmConcurrency: number;
  /** Most runs running at once, per station. */
  runConcurrency: number;
  /** How priorities map to queue order. */
  priorities: Record<Priority, number>;
}

// ═══ Sessions and chat ═══

/** A chat. */
export interface Session {
  id: Id<'session'>;
  title: string;
  owner: Id<'actor'>;
  /** The agent that answers (an `llm` fn). Default `hub/chat`. */
  agent: QualifiedName;
  participants: Participant[];
  /** Only these stations' fns, context, mentions and hooks apply. `all` follows every connected station. */
  stations: StationName[] | 'all';
  /** The agent's current toolset (fns loaded so far). */
  tools: QualifiedName[];
  /** Context loaded so far. */
  context: QualifiedName[];
  priority: Priority;
  /** Per-turn default budget. */
  budget: FnBudget;
  status: 'idle' | 'running' | 'paused';
  /** The aeye messages so far, for the next LLM iteration. Kept in sync with `Message` rows. */
  transcript: Message[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archived: boolean;
}

/** Someone in a session. Agents other than the session's answerer reply only when tagged. */
export interface Participant {
  actor: Id<'actor'>;
  role: 'owner' | 'member' | 'agent';
  /** Notify on every message, only when tagged, or never. */
  notify: 'all' | 'tagged' | 'none';
  joinedAt: Timestamp;
}

/** A message in a session. */
export interface ChatMessage {
  id: Id<'message'>;
  session: Id<'session'>;
  turn: Id<'turn'>;
  author: Id<'actor'>;
  role: 'user' | 'assistant' | 'note';
  parts: MessagePart[];
  /** Runs started from this message (tool calls), in order. */
  runs: Id<'run'>[];
  status: 'streaming' | 'done' | 'failed';
  /** Who was tagged (wakes those agents, notifies those people). */
  tagged: Id<'actor'>[];
  createdAt: Timestamp;
}

/** A piece of a message. */
export type MessagePart =
  | { type: 'text'; text: string }
  /** Something picked with `@`; the LLM sees its rendered text. */
  | { type: 'mention'; option: MentionOption }
  /** A `/command` that loaded context. */
  | { type: 'command'; context: QualifiedName; args: string[] }
  /** A `!fn` the user ran, with its result. */
  | { type: 'invocation'; run: Id<'run'>; fn: QualifiedName }
  | { type: 'file'; ref: ContentRef; name: string }
  /** A block a hook added (local time, suggestions). Shown dimmed; the LLM sees it tagged. */
  | { type: 'hook'; hook: QualifiedName; contributions: HookContribution[] }
  | { type: 'attachment'; attachment: MessageAttachment };

/** Something a fn attaches to an assistant message. */
export type MessageAttachment =
  | { type: 'resource'; uri: ResourceUri; section?: SectionKey; title: string }
  | { type: 'url'; url: string; title: string }
  | { type: 'file'; ref: ContentRef; name: string }
  | { type: 'run'; run: Id<'run'>; title: string }
  /** A station's own attachment, drawn by its client renderer. */
  | { type: 'custom'; station: StationName; renderer: string; data: Json; title: string };

/** What a session's controls can do right now, given what is running. */
export interface SessionControls {
  /** Every running run can pause. */
  pause: boolean;
  /** At least one running run can cancel; the rest finish and report. */
  cancel: boolean;
  /** Runs that won't stop if cancelled, so the UI can say so. */
  uncancellable: Id<'run'>[];
  undoLastTurn: boolean;
}

/** Whether a user is looking at a session. Drives the tool timeout rule and notifications. */
export interface Presence {
  session: Id<'session'>;
  user: Id<'actor'>;
  focused: boolean;
  typing: boolean;
  lastActiveAt: Timestamp;
}

/**
 * What the chat UI may show, computed by the hub from what is configured and connected. The UI draws only
 * what is listed.
 */
export interface ChatCapabilities {
  voiceInput: boolean;
  voiceOutput: boolean;
  uploads: boolean;
  /** Characters that open a picker, with their providers. `@` is mentions. */
  mentions: Array<{ provider: QualifiedName; title: string }>;
  commands: Array<{ name: string; context: QualifiedName; args: ContextArg[]; description: string }>;
  /** Fns the user may run with `!`. */
  invocations: Array<{ fn: QualifiedName; description: string; args: GinTypeDef }>;
  /** Station client modules to load for renderers. */
  clients: Array<{ station: StationName; url: string; hash: string }>;
  stations: Array<{ name: StationName; status: StationStatus; enabled: boolean }>;
  models: Array<{ id: string; name: string }>;
}

// ═══ Hooks and inputs ═══

/** A user-message hook as a station declares it. */
export interface HookDecl {
  name: string;
  description: string;
  /** Hooks run in order; lower first. */
  order: number;
  /** Most time it may take before the message goes on without it. */
  timeout: Duration;
}

/** What a hook is given. */
export interface HookInput {
  session: Id<'session'>;
  turn: Id<'turn'>;
  author: Id<'actor'>;
  text: string;
  /** What the browser reported. */
  client: { localTime: string; timeZone: string; locale: string };
}

/** What a hook adds. Each becomes a tagged block the LLM can tell apart from what the user typed. */
export type HookContribution =
  | { type: 'text'; tag: string; text: string }
  | { type: 'suggest-context'; items: Array<{ context: QualifiedName; description: string; score: number }> }
  | { type: 'suggest-fns'; items: Array<{ fn: QualifiedName; description: string; score: number }> }
  /** Load these into the session now (the hook is sure). */
  | { type: 'load'; context?: QualifiedName[]; fns?: QualifiedName[] };

/** The hub's built-in hooks. */
export type HubHook = 'hub/local_time' | 'hub/suggest_context' | 'hub/suggest_fns';

/** A hook's implementation in a station. */
export interface HookImpl {
  decl: HookDecl;
  run(input: HookInput): Promise<HookContribution[]>;
}

/** An `@` search provider as a station declares it. */
export interface MentionProviderDecl {
  name: string;
  title: string;
  description: string;
}

/** One pick in an `@` search. */
export interface MentionOption {
  provider: QualifiedName;
  label: string;
  description?: string;
  /** What it points at. */
  target: { resource: ResourceUri } | { context: QualifiedName } | { fn: QualifiedName } | { actor: Id<'actor'> } | { custom: Json };
  /** The text the LLM sees for it. */
  text: string;
}

/** A mention provider's implementation. */
export interface MentionProviderImpl {
  decl: MentionProviderDecl;
  search(query: string, session: Id<'session'>): Promise<MentionOption[]>;
}

// ═══ Resources ═══

/** An absolute resource URI. Each station owns the URIs under its roots (`file:///home/phil/proj/a.ts`, `https://…`). */
export type ResourceUri = `${string}://${string}`;

/** A place a station offers resources from, initially folders. */
export interface ResourceRootDecl {
  uri: ResourceUri;
  name: string;
  description: string;
  /** Index everything under it, or only what is opened. */
  index: 'all' | 'on-read' | 'none';
  /** Glob patterns to leave out (`node_modules/**`). */
  ignore: string[];
  watch: boolean;
}

/** What is known about a resource without reading it. */
export interface ResourceStat {
  uri: ResourceUri;
  name: string;
  /** Folders, files and pages are all resources. A folder's links are its children. */
  type: 'folder' | 'file' | 'page' | 'record' | 'other';
  mime?: string;
  /** The format sectioning and renderers use (`markdown`, `typescript`, `pdf`). */
  format?: string;
  size?: number;
  modifiedAt?: Timestamp;
  /** Changes whenever the content does (etag, content hash or mtime+size). */
  version: string;
}

/** What the hub asks for when reading. */
export type ReadWant = 'links' | 'contents' | 'text';

/** The result of a read. The station may include contents even if only links were asked for, when it had them anyway. */
export interface ResourceRead {
  stat: ResourceStat;
  links?: ResourceLink[];
  /** The raw bytes, by ref. */
  contents?: ContentRef;
  /** Converted text (markdown), inline when small or by ref. */
  text?: { inline: string } | { ref: ContentRef };
}

/** A link from one resource to another: a folder's child, a code import, a page link. */
export interface ResourceLink {
  /** Absolute when the station could resolve it. */
  uri?: ResourceUri;
  /** What it was written as (`./foo`, `react`). */
  raw: string;
  kind: 'child' | 'import' | 'link' | 'embed' | 'external';
  title?: string;
}

/** A change a station reports from a watch. */
export interface ResourceChange {
  uri: ResourceUri;
  change: 'added' | 'changed' | 'removed';
  version?: string;
}

/** The hub's row for a resource it knows about. Contents are kept only when indexed. */
export interface ResourceRecord {
  uri: ResourceUri;
  station: StationName;
  stat: ResourceStat;
  links: ResourceLink[];
  /** The version whose sections are indexed. */
  indexedVersion?: string;
  /** The rule used to cut it. */
  sectionRule?: QualifiedName;
  /** Things derived from it (context) that are out of date. */
  stale: boolean;
  seenAt: Timestamp;
}

/** How a station's server side serves resources. Built on `@aeye/resources` parsers and resolvers where they fit. */
export interface ResourceProvider {
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead>;
  watch?(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void;
  /** aeye parsers to convert formats to text (the default registry's pdf, docx, html, … are included). */
  parsers?: ResourceParser[];
}

/**
 * How a fn reads resources from any station the run's actor may see. Calls go through the hub, which routes
 * each URI to the station that owns its root and caches what it indexes.
 */
export interface ResourceService {
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead>;
  /** The text of a resource, or of some of its sections. */
  text(uri: ResourceUri, sections?: SectionKey[]): Promise<string>;
  sections(uri: ResourceUri): Promise<Section[]>;
  links(uri: ResourceUri): Promise<ResourceLink[]>;
  search(query: string, options?: { roots?: ResourceUri[]; limit?: number }): Promise<SearchHit[]>;
}

/** A section's stable key: built from structure, so it survives content moving around. */
export type SectionKey = string & { readonly [brand]: 'SectionKey' };

/** A stable piece of a resource. */
export interface Section {
  key: SectionKey;
  /** Its place in the resource's outline (heading path, symbol path). */
  path: string[];
  title: string;
  /** Character offsets in the resource's text at this version. */
  start: number;
  end: number;
  /** Hash of the text, to tell changed from unchanged. */
  hash: string;
  /** What gets embedded: the text plus its headings and the resource name (aeye `embedText`). */
  embedText: string;
  parent?: SectionKey;
}

/**
 * How a format is cut into sections. The built-ins wrap aeye's slicers but key sections by structure (aeye's
 * own slice ids are ordinals that shift when content moves). A key collision gets `~2`, `~3`.
 */
export type Sectioner =
  | { type: 'whole' }
  | { type: 'headings'; /** Deepest heading level that starts a section. */ depth: number }
  | { type: 'symbols'; /** Which declarations start a section. */ declarations: Array<'function' | 'class' | 'interface' | 'type' | 'const' | 'export'> }
  | { type: 'pages' }
  | { type: 'paragraphs'; maxChars: number }
  /** A rule a station implements (`SectionRuleImpl`). */
  | { type: 'station'; rule: QualifiedName };

/** Which resources a rule applies to. */
export interface SectionMatch {
  format?: string;
  mime?: string;
  /** Glob over the URI. */
  glob?: string;
}

/** A user's or station's choice of sectioner for some resources. More specific matches win. */
export interface SectionRule {
  match: SectionMatch;
  sectioner: Sectioner;
  /** Who set it; a user's rule beats a station's default. */
  source: 'station' | 'user';
}

/** A section rule a station ships as a default. */
export interface SectionRuleDecl {
  name: string;
  description: string;
  match: SectionMatch;
  sectioner: Sectioner;
}

/** A station-implemented sectioner. Can reuse an aeye `ResourceSlicer` for the cutting and supply only the key. */
export interface SectionRuleImpl {
  decl: SectionRuleDecl;
  sections(text: string, stat: ResourceStat): Promise<Section[]>;
  slicer?: ResourceSlicer;
}

/** What changed between two versions of a resource, by section key. Context derived from changed sections goes stale. */
export interface SectionDiff {
  uri: ResourceUri;
  from: string;
  to: string;
  added: SectionKey[];
  changed: SectionKey[];
  removed: SectionKey[];
}

// ═══ Context ═══

/** An argument of a context's `/command`. */
export interface ContextArg {
  name: string;
  hint: string;
  required: boolean;
}

/**
 * Content available to the LLM. Authored, or taken from resource sections. It can mention or import other
 * context and fns, so loading it brings them along: context with fns is a skill.
 */
export interface ContextDecl {
  name: string;
  /** The preview the LLM sees before loading it. */
  description: string;
  /** The content. May reference `{{args}}` of its command. */
  content: string | { from: ContextSource };
  /** `/name args` loads it from the chat. */
  command?: { name: string; args: ContextArg[] };
  /** Context loaded along with this one (one level; the hub stops at cycles). */
  imports: QualifiedName[];
  /** Fns added to the toolset when this is loaded. */
  fns: QualifiedName[];
  /** Fns suggested (not added) when this is loaded. */
  suggestFns: QualifiedName[];
  /** Who it may be suggested to. */
  suggest: Audience;
  /** Who can find it in searches. */
  visible: Audience;
  /** Always loaded for these agents. */
  alwaysFor: QualifiedName[];
  tags: string[];
}

/** Where context content comes from when it isn't written inline. */
export type ContextSource =
  | { resource: ResourceUri }
  | { resource: ResourceUri; sections: SectionKey[] };

/** The hub's row for a piece of context. */
export interface ContextRecord {
  name: QualifiedName;
  station: StationName;
  decl: ContextDecl;
  /** The resolved text (for sourced context, at the version below). */
  text: string;
  sourceVersion?: string;
  /** A source section changed since it was resolved. */
  stale: boolean;
  /** References the hub found in the text (`@fs/read_file`, `@context:fs/guide`), added to imports and fns. */
  mentions: { context: QualifiedName[]; fns: QualifiedName[] };
  updatedAt: Timestamp;
}

// ═══ Index and search ═══

/** An embedder as a station declares it. */
export interface EmbedderDecl {
  name: string;
  dimensions: number;
  /** Most characters per text. */
  maxInput: number;
  /** Cost per million tokens, for budgets. */
  pricePerMillion: Usd;
}

/** An embedder's implementation in a station. */
export interface EmbedderImpl {
  decl: EmbedderDecl;
  embed(texts: string[]): Promise<number[][]>;
}

/** What the hub indexes. */
export type IndexedKind = 'fn' | 'context' | 'section' | 'message' | 'type';

/** One indexed item: its text, for full-text search, and its vectors per embedder. */
export interface IndexEntry {
  kind: IndexedKind;
  /** The fn or context name, `uri#section`, or message id. */
  key: string;
  station?: StationName;
  text: string;
  /** Vectors live in a table per embedder (sqlite-vec), keyed by entry. */
  embedder: QualifiedName;
  updatedAt: Timestamp;
}

/** A search over the index: text match and meaning combined. */
export interface SearchQuery {
  kinds: IndexedKind[];
  text: string;
  /** Weight of meaning (0) versus words (1). */
  balance: number;
  stations?: StationName[];
  limit: number;
}

/** One search hit. */
export interface SearchHit {
  kind: IndexedKind;
  key: string;
  score: number;
  title: string;
  preview: string;
}

// ═══ Models, providers and spend ═══

/** A model provider the hub can call. Each maps to an aeye provider package. */
export type ProviderConfig =
  | { provider: 'openai'; apiKeySecret: Id<'secret'>; baseURL?: string }
  | { provider: 'openrouter'; apiKeySecret: Id<'secret'> }
  | { provider: 'aws'; region: string; credentialsSecret?: Id<'secret'> }
  | { provider: 'replicate'; apiKeySecret: Id<'secret'> };

/** A secret value (API key), stored encrypted. Fns and the UI only ever see its id and name. */
export interface Secret {
  id: Id<'secret'>;
  name: string;
  owner: Id<'actor'>;
  /** Encrypted with the hub's key. */
  ciphertext: string;
  createdAt: Timestamp;
}

/** A named, ordered list of models: try the first, move down when quality demands it. */
export interface ModelCategory {
  id: Id<'modelCategory'>;
  name: string;
  description: string;
  models: string[];
}

/** The hub's model catalog: aeye's `ModelInfo` for every model of every configured provider. */
export interface ModelCatalog {
  models: ModelInfo[];
  refreshedAt: Timestamp;
}

/** What a spend limit covers. */
export type SpendScope =
  | { scope: 'all' }
  | { scope: 'actor'; actor: Id<'actor'> }
  | { scope: 'station'; station: StationName }
  | { scope: 'session'; session: Id<'session'> }
  | { scope: 'fn'; fn: QualifiedName }
  | { scope: 'model'; model: string };

/**
 * A limit on spend per window of time, for LLM calls (and reported fn costs). A group's limit is shared by
 * its members. `@ayepi/rate` counts calls, not dollars, so the hub keeps a ledger and reserves before each call.
 */
export interface SpendLimit {
  id: Id<'spendLimit'>;
  target: SpendScope;
  window: Duration;
  maxCost: Usd;
  maxCalls?: number;
  maxTokens?: number;
  /** When hit: wait for the window, refuse, or ask someone to raise it. */
  onLimit: 'wait' | 'refuse' | 'ask';
  createdBy: Id<'actor'>;
}

/** A hold on budget before an LLM call, settled with the real cost after. */
export interface Reservation {
  id: Id<'reservation'>;
  limits: Id<'spendLimit'>[];
  estimate: Usd;
  createdAt: Timestamp;
  settled?: { cost: Usd; at: Timestamp };
}

/** One line in the spend ledger. Spend over a window is a sum over these. */
export interface LedgerEntry {
  id: Id<'ledger'>;
  at: Timestamp;
  cost: Usd;
  tokens: number;
  actor: Id<'actor'>;
  station?: StationName;
  session?: Id<'session'>;
  fn: QualifiedName;
  model?: string;
  llmCall?: Id<'llmInteraction'>;
  run: Id<'run'>;
}

/**
 * The aeye provider stations use. Every request goes to the hub over the link (`HubLink.llm`), which picks
 * the model, enforces limits, calls the real provider and records the interaction. It lists the hub's models
 * so aeye's selection works on the station side.
 */
export interface HarnessProvider extends Provider<{ link: HubLink; run?: Id<'run'> }> {
  name: 'harness';
}

/** An LLM request forwarded from a station. Zod schemas don't cross the wire, so tools and output go as JSON schema. */
export interface LlmForward {
  run?: Id<'run'>;
  request: Omit<AeyeRequest, 'tools' | 'responseFormat'> & {
    tools?: Array<{ name: string; description?: string; parameters: Json }>;
    responseFormat?: 'text' | 'json' | { schema: Json; strict: boolean };
  };
  /** aeye selection metadata (weights, required capabilities, model). */
  metadata: Json;
  stream: boolean;
}

/** A streamed chunk back to the station: aeye chunks, then the final usage with the real cost. */
export type LlmForwardChunk =
  | { type: 'chunk'; chunk: Chunk }
  /** Which schema descriptors the provider used, so the station's aeye can decode strict output. */
  | { type: 'descriptors'; tools: Record<string, string>; output?: string }
  | { type: 'done'; usage: Usage; cost: Usd; interaction: Id<'llmInteraction'> }
  | { type: 'error'; message: string; kind: 'model' | 'tool' | 'limit' | 'provider' };

// ═══ Hub events ═══

/** Events the hub emits to the browser and to subscribed stations. */
export type HubEvent =
  | { type: 'session.message'; session: Id<'session'>; message: ChatMessage }
  | { type: 'session.token'; session: Id<'session'>; message: Id<'message'>; text: string }
  | { type: 'session.controls'; session: Id<'session'>; controls: SessionControls }
  | { type: 'run.update'; run: Id<'run'>; session?: Id<'session'>; update: RunUpdate }
  | { type: 'run.created'; run: RunSummary; parent?: Id<'run'>; session?: Id<'session'> }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'station.status'; station: StationName; status: StationStatus }
  | { type: 'pairing.requested'; pairing: PairingRequest }
  | { type: 'fns.changed'; report: ImportReport }
  | { type: 'resource.changed'; changes: ResourceChange[] }
  | { type: 'spend.limit'; limit: Id<'spendLimit'>; used: Usd }
  | { type: 'capabilities'; capabilities: ChatCapabilities };

/** The name of a hub event. */
export type HubEventName = HubEvent['type'];

// ═══ Notifications ═══

/** A browser's web push subscription (VAPID). The hub sends pushes itself; ayepi has no web push. */
export interface PushSubscriptionRecord {
  id: Id<'pushSubscription'>;
  user: Id<'actor'>;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device: string;
  createdAt: Timestamp;
}

/** Why the hub notifies someone. */
export type NotificationReason =
  | 'approval-needed'
  | 'input-needed'
  | 'tagged'
  | 'turn-finished'
  | 'pairing-requested'
  | 'station-disconnected'
  | 'spend-limit';

/** An item in a user's inbox; also pushed when they aren't looking. */
export interface Notification {
  id: Id<'notification'>;
  user: Id<'actor'>;
  reason: NotificationReason;
  title: string;
  body: string;
  /** Where clicking takes them. */
  link: { session: Id<'session'> } | { approval: Id<'approval'> } | { pairing: Id<'pairing'> } | { run: Id<'run'> };
  read: boolean;
  pushed: boolean;
  createdAt: Timestamp;
}

// ═══ Browser renderers ═══

/** What a station's client entry exports. The chat UI imports it and calls `register`. */
export interface StationClientModule {
  register(registry: ClientRegistry): void;
}

/**
 * Where a station registers browser renderers. A renderer mounts into a DOM element and returns a cleanup, so
 * stations can use any UI library.
 */
export interface ClientRegistry {
  /** How a call of this fn (or every fn of a kind) is drawn in the chat. */
  fn(target: { fn: QualifiedName } | { kind: QualifiedName }, render: Mount<FnRenderProps>): void;
  /** How a resource format is previewed. */
  resource(format: string, render: Mount<ResourceRenderProps>): void;
  /** How a custom attachment is drawn. */
  attachment(renderer: string, render: Mount<AttachmentRenderProps>): void;
  /** A custom input for a named type (used in `!fn` forms and handler prompts). */
  input(type: QualifiedName, render: Mount<InputRenderProps>): void;
}

/** A renderer: draw into `el`, return a cleanup. */
export type Mount<P> = (el: HTMLElement, props: P) => () => void;

/** What a fn renderer gets. */
export interface FnRenderProps {
  run: RunSummary;
  args: Json;
  /** Live updates while it runs. */
  subscribe(listener: (update: RunUpdate) => void): () => void;
}

/** What a resource renderer gets. */
export interface ResourceRenderProps {
  stat: ResourceStat;
  section?: SectionKey;
  /** Fetch the text or bytes when needed. */
  load(): Promise<string | Uint8Array>;
}

/** What an attachment renderer gets. */
export interface AttachmentRenderProps {
  data: Json;
  title: string;
}

/** What an input renderer gets. */
export interface InputRenderProps {
  type: GinTypeDef;
  value: Json | undefined;
  onChange(value: Json): void;
  /** Validation problems for the current value. */
  problems: string[];
}

// ═══ Browser API ═══

/**
 * What the web chat calls on the hub. Becomes an ayepi spec served over HTTP and the browser's WebSocket
 * (events are `HubEvent`s on per-user and per-session channels).
 */
export interface HubWebApi {
  signIn(input: { email: string; password: string }): Promise<{ token: string; user: UserActor }>;
  capabilities(input: { session?: Id<'session'> }): Promise<ChatCapabilities>;
  sessions(input: { cursor?: string; search?: string }): Promise<Page<Session>>;
  createSession(input: { agent?: QualifiedName; stations?: StationName[] | 'all'; title?: string }): Promise<Session>;
  updateSession(input: { session: Id<'session'>; stations?: StationName[] | 'all'; agent?: QualifiedName; priority?: Priority; budget?: FnBudget }): Promise<Session>;
  messages(input: { session: Id<'session'>; cursor?: string }): Promise<Page<ChatMessage>>;
  send(input: { session: Id<'session'>; parts: MessagePart[]; client: HookInput['client'] }): Promise<{ turn: Id<'turn'>; message: ChatMessage }>;
  /** Run a fn directly (`!fn`). */
  invoke(input: { session: Id<'session'>; fn: QualifiedName; args: Json }): Promise<{ turn: Id<'turn'>; run: Id<'run'> }>;
  control(input: { session: Id<'session'>; action: 'pause' | 'resume' | 'cancel' }): Promise<SessionControls>;
  undoTurn(input: { turn: Id<'turn'> }): Promise<UndoReport>;
  tree(input: { turn: Id<'turn'> }): Promise<TreeNode>;
  run(input: { run: Id<'run'> }): Promise<Run>;
  llmCall(input: { id: Id<'llmInteraction'> }): Promise<LlmInteraction>;
  mention(input: { session: Id<'session'>; provider: QualifiedName; query: string }): Promise<MentionOption[]>;
  answerApproval(input: { approval: Id<'approval'>; approve: boolean; remember: ApprovalDecision['remember']; reason?: string }): Promise<ApprovalRequest>;
  answerHandler(input: { call: Id<'handlerCall'>; value: Json }): Promise<void>;
  presence(input: Omit<Presence, 'user' | 'lastActiveAt'>): Promise<void>;
  notifications(input: { cursor?: string; unread?: boolean }): Promise<Page<Notification>>;
  subscribePush(input: Omit<PushSubscriptionRecord, 'id' | 'user' | 'createdAt'>): Promise<{ id: Id<'pushSubscription'> }>;
  resource(input: { uri: ResourceUri; want: ReadWant[] }): Promise<ResourceRead>;
  search(input: SearchQuery): Promise<SearchHit[]>;
  /** Transcribe recorded audio (needs a transcription provider). */
  transcribe(input: { audio: ContentRef }): Promise<{ text: string }>;
  /** Admin: stations, pairing, providers, limits, policies, actors. These mirror the `HubFns` admin fns. */
  admin(input: { fn: keyof HubFns; args: Json }): Promise<Json>;
}

// ═══ Storage ═══

/** Every table the hub keeps, by name. */
export interface HubTables {
  actors: Actor;
  memberships: Membership;
  credentials: Credential;
  authSessions: AuthSession;
  policies: Policy;
  approvals: ApprovalRequest;
  actorSettings: ActorSetting;
  stations: StationRecord;
  pairings: PairingRequest;
  pairingTokens: PairingToken;
  types: TypeDecl & { name: QualifiedName; station: StationName };
  kinds: FnKindDecl & { name: QualifiedName; station: StationName };
  fns: FnRecord;
  sessions: Session;
  messages: ChatMessage;
  turns: Turn;
  runs: Run;
  llmInteractions: LlmInteraction;
  resources: ResourceRecord;
  sections: Section & { uri: ResourceUri; version: string };
  sectionRules: SectionRule & { id: Id<'sectionRule'> };
  context: ContextRecord;
  index: IndexEntry;
  secrets: Secret;
  providers: ProviderConfig & { id: Id<'provider'> };
  modelCategories: ModelCategory;
  spendLimits: SpendLimit;
  reservations: Reservation;
  ledger: LedgerEntry;
  notifications: Notification;
  pushSubscriptions: PushSubscriptionRecord;
}

/** A filter on a table's columns. */
export type Where<Row> = { [K in keyof Row]?: Row[K] | { in: Row[K][] } | { gt: Row[K] } | { lt: Row[K] } };

/** A bounded, ordered read. Nothing reads a whole table. */
export interface TableQuery<Row> {
  where?: Where<Row>;
  order?: Array<[keyof Row & string, 'asc' | 'desc']>;
  limit: number;
  cursor?: string;
}

/** One table. */
export interface Table<Row> {
  get(key: string): Promise<Row | undefined>;
  find(query: TableQuery<Row>): Promise<Page<Row>>;
  count(where?: Where<Row>): Promise<number>;
  insert(row: Row): Promise<Row>;
  update(key: string, patch: Partial<Row>): Promise<Row>;
  remove(key: string): Promise<void>;
}

/**
 * The storage port. SQLite by default; Postgres later. The same database also backs the ayepi ports the hub
 * uses (work `Queue`/`Store`/`PubSub`, the rate store, the cache store), so one file holds everything.
 */
export interface HubStore {
  table<K extends keyof HubTables>(name: K): Table<HubTables[K]>;
  /** Run a function in one transaction. */
  tx<T>(fn: (store: HubStore) => Promise<T>): Promise<T>;
  vectors: VectorIndex;
  /** Full-text search over the index table. */
  text(query: { text: string; kinds: IndexedKind[]; limit: number }): Promise<Array<{ key: string; score: number }>>;
  migrate(): Promise<void>;
}

/** Vector search, per embedder. */
export interface VectorIndex {
  upsert(embedder: QualifiedName, entries: Array<{ key: string; vector: number[] }>): Promise<void>;
  remove(embedder: QualifiedName, keys: string[]): Promise<void>;
  nearest(embedder: QualifiedName, vector: number[], limit: number, kinds?: IndexedKind[]): Promise<Array<{ key: string; score: number }>>;
}

// ═══ Hub configuration ═══

/** The hub's settings (an ayepi env slice; every default lives in its schema). */
export interface HubConfig {
  port: number;
  /** Public URL, for pairing links and push notifications. */
  url: string;
  database: { driver: 'sqlite'; file: string } | { driver: 'postgres'; url: string };
  files: { dir: string };
  jwtSecret: string;
  /** Encrypts secrets. */
  secretKey: string;
  vapid: { publicKey: string; privateKey: string; subject: string };
  queues: QueueSettings;
  link: LinkLimits;
  /** Pairing requests expire after this. */
  pairingTimeout: Duration;
  /** Default per-turn budget. */
  turnBudget: FnBudget;
  /** The embedder used for the index. */
  embedder: QualifiedName;
}

// ═══ The fs station ═══

/** A file or folder as the fs station reports it. */
export interface FsEntry {
  path: string;
  type: 'file' | 'folder' | 'link';
  size: number;
  modifiedAt: Timestamp;
}

/**
 * The first station. It gives an agent files and a shell over its folders, serves those folders as resources,
 * and can restart itself so changes to its own code (new fns, kinds, context, renderers) go live.
 */
export interface FsFns {
  read: { args: { path: string; offset?: number; limit?: number }; result: { text: string; lines: number; truncated: boolean } };
  /** Writes a file. Undo restores the previous content. */
  write: { args: { path: string; text: string }; result: { created: boolean }; undo: { path: string; previous: ContentRef | null } };
  /** Replaces exact text. Undo restores the previous content. */
  edit: { args: { path: string; find: string; replace: string; all?: boolean }; result: { replacements: number }; undo: { path: string; previous: ContentRef } };
  list: { args: { path: string; depth?: number }; result: { entries: FsEntry[] } };
  glob: { args: { pattern: string; root?: string }; result: { paths: string[] } };
  grep: { args: { pattern: string; root?: string; glob?: string; limit?: number }; result: { matches: Array<{ path: string; line: number; text: string }> } };
  /** Runs a command. Cancel kills it; progress streams its output tail. Asks the `confirm` handler for commands its policy marks risky. */
  bash: { args: { command: string; cwd?: string; timeout?: Duration }; result: { exitCode: number; stdout: string; stderr: string }; handlers: { confirm: { args: { command: string; reason: string }; returns: boolean; required: false } } };
  remove: { args: { path: string }; result: { removed: boolean }; undo: { path: string; previous: ContentRef } };
  /** Restarts the station process. It reconnects and the hub imports what changed. */
  restart: { args: { reason: string }; result: { restarting: true } };
}

/** The fs station's server settings. */
export interface FsStationConfig {
  /** The folders it serves and works in. Nothing outside them is reachable. */
  roots: Array<{ path: string; name: string; writable: boolean; index: ResourceRootDecl['index'] }>;
  /** Commands `bash` runs without asking, as patterns. */
  safeCommands: string[];
  /** The station's own source folder, so it can edit and restart itself. */
  self?: string;
}

// ═══ Later stations ═══

/**
 * A station that connects any MCP server to the hub: tools become fns, resources become resources, prompts
 * become context with commands. Needs an MCP client (ayepi's MCP package is server-only).
 * @status later
 */
export interface McpBridgeConfig {
  servers: Array<{ name: string; transport: { stdio: { command: string; args: string[]; env?: Record<string, string> } } | { http: { url: string; headersSecret?: Id<'secret'> } } }>;
}

/**
 * A station that wraps Claude Code: runs sessions (stream-json), exposes them as fns (list, read, search, send,
 * interrupt), and imports Claude's agents, skills and MCP servers as context and fns.
 * @status later
 */
export interface ClaudeCodeFns {
  sessions: { args: { cursor?: string }; result: Page<{ id: string; title: string; cwd: string; status: 'idle' | 'running' | 'waiting' }> };
  start: { args: { cwd: string; prompt: string; model?: string }; result: { id: string } };
  send: { args: { id: string; text: string }; result: { accepted: boolean } };
  read: { args: { id: string; cursor?: string }; result: Page<Json> };
  search: { args: { query: string; id?: string }; result: Array<{ id: string; message: string; preview: string }> };
  pending: { args: { id?: string }; result: Array<{ id: string; tool: string; input: Json }> };
  interrupt: { args: { id: string }; result: { interrupted: boolean } };
}

/**
 * A station over a database: a query tool, saved queries, custom types, and per-actor access rules.
 * Built on `@aeye/query` (its RLS and field access hooks take expressions).
 * @status later
 */
export interface DbStationConfig {
  connection: { driver: 'sqlite'; file: string } | { driver: 'postgres'; urlSecret: Id<'secret'> };
  /** Let users define new types (tables). */
  customTypes: boolean;
  /** How a hub user becomes a database user: a query that selects the database user for the hub user's id/email. */
  userMap?: { select: GinProgram; required: boolean };
  /** Types anyone may read without a mapped user. */
  publicTypes: string[];
}

/** Row and field access rules a db station attaches to actors (an `ActorSettingDecl` of this type). @status later */
export interface DbAccessSetting {
  rows: Record<string, GinProgram>;
  fields: Record<string, Record<string, GinProgram>>;
}

/** A saved query in a db station. @status later */
export interface SavedQuery {
  name: string;
  description: string;
  query: Json;
  params: GinTypeDef;
}

/** A station with fetch and web search. @status later */
export interface WebFns {
  fetch: { args: { url: string; format?: 'markdown' | 'text' | 'html' }; result: { text: string; links: ResourceLink[] } };
  search: { args: { query: string; limit?: number }; result: Array<{ url: string; title: string; snippet: string }> };
}

/** Run a fn on a schedule. @status future */
export interface Schedule {
  id: Id<'schedule'>;
  fn: QualifiedName;
  args: Json;
  cron: string;
  actor: Id<'actor'>;
  nextAt: Timestamp;
  enabled: boolean;
}

/** Run a fn when a hub event happens. @status future */
export interface Trigger {
  id: Id<'trigger'>;
  on: HubEventName;
  /** A gin predicate over the event. */
  when?: GinProgram;
  fn: QualifiedName;
  /** A gin program that builds the args from the event. */
  args: GinProgram;
  actor: Id<'actor'>;
  enabled: boolean;
}

/** The ayepi manifest a station's link spec produces, kept so the hub can build a client for it. */
export type StationLinkManifest = Manifest;

/** The typed gin builder the station SDK exports. */
export declare const g: GinBuilder;
