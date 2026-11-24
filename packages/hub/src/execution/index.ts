/**
 * The execution module: runs and the fn tree, the run queue and the LLM queue (`@ayepi/work`, a priority doer behind a
 * rate cap on LLM call starts, at most `HARNESS_RUN_CONCURRENCY` runs per system), the agent loop (one aeye `Prompt`
 * iteration per queued job, suspending on every tool call), the hub's one aeye `AI` (OpenRouter) whose hooks
 * rate-check, reserve and settle budgets and save every `LlmInteraction`, the gateway systems forward LLM calls
 * through, permissions and approvals, priority and budget resolution, the spend ledger, and handler relaying.
 *
 * These are the interfaces other modules use. The classes are beside them: `HubRunService` (runs.ts), `HubAgentLoop`
 * (agent.ts), `HubLlmGateway` (gateway.ts), `HubLimitResolver` (limits.ts), `HubLedger` (ledger.ts),
 * `HubPolicyEngine` (policies.ts) and `HandlerRelay` (handlers.ts); `createExecution` / `executionModule`
 * (create.ts) build them all, and `testing.ts` is the rig the tests run them in.
 */
import type {
  ActorId, Approval, FnError, Json, LlmForward, LlmForwardChunk, LlmInteractionId, Priority, QualifiedName, ResolvedLimits, Run, RunId, RunSettled,
  SessionId, TurnId, UndoOutcome, UserInfo, Usd, ApprovalId, Remember, ProgressReport, AllowedOperations, LedgerEntry, BudgetId, ReservationId,
  ModelCallId, InvalidInput, InstanceName, LlmRequest, ModelChoice, Approver, ApprovalPreview, ProposalAsk, ProposedRun, ProposeRun, SystemName, OutcomeWire, CompareFork, PromptPreview, Session,
} from '@harness/core';
import { hub } from '@harness/sdk';
import type { ModelSite } from '../models/index.ts';
import type { FnModeGate } from '../fns/index.ts';
import type { DecisionResponse } from '@aeye/ai';
import type { DecideCall, EmbedCall, Heard, ImageCall, MadeImage, SpeechCall, Spoken, TranscribeCall } from './media.ts';
import type { SpendReader } from './spend.ts';
import type { EngineModel } from './ports.ts';

/** The qualified kind of agent fns, from the hub contract (`hub.kinds.llm`): renaming it there breaks every user. */
export const AGENT_KIND = hub.kinds.llm.name;
/** The kind of fn the agent loop runs. */
export type AgentKind = typeof AGENT_KIND;

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
  /**
   * The caller found the input unusable before it could be checked (a model's tool call whose JSON didn't parse): the
   * run is made and settles `invalid-input` with these problems at once, so the caller hears them and may try again.
   */
  invalid?: InvalidInput;
  /** The instance of a fleet to run on (`on=laptop`); without it the hub picks one (`InstanceRouter`). */
  on?: InstanceName;
  /** Build 7: an admin's test call (`testCall`): it runs although its system is installed and not yet live. */
  test?: boolean;
}

/** Runs: create (after the policy check), queue, execute on the right system, control, settle and undo. */
export interface RunService {
  /** Build 5: check the calls a session's agent makes against the chat's fn mode with this gate from now on. */
  gateWith(gate: FnModeGate): void;
  /** Create a run. It may wait for approval first; the result settles when the run does (or goes to the background). */
  start(input: RunInput): Promise<{ run: RunId; settled: Promise<RunSettled> }>;
  /**
   * Add a run a system proposed (`propose` on the hub link): a run of one of its own fns that waits for approval with
   * the preview it worked out. With `parent` (a run of the same system) it is that run's child and its person answers;
   * without one it is the system's own run in a turn made for it, and the admins answer. The same key gives the same run.
   */
  propose(input: ProposeRun & { system: SystemName; instance: InstanceName }): Promise<ProposedRun>;
  /**
   * Build 6: a running run of `hub/system_calls` for model calls a system makes outside any run (hooks, timers,
   * lifecycle, `hubAi()`), in a turn of the system's own, so they are charged to the system's budgets and limits and
   * recorded as its. Settle it when the call is done.
   */
  systemWork(system: SystemName, instance: InstanceName): Promise<Run>;
  /** Settle a run with how it ended (its system's outcome, or the hub's for runs it holds itself). */
  settle(run: RunId, outcome: OutcomeWire): Promise<void>;
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

/** What the policies decided for one run. */
export type RunDecision = { effect: 'allow' } | { effect: 'deny'; reason: string } | { effect: 'ask'; approval: Approval };

/**
 * Policies: may this actor run this fn now? The highest-priority matching policy decides (then the more specific, then
 * deny over ask over allow); with no match, `read` fns are allowed and anything else asks the turn's user. A person
 * running a fn themselves is not asked. `ask` records an approval for `run` and publishes it with its approvers.
 */
export interface PolicyEngine {
  /**
   * A fn that always asks (`FnDecl.approval`) asks even when a policy or the fallback allows it (a deny still wins);
   * only an explicit allow policy stands in when its approvals may be remembered. `preview` is asked for only when an
   * approval is made (not for a run denied, allowed or remembered) and kept on it; when it gives nothing (the system
   * refused), no approval is made and the run is denied.
   */
  decide(input: {
    fn: QualifiedName; actor: ActorId; turnUser: ActorId; args: Json; session?: SessionId; run: RunId; caller: ActorId; ask?: Approver; preview?: () => Promise<ApprovalPreview | undefined>;
    /** A choice the preview offered on the card (`PreviewAnswer.ask`), read once `preview` is worked out; kept on the approval as its `ask`. */
    form?: () => ProposalAsk | undefined;
    /** A chat in auto mode let this call go ahead: no matching policy means allow rather than ask (a fn that always asks still asks). */
    autoAllowed?: boolean;
    /**
     * A system's run calls its own fn (a fleet forwarding to the instance with the data) and the calling run's fn declares
     * at least this fn's mode: what it may do was decided with that run, so no matching policy means allow.
     */
    withinParent?: boolean;
    /**
     * Build 8: the call touches sensitive files its system's rules ask about (`flagsVerdict`): it waits for the turn's
     * person every time. No policy, auto mode, remembered answer or the person's own call lets it through; a deny still wins.
     */
    sensitive?: boolean;
    /**
     * A/B compare: the call is made by one variant of a compared message (its session is a fork). A fn that writes or
     * deletes waits for the turn's person in every variant, each on its own: no policy, auto mode or remembered answer
     * lets it through, and the approval says which variant asks. A deny still wins.
     */
    variant?: CompareFork;
    /**
     * The fns of the runs the call is made under, nearest first (its parent's fn, then that run's parent's, …), so a
     * policy that names one (`FnMatch.via`) matches calls made by that fn's runs only.
     */
    via?: readonly QualifiedName[];
  }): Promise<RunDecision>;
  /** Make the approval of a run a system proposed (`propose` on the hub link), with its preview, and tell its approvers. */
  propose(input: { run: RunId; fn: QualifiedName; approver: Approver; preview: ApprovalPreview; turnUser: ActorId; session?: SessionId; ask?: ProposalAsk }): Promise<Approval>;
  /**
   * Answer an approval. For a fn whose approvals may not be remembered, any `remember` counts as `once`. Build 9: an
   * approval with `ask` is approved only with an `answer` that fits its type, set as the run's `args[into]` first.
   */
  answer(approval: ApprovalId, input: { by: ActorId; approve: boolean; remember: Remember; reason?: string; answer?: Json }): Promise<Approval>;
}

/** Priority and budgets for a turn: always exactly one answer (see `ResolvedLimits` and docs/harness.md). */
export interface LimitResolver {
  resolve(input: { user: UserInfo; session?: SessionId; turn?: TurnId; requested?: Priority }): Promise<ResolvedLimits>;
}

/** Where an LLM call is made, as its ledger line will say: the system, fn and model budgets that cover it. */
export type CallSite = Required<Pick<LedgerEntry, 'fn' | 'model'>> & Pick<LedgerEntry, 'system'>;

/** Spend: reservations before LLM calls, settlement after, the record of every cost, and what budgets have spent. */
export interface Ledger extends SpendReader {
  /**
   * Hold an estimate against every budget that applies: the turn's cap, the budgets its limits name, and every
   * system, fn and model budget that covers the call's site. Refused (or delayed) when one would go over.
   * Reservations are checked one at a time, so concurrent calls always see each other's holds.
   */
  reserve(input: { limits: ResolvedLimits; estimate: Usd; run: RunId; site: CallSite }): Promise<
    { ok: true; reservation: ReservationId } | { ok: false; wait?: number; reason: string; budget: BudgetId }
  >;
  /** Turn a hold into a ledger line of what the call really cost. Settling a reservation twice records it once. */
  settle(reservation: ReservationId, entry: Omit<LedgerEntry, 'id' | 'at'>): Promise<void>;
  /** A cost a system reported (`ctx.budget.spend`). */
  record(entry: Omit<LedgerEntry, 'id' | 'at'>): Promise<void>;
  /**
   * What is left to spend: the turn's cap lowered to every budget's remainder. Given the turn and actor, the turn's own
   * spend and the actor's group allowance count too.
   */
  remaining(limits: ResolvedLimits, who?: { turn: TurnId; actor: ActorId }): Promise<{ cost: Usd; limitedBy: string }>;
}

/** What a non-chat model call gave, with its `ModelCall` record, what it cost and the model that answered. */
export interface Recorded<T> {
  readonly value: T;
  readonly call: ModelCallId;
  readonly cost: Usd;
  readonly model: string;
}

/**
 * The one caller of real model providers, for every modality: queued by priority, rate-limited per model, budgeted
 * (calls inside a run, against its turn) and recorded (a `ModelCall` each; chat calls also as interactions). Non-chat
 * calls are for a run of a system (`ModelSite` with `system`, which must name the system's own unsettled run) or the
 * hub's own work (`purpose`, inside a run that pays when one is given).
 */
export interface LlmGateway {
  /** A forwarded request from a system (`HubLink.llm`), streamed back. */
  forward(input: LlmForward & { system: string; turn?: TurnId; instance?: InstanceName }, signal: AbortSignal): AsyncIterable<LlmForwardChunk>;
  /** Embeddings; the hub's own work may say how soon it is needed (`priority`, default background: the index's search lane is interactive). */
  embed(input: EmbedCall, site: ModelSite, signal: AbortSignal, priority?: Priority): Promise<Recorded<number[][]>>;
  image(input: ImageCall, site: ModelSite, signal: AbortSignal): Promise<Recorded<MadeImage[]>>;
  transcribe(input: TranscribeCall, site: ModelSite, signal: AbortSignal): Promise<Recorded<Heard>>;
  speech(input: SpeechCall, site: ModelSite, signal: AbortSignal): Promise<Recorded<Spoken>>;
  /** One decision call (within the model's `maxQuestions`: callers split, `models/decide.ts`). */
  decide(input: DecideCall, site: ModelSite, signal: AbortSignal): Promise<Recorded<DecisionResponse>>;
  /**
   * One chat call of the hub's own (no tools, the answer's text collected), recorded as a `ModelCall` with its site's
   * purpose and paid by its run when it names one; `provider` pins the model to one provider. `priority` places it on the LLM queue (the hub's work waits as
   * background otherwise).
   */
  chat(input: { request: LlmRequest; model?: ModelChoice; provider?: string; priority?: Priority }, site: ModelSite, signal: AbortSignal): Promise<Recorded<string>>;
  /** The models configured providers offer. */
  models(): Promise<EngineModel[]>;
  /**
   * Whether a provider (its aeye key) is set up on the hub AI now, so a call pinned to it can run (a system's provider
   * is offered a moment before the AI is rebuilt with it). Absent: assumed set up.
   */
  serves?(provider: string): boolean;
}

/** The model providers behind the hub AI. */
export interface ProviderService {
  /** Rebuild the hub AI from the stored provider records (after one was added or changed). */
  reload(): Promise<void>;
}

/** One agent (`AGENT_KIND` fn) run, iterated one LLM call per queued job. */
export interface AgentLoop {
  /** Start an agent run for a turn. */
  start(input: RunInput & { kind: AgentKind }): Promise<{ run: RunId }>;
  /** Run the next iteration of an agent run (the LLM job handler). */
  iterate(run: RunId, iteration: number, signal: AbortSignal): Promise<'waiting-for-tools' | 'done' | { failed: FnError }>;
  /** A new user message arrived: move the agent's running tool calls to the background so it can answer now. */
  interrupt(run: RunId): Promise<void>;
  /** Carry on an agent run that stopped at its step limit or was cancelled: the same run, a fresh step budget (Continue). */
  continue(run: RunId, by: ActorId): Promise<void>;
  /** The request a session's agent would send for a new message, with no model called and nothing kept (admins' prompt preview). */
  preview(input: { session: Session; user: ActorId; message: string; model?: string | undefined; count?: readonly string[] | undefined }): Promise<PromptPreview>;
}
