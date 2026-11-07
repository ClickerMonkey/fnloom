// # Hub
// The hub's side: what crosses the wire from systems, what it stores, how it runs turns, permissions, spend,
// chat and storage. System authors never touch these directly; the SDK (sdk.ts) is their surface. Library types
// (aeye, ayepi) appear only here, where the hub uses them.

import type { Usage, Message, Request as AeyeRequest, Response as AeyeResponse, Chunk } from '@aeye/core';
import type { ModelInfo } from '@aeye/ai';
import type {
  Id, RunId, TurnId, SessionId, ActorId, MessageId, Duration, Timestamp, Usd, Json, QualifiedName, Priority, Audience, ActorKind, Page,
  GinTypeDef, FnError, RunStatus, RunUpdate, Operations, FnLimits, ModelChoice, KindDescription,
  ResourceUri, ResourceStat, ResourceLink, ResourceRead, ResourceRoot, ResourceChange, ReadWant, ContentRef, Section, SectionKey, SectionMatch,
  HookInput, MentionOption, MentionHover, SystemEvent, UndoOutcome, Link, Display, RunInfo, UserInfo, TimeInfo, TypeDisplay,
} from './sdk.ts';

// ═══ Wire: what a system sends ═══

/** A system's name. Unique among the hub's systems; namespaces everything it contributes. */
export type SystemName = string & { readonly __system: true };

/**
 * A system's whole contract as JSON, sent on connect (skipped if the hash matches) and kept current with
 * patches. The SDK builds it from the typed contract. Names inside are unqualified.
 */
export interface Manifest {
  name: SystemName;
  version: string;
  description: string;
  /** Hash of everything below; sent in `Hello`. */
  hash: string;
  /** Named types. A type's methods are sent as fns named `Type.method` whose args hold the value as `self`. */
  types: Array<{ name: string; description: string; def: GinTypeDef; display: TypeDisplay; methods: string[] }>;
  settings: Array<{ name: string; description: string; type: GinTypeDef; appliesTo: ActorKind[]; merge: string; editableBy: string[] }>;
  attachments: Array<{ name: string; description: string; data: GinTypeDef }>;
  kinds: KindDecl[];
  fns: FnDecl[];
  context: ContextDecl[];
  hooks: Array<{ name: string; description: string; order: number; timeout: Duration }>;
  mentions: Array<{ name: string; title: string; description: string; target: GinTypeDef; /** The type of the things it points at. */ of?: QualifiedName }>;
  embedders: Array<{ name: string; dimensions: number; maxInput: number; pricePerMillionTokens: Usd }>;
  sectioners: Array<{ name: string; description: string; match: SectionMatch }>;
  actions: Array<{ name: string; description: string; input: GinTypeDef; returns: GinTypeDef; state?: GinTypeDef; expires?: Duration }>;
  /** Events it handles; the hub only sends those. */
  events: SystemEvent['type'][];
  /** Whether it serves resources. Roots are fetched separately (they can change). */
  resources: boolean;
  client?: { entry: string; hash: string; files: Array<{ path: string; size: number; hash: string }> };
  /** Systems whose fns, kinds or context it refers to. */
  requires: SystemName[];
}

/** The sections of a manifest a patch can change. */
export type ManifestSection = 'types' | 'settings' | 'attachments' | 'kinds' | 'fns' | 'context' | 'hooks' | 'mentions' | 'embedders' | 'sectioners' | 'actions';

/** A runtime change to a manifest. */
export interface ManifestPatch {
  hash: string;
  upsert: Partial<Pick<Manifest, ManifestSection>>;
  remove: Partial<Record<ManifestSection, string[]>>;
}

/** A kind on the wire. */
export interface KindDecl {
  name: string;
  description: string;
  applicability: string;
  payload: GinTypeDef;
  approveChanges: boolean;
}

/** A handler on the wire. */
export interface HandlerDecl {
  description: string;
  args: GinTypeDef;
  returns: GinTypeDef;
  required: boolean;
}

/** Progress on the wire. */
export type ProgressDecl = { type: 'none' } | { type: 'linear' } | { type: 'steps'; steps: Record<string, string> };

/**
 * A fn on the wire. Native fns carry their signature, deps and handlers as declared. Fns of other kinds carry a
 * payload; the hub asks the kind's system to describe it and checks the result against the declared signature.
 */
export interface FnDecl {
  name: string;
  description: string;
  instructions?: string;
  /** `native`, or the qualified name of a kind. */
  kind: 'native' | QualifiedName;
  payload?: Json;
  args: GinTypeDef;
  returns: GinTypeDef;
  deps: QualifiedName[];
  handlers: Record<string, HandlerDecl>;
  progress: ProgressDecl;
  operations: Operations;
  undo?: GinTypeDef;
  resume?: GinTypeDef;
  /** The session state fields it uses (an object type). */
  state?: GinTypeDef;
  /** What its renderer's form submits. */
  form?: GinTypeDef;
  display: Display;
  limits: FnLimits;
  visibility: Audience;
  tags: string[];
}

/** Context on the wire. */
export interface ContextDecl {
  name: string;
  description: string;
  /** Absent for dynamic context: the hub asks the system for it on load. */
  content?: string;
  command?: { name: string; args: Array<{ name: string; hint: string; required: boolean }> };
  imports: QualifiedName[];
  fns: QualifiedName[];
  suggestFns: QualifiedName[];
  suggest: Audience;
  visible: Audience;
  alwaysFor: QualifiedName[];
  tags: string[];
}

/** What the hub did with a manifest or patch. */
export interface ImportReport {
  added: QualifiedName[];
  updated: QualifiedName[];
  removed: QualifiedName[];
  /** Refused, and why: a bad type, a name clash, an incompatible change to a fn others depend on. */
  refused: Array<{ name: string; problems: string[] }>;
}

// ═══ Wire: the link ═══

/** The first frame from a system. A new name starts pairing; a known name gets a challenge. */
export interface Hello {
  protocol: 1;
  name: SystemName;
  version: string;
  /** New per process start, to tell a restart from a reconnect. */
  instance: string;
  publicKey: string;
  manifestHash: string;
  pairingToken?: string;
}

/** The hub's challenge to a known system; the system signs the nonce with its private key. */
export interface Challenge { nonce: string }
export interface ChallengeAnswer { signature: string }

/** The hub accepts the system. */
export interface Welcome {
  /** A short-lived token for HTTP (asset upload, presigned content). */
  token: string;
  /** The hub's copy is stale: send the manifest. */
  sendManifest: boolean;
  limits: LinkLimits;
}

/** Size limits that keep system traffic small. */
export interface LinkLimits {
  /** Largest frame; bigger content goes as a `ContentRef`. */
  maxFrame: number;
  maxChunk: number;
  heartbeat: Duration;
}

/**
 * One WebSocket carries both directions. ayepi's ws protocol is one-way (client calls, server answers), so each
 * side runs both an ayepi client and an ayepi server and every frame says which conversation it belongs to.
 */
export interface LinkFrame {
  /** `h`: a call the system made to the hub, or its reply. `s`: a call the hub made to the system, or its reply. */
  d: 'h' | 's';
  /** The ayepi frame. */
  f: Json;
}

/** What a system calls on the hub (an ayepi spec). */
export interface HubLink {
  manifest(input: Manifest): Promise<ImportReport>;
  patch(input: ManifestPatch): Promise<ImportReport>;
  /** A call from inside a run. Queued like every run; replies when it settles. */
  call(input: { parent: RunId; fn: QualifiedName; args: Json; key: string; budget?: { cost?: Usd; time?: Duration }; handlers: string[]; background: boolean }): Promise<RunSettled>;
  progress(input: { run: RunId; progress: Json }): Promise<void>;
  allow(input: { run: RunId; operations: Partial<Pick<Operations, 'cancel' | 'pause' | 'background'>> }): Promise<void>;
  undoWith(input: { run: RunId; undo: Json }): Promise<void>;
  attach(input: { run: RunId; attachment: QualifiedName; data: Json; title: string } | { run: RunId; link: Link }): Promise<void>;
  /** Answer a handler call the hub relayed to this system (it was the caller). */
  handlerResult(input: { call: Id<'handlerCall'>; result: { ok: true; value: Json } | { ok: false; error: FnError } }): Promise<void>;
  resourcesChanged(input: { changes: ResourceChange[] }): Promise<void>;
  /** The LLM forward behind `ctx.llm` (and the aeye provider). */
  llm(input: LlmForward): AsyncIterable<LlmForwardChunk>;
  embed(input: { texts: string[]; run?: RunId }): Promise<{ vectors: number[][]; cost: Usd }>;
  /** Resource access for `ctx.resources`, routed to whichever system serves the URI. */
  resource(input: { uri: ResourceUri; want: ReadWant[]; run?: RunId }): Promise<ResourceRead>;
  content(input: { ref: ContentRef; offset: number; length: number }): Promise<{ chunk: string }>;
  setting(input: { run: RunId; setting: QualifiedName }): Promise<{ value?: Json }>;
  /**
   * Session state for a run (or an action). The hub knows which fields the fn or action declared and only reads or
   * writes those, matched by name and type. `update` takes the version it read, and is refused if another write
   * came in between (the SDK retries).
   */
  stateGet(input: { run: RunId } | { delivery: Id<'delivery'> }): Promise<{ values: Record<string, Json>; version: number }>;
  stateSet(input: ({ run: RunId } | { delivery: Id<'delivery'> }) & { patch: Record<string, Json>; clear: string[]; version?: number }): Promise<{ version: number } | { conflict: true }>;
  log(input: { level: 'debug' | 'info' | 'warn' | 'error'; key: string; fields: Record<string, Json> }): Promise<void>;
}

/** What the hub calls on a system (an ayepi spec the system serves over the link). */
export interface SystemLink {
  run(input: RunRequest): Promise<OutcomeWire>;
  control(input: { run: RunId; action: 'cancel' | 'pause' }): Promise<{ accepted: boolean; reason?: string }>;
  undo(input: { run: RunId; fn: QualifiedName; payload: Json }): Promise<UndoOutcome>;
  /** Relay a handler call to the system whose run supplied it. */
  handler(input: { call: Id<'handlerCall'>; run: RunId; handler: string; args: Json }): Promise<{ ok: true; value: Json } | { ok: false; error: FnError }>;
  check(input: { kind: string; payload: Json }): Promise<{ problems: string[]; description?: KindDescription }>;
  context(input: { name: string; args: Record<string, string>; session?: SessionId; actor: ActorId }): Promise<{ text: string }>;
  roots(input: Record<string, never>): Promise<ResourceRoot[]>;
  list(input: { uri: ResourceUri; cursor?: string }): Promise<Page<ResourceStat>>;
  stat(input: { uri: ResourceUri }): Promise<ResourceStat | undefined>;
  read(input: { uri: ResourceUri; want: ReadWant[] }): Promise<ResourceRead>;
  sections(input: { sectioner: string; uri: ResourceUri; version: string }): Promise<Section[]>;
  watch(input: { uris: ResourceUri[]; on: boolean }): Promise<void>;
  content(input: { ref: ContentRef; offset: number; length: number }): Promise<{ chunk: string }>;
  embed(input: { embedder: string; texts: string[] }): Promise<{ vectors: number[][] }>;
  hook(input: { hook: string; message: HookInput }): Promise<Json[]>;
  /** `@` search. */
  mentions(input: { provider: string; query: string; session: SessionId; actor: ActorId }): Promise<MentionOption<Json>[]>;
  /** A mention's hover card, asked for when a person hovers it. */
  mentionHover(input: { provider: string; target: Json; session: SessionId; actor: ActorId }): Promise<MentionHover | undefined>;
  /** A mention's text for the LLM, asked for when the message is sent. */
  mentionText(input: { provider: string; target: Json; session: SessionId; actor: ActorId }): Promise<{ text: string }>;
  event(input: SystemEvent): Promise<void>;
  /** Deliver a stored action. Replies with the result; the hub keeps it with the delivery. */
  action(input: { delivery: Id<'delivery'>; action: string; input: Json; session: SessionId; actor: ActorId; run?: RunId }): Promise<{ result: Json }>;
  /** Deliver a form submission to the run waiting in `ctx.form()`. */
  form(input: { delivery: Id<'delivery'>; run: RunId; value: Json }): Promise<void>;
  restart(input: { reason: string }): Promise<void>;
}

/** The hub's request to run a fn. */
export interface RunRequest {
  /** Who and when: the person (name, id, email, groups, zone, locale), their current time, and this system and caller. */
  run: RunInfo;
  fn: string;
  kind: 'native' | string;
  payload?: Json;
  args: Json;
  /** What is left, for information. The hub enforces LLM spend itself. */
  budget: { cost: Usd; time: Duration; limitedBy: string };
  /** Optional handlers the caller can answer. */
  handlers: string[];
  resume?: { state: Json; calls: Record<string, RunSettled>; reason: 'resumed' | 'restart' };
  deadline: Timestamp;
}

/** A run's outcome on the wire. */
export type OutcomeWire =
  | { status: 'done'; result: Json; undo?: Json; cost?: Usd }
  | { status: 'paused'; resume: Json; cost?: Usd }
  | { status: 'failed'; error: FnError; undo?: Json; cost?: Usd }
  | { status: 'cancelled'; partial?: Json; undo?: Json; cost?: Usd };

/** How a child call ended, as its caller hears it. */
export type RunSettled =
  | { status: 'done'; result: Json }
  | { status: 'failed'; error: FnError }
  | { status: 'cancelled' }
  | { status: 'background'; run: RunId };

/** An LLM request forwarded from a system. Tools and output types go as JSON schema (zod doesn't cross the wire). */
export interface LlmForward {
  run?: RunId;
  request: Omit<AeyeRequest, 'tools' | 'responseFormat'> & {
    tools?: Array<{ name: string; description?: string; parameters: Json }>;
    responseFormat?: 'text' | 'json' | { schema: Json; strict: boolean };
  };
  model?: ModelChoice;
  stream: boolean;
}

/** What streams back: chunks, the schema descriptors the provider used (so strict output decodes), then cost. */
export type LlmForwardChunk =
  | { type: 'chunk'; chunk: Chunk }
  | { type: 'descriptors'; tools: Record<string, string>; output?: string }
  | { type: 'done'; usage: Usage; cost: Usd; interaction: Id<'llmInteraction'> }
  | { type: 'error'; message: string; kind: 'model' | 'tool' | 'limit' | 'provider' };

// ═══ Systems ═══

/** Where a system is. */
export type SystemStatus = 'pairing' | 'connected' | 'disconnected' | 'removed';

/** The hub's row for a system. */
export interface SystemRecord {
  name: SystemName;
  description: string;
  status: SystemStatus;
  /** A known name must prove it holds this key. */
  keyFingerprint: string;
  version: string;
  manifestHash: string;
  pairedAt?: Timestamp;
  pairedBy?: ActorId;
  lastSeenAt?: Timestamp;
  address?: string;
  actor: ActorId;
}

/** A pairing waiting for an admin. */
export interface PairingRequest {
  id: Id<'pairing'>;
  name: SystemName;
  keyFingerprint: string;
  version: string;
  address: string;
  /** `code`: the admin compares the code the system printed. `token`: the system brought a one-time token. */
  method: 'code' | 'token';
  code?: string;
  /** The name is paired to a different key; approving replaces that system. */
  replaces?: SystemName;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/** A one-time token an admin creates so a system can pair without a code. */
export interface PairingToken {
  id: Id<'pairingToken'>;
  /** The name it may claim, or any. */
  name?: SystemName;
  tokenHash: string;
  createdBy: ActorId;
  expiresAt: Timestamp;
  usedAt?: Timestamp;
}

// ═══ Catalog ═══

/** Why a fn can't be called right now. */
export type FnUnavailable = 'system-disconnected' | 'system-removed' | 'kind-missing' | 'kind-system-disconnected' | 'dep-unavailable' | 'disabled' | 'paused';

/** The hub's row for a fn. */
export interface FnRecord {
  name: QualifiedName;
  system: SystemName;
  decl: FnDecl;
  /** Hash of the decl; runs record the version they used. */
  version: string;
  origin: 'contract' | 'runtime';
  addedBy?: ActorId;
  available: true | { unavailable: FnUnavailable; detail: string };
  /** Queued runs wait while paused (by an admin, or automatically after repeated failures). */
  paused: boolean;
  disabled: boolean;
  stats: { runs: number; failures: number; averageCost: Usd; averageTime: Duration; lastRunAt?: Timestamp };
  updatedAt: Timestamp;
}

/** The hub's row for a kind. */
export interface KindRecord {
  name: QualifiedName;
  system: SystemName;
  decl: KindDecl;
}

/** The hub's row for a named type. Types re-declared by a system must stay compatible (gin `compatible`). */
export interface TypeRecord {
  name: QualifiedName;
  system: SystemName;
  description: string;
  def: GinTypeDef;
}

/** The hub's row for context. */
export interface ContextRecord {
  name: QualifiedName;
  system: SystemName;
  decl: ContextDecl;
  /** References found in the text (`@fs/read`), added to what loading brings along. */
  mentions: { context: QualifiedName[]; fns: QualifiedName[] };
  /** A source section changed since this was written. */
  stale: boolean;
  updatedAt: Timestamp;
}

// ═══ Actors ═══

/** The core table: anything that acts, owns, or is granted something. */
export interface ActorBase {
  id: ActorId;
  kind: ActorKind;
  name: string;
  /** Agents and other participants see this. */
  about: string;
  createdAt: Timestamp;
  disabled: boolean;
}

export interface UserActor extends ActorBase { kind: 'user'; email: string; role: 'admin' | 'member'; timeZone?: string }
/** A named set of users. A user is in zero or more groups. */
export interface GroupActor extends ActorBase { kind: 'group' }
/** An agent fn acting as a participant, so its runs and messages have an author. */
export interface AgentActor extends ActorBase { kind: 'agent'; fn: QualifiedName }
export interface SystemActor extends ActorBase { kind: 'system'; system: SystemName }
export type Actor = UserActor | GroupActor | AgentActor | SystemActor;

export interface Membership { group: ActorId; user: ActorId; addedBy: ActorId; addedAt: Timestamp }

/** How a user signs in. Hashing is the hub's (ayepi auth leaves it to the app). */
export interface Credential { user: ActorId; kind: 'password' | 'passkey'; secretHash: string; createdAt: Timestamp }

/** A signed-in browser: makes refresh and revocation of ayepi JWTs possible. */
export interface AuthSession {
  id: Id<'authSession'>;
  user: ActorId;
  /** Bumped to revoke every token of this session. */
  version: number;
  device: string;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  /** An admin acting as another user; actions are recorded under the admin. */
  actingAs?: ActorId;
}

/** A value of a system's actor setting on one actor. */
export interface ActorSetting {
  setting: QualifiedName;
  actor: ActorId;
  value: Json;
  setBy: ActorId;
  run?: RunId;
  updatedAt: Timestamp;
}

// ═══ Permissions ═══

/** Which actors a policy covers. */
export type ActorMatch = { actor: ActorId } | { group: ActorId } | { kind: ActorKind } | { everyone: true };

/** Which fns a policy covers. All given fields must match. */
export interface FnMatch {
  /** A name or a glob over names: `fs/*`. */
  fn?: string;
  system?: SystemName;
  kind?: 'native' | QualifiedName;
  tags?: string[];
  /** A gin predicate over the args. */
  when?: Json;
}

/** Who answers an "ask". */
export type Approver =
  | { by: 'turn-user' }
  | { by: 'actor'; actor: ActorId }
  | { by: 'group'; group: ActorId; quorum?: number }
  /** An agent fn that answers allow or deny with a reason. */
  | { by: 'judge'; fn: QualifiedName }
  /** The hub decides by itself (a rule, a quota). */
  | { by: 'hub' };

/**
 * May these actors run these fns? Deny beats ask beats allow; a more specific match beats a broader one. With no
 * match, the turn's user is asked. Only admins and approved hub fns change policies.
 */
export interface Policy {
  id: Id<'policy'>;
  description: string;
  subject: ActorMatch;
  target: FnMatch;
  decision: { effect: 'allow' } | { effect: 'deny'; reason: string } | { effect: 'ask'; approver: Approver };
  priority: number;
  expiresAt?: Timestamp;
  createdBy: ActorId;
  createdAt: Timestamp;
}

/** A run waiting for approval. */
export interface Approval {
  id: Id<'approval'>;
  run: RunId;
  policy?: Id<'policy'>;
  approver: Approver;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decisions: Array<{ by: ActorId; approve: boolean; remember: 'once' | 'session' | 'always'; reason?: string; at: Timestamp }>;
  createdAt: Timestamp;
}

// ═══ Runs and turns ═══

/** One call of a fn: args, outcome, timing, cost, and its place in the tree. */
export interface Run {
  id: RunId;
  fn: QualifiedName;
  fnVersion: string;
  kind: 'native' | QualifiedName;
  /** The system that ran it. */
  system: SystemName;
  parent?: RunId;
  root: RunId;
  turn: TurnId;
  session?: SessionId;
  key: string;
  actor: ActorId;
  caller: ActorId;
  /** The LLM call whose tool call made this run. */
  llmCall?: Id<'llmInteraction'>;
  toolCallId?: string;
  args: Json;
  status: RunStatus;
  outcome?: OutcomeWire;
  progress?: Json;
  allowed: Pick<Operations, 'cancel' | 'pause' | 'background'>;
  /** Spent by this run itself. */
  cost: Usd;
  /** Spent by it and everything under it. */
  totalCost: Usd;
  priority: Priority;
  background: boolean;
  attempt: number;
  errors: Array<{ attempt: number; error: FnError; cost: Usd; at: Timestamp }>;
  undo?: Json;
  resume?: Json;
  /** Session state it changed, with the values before, so undoing the turn can put them back. */
  stateChanges: Array<{ field: string; type: string; before?: Json; after?: Json }>;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
}

/**
 * One field of a system's session state. A field is identified by its name and type together: two fns share it
 * only if both declare that name with the same type.
 */
export interface StateField {
  session: SessionId;
  system: SystemName;
  name: string;
  /** Hash of the field's gin type. */
  type: string;
  def: GinTypeDef;
  value: Json;
  /** Bumped on every write. */
  version: number;
  updatedBy: { run: RunId } | { delivery: Id<'delivery'> };
  updatedAt: Timestamp;
}

/**
 * A message from the browser to a system: an action, or a form submission to a waiting run. Stored before it is
 * delivered, so nothing is lost while the system is offline; delivered in order when it connects. The sender sees
 * its status and result live.
 */
export interface DeliveryRecord {
  id: Id<'delivery'>;
  system: SystemName;
  kind: { action: string; input: Json } | { form: RunId; value: Json };
  session: SessionId;
  actor: ActorId;
  /** The run whose renderer sent it. */
  run?: RunId;
  status: 'queued' | 'delivered' | 'done' | 'failed' | 'expired';
  result?: Json;
  error?: FnError;
  attempts: number;
  createdAt: Timestamp;
  deliveredAt?: Timestamp;
  doneAt?: Timestamp;
  expiresAt?: Timestamp;
}

/** A handler call relayed between a run and its caller. */
export interface HandlerCall {
  id: Id<'handlerCall'>;
  run: RunId;
  handler: string;
  args: Json;
  /** Who answers: a person (a form in the chat), or the caller's system. */
  answerer: { user: ActorId } | { system: SystemName; run: RunId };
  status: 'pending' | 'answered' | 'failed';
  result?: Json;
}

/** One user message (or `!` invocation) and everything it caused. Undo, budgets and the tree view work on turns. */
export interface Turn {
  id: TurnId;
  session?: SessionId;
  message?: MessageId;
  actor: ActorId;
  /** The person, as systems see them, captured when the turn started. */
  user: UserInfo;
  /** Their time when the turn started; runs get the time when they start. */
  time: TimeInfo;
  /** What the browser reported with the message. */
  client?: ClientInfo;
  root?: RunId;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'paused' | 'undone';
  /** Priority and budgets, resolved once when the turn starts (see `Limits`). */
  limits: ResolvedLimits;
  cost: Usd;
  /** Stop after this many failures, or keep feeding errors to the agent. */
  errors: { max: number } | 'feed-back';
  createdAt: Timestamp;
  endedAt?: Timestamp;
}

/** A node of a turn's fn tree. */
export interface TreeNode {
  run: Pick<Run, 'id' | 'fn' | 'status' | 'cost' | 'totalCost' | 'startedAt' | 'endedAt'>;
  llmCalls: Array<Pick<LlmInteraction, 'id' | 'model' | 'cost' | 'status'>>;
  children: TreeNode[];
}

/** What undoing a turn did. */
export interface UndoReport {
  turn: TurnId;
  undone: Array<{ run: RunId; fn: QualifiedName; summary: string }>;
  failed: Array<{ run: RunId; fn: QualifiedName; error: FnError }>;
  notUndoable: Array<{ run: RunId; fn: QualifiedName }>;
}

/** Every LLM call, saved whole. */
export interface LlmInteraction {
  id: Id<'llmInteraction'>;
  turn: TurnId;
  run: RunId;
  session?: SessionId;
  /** Set when it came from a system through `ctx.llm`. */
  system?: SystemName;
  iteration: number;
  provider: string;
  model: string;
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

/** One iteration of an agent run, waiting for the LLM worker (`@ayepi/work`, priority doer, behind the budgets). */
export interface LlmJob {
  run: RunId;
  turn: TurnId;
  session?: SessionId;
  iteration: number;
  priority: Priority;
}

/** A run waiting for the run worker. */
export interface RunJob {
  run: RunId;
  priority: Priority;
}

/** Queue and timing settings. */
export interface QueueSettings {
  /** A tool running longer than this stops blocking the agent, if a user is active in the session. */
  toolTimeout: Duration;
  /** How recently a user must have been active to count as present. */
  activeWindow: Duration;
  llmConcurrency: number;
  /** Per system. */
  runConcurrency: number;
  priorities: Record<Priority, number>;
}

// ═══ Sessions and chat ═══

/**
 * A chat. With one person in it, the session's agent answers every message. With more than one person, agents
 * stay quiet unless addressed: an agent answers a message that replies to one of its own messages, and every
 * agent answers a reply-all. See `ChatMessage.replyTo` and `replyAll`.
 */
export interface Session {
  id: SessionId;
  title: string;
  owner: ActorId;
  /** The agent fn that answers when only one person is in the session. Default `hub/chat`. */
  agent: QualifiedName;
  /** People and agents. A person is notified of every message, of replies to their own messages, or of nothing. Agents follow the reply rule above. */
  participants: Array<{ actor: ActorId; role: 'owner' | 'member' | 'agent'; notify: 'all' | 'replies' | 'none'; joinedAt: Timestamp }>;
  /** Only these systems' fns, context, mentions and hooks apply. The hub's own message extras always do. */
  systems: SystemName[] | 'all';
  /** The agent's loaded fns and context so far. */
  tools: QualifiedName[];
  context: QualifiedName[];
  /** The session's priority and budgets are `PriorityRule`s and `BudgetRule`s scoped to it: a default and a ceiling, a per-turn cap, and a total for the whole session. */
  status: 'idle' | 'running' | 'paused';
  /** The aeye conversation for the next iteration. */
  transcript: Message[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archived: boolean;
}

/** A message in a session. */
export interface ChatMessage {
  id: MessageId;
  session: SessionId;
  turn: TurnId;
  author: ActorId;
  role: 'user' | 'assistant' | 'note';
  parts: MessagePart[];
  runs: RunId[];
  status: 'streaming' | 'done' | 'failed';
  /** The message this replies to. With more than one person in the session, replying to an agent's message is how that agent is asked to answer. */
  replyTo?: MessageId;
  /** Addressed to every agent in the session: each one answers. */
  replyAll: boolean;
  /** The agents the hub woke for this message, from the rule on `Session`. */
  answerers: ActorId[];
  createdAt: Timestamp;
}

/** A piece of a message. */
export type MessagePart =
  | { type: 'text'; text: string }
  /**
   * Something picked with `@`. The chat shows `label` as a chip with the system's hover card. The LLM gets `text`
   * (from the provider's `llm`, written at send time) wrapped as
   * `<mention provider="db/rows" label="Acme Corp">…text…</mention>` in place of the chip.
   */
  | { type: 'mention'; provider: QualifiedName; label: string; target: Json; text: string }
  | { type: 'command'; context: QualifiedName; args: Record<string, string> }
  | { type: 'invocation'; run: RunId; fn: QualifiedName }
  | { type: 'file'; ref: ContentRef; name: string }
  /** What the hub added by itself (local time, suggested context and fns). Shown dimmed; the LLM sees it tagged. */
  | { type: 'extra'; extra: 'local-time' | 'suggested-context' | 'suggested-fns'; blocks: Json[] }
  /** What a system's hook added. Shown dimmed; the LLM sees it tagged. */
  | { type: 'hook'; hook: QualifiedName; blocks: Json[] }
  | { type: 'attachment'; attachment: QualifiedName; data: Json; title: string }
  | { type: 'link'; link: Link };

/** What the session's controls can do, given what's running. */
export interface SessionControls {
  pause: boolean;
  cancel: boolean;
  /** Runs that won't stop on cancel. */
  uncancellable: RunId[];
  undoLastTurn: boolean;
}

/** Whether a user is looking at a session. */
export interface Presence {
  session: SessionId;
  user: ActorId;
  focused: boolean;
  typing: boolean;
  lastActiveAt: Timestamp;
}

/** What the chat UI may show right now, from what is configured and connected. */
export interface ChatCapabilities {
  voiceInput: boolean;
  voiceOutput: boolean;
  uploads: boolean;
  mentions: Array<{ provider: QualifiedName; title: string }>;
  commands: Array<{ name: string; context: QualifiedName; args: Array<{ name: string; hint: string; required: boolean }>; description: string }>;
  /** Fns a user may run with `!`. */
  invocations: Array<{ fn: QualifiedName; description: string; args: GinTypeDef }>;
  clients: Array<{ system: SystemName; url: string; hash: string }>;
  systems: Array<{ name: SystemName; status: SystemStatus; enabled: boolean }>;
  models: Array<{ id: string; name: string }>;
}

// ═══ Content and index ═══

/** The hub's row for a resource. */
export interface ResourceRecord {
  uri: ResourceUri;
  system: SystemName;
  stat: ResourceStat;
  links: ResourceLink[];
  indexedVersion?: string;
  sectioner?: QualifiedName;
  seenAt: Timestamp;
}

/** A user's choice of sectioner for some resources. More specific matches win; a user's rule beats a system's default. */
export interface SectionRule {
  id: Id<'sectionRule'>;
  match: SectionMatch;
  sectioner: QualifiedName;
  setBy: ActorId;
}

/** What changed between two versions of a resource, by section key. Context made from changed sections goes stale. */
export interface SectionDiff {
  uri: ResourceUri;
  from: string;
  to: string;
  added: SectionKey[];
  changed: SectionKey[];
  removed: SectionKey[];
}

/** What the hub indexes. */
export type IndexedKind = 'fn' | 'context' | 'section' | 'message' | 'type';

/** An indexed item. Vectors live in a table per embedder. */
export interface IndexEntry {
  kind: IndexedKind;
  key: string;
  system?: SystemName;
  text: string;
  embedder: QualifiedName;
  updatedAt: Timestamp;
}

// ═══ Models and spend ═══

/** A model provider, one per aeye provider package. Keys are stored as secrets. */
export type ProviderConfig =
  | { provider: 'openai'; apiKey: Id<'secret'>; baseURL?: string }
  | { provider: 'openrouter'; apiKey: Id<'secret'> }
  | { provider: 'aws'; region: string; credentials?: Id<'secret'> }
  | { provider: 'replicate'; apiKey: Id<'secret'> };

/** An encrypted secret. Only its id and name ever leave the hub. */
export interface Secret { id: Id<'secret'>; name: string; owner: ActorId; ciphertext: string; createdAt: Timestamp }

/** A named, ordered list of models: start with the first, move down when quality demands it. */
export interface ModelCategory { id: Id<'modelCategory'>; name: string; description: string; models: string[] }

/** The hub's catalog: aeye's `ModelInfo` for every configured provider's models. */
export interface ModelCatalog { models: ModelInfo[]; refreshedAt: Timestamp }

/**
 * Where a priority or budget rule lives. The levels a turn passes through, from broad to specific: the hub, the
 * user's groups, the user, the session, the turn. Systems, fns and models can have budgets too.
 */
export type LimitScope =
  | { scope: 'hub' }
  | { scope: 'group'; group: ActorId }
  | { scope: 'user'; user: ActorId }
  | { scope: 'session'; session: SessionId }
  | { scope: 'turn'; turn: TurnId }
  | { scope: 'system'; system: SystemName }
  | { scope: 'fn'; fn: QualifiedName }
  | { scope: 'model'; model: string };

/** How long a budget's spend adds up before it starts again. */
export type BudgetPeriod =
  /** A rolling window (the last 24 hours). */
  | { window: Duration }
  /** Never resets: a session's total, a user's lifetime allowance. */
  | 'all-time'
  /** Each turn on its own: the per-message cap. Only on hub, group, user and session. */
  | 'per-turn';

/** A budget: how much may be spent at one level, per period. `@ayepi/rate` counts calls, not dollars, so the hub keeps a ledger. */
export interface BudgetRule {
  id: Id<'budget'>;
  target: LimitScope;
  period: BudgetPeriod;
  maxCost: Usd;
  maxTokens?: number;
  maxCalls?: number;
  /** For `per-turn` budgets: how long a turn may take. */
  maxTime?: Duration;
  /**
   * Only on groups. `pooled`: the members share one pot. `each`: every member gets this allowance on their own,
   * and a user in several such groups gets the most generous one.
   */
  share?: 'pooled' | 'each';
  /** When reached: wait for the period to free up, refuse, or ask someone to raise it. */
  onLimit: 'wait' | 'refuse' | 'ask';
  setBy: ActorId;
}

/** A priority rule: the priority used unless something more specific sets one, and the highest allowed. */
export interface PriorityRule {
  id: Id<'priorityRule'>;
  target: Extract<LimitScope, { scope: 'hub' | 'group' | 'user' | 'session' | 'turn' }>;
  default?: Priority;
  /** No turn under this level runs above it. */
  max?: Priority;
  setBy: ActorId;
}

/**
 * How priority and budgets are resolved for a turn. There is always exactly one answer.
 *
 * **Priority:**
 * 1. The default comes from the most specific level that sets one: turn, session, user, the user's groups (the
 *    highest among them), then the hub.
 * 2. The ceiling is the lowest `max` across the levels that set one. At the group level, the highest `max`
 *    among the user's groups counts, because membership grants.
 * 3. The turn runs at the default, lowered to the ceiling if it is above it.
 *
 * **Budgets:**
 * 1. Every window and all-time budget that applies counts at once: the hub's, the session's total, the user's,
 *    each pooled group the user is in, and the most generous `each` group allowance. No spend may take any of
 *    them over.
 * 2. The per-turn cap is the lowest `per-turn` budget across the levels, so a session can lower what one message
 *    may spend but can't raise it above the user's or the hub's cap.
 * 3. A turn's budget is the per-turn cap, lowered to the least that is left of every other budget. So a nearly
 *    spent session total shrinks each message's budget.
 * 4. System, fn and model budgets are checked on each call they cover.
 */
export interface ResolvedLimits {
  priority: Priority;
  /** Which level gave the default, and which capped it. */
  priorityFrom: { default: LimitScope['scope']; cappedBy?: LimitScope['scope'] };
  /** The turn's own budget after rule 3. */
  turn: { cost: Usd; time: Duration };
  /** Every budget that applies, with what was left when the turn started. */
  budgets: Array<{ rule: Id<'budget'>; scope: LimitScope; remaining: Usd }>;
  /** The tightest one, shown in the chat ("limited by: session total"). */
  limitedBy: Id<'budget'>;
}

/** Budget held before an LLM call, settled with the real cost after. */
export interface Reservation { id: Id<'reservation'>; budgets: Id<'budget'>[]; estimate: Usd; createdAt: Timestamp; settled?: { cost: Usd; at: Timestamp } }

/** One line of spend. */
export interface LedgerEntry {
  id: Id<'ledger'>;
  at: Timestamp;
  cost: Usd;
  tokens: number;
  actor: ActorId;
  system?: SystemName;
  session?: SessionId;
  fn: QualifiedName;
  model?: string;
  llmCall?: Id<'llmInteraction'>;
  run: RunId;
}

// ═══ Browser ═══

/** Events the browser receives (per-user and per-session channels). */
export type BrowserEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'token'; session: SessionId; message: MessageId; text: string }
  | { type: 'controls'; session: SessionId; controls: SessionControls }
  | { type: 'run'; run: RunId; session?: SessionId; update: RunUpdate }
  | { type: 'approval'; approval: Approval }
  | { type: 'handler'; call: HandlerCall }
  | { type: 'system'; system: SystemName; status: SystemStatus }
  | { type: 'pairing'; pairing: PairingRequest }
  | { type: 'capabilities'; capabilities: ChatCapabilities }
  | { type: 'notification'; notification: Notification }
  /** Session state changed; each renderer gets the fields it declared. */
  | { type: 'state'; session: SessionId; system: SystemName; fields: Array<{ name: string; type: string; value?: Json }> }
  | { type: 'delivery'; delivery: Pick<DeliveryRecord, 'id' | 'status' | 'result' | 'error'> };

/** Why someone is notified. */
export type NotificationReason = 'approval-needed' | 'input-needed' | 'replied' | 'turn-finished' | 'pairing-requested' | 'system-disconnected' | 'spend-limit';

/** An inbox item; pushed (web push) when the user isn't looking. */
export interface Notification {
  id: Id<'notification'>;
  user: ActorId;
  reason: NotificationReason;
  title: string;
  body: string;
  link: { session: SessionId } | { approval: Id<'approval'> } | { pairing: Id<'pairing'> } | { run: RunId };
  read: boolean;
  pushed: boolean;
  createdAt: Timestamp;
}

/** A browser's web push subscription (VAPID; the hub sends pushes itself). */
export interface PushSubscription { id: Id<'push'>; user: ActorId; endpoint: string; keys: { p256dh: string; auth: string }; device: string; createdAt: Timestamp }

/** What the browser reports with every message and action, so the hub can tell systems the person's time. */
export interface ClientInfo {
  timeZone: string;
  locale: string;
  /** The browser's clock, to catch a wrong system clock. */
  now: Timestamp;
}

/** What the web chat calls (an ayepi spec over HTTP and the browser's WebSocket). */
export interface HubWebApi {
  signIn(input: { email: string; password: string }): Promise<{ token: string; user: UserActor }>;
  capabilities(input: { session?: SessionId }): Promise<ChatCapabilities>;
  sessions(input: { cursor?: string; search?: string }): Promise<Page<Session>>;
  createSession(input: { agent?: QualifiedName; systems?: SystemName[] | 'all'; title?: string }): Promise<Session>;
  updateSession(input: { session: SessionId; systems?: SystemName[] | 'all'; agent?: QualifiedName; priority?: Priority }): Promise<Session>;
  /** The resolved priority and budgets the next turn in a session would get, for the budget meter. */
  limits(input: { session: SessionId }): Promise<ResolvedLimits>;
  messages(input: { session: SessionId; cursor?: string }): Promise<Page<ChatMessage>>;
  send(input: { session: SessionId; parts: MessagePart[]; replyTo?: MessageId; replyAll?: boolean; client: ClientInfo }): Promise<{ turn: TurnId; message: ChatMessage }>;
  invoke(input: { session: SessionId; fn: QualifiedName; args: Json }): Promise<{ turn: TurnId; run: RunId }>;
  control(input: { session: SessionId; action: 'pause' | 'resume' | 'cancel' }): Promise<SessionControls>;
  undoTurn(input: { turn: TurnId }): Promise<UndoReport>;
  tree(input: { turn: TurnId }): Promise<TreeNode>;
  run(input: { run: RunId }): Promise<Run>;
  llmCall(input: { id: Id<'llmInteraction'> }): Promise<LlmInteraction>;
  mentions(input: { session: SessionId; provider: QualifiedName; query: string }): Promise<MentionOption<Json>[]>;
  mentionHover(input: { session: SessionId; provider: QualifiedName; target: Json }): Promise<MentionHover | undefined>;
  approve(input: { approval: Id<'approval'>; approve: boolean; remember: 'once' | 'session' | 'always'; reason?: string }): Promise<Approval>;
  answer(input: { call: Id<'handlerCall'>; value: Json }): Promise<void>;
  presence(input: Omit<Presence, 'user' | 'lastActiveAt'>): Promise<void>;
  notifications(input: { cursor?: string; unread?: boolean }): Promise<Page<Notification>>;
  subscribePush(input: Omit<PushSubscription, 'id' | 'user' | 'createdAt'>): Promise<{ id: Id<'push'> }>;
  resource(input: { uri: ResourceUri; want: ReadWant[] }): Promise<ResourceRead>;
  transcribe(input: { audio: ContentRef }): Promise<{ text: string }>;
  /** Send an action from a renderer. Stored, then delivered when the system is online. */
  act(input: { session: SessionId; system: SystemName; action: string; input: Json; run?: RunId }): Promise<{ delivery: Id<'delivery'> }>;
  /** Submit a fn's form to its waiting run. */
  submit(input: { run: RunId; value: Json }): Promise<{ delivery: Id<'delivery'> }>;
  /** The state fields a renderer declared (its fn's), for its first render; changes then arrive as events. */
  state(input: { run: RunId }): Promise<{ values: Record<string, Json> }>;
}

/**
 * Admin actions. Each is also a `hub` native fn, so it can be done by asking in chat (always with approval).
 */
export interface HubAdmin {
  configureProvider: { args: ProviderConfig; result: { models: number } };
  setModelCategory: { args: Omit<ModelCategory, 'id'>; result: { id: Id<'modelCategory'> } };
  configureTranscription: { args: { provider: string; model?: string } | { off: true }; result: { ok: boolean } };
  createPairingToken: { args: { name?: SystemName; expiresIn: Duration }; result: { token: string; expiresAt: Timestamp } };
  approvePairing: { args: { pairing: Id<'pairing'>; approve: boolean }; result: { system?: SystemName } };
  removeSystem: { args: { system: SystemName }; result: { fnsUnavailable: number } };
  setBudget: { args: Omit<BudgetRule, 'id' | 'setBy'>; result: { id: Id<'budget'> } };
  setPriority: { args: Omit<PriorityRule, 'id' | 'setBy'>; result: { id: Id<'priorityRule'> } };
  setPolicy: { args: Omit<Policy, 'id' | 'createdBy' | 'createdAt'>; result: { id: Id<'policy'> } };
  setActorSetting: { args: { setting: QualifiedName; actor: ActorId; value: Json }; result: { ok: boolean } };
  setSectionRule: { args: Omit<SectionRule, 'id' | 'setBy'>; result: { id: Id<'sectionRule'> } };
  addUser: { args: { email: string; name: string; role: 'admin' | 'member'; groups?: ActorId[] }; result: { id: ActorId } };
  addGroup: { args: { name: string; about: string; members?: ActorId[] }; result: { id: ActorId } };
}

// ═══ Storage ═══

/** Every table, by name. */
export interface HubTables {
  actors: Actor;
  memberships: Membership;
  credentials: Credential;
  authSessions: AuthSession;
  actorSettings: ActorSetting;
  policies: Policy;
  approvals: Approval;
  systems: SystemRecord;
  pairings: PairingRequest;
  pairingTokens: PairingToken;
  types: TypeRecord;
  kinds: KindRecord;
  fns: FnRecord;
  context: ContextRecord;
  sessions: Session;
  messages: ChatMessage;
  turns: Turn;
  runs: Run;
  handlerCalls: HandlerCall;
  stateFields: StateField;
  deliveries: DeliveryRecord;
  llmInteractions: LlmInteraction;
  resources: ResourceRecord;
  sections: Section & { uri: ResourceUri; version: string; hash: string };
  sectionRules: SectionRule;
  index: IndexEntry;
  secrets: Secret;
  providers: ProviderConfig & { id: Id<'provider'> };
  modelCategories: ModelCategory;
  budgets: BudgetRule;
  priorityRules: PriorityRule;
  reservations: Reservation;
  ledger: LedgerEntry;
  notifications: Notification;
  pushSubscriptions: PushSubscription;
}

/** A filter on columns. */
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
 * The storage port. SQLite by default; Postgres later. The same database backs the ayepi ports the hub uses (work
 * queue and store, rate store, cache), so one file holds everything.
 */
export interface HubStore {
  table<K extends keyof HubTables>(name: K): Table<HubTables[K]>;
  tx<T>(fn: (store: HubStore) => Promise<T>): Promise<T>;
  vectors: {
    upsert(embedder: QualifiedName, entries: Array<{ key: string; vector: number[] }>): Promise<void>;
    remove(embedder: QualifiedName, keys: string[]): Promise<void>;
    nearest(embedder: QualifiedName, vector: number[], limit: number, kinds?: IndexedKind[]): Promise<Array<{ key: string; score: number }>>;
  };
  text(query: { text: string; kinds: IndexedKind[]; limit: number }): Promise<Array<{ key: string; score: number }>>;
  migrate(): Promise<void>;
}

/** The hub's settings (an ayepi env slice; defaults live in its schema). */
export interface HubConfig {
  port: number;
  /** Public URL, for pairing links and push. */
  url: string;
  database: { driver: 'sqlite'; file: string } | { driver: 'postgres'; url: string };
  files: { dir: string };
  jwtSecret: string;
  secretKey: string;
  vapid: { publicKey: string; privateKey: string; subject: string };
  queues: QueueSettings;
  link: LinkLimits;
  pairingTimeout: Duration;
  /** The hub-level defaults, used until an admin sets hub rules. */
  defaults: { priority: Priority; perTurn: { cost: Usd; time: Duration } };
  embedder: QualifiedName;
}

// ═══ Later ═══

/** Run a fn on a schedule. @status future */
export interface Schedule { id: Id<'schedule'>; fn: QualifiedName; args: Json; cron: string; actor: ActorId; nextAt: Timestamp; enabled: boolean }

/** Run a fn when an event happens. @status future */
export interface Trigger { id: Id<'trigger'>; on: SystemEvent['type']; when?: Json; fn: QualifiedName; args: Json; actor: ActorId; enabled: boolean }

