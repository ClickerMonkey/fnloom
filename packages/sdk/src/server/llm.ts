/**
 * LLM calls from a system. Systems never call a provider: `HarnessProvider` is an aeye `Provider` whose one model,
 * `hub/auto`, forwards every request to the hub over the link (`HubLink.llm`). The hub picks the real model from the
 * forwarded `ModelChoice`, enforces budgets and records the interaction, then streams chunks back, with the schema
 * descriptors it chose (so strict tool arguments and outputs decode here) and the real cost.
 *
 * Every other modality (embeddings, images, transcription, speech) goes over the link's `model` endpoint through
 * `HubModels`, which the provider's aeye methods and `ctx.llm` share: the hub records each call as one `ModelCall`
 * attributed to the run, so nothing a system does reaches a provider any other way.
 *
 * `HubLlm` is `ctx.llm`: text, structured objects checked against a gin type and streams through an aeye `AI` built on
 * that provider, and the other modalities in core's shapes. System authors who want aeye prompts, tools, images or
 * speech in aeye's shapes use `harnessAi()` directly.
 */
import {
  AI, type AIContextAny, type EmbeddingRequest, type EmbeddingResponse, type ImageGenerationRequest, type ImageGenerationResponse, type ModelInfo, type Provider,
  type SpeechRequest, type SpeechResponse, type TranscriptionRequest, type TranscriptionResponse,
} from '@aeye/ai';
import { getResponseFromChunks, toFile, type AudioFormat, type Chunk, type Message, type Request, type Response } from '@aeye/core';
import { ModelChoice, type LlmForwardChunk, type LlmRequest, type ModelForward, type ModelForwardResult, type RunId } from '@harness/core';
import { z } from 'zod';
import type { ForwardModality, Llm, ModelInput, ModelOutput } from '../ctx.ts';
import type { GinType } from '../gin.ts';
import { HubContent, type ContentTransfer } from './content.ts';
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
  capabilities: new Set(['chat', 'streaming', 'tools', 'toolsStrict', 'structured', 'json', 'vision', 'files', 'reasoning', 'embedding', 'image', 'hearing', 'audio']),
  supportedParameters: new Set([
    'maxTokens', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'stop', 'seed', 'responseFormat', 'structuredOutput', 'tools',
    'toolChoice', 'toolsStrict', 'reason', 'verbosity', 'imageMultiple',
  ]),
  tier: 'flagship',
  pricing: {},
  contextWindow: 1_000_000,
};

/** aeye metadata a harness call carries: which model the hub should use. */
export interface HarnessMetadata {
  harness?: { model?: ModelChoice };
}

/** What a forwarding provider acts for: the hub, how content moves to it, and the run whose budget pays (absent outside runs). */
export interface HarnessProviderConfig {
  readonly hub: HubAccess;
  /** How audio goes up and images and speech come down by content ref. Default: over `hub`. */
  readonly content?: ContentTransfer;
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
  readonly #content: ContentTransfer;
  readonly #models: HubModels;

  constructor(config: HarnessProviderConfig) {
    this.config = config;
    this.#content = config.content ?? new HubContent(config.hub);
    this.#models = new HubModels(config);
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

  async embed(request: EmbeddingRequest, ctx?: AIContextAny): Promise<EmbeddingResponse> {
    const model = modelChoiceOf(ctx?.metadata);
    const { vectors, cost, model: served } = await this.#models.embed({ texts: request.texts, ...(model === undefined ? {} : { model }) }, ctx?.signal);
    return { embeddings: vectors.map((embedding, index) => ({ embedding, index })), model: served, usage: { cost } };
  }

  async generateImage(request: ImageGenerationRequest, ctx: AIContextAny): Promise<ImageGenerationResponse> {
    const model = modelChoiceOf(ctx.metadata);
    const made = await this.#models.image({
      prompt: request.prompt,
      ...(model === undefined ? {} : { model }),
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.n === undefined ? {} : { count: request.n }),
    }, ctx.signal);
    const images = await Promise.all(made.images.map(async (ref) => ({ b64_json: Buffer.from(await this.#content.download(ref, ctx.signal)).toString('base64') })));
    return { images, model: made.model, usage: { cost: made.cost } };
  }

  async transcribe(request: TranscriptionRequest, ctx: AIContextAny): Promise<TranscriptionResponse> {
    const model = modelChoiceOf(ctx.metadata);
    const file = await toFile(request.audio);
    const audio = await this.#content.upload(new Uint8Array(await file.arrayBuffer()), file.type === '' ? 'application/octet-stream' : file.type, ctx.signal);
    const heard = await this.#models.transcribe({
      audio,
      ...(model === undefined ? {} : { model }),
      ...(request.language === undefined ? {} : { language: request.language }),
    }, ctx.signal);
    return {
      text: heard.text,
      ...(heard.segments === undefined ? {} : { segments: heard.segments.map((segment, index) => ({ id: String(index), ...segment })) }),
      model: heard.model,
      usage: { cost: heard.cost },
    };
  }

  async speech(request: SpeechRequest, ctx: AIContextAny): Promise<SpeechResponse> {
    const model = modelChoiceOf(ctx.metadata);
    const format = request.responseFormat === undefined ? undefined : SPEECH_FORMATS[request.responseFormat];
    if (format === null) { throw new Error(`The hub speaks mp3, wav or ogg (opus), not ${request.responseFormat ?? ''}.`); }
    const spoken = await this.#models.speak({
      text: request.text,
      ...(model === undefined ? {} : { model }),
      ...(request.voice === undefined ? {} : { voice: request.voice }),
      ...(format === undefined ? {} : { format }),
    }, ctx.signal);
    const bytes = await this.#content.download(spoken.audio, ctx.signal);
    return {
      audio: new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(bytes); controller.close(); } }),
      ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
      model: spoken.model,
      usage: { cost: spoken.cost },
    };
  }
}

/** The audio formats the hub's `model` endpoint speaks, by aeye's format name; `null` for one it doesn't. */
const SPEECH_FORMATS = { mp3: 'mp3', wav: 'wav', opus: 'ogg', aac: null, flac: null, pcm: null } as const satisfies Record<AudioFormat, SpeechFormat | null>;

/** A speech format the `model` endpoint takes. */
type SpeechFormat = NonNullable<ModelInput<'speech'>['format']>;

/** Whether a forwarded call's result is of the modality asked for. */
function isModality<M extends ForwardModality>(result: ModelForwardResult, modality: M): result is Extract<ModelForwardResult, { modality: M }> {
  return result.modality === modality;
}

/**
 * Non-chat model calls over the link's `model` endpoint, on the run's budget: embeddings, images, transcription and
 * speech. The hub records each as one `ModelCall` and answers with its id and cost; large outputs come by content ref.
 */
export class HubModels {
  readonly #config: HarnessProviderConfig;

  constructor(config: HarnessProviderConfig) {
    this.#config = config;
  }

  embed(input: ModelInput<'embed'>, signal?: AbortSignal): Promise<ModelOutput<'embed'>> {
    return this.#send({ modality: 'embed', ...input }, signal);
  }

  image(input: ModelInput<'image'>, signal?: AbortSignal): Promise<ModelOutput<'image'>> {
    return this.#send({ modality: 'image', ...input }, signal);
  }

  transcribe(input: ModelInput<'transcribe'>, signal?: AbortSignal): Promise<ModelOutput<'transcribe'>> {
    return this.#send({ modality: 'transcribe', ...input }, signal);
  }

  speak(input: ModelInput<'speech'>, signal?: AbortSignal): Promise<ModelOutput<'speech'>> {
    return this.#send({ modality: 'speech', ...input }, signal);
  }

  async #send<M extends ForwardModality>(body: Extract<ModelForward, { modality: M }>, signal: AbortSignal | undefined): Promise<Extract<ModelForwardResult, { modality: M }>> {
    const hub = await this.#config.hub.ready(signal);
    const run = this.#config.run;
    const result = await hub.call('model', { ...body, ...(run === undefined ? {} : { run }) }, signal === undefined ? {} : { signal });
    if (!isModality(result, body.modality)) { throw new Error(`The hub answered a ${body.modality} call with ${result.modality}.`); }
    return result;
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
  readonly #models: HubModels;
  readonly #signal: AbortSignal | undefined;

  constructor(config: HarnessProviderConfig, signal?: AbortSignal) {
    this.#ai = harnessAi(config);
    this.#models = new HubModels(config);
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
    if (texts.length === 0) { return []; }
    return (await this.#models.embed({ texts }, this.#signal)).vectors;
  }

  image(input: ModelInput<'image'>): Promise<ModelOutput<'image'>> {
    return this.#models.image(input, this.#signal);
  }

  transcribe(input: ModelInput<'transcribe'>): Promise<ModelOutput<'transcribe'>> {
    return this.#models.transcribe(input, this.#signal);
  }

  speak(input: ModelInput<'speech'>): Promise<ModelOutput<'speech'>> {
    return this.#models.speak(input, this.#signal);
  }

  #signalOption(): { signal: AbortSignal } | {} {
    return this.#signal === undefined ? {} : { signal: this.#signal };
  }
}
