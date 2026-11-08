/**
 * The scope of one LLM call chain: who pays, where its interactions are saved, and what it cost. The agent loop makes
 * one per iteration and the gateway one per forwarded request; it rides on the aeye context (`ctx.call`), so the hub
 * AI's hooks reserve, settle and record against it without any id threading.
 */
import type {
  ActorId, LlmInteractionId, LlmUsage, ModelCallId, Priority, QualifiedName, ResolvedLimits, RunId, SessionId, SystemName, TurnId, Usd,
} from '@harness/core';

/** What a scope is made from. */
export interface LlmCallScopeInput {
  readonly run: RunId;
  readonly turn: TurnId;
  readonly session?: SessionId | undefined;
  /** Set when a system forwarded the call (`ctx.llm`). */
  readonly system?: SystemName | undefined;
  readonly fn: QualifiedName;
  readonly actor: ActorId;
  readonly iteration: number;
  readonly priority: Priority;
  readonly limits: ResolvedLimits;
  readonly queuedAt: number;
}

/** One finished LLM call inside a scope. */
export interface LlmCallRecord {
  readonly interaction: LlmInteractionId;
  /** Its `ModelCall` record. */
  readonly modelCall: ModelCallId;
  readonly model: string;
  readonly cost: Usd;
  readonly usage: LlmUsage;
}

/** One finished model call of any modality, as its caller hears of it. */
export interface ModelCallReceipt {
  readonly modelCall: ModelCallId;
  readonly model: string;
  readonly cost: Usd;
}

/**
 * Where the hub AI's hooks tell a caller what its calls were (their `ModelCall` ids, models and costs): a caller that
 * needs them (the model gateway, answering a system) puts one on the aeye context.
 */
export class CallReceipts {
  readonly #calls: ModelCallReceipt[] = [];

  record(call: ModelCallReceipt): void {
    this.#calls.push(call);
  }

  /** The calls finished so far, oldest first. */
  get calls(): readonly ModelCallReceipt[] {
    return this.#calls;
  }

  /** The last finished call. */
  get last(): ModelCallReceipt | undefined {
    return this.#calls.at(-1);
  }

  /** What every call cost together. */
  get cost(): Usd {
    return this.#calls.reduce((sum, call) => sum + call.cost, 0);
  }
}

/** One chain of LLM calls (a prompt iteration with its retries, or one forwarded request). */
export class LlmCallScope {
  readonly run: RunId;
  readonly turn: TurnId;
  readonly session: SessionId | undefined;
  readonly system: SystemName | undefined;
  readonly fn: QualifiedName;
  readonly actor: ActorId;
  readonly iteration: number;
  readonly priority: Priority;
  readonly limits: ResolvedLimits;
  readonly queuedAt: number;
  readonly #calls: LlmCallRecord[] = [];
  #firstTokenAt: number | undefined;

  constructor(input: LlmCallScopeInput) {
    this.run = input.run;
    this.turn = input.turn;
    this.session = input.session;
    this.system = input.system;
    this.fn = input.fn;
    this.actor = input.actor;
    this.iteration = input.iteration;
    this.priority = input.priority;
    this.limits = input.limits;
    this.queuedAt = input.queuedAt;
  }

  /** The calls finished so far, oldest first. */
  get calls(): readonly LlmCallRecord[] {
    return this.#calls;
  }

  /** The last finished call, whose tool calls become runs. */
  get last(): LlmCallRecord | undefined {
    return this.#calls.at(-1);
  }

  /** What every call in the scope cost together. */
  get cost(): Usd {
    return this.#calls.reduce((sum, call) => sum + call.cost, 0);
  }

  /** When the first token of the current call arrived. */
  get firstTokenAt(): number | undefined {
    return this.#firstTokenAt;
  }

  /** Note that a call started streaming (only the first time per call counts). */
  markFirstToken(at: number): void {
    this.#firstTokenAt ??= at;
  }

  /** Record a finished call; the next call measures its own first token. */
  record(call: LlmCallRecord): void {
    this.#calls.push(call);
    this.#firstTokenAt = undefined;
  }
}

/**
 * The hub's part of every aeye context: the scope its hooks reserve and settle against (absent for the hub's own work,
 * which no turn pays for), what that work is for (`purpose`, recorded on its `ModelCall`: `index`, `form:description`),
 * and where to report each call's record.
 */
export type HubCallContext = {
  call?: LlmCallScope;
  purpose?: string;
  receipts?: CallReceipts;
};

/** Model selection for one call, as aeye metadata: a model id, or weights for automatic selection. */
export interface HubCallMetadata {
  model?: string;
  weights?: { cost?: number; speed?: number; accuracy?: number };
}
