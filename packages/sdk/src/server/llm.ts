/**
 * LLM calls from a system. Systems never call a provider: `HarnessProvider` is an aeye `Provider` that forwards every
 * request to the hub over the link (`HubLink.llm`). Its models are the hub's real ones (`models` on the link: the
 * models the system may use, with their capabilities, prices and limits), plus one per hub role (`role/chat`), so
 * aeye's own selection, capability checks, tools, structured output and agents work unchanged. The model aeye picks
 * (or the one a call names) goes to the hub, which still decides access and budgets, records the interaction and
 * streams chunks back, with the schema descriptors it chose (so strict tool arguments and outputs decode here) and the
 * real cost. `hub/auto` (`HUB_MODEL`) leaves the choice to the hub.
 *
 * Every other modality (embeddings, images, transcription, speech) goes over the link's `model` endpoint through
 * `HubModels`, which the provider's aeye methods and `ctx.llm` share: the hub records each call as one `ModelCall`
 * attributed to the run, so nothing a system does reaches a provider any other way.
 *
 * `HubLlm` is `ctx.llm`: text, structured objects checked against a gin type and streams through an aeye `AI` built on
 * that provider, and the other modalities in core's shapes. System authors who want aeye prompts, tools, images or
 * speech in aeye's shapes use `ctx.ai()` (in any context) or `hubAi(system)` (anywhere in the process).
 */
import {
  AI, type AIContextAny, type EmbeddingRequest, type EmbeddingResponse, type ImageGenerationRequest, type ImageGenerationResponse, type ModelCapability,
  type ModelInfo, type Provider,
  type SpeechRequest, type SpeechResponse, type TranscriptionRequest, type TranscriptionResponse,
} from '@aeye/ai';
import { getResponseFromChunks, schemaRejection, toFile, type AudioFormat, type Chunk, type Message, type Request, type Response } from '@aeye/core';
import { ModelChoice, type HubModelInfo, type LlmForward, type LlmForwardChunk, type LlmRequest, type ModelForward, type ModelForwardResult, type RunId } from '@harness/core';
import { z } from 'zod';
import type { ForwardModality, Llm, ModelInput, ModelOutput } from '../ctx.ts';
import type { GinType } from '../gin.ts';
import { HubContent, type ContentTransfer } from './content.ts';
import type { HubAccess } from './link.ts';
import { applyDescriptors, chunkFromWire, LlmWire, usageFromWire } from './llm-wire.ts';
import { decodeOrThrow } from './wire.ts';
import { expectType, type Equal } from '../util.ts';

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

/** Every capability name aeye knows; the `expectType` below fails to compile when aeye adds one this list lacks. */
const AEYE_CAPABILITIES = [
  'chat', 'tools', 'vision', 'files', 'videoInput', 'json', 'structured', 'streaming', 'reasoning', 'image', 'audio', 'hearing', 'embedding', 'rerank',
  'decision', 'zdr', 'toolsStrict',
] as const satisfies readonly ModelCapability[];
expectType<Equal<(typeof AEYE_CAPABILITIES)[number], ModelCapability>>(true);
const CAPABILITY_NAMES: ReadonlySet<string> = new Set(AEYE_CAPABILITIES);

/** Whether a capability word from the hub is one of aeye's. */
function isCapability(name: string): name is ModelCapability {
  return CAPABILITY_NAMES.has(name);
}

/** The aeye model id of a hub model: its id under its provider (`openrouter/meta-llama/llama-3.2-3b-instruct`), which the hub reads (`namesModel`). */
export function hubModelId(model: Pick<HubModelInfo, 'id' | 'provider'>): string {
  return `${model.provider}/${model.id}`;
}

/** The aeye model id that stands for a hub role (`role/chat`): the model the admin set for it. */
export function roleModelId(role: string): string {
  return `role/${role}`;
}

/**
 * A hub model as aeye's registry sees it: under the hub provider, with aeye's capability names (others dropped), its
 * price per million tokens, its tier and its limits. `id` and `name` override its own (a role's stand-in).
 */
export function aeyeModelOf(model: HubModelInfo, id: string = hubModelId(model), name: string = model.name): ModelInfo {
  return {
    id,
    provider: HUB_PROVIDER,
    name,
    capabilities: new Set(model.capabilities.filter(isCapability)),
    tier: model.tier,
    pricing: model.pricing === undefined ? {} : { text: { input: model.pricing.input, output: model.pricing.output } },
    contextWindow: model.contextWindow ?? 0,
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  };
}

/**
 * What a forwarding provider sends model calls over: the hub link (`HubModelLink`), or a fake in tests
 * (`FakeModelLink` in `@harness/sdk/server/testing`).
 */
export interface ModelLink {
  /** Stream one chat request through the hub. */
  llm(forward: LlmForward, signal?: AbortSignal): AsyncIterable<LlmForwardChunk>;
  /** One non-chat call (embeddings, images, transcription, speech). */
  model(forward: ModelForward, signal?: AbortSignal): Promise<ModelForwardResult>;
  /** The models (and the roles they fill) this system may use. */
  models(signal?: AbortSignal): Promise<HubModelInfo[]>;
  /** Whether the hub can be reached right now. */
  connected(): boolean;
}

/** The model link over the system's hub connection. */
export class HubModelLink implements ModelLink {
  readonly #hub: HubAccess;

  constructor(hub: HubAccess) {
    this.#hub = hub;
  }

  async *llm(forward: LlmForward, signal?: AbortSignal): AsyncIterable<LlmForwardChunk> {
    const hub = await this.#hub.ready(signal);
    yield* hub.call('llm', forward, signal === undefined ? {} : { signal });
  }

  async model(forward: ModelForward, signal?: AbortSignal): Promise<ModelForwardResult> {
    const hub = await this.#hub.ready(signal);
    return hub.call('model', forward, signal === undefined ? {} : { signal });
  }

  async models(signal?: AbortSignal): Promise<HubModelInfo[]> {
    const hub = await this.#hub.ready(signal);
    return hub.call('models', {}, signal === undefined ? {} : { signal });
  }

  connected(): boolean {
    return this.#hub.now() !== undefined;
  }
}

/** aeye metadata a harness call carries: which model the hub should use. */
export interface HarnessMetadata {
  harness?: { model?: ModelChoice };
}

/**
 * What a forwarding provider acts for: the hub (or a `ModelLink` standing in for it), how content moves to it, and the
 * run whose budget pays. Outside a run the system's own budget and limits pay, and the call is recorded as the system's.
 */
export interface HarnessProviderConfig {
  readonly hub: HubAccess | ModelLink;
  /** How audio goes up and images and speech come down by content ref. Default: over `hub` (none over a bare `ModelLink`). */
  readonly content?: ContentTransfer;
  readonly run?: RunId;
}

/** Whether a config's hub is a model link already. */
function isModelLink(hub: HubAccess | ModelLink): hub is ModelLink {
  return 'llm' in hub;
}

/** The model link of a config. */
function modelLinkOf(config: HarnessProviderConfig): ModelLink {
  return isModelLink(config.hub) ? config.hub : new HubModelLink(config.hub);
}

const NO_CONTENT_MESSAGE = 'This model link moves no content: give the provider a content transfer.';

/** Content transfer for a model link that was given none. */
const NO_CONTENT: ContentTransfer = {
  upload: () => Promise.reject(new Error(NO_CONTENT_MESSAGE)),
  download: () => Promise.reject(new Error(NO_CONTENT_MESSAGE)),
};

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

/** The model aeye selected for a call (it puts the selected `ModelInfo` in the call's metadata): its id and provider. */
function selectedModelOf(metadata: unknown): { id: string; provider: string } | undefined {
  if (typeof metadata !== 'object' || metadata === null || !('model' in metadata)) { return undefined; }
  const model: unknown = metadata.model;
  if (typeof model !== 'object' || model === null || !('id' in model) || !('provider' in model)) { return undefined; }
  const { id, provider } = model;
  return typeof id === 'string' && typeof provider === 'string' ? { id, provider } : undefined;
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
  readonly #link: ModelLink;
  readonly #content: ContentTransfer;
  readonly #models: HubModels;
  /** The hub model each aeye id stands for (`role/chat` → the role's model), from the last `listModels`. */
  readonly #names = new Map<string, string>();

  constructor(config: HarnessProviderConfig) {
    this.config = config;
    this.#link = modelLinkOf(config);
    this.#content = config.content ?? (isModelLink(config.hub) ? NO_CONTENT : new HubContent(config.hub));
    this.#models = new HubModels(this.#link, config.run);
  }

  /**
   * The hub's models this system may use, as aeye models, and a stand-in for each role they fill (`role/chat`). Just
   * `hub/auto` when the hub lists none, so a call still reaches the hub, which then picks.
   */
  async listModels(): Promise<ModelInfo[]> {
    const listed = await this.#link.models();
    this.#names.clear();
    const models: ModelInfo[] = [];
    for (const model of listed) {
      const id = hubModelId(model);
      this.#names.set(id, id);
      models.push(aeyeModelOf(model));
      for (const role of model.roles) {
        this.#names.set(roleModelId(role), id);
        models.push(aeyeModelOf(model, roleModelId(role), `${model.name} (the ${role} role)`));
      }
    }
    return models.length === 0 ? [HUB_MODEL] : models;
  }

  checkHealth(): Promise<boolean> {
    return Promise.resolve(this.#link.connected());
  }

  /**
   * The model choice a call forwards: the one its harness metadata names, else the model aeye selected (a role's
   * stand-in becomes the role's model), else none (`hub/auto`: the hub picks).
   */
  choiceFor(metadata: unknown): ModelChoice | undefined {
    const named = modelChoiceOf(metadata);
    if (named !== undefined) { return named; }
    const selected = selectedModelOf(metadata);
    if (selected === undefined || selected.provider !== HUB_PROVIDER || selected.id === HUB_MODEL_ID) { return undefined; }
    return { model: this.#names.get(selected.id) ?? selected.id };
  }

  /** Stream one request through the hub. */
  async *forward(request: Request, model: ModelChoice | undefined, signal?: AbortSignal): AsyncGenerator<Chunk, Response> {
    const forward = {
      request: wireRequest(request),
      stream: true,
      ...(this.config.run === undefined ? {} : { run: this.config.run }),
      ...(model === undefined ? {} : { model }),
    };
    const chunks: Chunk[] = [];
    let served = 'hub';
    for await (const item of this.#link.llm(forward, signal)) {
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
        case 'error': {
          const error = new HubLlmError(item.message, item.kind);
          // a provider that refused a tool or output schema (OpenAI's strict mode): thrown as aeye's own rejection, so
          // the prompt steps down its schema fallbacks (strict, then not) as it would calling the provider itself
          throw schemaRejection(request, error) ?? error;
        }
      }
    }
    return getResponseFromChunks(chunks, served);
  }

  createStreamer() {
    return <C, M>(request: Request, _context: C, metadata?: M, signal?: AbortSignal): AsyncGenerator<Chunk, Response> =>
      this.forward(request, this.choiceFor(metadata), signal);
  }

  createExecutor() {
    return async <C, M>(request: Request, _context: C, metadata?: M, signal?: AbortSignal): Promise<Response> => {
      const stream = this.forward(request, this.choiceFor(metadata), signal);
      for (;;) {
        const next = await stream.next();
        if (next.done === true) { return next.value; }
      }
    };
  }

  async embed(request: EmbeddingRequest, ctx?: AIContextAny): Promise<EmbeddingResponse> {
    const model = this.choiceFor(ctx?.metadata);
    const { vectors, cost, model: served } = await this.#models.embed({ texts: request.texts, ...(model === undefined ? {} : { model }) }, ctx?.signal);
    return { embeddings: vectors.map((embedding, index) => ({ embedding, index })), model: served, usage: { cost } };
  }

  async generateImage(request: ImageGenerationRequest, ctx: AIContextAny): Promise<ImageGenerationResponse> {
    const model = this.choiceFor(ctx.metadata);
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
    const model = this.choiceFor(ctx.metadata);
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
    const model = this.choiceFor(ctx.metadata);
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
  readonly #link: ModelLink;
  readonly #run: RunId | undefined;

  constructor(link: ModelLink, run?: RunId) {
    this.#link = link;
    this.#run = run;
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
    const run = this.#run;
    const result = await this.#link.model({ ...body, ...(run === undefined ? {} : { run }) }, signal);
    if (!isModality(result, body.modality)) { throw new Error(`The hub answered a ${body.modality} call with ${result.modality}.`); }
    return result;
  }
}

/**
 * An aeye `AI` whose only provider is the hub, before its models are listed: only calls that name a model (or pass
 * `HUB_MODEL`) resolve. `hubAiOf` lists them; `ctx.ai()` and `hubAi(system)` give an `AI` that is ready.
 */
export function harnessAi(config: HarnessProviderConfig) {
  return AI.with<{}, HarnessMetadata>().providers({ [HUB_PROVIDER]: new HarnessProvider(config) }).create({});
}

/** The aeye `AI` a system gets from `ctx.ai()` and `hubAi(system)`. */
export type HarnessAi = ReturnType<typeof harnessAi>;

/** An aeye `AI` backed by the hub, with the hub's models and roles listed, so aeye selects among them. */
export async function hubAiOf(config: HarnessProviderConfig): Promise<HarnessAi> {
  const ai = harnessAi(config);
  await ai.models.refresh();
  return ai;
}

function conversation(input: { prompt: string; system?: string }): Message[] {
  return [...(input.system === undefined ? [] : [{ role: 'system' as const, content: input.system }]), { role: 'user', content: input.prompt }];
}

/** `ctx.llm` calls pass the model they name, or `hub/auto`, so the hub picks as it always has. */
function metadataFor(model: ModelChoice | undefined): { metadata: HarnessMetadata & { model: ModelInfo } } {
  return { metadata: { model: HUB_MODEL, ...(model === undefined ? {} : { harness: { model } }) } };
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

/** `ctx.llm`: a thin helper over the same hub-backed aeye `AI` as `ctx.ai()`, counted against the run's budget. */
export class HubLlm implements Llm {
  readonly #config: HarnessProviderConfig;
  readonly #ai: HarnessAi;
  readonly #models: HubModels;
  readonly #signal: AbortSignal | undefined;

  constructor(config: HarnessProviderConfig, signal?: AbortSignal) {
    this.#config = config;
    this.#ai = harnessAi(config);
    this.#models = new HubModels(modelLinkOf(config), config.run);
    this.#signal = signal;
  }

  /** The aeye `AI` these calls go through, its models not listed: `ctx.llm` lets the hub pick unless a call names one. */
  get ai(): HarnessAi {
    return this.#ai;
  }

  /** `ctx.ai()`: an aeye `AI` on the same hub, run and budget, with the hub's models listed. */
  listed(): Promise<HarnessAi> {
    return hubAiOf(this.#config);
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
