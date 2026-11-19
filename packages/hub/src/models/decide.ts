/**
 * The hub's own decisions by a decision model (`HubDecider`), and asking one more questions than it takes in a call.
 * A decision model may cap the questions per call (aeye's `ModelInfo.maxQuestions`; Ollama's System One models take
 * 64) and the bytes of input and questions per call (`ModelInfo.maxRequestBytes`; System One takes 64 KiB), and aeye
 * refuses a call over a cap without splitting it (`DecisionLimitError`). So every hub caller that asks questions
 * (suggestions, systems' `decide`, `context_crawl`) goes through `HubDecider.ask`, which splits them here, in order,
 * one call per batch, and gets every answer back by name. The model is the `decide` role's unless the job chose one,
 * and the role's threshold says how likely a yes/no answer must be to count as yes.
 */
import { DecisionLimitError, type DecisionAnswer, type DecisionQuestion, type DecisionRequest, type DecisionResponse } from '@aeye/ai';
import { DEFAULT_DECIDE_THRESHOLD, type ModelCallId, type RoleModel } from '@harness/core';
import { decisionInputFromWire } from '@harness/sdk/server';
import type { LlmGateway } from '../execution/index.ts';
import type { DecidedAnswers, Decider, DecisionModel, ModelRoles } from './index.ts';

/** What a batch of questions stays within: a model's caps (an absent cap is none). */
export type DecisionLimits = Pick<DecisionModel, 'maxQuestions' | 'maxRequestBytes'>;

/** UTF-8 bytes of a text. */
const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The bytes a call's input counts against `maxRequestBytes`: its text, or its conversation as JSON. Each question adds
 * its own (`questionBytes`). aeye has no shared measure (each provider counts its own wire form), so this is the input
 * and questions as the hub sends them; a provider that counts more still refuses the call.
 */
export function decisionInputBytes(input: DecisionRequest['input']): number {
  return bytesOf(typeof input === 'string' ? input : JSON.stringify(input));
}

/** The bytes one named question adds to a call: its entry in the questions object, with the comma between. */
function questionBytes(name: string, question: DecisionQuestion): number {
  return bytesOf(JSON.stringify({ [name]: question })) - 1;
}

/**
 * The questions in batches the model takes, in order: at most `maxQuestions` each, and at most `maxRequestBytes` of
 * input and questions each. One batch when the model has no cap. A question that can't fit beside the input even
 * alone is refused here with aeye's `DecisionLimitError`, as the model would refuse it.
 */
export function questionBatches(questions: Readonly<Record<string, DecisionQuestion>>, limits: DecisionLimits, inputBytes = 0, model = 'the decision model'): Record<string, DecisionQuestion>[] {
  const most = limits.maxQuestions === undefined || limits.maxQuestions < 1 ? Number.POSITIVE_INFINITY : Math.floor(limits.maxQuestions);
  const room = limits.maxRequestBytes === undefined ? Number.POSITIVE_INFINITY : limits.maxRequestBytes - inputBytes;
  const batches: Record<string, DecisionQuestion>[] = [];
  let batch: Array<[string, DecisionQuestion]> = [];
  // the braces of the questions object
  let bytes = 2;
  for (const [name, question] of Object.entries(questions)) {
    const size = questionBytes(name, question);
    if (batch.length > 0 && (batch.length >= most || bytes + size > room)) {
      batches.push(Object.fromEntries(batch));
      batch = [];
      bytes = 2;
    }
    if (bytes + size > room) { throw new DecisionLimitError(model, 'maxRequestBytes', limits.maxRequestBytes ?? 0, inputBytes + bytes + size); }
    batch.push([name, question]);
    bytes += size;
  }
  if (batch.length > 0) batches.push(Object.fromEntries(batch));
  return batches;
}

/** Every answer by question name, and each call's response (for usage and cost), in batch order. */
export interface BatchedDecision {
  readonly answers: Record<string, DecisionAnswer>;
  readonly responses: readonly DecisionResponse[];
}

/**
 * Ask `questions` about `input` in calls the model takes (`questionBatches`), one after another (a local decision
 * model answers one call at a time), through `ask` (an `ai.decide.get` with the caller's input, model and signal).
 */
export async function decideInBatches(
  questions: Readonly<Record<string, DecisionQuestion>>,
  limits: DecisionLimits & { readonly input: DecisionRequest['input']; readonly model?: string },
  ask: (batch: Record<string, DecisionQuestion>) => Promise<DecisionResponse>,
): Promise<BatchedDecision> {
  const answers: Record<string, DecisionAnswer> = {};
  const responses: DecisionResponse[] = [];
  for (const batch of questionBatches(questions, limits, decisionInputBytes(limits.input), limits.model)) {
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
    return {
      model: resolved.model, provider: resolved.provider, threshold,
      ...(info?.maxQuestions === undefined ? {} : { maxQuestions: info.maxQuestions }), ...(info?.maxRequestBytes === undefined ? {} : { maxRequestBytes: info.maxRequestBytes }),
    };
  }

  async ask(request: Parameters<Decider['ask']>[0]): Promise<DecidedAnswers> {
    const { input, questions, model, site, signal } = request;
    const calls: ModelCallId[] = [];
    let cost = 0;
    const metadata = { model: model.model, provider: model.provider };
    const wanted = decisionInputFromWire(input);
    const limits = { input: wanted, model: model.model, ...(model.maxQuestions === undefined ? {} : { maxQuestions: model.maxQuestions }), ...(model.maxRequestBytes === undefined ? {} : { maxRequestBytes: model.maxRequestBytes }) };
    const { answers } = await decideInBatches(questions, limits, async (batch) => {
      const out = await this.#deps.llm.decide({ input: wanted, questions: batch, metadata }, site, signal);
      calls.push(out.call);
      cost += out.cost;
      return out.value;
    });
    return { answers, calls, cost };
  }
}
