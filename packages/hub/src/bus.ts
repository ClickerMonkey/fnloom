/**
 * The hub's internal event bus: how modules tell each other what happened without importing each other's
 * implementations. Events are typed by `HubEvents`; the api module relays the browser-facing ones as web events
 * (`SessionEvent`, `UserEvent`) and the link module relays the subscribed ones to systems (`SystemEvent`).
 *
 * Owner: the api lane implements `EventBus` (`bus/memory.ts`); every module publishes and subscribes through it.
 */
import type {
  ActorId, Approval, BudgetRule, ChatMessage, DeliveryView, FnRecord, FnStats, HandlerCall, HubMcpId, MessageId, PairingRequest, Presence, QualifiedName, ResourceChange,
  FormKind, OutputLine, ResourceRoot, ResourceUri, RunId, RunUpdate, SessionControls, SessionId, SessionSummary, StateFieldValue, SystemName, SystemStatus, Notification,
} from '@harness/core';

/** Every internal event, by name. */
export interface HubEvents {
  'message': { message: ChatMessage };
  'message.token': { session: SessionId; message: MessageId; text: string };
  'message.reasoning': { session: SessionId; message: MessageId; text: string };
  'session.changed': { session: SessionSummary; participants: readonly ActorId[] };
  /** A session was deleted for good. */
  'session.deleted': { session: SessionId; participants: readonly ActorId[] };
  'session.controls': { session: SessionId; controls: SessionControls };
  'run.update': { run: RunId; fn: QualifiedName; session?: SessionId; update: RunUpdate };
  'state.changed': { session: SessionId; system: SystemName; fields: StateFieldValue[] };
  'delivery': { session: SessionId; delivery: DeliveryView };
  'handler': { session?: SessionId; call: HandlerCall };
  'approval': { session?: SessionId; approval: Approval; approvers: readonly ActorId[] };
  'presence': { presence: Presence };
  'notification': { notification: Notification };
  'system.status': { system: SystemName; status: SystemStatus };
  /** A connected system has applied a config version the hub pushed (its `configure` call answered). */
  'system.configured': { system: SystemName; version: number };
  /** Build 7: a system kept going past what it declared, so its functions were switched off. */
  'system.paused': { system: SystemName; refusals: number };
  /** Build 7: a system told its admins something (`notifyAdmins`). */
  'system.notice': { system: SystemName; title: string; body: string };
  'system.output': { system: SystemName; line: OutputLine };
  'pairing': { pairing: PairingRequest };
  'catalog.changed': { added: QualifiedName[]; removed: QualifiedName[]; fns: readonly FnRecord[] };
  /** A fn's running numbers after one of its runs settled. */
  'fn.stats': { fn: QualifiedName; system: SystemName; stats: FnStats };
  'resources.changed': { system: SystemName; changes: ResourceChange[] };
  /** A system's roots, as it offered them on connect or after it said they changed. */
  'resources.roots': { system: SystemName; roots: readonly ResourceRoot[] };
  /** A resource's forms or primary form changed (a form was made), so browsers refresh its badges and open viewer. */
  'resource.forms': { uri: ResourceUri; forms: FormKind[] };
  /** A context item was written, linked or forgotten. */
  'context.changed': { name: QualifiedName };
  'capabilities.changed': Record<string, never>;
  /** A hub MCP was made, changed, given a new secret or removed: its endpoint is rebuilt (or taken down). */
  'mcp.changed': { mcp: HubMcpId; removed: boolean };
  /** A budget whose rule says `ask` is used up: a call is waiting for someone to raise it. */
  'budget.reached': { budget: BudgetRule; run: RunId; reason: string; session?: SessionId | undefined };
}

export type HubEventName = keyof HubEvents;

/** A typed publish/subscribe bus. Listeners run after the publishing call returns; a throwing listener is logged, not propagated. */
export interface EventBus {
  publish<E extends HubEventName>(event: E, data: HubEvents[E]): void;
  /** Returns the unsubscribe. */
  subscribe<E extends HubEventName>(event: E, listener: (data: HubEvents[E]) => void): () => void;
}
