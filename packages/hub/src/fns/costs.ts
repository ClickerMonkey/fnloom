/**
 * Cost estimators, one per kind of work, asked in order until one answers:
 *
 * - `FreeCostEstimator`: a fn whose facts say it spends nothing (reading a file) costs nothing.
 * - `KindCostEstimator` (build 6): a fn of a kind that estimates asks the kind's system, from its payload and args.
 * - `HistoryCostEstimator`: a fn that has run costs what its runs cost: the cheapest and dearest day's average, and
 *   the overall average as typical.
 * - `AgentCostEstimator`: an agent (the hub's `llm` kind) that has never run is priced from the call: its
 *   instructions and args as input tokens (the contextor's estimate for the model), and the model's price for some
 *   output (none, a typical answer, the most it may write by its payload or the model's limits).
 * - `DeclaredCostEstimator`: a fn that declares a rough cost per run costs that until it has run.
 * - `UnknownCostEstimator`: anything else that spends and has never run says so, at zero.
 */
import { ModelChoice, type CostEstimate, type FnMetricsDay, type KindEstimateAnswer, type KindEstimateRequest, type KindRecord, type ModelInfo, type QualifiedName, type SystemName } from '@harness/core';
import { parseValue, LlmPayloadType } from '@harness/sdk';
import type { TokenEstimator } from '../contextor/index.ts';
import { AGENT_KIND } from '../execution/index.ts';
import type { CostEstimator, CostInput } from './index.ts';

/** The output tokens of a typical agent answer (never more than the most it may write). */
const TYPICAL_OUTPUT = 800;
/** Prices are per million tokens. */
const PER_TOKENS = 1_000_000;

/** A fn that spends nothing. */
export class FreeCostEstimator implements CostEstimator {
  estimate(input: CostInput): Promise<CostEstimate | undefined> {
    return Promise.resolve(input.free ? { min: 0, typical: 0, max: 0, basis: 'free', runs: runsOf(input.history) } : undefined);
  }
}

/** The runs a history holds. */
function runsOf(history: readonly FnMetricsDay[]): number {
  return history.reduce((sum, day) => sum + Object.values(day.outcomes).reduce((a, b) => a + b, 0), 0);
}

/** From the fn's own run history. */
export class HistoryCostEstimator implements CostEstimator {
  estimate(input: CostInput): Promise<CostEstimate | undefined> {
    const days = input.history.map((day) => ({ day, runs: Object.values(day.outcomes).reduce((a, b) => a + b, 0) })).filter((d) => d.runs > 0);
    const runs = days.reduce((sum, d) => sum + d.runs, 0);
    if (runs === 0) return Promise.resolve(undefined);
    const averages = days.map((d) => d.day.cost / d.runs);
    const total = days.reduce((sum, d) => sum + d.day.cost, 0);
    return Promise.resolve({ min: Math.min(...averages), typical: total / runs, max: Math.max(...averages), basis: 'history', runs });
  }
}

/**
 * What the agent estimator reads: the models on offer, which one an agent uses when its payload doesn't say, and the
 * contextor's token estimator for a model (the one place the hub turns text into tokens, with the model's limits).
 */
export interface AgentPricing {
  models(): Promise<readonly ModelInfo[]>;
  /** The model id an agent without a model choice answers with. */
  defaultModel(): Promise<string>;
  tokens(model: string): Promise<Pick<TokenEstimator, 'text' | 'limits'>>;
}

/** An agent that hasn't run yet, priced from the call. */
export class AgentCostEstimator implements CostEstimator {
  readonly #pricing: AgentPricing;

  constructor(pricing: AgentPricing) {
    this.#pricing = pricing;
  }

  async estimate(input: CostInput): Promise<CostEstimate | undefined> {
    if (input.fn.decl.kind !== AGENT_KIND) return undefined;
    const payload = parseValue(LlmPayloadType, input.fn.decl.payload);
    const choice = ModelChoice.safeParse(payload.model);
    const wanted = choice.success && 'model' in choice.data ? choice.data.model : await this.#pricing.defaultModel();
    const model = (await this.#pricing.models()).find((m) => m.id === wanted || `${m.provider}/${m.id}` === wanted);
    const pricing = model?.pricing;
    if (pricing === undefined) return undefined;
    const tokens = await this.#pricing.tokens(wanted);
    const inputTokens = tokens.text(payload.instructions) + tokens.text(JSON.stringify(input.args ?? {}));
    // the most it may write: its payload's cap, else the model's, plus what a reasoning model thinks first
    const most = (payload.maxOutput ?? tokens.limits.maxOutputTokens) + tokens.limits.reasoningTokens;
    const price = (output: number): number => (inputTokens * pricing.input + output * pricing.output) / PER_TOKENS;
    return { min: price(0), typical: price(Math.min(TYPICAL_OUTPUT, most)), max: price(most), basis: 'payload', runs: 0 };
  }
}

/** A fn that declares a rough cost per run (`FnLimits.cost`) and has no history yet: that, as all three. */
export class DeclaredCostEstimator implements CostEstimator {
  estimate(input: CostInput): Promise<CostEstimate | undefined> {
    const cost = input.fn.decl.limits.cost;
    return Promise.resolve(cost === undefined ? undefined : { min: cost, typical: cost, max: cost, basis: 'payload', runs: 0 });
  }
}

/** How a kind's system is asked what a fn of the kind would cost (`estimate` on the system link); none when it can't answer. */
export interface KindEstimates {
  kind(name: QualifiedName): Promise<Pick<KindRecord, 'system' | 'decl'> | undefined>;
  ask(system: SystemName, request: KindEstimateRequest): Promise<KindEstimateAnswer | undefined>;
}

/**
 * Build 6: a fn of a kind that estimates (`KindDecl.estimates`, a saved query, a form) asks the kind's system, which
 * works the cost out from the payload and the call's args, blending in the history it is given. No answer, or no
 * estimate in it, leaves it to the estimators after.
 */
export class KindCostEstimator implements CostEstimator {
  readonly #kinds: KindEstimates;
  readonly #history = new HistoryCostEstimator();

  constructor(kinds: KindEstimates) {
    this.#kinds = kinds;
  }

  async estimate(input: CostInput): Promise<CostEstimate | undefined> {
    const { kind, payload } = input.fn.decl;
    if (kind === 'native') return undefined;
    const record = await this.#kinds.kind(kind);
    if (record?.decl.estimates !== true) return undefined;
    const history = await this.#history.estimate(input);
    const answer = await this.#kinds.ask(record.system, {
      kind, payload: payload ?? null, ...(input.args === undefined ? {} : { args: input.args }), ...(history === undefined ? {} : { history }),
    });
    return answer?.estimate;
  }
}

/** Anything else that spends and has no history. */
export class UnknownCostEstimator implements CostEstimator {
  estimate(input: CostInput): Promise<CostEstimate | undefined> {
    return Promise.resolve({ min: 0, typical: 0, max: 0, basis: 'unknown', runs: runsOf(input.history) });
  }
}

/** Ask each estimator in turn; the first answer wins (the last one always answers). */
export async function estimateCost(estimators: readonly CostEstimator[], input: CostInput): Promise<CostEstimate> {
  for (const estimator of estimators) {
    const estimate = await estimator.estimate(input);
    if (estimate !== undefined) return estimate;
  }
  return { min: 0, typical: 0, max: 0, basis: 'unknown', runs: runsOf(input.history) };
}
