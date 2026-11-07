/**
 * The chat module: sessions, turns and messages; the reply rule (who answers); approvals shown to people; session
 * state (fields matched by name and type, versioned, undoable); deliveries (actions and form submissions, stored
 * before delivery); undoing a turn; and what is added to a user message (the hub's own extras, then system hooks).
 *
 * Owner: the chat lane. Implement `SessionService`, `TurnService`, `ReplyRule`, `StateService`, `DeliveryService`,
 * `UndoService` and `MessageEnricher`, each in its own file under `chat/`.
 */
import type {
  ActorId, ChatMessage, ClientInfo, DeliveryId, DeliveryRecord, HookBlock, Json, MessageId, MessagePart, OutgoingPart, Page, Presence, QualifiedName,
  RunId, Session, SessionControls, SessionId, SessionSummary, StateOwner, SystemName, TurnId, UndoReport, UserInfo, Priority,
} from '@harness/core';

/** Sessions. */
export interface SessionService {
  create(input: { owner: ActorId; agent?: QualifiedName; systems?: SystemName[] | 'all'; title?: string }): Promise<Session>;
  get(session: SessionId, viewer: ActorId): Promise<Session | undefined>;
  list(viewer: ActorId, query: { cursor?: string; limit?: number; search?: string; archived?: boolean }): Promise<Page<SessionSummary>>;
  update(session: SessionId, patch: { title?: string; systems?: SystemName[] | 'all'; agent?: QualifiedName; priority?: Priority; archived?: boolean }, by: ActorId): Promise<Session>;
  messages(session: SessionId, viewer: ActorId, query: { cursor?: string; limit?: number }): Promise<Page<ChatMessage>>;
  controls(session: SessionId): Promise<SessionControls>;
  control(session: SessionId, action: 'pause' | 'resume' | 'cancel', by: ActorId): Promise<SessionControls>;
  presence(presence: Omit<Presence, 'lastActiveAt'>): Promise<void>;
  /** Whether a person is active in a session now (for the tool-timeout rule). */
  active(session: SessionId): Promise<boolean>;
}

/** Turns: a user message (or `!` invocation) and everything it caused. */
export interface TurnService {
  send(input: { session: SessionId; author: ActorId; parts: OutgoingPart[]; replyTo?: MessageId; replyAll?: boolean; client: ClientInfo }): Promise<{ turn: TurnId; message: ChatMessage }>;
  invoke(input: { session: SessionId; author: ActorId; fn: QualifiedName; args: Json; client: ClientInfo }): Promise<{ turn: TurnId; run: RunId }>;
  /** Append streamed text to an assistant message (from the agent loop). */
  stream(message: MessageId, delta: { text?: string; reasoning?: string }): void;
  finish(message: MessageId, parts: MessagePart[], status: 'done' | 'failed'): Promise<ChatMessage>;
}

/** Who answers a message: with one person, the session's agent; with more, only agents replied to, or every agent on reply-all. */
export interface ReplyRule {
  answerers(input: { session: Session; message: ChatMessage; repliedTo?: ChatMessage }): readonly ActorId[];
}

/** What is added to a user message before the LLM sees it: local time and suggestions (the hub's), then system hooks. */
export interface MessageEnricher {
  enrich(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<MessagePart[]>;
  /** The text the LLM gets for a message: mentions as `<mention …>` blocks, extras and hooks as tagged blocks. */
  render(message: ChatMessage): string;
  /** Hook blocks as the LLM text block they become. */
  block(tag: string, blocks: readonly HookBlock[]): string;
}

/** Session state: each fn, action and renderer sees only the fields it declared, matched by name and type. */
export interface StateService {
  get(owner: StateOwner): Promise<{ values: Record<string, Json>; version: number }>;
  set(owner: StateOwner, input: { patch: Record<string, Json>; clear: readonly string[]; version?: number }): Promise<{ version: number } | { conflict: true }>;
  /** The fields a run's fn declared, for its renderer's first draw. */
  forRun(run: RunId): Promise<Record<string, Json>>;
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
