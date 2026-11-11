/**
 * A real model for tests: what the hub's LLM gateway does with a forwarded chat request (rebuild its JSON schemas as
 * zod, stream it from a provider, send back the descriptors it used, then the chunks and the cost), done here on a
 * free OpenRouter model. `OpenRouterModelLink` is a `ModelLink`, so `ctx.ai()` in a test hub and `hubAiOf` both run
 * on it. The free models are tried in order; one that fails before its first chunk (busy, rate limited) gives way to
 * the next.
 */
import { AI } from '@aeye/ai';
import type { Chunk, Message, Request } from '@aeye/core';
import { models, strictSupport } from '@aeye/models';
import { OpenRouterProvider } from '@aeye/openrouter';
import { mintId, type HubModelInfo, type Json, type LlmChunk, type LlmForward, type LlmForwardChunk, type ModelForward, type ModelForwardResult } from '@harness/core';
import { z } from 'zod';
import type { ModelLink } from '../server/llm.ts';

/** A forwarded JSON schema as zod again, wrapped when it isn't an object (tool parameters must be). */
function objectSchema(json: Json): z.ZodType<object, object> {
  const schema = z.fromJSONSchema(Object.fromEntries(Object.entries(typeof json === 'object' && json !== null && !Array.isArray(json) ? json : {})));
  return schema instanceof z.ZodObject ? schema : z.object({ value: schema });
}

/** A forwarded message as aeye's. */
function aeyeMessage(message: LlmForward['request']['messages'][number]): Message {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map((p) => ({ type: p.type, content: p.content })),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  };
}

/** An aeye chunk as the link's. */
function wireChunk(chunk: Chunk): LlmChunk {
  return {
    ...(chunk.content === undefined ? {} : { content: chunk.content }),
    ...(chunk.toolCallNamed === undefined ? {} : { toolCallNamed: chunk.toolCallNamed }),
    ...(chunk.toolCallArguments === undefined ? {} : { toolCallArguments: chunk.toolCallArguments }),
    ...(chunk.toolCall === undefined ? {} : { toolCall: chunk.toolCall }),
    ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
  };
}

/** A forwarded request as an aeye request. */
function aeyeRequest(forward: LlmForward, maxTokens: number): Request {
  const format = forward.request.responseFormat;
  return {
    messages: forward.request.messages.map(aeyeMessage),
    maxTokens,
    ...(forward.request.tools === undefined ? {} : {
      tools: forward.request.tools.map((t) => ({ name: t.name, parameters: objectSchema(t.parameters), ...(t.description === undefined ? {} : { description: t.description }), ...(t.strict === undefined ? {} : { strict: t.strict }) })),
    }),
    ...(format === undefined || typeof format === 'string' ? {} : { responseFormat: { type: objectSchema(format.schema), strict: format.strict } }),
  };
}

/** How an `OpenRouterModelLink` calls. */
export interface OpenRouterOptions {
  /** The OpenRouter key. */
  readonly key: string;
  /** The models to try, first choice first (OpenRouter ids, e.g. `vendor/model:free`). */
  readonly models: readonly string[];
  /** The most tokens one reply may have (default 2000). */
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
    const request = aeyeRequest(forward, this.#options.maxTokens ?? 2_000);
    const failures: string[] = [];
    for (const model of this.#options.models) {
      let started = false;
      try {
        let usage = { input: 0, output: 0 };
        let cost = 0;
        for await (const chunk of this.#ai.chat.stream(request, { metadata: { model: `openrouter/${model}` }, ...(signal === undefined ? {} : { signal }) })) {
          if (!started) {
            started = true;
            const tools = Object.fromEntries((request.tools ?? []).flatMap((t) => (t.descriptor === undefined ? [] : [[t.name, t.descriptor]])));
            const output = typeof request.responseFormat === 'object' ? request.responseFormat.descriptor : undefined;
            yield { type: 'descriptors', tools, ...(output === undefined ? {} : { output }) };
          }
          if (chunk.usage !== undefined) {
            usage = { input: chunk.usage.text?.input ?? usage.input, output: chunk.usage.text?.output ?? usage.output };
            cost = chunk.usage.cost ?? cost;
          }
          yield { type: 'chunk', chunk: wireChunk(chunk) };
        }
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
