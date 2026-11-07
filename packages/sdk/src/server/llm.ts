/**
 * LLM calls from a system. Systems never call a provider: `HarnessProvider` is an aeye `Provider` whose one model,
 * `hub/auto`, forwards every request to the hub over the link (`HubLink.llm`). The hub picks the real model from the
 * forwarded `ModelChoice`, enforces budgets and records the interaction, then streams chunks back, with the schema
 * descriptors it chose (so strict tool arguments and outputs decode here) and the real cost.
 *
 * `HubLlm` is `ctx.llm`: text, structured objects checked against a gin type, streams and embeddings, all through an
 * aeye `AI` built on that provider. System authors who want aeye prompts and tools use `harnessAi()` directly.
 */
import { AI, type EmbeddingRequest, type EmbeddingResponse, type ModelInfo, type Provider } from '@aeye/ai';
import { getResponseFromChunks, type Chunk, type Message, type Request, type Response } from '@aeye/core';
import { ModelChoice, type LlmForwardChunk, type LlmRequest, type RunId } from '@harness/core';
import { z } from 'zod';
import type { Llm } from '../ctx.ts';
import type { GinType } from '../gin.ts';
import type { HubAccess } from './link.ts';
import { applyDescriptors, chunkFromWire, LlmWire, usageFromWire } from './llm-wire.ts';
import { decodeOrThrow } from './wire.ts';

/** The provider key and the one model the system-side registry knows. */
export const HUB_PROVIDER = 'hub';
export const HUB_MODEL_ID = 'auto';

/**
 * The system-side stand-in for whatever model the hub picks: every chat capability and parameter (strict tools
 * included), so the system's registry never filters; no price; and no strict dialect, because the hub strictifies for
 * the model it picks and sends back the descriptors it used.
 */
export const HUB_MODEL: ModelInfo = {
  id: HUB_MODEL_ID,
  provider: HUB_PROVIDER,
  name: 'Chosen by the hub',
  capabilities: new Set(['chat', 'streaming', 'tools', 'toolsStrict', 'structured', 'json', 'vision', 'files', 'reasoning', 'embedding']),
  supportedParameters: new Set([
    'maxTokens', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'stop', 'seed', 'responseFormat', 'structuredOutput', 'tools',
    'toolChoice', 'toolsStrict', 'reason', 'verbosity',
  ]),
  tier: 'flagship',
  pricing: {},
  contextWindow: 1_000_000,
};

/** aeye metadata a harness call carries: which model the hub should use. */
export interface HarnessMetadata {
  harness?: { model?: ModelChoice };
}

/** What a forwarding provider acts for: the hub, and the run whose budget pays (absent outside runs). */
export interface HarnessProviderConfig {
  readonly hub: HubAccess;
  readonly run?: RunId;
}

/** An LLM forward failed on the hub. `kind` says whose fault: the model, a tool, a budget limit or the provider. */
export class HubLlmError extends Error {
  override readonly name = 'HubLlmError';
  readonly kind: Extract<LlmForwardChunk, { type: 'error' }>['kind'];
  constructor(message: string, kind: Extract<LlmForwardChunk, { type: 'error' }>['kind']) {
    super(message);
    this.kind = kind;
  }
}

const HarnessMetadataSchema = z.object({ harness: z.object({ model: ModelChoice.optional() }).optional() });

/** The model choice in a call's metadata, if any. */
function modelChoiceOf(metadata: unknown): ModelChoice | undefined {
  const parsed = HarnessMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.harness?.model : undefined;
}

/**
 * Requests a system forwards: anything the wire can't carry is refused, because the hub would otherwise send the
 * model something other than what the system asked.
 */
const forwardWire = new LlmWire({ unrepresentable: 'refuse' });

/** An aeye request as it is forwarded to the hub. */
export function wireRequest(request: Request): LlmRequest {
  return forwardWire.request(request);
}

/** The aeye provider that forwards to the hub. */
export class HarnessProvider implements Provider<HarnessProviderConfig> {
  readonly name = HUB_PROVIDER;
  readonly config: HarnessProviderConfig;

  constructor(config: HarnessProviderConfig) {
    this.config = config;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([HUB_MODEL]);
  }

  checkHealth(): Promise<boolean> {
    return Promise.resolve(this.config.hub.now() !== undefined);
  }

  /** Stream one request through the hub. */
  async *forward(request: Request, model: ModelChoice | undefined, signal?: AbortSignal): AsyncGenerator<Chunk, Response> {
    const hub = await this.config.hub.ready(signal);
    const forward = {
      request: wireRequest(request),
      stream: true,
      ...(this.config.run === undefined ? {} : { run: this.config.run }),
      ...(model === undefined ? {} : { model }),
    };
    const chunks: Chunk[] = [];
    let served = 'hub';
    for await (const item of hub.call('llm', forward, signal === undefined ? {} : { signal })) {
      switch (item.type) {
        case 'descriptors': applyDescriptors(request, item); break;
        case 'chunk': {
          const chunk = chunkFromWire(item.chunk);
          chunks.push(chunk);
          yield chunk;
          break;
        }
        case 'done': {
          served = item.model;
          const last: Chunk = { usage: usageFromWire(item.usage, item.cost), model: item.model };
          chunks.push(last);
          yield last;
          break;
        }
        case 'error': throw new HubLlmError(item.message, item.kind);
      }
    }
    return getResponseFromChunks(chunks, served);
  }

  createStreamer() {
    return <C, M>(request: Request, _context: C, metadata?: M, signal?: AbortSignal): AsyncGenerator<Chunk, Response> =>
      this.forward(request, modelChoiceOf(metadata), signal);
  }

  createExecutor() {
    return async <C, M>(request: Request, _context: C, metadata?: M, signal?: AbortSignal): Promise<Response> => {
      const stream = this.forward(request, modelChoiceOf(metadata), signal);
      for (;;) {
        const next = await stream.next();
        if (next.done === true) { return next.value; }
      }
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const hub = await this.config.hub.ready();
    const { vectors, cost } = await hub.call('embed', { texts: request.texts, ...(this.config.run === undefined ? {} : { run: this.config.run }) });
    return { embeddings: vectors.map((embedding, index) => ({ embedding, index })), model: `${HUB_PROVIDER}/${HUB_MODEL_ID}`, usage: { cost } };
  }
}

/** An aeye `AI` whose only provider is the hub. Use it for aeye prompts, tools and agents inside a system. */
export function harnessAi(config: HarnessProviderConfig) {
  return AI.with<{}, HarnessMetadata>().providers({ [HUB_PROVIDER]: new HarnessProvider(config) }).create({ models: [HUB_MODEL] });
}

/** The aeye `AI` a system gets: `ctx.llm.ai`. */
export type HarnessAi = ReturnType<typeof harnessAi>;

function conversation(input: { prompt: string; system?: string }): Message[] {
  return [...(input.system === undefined ? [] : [{ role: 'system' as const, content: input.system }]), { role: 'user', content: input.prompt }];
}

function metadataFor(model: ModelChoice | undefined): { metadata: HarnessMetadata } | {} {
  return model === undefined ? {} : { metadata: { harness: { model } } };
}

/**
 * The aeye `AI` behind a context's `llm`, for aeye prompts, tools and agents inside a run: `harnessAiOf(ctx.llm).prompt(...)`.
 * Its calls go through the hub on the same budget as the rest of `ctx.llm`. Throws for an `Llm` that isn't the
 * runtime's (a test fake).
 */
export function harnessAiOf(llm: Llm): HarnessAi {
  if (llm instanceof HubLlm) { return llm.ai; }
  throw new Error('This Llm does not reach the hub (is it a test fake?), so it has no aeye AI.');
}

/** `ctx.llm`: LLM calls through the hub, counted against the run's budget. */
export class HubLlm implements Llm {
  readonly #ai: HarnessAi;
  readonly #signal: AbortSignal | undefined;

  constructor(config: HarnessProviderConfig, signal?: AbortSignal) {
    this.#ai = harnessAi(config);
    this.#signal = signal;
  }

  get ai(): HarnessAi {
    return this.#ai;
  }

  async text(input: { prompt: string; system?: string; model?: ModelChoice }): Promise<string> {
    const response = await this.#ai.chat.get({ messages: conversation(input) }, { ...metadataFor(input.model), ...this.#signalOption() });
    return response.content;
  }

  async object<T>(input: { prompt: string; output: GinType<T>; system?: string; model?: ModelChoice }): Promise<T> {
    const schema = input.output.toValueSchema();
    const response = await this.#ai.chat.get(
      { messages: conversation(input), responseFormat: { type: z.object({ value: schema }), strict: true } },
      { ...metadataFor(input.model), ...this.#signalOption() },
    );
    const parsed = z.object({ value: z.unknown() }).parse(JSON.parse(response.content));
    return decodeOrThrow(input.output, parsed.value, 'The model\'s answer');
  }

  async *stream(input: { prompt: string; system?: string; model?: ModelChoice }): AsyncIterable<string> {
    for await (const chunk of this.#ai.chat.stream({ messages: conversation(input) }, { ...metadataFor(input.model), ...this.#signalOption() })) {
      if (chunk.content !== undefined && chunk.content !== '') { yield chunk.content; }
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.#ai.embed.get({ texts });
    return response.embeddings.sort((a, b) => a.index - b.index).map((e) => e.embedding);
  }

  #signalOption(): { signal: AbortSignal } | {} {
    return this.#signal === undefined ? {} : { signal: this.#signal };
  }
}
