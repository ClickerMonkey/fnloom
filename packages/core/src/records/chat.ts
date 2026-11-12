/** Sessions, messages, presence and what the chat UI may offer. */
import { z } from 'zod';
import { ModelInfo } from '../admin.ts';
import { GinTypeDef } from '../gin.ts';
import { LlmMessage, ModelChoice } from '../llm.ts';
import { DICTATION_ENGINES } from '../model-calls.ts';
import { ChatModeConfig, ContextorConfig, GraphSelection } from '../modes.ts';
import { ChatFnMode, CommandArg, HookBlock } from '../manifest.ts';
import { ActorId, Json, MessageId, ModelCallId, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId } from '../primitives.ts';
import { ContentRef, Link } from '../resources.ts';
import { SystemStatus } from './systems.ts';
import { SuggestionRecord } from '../suggestions.ts';
import { RunStatus } from '../run.ts';
import { Display } from '../run.ts';

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
  /** The model the agent answers with in this chat, instead of the one its fn chooses. */
  model: ModelChoice.optional(),
  /** The chat mode and contextor here, instead of the agent fn's. */
  mode: ChatModeConfig.optional(),
  contextor: ContextorConfig.optional(),
  /** How far the agent may go with fns here (absent: as far as the policies allow, like `delete`). */
  fnMode: ChatFnMode.optional(),
  /** What the graph contextor chose last, rewritten every cycle. */
  selection: GraphSelection.optional(),
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

const TextPart = z.object({ type: z.literal('text'), text: z.string() });
/** Something picked with `@`: the chat shows `label` as a chip; the LLM gets `text` (written at send time) in its place. */
const MentionPart = z.object({ type: z.literal('mention'), provider: QualifiedName, label: z.string(), target: Json, text: z.string() });
const CommandPart = z.object({ type: z.literal('command'), context: QualifiedName, args: z.record(z.string(), z.string()) });
const FilePart = z.object({ type: z.literal('file'), ref: ContentRef, name: z.string() });
/**
 * Answers to an input form: the model reads them as `<input-answer>` tags (`text` is what it reads, written
 * by the web from the form's labels and values); the chat hides the part. `run` is the `input/*` run that asked.
 */
const InputAnswerPart = z.object({ type: z.literal('input-answer'), run: RunId, title: z.string(), value: Json, text: z.string() });

/** The tag the model reads input answers in. */
export const INPUT_ANSWER_TAG = 'input-answer';

/** A piece of a message. */
export const MessagePart = z.discriminatedUnion('type', [
  TextPart,
  /** An assistant's reasoning before its answer, kept as it streamed. Shown collapsed; the LLM never reads it back. */
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  MentionPart,
  CommandPart,
  z.object({ type: z.literal('invocation'), run: RunId, fn: QualifiedName }),
  /**
   * A fn call the assistant made, in the place it made it among its reasoning and text, so a message keeps
   * the order the model produced them in.
   */
  z.object({ type: z.literal('call'), run: RunId, fn: QualifiedName }),
  FilePart,
  InputAnswerPart,
  /** What the hub added by itself. Shown dimmed; the LLM sees it tagged. */
  z.object({ type: z.literal('extra'), extra: ExtraKind, blocks: z.array(HookBlock) }),
  /** What a system's hook added. Shown dimmed; the LLM sees it tagged. */
  z.object({ type: z.literal('hook'), hook: QualifiedName, blocks: z.array(HookBlock) }),
  z.object({ type: z.literal('attachment'), attachment: QualifiedName, data: Json, title: z.string() }),
  z.object({ type: z.literal('link'), link: Link }),
]);
export type MessagePart = z.infer<typeof MessagePart>;

/** The parts the chat hides (they still go to the model): what the hub or a hook added, and a form's answers. */
export const HIDDEN_PART_TYPES = ['extra', 'hook', 'input-answer'] as const satisfies readonly MessagePart['type'][];
const HIDDEN_PARTS: ReadonlySet<string> = new Set(HIDDEN_PART_TYPES);

/** Whether the chat hides a part (it shows in debug mode only). */
export function isHiddenPart(part: Pick<MessagePart, 'type'>): boolean {
  return HIDDEN_PARTS.has(part.type);
}

/** The parts a person can send (the rest are added by the hub and by fns). A mention's text is written by the hub. */
export const OutgoingPart = z.discriminatedUnion('type', [TextPart, MentionPart.omit({ text: true }), CommandPart, FilePart, InputAnswerPart]);
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
  /** User messages: the fns and context suggested for it, and those left out with their reasons. */
  suggestions: SuggestionRecord.optional(),
  /**
   * Assistant messages: the model call behind it read no prompt cache although an earlier call of the session
   * did, in full-history mode with a model that caches; the chat draws a wavy rule above it with `at`.
   */
  cacheMiss: z.object({ call: ModelCallId, at: Timestamp }).optional(),
  createdAt: Timestamp,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** What a person can do to the work running in a session: pause it, resume what was paused, or cancel it. */
export const SessionControlAction = z.enum(['pause', 'resume', 'cancel']);
export type SessionControlAction = z.infer<typeof SessionControlAction>;

/** A running (or paused) run and what can be done to it now. */
export const ControllableRun = z.object({ run: RunId, fn: QualifiedName, status: RunStatus, pause: z.boolean(), resume: z.boolean(), cancel: z.boolean() });
export type ControllableRun = z.infer<typeof ControllableRun>;

/** What the session's controls can do, given what's running. */
export const SessionControls = z.object({
  pause: z.boolean(),
  cancel: z.boolean(),
  /** Runs that won't stop on cancel. */
  uncancellable: z.array(RunId),
  undoLastTurn: z.boolean(),
  /** Each run of the session a person can control, so the chat can stop, pause or resume one, some or all. */
  runs: z.array(ControllableRun).optional(),
});
export type SessionControls = z.infer<typeof SessionControls>;

/** Whether a user is looking at a session. */
export const Presence = z.object({ session: SessionId, user: ActorId, focused: z.boolean(), typing: z.boolean(), lastActiveAt: Timestamp });
export type Presence = z.infer<typeof Presence>;

/** What the chat UI may show right now, from what is configured and connected. */
export const ChatCapabilities = z.object({
  voiceInput: z.boolean(),
  voiceOutput: z.boolean(),
  /** How voice input is heard: the browser's speech recognition, or a recording sent to the dictation model. Absent while `voiceInput` is false. */
  dictation: z.object({ engine: z.enum(DICTATION_ENGINES), language: z.string().optional() }).optional(),
  uploads: z.boolean(),
  /** `of` is the named type of the things a provider points at, whose methods its hover card offers. */
  mentions: z.array(z.object({ provider: QualifiedName, title: z.string(), of: QualifiedName.optional() })),
  /**
   * The `/commands` a person can see. `unavailable` is why one can't run now (its system is offline or left out of the
   * session): the composer shows it greyed out with that reason instead of offering it.
   */
  commands: z.array(z.object({ name: z.string(), context: QualifiedName, args: z.array(CommandArg), description: z.string(), unavailable: z.string().optional() })),
  /** Agent fns (of the hub's `llm` kind) that can answer in a chat, for the agent picker. */
  agents: z.array(z.object({ fn: QualifiedName, description: z.string() })),
  /**
   * How each fn's finished runs look in the chat, for the fns that don't keep their card (`message` or `hidden`, by
   * qualified name). A fn not listed keeps its card.
   */
  display: z.record(z.string(), Display),
  /** Fns a user may run with `!`. */
  invocations: z.array(z.object({ fn: QualifiedName, description: z.string(), args: GinTypeDef })),
  /**
   * Methods of named types a person may run on a value, from its mention's hover card. `fn` is the method's fn
   * (`fs/Entry.reveal`), whose args are the value as `self` plus the method's own.
   */
  methods: z.array(z.object({ type: QualifiedName, method: z.string(), fn: QualifiedName, description: z.string(), args: GinTypeDef })),
  clients: z.array(z.object({ system: SystemName, url: z.string(), hash: z.string() })),
  systems: z.array(z.object({ name: SystemName, status: SystemStatus, enabled: z.boolean() })),
  /** The chat models the hub can call (no embedding or rerank models), with their prices, context and abilities, for the model picker. */
  models: z.array(ModelInfo),
});
export type ChatCapabilities = z.infer<typeof ChatCapabilities>;
