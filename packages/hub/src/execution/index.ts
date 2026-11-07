/**
 * The execution module: runs, the run queue and the LLM queue (`@ayepi/work` on the SQLite ports, priority doers,
 * `@ayepi/rate` per model), the agent loop (one aeye `Prompt` iteration per queued job, suspending on tool calls),
 * the hub as an aeye provider for systems, permissions, priority and budget resolution, and the ledger.
 *
 * Owner: the execution lane. Implement `RunService`, `AgentLoop`, `LlmGateway`, `LimitResolver`, `Ledger` and
 * `PolicyEngine`, each in its own file under `execution/`.
 */
import type {
  ActorId, Approval, FnError, Json, LlmForward, LlmForwardChunk, LlmInteractionId, Priority, QualifiedName, ResolvedLimits, Run, RunId, RunSettled,
  SessionId, TurnId, UndoOutcome, UserInfo, Usd, ApprovalId, Remember, ProgressReport, AllowedOperations, LedgerEntry, BudgetId,
} from '@harness/core';

/** A request to run a fn: from an agent's tool call, a person's `!`, or a run's child call. */
export interface RunInput {
  fn: QualifiedName;
  args: Json;
  turn: TurnId;
  session?: SessionId;
  parent?: RunId;
  /** The call's key within its parent (resumed runs get finished calls back by key). */
  key: string;
  /** Who the run acts for. */
  actor: ActorId;
  /** Who called: the agent, the user, or the parent run's fn. */
  caller: ActorId;
  priority: Priority;
  background: boolean;
  /** The optional handlers the caller can answer. */
  handlers: readonly string[];
  llmCall?: LlmInteractionId;
  toolCallId?: string;
  budget?: { cost?: Usd; time?: number };
}

/** Runs: create (after the policy check), queue, execute on the right system, control, settle and undo. */
export interface RunService {
  /** Create a run. It may wait for approval first; the result settles when the run does (or goes to the background). */
  start(input: RunInput): Promise<{ run: RunId; settled: Promise<RunSettled> }>;
  get(run: RunId): Promise<Run | undefined>;
  cancel(run: RunId, by: ActorId): Promise<{ accepted: boolean; reason?: string }>;
  pause(run: RunId, by: ActorId): Promise<{ accepted: boolean; reason?: string }>;
  resume(run: RunId, by: ActorId): Promise<void>;
  /** Stop the caller waiting: the run goes on and reports back when it finishes. */
  background(run: RunId): Promise<boolean>;
  progress(run: RunId, report: ProgressReport): Promise<void>;
  allow(run: RunId, operations: Partial<AllowedOperations>): Promise<void>;
  undoWith(run: RunId, undo: Json): Promise<void>;
  undo(run: RunId, by: ActorId): Promise<UndoOutcome>;
  /** Called by the link module when a system reconnects: re-send its unsettled runs (by `RunId`, so they run once). */
  resend(system: string): Promise<void>;
}

/** Policies: may this actor run this fn now? Deny beats ask beats allow; with no match, `read` fns are allowed. */
export interface PolicyEngine {
  decide(input: { fn: QualifiedName; actor: ActorId; turnUser: ActorId; args: Json; session?: SessionId }): Promise<
    { effect: 'allow' } | { effect: 'deny'; reason: string } | { effect: 'ask'; approval: Approval }
  >;
  answer(approval: ApprovalId, input: { by: ActorId; approve: boolean; remember: Remember; reason?: string }): Promise<Approval>;
}

/** Priority and budgets for a turn: always exactly one answer (see `ResolvedLimits` and docs/harness.md). */
export interface LimitResolver {
  resolve(input: { user: UserInfo; session?: SessionId; turn?: TurnId; requested?: Priority }): Promise<ResolvedLimits>;
}

/** Spend: reservations before LLM calls, settlement after, and the record of every cost. */
export interface Ledger {
  /** Hold an estimate against every budget that applies; refused (or delayed) when one would go over. */
  reserve(input: { limits: ResolvedLimits; estimate: Usd; run: RunId }): Promise<
    { ok: true; reservation: string } | { ok: false; wait?: number; reason: string; budget: BudgetId }
  >;
  settle(reservation: string, entry: Omit<LedgerEntry, 'id' | 'at'>): Promise<void>;
  /** A cost a system reported (`ctx.budget.spend`). */
  record(entry: Omit<LedgerEntry, 'id' | 'at'>): Promise<void>;
  remaining(limits: ResolvedLimits): Promise<{ cost: Usd; limitedBy: string }>;
}

/** The one caller of real LLM providers: queued by priority, rate-limited per model, budgeted and recorded. */
export interface LlmGateway {
  /** A forwarded request from a system (`HubLink.llm`), streamed back. */
  forward(input: LlmForward & { system: string; turn?: TurnId }, signal: AbortSignal): AsyncIterable<LlmForwardChunk>;
  /** Embeddings through a provider (when no embedder system is used). */
  embed(texts: readonly string[], run?: RunId): Promise<{ vectors: number[][]; cost: Usd }>;
  /** The models configured providers offer. */
  models(): Promise<Array<{ id: string; name: string }>>;
}

/** One agent (`hub/llm` fn) run, iterated one LLM call per queued job. */
export interface AgentLoop {
  /** Start an agent run for a turn. */
  start(input: RunInput & { kind: 'hub/llm' }): Promise<{ run: RunId }>;
  /** Run the next iteration of an agent run (the LLM job handler). */
  iterate(run: RunId, iteration: number, signal: AbortSignal): Promise<'waiting-for-tools' | 'done' | { failed: FnError }>;
  /** A new user message arrived: move the agent's running tool calls to the background so it can answer now. */
  interrupt(run: RunId): Promise<void>;
}
