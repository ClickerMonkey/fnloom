/** Runs, turns, LLM interactions, session state, deliveries and handler calls: the record of everything that happened. */
import { z } from 'zod';
import { GinTypeDef } from '../gin.ts';
import { LlmChunk, LlmRequest, LlmUsage } from '../llm.ts';
import {
  ActorId, ConnectionId, DeliveryId, FnKindName, HandlerCallId, InstanceName, Json, LlmInteractionId, MessageId, ModelCallId, Priority, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId, Usd,
} from '../primitives.ts';
import { AllowedOperations, ClientInfo, FnError, OutcomeWire, ProgressWire, RunStatus, TimeInfo, UserInfo } from '../run.ts';
import { RunText } from '../status.ts';
import { GraphSelection, SelectionReport } from '../modes.ts';
import { ResolvedLimits } from './spend.ts';
import { AnnouncedSystems } from './announced.ts';
import { KeptVariant, TurnCompare } from './compare.ts';

/** A session state change a run made, with the value before, so undoing the turn can put it back. */
export const StateChange = z.object({ field: z.string(), type: z.string(), before: Json.optional(), after: Json.optional() });
export type StateChange = z.infer<typeof StateChange>;

/** One call of a fn: args, outcome, timing, cost, and its place in the tree. */
export const Run = z.object({
  id: RunId,
  fn: QualifiedName,
  fnVersion: z.string(),
  kind: FnKindName,
  /** The system that ran it. */
  system: SystemName,
  /**
   * The instance of the system it runs on, chosen once when it is made (`laptop` in a fleet of fs instances). Absent
   * for the hub's own runs and for rows made before fleets.
   */
  instance: InstanceName.optional(),
  parent: RunId.optional(),
  root: RunId,
  turn: TurnId,
  session: SessionId.optional(),
  key: z.string(),
  actor: ActorId,
  caller: ActorId,
  /** A per-person fn's connection, chosen when the run started (its 'ask first' decided the approval): the run acts as it. */
  connection: ConnectionId.optional(),
  /** The LLM call whose tool call made this run. */
  llmCall: LlmInteractionId.optional(),
  toolCallId: z.string().optional(),
  args: Json,
  /** An admin's test call of an installed system or an item waiting for review; the calls it makes are tests too. */
  test: z.boolean().optional(),
  status: RunStatus,
  /** What it says it is doing, resolved from its fn's status templates when it last changed phase. */
  text: RunText.optional(),
  outcome: OutcomeWire.optional(),
  progress: ProgressWire.optional(),
  allowed: AllowedOperations,
  /** Spent by this run itself. */
  cost: Usd,
  /** Spent by it and everything under it. */
  totalCost: Usd,
  priority: Priority,
  background: z.boolean(),
  attempt: z.number().int().min(1),
  errors: z.array(z.object({ attempt: z.number().int(), error: FnError, cost: Usd, at: Timestamp })),
  undo: Json.optional(),
  resume: Json.optional(),
  stateChanges: z.array(StateChange),
  /** Model tokens it and its model calls used (for metrics). */
  tokens: z.number().int().min(0).optional(),
  createdAt: Timestamp,
  /** When a person approved it, so the approval wait is told apart from the queue wait. */
  approvedAt: Timestamp.optional(),
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
});
export type Run = z.infer<typeof Run>;

/** The parts of a run the chat shows in lists and trees. */
export const RunSummary = Run.pick({ id: true, fn: true, status: true, cost: true, totalCost: true, startedAt: true, endedAt: true });
export type RunSummary = z.infer<typeof RunSummary>;

/** One field of a system's session state, identified by its name and type together. */
export const StateField = z.object({
  session: SessionId,
  system: SystemName,
  name: z.string(),
  /** Hash of the field's gin type. */
  type: z.string(),
  def: GinTypeDef,
  value: Json,
  /** Bumped on every write. */
  version: z.number().int().min(1),
  updatedBy: z.union([z.object({ run: RunId }), z.object({ delivery: DeliveryId })]),
  updatedAt: Timestamp,
});
export type StateField = z.infer<typeof StateField>;

/**
 * A state field as the chat sees it: its name and type hash (two fields are the same only when both match) and its
 * value, absent when the field is empty or was just cleared.
 */
export const StateFieldValue = StateField.pick({ name: true, type: true }).extend({ value: Json.optional() });
export type StateFieldValue = z.infer<typeof StateFieldValue>;

/** Where a delivery is. */
export const DeliveryStatus = z.enum(['queued', 'delivered', 'done', 'failed', 'expired']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** A message from the browser to a system (an action, or a form submission), stored before it is delivered. */
export const DeliveryRecord = z.object({
  id: DeliveryId,
  system: SystemName,
  kind: z.union([z.object({ action: z.string(), input: Json }), z.object({ form: RunId, value: Json })]),
  session: SessionId,
  actor: ActorId,
  /** The run whose renderer sent it. */
  run: RunId.optional(),
  status: DeliveryStatus,
  result: Json.optional(),
  error: FnError.optional(),
  attempts: z.number().int().min(0),
  createdAt: Timestamp,
  deliveredAt: Timestamp.optional(),
  doneAt: Timestamp.optional(),
  expiresAt: Timestamp.optional(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

/** What the browser hears about a delivery. */
export const DeliveryView = DeliveryRecord.pick({ id: true, status: true, result: true, error: true });
export type DeliveryView = z.infer<typeof DeliveryView>;

/** A handler call relayed between a run and its caller. */
export const HandlerCall = z.object({
  id: HandlerCallId,
  run: RunId,
  handler: z.string(),
  args: Json,
  /** The handler's declared shapes, so a person can be shown a form. */
  decl: z.object({ description: z.string(), args: GinTypeDef, returns: GinTypeDef }),
  /** Who answers: a person (a form in the chat), or the caller's system. */
  answerer: z.union([z.object({ user: ActorId }), z.object({ system: SystemName, run: RunId })]),
  status: z.enum(['pending', 'answered', 'failed']),
  result: Json.optional(),
  createdAt: Timestamp,
});
export type HandlerCall = z.infer<typeof HandlerCall>;

/** How a turn stands. */
export const TurnStatus = z.enum(['running', 'done', 'failed', 'cancelled', 'paused', 'undone']);
export type TurnStatus = z.infer<typeof TurnStatus>;

/**
 * What a turn found on its session before it changed anything, so undoing it puts the session back: how long the
 * transcript was, and the fns, context and graph selection the agent had loaded.
 */
export const TurnStart = z.object({
  /** The transcript's length before the turn's first message went in. */
  transcript: z.number().int().min(0),
  tools: z.array(QualifiedName),
  context: z.array(QualifiedName),
  selection: GraphSelection.optional(),
  /** What the chat had been suggested (`Session.suggested`), so an undone turn's suggestions can be made again. */
  suggested: z.array(QualifiedName).optional(),
  /** What the model had been told about the systems (`Session.announcedSystems`), so an undone turn's changes are told again. */
  announcedSystems: AnnouncedSystems.optional(),
});
export type TurnStart = z.infer<typeof TurnStart>;

/** One user message (or `!` invocation) and everything it caused. Undo, budgets and the tree view work on turns. */
export const Turn = z.object({
  id: TurnId,
  session: SessionId.optional(),
  message: MessageId.optional(),
  actor: ActorId,
  user: UserInfo,
  time: TimeInfo,
  client: ClientInfo.optional(),
  root: RunId.optional(),
  status: TurnStatus,
  limits: ResolvedLimits,
  cost: Usd,
  /** Stop after this many failures, or keep feeding errors to the agent. */
  errors: z.union([z.object({ max: z.number().int().min(1) }), z.literal('feed-back')]),
  /** The session as the turn found it (a session turn; absent on turns from before it was kept). */
  start: TurnStart.optional(),
  /** A/B compare: the variants answering this turn's message, each in a fork of the session, and which was chosen. */
  compare: TurnCompare.optional(),
  createdAt: Timestamp,
  /** When a person last continued the turn after it stopped: its time budget counts from here. */
  continuedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
});
export type Turn = z.infer<typeof Turn>;

/** Where an LLM interaction is. */
export const LlmStatus = z.enum(['queued', 'streaming', 'done', 'failed', 'aborted']);
export type LlmStatus = z.infer<typeof LlmStatus>;

/** The response of an LLM call, as saved. */
export const LlmResponse = z.object({
  content: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(LlmChunk.shape.toolCall.unwrap()).optional(),
  finishReason: LlmChunk.shape.finishReason.unwrap(),
  refusal: z.string().optional(),
});
export type LlmResponse = z.infer<typeof LlmResponse>;

/** Every LLM call, saved whole. */
export const LlmInteraction = z.object({
  id: LlmInteractionId,
  turn: TurnId,
  run: RunId,
  session: SessionId.optional(),
  /** Set when it came from a system through `ctx.llm`. */
  system: SystemName.optional(),
  iteration: z.number().int().min(0),
  provider: z.string(),
  model: z.string(),
  request: LlmRequest,
  response: LlmResponse.optional(),
  usage: LlmUsage.optional(),
  cost: Usd,
  status: LlmStatus,
  error: z.string().optional(),
  priority: Priority,
  /** What the contextor put in this prompt, and how its tokens were spent. */
  selection: SelectionReport.optional(),
  /** Its `ModelCall` (the record every model call has, of every modality). */
  modelCall: ModelCallId.optional(),
  queuedAt: Timestamp,
  startedAt: Timestamp.optional(),
  firstTokenAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
});
export type LlmInteraction = z.infer<typeof LlmInteraction>;

/** A node of a turn's fn tree. */
export interface TreeNode {
  run: RunSummary;
  llmCalls: Array<Pick<LlmInteraction, 'id' | 'model' | 'cost' | 'status'>>;
  children: TreeNode[];
}
export const TreeNode: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    run: RunSummary,
    llmCalls: z.array(LlmInteraction.pick({ id: true, model: true, cost: true, status: true })),
    children: z.array(TreeNode),
  }),
);

/** What undoing a turn did. */
export const UndoReport = z.object({
  turn: TurnId,
  undone: z.array(z.object({ run: RunId, fn: QualifiedName, summary: z.string() })),
  failed: z.array(z.object({ run: RunId, fn: QualifiedName, error: FnError })),
  notUndoable: z.array(z.object({ run: RunId, fn: QualifiedName })),
  /** An A/B compared turn: what its variants did that stays done, by variant (only variants that changed something). */
  kept: z.array(KeptVariant).optional(),
  /** How the session was put back to before the turn (a session turn that kept its start). */
  session: z.object({
    /** Messages of the turn taken out of the transcript the agent continues. */
    messages: z.number().int().min(0),
    /** Fns and context the turn loaded, unloaded again. */
    unloaded: z.array(QualifiedName),
    /** Fns and context the turn dropped, loaded again. */
    reloaded: z.array(QualifiedName),
  }).optional(),
});
export type UndoReport = z.infer<typeof UndoReport>;

/** One iteration of an agent run, waiting for the LLM worker. */
export const LlmJob = z.object({ run: RunId, turn: TurnId, session: SessionId.optional(), iteration: z.number().int().min(0), priority: Priority });
export type LlmJob = z.infer<typeof LlmJob>;

/** A run waiting for the run worker. */
export const RunJob = z.object({ run: RunId, priority: Priority });
export type RunJob = z.infer<typeof RunJob>;
