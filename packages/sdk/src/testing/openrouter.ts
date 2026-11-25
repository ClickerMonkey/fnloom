/**
 * A real model for tests: what the hub's LLM gateway does with a forwarded chat request (rebuild its JSON schemas as
 * `a` schemas, stream it from a provider that plans them for its model, decode the answers through that plan, then
 * the cost), done here on a
 * free OpenRouter model. `OpenRouterModelLink` is a `ModelLink`, so `ctx.ai()` in a test hub and `hubAiOf` both run
 * on it. The free models are tried in order; one that fails before its first chunk (busy, rate limited) gives way to
 * the next.
 */
import { AI } from '@aeye/ai';
import type { Request } from '@aeye/core';
import { models, strictSupport } from '@aeye/models';
import { OpenRouterProvider } from '@aeye/openrouter';
import { mintId, type HubModelInfo, type LlmForward, type LlmForwardChunk, type ModelForward, type ModelForwardResult } from '@harness/core';
import type { ModelLink } from '../server/llm.ts';
import { AnswerDecoder, chunkToWire, requestFromWire } from '../server/llm-wire.ts';

/** A forwarded request as an aeye request: the gateway's own rebuild, so a test model gets exactly the schemas the hub sends. */
function aeyeRequest(forward: LlmForward, maxTokens: number | undefined): Request {
  const request = requestFromWire(forward.request);
  // as the hub's gateway: the request's own cap, else this link's, else none (a reasoning model spends output tokens
  // thinking, so a fixed small cap cut authoring replies off mid-draft)
  const cap = forward.request.maxTokens ?? maxTokens;
  return cap === undefined ? request : { ...request, maxTokens: cap };
}

/** How an `OpenRouterModelLink` calls. */
export interface OpenRouterOptions {
  /** The OpenRouter key. */
  readonly key: string;
  /** The models to try, first choice first (OpenRouter ids, e.g. `vendor/model:free`). */
  readonly models: readonly string[];
  /** The most tokens one reply may have when the request sets none (default: no cap, as the hub's gateway). */
  readonly maxTokens?: number;
}

/** A `ModelLink` that runs forwarded chat requests on free OpenRouter models. Only chat: other modalities are refused. */
export class OpenRouterModelLink implements ModelLink {
  /** Every chat forward, in order. */
  readonly forwards: LlmForward[] = [];
  /** The model that answered each forward, in order. */
  readonly answeredBy: string[] = [];
  readonly #ai;
  readonly #options: OpenRouterOptions;

  constructor(options: OpenRouterOptions) {
    if (options.models.length === 0) { throw new Error('OpenRouterModelLink needs at least one model.'); }
    this.#options = options;
    const openrouter = new OpenRouterProvider({ apiKey: options.key });
    this.#ai = AI.with().providers({ openrouter }).create({ models, modelOverrides: [...strictSupport] });
  }

  async *llm(forward: LlmForward, signal?: AbortSignal): AsyncGenerator<LlmForwardChunk> {
    this.forwards.push(forward);
    const request = aeyeRequest(forward, this.#options.maxTokens);
    const failures: string[] = [];
    for (const model of this.#options.models) {
      let started = false;
      const decoder = new AnswerDecoder(request);
      try {
        let usage = { input: 0, output: 0 };
        let cost = 0;
        for await (const chunk of this.#ai.chat.stream(request, { metadata: { model: `openrouter/${model}` }, ...(signal === undefined ? {} : { signal }) })) {
          started = true;
          if (chunk.usage !== undefined) {
            usage = { input: chunk.usage.text?.input ?? usage.input, output: chunk.usage.text?.output ?? usage.output };
            cost = chunk.usage.cost ?? cost;
          }
          for (const out of decoder.chunk(chunk)) { yield { type: 'chunk', chunk: chunkToWire(out) }; }
        }
        for (const out of decoder.end()) { yield { type: 'chunk', chunk: chunkToWire(out) }; }
        this.answeredBy.push(model);
        yield { type: 'done', usage, cost, interaction: mintId('llmInteraction'), model };
        return;
      } catch (error) {
        // a model that already streamed can't be swapped mid-reply
        if (started) { throw error; }
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No OpenRouter model answered:\n${failures.join('\n')}`);
  }

  model(forward: ModelForward): Promise<ModelForwardResult> {
    return Promise.reject(new Error(`The OpenRouter test link answers chat only, not ${forward.modality}.`));
  }

  models(): Promise<HubModelInfo[]> {
    return Promise.resolve([]);
  }

  connected(): boolean {
    return true;
  }
}
