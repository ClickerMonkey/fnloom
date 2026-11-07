/**
 * The hub's internal event bus: how modules tell each other what happened without importing each other's
 * implementations. Events are typed by `HubEvents`; the api module relays the browser-facing ones as web events
 * (`SessionEvent`, `UserEvent`) and the link module relays the subscribed ones to systems (`SystemEvent`).
 *
 * Owner: the api lane implements `EventBus` (`bus/memory.ts`); every module publishes and subscribes through it.
 */
import type {
  ActorId, Approval, BudgetRule, ChatMessage, DeliveryView, FnRecord, HandlerCall, MessageId, PairingRequest, Presence, QualifiedName, ResourceChange,
  Json, OutputLine, ResourceRoot, RunId, RunUpdate, SessionControls, SessionId, SessionSummary, SystemName, SystemStatus, Notification,
} from '@harness/core';

/** Every internal event, by name. */
export interface HubEvents {
  'message': { message: ChatMessage };
  'message.token': { session: SessionId; message: MessageId; text: string };
  'message.reasoning': { session: SessionId; message: MessageId; text: string };
  'session.changed': { session: SessionSummary; participants: readonly ActorId[] };
  'session.controls': { session: SessionId; controls: SessionControls };
  'run.update': { run: RunId; fn: QualifiedName; session?: SessionId; update: RunUpdate };
  'state.changed': { session: SessionId; system: SystemName; fields: Array<{ name: string; type: string; value?: Json }> };
  'delivery': { session: SessionId; delivery: DeliveryView };
  'handler': { session?: SessionId; call: HandlerCall };
  'approval': { session?: SessionId; approval: Approval; approvers: readonly ActorId[] };
  'presence': { presence: Presence };
  'notification': { notification: Notification };
  'system.status': { system: SystemName; status: SystemStatus };
  /** A connected system has applied a config version the hub pushed (its `configure` call answered). */
  'system.configured': { system: SystemName; version: number };
  'system.output': { system: SystemName; line: OutputLine };
  'pairing': { pairing: PairingRequest };
  'catalog.changed': { added: QualifiedName[]; removed: QualifiedName[]; fns: readonly FnRecord[] };
  'resources.changed': { system: SystemName; changes: ResourceChange[] };
  /** A system's roots, as it offered them on connect or after it said they changed. */
  'resources.roots': { system: SystemName; roots: readonly ResourceRoot[] };
  'capabilities.changed': Record<string, never>;
  /** A budget whose rule says `ask` is used up: a call is waiting for someone to raise it. */
  'budget.reached': { budget: BudgetRule; run: RunId; reason: string };
}

export type HubEventName = keyof HubEvents;

/** A typed publish/subscribe bus. Listeners run after the publishing call returns; a throwing listener is logged, not propagated. */
export interface EventBus {
  publish<E extends HubEventName>(event: E, data: HubEvents[E]): void;
  /** Returns the unsubscribe. */
  subscribe<E extends HubEventName>(event: E, listener: (data: HubEvents[E]) => void): () => void;
}
