/**
 * The chat module: sessions, turns and messages; the reply rule (who answers); approvals shown to people; session
 * state (fields matched by name and type, versioned, undoable); deliveries (actions and form submissions, stored
 * before delivery); undoing a turn; what is added to a user message (the hub's own extras, then system hooks);
 * mentions (searched, hovered and resolved to LLM text at send time); presence; and notifications with web push.
 *
 * Owner: the chat lane. Each interface is implemented by a class in its own file under `chat/`, and `createChat`
 * (`chat/chat.ts`) builds them all from `ChatDeps`. Hooks, mention providers and actions come from the catalog's
 * manifest entries (`Catalog.entries`).
 */
import type {
  ActorId, Approver, Asker, ChatMessage, ClientInfo, DeliveryId, DeliveryRecord, HookBlock, InstanceName, Json, MentionHover, MentionOption,
  MessageId, MessagePart, Notification, NotificationId, NotificationLink, NotificationReason, OutgoingPart, Page, Presence, QualifiedName, RunId,
  Session, SessionControls, SessionId, Suggestion, SuggestDecision, SuggestDecisionView, SuggestionRecord, SessionPatch, SessionSummary, StateFieldValue, StateOwner, SystemName, TurnId, TurnStatus, UndoReport, UserInfo,
  Compact, DecideAnswer, DecideRequest, SessionListQuery, MessageListQuery, NotificationListQuery, SessionControlAction,
} from '@harness/core';

/** Sessions. */
export interface SessionService {
  create(input: { owner: ActorId; agent?: QualifiedName; systems?: SystemName[] | 'all'; title?: string }): Promise<Session>;
  get(session: SessionId, viewer: ActorId): Promise<Session | undefined>;
  list(viewer: ActorId, query: Compact<SessionListQuery>): Promise<Page<SessionSummary>>;
  /** Change a session. `notify` is the choice of `by` alone; everything else needs `by` to own the session. */
  update(
    session: SessionId,
    patch: SessionPatch,
    by: ActorId,
  ): Promise<Session>;
  /**
   * Delete a session for good: its owner only. Work still running in it is cancelled first; its messages, session
   * state, deliveries and its own priority rule go with it. Runs, turns and the ledger stay, for the admin's history.
   */
  delete(session: SessionId, by: ActorId): Promise<boolean>;
  /** Messages, newest first. A message still streaming carries the text streamed so far. */
  messages(session: SessionId, viewer: ActorId, query: Compact<Omit<MessageListQuery, 'session'>>): Promise<Page<ChatMessage>>;
  controls(session: SessionId): Promise<SessionControls>;
  /** Send a session's controls again whenever one of its runs changes status or what it allows; the unsubscribe. */
  follow(): () => void;
  /** Pause, resume or cancel the session's active runs: those named in `runs` (others of the session are ignored), else all. */
  control(session: SessionId, action: SessionControlAction, by: ActorId, runs?: readonly RunId[]): Promise<SessionControls>;
  presence(presence: Omit<Presence, 'lastActiveAt'>): Promise<void>;
  /** Whether a person is active in a session now (for the tool-timeout rule). */
  active(session: SessionId): Promise<boolean>;
  /** Set the fns and context the session's agent has loaded (`hub/load_fns`, `hub/drop_fns`, `hub/load_context`). */
  load(session: SessionId, loaded: { tools?: readonly QualifiedName[]; context?: readonly QualifiedName[] }): Promise<Session>;
}

/** What a run can attach to an assistant message. */
export type AttachedPart = Extract<MessagePart, { type: 'attachment' | 'link' }>;

/** Whether a part is one a run attached. */
export function isAttached(part: MessagePart): part is AttachedPart {
  return part.type === 'attachment' || part.type === 'link';
}

/** How a turn ends: done, failed or cancelled (never back to running, paused or undone). */
export type TurnEnd = Exclude<TurnStatus, 'running' | 'paused' | 'undone'>;

/** Turns: a user message (or `!` invocation) and everything it caused. */
export interface TurnService {
  send(input: { session: SessionId; author: ActorId; parts: OutgoingPart[]; replyTo?: MessageId; replyAll?: boolean; client: ClientInfo }): Promise<{ turn: TurnId; message: ChatMessage }>;
  invoke(input: { session: SessionId; author: ActorId; fn: QualifiedName; args: Json; on?: InstanceName | undefined; client: ClientInfo }): Promise<{ turn: TurnId; run: RunId }>;
  /** Open an assistant message for an agent's answer (from the agent loop); it streams until `finish`. */
  begin(input: { turn: TurnId; author: ActorId; replyTo?: MessageId }): Promise<ChatMessage>;
  /** Append streamed text to an assistant message (from the agent loop). */
  stream(message: MessageId, delta: { text?: string; reasoning?: string }): void;
  /** Close an assistant message with its final parts. Attachments and links runs added while it streamed are kept. */
  finish(message: MessageId, parts: MessagePart[], status: 'done' | 'failed'): Promise<ChatMessage>;
  /**
   * A run attaches something (a system attachment, already checked, or a link) to its turn's latest assistant
   * message. Refused when the run belongs to no session turn or the turn has no assistant message yet.
   */
  attach(run: RunId, part: AttachedPart): Promise<ChatMessage>;
  /**
   * Record the runs an assistant message's tool calls started, each as a `call` part in the place the model made it
   * (after what it streamed before), so the chat shows them in order (from the agent loop).
   */
  track(message: MessageId, calls: ReadonlyArray<{ readonly run: RunId; readonly fn: QualifiedName }>): Promise<void>;
  /** Record what a graph prompt chose for a user message as its suggestions (its first cycle only; a message that has them keeps them). */
  suggested(message: MessageId, record: SuggestionRecord): Promise<void>;
  /** A turn ended (the agent answered without tool calls, failed, or was cancelled): record it and tell people who are away. */
  settle(turn: TurnId, status: TurnEnd): Promise<void>;
  /**
   * Wake a session's agent to follow up on something that happened after its turn ended (a run it stopped waiting
   * for settled, its result already in the session's transcript): a new turn for the person of `turn`, with no
   * message of its own, in which `agent` answers. Nothing starts while an agent is answering in the session (it reads
   * the transcript on its next step) or when the session is gone or archived. Returns the turn started, if any.
   */
  followUp(input: { turn: TurnId; agent: ActorId }): Promise<TurnId | undefined>;
}

/** Who answers a message: with one person, the session's agent; with more, only agents replied to, or every agent on reply-all. */
export interface ReplyRule {
  answerers(input: { session: Session; message: ChatMessage; repliedTo?: ChatMessage }): readonly ActorId[];
}

/** What a message is offered, and the record of every candidate (used or not, with why). */
export interface DecidedSuggestions {
  readonly suggestions: Suggestion[];
  readonly record?: SuggestionRecord;
}

/**
 * Which fns and context a sent message is offered: by score over a threshold, or by the admin's decision model
 * (`hubOptions['suggestDecision']`) when it is on. Its picks and refusals, with reasons, become the message's record.
 */
export interface SuggestionDecider {
  decide(input: { session: SessionId; text: string; actor: ActorId }): Promise<DecidedSuggestions>;
  /** The decision model setting (off by default). */
  setting(): Promise<SuggestDecisionView>;
  set(value: SuggestDecision, by: ActorId): Promise<SuggestDecisionView>;
  /**
   * Build 5: the decision model chooses for a system (`decide` on the hub link) between reusing something it has and
   * making something new. `off` when the model is off; `failed` when its call fails or answers nonsense. The call is
   * a model call of the asking run.
   */
  forSystem(request: DecideRequest): Promise<DecideAnswer>;
}

/** What is added to a user message before the LLM sees it: local time and suggestions (the hub's), then system hooks. */
export interface MessageEnricher {
  /** The parts to add, and the record of what was suggested and what was not (none when nothing was a candidate). */
  enrich(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<{ parts: MessagePart[]; suggestions?: SuggestionRecord }>;
  /** The text the LLM gets for a message: mentions as `<mention …>` blocks, extras and hooks as tagged blocks. */
  render(message: ChatMessage): string;
  /** Hook blocks as the LLM text block they become. */
  block(tag: string, blocks: readonly HookBlock[]): string;
}

/** Session state: each fn, action and renderer sees only the fields it declared, matched by name and type. */
export interface StateService {
  get(owner: StateOwner): Promise<{ values: Record<string, Json>; version: number }>;
  set(owner: StateOwner, input: { patch: Record<string, Json>; clear: readonly string[]; version?: number }): Promise<{ version: number } | { conflict: true }>;
  /** Every field a run's fn declared, with its type and current value (if any), for its renderer's first draw. */
  forRun(run: RunId): Promise<{ system: SystemName; fields: StateFieldValue[] }>;
  /** Put back what a run changed (undo). */
  revert(run: RunId): Promise<void>;
}

/** Deliveries: actions and form submissions, stored first, delivered in order when the system is online. */
export interface DeliveryService {
  act(input: { session: SessionId; system: SystemName; action: string; input: Json; run?: RunId; actor: ActorId; client: ClientInfo }): Promise<DeliveryId>;
  submit(input: { run: RunId; value: Json; actor: ActorId }): Promise<DeliveryId>;
  get(delivery: DeliveryId): Promise<DeliveryRecord | undefined>;
  /** Deliver everything queued for a system (on connect). */
  flush(system: SystemName): Promise<void>;
}

/** Undo a turn: every run with an undo payload, newest first; session state put back. */
export interface UndoService {
  undoTurn(turn: TurnId, by: ActorId): Promise<UndoReport>;
}

// ─── Mentions ─────────────────────────────────────────────────────────────────

/** A person's mention request from the browser: where they are, and which provider. */
export interface MentionRequest {
  session: SessionId;
  actor: ActorId;
  provider: QualifiedName;
}

/** What a provider is asked with: who is asking and when (core's `Asker`), and the provider. */
export type MentionAsk = Asker & { provider: QualifiedName };

/** One source of mentions: the hub's own providers, or a system's over the link. */
export interface MentionProvider {
  /** Whether this source answers for a provider. */
  serves(provider: QualifiedName): boolean;
  search(ask: MentionAsk, query: string): Promise<MentionOption[]>;
  hover(ask: MentionAsk, target: Json): Promise<MentionHover | undefined>;
  text(ask: MentionAsk, target: Json): Promise<string>;
}

/** Mentions across every provider a session allows. */
export interface MentionService {
  search(request: MentionRequest, query: string): Promise<MentionOption[]>;
  hover(request: MentionRequest, target: Json): Promise<MentionHover | undefined>;
  /** Turn the parts a person sent into stored parts, with each mention's LLM text written now (at send time). */
  resolve(input: { session: Session; asker: Asker; parts: readonly OutgoingPart[] }): Promise<MessagePart[]>;
}

// ─── Presence and notifications ───────────────────────────────────────────────

/** Who is looking at which session, from what browsers report. */
export interface PresenceTracker {
  report(presence: Omit<Presence, 'lastActiveAt'>): Presence;
  /** Whether anyone has been focused on the session within the active window. */
  active(session: SessionId): boolean;
  /** Whether a user is focused on the session (or, without one, on any session) within the active window. */
  looking(user: ActorId, session?: SessionId): boolean;
}

/** The inbox: every notification is stored, published live, and pushed (web push) when the user isn't looking. */
export interface NotificationService {
  notify(input: { user: ActorId; reason: NotificationReason; title: string; body: string; link: NotificationLink }): Promise<Notification>;
  list(user: ActorId, query: Compact<NotificationListQuery>): Promise<Page<Notification>>;
  /** Mark some of a user's notifications read; returns how many changed. Others' ids are ignored. */
  read(user: ActorId, ids: readonly NotificationId[]): Promise<number>;
}

/** Who answers an approval, as people: the execution module publishes `approval` events with these. */
export interface ApproverDirectory {
  approvers(approver: Approver, turnUser: ActorId): Promise<ActorId[]>;
}

