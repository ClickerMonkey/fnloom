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
import { getResponseFromChunks, type Chunk, type Message, type MessageContent, type Request, type Response, type ToolChoice, type Usage } from '@aeye/core';
import {
  Json, LlmRequest, ModelChoice,
  type LlmChunk, type LlmContentPart, type LlmForwardChunk, type LlmMessage, type LlmResponseFormat, type LlmToolSpec, type LlmUsage, type RunId,
} from '@harness/core';
import { z } from 'zod';
import type { Llm } from '../ctx.ts';
import type { GinType } from '../gin.ts';
import type { HubAccess } from './link.ts';
import { decodeOrThrow, LinkGap } from './wire.ts';

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

/** A message part's content as wire text: text, a URL, or a data URL. */
function partContent(part: MessageContent): string {
  const content = part.content;
  if (typeof content === 'string') { return content; }
  if (content instanceof URL) { return content.href; }
  if (content instanceof Uint8Array) { return `data:application/octet-stream;base64,${Buffer.from(content).toString('base64')}`; }
  throw new LinkGap('Only text, URL and byte message parts can be forwarded to the hub.');
}

function wireMessage(message: Message): LlmMessage {
  const content = typeof message.content === 'string'
    ? message.content
    : message.content.map((part): LlmContentPart => ({
      type: part.type,
      content: partContent(part),
      ...(part.format === undefined ? {} : { format: part.format }),
      ...(part.name === undefined ? {} : { name: part.name }),
    }));
  return {
    role: message.role,
    content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) }),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
    ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
  };
}

/** A zod schema as plain JSON schema for the hub, which rebuilds it and strictifies it for the model it picks. */
function jsonSchemaOf(schema: z.ZodType): Json {
  return Json.parse(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }));
}

function wireToolChoice(choice: ToolChoice): LlmRequest['toolChoice'] {
  if (typeof choice === 'string' || 'tool' in choice) { return choice; }
  // the wire has no "only these" choice yet: let the model pick among all, or require one
  return choice.required === true ? 'required' : 'auto';
}

function wireResponseFormat(format: NonNullable<Request['responseFormat']>): LlmResponseFormat {
  if (format === 'text' || format === 'json') { return format; }
  return { schema: jsonSchemaOf(format.type), strict: format.strict === true };
}

/** An aeye request as it crosses the wire: zod schemas become JSON schema. */
export function wireRequest(request: Request): LlmRequest {
  const tools = request.tools?.map((tool): LlmToolSpec => ({
    name: tool.name,
    parameters: jsonSchemaOf(tool.parameters),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
  }));
  return LlmRequest.parse({
    messages: request.messages.map(wireMessage),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: typeof request.stop === 'string' ? [request.stop] : request.stop }),
    ...(tools === undefined ? {} : { tools }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: wireToolChoice(request.toolChoice) }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: wireResponseFormat(request.responseFormat) }),
  });
}

function aeyeUsage(usage: LlmUsage, cost?: number): Usage {
  return {
    text: { input: usage.input, output: usage.output, ...(usage.cached === undefined ? {} : { cached: usage.cached }) },
    ...(usage.reasoning === undefined ? {} : { reasoning: { output: usage.reasoning } }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** A wire chunk as an aeye chunk. */
export function aeyeChunk(chunk: LlmChunk): Chunk {
  return {
    ...(chunk.content === undefined ? {} : { content: chunk.content }),
    ...(chunk.reasoning === undefined ? {} : { reasoning: { content: chunk.reasoning } }),
    ...(chunk.toolCallNamed === undefined ? {} : { toolCallNamed: chunk.toolCallNamed }),
    ...(chunk.toolCallArguments === undefined ? {} : { toolCallArguments: chunk.toolCallArguments }),
    ...(chunk.toolCall === undefined ? {} : { toolCall: chunk.toolCall }),
    ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
    ...(chunk.refusal === undefined ? {} : { refusal: chunk.refusal }),
    ...(chunk.usage === undefined ? {} : { usage: aeyeUsage(chunk.usage) }),
  };
}

/** Write the descriptors the hub chose into the request the system's prompt holds, so it decodes the strict wire shape. */
function applyDescriptors(request: Request, descriptors: Extract<LlmForwardChunk, { type: 'descriptors' }>): void {
  for (const tool of request.tools ?? []) {
    const id = descriptors.tools[tool.name];
    if (id !== undefined) { tool.descriptor = id; }
  }
  if (descriptors.output !== undefined && typeof request.responseFormat === 'object') {
    request.responseFormat.descriptor = descriptors.output;
  }
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
          const chunk = aeyeChunk(item.chunk);
          chunks.push(chunk);
          yield chunk;
          break;
        }
        case 'done': {
          served = item.model;
          const last: Chunk = { usage: aeyeUsage(item.usage, item.cost), model: item.model };
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
