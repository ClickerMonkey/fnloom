/** Sessions, messages, presence and what the chat UI may offer. */
import { z } from 'zod';
import { GinTypeDef } from '../gin.ts';
import { LlmMessage } from '../llm.ts';
import { CommandArg, HookBlock } from '../manifest.ts';
import { ActorId, Json, MessageId, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId } from '../primitives.ts';
import { ContentRef, Link } from '../resources.ts';
import { SystemStatus } from './systems.ts';

/** How a person wants to hear about a session's messages. */
export const NotifyChoice = z.enum(['all', 'replies', 'none']);
export type NotifyChoice = z.infer<typeof NotifyChoice>;

/** Someone in a session. */
export const Participant = z.object({ actor: ActorId, role: z.enum(['owner', 'member', 'agent']), notify: NotifyChoice, joinedAt: Timestamp });
export type Participant = z.infer<typeof Participant>;

/** A session's state. */
export const SessionStatus = z.enum(['idle', 'running', 'paused']);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * A chat. With one person in it, the session's agent answers every message. With more than one person, an agent
 * answers a message that replies to one of its own messages, and every agent answers a reply-all.
 */
export const Session = z.object({
  id: SessionId,
  title: z.string(),
  owner: ActorId,
  /** The agent fn that answers. Default `hub/chat`. */
  agent: QualifiedName,
  participants: z.array(Participant),
  /** Only these systems' fns, context, mentions and hooks apply. The hub's own message extras always do. */
  systems: z.union([z.array(SystemName), z.literal('all')]),
  /** The agent's loaded fns and context so far. */
  tools: z.array(QualifiedName),
  context: z.array(QualifiedName),
  status: SessionStatus,
  /** The conversation the next agent iteration continues. */
  transcript: z.array(LlmMessage),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archived: z.boolean(),
});
export type Session = z.infer<typeof Session>;

/** The parts of a session a list shows. */
export const SessionSummary = Session.pick({ id: true, title: true, owner: true, agent: true, status: true, createdAt: true, updatedAt: true, archived: true });
export type SessionSummary = z.infer<typeof SessionSummary>;

/** What the hub adds to a message by itself. */
export const ExtraKind = z.enum(['local-time', 'suggested-context', 'suggested-fns']);
export type ExtraKind = z.infer<typeof ExtraKind>;

/** A piece of a message. */
export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  /** An assistant's reasoning before its answer, kept as it streamed. Shown collapsed; the LLM never reads it back. */
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  /** Something picked with `@`: the chat shows `label` as a chip; the LLM gets `text` (written at send time) in its place. */
  z.object({ type: z.literal('mention'), provider: QualifiedName, label: z.string(), target: Json, text: z.string() }),
  z.object({ type: z.literal('command'), context: QualifiedName, args: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('invocation'), run: RunId, fn: QualifiedName }),
  z.object({ type: z.literal('file'), ref: ContentRef, name: z.string() }),
  /** What the hub added by itself. Shown dimmed; the LLM sees it tagged. */
  z.object({ type: z.literal('extra'), extra: ExtraKind, blocks: z.array(HookBlock) }),
  /** What a system's hook added. Shown dimmed; the LLM sees it tagged. */
  z.object({ type: z.literal('hook'), hook: QualifiedName, blocks: z.array(HookBlock) }),
  z.object({ type: z.literal('attachment'), attachment: QualifiedName, data: Json, title: z.string() }),
  z.object({ type: z.literal('link'), link: Link }),
]);
export type MessagePart = z.infer<typeof MessagePart>;

/** The parts a person can send (the rest are added by the hub and by fns). */
export const OutgoingPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('mention'), provider: QualifiedName, label: z.string(), target: Json }),
  z.object({ type: z.literal('command'), context: QualifiedName, args: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('file'), ref: ContentRef, name: z.string() }),
]);
export type OutgoingPart = z.infer<typeof OutgoingPart>;

/** A message's role. `note`: something the hub says (a turn was undone, a system went away). */
export const MessageRole = z.enum(['user', 'assistant', 'note']);
export type MessageRole = z.infer<typeof MessageRole>;

/** A message in a session. */
export const ChatMessage = z.object({
  id: MessageId,
  session: SessionId,
  turn: TurnId,
  author: ActorId,
  role: MessageRole,
  parts: z.array(MessagePart),
  runs: z.array(RunId),
  status: z.enum(['streaming', 'done', 'failed']),
  /** The message this replies to. */
  replyTo: MessageId.optional(),
  /** Addressed to every agent in the session. */
  replyAll: z.boolean(),
  /** The agents the hub woke for this message. */
  answerers: z.array(ActorId),
  createdAt: Timestamp,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** What the session's controls can do, given what's running. */
export const SessionControls = z.object({
  pause: z.boolean(),
  cancel: z.boolean(),
  /** Runs that won't stop on cancel. */
  uncancellable: z.array(RunId),
  undoLastTurn: z.boolean(),
});
export type SessionControls = z.infer<typeof SessionControls>;

/** Whether a user is looking at a session. */
export const Presence = z.object({ session: SessionId, user: ActorId, focused: z.boolean(), typing: z.boolean(), lastActiveAt: Timestamp });
export type Presence = z.infer<typeof Presence>;

/** What the chat UI may show right now, from what is configured and connected. */
export const ChatCapabilities = z.object({
  voiceInput: z.boolean(),
  voiceOutput: z.boolean(),
  uploads: z.boolean(),
  mentions: z.array(z.object({ provider: QualifiedName, title: z.string() })),
  commands: z.array(z.object({ name: z.string(), context: QualifiedName, args: z.array(CommandArg), description: z.string() })),
  /** Fns a user may run with `!`. */
  invocations: z.array(z.object({ fn: QualifiedName, description: z.string(), args: GinTypeDef })),
  clients: z.array(z.object({ system: SystemName, url: z.string(), hash: z.string() })),
  systems: z.array(z.object({ name: SystemName, status: SystemStatus, enabled: z.boolean() })),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ChatCapabilities = z.infer<typeof ChatCapabilities>;
