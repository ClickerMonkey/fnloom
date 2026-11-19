/**
 * The hub's own decisions by a decision model (`HubDecider`), and asking one more questions than it takes in a call.
 * A decision model may cap the questions per call (aeye's `ModelInfo.maxQuestions`; Ollama's System One models take
 * 64), and aeye refuses a call over the cap without splitting it (`DecisionLimitError`). So every hub caller that asks
 * questions (suggestions, systems' `decide`, `context_crawl`) goes through `HubDecider.ask`, which splits them here, in
 * order, one call per batch, and gets every answer back by name. The model is the `decide` role's unless the job chose
 * one, and the role's threshold says how likely a yes/no answer must be to count as yes.
 */
import type { DecisionAnswer, DecisionQuestion, DecisionResponse } from '@aeye/ai';
import { DEFAULT_DECIDE_THRESHOLD, type ModelCallId, type RoleModel } from '@harness/core';
import { decisionInputFromWire } from '@harness/sdk/server';
import type { LlmGateway } from '../execution/index.ts';
import type { DecidedAnswers, Decider, DecisionModel, ModelRoles } from './index.ts';

/** The questions in batches of at most `maxQuestions`, in order; one batch when the model has no cap. */
export function questionBatches(questions: Readonly<Record<string, DecisionQuestion>>, maxQuestions: number | undefined): Record<string, DecisionQuestion>[] {
  const entries = Object.entries(questions);
  const size = maxQuestions === undefined || maxQuestions < 1 ? Math.max(entries.length, 1) : Math.floor(maxQuestions);
  const batches: Record<string, DecisionQuestion>[] = [];
  for (let start = 0; start < entries.length; start += size) batches.push(Object.fromEntries(entries.slice(start, start + size)));
  return batches;
}

/** Every answer by question name, and each call's response (for usage and cost), in batch order. */
export interface BatchedDecision {
  readonly answers: Record<string, DecisionAnswer>;
  readonly responses: readonly DecisionResponse[];
}

/**
 * Ask `questions` in calls of at most `maxQuestions`, one after another (a local decision model answers one call at a
 * time), through `ask` (an `ai.decide.get` with the caller's input, model and signal).
 */
export async function decideInBatches(
  questions: Readonly<Record<string, DecisionQuestion>>,
  maxQuestions: number | undefined,
  ask: (batch: Record<string, DecisionQuestion>) => Promise<DecisionResponse>,
): Promise<BatchedDecision> {
  const answers: Record<string, DecisionAnswer> = {};
  const responses: DecisionResponse[] = [];
  for (const batch of questionBatches(questions, maxQuestions)) {
    const response = await ask(batch);
    responses.push(response);
    Object.assign(answers, response.answers);
  }
  return { answers, responses };
}

/** What the decider uses: the roles (the `decide` role and a job's own choice) and the gateway that makes the calls. */
export interface HubDeciderDeps {
  readonly roles: Pick<ModelRoles, 'get' | 'resolveModel'>;
  readonly llm: Pick<LlmGateway, 'decide' | 'models'>;
}

/** The hub's decisions, through the execution module's gateway: budgeted, rate-limited and recorded per call. */
export class HubDecider implements Decider {
  readonly #deps: HubDeciderDeps;

  constructor(deps: HubDeciderDeps) {
    this.#deps = deps;
  }

  async model(choice?: RoleModel): Promise<DecisionModel | { readonly problem: string }> {
    const { roles, llm } = this.#deps;
    const view = await roles.get('decide');
    const threshold = view.choice?.role === 'decide' ? view.choice.threshold : DEFAULT_DECIDE_THRESHOLD;
    const resolved = choice === undefined ? view.resolved : await roles.resolveModel('decide', choice);
    if (resolved === undefined) return { problem: 'No decision model is set (an admin sets the Decide role).' };
    if ('problem' in resolved) return resolved;
    const info = (await llm.models()).find((model) => model.provider === resolved.provider && model.id === resolved.model);
    return { model: resolved.model, provider: resolved.provider, threshold, ...(info?.maxQuestions === undefined ? {} : { maxQuestions: info.maxQuestions }) };
  }

  async ask(request: Parameters<Decider['ask']>[0]): Promise<DecidedAnswers> {
    const { input, questions, model, site, signal } = request;
    const calls: ModelCallId[] = [];
    let cost = 0;
    const metadata = { model: model.model, provider: model.provider };
    const { answers } = await decideInBatches(questions, model.maxQuestions, async (batch) => {
      const out = await this.#deps.llm.decide({ input: decisionInputFromWire(input), questions: batch, metadata }, site, signal);
      calls.push(out.call);
      cost += out.cost;
      return out.value;
    });
    return { answers, calls, cost };
  }
}
